import { FAILED, PENDING, SAVED, SAVING } from './save-status.js';

/**
 * Persists the document whenever it settles.
 *
 * Both the repository and the board it writes to are injected, so this is the
 * same code whether the board is going to localStorage today or to an endpoint
 * later, and whether the workspace holds one board or a hundred.
 *
 * `flush` hands back the write's promise, so a caller that wants to know
 * whether it landed can wait for it. The debounced path deliberately
 * does not: it fires on every settled edit with nobody waiting, and a rejected
 * save there is a dropped autosave, not a reason to take the tab down with an
 * unhandled rejection. The session keeps working from memory either way.
 *
 * `canWrite` is how a board with several people on it has one of them writing
 * it. Everyone applies the same ops and so holds the same document; the one
 * elected to save it does, and the rest hold their peace rather than take
 * turns overwriting each other. It gates the debounced path *and* an explicit
 * flush, because a caller asking to save is not a caller claiming authority.
 *
 * `onStatus` is how any of that reaches the person who made the edits. It is
 * called with the values in ./save-status.js, and never twice with the same
 * one.
 */

/**
 * How long to wait before trying a refused write again, and again.
 *
 * The first retry is quick because the common failure is a save that lost a
 * race with another editor and would succeed on a second attempt. The tail is
 * slow because the other common failure is a network that is gone, and a board
 * nobody is touching has no business hammering a server that just said no. The
 * last delay repeats for as long as it keeps failing.
 */
export const RETRY_DELAYS = [1000, 3000, 10000, 30000];

export function createAutosave({ store, repository, boardId, scheduler, delay = 400, canWrite, onStatus }) {
  // A write that did not land leaves the document dirty. Without this, a save
  // refused because someone else's version is current — or dropped because the
  // network was — is never retried, and the last edits are lost on reload by a
  // session that had them the whole time.
  let dirty = false;

  // Which document the last successful write carried. An edit made while a
  // save is in flight belongs to a later version than the one being written,
  // so that write landing does not make the board clean — without the counter
  // the edit is marked saved and the next reload is missing it.
  let version = 0;
  let written = 0;

  let status = SAVED;
  let retries = 0;
  let cancelRetry = null;
  let stopped = false;
  let inFlight = null;

  const setStatus = (next) => {
    if (next === status) return;
    status = next;
    onStatus?.(next);
  };

  const cancelPending = () => {
    cancelRetry?.();
    cancelRetry = null;
  };

  /**
   * Try again later, on a timer of its own.
   *
   * This is the part riding the next settled edit cannot do. Retrying on the
   * next edit is free and costs nothing while somebody is working — but the
   * board that loses data is the one whose last edit failed to save and was
   * then left alone. There is no next edit coming, and the tab it is in is
   * going to be closed.
   */
  const scheduleRetry = () => {
    if (stopped) return;
    cancelPending();
    const wait = RETRY_DELAYS[Math.min(retries, RETRY_DELAYS.length - 1)];
    retries += 1;
    cancelRetry = scheduler.after(() => {
      cancelRetry = null;
      attempt();
    }, wait);
  };

  const write = async () => {
    if (canWrite?.() === false) {
      // Not this client's write to make. The document stays dirty so that
      // taking over write authority saves it, but nothing is wrong and the
      // person is not told that it is: the elected writer holds the same
      // document, arrived at by applying the same ops.
      dirty = true;
      setStatus(SAVED);
      return false;
    }

    const at = version;
    setStatus(SAVING);

    let wrote;
    try {
      wrote = await repository.save(boardId, store.toJSON());
    } catch (error) {
      // Handled here rather than in the debounced wrapper below: `flush` is
      // public and the callers that use it directly — the replay after a load,
      // the save on taking over write authority, a page on its way out —
      // would otherwise leave a board that failed to write looking clean, and
      // nothing would retry it.
      dirty = true;
      setStatus(FAILED);
      scheduleRetry();
      throw error;
    }

    if (!wrote) {
      dirty = true;
      setStatus(FAILED);
      scheduleRetry();
      return false;
    }

    written = at;
    retries = 0;
    cancelPending();
    dirty = version !== written;
    setStatus(dirty ? PENDING : SAVED);
    // Edits made while that write was in flight are not in it, and they have
    // no debounce left to fire — theirs was consumed by the write that just
    // landed. The follow-up is scheduled here instead.
    if (dirty) save();
    return true;
  };

  /**
   * One write at a time.
   *
   * There are four callers now — the debounce, the retry timer, the page on
   * its way out, and the button in the bar — and none of them knows about the
   * others. Two of them overlapping is not a race the repository can settle:
   * both writes capture the same version to replace, so whichever lands second
   * is refused for claiming a version the first has just moved, and the board
   * spends a retry converging on a document it already had. A second caller
   * joins the queue behind the write already out instead.
   *
   * The write is still started synchronously when nothing is in flight, which
   * is what `platform/lifecycle.js` depends on: against Web Storage the save
   * has landed before the `pagehide` handler returns.
   */
  const flush = () => {
    // then(write, write): the next write is owed whether the last one landed
    // or not, and it is the one holding the newer document.
    const next = inFlight ? inFlight.then(write, write) : write();
    inFlight = next;

    const settle = () => {
      if (inFlight === next) inFlight = null;
    };
    // both handlers, so this derived promise is never an unhandled rejection —
    // the one handed back to the caller keeps the original outcome
    next.then(settle, settle);
    return next;
  };

  /**
   * The scheduled paths — the debounce and the retry — write only what is
   * outstanding.
   *
   * A direct `flush()` does not consume the debounce an edit armed, so the
   * Retry button and the page on its way out both leave a timer behind that
   * would fire on a board they have already stored. A duplicate write is
   * mostly waste, but a duplicate write that *fails* is worse than waste: it
   * reports a board as unsaved when the document is safely stored, which is
   * the one thing this is all here to stop doing.
   *
   * The rejection is swallowed rather than rethrown, because these paths fire
   * with nobody waiting and a dropped autosave is not a reason to take the tab
   * down with an unhandled rejection.
   */
  const attempt = () => (dirty ? flush().catch(() => false) : Promise.resolve(false));
  const save = scheduler.debounce(attempt, delay);

  const stopListening = store.on(() => {
    version += 1;
    dirty = true;
    // A failed write stays failed until one succeeds. Calling a fresh edit
    // merely pending would say the previous one was stored, which is the thing
    // this is here to stop saying.
    if (status === SAVED) setStatus(PENDING);
    save();
  });

  return {
    flush,
    boardId,

    stop() {
      stopped = true;
      stopListening();
      // A debounce already in flight is deliberately left to fire: those are
      // the last few hundred milliseconds of a board being closed, and they
      // still have somewhere to write. A retry is not — it is a timer that
      // would outlive the board by half a minute to save a document nothing is
      // looking at any more.
      cancelPending();
    },

    /** Whether the document on screen is ahead of the one that was stored. */
    get dirty() {
      return dirty;
    },

    /** One of the values in ./save-status.js. */
    get status() {
      return status;
    },
  };
}
