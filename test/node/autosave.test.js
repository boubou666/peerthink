import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RETRY_DELAYS, createAutosave } from '../../src/core/autosave.js';
import { FAILED, PENDING, SAVED, SAVING } from '../../src/core/save-status.js';
import { Store } from '../../src/core/store.js';
import { createManualScheduler } from '../../src/core/scheduler.js';

const card = (id) => ({ id, type: 'card', x: 0, y: 0, w: 200, h: 120, text: '' });

function harness() {
  const store = new Store();
  const scheduler = createManualScheduler();
  const saved = [];
  const repository = {
    load: async () => null,
    async save(boardId, board) {
      saved.push({ boardId, board });
      return true;
    },
  };
  const autosave = createAutosave({ store, repository, boardId: 'alpha', scheduler });
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
    assert.equal(saved[0].board.objects[0].x, 2, 'the settled state, not an intermediate one');
  });

  test('writes to the board it was given', () => {
    const { store, scheduler, saved, autosave } = harness();
    assert.equal(autosave.boardId, 'alpha');

    store.apply([{ t: 'add', obj: card('a') }]);
    scheduler.flushTimers();
    assert.equal(saved[0].boardId, 'alpha');
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
    const repository = { load: async () => null, save: async () => false };
    createAutosave({ store, repository, boardId: 'alpha', scheduler });

    store.apply([{ t: 'add', obj: card('a') }]);
    scheduler.flushTimers();
    assert.equal(store.order.length, 1);
  });

  /**
   * With several people on a board, every one of them holds the same document
   * and only one of them writes it. A client that has been outvoted holds its
   * peace rather than taking turns overwriting the others.
   */
  describe('write authority', () => {
    const gated = (canWrite) => {
      const store = new Store();
      const scheduler = createManualScheduler();
      const saved = [];
      const repository = {
        load: async () => null,
        save: async (boardId, board) => {
          saved.push({ boardId, board });
          return true;
        },
      };
      const autosave = createAutosave({ store, repository, boardId: 'alpha', scheduler, canWrite });
      return { store, scheduler, saved, autosave };
    };

    test('a client without authority does not write', () => {
      const { store, scheduler, saved } = gated(() => false);

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      assert.deepEqual(saved, []);
    });

    test('an explicit flush is not a claim of authority either', async () => {
      const { store, saved, autosave } = gated(() => false);

      store.apply([{ t: 'add', obj: card('a') }]);
      assert.equal(await autosave.flush(), false);
      assert.deepEqual(saved, []);
    });

    test('authority is read at write time, not at construction', async () => {
      let writer = false;
      const { store, scheduler, saved } = gated(() => writer);

      // Writes are serialised, so the second attempt only starts on its own
      // once the first has settled. Draining the microtasks between the two
      // timers is what a real clock does anyway — a task never follows a task
      // without the queue in between emptying first.
      const drain = () => new Promise((resolve) => setImmediate(resolve));

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await drain();
      assert.deepEqual(saved, [], 'wrote before it had authority');

      writer = true;
      store.apply([{ t: 'set', id: 'a', patch: { x: 1 } }]);
      scheduler.flushTimers();
      await drain();
      assert.equal(saved.length, 1, 'did not write once it had authority');
    });

    test('no gate at all is a board this client writes', () => {
      const { store, scheduler, saved } = gated(undefined);

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      assert.equal(saved.length, 1);
    });
  });

  /**
   * A write that did not land leaves the document ahead of the stored one, and
   * nothing else will notice — the next settled edit is what retries it.
   */
  describe('dirty', () => {
    const withRepository = (save) => {
      const store = new Store();
      const scheduler = createManualScheduler();
      const autosave = createAutosave({ store, repository: { load: async () => null, save }, boardId: 'alpha', scheduler });
      return { store, scheduler, autosave };
    };

    test('a settled write leaves nothing outstanding', async () => {
      const { store, scheduler, autosave } = withRepository(async () => true);
      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(autosave.dirty, false);
    });

    test('a refused write stays outstanding', async () => {
      const { store, scheduler, autosave } = withRepository(async () => false);
      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(autosave.dirty, true, 'a save the server refused was forgotten');
    });

    test('a rejected write stays outstanding, whichever path made it', async () => {
      const failing = () => withRepository(async () => { throw new Error('offline'); });

      // the debounced path
      const viaDebounce = failing();
      viaDebounce.store.apply([{ t: 'add', obj: card('a') }]);
      viaDebounce.scheduler.flushTimers();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(viaDebounce.autosave.dirty, true);

      // and a direct flush, which is what app.js uses for the replay and for
      // the save on taking over write authority
      const viaFlush = failing();
      viaFlush.store.apply([{ t: 'add', obj: card('a') }]);
      await assert.rejects(() => viaFlush.autosave.flush());
      assert.equal(viaFlush.autosave.dirty, true, 'a direct flush that rejected looked clean');
    });

    test('a client without authority is dirty rather than saved', async () => {
      const store = new Store();
      const scheduler = createManualScheduler();
      const autosave = createAutosave({
        store, scheduler, boardId: 'alpha', canWrite: () => false,
        repository: { load: async () => null, save: async () => true },
      });

      store.apply([{ t: 'add', obj: card('a') }]);
      assert.equal(await autosave.flush(), false);
      assert.equal(autosave.dirty, true);
    });
  });

  /**
   * A board is only as safe as the last write that landed, and the one thing
   * that must never happen is a board saying it is stored when it is not.
   */
  describe('what the person is told', () => {
    const watched = (save, { canWrite } = {}) => {
      const store = new Store();
      const scheduler = createManualScheduler();
      const seen = [];
      const autosave = createAutosave({
        store,
        repository: { load: async () => null, save },
        boardId: 'alpha',
        scheduler,
        canWrite,
        onStatus: (status) => seen.push(status),
      });
      return { store, scheduler, autosave, seen };
    };

    const settle = () => new Promise((resolve) => setImmediate(resolve));

    test('an edit is pending, a landed write is saved', async () => {
      const { store, scheduler, autosave, seen } = watched(async () => true);
      assert.equal(autosave.status, SAVED, 'a board nobody has touched is stored');

      store.apply([{ t: 'add', obj: card('a') }]);
      assert.deepEqual(seen, [PENDING]);

      scheduler.flushTimers();
      await settle();
      assert.deepEqual(seen, [PENDING, SAVING, SAVED]);
      assert.equal(autosave.status, SAVED);
    });

    test('a refused write says so and stays saying it', async () => {
      const { store, scheduler, autosave, seen } = watched(async () => false);

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await settle();
      assert.deepEqual(seen, [PENDING, SAVING, FAILED]);

      // The next edit does not get to look like a fresh start: the previous
      // one is still not stored, and pending would say that it was.
      store.apply([{ t: 'set', id: 'a', patch: { x: 1 } }]);
      assert.equal(autosave.status, FAILED);
    });

    test('a rejected write is a failure like any other', async () => {
      const { store, scheduler, autosave } = watched(async () => { throw new Error('offline'); });

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await settle();
      assert.equal(autosave.status, FAILED);
    });

    test('a client that is not the writer is not told anything is wrong', async () => {
      const { store, scheduler, autosave, seen } = watched(async () => true, { canWrite: () => false });

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await settle();

      assert.deepEqual(seen, [PENDING, SAVED], 'someone else writes this board; that is not a problem');
      assert.equal(autosave.dirty, true, 'but this client still owes the write if it takes over');
    });

    test('a recovered write clears the warning', async () => {
      let working = false;
      const { store, scheduler, autosave } = watched(async () => working);

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await settle();
      assert.equal(autosave.status, FAILED);

      working = true;
      assert.equal(await autosave.flush(), true);
      assert.equal(autosave.status, SAVED);
      assert.equal(autosave.dirty, false);
    });
  });

  /**
   * The board that loses data is the one whose last write failed and was then
   * left alone. Riding the next settled edit cannot save it — there is no next
   * edit, and the tab is about to be closed.
   */
  describe('retry', () => {
    const failing = (results) => {
      const store = new Store();
      const scheduler = createManualScheduler();
      const attempts = [];
      const autosave = createAutosave({
        store,
        scheduler,
        boardId: 'alpha',
        repository: {
          load: async () => null,
          save: async () => {
            attempts.push(1);
            return results.shift() ?? false;
          },
        },
      });
      return { store, scheduler, autosave, attempts };
    };

    const settle = () => new Promise((resolve) => setImmediate(resolve));

    test('a refused write is tried again with nobody touching the board', async () => {
      const { store, scheduler, attempts } = failing([false, true]);

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await settle();
      assert.equal(attempts.length, 1);

      // no edit, no interaction — just the timer the failure armed
      scheduler.flushTimers();
      await settle();
      assert.equal(attempts.length, 2, 'the board sat there holding an unsaved edit');
    });

    test('it keeps trying, and stops once one lands', async () => {
      const { store, scheduler, autosave, attempts } = failing([false, false, true]);

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await settle();

      for (let i = 0; i < 4; i++) {
        scheduler.flushTimers();
        await settle();
      }

      assert.equal(attempts.length, 3, 'either it gave up early or it never stopped');
      assert.equal(autosave.status, SAVED);
      assert.equal(autosave.dirty, false);
    });

    test('the delays back off rather than hammering a server that said no', async () => {
      const timers = [];
      const scheduler = createManualScheduler();
      const spy = { ...scheduler, after: (fn, ms) => { timers.push(ms); return scheduler.after(fn, ms); } };
      const store = new Store();
      createAutosave({
        store,
        scheduler: spy,
        boardId: 'alpha',
        repository: { load: async () => null, save: async () => false },
      });

      store.apply([{ t: 'add', obj: card('a') }]);
      // each round is one refused write and the timer it arms for the next
      for (let i = 0; i < RETRY_DELAYS.length + 2; i++) {
        scheduler.flushTimers();
        await new Promise((resolve) => setImmediate(resolve));
      }

      assert.deepEqual(timers.slice(0, RETRY_DELAYS.length), RETRY_DELAYS);
      assert.equal(timers.at(-1), RETRY_DELAYS.at(-1), 'the last delay repeats rather than growing');
    });

    test('stop takes the timer with it', async () => {
      const { store, scheduler, autosave, attempts } = failing([false]);

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await settle();
      assert.equal(attempts.length, 1);

      autosave.stop();
      scheduler.flushTimers();
      await settle();
      assert.equal(attempts.length, 1, 'a closed board woke up to save itself');
    });
  });

  /**
   * Four callers reach `flush` — the debounce, the retry timer, the page on
   * its way out and the button in the bar — and none of them knows about the
   * others.
   */
  describe('one write at a time', () => {
    const blocking = () => {
      const store = new Store();
      const scheduler = createManualScheduler();
      const started = [];
      const waiting = [];
      const autosave = createAutosave({
        store,
        scheduler,
        boardId: 'alpha',
        repository: {
          load: async () => null,
          save: async (id, board) => {
            started.push(board);
            await new Promise((resolve) => waiting.push(resolve));
            return true;
          },
        },
      });
      const settle = () => new Promise((resolve) => setImmediate(resolve));
      return { store, autosave, started, waiting, settle };
    };

    test('a second caller joins the queue rather than racing the write already out', async () => {
      const { store, autosave, started, waiting, settle } = blocking();

      store.apply([{ t: 'add', obj: card('a') }]);
      const first = autosave.flush();
      await settle();
      assert.equal(started.length, 1);

      // what pagehide, the retry timer or the Retry button does mid-write
      store.apply([{ t: 'set', id: 'a', patch: { x: 42 } }]);
      const second = autosave.flush();
      await settle();
      assert.equal(started.length, 1, 'two writes were out at once');

      waiting.shift()();
      await first;
      await settle();
      assert.equal(started.length, 2, 'the queued write never ran');
      assert.equal(started[1].objects[0].x, 42, 'the second write carried the older document');

      waiting.shift()();
      assert.equal(await second, true);
      assert.equal(autosave.dirty, false);
    });

    test('a queued write still runs when the one before it failed', async () => {
      const store = new Store();
      const scheduler = createManualScheduler();
      const results = [false, true];
      const started = [];
      const autosave = createAutosave({
        store,
        scheduler,
        boardId: 'alpha',
        repository: {
          load: async () => null,
          save: async () => {
            started.push(1);
            return results.shift();
          },
        },
      });

      store.apply([{ t: 'add', obj: card('a') }]);
      const [first, second] = [autosave.flush(), autosave.flush()];
      assert.equal(await first, false);
      assert.equal(await second, true);
      assert.equal(started.length, 2);
      assert.equal(autosave.status, SAVED);
    });
  });

  /**
   * A write is a snapshot of the document at the moment it started. Anything
   * typed while it is in flight is not in it.
   */
  describe('edits made during a write', () => {
    test('are not marked saved by the write that missed them', async () => {
      const store = new Store();
      const scheduler = createManualScheduler();
      const saved = [];
      let release;
      const autosave = createAutosave({
        store,
        scheduler,
        boardId: 'alpha',
        repository: {
          load: async () => null,
          save: async (id, board) => {
            saved.push(board);
            await new Promise((resolve) => { release = resolve; });
            return true;
          },
        },
      });

      store.apply([{ t: 'add', obj: card('a') }]);
      scheduler.flushTimers();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(saved.length, 1, 'the first write is in flight');

      store.apply([{ t: 'set', id: 'a', patch: { x: 99 } }]);
      release();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(autosave.dirty, true, 'the edit was marked saved by a write it was not in');
      assert.equal(autosave.status, PENDING);

      // and the follow-up needs no further edit to be scheduled
      scheduler.flushTimers();
      await new Promise((resolve) => setImmediate(resolve));
      release();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(saved.length, 2);
      assert.equal(saved[1].objects[0].x, 99);
      assert.equal(autosave.dirty, false);
    });
  });

  test('a repository that rejects does not surface an unhandled rejection', async () => {
    const store = new Store();
    const scheduler = createManualScheduler();
    const repository = { load: async () => null, save: async () => { throw new Error('offline'); } };
    createAutosave({ store, repository, boardId: 'alpha', scheduler });

    store.apply([{ t: 'add', obj: card('a') }]);
    scheduler.flushTimers();

    // an unhandled rejection would take the process down between these lines
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.order.length, 1, 'the board is still there to keep editing');
  });
});
