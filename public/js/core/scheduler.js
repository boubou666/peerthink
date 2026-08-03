/**
 * Timing, behind an interface.
 *
 * Everything that needs a frame or a delay takes a scheduler rather than
 * reaching for the globals, which keeps those code paths drivable from a test
 * without waiting on real time.
 */
export function createScheduler({ requestAnimationFrame, setTimeout, clearTimeout }) {
  return {
    /** Coalesce a burst of calls into one, on the next frame, with the last args. */
    onFrame(fn) {
      let queued = false;
      let args = null;
      return (...a) => {
        args = a;
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          fn(...args);
        });
      };
    },

    /** Run once the calls stop for `ms`. */
    debounce(fn, ms) {
      let timer = null;
      return (...a) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...a), ms);
      };
    },

    /** Run on the next frame, once. */
    nextFrame(fn) {
      requestAnimationFrame(fn);
    },
  };
}

/** A scheduler driven by hand — `flushFrames()` / `flushTimers()` in tests. */
export function createManualScheduler() {
  const frames = [];
  const timers = new Map();
  let nextTimer = 1;

  const scheduler = createScheduler({
    requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });

  scheduler.flushFrames = () => {
    const due = frames.splice(0, frames.length);
    for (const fn of due) fn();
    return due.length;
  };
  scheduler.flushTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
    return due.length;
  };
  scheduler.pendingFrames = () => frames.length;

  return scheduler;
}
