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
 * Every call is total. Storage can be full, disabled, or hold junk written by
 * an older version, and none of that is worth losing the session over.
 */

export const RECORD_VERSION = 1;
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

  const read = (key) => {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const record = JSON.parse(raw);
      return isBoard(record?.board) ? record : null;
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

  /** Board ids present in storage. Enumeration is a Web Storage detail. */
  const ids = () => {
    const found = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) found.push(key.slice(prefix.length));
      }
    } catch {
      // storage that cannot be enumerated still supports get/set by id
    }
    return found;
  };

  const repository = {
    /**
     * Summaries for a board picker, newest first. This parses every stored
     * board, which is fine at Web Storage scale and is exactly the call a
     * server-backed repository answers with a single query instead.
     */
    async list() {
      return ids()
        .map((id) => [id, read(keyFor(id))])
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
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async load(id) {
      return read(keyFor(id));
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

/** Drops everything on the floor. Used when no storage is available at all. */
export function createNullRepository() {
  return {
    list: async () => [],
    load: async () => null,
    save: async () => false,
    rename: async () => false,
    remove: async () => false,
    migrateLegacy: async () => false,
  };
}
