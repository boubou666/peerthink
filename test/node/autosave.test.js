import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAutosave } from '../../public/js/core/autosave.js';
import { Store } from '../../public/js/core/store.js';
import { createManualScheduler } from '../../public/js/core/scheduler.js';

const card = (id) => ({ id, type: 'card', x: 0, y: 0, w: 200, h: 120, text: '' });

function harness() {
  const store = new Store();
  const scheduler = createManualScheduler();
  const saved = [];
  const repository = {
    load: () => null,
    save(board) {
      saved.push(board);
      return true;
    },
  };
  const autosave = createAutosave({ store, repository, scheduler });
  return { store, scheduler, saved, autosave };
}

describe('autosave', () => {
  test('writes once after a burst of changes settles', () => {
    const { store, scheduler, saved } = harness();

    store.apply([{ t: 'add', obj: card('a') }]);
    store.apply([{ t: 'set', id: 'a', patch: { x: 1 } }]);
    store.apply([{ t: 'set', id: 'a', patch: { x: 2 } }]);
    assert.deepEqual(saved, [], 'nothing written while the user is still working');

    scheduler.flushTimers();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].objects[0].x, 2, 'the settled state, not an intermediate one');
  });

  test('flush writes immediately, without waiting for the debounce', () => {
    const { store, saved, autosave } = harness();
    store.apply([{ t: 'add', obj: card('a') }]);
    autosave.flush();
    assert.equal(saved.length, 1);
  });

  test('stop unsubscribes from the store', () => {
    const { store, scheduler, saved, autosave } = harness();
    autosave.stop();
    store.apply([{ t: 'add', obj: card('a') }]);
    scheduler.flushTimers();
    assert.deepEqual(saved, []);
  });

  test('a repository that cannot save does not break the session', () => {
    const store = new Store();
    const scheduler = createManualScheduler();
    const repository = { load: () => null, save: () => false };
    createAutosave({ store, repository, scheduler });

    store.apply([{ t: 'add', obj: card('a') }]);
    scheduler.flushTimers();
    assert.equal(store.order.length, 1);
  });
});
