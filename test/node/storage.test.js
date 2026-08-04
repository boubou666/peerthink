import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BOARD_ID,
  DEFAULT_TITLE,
  LEGACY_KEY,
  createLocalStorageRepository,
  createNullRepository,
} from '../../src/platform/storage.js';

/** Stand-in for Web Storage, with hooks for the failure modes that matter. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    failOn: null,
    get length() {
      if (this.failOn === 'enumerate') throw new Error('unavailable');
      return data.size;
    },
    key(i) {
      return [...data.keys()][i] ?? null;
    },
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

const board = (n = 1) => ({
  v: 1,
  order: Array.from({ length: n }, (_, i) => `o${i}`),
  objects: Array.from({ length: n }, (_, i) => ({ id: `o${i}`, type: 'card', x: 0, y: 0, w: 1, h: 1 })),
});

describe('local storage repository', () => {
  let storage;
  let clock;
  let repo;

  beforeEach(() => {
    storage = fakeStorage();
    clock = 1000;
    repo = createLocalStorageRepository({ storage, now: () => clock });
  });

  describe('save and load', () => {
    test('round-trips a board under its own id', async () => {
      assert.equal(await repo.save('alpha', board()), true);
      const record = await repo.load('alpha');
      assert.equal(record.id, 'alpha');
      assert.deepEqual(record.board, board());
    });

    test('boards are independent', async () => {
      await repo.save('alpha', board(1));
      await repo.save('beta', board(3));
      assert.equal((await repo.load('alpha')).board.objects.length, 1);
      assert.equal((await repo.load('beta')).board.objects.length, 3);
    });

    test('an unknown id reads as null', async () => {
      assert.equal(await repo.load('nope'), null);
    });

    test('an empty board is a real board, not a missing one', async () => {
      // the single-board version treated this as "nothing saved" and re-seeded
      await repo.save('alpha', { v: 1, order: [], objects: [] });
      assert.deepEqual((await repo.load('alpha')).board.objects, []);
    });

    test('refuses to store something that is not a board', async () => {
      assert.equal(await repo.save('alpha', null), false);
      assert.equal(await repo.save('alpha', { objects: 'nope' }), false);
      assert.equal(await repo.load('alpha'), null);
    });

    test('stamps updatedAt from the injected clock', async () => {
      await repo.save('alpha', board());
      assert.equal((await repo.load('alpha')).updatedAt, 1000);
      clock = 2000;
      await repo.save('alpha', board());
      assert.equal((await repo.load('alpha')).updatedAt, 2000);
    });

    test('defaults the title, and keeps an existing one across saves', async () => {
      await repo.save('alpha', board());
      assert.equal((await repo.load('alpha')).title, DEFAULT_TITLE);

      await repo.save('alpha', board(), { title: 'Roadmap' });
      await repo.save('alpha', board(2));
      assert.equal((await repo.load('alpha')).title, 'Roadmap', 'a save without a title does not reset it');
    });

    test('namespaces its keys, so two workspaces cannot collide', async () => {
      await repo.save('alpha', board());
      await createLocalStorageRepository({ storage, namespace: 'other' }).save('alpha', board(2));

      assert.equal((await repo.load('alpha')).board.objects.length, 1);
      assert.deepEqual([...storage.data.keys()].sort(), ['other:board:alpha', 'peerthink:board:alpha']);
    });
  });

  describe('list', () => {
    test('summarises every board, newest first', async () => {
      clock = 100;
      await repo.save('old', board(), { title: 'Old' });
      clock = 300;
      await repo.save('new', board(), { title: 'New' });
      clock = 200;
      await repo.save('mid', board(), { title: 'Mid' });

      // `owned` is part of the contract, and true for everything here: nobody
      // else can reach this browser's storage.
      assert.deepEqual(await repo.list(), [
        { id: 'new', title: 'New', updatedAt: 300, owned: true },
        { id: 'mid', title: 'Mid', updatedAt: 200, owned: true },
        { id: 'old', title: 'Old', updatedAt: 100, owned: true },
      ]);
    });

    test('is empty when nothing is stored', async () => {
      assert.deepEqual(await repo.list(), []);
    });

    test('ignores unrelated keys and unreadable records', async () => {
      await repo.save('good', board());
      storage.data.set('unrelated', 'whatever');
      storage.data.set('peerthink:board:broken', '{not json');
      storage.data.set('peerthink:board:wrongshape', JSON.stringify({ v: 1, board: { nope: true } }));

      assert.deepEqual((await repo.list()).map((b) => b.id), ['good']);
    });

    test('trusts the key over an id field that disagrees with it', async () => {
      // a record written by an older version, or edited by hand
      storage.data.set('peerthink:board:real-id', JSON.stringify({
        v: 1, id: 'stale-id', title: 'T', updatedAt: 5, board: board(),
      }));
      assert.deepEqual((await repo.list()).map((b) => b.id), ['real-id']);
    });

    test('a record missing its metadata still sorts and still has a label', async () => {
      storage.data.set('peerthink:board:bare', JSON.stringify({ v: 1, board: board() }));
      clock = 50;
      await repo.save('dated', board(), { title: 'Dated' });

      assert.deepEqual(await repo.list(), [
        { id: 'dated', title: 'Dated', updatedAt: 50, owned: true },
        { id: 'bare', title: DEFAULT_TITLE, updatedAt: 0, owned: true },
      ]);
    });

    test('storage that cannot be enumerated degrades to an empty list', async () => {
      await repo.save('alpha', board());
      storage.failOn = 'enumerate';
      assert.deepEqual(await repo.list(), []);

      storage.failOn = null;
      assert.equal((await repo.load('alpha')).id, 'alpha', 'load by id still works');
    });
  });

  describe('rename', () => {
    test('changes the title and restamps', async () => {
      await repo.save('alpha', board());
      clock = 5000;
      assert.equal(await repo.rename('alpha', 'Q3 planning'), true);
      assert.equal((await repo.load('alpha')).title, 'Q3 planning');
      assert.equal((await repo.load('alpha')).updatedAt, 5000);
    });

    test('leaves the board itself alone', async () => {
      await repo.save('alpha', board(3));
      await repo.rename('alpha', 'Renamed');
      assert.equal((await repo.load('alpha')).board.objects.length, 3);
    });

    test('reports failure for an unknown board', async () => {
      assert.equal(await repo.rename('nope', 'x'), false);
    });
  });

  describe('remove', () => {
    test('deletes one board and leaves the others', async () => {
      await repo.save('alpha', board());
      await repo.save('beta', board());
      assert.equal(await repo.remove('alpha'), true);
      assert.equal(await repo.load('alpha'), null);
      assert.equal((await repo.load('beta')).id, 'beta');
    });

    test('reports failure rather than throwing', async () => {
      storage.failOn = 'remove';
      assert.equal(await repo.remove('alpha'), false);
    });
  });

  describe('failure modes', () => {
    test('unreadable storage reads as null', async () => {
      await repo.save('alpha', board());
      storage.failOn = 'get';
      assert.equal(await repo.load('alpha'), null);
    });

    test('corrupt JSON reads as null', async () => {
      storage.data.set('peerthink:board:alpha', '{not json');
      assert.equal(await repo.load('alpha'), null);
    });

    test('a full quota is reported, not thrown', async () => {
      storage.failOn = 'set';
      assert.equal(await repo.save('alpha', board()), false);
    });
  });

  describe('migrateLegacy', () => {
    const legacy = board(2);

    test('adopts a single-board record and clears the old key', async () => {
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));

      assert.equal(await repo.migrateLegacy(), true);
      assert.deepEqual((await repo.load(DEFAULT_BOARD_ID)).board, legacy);
      assert.equal(storage.data.has(LEGACY_KEY), false);
    });

    test('takes a target id and title', async () => {
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));
      await repo.migrateLegacy({ toId: 'imported', title: 'From v1' });

      const record = await repo.load('imported');
      assert.equal(record.title, 'From v1');
      assert.deepEqual(record.board, legacy);
    });

    test('does nothing when there is no legacy board', async () => {
      assert.equal(await repo.migrateLegacy(), false);
    });

    test('never overwrites a board that already exists', async () => {
      await repo.save(DEFAULT_BOARD_ID, board(9), { title: 'Mine' });
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));

      assert.equal(await repo.migrateLegacy(), false);
      assert.equal((await repo.load(DEFAULT_BOARD_ID)).board.objects.length, 9);
      assert.equal(storage.data.has(LEGACY_KEY), true, 'the legacy board is left for inspection');
    });

    test('a non-default namespace leaves the legacy board alone', async () => {
      // both repositories share one Web Storage, and the legacy key belongs to
      // the default workspace — adopting it here would steal someone's board
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));
      const scratch = createLocalStorageRepository({ storage, namespace: 'scratch', now: () => clock });

      assert.equal(await scratch.migrateLegacy(), false);
      assert.equal(await scratch.load(DEFAULT_BOARD_ID), null);
      assert.equal(storage.data.has(LEGACY_KEY), true);

      assert.equal(await repo.migrateLegacy(), true, 'the owning workspace still adopts it');
    });

    test('an explicit legacy key overrides the namespace rule', async () => {
      storage.data.set('other:board', JSON.stringify(legacy));
      const scoped = createLocalStorageRepository({
        storage, namespace: 'scratch', legacyKey: 'other:board', now: () => clock,
      });

      assert.equal(await scoped.migrateLegacy(), true);
      assert.deepEqual((await scoped.load(DEFAULT_BOARD_ID)).board, legacy);
    });

    test('ignores a legacy key holding junk', async () => {
      storage.data.set(LEGACY_KEY, '{not json');
      assert.equal(await repo.migrateLegacy(), false);

      storage.data.set(LEGACY_KEY, JSON.stringify({ nope: true }));
      assert.equal(await repo.migrateLegacy(), false);
    });

    test('reports failure when the copy cannot be written', async () => {
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));
      storage.failOn = 'set';
      assert.equal(await repo.migrateLegacy(), false);
    });

    test('keeps the migrated copy even if the old key cannot be cleared', async () => {
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));
      storage.failOn = 'remove';

      assert.equal(await repo.migrateLegacy(), true);
      assert.deepEqual((await repo.load(DEFAULT_BOARD_ID)).board, legacy);
    });
  });
});

describe('null repository', () => {
  test('accepts every call and keeps nothing', async () => {
    const repo = createNullRepository();
    assert.deepEqual(await repo.list(), []);
    assert.equal(await repo.load('alpha'), null);
    assert.equal(await repo.save('alpha', board()), false);
    assert.equal(await repo.rename('alpha', 'x'), false);
    assert.equal(await repo.remove('alpha'), false);
    assert.equal(await repo.migrateLegacy(), false);
    assert.equal(await repo.load('alpha'), null);
  });
});
