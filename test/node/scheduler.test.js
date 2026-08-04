import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createManualScheduler, createScheduler } from '../../src/core/scheduler.js';

describe('createScheduler', () => {
  test('onFrame collapses a burst into one call with the latest arguments', () => {
    const scheduler = createManualScheduler();
    const seen = [];
    const throttled = scheduler.onFrame((...args) => seen.push(args));

    throttled(1);
    throttled(2);
    throttled(3);
    assert.deepEqual(seen, [], 'nothing runs before the frame');
    assert.equal(scheduler.pendingFrames(), 1, 'only one frame is requested');

    scheduler.flushFrames();
    assert.deepEqual(seen, [[3]]);

    throttled(4);
    scheduler.flushFrames();
    assert.deepEqual(seen, [[3], [4]], 'the throttle rearms after the frame');
  });

  test('debounce runs once, after the calls stop, with the last arguments', () => {
    const scheduler = createManualScheduler();
    const seen = [];
    const debounced = scheduler.debounce((v) => seen.push(v), 20);

    debounced('a');
    debounced('b');
    debounced('c');
    assert.deepEqual(seen, []);

    assert.equal(scheduler.flushTimers(), 1, 'earlier timers were cancelled');
    assert.deepEqual(seen, ['c']);
  });

  /**
   * The difference from debounce, and the reason it exists: a caller that
   * never stops calling still gets served. Debounce would hold everything
   * until the drag ended, which is exactly when the other end stops caring.
   */
  test('throttle runs immediately, then no more often than the interval', () => {
    const scheduler = createManualScheduler();
    let ran = 0;
    const throttled = scheduler.throttle(() => ran++, 20);

    throttled();
    assert.equal(ran, 1, 'the first call is not delayed');

    throttled();
    throttled();
    assert.equal(ran, 1, 'the ones behind it wait for the window');

    scheduler.flushTimers();
    assert.equal(ran, 2, 'a burst behind the leading call is one more run');

    // that trailing run opened a window of its own; nothing is waiting in it
    scheduler.flushTimers();
    assert.equal(ran, 2);

    throttled();
    assert.equal(ran, 3, 'the throttle rearms once the window closes empty');
  });

  test('nextFrame runs a one-shot callback', () => {
    const scheduler = createManualScheduler();
    let ran = 0;
    scheduler.nextFrame(() => ran++);
    scheduler.flushFrames();
    scheduler.flushFrames();
    assert.equal(ran, 1);
  });

  test('drives whatever timing primitives it is handed', () => {
    const frames = [];
    const timers = [];
    const cleared = [];
    const scheduler = createScheduler({
      requestAnimationFrame: (fn) => frames.push(fn),
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: (id) => cleared.push(id),
    });

    scheduler.onFrame(() => {})();
    scheduler.debounce(() => {}, 55)();
    assert.equal(frames.length, 1);
    assert.deepEqual(timers.map((t) => t.ms), [55]);
    assert.deepEqual(cleared, [null], 'the first call clears an empty timer handle');
  });
});
