/**
 * The last few hundred milliseconds of a tab.
 *
 * Autosave waits for the document to settle before writing it, which means
 * there is always a window where the board on screen is ahead of the board in
 * storage. Closing the tab inside that window used to lose those edits: the
 * debounce is a timer, and a page that is going away does not run its timers.
 *
 * So a page on its way out is asked to write now. Against Web Storage this is
 * decisive — `save()` reaches `setItem` before it awaits anything, so the
 * write has landed by the time the handler returns. Against a network
 * repository it is best effort: the request goes out, and whether it arrives
 * depends on how long the browser keeps the page alive. Best effort beats the
 * current behaviour, which is not trying.
 *
 * Two events, because neither is enough on its own. `visibilitychange` is the
 * one a phone actually fires when the user switches app — a tab discarded in
 * the background may never see anything else. `pagehide` covers the plain
 * desktop case of closing the tab or following a link out, where the page can
 * go from visible to gone without an intervening hidden.
 */
export function createFlushOnHide({ window, document, autosave }) {
  const flush = () => {
    // Nothing outstanding, nothing to do — and asking anyway would write on
    // every tab switch, which against a server is a request per glance at
    // another window.
    if (!autosave.dirty) return false;
    // Nobody is left to hear about a failure: the retry this schedules will
    // not survive the page either. The write is the whole point.
    autosave.flush().catch(() => {});
    return true;
  };

  const onPageHide = () => flush();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flush();
  };

  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    /** Exposed for tests and for a manual save; the events are the real caller. */
    flush,
    destroy() {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
