// The guard on incoming cursors: this client never draws its own pointer.
//
// Deliberately separate from sync.test.js, which stubs nothing and proves the
// claims only real Realtime can settle. This one is about a rule of our own,
// on our side of the socket — so a fake channel is the right instrument
// rather than a shortcut. What it must not be read as is evidence about
// `broadcast: { self: false }`, which is the transport's promise and is
// exactly what this guard exists not to depend on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../../src/core/store.js';
import { createManualScheduler } from '../../src/core/scheduler.js';
import { CURSOR_EVENT, createBoardSync } from '../../src/platform/sync.js';

const build = ({ clientId }) => {
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

  const seen = [];
  const sync = createBoardSync({
    client: { channel: () => channel, removeChannel: async () => {} },
    boardId: 'board-1',
    store: new Store(),
    scheduler: createManualScheduler(),
    clientId,
    onCursor: (cursor) => seen.push(cursor),
  });

  const arrive = (payload) => {
    for (const l of listeners) {
      if (l.type === 'broadcast' && l.filter?.event === CURSOR_EVENT) l.callback({ payload });
    }
  };

  return { sync, seen, arrive };
};

describe('incoming cursors', () => {
  /**
   * A self-echoed pointer is not merely redundant, it is unrecognisable:
   * presence excludes this client from its own member list, so the pointer
   * arrives with no label and draws as an anonymous stranger on a board with
   * nobody else on it.
   */
  test('this client never draws its own pointer', () => {
    const { seen, arrive } = build({ clientId: 'me' });

    arrive({ id: 'me', x: 10, y: 20 });
    assert.deepEqual(seen, [], 'the client drew its own cursor');
  });

  test('a departure from this client is ignored too', () => {
    const { seen, arrive } = build({ clientId: 'me' });

    arrive({ id: 'me', gone: true });
    assert.deepEqual(seen, []);
  });

  test('somebody else still arrives', () => {
    const { seen, arrive } = build({ clientId: 'me' });

    arrive({ id: 'her', x: 10, y: 20 });
    arrive({ id: 'her', gone: true });
    assert.deepEqual(seen, [{ id: 'her', x: 10, y: 20 }, { id: 'her', gone: true }]);
  });
});
