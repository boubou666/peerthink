// Formatting the selected cards.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('format bar', () => {
  let page;

  before(async () => { page = await openApp(); });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  beforeEach(async () => {
    await page.eval('localStorage.clear()');
    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
    await page.eval('app.store.load({ v: 1, order: [], objects: [] })');
  });

  const addCard = (props = {}) =>
    page.eval(`app.board.add('card', ${JSON.stringify({ x: 200, y: 200, ...props })}).id`);

  const select = (...ids) => page.eval(`app.selection.set(${JSON.stringify(ids)})`);

  /** The bar renders on a React commit, which follows the selection change. */
  const bar = async () => {
    await page.waitFor('true', { timeout: 1 }).catch(() => {});
    return page.eval(`document.querySelector('[data-format-bar]') !== null`);
  };

  const click = async (selector) => {
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, {
      label: `the control ${selector}`,
    });
    await page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };

  const styleOf = (id) => page.eval(`(() => {
    const el = document.querySelector('[data-id="${id}"]');
    return { ...el.dataset };
  })()`);

  test('appears for a selected card and goes when nothing is selected', async () => {
    // `board.add` selects what it made, so a fresh card already has the bar.
    // Clearing first is what makes the appearance below mean something.
    const id = await addCard();
    await page.eval('app.selection.clear()');
    await page.waitFor(`document.querySelector('[data-format-bar]') === null`, { label: 'no bar yet' });

    await select(id);
    await page.waitFor(`document.querySelector('[data-format-bar]') !== null`, { label: 'the bar' });

    await page.eval('app.selection.clear()');
    await page.waitFor(`document.querySelector('[data-format-bar]') === null`, { label: 'the bar to go' });
  });

  test('is not offered for things that are not cards', async () => {
    const envelope = await page.eval(`app.board.add('envelope', { x: 0, y: 0 }).id`);
    await select(envelope);
    assert.equal(await bar(), false, 'an envelope was offered card formatting');
  });

  test('each control writes its field, and the card shows it', async () => {
    const id = await addCard();
    await select(id);

    await click('[data-format-bar] .fmt-fill[data-value="blue"]');
    await click('[data-format-bar] .fmt-ink[data-value="red"]');
    await click('[data-format-bar] .fmt-align[data-value="center"]');
    await page.eval(`(() => {
      const el = document.querySelector('[data-format-bar] [data-field="size"]');
      el.value = 'xl';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    const style = await styleOf(id);
    assert.equal(style.fill, 'blue');
    assert.equal(style.ink, 'red');
    assert.equal(style.align, 'center');
    assert.equal(style.size, 'xl');

    // What the DOM does with it, not just what was written down.
    const painted = await page.eval(`(() => {
      const el = document.querySelector('[data-id="${id}"]');
      const text = getComputedStyle(el.querySelector('.card-text'));
      return { bg: getComputedStyle(el).backgroundColor, color: text.color, align: text.textAlign, size: text.fontSize };
    })()`);
    assert.equal(painted.bg, 'rgb(180, 213, 255)');
    assert.equal(painted.color, 'rgb(179, 38, 30)');
    assert.equal(painted.align, 'center');
    assert.equal(painted.size, '24px');
  });

  test('a transparent fill leaves the card unpainted', async () => {
    const id = await addCard({ text: 'floating' });
    await select(id);

    await click('[data-format-bar] .fmt-fill[data-value="none"]');

    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor`),
      'rgba(0, 0, 0, 0)',
    );
  });

  test('one change covers every selected card, and undoes as one', async () => {
    const first = await addCard();
    const second = await addCard({ x: 500 });
    await select(first, second);

    await click('[data-format-bar] .fmt-fill[data-value="green"]');
    assert.equal((await styleOf(first)).fill, 'green');
    assert.equal((await styleOf(second)).fill, 'green');

    // One op batch, so one undo — not one per card.
    await page.eval('app.store.undo()');
    assert.notEqual((await styleOf(first)).fill, 'green');
    assert.notEqual((await styleOf(second)).fill, 'green');
  });

  /**
   * Showing the first card's value would claim the others match it, and
   * pre-selecting a swatch true of only one is how somebody changes a card
   * they meant to leave alone.
   */
  test('a disagreeing selection shows no current value', async () => {
    const yellow = await addCard({ fill: 'yellow' });
    const pink = await addCard({ x: 500, fill: 'pink' });

    await select(yellow);
    await page.waitFor(`document.querySelector('[data-format-bar] .fmt-fill[data-current]') !== null`, {
      label: 'the current swatch',
    });

    await select(yellow, pink);
    await page.waitFor(`document.querySelector('[data-format-bar] .fmt-fill[data-current]') === null`, {
      label: 'the current swatch to be dropped',
    });
  });

  test('the bar follows the card when the camera moves', async () => {
    const id = await addCard();
    await select(id);
    await page.waitFor(`document.querySelector('[data-format-bar]') !== null`, { label: 'the bar' });

    const left = () => page.eval(`document.querySelector('[data-format-bar]').getBoundingClientRect().left`);
    const before = await left();

    await page.eval('app.viewport.panBy(-160, 0)');
    await page.waitFor(`document.querySelector('[data-format-bar]').getBoundingClientRect().left !== ${before}`, {
      label: 'the bar to follow the pan',
    });

    assert.ok(Math.abs((await left()) - (before - 160)) < 2, 'the bar did not move with the board');
  });
});
