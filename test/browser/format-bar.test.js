// Formatting the selected cards.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

const SHIFT = 8; // CDP modifier bitmask

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

  const panel = (field) => `[data-colour-panel="${field}"]`;

  /** Open a picker's panel, or leave it open if it already is. */
  const openPicker = async (field) => {
    if (await page.eval(`document.querySelector('${panel(field)}') !== null`)) return;
    await click(`[data-format-bar] [data-field="${field}"]`);
    await page.waitFor(`document.querySelector('${panel(field)}') !== null`, {
      label: `the ${field} panel`,
    });
  };

  /** The swatch on the bar, which is what the picker is currently showing. */
  const showing = (field) =>
    page.eval(`document.querySelector('[data-format-bar] [data-field="${field}"]').dataset.value`);

  /**
   * Type a colour into the panel's hex field.
   *
   * The value is assigned through the prototype's setter because React keeps
   * its own record of what it last wrote — a plain assignment leaves that
   * record agreeing with the new value, so the event is dispatched and React
   * decides nothing changed.
   */
  const pick = async (field, hex) => {
    await openPicker(field);
    await page.eval(`(() => {
      const el = document.querySelector('${panel(field)} [data-colour-hex]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(hex)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  };

  /** Where something in the panel is on screen, for a real mouse to aim at. */
  const box = (selector) => page.eval(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  })()`);

  const backgroundOf = (id) =>
    page.eval(`getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor`);

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

    assert.equal(await backgroundOf(id), 'rgba(0, 0, 0, 0)');
  });

  /**
   * The palette writes the name, not the colour behind it.
   *
   * A card that says `blue` goes on asking the stylesheet what blue is, so it
   * follows a retune and can differ between themes; one that says `#b4d5ff`
   * has decided. Picking off the palette is the case where the first is what
   * was meant, and it is the only way left to say it.
   */
  test('a swatch from the palette writes the name, not its hex', async () => {
    const id = await addCard();
    await select(id);

    await openPicker('fill');
    await click(`${panel('fill')} .cp-preset[data-value="blue"]`);
    await settled(id, 'fill', 'blue');

    assert.equal(await page.eval(`app.store.get('${id}').fill`), 'blue');
    assert.equal(await backgroundOf(id), 'rgb(180, 213, 255)');
  });

  /**
   * The ink palette is not the fill palette. Both have a blue and they are
   * different colours — pale paper against dark type — which a single map of
   * names to colours got wrong in one direction or the other.
   */
  test('ink offers ink colours, not the paper ones', async () => {
    const id = await addCard();
    await select(id);

    await openPicker('ink');
    await click(`${panel('ink')} .cp-preset[data-value="blue"]`);
    await settled(id, 'ink', 'blue');

    assert.equal(
      await page.eval(`getComputedStyle(document.querySelector('[data-id="${id}"] .card-text')).color`),
      'rgb(26, 79, 180)',
    );
  });

  /**
   * The square is the point of drawing our own picker, so it is driven with a
   * real mouse rather than a synthetic event: pointer capture — what keeps a
   * drag alive past the edge of the square — only exists for a real pointer.
   */
  test('dragging the square paints the cards as it goes', async () => {
    const id = await addCard({ fill: '#ff0000' });
    await select(id);
    await openPicker('fill');

    const square = await box(`${panel('fill')} .cp-area`);
    await page.mouse('mousePressed', square.x + square.w / 2, square.y + square.h / 2);
    await page.mouse('mouseMoved', square.x + square.w * 0.2, square.y + square.h * 0.2);

    // Mid-drag, with the button still down: the choice is made by watching the
    // board rather than the swatch, so the cards have to follow the cursor.
    await page.waitFor(
      `getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor !== 'rgb(255, 0, 0)'`,
      { label: 'the cards to follow the cursor' },
    );

    // Out past the top-left corner: overshooting is how everybody reaches pure
    // white, and carrying on past the edge is what pointer capture is for.
    await page.mouse('mouseMoved', square.x - 40, square.y - 40);
    await page.mouse('mouseReleased', square.x - 40, square.y - 40);

    await page.waitFor(
      `getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor === 'rgb(255, 255, 255)'`,
      { label: 'the drag to reach white' },
    );
  });

  /**
   * The square is two values at once, which no ARIA role describes — so it is
   * a focusable element that takes the arrows rather than a widget claiming to
   * be something it is not.
   */
  test('the square takes arrow keys', async () => {
    const id = await addCard({ fill: '#808080' });
    await select(id);
    await openPicker('fill');

    await page.eval(`document.querySelector('${panel('fill')} .cp-area').focus()`);
    await page.key('ArrowRight', { code: 'ArrowRight', vk: 39, modifiers: SHIFT });

    await page.waitFor(
      `getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor !== 'rgb(128, 128, 128)'`,
      { label: 'the arrow to move the colour' },
    );

    // The keystroke was spent on the colour, not on the board behind it.
    assert.deepEqual(await page.eval(`(() => { const c = app.store.get('${id}'); return [c.x, c.y]; })()`), [200, 200]);
  });

  test('the hue slider turns the wheel under the square', async () => {
    const id = await addCard({ fill: '#ff0000' });
    await select(id);
    await openPicker('fill');

    await page.eval(`(() => {
      const el = document.querySelector('${panel('fill')} [data-colour-hue]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '120');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    // Saturation and brightness were both full, and only the hue moved.
    await page.waitFor(
      `getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor === 'rgb(0, 255, 0)'`,
      { label: 'the hue to reach green' },
    );
  });

  /**
   * The canvas listens for keys on `window` and does not ask where they came
   * from: `c` adds a card, `e` an envelope, and Backspace deletes the
   * selection. Both letters are hex digits, and `#ccee00` is a colour somebody
   * will type.
   *
   * Real key events, not `insertText`: the whole point is what the keystrokes
   * do on their way past, and inserted text produces none of them.
   */
  test('typing a colour does not type it at the board', async () => {
    const id = await addCard();
    await select(id);
    await openPicker('fill');

    await page.eval(`document.querySelector('${panel('fill')} [data-colour-hex]').focus()`);
    for (const [key, code, vk] of [['c', 'KeyC', 67], ['e', 'KeyE', 69], ['0', 'Digit0', 48]]) {
      await page.key(key, { code, vk, text: key });
    }
    await page.key('Backspace', { code: 'Backspace', vk: 8 });

    assert.deepEqual(await page.eval('app.store.order'), [id], 'the board grew while a colour was typed');
  });

  test('half a colour is kept in the field and not written to the cards', async () => {
    const id = await addCard({ fill: 'blue' });
    await select(id);

    // Five digits is no length of colour — `#b4d` would have been one, since
    // the short form is as real as the long.
    await pick('fill', '#b4d5f');
    await page.waitFor(`document.querySelector('${panel('fill')} [data-colour-hex]').value === '#b4d5f'`, {
      label: 'the field to keep what was typed',
    });
    assert.equal(await page.eval(`app.store.get('${id}').fill`), 'blue', 'a half-typed colour reached the card');

    // And once it is a colour, it lands — the field is not a dead end.
    await pick('fill', '#b4d5ff');
    await settled(id, 'fill', 'custom');
  });

  test('the panel closes on Escape, and the selection survives it', async () => {
    const id = await addCard();
    await select(id);
    await openPicker('fill');

    await page.key('Escape', { code: 'Escape', vk: 27 });
    await page.waitFor(`document.querySelector('${panel('fill')}') === null`, { label: 'the panel to close' });

    // Escape on the canvas clears the selection; the panel in front of it is
    // what the key was for, so the bar is still there.
    assert.equal(await page.eval('app.selection.size'), 1);
    assert.equal(await page.eval(`document.querySelector('[data-format-bar]') !== null`), true);
  });

  /**
   * The bar stops pointer events reaching the stage, so a listener that waits
   * for them to bubble never hears about the click on the other swatch — and
   * two panels sit open at once.
   */
  test('opening one picker closes the other', async () => {
    const id = await addCard();
    await select(id);
    await openPicker('fill');

    const swatch = await box('[data-format-bar] [data-field="ink"]');
    await page.click(swatch.x + swatch.w / 2, swatch.y + swatch.h / 2);

    await page.waitFor(`document.querySelector('${panel('ink')}') !== null`, { label: 'the ink panel' });
    assert.equal(await page.eval(`document.querySelector('${panel('fill')}') === null`), true, 'both panels were open');
  });

  /**
   * The bar follows the selection and the selection can be anywhere, so there
   * is no side that is always right: below a card near the floor is below the
   * fold, where the controls cannot be reached.
   */
  test('a picker near the bottom of the window opens upwards', async () => {
    await page.eval('app.viewport.x = 0; app.viewport.y = 0; app.viewport.scale = 1; app.viewport.emit();');
    const id = await addCard({ y: await page.eval('window.innerHeight - 120') });
    await select(id);

    await openPicker('fill');
    assert.equal(await page.eval(`document.querySelector('${panel('fill')}').dataset.placement`), 'above');

    const laid = await box(panel('fill'));
    assert.ok(laid.y >= 0, `the panel starts off screen at ${laid.y}`);
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

    await select(blue);
    await page.waitFor(`document.querySelector('[data-format-bar]') !== null`, { label: 'the bar' });
    assert.equal(await showing('fill'), '#b4d5ff', "the picker did not show the card's colour");

    await select(blue, pink);
    await page.waitFor(
      `document.querySelector('[data-format-bar] [data-field="fill"]').dataset.value !== '#b4d5ff'`,
      { label: 'the picker to stop showing the first card' },
    );

    // Nothing true to show, so it shows the default rather than either card's
    // colour dressed up as everyone's.
    assert.equal(await showing('fill'), '#ffe98a', 'a disagreeing selection did not fall back to the default');
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
