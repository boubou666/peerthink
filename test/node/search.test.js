// Finding words on a board.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTOR } from '../../src/core/connectors.js';
import { search, step, textOf } from '../../src/core/search.js';

const card = (id, text, at = {}) => ({ id, type: 'card', x: 0, y: 0, w: 100, h: 100, text, ...at });
const sheet = (id, objects, name = id) => ({ id, name, objects });

describe('the text an object holds', () => {
  test('is whatever a person typed into it, whatever kind it is', () => {
    assert.equal(textOf(card('a', 'hello')), 'hello');
    assert.equal(textOf({ type: 'envelope', title: 'Q3' }), 'Q3');
    assert.equal(
      textOf({ type: 'list', title: 'Jobs', items: [{ text: 'one' }, { text: 'two' }] }),
      'Jobs\none\ntwo',
    );
    assert.equal(textOf({ type: CONNECTOR, text: 'blocks' }), 'blocks');
  });

  test('and nothing at all for a picture, which holds none', () => {
    assert.equal(textOf({ type: 'image', src: 'data:image/png;base64,x' }), '');
    assert.equal(textOf(null), '');
  });
});

describe('searching', () => {
  test('matches part of a word, in any case', () => {
    const sheets = [sheet('s1', [card('a', 'The Roadmap'), card('b', 'nothing here')])];

    assert.deepEqual(search(sheets, 'roadmap').map((hit) => hit.id), ['a']);
    assert.deepEqual(search(sheets, 'ROAD').map((hit) => hit.id), ['a']);
    assert.deepEqual(search(sheets, 'here').map((hit) => hit.id), ['b']);
  });

  /**
   * Every object at once is not an answer to "where is it", and a bar that
   * selected the whole board the moment it opened is one nobody opens twice.
   */
  test('nothing matches nothing', () => {
    const sheets = [sheet('s1', [card('a', 'anything')])];

    assert.deepEqual(search(sheets, ''), []);
    assert.deepEqual(search(sheets, '   '), []);
    assert.deepEqual(search(sheets, null), []);
    assert.deepEqual(search(null, 'a'), []);
  });

  /**
   * The characters the document holds, so a labelled link is found both by
   * what it says and by where it goes.
   */
  test('the stored text is what is searched', () => {
    const sheets = [sheet('s1', [card('a', 'read the [roadmap](https://plan.test/q) today')])];

    assert.deepEqual(search(sheets, 'roadmap').map((hit) => hit.id), ['a'], 'by its words');
    assert.deepEqual(search(sheets, 'plan.test').map((hit) => hit.id), ['a'], 'and by its address');
  });

  test('matches come back down the page, then across it', () => {
    const sheets = [sheet('s1', [
      card('bottom', 'x', { y: 500 }),
      card('right', 'x', { y: 0, x: 300 }),
      card('left', 'x', { y: 0, x: 0 }),
    ])];

    assert.deepEqual(search(sheets, 'x').map((hit) => hit.id), ['left', 'right', 'bottom']);
  });

  test('and sheet by sheet, in tab order', () => {
    const sheets = [
      sheet('s1', [card('a', 'here')], 'First'),
      sheet('s2', [card('b', 'here')], 'Second'),
    ];

    assert.deepEqual(
      search(sheets, 'here').map((hit) => [hit.sheetId, hit.sheetName, hit.id]),
      [['s1', 'First', 'a'], ['s2', 'Second', 'b']],
    );
  });

  describe('a connector, which has no box', () => {
    const ends = [
      card('a', '', { x: 0, y: 0 }),
      card('b', '', { x: 400, y: 200 }),
    ];
    const arrow = { id: 'c', type: CONNECTOR, from: 'a', to: 'b', text: 'blocks' };

    test('is ordered by where it is drawn, between the two it joins', () => {
      const sheets = [sheet('s1', [...ends, arrow, card('below', 'blocks', { y: 900 })])];

      assert.deepEqual(search(sheets, 'blocks').map((hit) => hit.id), ['c', 'below']);
      // Halfway between the two middles: (50,50) and (450,250).
      assert.deepEqual(search(sheets, 'blocks')[0].at, { x: 250, y: 150 });
    });

    test('and is dropped when its ends are not both here to place it', () => {
      const sheets = [sheet('s1', [ends[0], arrow])];
      assert.deepEqual(search(sheets, 'blocks'), []);
    });
  });
});

describe('stepping through them', () => {
  test('wraps at both ends', () => {
    assert.equal(step(0, 3, 1), 1);
    assert.equal(step(2, 3, 1), 0, 'past the last is the first');
    assert.equal(step(0, 3, -1), 2, 'and before the first is the last');
  });

  /**
   * −1 is "a query, but nowhere yet". Pressing Enter once has to mean the
   * first match rather than the second.
   */
  test('from nowhere, forwards is the first and backwards is the last', () => {
    assert.equal(step(-1, 3, 1), 0);
    assert.equal(step(-1, 3, -1), 2);
  });

  test('and answers nowhere when there is nothing to step through', () => {
    assert.equal(step(0, 0, 1), -1);
  });
});
