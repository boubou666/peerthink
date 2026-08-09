// The whole sheet in a small box.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { centredOn, covered, mapFit, toMap, toWorld } from '../../src/core/minimap.js';
import { createMinimapState } from '../../src/platform/minimap-state.js';

const VIEW = { x: 0, y: 0, w: 100, h: 100 };
const BOX = { w: 100, h: 100 };

describe('what the map covers', () => {
  test('the objects and the part being looked at, together', () => {
    assert.deepEqual(
      covered({ x: 0, y: 0, w: 50, h: 50 }, { x: 100, y: 100, w: 50, h: 50 }),
      { x: 0, y: 0, w: 150, h: 150 },
    );
  });

  /**
   * A map of the objects alone would push the view rectangle off its own edge
   * as soon as somebody panned away from their work, and a rectangle you cannot
   * see cannot say where you are.
   */
  test('so panning away from everything keeps you on the map', () => {
    const content = { x: 0, y: 0, w: 100, h: 100 };
    const away = { x: 900, y: 0, w: 100, h: 100 };
    const fit = mapFit(content, away, BOX);

    const rect = toMap(away, fit);
    assert.ok(rect.x >= 0 && rect.x + rect.w <= BOX.w, `the view is inside the box: ${JSON.stringify(rect)}`);
  });

  test('a sheet with nothing on it is just where you are', () => {
    assert.deepEqual(covered(null, VIEW), VIEW);
  });
});

describe('fitting it in the box', () => {
  test('one scale for both axes, and what is left over is shared', () => {
    const fit = mapFit({ x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 0, w: 200, h: 100 }, BOX);

    // 88 usable pixels across 200 world units is the tighter of the two axes.
    assert.equal(fit.scale, 0.44);
    assert.deepEqual(toMap({ x: 0, y: 0, w: 200, h: 100 }, fit), { x: 6, y: 28, w: 88, h: 44 });
  });

  test('the middle of the box is the middle of what it covers', () => {
    const content = { x: -300, y: 40, w: 120, h: 900 };
    const fit = mapFit(content, VIEW, BOX);
    const region = covered(content, VIEW);

    const middle = toWorld({ x: BOX.w / 2, y: BOX.h / 2 }, fit);
    assert.ok(Math.abs(middle.x - (region.x + region.w / 2)) < 1e-9, 'across');
    assert.ok(Math.abs(middle.y - (region.y + region.h / 2)) < 1e-9, 'down');
  });

  test('a point in the box and a rectangle on the sheet are the same transform', () => {
    const fit = mapFit({ x: 10, y: 20, w: 300, h: 200 }, VIEW, BOX);
    const rect = { x: 60, y: 90, w: 40, h: 30 };
    const at = toMap(rect, fit);
    const back = toWorld({ x: at.x, y: at.y }, fit);

    // Within a ten-thousandth of a world unit: the two are one multiply apart
    // and back, and floating point does not promise the exact bits.
    assert.ok(Math.abs(back.x - rect.x) < 1e-4, `across: ${back.x}`);
    assert.ok(Math.abs(back.y - rect.y) < 1e-4, `down: ${back.y}`);
  });

  test('nothing to cover, or nowhere to draw it, has no answer', () => {
    assert.equal(mapFit(null, null, BOX), null);
    assert.equal(mapFit(null, VIEW, { w: 0, h: 0 }), null, 'a box that has not been laid out');
    assert.equal(mapFit(null, VIEW, { w: 8, h: 8 }), null, 'a box smaller than its own padding');
    assert.equal(mapFit({ x: 0, y: 0, w: 0, h: 0 }, null, BOX), null, 'a region with no size');
  });
});

describe('going somewhere', () => {
  test('the point pressed becomes the middle of the screen', () => {
    assert.deepEqual(centredOn({ x: 500, y: 400 }, { x: 0, y: 0, w: 200, h: 100 }), { x: 400, y: 350 });
  });
});

describe('whether the map is showing', () => {
  const memory = () => {
    const held = new Map();
    return {
      getItem: (k) => (held.has(k) ? held.get(k) : null),
      setItem: (k, v) => held.set(k, String(v)),
    };
  };

  test('shows until somebody says otherwise, and remembers that they did', () => {
    const state = createMinimapState({ storage: memory() });
    assert.equal(state.open(), true);

    state.set(false);
    assert.equal(state.open(), false);

    state.set(true);
    assert.equal(state.open(), true);
  });

  test('two of them over one store agree, which is what a reload is', () => {
    const storage = memory();
    createMinimapState({ storage }).set(false);
    assert.equal(createMinimapState({ storage }).open(), false);
  });

  /** A privacy mode where storage throws, and one where there is none at all. */
  test('a store that cannot be reached costs the memory, not the map', () => {
    const throwing = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };

    assert.equal(createMinimapState({ storage: throwing }).open(), true);
    assert.doesNotThrow(() => createMinimapState({ storage: throwing }).set(false));

    assert.equal(createMinimapState().open(), true);
    assert.doesNotThrow(() => createMinimapState().set(false));
  });

  test('a record from somewhere else reads as showing', () => {
    const storage = memory();
    storage.setItem('peerthink:minimap', 'folded-away');
    assert.equal(createMinimapState({ storage }).open(), true);
  });
});
