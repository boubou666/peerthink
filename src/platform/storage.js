/**
 * Board persistence against a Web Storage implementation.
 *
 * The repository is addressed by board id rather than holding a single board,
 * which is what lets one workspace hold many. The shape here — list / load /
 * save / rename / remove — is the contract a server-backed repository also
 * implements; nothing above it should know which one it is talking to.
 *
 * Every method is async. Web Storage answers instantly and could have stayed
 * synchronous, but the contract is the one a network-backed repository has to
 * satisfy, and a caller written against a synchronous seam is a caller that
 * has to be rewritten the day the boards live on a server. The cost here is a
 * resolved promise; the alternative is two shapes of the same interface.
 *
 * Every call is total but one. Storage can be full, disabled, or hold junk
 * written by an older version, and none of that is worth losing the session
 * over — a refused write answers false, an unreadable board answers null.
 *
 * The two reads are the exception, and reject when the store will not answer
 * at all. Every other method has something honest to fall back on; a read does
 * not. `list()`'s empty array is a claim about someone's whole workspace and
 * `load()`'s null is a claim that a particular board does not exist — and a
 * request that never happened cannot support either. Both are acted on: an
 * empty list renders as "No boards yet", and a null load seeds a fresh board
 * over the top of one that was only unreachable.
 *
 * So null from `load()` means the board is genuinely not there, and nothing
 * else.
 */

export const RECORD_VERSION = 1;

/**
 * How many boards a page of the list holds.
 *
 * Part of the contract rather than a detail of either implementation, so the
 * two agree about what a page is and a caller can page through both the same
 * way. Big enough that most workspaces never see a second page, small enough
 * that being in a large team costs one screenful instead of the whole team.
 */
export const PAGE_SIZE = 50;
export const DEFAULT_NAMESPACE = 'peerthink';
export const DEFAULT_BOARD_ID = 'default';
export const DEFAULT_TITLE = 'Untitled board';

/** Where single-board versions of the app kept their state. */
export const LEGACY_KEY = 'peerthink:board';

/**
 * What every repository agrees a board looks like. Exported so the
 * server-backed one rejects the same documents this one does, and so the
 * check constraint in the migration has something to mirror.
 */
export const isBoard = (board) => Array.isArray(board?.objects) && Array.isArray(board?.order);

/** Shared empty page, so an answer of "nothing here" allocates nothing. */
const NO_BOARDS = [];

