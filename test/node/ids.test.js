import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createIdGenerator, createSequentialIds } from '../../public/js/core/ids.js';

describe('createIdGenerator', () => {
  test('produces short, collision-free ids by default', () => {
    const newId = createIdGenerator();
    const ids = Array.from({ length: 5000 }, newId);
    assert.equal(ids[0].length, 8);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('takes its randomness from the injected source', () => {
    const newId = createIdGenerator(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(newId(), 'aaaaaaaa');
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
