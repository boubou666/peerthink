/**
 * Persists the document whenever it settles.
 *
 * Both the repository and the board it writes to are injected, so this is the
 * same code whether the board is going to localStorage today or to an endpoint
 * later, and whether the workspace holds one board or a hundred.
 *
 * `flush` hands back the repository's promise, so a caller that wants to know
 * whether the write landed can wait for it. The debounced path deliberately
 * does not: it fires on every settled edit with nobody waiting, and a rejected
 * save there is a dropped autosave, not a reason to take the tab down with an
 * unhandled rejection. The session keeps working from memory either way.
 *
 * `canWrite` is how a board with several people on it has one of them writing
 * it. Everyone applies the same ops and so holds the same document; the one
 * elected to save it does, and the rest hold their peace rather than take
 * turns overwriting each other. It gates the debounced path *and* an explicit
 * flush, because a caller asking to save is not a caller claiming authority.
 */
export function createAutosave({ store, repository, boardId, scheduler, delay = 400, canWrite }) {
  // A write that did not land leaves the document dirty. Without this, a save
  // refused because someone else's version is current — or dropped because the
  // network was — is never retried, and the last edits are lost on reload by a
  // session that had them the whole time. The retry rides the next settled
  // edit rather than a timer of its own, so a board nobody is touching does
  // not sit there hammering a server that just said no.
  let dirty = false;

  const flush = async () => {
    if (canWrite?.() === false) {
      dirty = true;
      return false;
    }

    try {
      const wrote = await repository.save(boardId, store.toJSON());
      dirty = !wrote;
      return wrote;
    } catch (error) {
      // Set here rather than in the debounced wrapper below: `flush` is public
      // and the callers that use it directly — the replay after a load, the
      // save on taking over write authority — would otherwise leave a board
      // that failed to write looking clean, and nothing would retry it.
      dirty = true;
      throw error;
    }
  };

  // Rethrown by flush, and swallowed here: the debounced path fires on every
  // settled edit with nobody waiting, and a rejected autosave is a dropped
  // write rather than a reason to take the tab down.
  const attempt = () => flush().catch(() => false);
  const save = scheduler.debounce(attempt, delay);
  const stop = store.on(save);

  return {
    stop,
    flush,
    boardId,
    /** Whether the document on screen is ahead of the one that was stored. */
    get dirty() {
      return dirty;
    },
  };
}
