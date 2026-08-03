import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { seedBoard } from '../../public/js/core/seed.js';
import { Board } from '../../public/js/core/board.js';
import { Store } from '../../public/js/core/store.js';
import { Selection } from '../../public/js/core/selection.js';
import { createSequentialIds } from '../../public/js/core/ids.js';
import { rectContains } from '../../public/js/core/geometry.js';

describe('seedBoard', () => {
  let store;
  let board;

  beforeEach(() => {
    store = new Store();
    board = new Board({ store, selection: new Selection(), newId: createSequentialIds() });
    seedBoard(board);
  });

  test('shows off every object type', () => {
    assert.deepEqual([...new Set(store.all().map((o) => o.type))].sort(), ['card', 'envelope', 'list']);
  });

  test('is not undoable — there is nothing behind a fresh board', () => {
    assert.equal(store.past.length, 0);
  });

  test('puts cards inside the envelope, so the carry behaviour is discoverable', () => {
    const envelope = store.all().find((o) => o.type === 'envelope');
    const contained = store.all().filter((o) => o !== envelope && rectContains(envelope, o));
    assert.ok(contained.length >= 3, `expected cards inside the envelope, found ${contained.length}`);
  });

  test('the list arrives with rows', () => {
    assert.ok(store.all().find((o) => o.type === 'list').items.length >= 3);
  });

  test('every object has a distinct id and a real size', () => {
    const objects = store.all();
    assert.equal(new Set(objects.map((o) => o.id)).size, objects.length);
    assert.ok(objects.every((o) => o.w > 0 && o.h > 0));
  });
});
