// Where floating chrome sits. The clamping is the fiddly part.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { barPosition, popoverPosition } from '../../src/core/bar-position.js';

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

describe('the link popover position', () => {
  const screen = { width: 1000, height: 800 };
  const link = (x, y, w = 160, h = 18) => ({ x, y, w, h });
  const size = { width: 300, height: 200 };

  /** Under the word, where the pointer is not, which is what a tooltip does. */
  test('sits below the link, left-aligned with it', () => {
    const at = popoverPosition(link(200, 300), screen, size);
    assert.equal(at.x, 200, 'not aligned with the start of the link');
    assert.equal(at.below, true);
    assert.ok(at.y > 318, 'not below the link');
  });

  /**
   * Measured against the whole popover, not its top edge: the reason to flip is
   * that the bottom would be off screen.
   */
  test('flips above when the whole panel will not fit below', () => {
    const at = popoverPosition(link(200, 700), screen, size);
    assert.equal(at.below, false);
    assert.ok(at.y < 700, 'not above the link');
  });

  test('a short panel still fits where a tall one does not', () => {
    assert.equal(popoverPosition(link(200, 700), screen, { width: 300, height: 40 }).below, true);
    assert.equal(popoverPosition(link(200, 700), screen, { width: 300, height: 400 }).below, false);
  });

  describe('keeping it on screen', () => {
    test('a link near the right edge pulls the panel back', () => {
      const at = popoverPosition(link(900, 300), screen, size);
      assert.equal(at.x + size.width, screen.width - 8, 'the right edge is off screen');
    });

    test('a link off the left edge pushes it in', () => {
      const at = popoverPosition(link(-40, 300), screen, size);
      assert.equal(at.x, 8);
    });

    /** The same answer barPosition gives: clip evenly rather than pin one edge. */
    test('a panel wider than the stage is centred instead', () => {
      const at = popoverPosition(link(400, 300), screen, { width: 1200, height: 100 });
      assert.equal(at.x, -100);
    });
  });

  test('the first paint has no size to allow for, and simply does less', () => {
    const at = popoverPosition(link(900, 300), screen);
    assert.equal(at.x, 900);
    assert.equal(at.below, true);
  });
});
