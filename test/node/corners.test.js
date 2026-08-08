// Whether an object's corners are rounded.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CORNERED_TYPES, DEFAULT_CORNERS, cornersOf, hasCorners } from '../../src/core/corners.js';

describe('corners', () => {
  /** Every board that existed before this did has no `corners` on anything. */
  test('an object with nothing set is round, as it has always been drawn', () => {
    assert.equal(DEFAULT_CORNERS, 'round');
    assert.equal(cornersOf({ type: 'card' }), 'round');
    assert.equal(cornersOf(), 'round');
  });

  test('what is set is kept', () => {
    assert.equal(cornersOf({ corners: 'square' }), 'square');
    assert.equal(cornersOf({ corners: 'round' }), 'round');
  });

  /**
   * A board can arrive from a client that knows a token this one does not, and
   * an attribute no stylesheet matches is not a corner style — it is an object
   * drawn some other way entirely.
   */
  test('a token this build does not know falls back rather than reaching the DOM', () => {
    for (const value of ['pill', '', 8, null, {}]) {
      assert.equal(cornersOf({ corners: value }), DEFAULT_CORNERS);
    }
  });

  test('every type on the board has corners', () => {
    for (const type of ['card', 'envelope', 'list', 'image']) {
      assert.ok(hasCorners({ type }), type);
      assert.ok(CORNERED_TYPES.includes(type));
    }
  });

  test('nothing else does', () => {
    assert.equal(hasCorners({ type: 'sticker-from-a-newer-build' }), false);
    assert.equal(hasCorners({}), false);
    assert.equal(hasCorners(null), false);
  });
});
