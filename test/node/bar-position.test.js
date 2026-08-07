// Where the format bar sits. The clamping is the fiddly part.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { barPosition } from '../../src/core/bar-position.js';

/** A camera at 1:1 with no pan, so world and screen are the same numbers. */
const viewport = { toScreen: (x, y) => ({ x, y }) };
const stage = { width: 1000 };
const card = (x, y, w = 200, h = 120) => ({ x, y, w, h });

describe('the format bar position', () => {
  test('nothing selected is nowhere to put it', () => {
    assert.equal(barPosition([], viewport, stage, 300), null);
  });

  test('sits centred above the selection', () => {
    const at = barPosition([card(400, 300)], viewport, stage, 300);
    assert.equal(at.x, 500, 'not centred over the card');
    assert.ok(at.y < 300, 'not above it');
    assert.equal(at.below, false);
  });

  test('spans everything selected, not just the first', () => {
    const at = barPosition([card(400, 300), card(600, 900)], viewport, stage, 300);
    assert.equal(at.x, 600, 'centred over one card rather than the pair');
    assert.ok(at.y < 300, 'placed against the lower card');
  });

  /**
   * The bar is positioned by its centre, so clamping the centre alone leaves
   * half of it outside — which is most of the controls.
   */
  describe('keeping it on screen', () => {
    test('a selection at the left edge holds the whole bar in', () => {
      const at = barPosition([card(-500, 300)], viewport, stage, 300);
      assert.ok(at.x - 150 >= 0, `the bar starts at ${at.x - 150}`);
    });

    test('and one at the right edge does too', () => {
      const at = barPosition([card(1400, 300)], viewport, stage, 300);
      assert.ok(at.x + 150 <= stage.width, `the bar ends at ${at.x + 150} of ${stage.width}`);
    });

    /**
     * A bar wider than the stage cannot satisfy both margins. Clamping picks
     * the low bound and pins the left margin, pushing everything else off the
     * right; centring clips evenly at both ends instead.
     */
    test('a bar wider than the stage is centred rather than pinned left', () => {
      const narrow = { width: 320 };
      const at = barPosition([card(0, 300)], viewport, narrow, 600);

      assert.equal(at.x, 160, 'the bar was pinned to a margin it cannot honour');
    });

    test('an unmeasured bar still lands over the selection', () => {
      // Width is 0 on the first paint, before the layout effect has measured.
      const at = barPosition([card(400, 300)], viewport, stage, 0);
      assert.equal(at.x, 500);
    });
  });

  /**
   * Flipping the transform without moving `y` drew the bar downwards from
   * above the cards, covering the very things being formatted.
   */
  describe('when there is no room above', () => {
    test('it goes below the selection, not above it', () => {
      const at = barPosition([card(400, 2)], viewport, stage, 300);

      assert.equal(at.below, true);
      assert.ok(at.y > 2 + 120, `the bar at ${at.y} overlaps a card ending at ${2 + 120}`);
    });

    test('and stays above when there is room', () => {
      const at = barPosition([card(400, 300)], viewport, stage, 300);
      assert.equal(at.below, false);
      assert.ok(at.y < 300);
    });
  });
});
