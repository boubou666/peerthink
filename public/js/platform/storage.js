/**
 * Board persistence against a Web Storage implementation.
 *
 * Both calls are total: storage can be full, disabled, or hold junk written by
 * an older version, and none of that is worth losing the session over.
 */
export function createLocalStorageRepository({ storage, key = 'peerthink:board' }) {
  return {
    load() {
      try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data?.objects?.length ? data : null;
      } catch {
        return null;
      }
    },

    save(board) {
      try {
        storage.setItem(key, JSON.stringify(board));
        return true;
      } catch {
        return false; // quota or private mode — the board still works in memory
      }
    },

    clear() {
      try {
        storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Drops everything on the floor. Used when no storage is available at all. */
export function createNullRepository() {
  return { load: () => null, save: () => false, clear: () => false };
}
