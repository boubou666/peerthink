import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bbox, clamp, rectContains, rectFromPoints, rectsIntersect } from '../../public/js/core/geometry.js';

const R = (x, y, w, h) => ({ x, y, w, h });

describe('clamp', () => {
  test('passes values inside the range through', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  test('clamps to both bounds', () => {
    assert.equal(clamp(-3, 0, 10), 0);
    assert.equal(clamp(42, 0, 10), 10);
  });
});

describe('rectsIntersect', () => {
  test('detects overlap', () => {
    assert.ok(rectsIntersect(R(0, 0, 10, 10), R(5, 5, 10, 10)));
  });

  test('rejects separation on either axis', () => {
    assert.ok(!rectsIntersect(R(0, 0, 10, 10), R(20, 0, 5, 5)));
    assert.ok(!rectsIntersect(R(0, 0, 10, 10), R(0, 20, 5, 5)));
    assert.ok(!rectsIntersect(R(20, 0, 5, 5), R(0, 0, 10, 10)));
    assert.ok(!rectsIntersect(R(0, 20, 5, 5), R(0, 0, 10, 10)));
  });

  test('touching edges do not count as overlap', () => {
    assert.ok(!rectsIntersect(R(0, 0, 10, 10), R(10, 0, 10, 10)));
  });
});

describe('rectContains', () => {
  test('accepts a fully enclosed rect, including flush edges', () => {
    assert.ok(rectContains(R(0, 0, 100, 100), R(10, 10, 20, 20)));
    assert.ok(rectContains(R(0, 0, 100, 100), R(0, 0, 100, 100)));
  });

  test('rejects a rect crossing any edge', () => {
    assert.ok(!rectContains(R(0, 0, 100, 100), R(-1, 10, 20, 20)));
    assert.ok(!rectContains(R(0, 0, 100, 100), R(10, -1, 20, 20)));
    assert.ok(!rectContains(R(0, 0, 100, 100), R(90, 10, 20, 20)));
    assert.ok(!rectContains(R(0, 0, 100, 100), R(10, 90, 20, 20)));
  });
});

describe('bbox', () => {
  test('returns null for an empty list', () => {
    assert.equal(bbox([]), null);
  });

  test('spans every rect', () => {
    assert.deepEqual(bbox([R(10, 10, 10, 10), R(-5, 40, 20, 5)]), R(-5, 10, 25, 35));
  });

  test('a single rect is its own bounding box', () => {
    assert.deepEqual(bbox([R(3, 4, 5, 6)]), R(3, 4, 5, 6));
  });
});

describe('rectFromPoints', () => {
  test('normalises corners dragged in any direction', () => {
    const expected = R(10, 20, 30, 40);
    assert.deepEqual(rectFromPoints({ x: 10, y: 20 }, { x: 40, y: 60 }), expected);
    assert.deepEqual(rectFromPoints({ x: 40, y: 60 }, { x: 10, y: 20 }), expected);
    assert.deepEqual(rectFromPoints({ x: 40, y: 20 }, { x: 10, y: 60 }), expected);
  });

  test('collapses to zero area for a single point', () => {
    assert.deepEqual(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 }), R(5, 5, 0, 0));
  });
});
