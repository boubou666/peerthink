// Which boards this browser has already shown.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSeenBoards } from '../../src/platform/seen-boards.js';

const fakeStorage = (initial = {}) => {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
  };
};

const build = (initial) => {
  const storage = fakeStorage(initial);
  return { storage, seen: createSeenBoards({ storage, accountId: 'u1' }) };
};

describe('seen boards', () => {
  test('the first look at a workspace announces nothing', () => {
    // Everything already there is not new, it is the workspace. Flagging all of
    // it would make the badge meaningless on the visit where it shows most.
    const { seen } = build();
    assert.deepEqual([...seen.reconcile(['a', 'b'])], []);
  });

  test('a board that turns up later is new', () => {
    const { seen } = build();
    seen.reconcile(['a', 'b']);

    assert.deepEqual([...seen.reconcile(['a', 'b', 'c'])], ['c']);
  });

  test('and stays new until it is opened', () => {
    // Reconciling is looking at the list, not at the board. A badge that
    // cleared on the next refresh would be gone before it was read.
    const { seen } = build();
    seen.reconcile(['a']);
    seen.reconcile(['a', 'b']);

    assert.deepEqual([...seen.reconcile(['a', 'b'])], ['b'], 'the badge cleared without being opened');

    seen.markSeen('b');
    assert.deepEqual([...seen.reconcile(['a', 'b'])], []);
  });

  test('a board that has gone is forgotten, so the record cannot grow for ever', () => {
    const { storage, seen } = build();
    seen.reconcile(['a', 'b', 'c']);
    seen.reconcile(['a']);

    assert.deepEqual(JSON.parse(storage.getItem('peerthink:seen:u1')), ['a']);
  });

  test('a board that goes and comes back is new again', () => {
    // It was left, or revoked and shared again. Either way this browser has
    // not shown it since, and saying so is better than remembering for ever.
    const { seen } = build();
    seen.reconcile(['a', 'b']);
    seen.reconcile(['a']);

    assert.deepEqual([...seen.reconcile(['a', 'b'])], ['b']);
  });

  test('each account keeps its own record', () => {
    const storage = fakeStorage();
    const mine = createSeenBoards({ storage, accountId: 'u1' });
    const theirs = createSeenBoards({ storage, accountId: 'u2' });

    mine.reconcile(['a']);
    // Signing in as somebody else must not inherit the last person's idea of
    // what is new — theirs is a first look, so it seeds rather than announces.
    assert.deepEqual([...theirs.reconcile(['a', 'z'])], []);
    assert.deepEqual([...mine.reconcile(['a', 'z'])], ['z']);
  });

  describe('when the record cannot be trusted', () => {
    test('no storage at all reads as everything seen', () => {
      // A badge that never appears is a missing nicety. One that appears on
      // everything every visit is noise the user cannot switch off.
      const seen = createSeenBoards({ storage: null, accountId: 'u1' });

      seen.reconcile(['a']);
      assert.deepEqual([...seen.reconcile(['a', 'b'])], []);
      assert.doesNotThrow(() => seen.markSeen('a'));
    });

    test('a record that is not JSON is treated as no record', () => {
      const { seen } = build({ 'peerthink:seen:u1': 'not json' });
      assert.deepEqual([...seen.reconcile(['a', 'b'])], [], 'a corrupt record announced the whole workspace');
    });

    test('a store that refuses to write costs a badge, not a board', () => {
      const storage = fakeStorage();
      storage.setItem = () => { throw new Error('quota'); };
      const seen = createSeenBoards({ storage, accountId: 'u1' });

      assert.doesNotThrow(() => seen.reconcile(['a']));
      assert.doesNotThrow(() => seen.markSeen('a'));
    });

    test('a store that reads but will not write marks nothing', () => {
      // The nastier half: the old record is still readable, so a badge would
      // be computed — and markSeen cannot clear it, so it would come back on
      // every visit for ever. Readable and unwritable is the same situation as
      // no storage at all, and gets the same answer.
      const storage = fakeStorage({ 'peerthink:seen:u1': JSON.stringify(['a']) });
      const seen = createSeenBoards({ storage, accountId: 'u1' });

      assert.deepEqual([...seen.reconcile(['a', 'b'])], ['b'], 'a writable store should still mark');

      storage.setItem = () => { throw new Error('quota'); };
      assert.deepEqual([...seen.reconcile(['a', 'b'])], [], 'a badge was shown that could never be cleared');
    });
  });
});
