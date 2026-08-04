/**
 * What the person at the keyboard is told about their work being stored.
 *
 * Autosave already knew all of this and kept it to itself: a write that was
 * refused left the document dirty and nothing said so, and a board that failed
 * to load left a canvas that was fully editable and saved nowhere. The states
 * are the ones a user can act on, not the ones the code happens to be in.
 *
 * It lives in core/ because it is a fact about the document, not about a
 * browser — the shell subscribes to it, but so could anything else.
 */

/** The stored board matches the one on screen. */
export const SAVED = 'saved';
/** Edits are waiting for the debounce, or for a write that is already out. */
export const PENDING = 'pending';
/** A write is in flight. */
export const SAVING = 'saving';
/** The last write did not land. Retried on a backoff; the document is intact. */
export const FAILED = 'failed';
/** The board never loaded, so nothing is being saved at all. */
export const UNLOADED = 'unloaded';

/**
 * A subscribable current value.
 *
 * Created before `hydrate()` rather than by the autosave it reports on, so the
 * shell can subscribe at mount and still hear about a board that fails on the
 * way in — the case where there is no autosave to ask.
 */
export function createSaveStatus(initial = SAVED) {
  let status = initial;
  const listeners = new Set();

  return {
    get: () => status,

    set(next) {
      if (next === status) return;
      status = next;
      // copied: a listener that unsubscribes on the way through would
      // otherwise reindex the set mid-iteration
      for (const listener of [...listeners]) listener(status);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
