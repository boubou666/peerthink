// Who writes the snapshot, and what happens to that answer when the channel
// goes away.
//
// A fake channel, because what is under test is this client's own reasoning
// about whether it can still stand down — not delivery, which sync.test.js
// covers over real Realtime.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../../src/core/store.js';
import { createSheets } from '../../src/core/sheets.js';
import { createIdGenerator } from '../../src/core/ids.js';
import { createManualScheduler } from '../../src/core/scheduler.js';
import { createBoardSync } from '../../src/platform/sync.js';

const build = ({ presence = {} } = {}) => {
  const listeners = [];
  let announce = () => {};
  let state = presence;

  const channel = {
    on(type, filter, callback) {
      listeners.push({ type, filter, callback });
      return channel;
    },
    subscribe(callback) {
      announce = callback;
      callback('SUBSCRIBED');
      return channel;
    },
    send: async () => 'ok',
    presenceState: () => state,
    track: async () => {},
  };

  const writerCalls = [];
  // Neither cursors nor the writer election touches sheets, but the sync is
  // built with the whole document either way — a stand-in here would be a
  // second answer to what a board is.
  const store = new Store();
  const sheets = createSheets({ store, newId: createIdGenerator() });
  sheets.load(null);

  const sync = createBoardSync({
    client: { channel: () => channel, removeChannel: async () => {} },
    boardId: 'board-1',
    store,
    sheets,
    scheduler: createManualScheduler(),
    clientId: 'me',
    onWriter: (isWriter) => writerCalls.push(isWriter),
  });

  /** Presence says who is on the board; the earliest joiner writes. */
  const presenceSays = (next) => {
    state = next;
    for (const l of listeners) if (l.type === 'presence') l.callback();
  };

  return { sync, writerCalls, presenceSays, status: (s) => announce(s) };
};

const other = (id, at) => ({ [id]: [{ id, at }] });

describe('who writes the snapshot', () => {
  test('alone on the board, this client writes', () => {
    const { sync } = build();
    assert.equal(sync.isWriter(), true);
  });

  test('an earlier joiner takes the job', () => {
    const { sync, presenceSays } = build();

    presenceSays({ ...other('her', 1), ...other('me', 2) });
    assert.equal(sync.isWriter(), false, 'both clients would write the snapshot');
  });

  /**
   * The claim in the README, and the reason this file exists. Standing down is
   * a promise that somebody else is storing these edits — it is only as good
   * as the channel carrying them there. A client that has lost the channel
   * holds ops the elected writer has never seen, and reporting the board saved
   * on the strength of a broadcast is a claim about a message that may have
   * gone nowhere: `channel.send` for a broadcast without `ack` resolves 'ok'
   * before the socket has been written to.
   */
  test('losing the channel takes the job back', () => {
    const { sync, presenceSays, status } = build();

    presenceSays({ ...other('her', 1), ...other('me', 2) });
    assert.equal(sync.isWriter(), false);

    status('CLOSED');
    assert.equal(sync.isWriter(), true, 'a disconnected client left its edits to somebody it cannot reach');
    assert.equal(sync.isLive(), false);
  });

  test('and rejoining hands it back, if somebody else is still older', () => {
    const { sync, presenceSays, status } = build();

    presenceSays({ ...other('her', 1), ...other('me', 2) });
    status('CHANNEL_ERROR');
    assert.equal(sync.isWriter(), true);

    status('SUBSCRIBED');
    presenceSays({ ...other('her', 1), ...other('me', 2) });
    assert.equal(sync.isWriter(), false, 'the client kept writing after it could stand down again');
  });

  test('a join that never succeeded writes, rather than waiting for one', () => {
    // A board the policy refuses reports CLOSED, not an error. It still opens,
    // still edits, and must still save.
    const { sync, status } = build();

    status('CLOSED');
    assert.equal(sync.isWriter(), true);
  });

  describe('telling the caller', () => {
    test('a change is reported once, whatever caused it', () => {
      const { writerCalls, presenceSays, status } = build();

      presenceSays({ ...other('her', 1), ...other('me', 2) });
      presenceSays({ ...other('her', 1), ...other('me', 2) });
      assert.deepEqual(writerCalls, [false], 'the same answer was reported twice');

      status('CLOSED');
      status('CLOSED');
      assert.deepEqual(writerCalls, [false, true], 'a repeated drop was reported as a change');
    });

    /**
     * Taking the job back is what makes the held edits get written: createApp
     * flushes the autosave on this callback. Without it the client waits for
     * the next edit before saving anything, which for someone who has stopped
     * typing is for ever.
     */
    test('taking the job back is announced, not just answered', () => {
      const { writerCalls, presenceSays, status } = build();

      presenceSays({ ...other('her', 1), ...other('me', 2) });
      writerCalls.length = 0;

      status('CLOSED');
      assert.deepEqual(writerCalls, [true], 'nothing told the autosave it had become the writer');
    });
  });
});
