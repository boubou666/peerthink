// How a card looks, as tokens.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CARD_STYLE_DEFAULTS, cardStyle, isCardStyleValue } from '../../src/core/card-style.js';

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

  test('the vocabulary is what the pickers offer', () => {
    assert.equal(isCardStyleValue('fill', 'none'), true, 'transparent is a fill');
    assert.equal(isCardStyleValue('fill', 'nope'), false);
    assert.equal(isCardStyleValue('nonsense', 'left'), false, 'an unknown field admits nothing');
  });
});
