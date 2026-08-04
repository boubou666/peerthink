/**
 * Persists the document whenever it settles.
 *
 * Both the repository and the board it writes to are injected, so this is the
 * same code whether the board is going to localStorage today or to an endpoint
 * later, and whether the workspace holds one board or a hundred.
 */
export function createAutosave({ store, repository, boardId, scheduler, delay = 400 }) {
  const flush = () => repository.save(boardId, store.toJSON());
  const save = scheduler.debounce(flush, delay);
  const stop = store.on(save);
  return { stop, flush, boardId };
}
