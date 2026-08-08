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

import { REMOTE, Store } from '../../src/core/store.js';
import { createSheets } from '../../src/core/sheets.js';
import { createIdGenerator } from '../../src/core/ids.js';
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
    send: async (message) => { sent.push(message); },
    presenceState: () => ({}),
    track: async () => {},
  };

  const sent = [];
  const scheduler = createManualScheduler();
  const store = new Store();
  // Real sheets, so what is asserted about held ops is asserted about the
  // routing they now go through rather than around it.
  const sheets = createSheets({ store, newId: createIdGenerator() });
  sheets.load(null);

  const sync = createBoardSync({
    client: { channel: () => channel, removeChannel: async () => {} },
    boardId: 'board-1',
    store,
    sheets,
    scheduler,
    clientId: 'me',
    heldUntil,
  });

  /** `sheet` left out is what a client with one canvas sends, and what a
      client from before sheets sent. */
  const arrive = (ops, sheet) => {
    for (const l of listeners) {
      if (l.type === 'broadcast' && l.filter?.event === EVENT) l.callback({ payload: { ops, ...(sheet ? { sheet } : {}) } });
    }
  };

  return { store, sheets, sync, arrive, sent, scheduler };
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

  test('and so is everything that arrives after the load failed', async () => {
    // The failure is terminal, not a moment. Before this client joined the
    // channel early, a load that failed meant no channel at all and so no
    // remote ops ever — letting later ones through would be a new way to put
    // somebody's work where it cannot be saved.
    const { store, arrive } = build({ heldUntil: Promise.reject(new Error('no')) });
    await settle();

    arrive([{ t: 'add', obj: card('c2') }]);
    await settle();

    assert.equal(store.has('c2'), false, 'an op after a failed load was applied anyway');
  });

  test('and so is everything that arrives after the app was destroyed', async () => {
    // A load that never settles leaves the gate pending for ever; destroy() is
    // what stops the buffer outliving the app that was waiting on it.
    const { store, sync, arrive } = build({ heldUntil: new Promise(() => {}) });

    arrive([{ t: 'add', obj: card('c1') }]);
    await sync.destroy();
    arrive([{ t: 'add', obj: card('c2') }]);
    await settle();

    assert.equal(store.has('c1'), false);
    assert.equal(store.has('c2'), false);
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

/**
 * Which sheet an op belongs to.
 *
 * A board has several canvases now, and two people on it need not be looking
 * at the same one. An op that arrived without saying where it went would be
 * applied to whatever the receiver happens to have open — one editor's work
 * landing on another editor's canvas, which is the failure this addressing
 * exists to prevent.
 */
describe('ops and the sheet they were made on', () => {
  test('going out, an op names the sheet it was made on', async () => {
    const { store, sheets, sent } = build();
    const second = sheets.add();

    store.apply([{ t: 'add', obj: card('c1') }]);
    await settle();

    const [message] = sent.filter((m) => m.event === EVENT);
    assert.equal(message.payload.sheet, second, 'the op went out for the wrong sheet');
    assert.equal(message.payload.ops.length, 1);
  });

  /**
   * The throttle holds ops for up to `sendEvery` after they were made, and
   * switching sheets in that window is one click. Addressed at send time, a
   * drag on one sheet would arrive on everyone else's copy of another.
   */
  test('the sheet is the one it was made on, not the one showing when it goes out', async () => {
    const { store, sheets, sent, scheduler } = build();
    const first = sheets.activeId;

    store.apply([{ t: 'add', obj: card('c1') }]);
    const second = sheets.add();
    scheduler.flushTimers();
    await settle();

    const [message] = sent.filter((m) => m.event === EVENT);
    assert.equal(message.payload.sheet, first, 'the op was readdressed to the sheet switched to');
    assert.notEqual(message.payload.sheet, second);
  });

  /**
   * Before the board has loaded, "which sheet is this on" has no settled
   * answer: the sheet on screen is the empty one this client started with, and
   * the load is about to replace it. Sent then, the ops name a sheet nobody
   * else has, and every receiver drops them.
   */
  test('an op made before the board loaded goes out addressed to the board', async () => {
    let landed;
    const { store, sheets, sent, scheduler } = build({
      heldUntil: new Promise((resolve) => { landed = resolve; }),
    });

    store.apply([{ t: 'add', obj: card('early') }]);
    await settle();
    assert.deepEqual(sent.filter((m) => m.event === EVENT), [], 'an op went out before it could be addressed');

    /**
     * All of what `hydrate()` does, in its order: the board arrives and its
     * own first sheet — with an id every client agrees on — becomes the one on
     * screen, and then the edits made while it was in flight are replayed onto
     * it. As REMOTE, because they were already handed to the channel when they
     * happened and replaying them as local would send each one twice.
     *
     * The replay is why the person who made those edits keeps them: the load
     * replaced the document they were applied to. Modelled here rather than
     * left out, so this test cannot be read as saying they are lost.
     */
    sheets.load({ v: 2, sheets: [{ id: 'from-the-board', name: 'Discovery', order: [], objects: [] }] });
    store.apply([{ t: 'add', obj: card('early') }], false, REMOTE);
    landed();
    await settle();
    scheduler.flushTimers();

    const [message] = sent.filter((m) => m.event === EVENT);
    assert.equal(message.payload.sheet, 'from-the-board', 'it went out naming a sheet nobody else has');
    assert.equal(message.payload.ops.length, 1, 'the op was sent twice, or not at all');
    assert.equal(store.has('early'), true, 'the edit made during the load was lost by the one who made it');
  });

  test('arriving, it lands on that sheet rather than the one on screen', async () => {
    const { store, sheets, arrive } = build();
    const [first] = sheets.list();
    sheets.add();

    arrive([{ t: 'add', obj: card('hers') }], first.id);
    await settle();
    assert.equal(store.has('hers'), false, "somebody else's edit landed on the sheet on screen");

    sheets.select(first.id);
    assert.equal(store.has('hers'), true, 'the edit did not reach the sheet it was made on');
  });

  /**
   * A client whose board has one sheet, or one from before there were any,
   * sends no sheet at all. Both mean the canvas they are looking at.
   */
  test('an op that names no sheet lands on the one on screen', async () => {
    const { store, arrive } = build();
    arrive([{ t: 'add', obj: card('c1') }]);
    await settle();
    assert.equal(store.has('c1'), true);
  });

  test('a held op keeps the sheet it was for', async () => {
    let landed;
    const { store, sheets, arrive } = build({
      heldUntil: new Promise((resolve) => { landed = resolve; }),
    });

    const [first] = sheets.list();
    const second = sheets.add();
    arrive([{ t: 'add', obj: card('hers') }], first.id);

    landed();
    await settle();

    assert.equal(store.has('hers'), false, 'a replayed op forgot which sheet it was for');
    assert.equal(sheets.activeId, second);
    sheets.select(first.id);
    assert.equal(store.has('hers'), true);
  });
});
