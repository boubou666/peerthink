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
   * Whether something is absent, after giving React a commit to render it in.
   *
   * Asserting absence needs a settled page, and there is no positive condition
   * to wait for — so this waits for something that *would* have happened by
   * then: the selection reaching the renderer, which runs on the same frames.
   */
  const absent = async (selector = '[data-format-bar]') => {
    await page.waitFor('Boolean(window.app?.store)', { label: 'the app' });
    await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    return page.eval(`document.querySelector(${JSON.stringify(selector)}) === null`);
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

  /**
   * Colour, font, size and alignment are a card's. Corners are not, so the bar
   * appears with that group alone rather than not appearing at all.
   */
  test('offers an envelope its corners and none of the card controls', async () => {
    const envelope = await page.eval(`app.board.add('envelope', { x: 0, y: 0 }).id`);
    await select(envelope);
    await page.waitFor(`document.querySelector('[data-format-bar]') !== null`, { label: 'the bar' });

    assert.equal(await absent('[data-format-bar] [data-field="fill"]'), true, 'a fill picker for an envelope');
    assert.equal(await absent('[data-format-bar] [data-field="size"]'), true, 'a font size for an envelope');
    assert.equal(await absent('[data-format-bar] .fmt-align'), true, 'text alignment for an envelope');
    assert.equal(await page.eval(`document.querySelectorAll('[data-format-bar] .fmt-corner').length`), 2);
  });

  describe('corners', () => {
    const corner = (value) => `[data-format-bar] .fmt-corner[data-value="${value}"]`;
    const radiusOf = (id) =>
      page.eval(`getComputedStyle(document.querySelector('[data-id="${id}"]')).borderTopLeftRadius`);

    test('squares a card, and rounds it again', async () => {
      const id = await addCard();
      await select(id);

      await click(corner('square'));
      await settled(id, 'corners', 'square');
      assert.equal(await radiusOf(id), '0px', 'the DOM kept the radius');

      await click(corner('round'));
      await settled(id, 'corners', 'round');
      assert.equal(await radiusOf(id), '8px');
    });

    /** The one control the bar offers a selection that has no cards in it. */
    test('applies to every kind of object at once', async () => {
      const card = await addCard();
      const envelope = await page.eval(`app.board.add('envelope', { x: 400, y: 0 }).id`);
      const list = await page.eval(`app.board.add('list', { x: 900, y: 0 }).id`);
      await select(card, envelope, list);

      await click(corner('square'));
      for (const id of [card, envelope, list]) {
        await settled(id, 'corners', 'square');
        assert.equal(await radiusOf(id), '0px', id);
      }
    });

    /**
     * Pre-selecting a value that is only true of one object is how people
     * change something they meant to leave alone — so a selection that
     * disagrees shows neither as current, exactly as the alignment group does.
     */
    test('a selection that disagrees shows neither as current', async () => {
      const round = await addCard();
      const square = await addCard({ x: 600, corners: 'square' });

      await select(square);
      await page.waitFor(`document.querySelector('${corner('square')}[data-current]') !== null`, {
        label: 'square to read as current',
      });

      await select(round, square);
      assert.equal(await absent(`${corner('square')}[data-current]`), true);
      assert.equal(await absent(`${corner('round')}[data-current]`), true);

      // And it still writes to both, which is the point of offering it.
      await click(corner('round'));
      await settled(square, 'corners', 'round');
      await settled(round, 'corners', 'round');
    });

    test('a board written before corners existed draws them round', async () => {
      const id = await addCard();
      assert.equal(await page.eval(`'corners' in app.store.get('${id}')`), false);
      await select(id);

      await page.waitFor(`document.querySelector('${corner('round')}[data-current]') !== null`, {
        label: 'round to read as current',
      });
      assert.equal(await radiusOf(id), '8px');
    });
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
   * The canvas listens for keys on `window`, where `c` adds a card, `e` an
   * envelope and Backspace deletes the selection. Both letters are hex digits
   * and `#ccee00` is a colour somebody will type, so the panel has to be a
   * place where they are only ever digits.
   *
   * Real key events, not `insertText`: the whole point is what the keystrokes
   * do on their way past, and inserted text produces none of them.
   */
  test('typing a colour does not type it at the board', async () => {
    const id = await addCard();
    await select(id);
    await openPicker('fill');

    // Selected, so the keys replace the colour that is there rather than
    // landing wherever focus happens to put the caret.
    await page.eval(`(() => {
      const el = document.querySelector('${panel('fill')} [data-colour-hex]');
      el.focus();
      el.select();
    })()`);
    for (const [key, code, vk] of [['c', 'KeyC', 67], ['e', 'KeyE', 69], ['0', 'Digit0', 48]]) {
      await page.key(key, { code, vk, text: key });
    }
    await page.key('Backspace', { code: 'Backspace', vk: 8 });

    // Wait for the field to hold what was typed before asking what the board
    // did with it. Without this the test can pass for the wrong reason: keys
    // that never reached the picker also never reach the canvas.
    await page.waitFor(
      `document.querySelector('${panel('fill')} [data-colour-hex]').value === 'ce'`,
      { label: 'the keys to land in the hex field' },
    );

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

  /**
   * The palette is read from the stylesheet that decides what the names mean,
   * rather than restated in the component — so retuning a colour in canvas.css
   * moves the swatch with it, and cannot leave the two disagreeing.
   */
  describe('the palette', () => {
    const swatchColours = (field) => page.eval(`(() => {
      const swatches = document.querySelectorAll('${panel(field)} .cp-presets:not([data-colour-recent]) .cp-preset');
      return [...swatches].map((el) => [el.dataset.value, getComputedStyle(el).backgroundColor]);
    })()`);

    test('shows what the stylesheet says each name is', async () => {
      const id = await addCard();
      await select(id);

      await openPicker('fill');
      assert.deepEqual(await swatchColours('fill'), [
        ['yellow', 'rgb(255, 233, 138)'],
        ['blue', 'rgb(180, 213, 255)'],
        ['green', 'rgb(184, 230, 189)'],
        ['pink', 'rgb(255, 196, 214)'],
        ['white', 'rgb(255, 255, 255)'],
      ]);
    });

    /** The same names, and deliberately not the same colours. */
    test('ink is read separately from fill', async () => {
      const id = await addCard();
      await select(id);

      await openPicker('ink');
      const inks = Object.fromEntries(await swatchColours('ink'));
      assert.equal(inks.blue, 'rgb(26, 79, 180)', 'ink blue was read as the paper blue');
      assert.equal(inks.ink, 'rgb(28, 27, 25)');
    });

    /**
     * `none` is a fill the stylesheet has no colour for, and reading its
     * transparent background as a colour would put a black swatch in the
     * palette where "no fill" belongs.
     */
    test('a fill with no colour is not a swatch', async () => {
      const id = await addCard();
      await select(id);

      await openPicker('fill');
      const names = (await swatchColours('fill')).map(([name]) => name);
      assert.equal(names.includes('none'), false, 'transparent was drawn as a colour');
    });
  });

  describe('recent colours', () => {
    const recentSwatches = (field) =>
      page.eval(`[...document.querySelectorAll('${panel(field)} [data-colour-recent] .cp-preset')].map((el) => el.dataset.value)`);

    /**
     * On closing rather than on every change: a drag across the square writes
     * a colour per pointer move, and a row of the last six would be six frames
     * of one gesture.
     */
    test('a mixed colour is remembered when the panel closes', async () => {
      const id = await addCard();
      await select(id);

      await pick('fill', '#123456');
      await page.key('Escape', { code: 'Escape', vk: 27 });
      await page.waitFor(`document.querySelector('${panel('fill')}') === null`, { label: 'the panel to close' });

      await openPicker('fill');
      assert.deepEqual(await recentSwatches('fill'), ['#123456']);
    });

    /**
     * Every way of shutting the panel is a way of settling on a colour. The
     * swatch is a toggle, so it closes the panel without going anywhere near
     * the dismissal listeners the other two ways run through.
     */
    test('closing on the swatch remembers it too', async () => {
      const id = await addCard();
      await select(id);

      await pick('fill', '#654321');
      await click('[data-format-bar] [data-field="fill"]');
      await page.waitFor(`document.querySelector('${panel('fill')}') === null`, { label: 'the panel to close' });

      await openPicker('fill');
      assert.deepEqual(await recentSwatches('fill'), ['#654321']);
    });

    test('and is offered back, as a colour rather than a name', async () => {
      const first = await addCard();
      await select(first);
      await pick('fill', '#123456');
      await page.key('Escape', { code: 'Escape', vk: 27 });

      const second = await addCard({ x: 600 });
      await select(second);
      await openPicker('fill');
      await click(`${panel('fill')} [data-colour-recent] .cp-preset[data-value="#123456"]`);

      await settled(second, 'fill', 'custom');
      assert.equal(await page.eval(`app.store.get('${second}').fill`), '#123456');
    });

    /** A row repeating the swatches directly above it would say nothing. */
    test('a colour the palette already names is not repeated', async () => {
      const id = await addCard();
      await select(id);

      // The fill blue, typed as hex rather than taken off the palette.
      await pick('fill', '#b4d5ff');
      await page.key('Escape', { code: 'Escape', vk: 27 });

      await openPicker('fill');
      assert.deepEqual(await recentSwatches('fill'), [], 'the palette was repeated back');

      // But it is not the *ink* blue, so ink still offers it.
      await page.key('Escape', { code: 'Escape', vk: 27 });
      await openPicker('ink');
      assert.deepEqual(await recentSwatches('ink'), ['#b4d5ff']);
    });

    test('opening and closing without mixing anything remembers nothing', async () => {
      const id = await addCard();
      await select(id);

      await openPicker('fill');
      await click(`${panel('fill')} .cp-preset[data-value="blue"]`);
      await settled(id, 'fill', 'blue');
      await page.key('Escape', { code: 'Escape', vk: 27 });

      await openPicker('fill');
      assert.deepEqual(await recentSwatches('fill'), [], 'a colour off the palette was remembered as if mixed');
    });

    test('it is the browser that remembers, so a reload keeps them', async () => {
      const id = await addCard();
      await select(id);
      await pick('fill', '#123456');
      await page.key('Escape', { code: 'Escape', vk: 27 });

      await page.goto();
      await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
      const again = await addCard();
      await select(again);

      await openPicker('fill');
      assert.deepEqual(await recentSwatches('fill'), ['#123456']);
    });
  });

  describe('the eyedropper', () => {
    /**
     * Chromium has one; the others do not, which is why it is asked for rather
     * than assumed. The stub records that it was opened, which is the only
     * moment the test can see — a dismissal changes nothing, so there is no
     * state to wait for afterwards.
     */
    const stubEyeDropper = (answer) => page.eval(`(() => {
      window.opened = false;
      window.EyeDropper = class {
        open() {
          window.opened = true;
          return ${answer === null ? 'Promise.reject(new DOMException("aborted"))' : `Promise.resolve({ sRGBHex: ${JSON.stringify(answer)} })`};
        }
      };
    })()`);

    /**
     * The eyedropper has been opened and its answer dealt with.
     *
     * Two frames after the call, because the rejection is handled in a
     * microtask and microtasks are drained before the next frame — so anything
     * this flow was going to do has happened by then. The same reasoning as
     * `absent` above: asserting that nothing changed needs a settled page, and
     * there is no positive condition to wait for.
     */
    const settledDropper = async () => {
      await page.waitFor('window.opened === true', { label: 'the eyedropper to open' });
      await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    };

    test('samples a colour onto the cards', async () => {
      const id = await addCard();
      await select(id);
      await stubEyeDropper('#0a7d33');

      await openPicker('fill');
      await click(`${panel('fill')} [data-colour-dropper]`);

      await settled(id, 'fill', 'custom');
      assert.equal(await page.eval(`app.store.get('${id}').fill`), '#0a7d33');
      assert.equal(
        await page.eval(`document.querySelector('${panel('fill')} [data-colour-hex]').value`),
        '#0a7d33',
        'the panel did not follow the colour it sampled',
      );
    });

    /**
     * Escape dismisses the browser's eyedropper, which rejects. That is an
     * ordinary way to end and leaves the panel as it was.
     */
    test('a dismissed eyedropper changes nothing', async () => {
      const id = await addCard({ fill: 'blue' });
      await select(id);
      await stubEyeDropper(null);

      await openPicker('fill');
      await click(`${panel('fill')} [data-colour-dropper]`);
      await settledDropper();

      assert.equal(await page.eval(`app.store.get('${id}').fill`), 'blue');
      assert.equal(
        await page.eval(`document.querySelector('${panel('fill')} [data-colour-hex]').value`),
        '#b4d5ff',
        'the panel moved off the colour it was showing',
      );
      assert.deepEqual(page.errors, [], 'a dismissal was reported as an error');
    });

    test('the button is absent where the browser has no eyedropper', async () => {
      const id = await addCard();
      await select(id);
      await page.eval('delete window.EyeDropper');

      await openPicker('fill');
      assert.equal(
        await page.eval(`document.querySelector('${panel('fill')} [data-colour-dropper]') === null`),
        true,
        'a control was offered for a capability the browser does not have',
      );
    });
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
