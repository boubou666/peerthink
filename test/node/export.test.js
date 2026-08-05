import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_EDGE, PADDING, SCALE, exportFrame, fileName } from '../../src/core/export.js';

/**
 * What an export covers, decided without a canvas.
 *
 * The drawing needs a browser and is tested in one; this is the half that says
 * which part of an infinite board the picture is of and how many pixels that
 * comes to, which is the same answer whether anything renders it or not.
 */

const at = (x, y, w = 100, h = 60) => ({ x, y, w, h });

describe('export frame', () => {
  test('covers the content with a margin around it', () => {
    const frame = exportFrame([at(0, 0), at(200, 100)]);

    assert.deepEqual(frame.rect, {
      x: -PADDING,
      y: -PADDING,
      w: 300 + PADDING * 2,
      h: 160 + PADDING * 2,
    });
  });

  test('a board with nothing on it has no frame', () => {
    assert.equal(exportFrame([]), null);
    assert.equal(exportFrame(), null);
  });

  test('pixels are world units at the device scale', () => {
    const frame = exportFrame([at(0, 0, 100, 50)], { padding: 0 });

    assert.equal(frame.scale, SCALE);
    assert.equal(frame.width, 100 * SCALE);
    assert.equal(frame.height, 50 * SCALE);
  });

  test('negative coordinates are covered like any other', () => {
    const frame = exportFrame([at(-500, -300, 100, 100)], { padding: 0 });

    assert.deepEqual(frame.rect, { x: -500, y: -300, w: 100, h: 100 });
  });

  /**
   * The board is infinite and a canvas is not. Past the cap a browser hands
   * back a blank or a null blob, so the export has to give up resolution
   * rather than give up objects — a picture missing the right-hand half of the
   * board would be worse than a soft one.
   */
  describe('a board too big for a canvas', () => {
    test('shrinks rather than cropping', () => {
      const huge = at(0, 0, MAX_EDGE, 200);
      const frame = exportFrame([huge], { padding: 0 });

      assert.ok(frame.scale < SCALE, 'kept the full scale on a canvas that cannot hold it');
      assert.equal(frame.width, MAX_EDGE);
      assert.deepEqual(frame.rect.w, MAX_EDGE, 'the rect still covers every object');
    });

    test('the tighter of the two sides decides', () => {
      // tall and narrow: the height is what runs out of room first
      const frame = exportFrame([at(0, 0, 10, MAX_EDGE)], { padding: 0 });

      assert.equal(frame.height, MAX_EDGE);
      assert.ok(frame.width < MAX_EDGE);
    });

    test('a board within the cap is left at full scale', () => {
      const frame = exportFrame([at(0, 0, 400, 300)], { padding: 0 });
      assert.equal(frame.scale, SCALE);
    });
  });

  test('a zero-sized object still makes an image', () => {
    const frame = exportFrame([at(0, 0, 0, 0)], { padding: 0 });

    assert.equal(frame.width, 1);
    assert.equal(frame.height, 1);
  });
});

describe('file name', () => {
  test('is the board title', () => {
    assert.equal(fileName('Sprint retro'), 'Sprint retro.png');
  });

  test('keeps accents and other scripts', () => {
    assert.equal(fileName('Rétrospective'), 'Rétrospective.png');
    assert.equal(fileName('計画'), '計画.png');
  });

  test('drops what a file system will not take', () => {
    // and closes the gaps the dropped characters leave behind, so a title
    // does not arrive with the shape of its own punctuation still in it
    assert.equal(fileName('Q3: plans / ideas?'), 'Q3 plans ideas.png');
    assert.equal(fileName('a\\b:c*d?e"f<g>h|i'), 'abcdefghi.png');
  });

  test('falls back for a board with no usable name', () => {
    assert.equal(fileName(null), 'board.png');
    assert.equal(fileName(''), 'board.png');
    assert.equal(fileName('   '), 'board.png');
    assert.equal(fileName('///'), 'board.png');
  });

  /** A trailing dot is refused on Windows and would eat the separator. */
  test('does not end the name in a dot', () => {
    assert.equal(fileName('Version 2.'), 'Version 2.png');
    assert.equal(fileName('...'), 'board.png');
  });

  test('is not unboundedly long', () => {
    const name = fileName('x'.repeat(500));
    assert.equal(name.length, 84, 'a 500-character title made a 500-character file name');
  });

  test('takes the extension it is given', () => {
    assert.equal(fileName('Board', 'json'), 'Board.json');
  });
});
