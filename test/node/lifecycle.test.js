import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAutosave } from '../../src/core/autosave.js';
import { createManualScheduler } from '../../src/core/scheduler.js';
import { Store } from '../../src/core/store.js';
import { createFlushOnHide } from '../../src/platform/lifecycle.js';
import { createLocalStorageRepository } from '../../src/platform/storage.js';

const card = (id) => ({ id, type: 'card', x: 0, y: 0, w: 200, h: 120, text: '' });

/** Just enough of the two event targets to fire at them and to count listeners. */
function fakeHost({ visibilityState = 'visible' } = {}) {
  const make = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type, fn) => {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
      dispatch: (type) => listeners.get(type)?.(),
    };
  };
  const window = make();
  const document = make();
  document.visibilityState = visibilityState;
  return { window, document };
}

describe('flush on hide', () => {
  const withAutosave = (autosave, options) => {
    const { window, document } = fakeHost(options);
    return { window, document, hide: createFlushOnHide({ window, document, autosave }) };
  };

  const spy = (dirty) => {
    const calls = [];
    return { calls, autosave: { get dirty() { return dirty; }, flush: async () => calls.push('flush') } };
  };

  test('a page going away writes what the debounce has not', () => {
    const { calls, autosave } = spy(true);
    const { window } = withAutosave(autosave);

    window.dispatch('pagehide');
    assert.deepEqual(calls, ['flush']);
  });

  test('a hidden tab writes too — a phone may never fire anything else', () => {
    const { calls, autosave } = spy(true);
    const { document } = withAutosave(autosave, { visibilityState: 'hidden' });

    document.dispatch('visibilitychange');
    assert.deepEqual(calls, ['flush']);
  });

  test('coming back into view is not a reason to write', () => {
    const { calls, autosave } = spy(true);
    const { document } = withAutosave(autosave, { visibilityState: 'visible' });

    document.dispatch('visibilitychange');
    assert.deepEqual(calls, [], 'wrote on becoming visible');
  });

  test('a board with nothing outstanding is left alone', () => {
    const { calls, autosave } = spy(false);
    const { window, document } = withAutosave(autosave, { visibilityState: 'hidden' });

    window.dispatch('pagehide');
    document.dispatch('visibilitychange');
    assert.deepEqual(calls, [], 'a request per tab switch, for nothing');
  });

  test('destroy leaves nothing listening', () => {
    const { calls, autosave } = spy(true);
    const { window, document, hide } = withAutosave(autosave, { visibilityState: 'hidden' });

    hide.destroy();
    assert.equal(window.listeners.size, 0);
    assert.equal(document.listeners.size, 0);

    window.dispatch('pagehide');
    document.dispatch('visibilitychange');
    assert.deepEqual(calls, []);
  });

  test('a rejected last-gasp write does not take the page down with it', async () => {
    const autosave = { dirty: true, flush: async () => { throw new Error('offline'); } };
    const { window } = withAutosave(autosave);

    window.dispatch('pagehide');
    // an unhandled rejection would end the process between these two lines
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(true);
  });

  /**
   * The claim the whole thing rests on: against Web Storage the write has
   * *landed* by the time the handler returns, rather than being queued behind
   * a microtask a closing page will never run.
   *
   * Every layer is the real one here — repository, autosave and store — with
   * only the storage and the event targets faked, because a seam anywhere in
   * between is a seam where an await could hide.
   */
  test('against Web Storage the write is on disk before the handler returns', () => {
    const written = [];
    const storage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: (key, value) => written.push([key, value]),
      removeItem: () => {},
    };

    const store = new Store();
    const autosave = createAutosave({
      document: store,
      repository: createLocalStorageRepository({ storage }),
      boardId: 'alpha',
      scheduler: createManualScheduler(),
    });
    const { window } = withAutosave(autosave);

    store.apply([{ t: 'add', obj: card('a') }]);
    assert.deepEqual(written, [], 'the debounce has not fired — that is the window being closed');

    window.dispatch('pagehide');
    assert.equal(written.length, 1, 'the write was still a microtask away when the page went');
    assert.match(written[0][0], /board:alpha$/);
    assert.match(written[0][1], /"id":"a"/);
  });
});
