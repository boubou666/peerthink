/**
 * Persists the document whenever it settles.
 *
 * The repository is injected, so this is the same code whether the board is
 * going to localStorage today or to an endpoint later.
 */
export function createAutosave({ store, repository, scheduler, delay = 400 }) {
  const flush = () => repository.save(store.toJSON());
  const save = scheduler.debounce(flush, delay);
  const stop = store.on(save);
  return { stop, flush };
}
