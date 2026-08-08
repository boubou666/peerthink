// What copied objects look like on a clipboard.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIPBOARD_KIND,
  CLIPBOARD_VERSION,
  readClipboard,
  writeClipboard,
} from '../../src/core/clipboard.js';

const card = (props = {}) => ({ id: 'a1', type: 'card', x: 10, y: 20, w: 200, h: 120, text: 'hi', ...props });

describe('clipboard', () => {
  test('what is written comes back', () => {
    const objects = [card(), card({ id: 'a2', x: 300, fill: 'blue', corners: 'square' })];
    assert.deepEqual(readClipboard(writeClipboard(objects)), objects);
  });

  test('the payload is text, so it can travel as text/plain', () => {
    assert.equal(typeof writeClipboard([card()]), 'string');
    const payload = JSON.parse(writeClipboard([card()]));
    assert.equal(payload.kind, CLIPBOARD_KIND);
    assert.equal(payload.v, CLIPBOARD_VERSION);
  });

  /**
   * The objects go in whole. A copy that quietly dropped the fields this
   * version happens to care about is a clipboard that loses work the next
   * version adds.
   */
  test('fields nothing here knows about survive the round trip', () => {
    const [back] = readClipboard(writeClipboard([card({ somethingNew: { deep: [1, 2] } })]));
    assert.deepEqual(back.somethingNew, { deep: [1, 2] });
  });

  test('the written objects are copies, not the ones handed in', () => {
    const objects = [card()];
    const text = writeClipboard(objects);
    objects[0].text = 'changed after copying';
    assert.equal(readClipboard(text)[0].text, 'hi');
  });

  describe('what is not ours', () => {
    for (const [what, text] of [
      ['nothing at all', ''],
      ['a paragraph from a web page', 'Lorem ipsum dolor sit amet'],
      ['somebody else’s JSON', JSON.stringify({ objects: [card()] })],
      ['our marker in text that is not JSON', `${CLIPBOARD_KIND} — see the docs`],
      ['a payload with no objects', JSON.stringify({ kind: CLIPBOARD_KIND, v: 1 })],
      ['an empty payload', JSON.stringify({ kind: CLIPBOARD_KIND, v: 1, objects: [] })],
      ['a version this build does not know', JSON.stringify({ kind: CLIPBOARD_KIND, v: 99, objects: [card()] })],
    ]) {
      test(`${what} reads as nothing to paste`, () => {
        assert.equal(readClipboard(text), null);
      });
    }

    test('so does anything that is not a string', () => {
      for (const value of [null, undefined, 42, {}, ['x']]) assert.equal(readClipboard(value), null);
    });
  });

  /**
   * A clipboard is a flat list of independent things, unlike an op batch: four
   * of the five cards somebody copied beats none of them.
   */
  test('an entry that cannot be placed is dropped, and the rest arrive', () => {
    const text = JSON.stringify({
      kind: CLIPBOARD_KIND,
      v: CLIPBOARD_VERSION,
      objects: [
        card(),
        null,
        'not an object',
        { type: 'card', x: 0, y: 0, w: 10 },                       // no height
        { type: 'card', x: 0, y: 0, w: 0, h: 10 },                 // no width
        { type: 'card', x: 0, y: 0, w: '10', h: 10 },              // width as text
        { type: 'card', x: Infinity, y: 0, w: 10, h: 10 },         // nowhere
        { x: 0, y: 0, w: 10, h: 10 },                              // no type
      ],
    });
    assert.deepEqual(readClipboard(text), [card()]);
  });

  test('a payload of nothing placeable reads as nothing to paste', () => {
    const text = JSON.stringify({ kind: CLIPBOARD_KIND, v: CLIPBOARD_VERSION, objects: [null, 7] });
    assert.equal(readClipboard(text), null);
  });
});
