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
    test('round-trips a board under its own id', () => {
      assert.equal(repo.save('alpha', board()), true);
      const record = repo.load('alpha');
      assert.equal(record.id, 'alpha');
      assert.deepEqual(record.board, board());
    });

    test('boards are independent', () => {
      repo.save('alpha', board(1));
      repo.save('beta', board(3));
      assert.equal(repo.load('alpha').board.objects.length, 1);
      assert.equal(repo.load('beta').board.objects.length, 3);
    });

    test('an unknown id reads as null', () => {
      assert.equal(repo.load('nope'), null);
    });

    test('an empty board is a real board, not a missing one', () => {
      // the single-board version treated this as "nothing saved" and re-seeded
      repo.save('alpha', { v: 1, order: [], objects: [] });
      assert.deepEqual(repo.load('alpha').board.objects, []);
    });

    test('refuses to store something that is not a board', () => {
      assert.equal(repo.save('alpha', null), false);
      assert.equal(repo.save('alpha', { objects: 'nope' }), false);
      assert.equal(repo.load('alpha'), null);
    });

    test('stamps updatedAt from the injected clock', () => {
      repo.save('alpha', board());
      assert.equal(repo.load('alpha').updatedAt, 1000);
      clock = 2000;
      repo.save('alpha', board());
      assert.equal(repo.load('alpha').updatedAt, 2000);
    });

    test('defaults the title, and keeps an existing one across saves', () => {
      repo.save('alpha', board());
      assert.equal(repo.load('alpha').title, DEFAULT_TITLE);

      repo.save('alpha', board(), { title: 'Roadmap' });
      repo.save('alpha', board(2));
      assert.equal(repo.load('alpha').title, 'Roadmap', 'a save without a title does not reset it');
    });

    test('namespaces its keys, so two workspaces cannot collide', () => {
      repo.save('alpha', board());
      createLocalStorageRepository({ storage, namespace: 'other' }).save('alpha', board(2));

      assert.equal(repo.load('alpha').board.objects.length, 1);
      assert.deepEqual([...storage.data.keys()].sort(), ['other:board:alpha', 'peerthink:board:alpha']);
    });
  });

  describe('list', () => {
    test('summarises every board, newest first', () => {
      clock = 100;
      repo.save('old', board(), { title: 'Old' });
      clock = 300;
      repo.save('new', board(), { title: 'New' });
      clock = 200;
      repo.save('mid', board(), { title: 'Mid' });

      assert.deepEqual(repo.list(), [
        { id: 'new', title: 'New', updatedAt: 300 },
        { id: 'mid', title: 'Mid', updatedAt: 200 },
        { id: 'old', title: 'Old', updatedAt: 100 },
      ]);
    });

    test('is empty when nothing is stored', () => {
      assert.deepEqual(repo.list(), []);
    });

    test('ignores unrelated keys and unreadable records', () => {
      repo.save('good', board());
      storage.data.set('unrelated', 'whatever');
      storage.data.set('peerthink:board:broken', '{not json');
      storage.data.set('peerthink:board:wrongshape', JSON.stringify({ v: 1, board: { nope: true } }));

      assert.deepEqual(repo.list().map((b) => b.id), ['good']);
    });

    test('trusts the key over an id field that disagrees with it', () => {
      // a record written by an older version, or edited by hand
      storage.data.set('peerthink:board:real-id', JSON.stringify({
        v: 1, id: 'stale-id', title: 'T', updatedAt: 5, board: board(),
      }));
      assert.deepEqual(repo.list().map((b) => b.id), ['real-id']);
    });

    test('a record missing its metadata still sorts and still has a label', () => {
      storage.data.set('peerthink:board:bare', JSON.stringify({ v: 1, board: board() }));
      clock = 50;
      repo.save('dated', board(), { title: 'Dated' });

      assert.deepEqual(repo.list(), [
        { id: 'dated', title: 'Dated', updatedAt: 50 },
        { id: 'bare', title: DEFAULT_TITLE, updatedAt: 0 },
      ]);
    });

    test('storage that cannot be enumerated degrades to an empty list', () => {
      repo.save('alpha', board());
      storage.failOn = 'enumerate';
      assert.deepEqual(repo.list(), []);

      storage.failOn = null;
      assert.equal(repo.load('alpha').id, 'alpha', 'load by id still works');
    });
  });

  describe('rename', () => {
    test('changes the title and restamps', () => {
      repo.save('alpha', board());
      clock = 5000;
      assert.equal(repo.rename('alpha', 'Q3 planning'), true);
      assert.equal(repo.load('alpha').title, 'Q3 planning');
      assert.equal(repo.load('alpha').updatedAt, 5000);
    });

    test('leaves the board itself alone', () => {
      repo.save('alpha', board(3));
      repo.rename('alpha', 'Renamed');
      assert.equal(repo.load('alpha').board.objects.length, 3);
    });

    test('reports failure for an unknown board', () => {
      assert.equal(repo.rename('nope', 'x'), false);
    });
  });

  describe('remove', () => {
    test('deletes one board and leaves the others', () => {
      repo.save('alpha', board());
      repo.save('beta', board());
      assert.equal(repo.remove('alpha'), true);
      assert.equal(repo.load('alpha'), null);
      assert.equal(repo.load('beta').id, 'beta');
    });

    test('reports failure rather than throwing', () => {
      storage.failOn = 'remove';
      assert.equal(repo.remove('alpha'), false);
    });
  });

  describe('failure modes', () => {
    test('unreadable storage reads as null', () => {
      repo.save('alpha', board());
      storage.failOn = 'get';
      assert.equal(repo.load('alpha'), null);
    });

    test('corrupt JSON reads as null', () => {
      storage.data.set('peerthink:board:alpha', '{not json');
      assert.equal(repo.load('alpha'), null);
    });

    test('a full quota is reported, not thrown', () => {
      storage.failOn = 'set';
      assert.equal(repo.save('alpha', board()), false);
    });
  });

  describe('migrateLegacy', () => {
    const legacy = board(2);

    test('adopts a single-board record and clears the old key', () => {
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));

      assert.equal(repo.migrateLegacy(), true);
      assert.deepEqual(repo.load(DEFAULT_BOARD_ID).board, legacy);
      assert.equal(storage.data.has(LEGACY_KEY), false);
    });

    test('takes a target id and title', () => {
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));
      repo.migrateLegacy({ toId: 'imported', title: 'From v1' });

      const record = repo.load('imported');
      assert.equal(record.title, 'From v1');
      assert.deepEqual(record.board, legacy);
    });

    test('does nothing when there is no legacy board', () => {
      assert.equal(repo.migrateLegacy(), false);
    });

    test('never overwrites a board that already exists', () => {
      repo.save(DEFAULT_BOARD_ID, board(9), { title: 'Mine' });
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));

      assert.equal(repo.migrateLegacy(), false);
      assert.equal(repo.load(DEFAULT_BOARD_ID).board.objects.length, 9);
      assert.equal(storage.data.has(LEGACY_KEY), true, 'the legacy board is left for inspection');
    });

    test('a non-default namespace leaves the legacy board alone', () => {
      // both repositories share one Web Storage, and the legacy key belongs to
      // the default workspace — adopting it here would steal someone's board
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));
      const scratch = createLocalStorageRepository({ storage, namespace: 'scratch', now: () => clock });

      assert.equal(scratch.migrateLegacy(), false);
      assert.equal(scratch.load(DEFAULT_BOARD_ID), null);
      assert.equal(storage.data.has(LEGACY_KEY), true);

      assert.equal(repo.migrateLegacy(), true, 'the owning workspace still adopts it');
    });

    test('an explicit legacy key overrides the namespace rule', () => {
      storage.data.set('other:board', JSON.stringify(legacy));
      const scoped = createLocalStorageRepository({
        storage, namespace: 'scratch', legacyKey: 'other:board', now: () => clock,
      });

      assert.equal(scoped.migrateLegacy(), true);
      assert.deepEqual(scoped.load(DEFAULT_BOARD_ID).board, legacy);
    });

    test('ignores a legacy key holding junk', () => {
      storage.data.set(LEGACY_KEY, '{not json');
      assert.equal(repo.migrateLegacy(), false);

      storage.data.set(LEGACY_KEY, JSON.stringify({ nope: true }));
      assert.equal(repo.migrateLegacy(), false);
    });

    test('reports failure when the copy cannot be written', () => {
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));
      storage.failOn = 'set';
      assert.equal(repo.migrateLegacy(), false);
    });

    test('keeps the migrated copy even if the old key cannot be cleared', () => {
      storage.data.set(LEGACY_KEY, JSON.stringify(legacy));
      storage.failOn = 'remove';

      assert.equal(repo.migrateLegacy(), true);
      assert.deepEqual(repo.load(DEFAULT_BOARD_ID).board, legacy);
    });
  });
});

describe('null repository', () => {
  test('accepts every call and keeps nothing', () => {
    const repo = createNullRepository();
    assert.deepEqual(repo.list(), []);
    assert.equal(repo.load('alpha'), null);
    assert.equal(repo.save('alpha', board()), false);
    assert.equal(repo.rename('alpha', 'x'), false);
    assert.equal(repo.remove('alpha'), false);
    assert.equal(repo.migrateLegacy(), false);
    assert.equal(repo.load('alpha'), null);
  });
});
