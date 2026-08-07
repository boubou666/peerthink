// Ops that arrive before this client has a document to put them on.
//
// The channel is joined before the snapshot is read, so the window between
// the two stops being one in which other people's edits are lost. What
// arrives in it is held and replayed once there is something to replay onto.
//
// A fake channel, deliberately: what is under test is this client's own
// holding and replaying, not delivery. `sync.test.js` covers delivery over
// real Realtime, and would prove nothing extra about a buffer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../../src/core/store.js';
import { createManualScheduler } from '../../src/core/scheduler.js';
import { EVENT, createBoardSync } from '../../src/platform/sync.js';

const card = (id, text = 'hello') => ({ id, type: 'card', x: 0, y: 0, w: 100, h: 60, text });

const build = ({ heldUntil } = {}) => {
  const listeners = [];
  const channel = {
    on(type, filter, callback) {
      listeners.push({ type, filter, callback });
      return channel;
    },
    subscribe(callback) {
      callback('SUBSCRIBED');
      return channel;
    },
    send: async () => {},
    presenceState: () => ({}),
    track: async () => {},
  };

  const store = new Store();
  const sync = createBoardSync({
    client: { channel: () => channel, removeChannel: async () => {} },
    boardId: 'board-1',
    store,
    scheduler: createManualScheduler(),
    clientId: 'me',
    heldUntil,
  });

  const arrive = (ops) => {
    for (const l of listeners) {
      if (l.type === 'broadcast' && l.filter?.event === EVENT) l.callback({ payload: { ops } });
    }
  };

  return { store, sync, arrive };
};

/** Let the promise callbacks that release the buffer actually run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ops that arrive before the snapshot', () => {
  test('are not applied to the document that is about to be replaced', async () => {
    // The reason for holding at all: store.load() replaces the document, so an
    // op applied first is overwritten by a snapshot that predates it — which
    // is a change silently lost rather than merely delayed.
    const { store, arrive } = build({ heldUntil: new Promise(() => {}) });

    arrive([{ t: 'add', obj: card('c1') }]);
    await settle();

    assert.equal(store.has('c1'), false, 'a held op was applied to the document being replaced');
  });

  test('land once there is a document to put them on', async () => {
    let landed;
    const hydrated = new Promise((resolve) => { landed = resolve; });
    const { store, arrive } = build({ heldUntil: hydrated });

    arrive([{ t: 'add', obj: card('c1', 'from her') }]);
    await settle();
    assert.equal(store.has('c1'), false);

    // What hydrate() does: the snapshot, and then the ops held while it was in
    // flight. The snapshot does not contain c1 — it was written before the op
    // existed, which is the whole situation being tested.
    store.load({ v: 1, order: ['c0'], objects: [card('c0', 'from the snapshot')] });
    landed();
    await settle();

    assert.equal(store.get('c1')?.text, 'from her', "an editor's op was lost across the load");
    assert.equal(store.get('c0')?.text, 'from the snapshot', 'the replay trampled the snapshot');
  });

  test('arrive in the order they were sent', async () => {
    let landed;
    const { store, arrive } = build({ heldUntil: new Promise((resolve) => { landed = resolve; }) });

    arrive([{ t: 'add', obj: card('c1', 'first') }]);
    arrive([{ t: 'set', id: 'c1', patch: { text: 'second' } }]);
    arrive([{ t: 'set', id: 'c1', patch: { text: 'third' } }]);

    store.load({ v: 1, order: [], objects: [] });
    landed();
    await settle();

    assert.equal(store.get('c1')?.text, 'third', 'held ops were replayed out of order');
  });

  test('are dropped when the load failed, rather than landing on nothing', async () => {
    // A board that did not load is not saveable and is not the board. Replaying
    // onto it would put another editor's work somewhere it can never be
    // written back from.
    const failed = Promise.reject(new Error('no'));
    const { store, arrive } = build({ heldUntil: failed });

    arrive([{ t: 'add', obj: card('c1') }]);
    await settle();

    assert.equal(store.has('c1'), false);
  });

  test('with nothing to wait for, they are applied as they arrive', async () => {
    // The offline and local-storage builds pass no promise: there is no window
    // to cover, and holding would mean holding for ever.
    const { store, arrive } = build();

    arrive([{ t: 'add', obj: card('c1') }]);
    assert.equal(store.has('c1'), true);
  });

  test('a held op still stays out of the undo stack', async () => {
    let landed;
    const { store, arrive } = build({ heldUntil: new Promise((resolve) => { landed = resolve; }) });

    arrive([{ t: 'add', obj: card('c1') }]);
    store.load({ v: 1, order: [], objects: [] });
    landed();
    await settle();

    assert.equal(store.canUndo, false, "someone else's edit entered this user's undo stack");
  });
});
