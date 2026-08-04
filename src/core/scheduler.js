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

    /**
     * Run now, then at most once every `ms` for as long as the calls keep
     * coming — with a final run after the last one.
     *
     * Unlike `debounce`, a caller that never stops still gets served: a drag
     * emits ops for as long as the pointer moves, and the other end of a wire
     * cannot wait for it to finish. Unlike `onFrame`, this is a timer, so it
     * keeps running in a tab the compositor has stopped drawing.
     *
     * Takes no arguments, because the callers that need this are draining a
     * queue rather than carrying a value forward.
     */
    throttle(fn, ms) {
      let timer = null;
      let queued = false;

      const run = () => {
        fn();
        timer = setTimeout(() => {
          timer = null;
          if (!queued) return;
          queued = false;
          run();
        }, ms);
      };

      return () => {
        if (timer) queued = true;
        else run();
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
