import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ADOPTED_KEY, adoptBoards } from '../../src/platform/adopt.js';
import { createLocalStorageRepository } from '../../src/platform/storage.js';

/**
 * Moving a browser's boards into an account.
 *
 * Driven against the real Web Storage repository on one side and a stub
 * account on the other, because what is being checked is the policy — never
 * overwrite the account, never delete the browser's copy, and be safe to run
 * again after a failure — rather than either repository's own behaviour.
 */

/** The fake Web Storage the local repository is built on elsewhere too. */
function fakeStorage() {
  const data = new Map();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

/** An account, with a record of what was asked of it. */
function fakeAccount({ existing = {}, save } = {}) {
  const boards = new Map(Object.entries(existing));
  const calls = { loads: [], saves: [] };

  return {
    boards,
    calls,
    async load(id) {
      calls.loads.push(id);
      const board = boards.get(id);
      return board ? { v: 1, id, title: board.title, updatedAt: 1, board: board.doc } : null;
    },
    async save(id, doc, { title } = {}) {
      calls.saves.push({ id, title });
      if (save && !(await save(id))) return false;
      boards.set(id, { title, doc });
      return true;
    },
  };
}

const board = (id) => ({ v: 1, order: [id], objects: [{ id, type: 'card', text: id }] });

describe('adopting a browser\'s boards', () => {
  let storage;
  let local;

  beforeEach(async () => {
    storage = fakeStorage();
    local = createLocalStorageRepository({ storage });
    await local.save('a', board('a'), { title: 'Roadmap' });
    await local.save('b', board('b'), { title: 'Retro' });
  });

  test('every board moves, keeping its id and its name', async () => {
    const remote = fakeAccount();

    const result = await adoptBoards({ local, remote, storage });

    assert.deepEqual(result, { adopted: 2, kept: 0, failed: 0, done: true });
    assert.deepEqual([...remote.boards.keys()].sort(), ['a', 'b']);
    assert.equal(remote.boards.get('a').title, 'Roadmap');
    assert.deepEqual(remote.boards.get('a').doc, board('a'));
  });

  /** Copying is reversible; deleting is not. */
  test('the browser keeps its copies', async () => {
    await adoptBoards({ local, remote: fakeAccount(), storage });

    assert.deepEqual((await local.list()).map((b) => b.id).sort(), ['a', 'b']);
  });

  test('it happens once, however many times it is asked', async () => {
    const remote = fakeAccount();

    await adoptBoards({ local, remote, storage });
    const second = await adoptBoards({ local, remote, storage });

    assert.deepEqual(second, { adopted: 0, kept: 0, failed: 0, done: true });
    assert.equal(remote.calls.saves.length, 2, 'the second run wrote again');
    assert.equal(remote.calls.loads.length, 2, 'the second run even looked');
  });

  /**
   * The account's copy is the one other people may have edited. A browser that
   * has been sitting closed must not put its version on top of it.
   */
  test('a board the account already has is left alone', async () => {
    const remote = fakeAccount({ existing: { a: { title: 'Roadmap, edited elsewhere', doc: board('newer') } } });

    const result = await adoptBoards({ local, remote, storage });

    assert.deepEqual(result, { adopted: 1, kept: 1, failed: 0, done: true });
    assert.equal(remote.boards.get('a').title, 'Roadmap, edited elsewhere');
    assert.deepEqual(remote.boards.get('a').doc, board('newer'));
    assert.deepEqual(remote.calls.saves.map((s) => s.id), ['b']);
  });

  describe('when a write does not land', () => {
    test('it is reported and nothing is marked finished', async () => {
      const remote = fakeAccount({ save: async (id) => id !== 'b' });

      const result = await adoptBoards({ local, remote, storage });

      assert.deepEqual(result, { adopted: 1, kept: 0, failed: 1, done: false });
      assert.equal(storage.getItem(ADOPTED_KEY), null, 'a partial adoption was marked done');
    });

    test('the next sign-in finishes the job without duplicating the first half', async () => {
      let offline = true;
      const remote = fakeAccount({ save: async (id) => !(offline && id === 'b') });

      await adoptBoards({ local, remote, storage });
      offline = false;
      const second = await adoptBoards({ local, remote, storage });

      // 'a' landed the first time, so the second run finds it in the account
      assert.deepEqual(second, { adopted: 1, kept: 1, failed: 0, done: true });
      assert.deepEqual([...remote.boards.keys()].sort(), ['a', 'b']);
    });
  });

  test('the marker records when it happened, from the clock it was given', async () => {
    await adoptBoards({ local, remote: fakeAccount(), storage, now: () => 'the moment it happened' });

    assert.equal(storage.getItem(ADOPTED_KEY), 'the moment it happened');
  });

  test('a browser with nothing in it is finished immediately', async () => {
    const empty = fakeStorage();
    const result = await adoptBoards({
      local: createLocalStorageRepository({ storage: empty }),
      remote: fakeAccount(),
      storage: empty,
    });

    assert.deepEqual(result, { adopted: 0, kept: 0, failed: 0, done: true });
  });

  /**
   * The marker is a convenience, not the correctness argument — storage that
   * refuses to remember it still must not produce two copies of a board.
   */
  test('storage that cannot remember still does not duplicate', async () => {
    const forgetful = { ...fakeStorage(), setItem() { throw new Error('full'); } };
    Object.assign(forgetful, {
      getItem: (k) => storage.getItem(k),
      key: (i) => storage.key(i),
      get length() { return storage.length; },
    });

    const remote = fakeAccount();
    await adoptBoards({ local, remote, storage: forgetful });
    const second = await adoptBoards({ local, remote, storage: forgetful });

    assert.equal(second.kept, 2, 'the second run did not recognise its own work');
    assert.equal(second.adopted, 0);
    assert.deepEqual([...remote.boards.keys()].sort(), ['a', 'b']);
  });
});
