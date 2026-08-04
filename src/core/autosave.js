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
  const flush = async () => (canWrite?.() === false ? false : repository.save(boardId, store.toJSON()));
  const save = scheduler.debounce(() => flush().catch(() => false), delay);
  const stop = store.on(save);
  return { stop, flush, boardId };
}
