import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ID_LENGTH, createIdGenerator, createSequentialIds } from '../../src/core/ids.js';

describe('createIdGenerator', () => {
  test('produces short lowercase hex ids', () => {
    const id = createIdGenerator()();
    assert.equal(id.length, ID_LENGTH);
    assert.match(id, /^[0-9a-f]+$/);
  });

  test('keeps enough width that independent clients do not collide', () => {
    // 48 bits: the expected number of collisions here is ~1e-8, so a failure
    // means the id width shrank, not that the run was unlucky.
    const newId = createIdGenerator();
    const ids = Array.from({ length: 50_000 }, newId);
    assert.ok(ID_LENGTH >= 12, 'ids narrower than 48 bits collide in practice');
    assert.equal(new Set(ids).size, ids.length);
  });

  test('takes its randomness from the injected source', () => {
    const newId = createIdGenerator(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(newId(), 'aaaaaaaabbbb');
  });
});

describe('createSequentialIds', () => {
  test('counts up from a prefix', () => {
    const newId = createSequentialIds('obj');
    assert.deepEqual([newId(), newId(), newId()], ['obj1', 'obj2', 'obj3']);
  });

  test('defaults to a p prefix', () => {
    assert.equal(createSequentialIds()(), 'p1');
  });
});
