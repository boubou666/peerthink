// Which keystrokes belong to a field rather than to the board.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isTyping } from '../../src/platform/typing.js';

/** Enough of an element for a predicate that only asks what it is. */
const el = (tagName, isContentEditable = false) => ({ tagName, isContentEditable });

describe('isTyping', () => {
  test('is true for the things a person types into', () => {
    assert.equal(isTyping(el('INPUT')), true, 'the board title, the hex field');
    assert.equal(isTyping(el('TEXTAREA')), true);
    // Not text, but it answers to letters, Backspace and the arrows — the
    // format bar's font and size.
    assert.equal(isTyping(el('SELECT')), true);
  });

  test('is true for an editable object on the board', () => {
    assert.equal(isTyping(el('DIV', true)), true);
  });

  test('is false for everything the shortcuts are meant to reach', () => {
    assert.equal(isTyping(el('DIV')), false);
    assert.equal(isTyping(el('BODY')), false);
    assert.equal(isTyping(el('BUTTON')), false, 'a toolbar button still undoes the board');
  });

  /**
   * A focusable div is not a field, which is why the colour picker's spectrum
   * square stops its own keys rather than relying on this.
   */
  test('a div is not a field for being focusable', () => {
    assert.equal(isTyping({ tagName: 'DIV', isContentEditable: false, tabIndex: 0 }), false);
  });

  test('no element is not typing', () => {
    // `document.activeElement` is null on a document that has none, and a key
    // event fired at nothing has a null target.
    assert.equal(isTyping(null), false);
    assert.equal(isTyping(undefined), false);
  });
});
