// Hex in, a point in the colour cylinder out, and back again.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hexToHsv, hsvToHex, normaliseHex, rgbToHex } from '../../src/core/colour.js';

/** The card palette, which is what the picker is asked to show most often. */
const PALETTE = ['#ffe98a', '#b4d5ff', '#b8e6bd', '#ffc4d6', '#ffffff', '#1c1b19', '#78766f', '#b3261e'];

describe('normalising hex', () => {
  test('accepts what a person types', () => {
    assert.equal(normaliseHex('#B4D5FF'), '#b4d5ff');
    assert.equal(normaliseHex('b4d5ff'), '#b4d5ff', 'a colour pasted without its hash');
    assert.equal(normaliseHex('  #b4d5ff  '), '#b4d5ff');
  });

  test('expands the short form the way CSS does', () => {
    assert.equal(normaliseHex('#f0a'), '#ff00aa');
    assert.equal(normaliseHex('fff'), '#ffffff');
  });

  /**
   * A card may carry `#rrggbbaa` — the board format allows it, and a picker
   * with no alpha still has to show one as something.
   */
  test('drops alpha rather than refusing the colour', () => {
    assert.equal(normaliseHex('#b4d5ff80'), '#b4d5ff');
    assert.equal(normaliseHex('#f0a8'), '#ff00aa');
  });

  test('refuses what is not a colour', () => {
    // Half-typed, which is the state the hex field is in for most of its life.
    assert.equal(normaliseHex('#b4d'.slice(0, 2)), null);
    assert.equal(normaliseHex('#b4d5f'), null, 'five digits is no length of colour');
    assert.equal(normaliseHex('red'), null, 'a name is not this function\'s business');
    assert.equal(normaliseHex('#gggggg'), null);
    assert.equal(normaliseHex(''), null);
    assert.equal(normaliseHex(undefined), null);
    assert.equal(normaliseHex(null), null);
  });
});

describe('hex to HSV', () => {
  test('reads the primaries off the wheel', () => {
    assert.deepEqual(hexToHsv('#ff0000'), { h: 0, s: 1, v: 1 });
    assert.deepEqual(hexToHsv('#00ff00'), { h: 120, s: 1, v: 1 });
    assert.deepEqual(hexToHsv('#0000ff'), { h: 240, s: 1, v: 1 });
  });

  test('a hue below zero comes back round the wheel, not negative', () => {
    // Magenta is the case: red is the maximum and blue exceeds green, which is
    // the branch that produces a negative angle before it is wrapped.
    assert.deepEqual(hexToHsv('#ff00ff'), { h: 300, s: 1, v: 1 });
  });

  test('grey has no hue and black has no saturation', () => {
    assert.deepEqual(hexToHsv('#ffffff'), { h: 0, s: 0, v: 1 });
    assert.deepEqual(hexToHsv('#808080'), { h: 0, s: 0, v: 128 / 255 });
    assert.deepEqual(hexToHsv('#000000'), { h: 0, s: 0, v: 0 });
  });

  test('is null for what is not a colour', () => {
    assert.equal(hexToHsv('nonsense'), null);
  });
});

describe('HSV to hex', () => {
  test('draws the primaries back', () => {
    assert.equal(hsvToHex({ h: 0, s: 1, v: 1 }), '#ff0000');
    assert.equal(hsvToHex({ h: 120, s: 1, v: 1 }), '#00ff00');
    assert.equal(hsvToHex({ h: 240, s: 1, v: 1 }), '#0000ff');
  });

  /** An angle, so a slider nudged past the end means red rather than violet. */
  test('hue wraps', () => {
    assert.equal(hsvToHex({ h: 360, s: 1, v: 1 }), '#ff0000');
    assert.equal(hsvToHex({ h: -60, s: 1, v: 1 }), hsvToHex({ h: 300, s: 1, v: 1 }));
  });

  /** Saturation and value are edges, not angles: past them is the edge. */
  test('saturation and value clamp', () => {
    assert.equal(hsvToHex({ h: 200, s: 1.4, v: 2 }), hsvToHex({ h: 200, s: 1, v: 1 }));
    assert.equal(hsvToHex({ h: 200, s: -1, v: -1 }), '#000000');
  });

  test('no saturation is grey, whatever the hue says', () => {
    assert.equal(hsvToHex({ h: 12, s: 0, v: 1 }), '#ffffff');
    assert.equal(hsvToHex({ h: 300, s: 0, v: 0 }), '#000000');
  });
});

/**
 * The round trip is what the picker actually depends on. It reads the card's
 * colour into a point, moves the point, and writes it back — so a colour that
 * does not survive the journey would drift every time the panel is opened.
 */
test('every palette colour survives the round trip', () => {
  for (const hex of PALETTE) {
    assert.equal(hsvToHex(hexToHsv(hex)), hex, `${hex} did not come back`);
  }
});

test('and so does every colour on a coarse sweep of the cylinder', () => {
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 51) {
      for (let b = 0; b < 256; b += 51) {
        const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
        assert.equal(hsvToHex(hexToHsv(hex)), hex, `${hex} did not come back`);
      }
    }
  }
});

/**
 * What a browser answers when asked what a stylesheet's colour is. It never
 * answers in the hex that was written — always `rgb()` or `rgba()` — which is
 * why the palette has to be read back through this.
 */
describe('rgb to hex', () => {
  test('reads what computed style gives', () => {
    assert.equal(rgbToHex('rgb(180, 213, 255)'), '#b4d5ff');
    assert.equal(rgbToHex('rgb(0, 0, 0)'), '#000000');
    // Both spellings: the space-separated form is what newer engines return.
    assert.equal(rgbToHex('rgb(180 213 255)'), '#b4d5ff');
    assert.equal(rgbToHex('rgba(180, 213, 255, 0.5)'), '#b4d5ff', 'alpha is dropped, not refused');
    assert.equal(rgbToHex('rgb(180 213 255 / 0.5)'), '#b4d5ff', 'the slash form of alpha');
  });

  /**
   * A card with no fill computes to this, and it is not black. Reading it as
   * `#000000` would put a black swatch in the palette where "no fill" belongs.
   */
  test('fully transparent is not a colour', () => {
    assert.equal(rgbToHex('rgba(0, 0, 0, 0)'), null);
    assert.equal(rgbToHex('rgba(180, 213, 255, 0)'), null);
  });

  test('is null for anything else', () => {
    assert.equal(rgbToHex('color(srgb 1 0 0)'), null, 'a form this cannot read is not guessed at');
    assert.equal(rgbToHex('#b4d5ff'), null, 'hex is not this function\'s business');
    assert.equal(rgbToHex('transparent'), null);
    assert.equal(rgbToHex(''), null);
    assert.equal(rgbToHex(null), null);
  });

  test('the round trip a palette makes', () => {
    for (const hex of PALETTE) {
      const { 1: r, 2: g, 3: b } = hex.match(/#(..)(..)(..)/);
      const rgb = `rgb(${[r, g, b].map((pair) => parseInt(pair, 16)).join(', ')})`;
      assert.equal(rgbToHex(rgb), hex, `${rgb} did not come back as ${hex}`);
    }
  });
});
