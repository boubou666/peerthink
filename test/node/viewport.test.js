import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SCALE, MIN_SCALE, Viewport } from '../../src/core/viewport.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

describe('Viewport', () => {
  let vp;
  beforeEach(() => {
    vp = new Viewport();
  });

  test('starts at the origin, unscaled', () => {
    assert.deepEqual({ x: vp.x, y: vp.y, scale: vp.scale }, { x: 0, y: 0, scale: 1 });
  });

  test('toWorld and toScreen are inverses', () => {
    vp.x = 120;
    vp.y = -40;
    vp.scale = 1.75;
    const world = vp.toWorld(300, 210);
    const screen = vp.toScreen(world.x, world.y);
    close(screen.x, 300);
    close(screen.y, 210);
  });

  test('moveTo sets the origin and notifies', () => {
    let calls = 0;
    vp.on(() => calls++);
    vp.moveTo(5, 6);
    assert.deepEqual({ x: vp.x, y: vp.y }, { x: 5, y: 6 });
    assert.equal(calls, 1);
  });

  test('panBy moves the camera opposite the drag, in world units', () => {
    vp.scale = 2;
    vp.panBy(100, -50);
    assert.deepEqual({ x: vp.x, y: vp.y }, { x: -50, y: 25 });
  });

  test('honours unsubscribe', () => {
    let calls = 0;
    const off = vp.on(() => calls++);
    vp.panBy(1, 1);
    off();
    vp.panBy(1, 1);
    assert.equal(calls, 1);
  });

  describe('zoomAt', () => {
    test('keeps the world point under the cursor pinned', () => {
      vp.x = 33;
      vp.y = 77;
      const before = vp.toWorld(400, 250);
      vp.zoomAt(400, 250, 2.5);
      const after = vp.toWorld(400, 250);
      close(after.x, before.x);
      close(after.y, before.y);
      assert.equal(vp.scale, 2.5);
    });

    test('clamps to the scale limits', () => {
      vp.zoomAt(0, 0, 1000);
      assert.equal(vp.scale, MAX_SCALE);
      vp.zoomAt(0, 0, 0.0001);
      assert.equal(vp.scale, MIN_SCALE);
    });

    test('is a no-op once pinned at a limit', () => {
      vp.zoomAt(0, 0, 1000);
      let calls = 0;
      vp.on(() => calls++);
      vp.zoomAt(10, 10, 2);
      assert.equal(calls, 0);
    });

    test('respects custom limits', () => {
      const tight = new Viewport({ minScale: 0.5, maxScale: 2 });
      tight.zoomAt(0, 0, 100);
      assert.equal(tight.scale, 2);
      tight.zoomAt(0, 0, 0.001);
      assert.equal(tight.scale, 0.5);
    });
  });

  test('setScaleAt lands on the requested scale', () => {
    vp.setScaleAt(200, 100, 3);
    assert.equal(vp.scale, 3);
  });

  test('visibleRect covers the stage in world units', () => {
    vp.x = 10;
    vp.y = 20;
    vp.scale = 2;
    assert.deepEqual(vp.visibleRect(800, 600), { x: 10, y: 20, w: 400, h: 300 });
    assert.deepEqual(vp.center(800, 600), { x: 210, y: 170 });
  });

  describe('fit', () => {
    test('centres the rect in the stage', () => {
      assert.equal(vp.fit({ x: 0, y: 0, w: 400, h: 200 }, 1000, 600, { padding: 50 }), true);
      const centre = vp.toScreen(200, 100);
      close(centre.x, 500);
      close(centre.y, 300);
    });

    test('never zooms past 1.5× for small content', () => {
      vp.fit({ x: 0, y: 0, w: 10, h: 10 }, 1000, 600);
      assert.equal(vp.scale, 1.5);
    });

    test('takes a custom maximum', () => {
      vp.fit({ x: 0, y: 0, w: 10, h: 10 }, 1000, 600, { maxScale: 3 });
      assert.equal(vp.scale, 3);
    });

    test('shrinks to fit large content', () => {
      vp.fit({ x: 0, y: 0, w: 4000, h: 100 }, 1000, 600, { padding: 50 });
      assert.ok(vp.scale < 1);
    });

    test('ignores a missing or degenerate rect', () => {
      let calls = 0;
      vp.on(() => calls++);
      assert.equal(vp.fit(null, 800, 600), false);
      assert.equal(vp.fit({ x: 0, y: 0, w: 0, h: 10 }, 800, 600), false);
      assert.equal(vp.fit({ x: 0, y: 0, w: 10, h: -1 }, 800, 600), false);
      assert.equal(calls, 0);
      assert.equal(vp.scale, 1);
    });
  });
});
