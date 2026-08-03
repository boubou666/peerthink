import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLocalStorageRepository, createNullRepository } from '../../public/js/platform/storage.js';

/** Stand-in for Web Storage, with hooks for the failure modes that matter. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    failOn: null,
    getItem(key) {
      if (this.failOn === 'get') throw new Error('unavailable');
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (this.failOn === 'set') throw new DOMException('quota', 'QuotaExceededError');
      data.set(key, value);
    },
    removeItem(key) {
      if (this.failOn === 'remove') throw new Error('unavailable');
      data.delete(key);
    },
  };
}

const board = { v: 1, order: ['a'], objects: [{ id: 'a', type: 'card' }] };

describe('local storage repository', () => {
  test('round-trips a board', () => {
    const storage = fakeStorage();
    const repo = createLocalStorageRepository({ storage });
    assert.equal(repo.save(board), true);
    assert.deepEqual(repo.load(), board);
  });

  test('uses the default key, and an override when given one', () => {
    const storage = fakeStorage();
    createLocalStorageRepository({ storage }).save(board);
    assert.ok(storage.data.has('peerthink:board'));

    createLocalStorageRepository({ storage, key: 'other' }).save(board);
    assert.ok(storage.data.has('other'));
  });

  test('an absent board reads as null', () => {
    assert.equal(createLocalStorageRepository({ storage: fakeStorage() }).load(), null);
  });

  test('corrupt JSON reads as null instead of throwing', () => {
    const storage = fakeStorage({ 'peerthink:board': '{not json' });
    assert.equal(createLocalStorageRepository({ storage }).load(), null);
  });

  test('a board with no objects reads as null', () => {
    const storage = fakeStorage({ 'peerthink:board': JSON.stringify({ v: 1, order: [], objects: [] }) });
    assert.equal(createLocalStorageRepository({ storage }).load(), null);
  });

  test('unreadable storage reads as null', () => {
    const storage = fakeStorage();
    storage.failOn = 'get';
    assert.equal(createLocalStorageRepository({ storage }).load(), null);
  });

  test('a full quota is reported, not thrown', () => {
    const storage = fakeStorage();
    storage.failOn = 'set';
    assert.equal(createLocalStorageRepository({ storage }).save(board), false);
  });

  test('clear removes the board, and reports failure rather than throwing', () => {
    const storage = fakeStorage();
    const repo = createLocalStorageRepository({ storage });
    repo.save(board);
    assert.equal(repo.clear(), true);
    assert.equal(repo.load(), null);

    storage.failOn = 'remove';
    assert.equal(repo.clear(), false);
  });
});

describe('null repository', () => {
  test('accepts every call and keeps nothing', () => {
    const repo = createNullRepository();
    assert.equal(repo.load(), null);
    assert.equal(repo.save(board), false);
    assert.equal(repo.clear(), false);
    assert.equal(repo.load(), null);
  });
});
