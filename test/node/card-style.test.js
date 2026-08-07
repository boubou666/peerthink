// How a card looks, as tokens.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_STYLE_DEFAULTS,
  cardStyle,
  isCardStyleValue,
  isCustomColour,
  namedColour,
} from '../../src/core/card-style.js';

describe('card style', () => {
  test('a card with nothing set gets the defaults', () => {
    assert.deepEqual(cardStyle({}), CARD_STYLE_DEFAULTS);
    assert.deepEqual(cardStyle(), CARD_STYLE_DEFAULTS);
  });

  test('what is set is kept', () => {
    assert.deepEqual(cardStyle({ fill: 'none', ink: 'white', font: 'mono', size: 'xl', align: 'center' }), {
      fill: 'none',
      ink: 'white',
      font: 'mono',
      size: 'xl',
      align: 'center',
    });
  });

  test('a field left out keeps its default while the others change', () => {
    assert.equal(cardStyle({ align: 'right' }).fill, 'yellow');
    assert.equal(cardStyle({ align: 'right' }).align, 'right');
  });

  /**
   * Boards written before the field was renamed are still out there, and a
   * card is not worth losing over a word.
   */
  test('`color` is still read as the fill', () => {
    assert.equal(cardStyle({ color: 'blue' }).fill, 'blue');
  });

  test('and `fill` wins when a card carries both', () => {
    assert.equal(cardStyle({ color: 'blue', fill: 'pink' }).fill, 'pink');
  });

  /**
   * A board can arrive from a client running a version that knows a token this
   * one does not. An attribute no stylesheet matches renders a card with no
   * background at all — falling back shows the wrong colour, passing it
   * through shows no card.
   */
  test('a token this version does not know falls back rather than reaching the DOM', () => {
    assert.equal(cardStyle({ fill: 'chartreuse' }).fill, 'yellow');
    assert.equal(cardStyle({ align: 'justify' }).align, 'left');
    assert.equal(cardStyle({ size: 42 }).size, 'md');
    assert.equal(cardStyle({ font: null }).font, 'sans');
  });

  describe('a colour the card carries itself', () => {
    test('hex is kept, for both colour fields', () => {
      assert.equal(cardStyle({ fill: '#b4d5ff' }).fill, '#b4d5ff');
      assert.equal(cardStyle({ ink: '#B3261E' }).ink, '#B3261E');
      assert.equal(cardStyle({ fill: '#abc' }).fill, '#abc', 'short hex is hex');
      assert.equal(cardStyle({ fill: '#b4d5ffcc' }).fill, '#b4d5ffcc', 'hex with alpha is hex');
    });

    test('a name is still a name', () => {
      assert.equal(namedColour('blue'), true);
      assert.equal(namedColour('none'), true, 'transparent is named, not custom');
      assert.equal(namedColour('#b4d5ff'), false);
    });

    /**
     * This value ends up in a CSS custom property, and it does not come only
     * from the person at the keyboard — a card arrives over the board's
     * channel from anyone authorised to edit it. Anything that is not plainly
     * a colour falls back rather than reaching the document.
     */
    test('anything that is not plainly a colour is refused', () => {
      for (const nasty of [
        'url(https://example.test/x.png)',
        'image-set("x.png" 1x)',
        'red; background: url(x)',
        'var(--anything)',
        '#12345',
        'rgb(1,2,3)',
        '#nothex',
        'blue url(x)',
      ]) {
        assert.equal(isCustomColour(nasty), false, `${nasty} was treated as a colour`);
        assert.equal(cardStyle({ fill: nasty }).fill, 'yellow', `${nasty} reached the card`);
      }
    });

    test('a colour field takes hex; the others still do not', () => {
      assert.equal(isCardStyleValue('fill', '#b4d5ff'), true);
      assert.equal(isCardStyleValue('ink', '#b4d5ff'), true);
      assert.equal(isCardStyleValue('align', '#b4d5ff'), false, 'an alignment is not a colour');
      assert.equal(isCardStyleValue('size', '#b4d5ff'), false);
    });
  });

  test('the vocabulary is what the pickers offer', () => {
    assert.equal(isCardStyleValue('fill', 'none'), true, 'transparent is a fill');
    assert.equal(isCardStyleValue('fill', 'nope'), false);
    assert.equal(isCardStyleValue('nonsense', 'left'), false, 'an unknown field admits nothing');
  });
});