export function createLocalStorageRepository({
  storage,
  namespace = DEFAULT_NAMESPACE,
  now = () => Date.now(),
  // Only the workspace that wrote the legacy key may adopt and delete it.
  // A repository on another namespace shares the same Web Storage, and would
  // otherwise consume a board that does not belong to it.
  legacyKey = namespace === DEFAULT_NAMESPACE ? LEGACY_KEY : null,
}) {
  const prefix = `${namespace}:board:`;
  const keyFor = (id) => `${prefix}${id}`;

  /**
   * The two ways a record fails to arrive are not the same thing, and only one
   * of them is the record's fault.
   *
   * Junk that will not parse is a bad record: skip it and the rest of the store
   * is still good. A `getItem` that throws is the store itself refusing, which
   * says nothing about what is in it. Keeping them apart is what lets `list()`
   * drop the first and report the second.
   */
  const parse = (raw) => {
    if (!raw) return null;
    try {
      const record = JSON.parse(raw);
      return isBoard(record?.board) ? record : null;
    } catch {
      return null;
    }
  };

  /**
   * Total, for the writes — save, rename, migrateLegacy — which look at what is
   * already stored but answer false rather than throwing. Both failures come
   * back as null. The reads use `parse` directly and let the store's own
   * failure out.
   */
  const read = (key) => {
    try {
      return parse(storage.getItem(key));
    } catch {
      return null;
    }
  };

  const write = (key, record) => {
    try {
      storage.setItem(key, JSON.stringify(record));
      return true;
    } catch {
      return false; // quota or private mode — the board still works in memory
    }
  };

  /**
   * Board ids present in storage. Enumeration is a Web Storage detail.
   *
   * Throws when the store will not be enumerated. It used to swallow that and
   * answer with the ids it had — which is to say none — and the only caller
   * turned that into "No boards yet" for a browser with boards in it.
   */
  const ids = () => {
    const found = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) found.push(key.slice(prefix.length));
    }
    return found;
  };

  const repository = {
    /**
     * A page of summaries, newest first, with a cursor for the next one.
     *
     * `scope` is the organization whose boards are wanted, or null for the
     * personal list. A browser's own storage has no organizations in it, so
     * anything but null matches nothing — the same reason every board here is
     * `owned` and none has an `orgId`.
     *
     * `after` is a cursor this method previously answered with, and is opaque:
     * the two implementations page over different clocks — epoch millis here,
     * a Postgres timestamp there — and a caller that took it apart would be
     * writing to one of them. Null when there is no page after this one.
     *
     * Deliberately not wrapped in a try: `ids()` and `getItem` throwing both
     * mean the store would not answer, and that has to reach the caller rather
     * than be flattened into an empty list. `parse` — not `read` — is what
     * reads each record here, so a single unparseable one is still skipped.
     */
    async list({ scope = null, after = null, limit = PAGE_SIZE } = {}) {
      if (scope !== null) return { boards: NO_BOARDS, cursor: null };

      const all = ids()
        .map((id) => [id, parse(storage.getItem(keyFor(id)))])
        .filter(([, record]) => record)
        // the key is the record's real address — an `id` field written by an
        // older version, or edited by hand, may disagree with it. A missing
        // updatedAt would make the comparator return NaN and scramble the
        // whole list, so it gets a floor too.
        .map(([id, { title, updatedAt }]) => ({
          id,
          title: typeof title === 'string' ? title : DEFAULT_TITLE,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
          // Nobody else can reach this browser's storage, so every board in it
          // is yours. The field exists because the contract has it, and a
          // caller should not have to ask which repository it is holding.
          owned: true,
          // And there is nobody to share an organization with either, for the
          // same reason. Stated rather than left off, so the board list can
          // read `orgId` without first asking which repository answered.
          orgId: null,
        }))
        // Ordered by id as well as time, and not only for tidiness: paging
        // needs a *total* order. Two boards saved in the same millisecond tie,
        // and a page boundary landing inside a tie is how a keyset walk skips
        // a board or serves it twice. The server-backed list breaks the tie
        // the same way, on the same column.
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

      // The same comparison the sort just made, which is what makes "the ones
      // after this cursor" mean the same thing as "further down that list".
      const rest = after
        ? all.filter(({ id, updatedAt }) =>
          updatedAt < after.updatedAt || (updatedAt === after.updatedAt && id < after.id))
        : all;

      // One more than asked for, purely to find out whether there is another
      // page — cheaper and more honest than a second count query, and it
      // cannot disagree with the page it was taken from.
      const boards = rest.slice(0, limit);
      const last = boards.at(-1);
      return {
        boards,
        cursor: rest.length > limit ? { updatedAt: last.updatedAt, id: last.id } : null,
      };
    },

    /**
     * The stored board, or null when there is none. Throws when the store will
     * not answer — `read()` is not used here for the same reason `list()` does
     * not use it: null has to mean "no such board", because that is what the
     * caller acts on by seeding a new one in its place.
     */
    async load(id) {
      return parse(storage.getItem(keyFor(id)));
    },

    /** Stamps updatedAt. An existing title survives a save that omits one. */
    async save(id, board, { title } = {}) {
      if (!isBoard(board)) return false;
      const existing = read(keyFor(id));
      return write(keyFor(id), {
        v: RECORD_VERSION,
        id,
        title: title ?? existing?.title ?? DEFAULT_TITLE,
        updatedAt: now(),
        board,
      });
    },

    async rename(id, title) {
      const record = read(keyFor(id));
      if (!record) return false;
      return write(keyFor(id), { ...record, title, updatedAt: now() });
    },

    async remove(id) {
      try {
        storage.removeItem(keyFor(id));
        return true;
      } catch {
        return false;
      }
    },

    /**
     * There is nowhere to move a board to. Organizations are people sharing
     * boards with each other, and a browser's own storage has nobody in it —
     * the same reason `owned` is always true above.
     *
     * False rather than absent, so a caller holding the contract can call this
     * without knowing which implementation answered. Nothing offers the move
     * in a build with no backend, because `shell/organizations.js` is null
     * there and the control is not rendered at all.
     */
    async move() {
      return false;
    },

    /**
     * Adopt a board written by a single-board version of the app. Returns true
     * only when something was actually moved, and never overwrites a board
     * that already exists under the target id.
     */
    async migrateLegacy({ toId = DEFAULT_BOARD_ID, title = DEFAULT_TITLE } = {}) {
      if (!legacyKey) return false;

      let legacy;
      try {
        const raw = storage.getItem(legacyKey);
        if (!raw) return false;
        legacy = JSON.parse(raw);
      } catch {
        return false;
      }
      if (!isBoard(legacy) || read(keyFor(toId))) return false;
      if (!(await repository.save(toId, legacy, { title }))) return false;

      try {
        storage.removeItem(legacyKey);
      } catch {
        // the copy landed; leaving the original behind is harmless
      }
      return true;
    },
  };

  return repository;
}

/**
 * Drops everything on the floor. Used when no storage is available at all.
 *
 * `list()` answers empty rather than rejecting, and that is not the lie the
 * other two implementations had to stop telling. Nothing can be read here
 * because nothing was ever written — `save()` refuses every time — so "no
 * boards" is the truth about this session, not a failure to find out. There is
 * also nothing a retry could do differently.
 */
export function createNullRepository() {
  return {
    list: async () => ({ boards: NO_BOARDS, cursor: null }),
    load: async () => null,
    save: async () => false,
    rename: async () => false,
    remove: async () => false,
    move: async () => false,
    migrateLegacy: async () => false,
  };
}
