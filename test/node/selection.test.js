import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Selection } from '../../src/core/selection.js';

describe('Selection', () => {
  let selection;
  beforeEach(() => {
    selection = new Selection();
  });

  test('set replaces the selection and reports size', () => {
    selection.set(['a', 'b']);
    assert.equal(selection.size, 2);
    assert.deepEqual(selection.list().sort(), ['a', 'b']);
    assert.ok(selection.has('a'));
  });

  test('set to an equivalent selection does not notify', () => {
    let calls = 0;
    selection.set(['a', 'b']);
    const off = selection.on(() => calls++);

    selection.set(['b', 'a']);
    assert.equal(calls, 0, 'same members, different order');

    selection.set(['a']);
    assert.equal(calls, 1);

    off();
    selection.set(['z']);
    assert.equal(calls, 1, 'unsubscribed');
  });

  test('set of the same size but different members does notify', () => {
    let calls = 0;
    selection.set(['a']);
    selection.on(() => calls++);
    selection.set(['b']);
    assert.equal(calls, 1);
  });

  test('toggle adds then removes', () => {
    selection.toggle('a');
    assert.ok(selection.has('a'));
    selection.toggle('a');
    assert.ok(!selection.has('a'));
  });

  test('clear empties it, and is a no-op when already empty', () => {
    let calls = 0;
    selection.on(() => calls++);
    selection.clear();
    assert.equal(calls, 0);

    selection.set(['a']);
    selection.clear();
    assert.equal(selection.size, 0);
    assert.equal(calls, 2);
  });
});
