// What an image source may be, and how large a picture lands.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { IMAGE_PIXELS_MAX, fitWithin, isImageSource } from '../../src/core/image.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUg';

describe('image source', () => {
  test('a base64 data URL of a raster type is a picture', () => {
    for (const type of ['png', 'jpeg', 'gif', 'webp', 'avif']) {
      assert.ok(isImageSource(`data:image/${type};base64,${PIXEL}`), type);
    }
  });

  /**
   * An object arrives over the board's channel from anyone authorised to edit
   * it, and `src` goes into an `img`. A remote URL in there is a request this
   * browser makes to a host of somebody else's choosing.
   */
  test('a link to somewhere else is not', () => {
    for (const src of [
      'https://example.test/tracker.gif',
      'http://example.test/pixel.png',
      '//example.test/pixel.png',
      '/local/pixel.png',
      'javascript:void 0',
    ]) {
      assert.equal(isImageSource(src), false, src);
    }
  });

  test('nor is a document dressed as a picture', () => {
    assert.equal(isImageSource('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), false);
    assert.equal(isImageSource('data:text/html;base64,PGI+aGk8L2I+'), false);
    assert.equal(isImageSource(`data:image/png,${PIXEL}`), false, 'not base64');
    assert.equal(isImageSource(`data:image/png;base64,${PIXEL}<script>`), false);
    assert.equal(isImageSource('data:,'), false, 'what a canvas answers when it cannot encode');
  });

  test('nor is anything that is not a string', () => {
    for (const value of [null, undefined, 12, {}, [`data:image/png;base64,${PIXEL}`]]) {
      assert.equal(isImageSource(value), false);
    }
  });
});

describe('fitWithin', () => {
  test('a picture larger than the box comes down, keeping its proportions', () => {
    assert.deepEqual(fitWithin({ w: 4000, h: 3000 }, 400), { w: 400, h: 300 });
    assert.deepEqual(fitWithin({ w: 3000, h: 4000 }, 400), { w: 300, h: 400 });
  });

  /** Blowing a favicon up to 480 across is a decision nobody asked for. */
  test('a picture smaller than the box is left alone', () => {
    assert.deepEqual(fitWithin({ w: 40, h: 30 }, 400), { w: 40, h: 30 });
    assert.deepEqual(fitWithin({ w: 400, h: 400 }, 400), { w: 400, h: 400 });
  });

  test('the sides are whole numbers, and never zero', () => {
    const { w, h } = fitWithin({ w: 1000, h: 3 }, 100);
    assert.equal(w, 100);
    assert.equal(h, 1, 'a side that rounds to nothing is still a side');
    assert.ok(Number.isInteger(fitWithin({ w: 999, h: 333 }, 100).h));
  });

  test('a size that is not one answers with nothing', () => {
    for (const size of [{ w: 0, h: 0 }, { w: -5, h: 5 }, { w: NaN, h: 10 }, { w: Infinity, h: 10 }, {}]) {
      assert.equal(fitWithin(size, 100), null);
    }
  });

  test('the stored ceiling is generous enough to zoom into', () => {
    assert.ok(IMAGE_PIXELS_MAX >= 1000);
  });
});
