/**
 * Board persistence against a Web Storage implementation.
 *
 * The repository is addressed by board id rather than holding a single board,
 * which is what lets one workspace hold many. The shape here — list / load /
 * save / rename / remove — is the contract a server-backed repository will
 * implement later; nothing above it should know which one it is talking to.
 *
 * Every call is total. Storage can be full, disabled, or hold junk written by
 * an older version, and none of that is worth losing the session over.
 */

export const RECORD_VERSION = 1;
export const DEFAULT_BOARD_ID = 'default';
export const DEFAULT_TITLE = 'Untitled board';

/** Where single-board versions of the app kept their state. */
export const LEGACY_KEY = 'peerthink:board';

const isBoard = (board) => Array.isArray(board?.objects) && Array.isArray(board?.order);

export function createLocalStorageRepository({
  storage,
  namespace = 'peerthink',
  now = () => Date.now(),
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
    list() {
      return ids()
        .map((id) => read(keyFor(id)))
        .filter(Boolean)
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    load(id) {
      return read(keyFor(id));
    },

    /** Stamps updatedAt. An existing title survives a save that omits one. */
    save(id, board, { title } = {}) {
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

    rename(id, title) {
      const record = read(keyFor(id));
      if (!record) return false;
      return write(keyFor(id), { ...record, title, updatedAt: now() });
    },

    remove(id) {
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
    migrateLegacy({ toId = DEFAULT_BOARD_ID, title = DEFAULT_TITLE } = {}) {
      let legacy;
      try {
        const raw = storage.getItem(LEGACY_KEY);
        if (!raw) return false;
        legacy = JSON.parse(raw);
      } catch {
        return false;
      }
      if (!isBoard(legacy) || read(keyFor(toId))) return false;
      if (!repository.save(toId, legacy, { title })) return false;

      try {
        storage.removeItem(LEGACY_KEY);
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
    list: () => [],
    load: () => null,
    save: () => false,
    rename: () => false,
    remove: () => false,
    migrateLegacy: () => false,
  };
}
