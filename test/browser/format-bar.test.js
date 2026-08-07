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

  /**
   * Whether the bar is absent, after giving React a commit to render it in.
   *
   * Asserting absence needs a settled page, and there is no positive condition
   * to wait for — so this waits for something that *would* have happened by
   * then: the selection reaching the renderer, which runs on the same frames.
   */
  const noBar = async () => {
    await page.waitFor('Boolean(window.app?.store)', { label: 'the app' });
    await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    return page.eval(`document.querySelector('[data-format-bar]') === null`);
  };

  const click = async (selector) => {
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, {
      label: `the control ${selector}`,
    });
    await page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };

  /**
   * A click writes an op; the renderer applies it on a frame. Reading the DOM
   * straight afterwards is a race that passes on a fast machine — the shape of
   * flake this suite has produced before.
   */
  const settled = (id, field, value) =>
    page.waitFor(`document.querySelector('[data-id="${id}"]').dataset.${field} === ${JSON.stringify(value)}`, {
      label: `${field} to become ${value} on screen`,
    });

  /**
   * Drive a native colour input. It answers to `input`, not `change` — which
   * is what makes the cards follow the cursor through the spectrum.
   */
  const pick = async (field, hex) => {
    await page.waitFor(`document.querySelector('[data-format-bar] [data-field="${field}"]') !== null`, {
      label: `the ${field} picker`,
    });
    await page.eval(`(() => {
      const el = document.querySelector('[data-format-bar] [data-field="${field}"]');
      el.value = ${JSON.stringify(hex)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
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
    assert.equal(await noBar(), true, 'an envelope was offered card formatting');
  });

  test('each control writes its field, and the card shows it', async () => {
    const id = await addCard();
    await select(id);

    await pick('fill', '#b4d5ff');
    await pick('ink', '#b3261e');
    await click('[data-format-bar] .fmt-align[data-value="center"]');
    await page.eval(`(() => {
      const el = document.querySelector('[data-format-bar] [data-field="size"]');
      el.value = 'xl';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settled(id, 'size', 'xl');

    const style = await styleOf(id);
    // A colour the card carries itself cannot be an attribute — no rule can be
    // written for a value nobody knew in advance — so the attribute says so
    // and the value is the custom property the rules would have set.
    assert.equal(style.fill, 'custom');
    assert.equal(style.ink, 'custom');
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

    await click('[data-format-bar] .fmt-transparent');
    await settled(id, 'fill', 'none');

    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor`),
      'rgba(0, 0, 0, 0)',
    );
  });

  test('one change covers every selected card, and undoes as one', async () => {
    const first = await addCard();
    const second = await addCard({ x: 500 });
    await select(first, second);

    await pick('fill', '#b8e6bd');
    await settled(first, 'fill', 'custom');
    await settled(second, 'fill', 'custom');
    assert.equal((await styleOf(first)).fill, 'custom');
    assert.equal((await styleOf(second)).fill, 'custom');

    // One op batch, so one undo — not one per card.
    await page.eval('app.store.undo()');
    await page.waitFor(`document.querySelector('[data-id="${first}"]').dataset.fill !== 'custom'`, {
      label: 'the undo to reach the screen',
    });
    assert.notEqual((await styleOf(first)).fill, 'custom');
    assert.notEqual((await styleOf(second)).fill, 'custom');
  });

  /**
   * Showing the first card's value would claim the others match it, and
   * pre-selecting a swatch true of only one is how somebody changes a card
   * they meant to leave alone.
   */
  test('a disagreeing selection shows the default, not one card\'s colour', async () => {
    // Neither card is yellow, because yellow *is* the fallback — with one of
    // them yellow the test could not tell "they agree" from "it gave up".
    const blue = await addCard({ fill: 'blue' });
    const pink = await addCard({ x: 500, fill: 'pink' });

    const showing = () => page.eval(`document.querySelector('[data-format-bar] [data-field="fill"]').value`);

    await select(blue);
    await page.waitFor(`document.querySelector('[data-format-bar]') !== null`, { label: 'the bar' });
    assert.equal(await showing(), '#b4d5ff', "the picker did not show the card's colour");

    await select(blue, pink);
    await page.waitFor(
      `document.querySelector('[data-format-bar] [data-field="fill"]').value !== '#b4d5ff'`,
      { label: 'the picker to stop showing the first card' },
    );

    // Nothing true to show, so it shows the default rather than either card's
    // colour dressed up as everyone's.
    assert.equal(await showing(), '#ffe98a', 'a disagreeing selection did not fall back to the default');
  });

  test('the bar follows the card when the camera moves', async () => {
    // The camera is pinned and the card put mid-stage, because the bar is
    // ~540px wide and the clamp holds it inside the viewport — at the edges
    // it deliberately stops following, which the next test is about.
    await page.eval('app.viewport.x = 0; app.viewport.y = 0; app.viewport.scale = 1; app.viewport.emit();');
    const id = await addCard({ x: 400 });
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

  /**
   * The bar is positioned by its centre, so clamping the centre alone still
   * leaves half of it off screen — which is most of the controls, and the
   * swatches cannot be clicked where they cannot be seen.
   */
  test('a card at the edge keeps the whole bar on screen', async () => {
    const id = await addCard({ x: -4000 });
    await select(id);
    await page.waitFor(`document.querySelector('[data-format-bar]') !== null`, { label: 'the bar' });

    const box = await page.eval(`(() => {
      const r = document.querySelector('[data-format-bar]').getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, stage: window.innerWidth };
    })()`);

    assert.ok(box.width > 0, 'the bar was not laid out');
    assert.ok(box.left >= 0, `the bar starts off screen at ${box.left}`);
    assert.ok(box.right <= box.stage, `the bar ends off screen at ${box.right} of ${box.stage}`);
  });
});
