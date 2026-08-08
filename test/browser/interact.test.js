import { test, describe, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

const CTRL = 2; // CDP modifier bitmask
const ALT = 1;
const SHIFT = 8;

/** The three letters that are shortcuts, as CDP has to be told about them. */
const LETTERS = [['c', 'KeyC', 67], ['e', 'KeyE', 69], ['l', 'KeyL', 76]];

describe('interaction', () => {
  let page;

  before(async () => {
    page = await openApp();
    await page.eval('localStorage.clear()');
    await page.goto();
  });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  /** Blank board, camera at 1:1 with the origin at the top-left. */
  beforeEach(async () => {
    await page.eval(`
      app.store.load({ order: [], objects: [] });
      app.selection.clear();
      app.viewport.x = 0; app.viewport.y = 0; app.viewport.scale = 1; app.viewport.emit();
    `);
    await page.sleep(60);
  });

  /**
   * Create an object and step out of the text field the app focuses for you —
   * these tests are about pointer and keyboard behaviour on the canvas, and
   * every shortcut is deliberately inert while typing.
   */
  const add = async (type, props) => {
    const id = await page.eval(`app.board.add(${JSON.stringify(type)}, ${JSON.stringify(props)}).id`);
    await blur();
    return id;
  };
  const pos = (id) => page.eval(`(({x,y,w,h}) => ({x,y,w,h}))(app.store.get("${id}"))`);
  const selected = () => page.eval('[...app.selection.ids]');
  const blur = () => page.eval('document.activeElement?.blur?.()');

  describe('panning', () => {
    test('middle-drag moves the camera', async () => {
      const before = await page.eval('({x: app.viewport.x, y: app.viewport.y})');
      await page.drag({ x: 600, y: 400 }, { x: 500, y: 350 }, { button: 'middle' });
      const after = await page.eval('({x: app.viewport.x, y: app.viewport.y})');
      assert.equal(Math.round(after.x - before.x), 100);
      assert.equal(Math.round(after.y - before.y), 50);
    });

    test('right-drag pans too, without opening a context menu', async () => {
      const before = await page.eval('({x: app.viewport.x})');
      await page.drag({ x: 600, y: 400 }, { x: 540, y: 400 }, { button: 'right' });
      assert.equal(Math.round(await page.eval('app.viewport.x') - before.x), 60);
    });

    test('space turns the canvas into a pan surface', async () => {
      await page.session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await page.sleep(40);
      assert.ok(await page.eval(`document.getElementById('stage').classList.contains('space')`));

      const before = await page.eval('app.viewport.x');
      await page.drag({ x: 600, y: 400 }, { x: 700, y: 400 });
      assert.equal(Math.round(await page.eval('app.viewport.x') - before), -100);

      await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await page.sleep(40);
      assert.ok(!(await page.eval(`document.getElementById('stage').classList.contains('space')`)));
    });

    test('losing window focus releases the space key', async () => {
      await page.session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await page.sleep(40);
      await page.eval(`window.dispatchEvent(new Event('blur'))`);
      assert.ok(!(await page.eval(`document.getElementById('stage').classList.contains('space')`)));
    });

    test('a plain wheel scrolls the canvas', async () => {
      const before = await page.eval('({x: app.viewport.x, y: app.viewport.y})');
      await page.wheel(600, 400, 40, 80);
      const after = await page.eval('({x: app.viewport.x, y: app.viewport.y})');
      assert.ok(after.x > before.x && after.y > before.y);
    });

    test('line and page wheel deltas scroll further than pixel ones', async () => {
      const start = await page.eval('app.viewport.y');
      await page.rawWheel(600, 400, 0, 1, { deltaMode: 1 });
      const lines = (await page.eval('app.viewport.y')) - start;
      await page.rawWheel(600, 400, 0, 1, { deltaMode: 2 });
      const pages = (await page.eval('app.viewport.y')) - start - lines;
      assert.equal(lines, 16);
      assert.equal(pages, 400);
    });

    test('an unhandled mouse button is ignored', async () => {
      // dispatched directly: a real back-button press would navigate the tab away
      const before = await page.eval('app.viewport.x');
      await page.eval(`(() => {
        const stage = document.getElementById('stage');
        stage.dispatchEvent(new PointerEvent('pointerdown', { button: 3, buttons: 8, clientX: 600, clientY: 400, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointermove', { button: 3, buttons: 8, clientX: 500, clientY: 400, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { button: 3, buttons: 0, clientX: 500, clientY: 400, bubbles: true }));
      })()`);
      assert.equal(await page.eval('app.viewport.x'), before);
    });

    test('a release with no gesture in flight is harmless', async () => {
      await page.mouse('mouseReleased', 600, 400);
      assert.deepEqual(page.errors, []);
    });
  });

  describe('zooming', () => {
    test('ctrl+wheel zooms about the cursor', async () => {
      const anchorBefore = await page.eval('app.viewport.toWorld(400, 300)');
      await page.wheel(400, 300, 0, -120, { modifiers: CTRL });
      const scale = await page.eval('app.viewport.scale');
      const anchorAfter = await page.eval('app.viewport.toWorld(400, 300)');

      assert.ok(scale > 1.2 && scale < 1.35, `one notch should be ~1.27×, got ${scale}`);
      assert.ok(Math.abs(anchorAfter.x - anchorBefore.x) < 0.001);
      assert.ok(Math.abs(anchorAfter.y - anchorBefore.y) < 0.001);
    });

    test('the toolbar reports the zoom level', async () => {
      await page.eval('app.viewport.setScaleAt(400, 300, 1.5)');
      assert.equal(await page.eval(`document.getElementById('zoom').textContent`), '150%');
      await page.eval('app.viewport.setScaleAt(400, 300, 1)');
    });
  });

  describe('dragging', () => {
    test('moves the object and snaps to a neighbour edge', async () => {
      const anchor = await add('card', { x: 400, y: 400, w: 200, h: 120 });
      const mover = await add('card', { x: 100, y: 100, w: 200, h: 120 });

      // aim 4px short of aligning the two left edges — inside the snap radius
      const r = await page.rect(mover);
      await page.drag({ x: r.cx, y: r.cy }, { x: r.cx + 296, y: r.cy + 300 });

      const moved = await pos(mover);
      assert.equal(moved.x, 400, 'left edges snapped together');
      assert.ok(await page.eval(`app.store.get("${anchor}").x === 400`));
    });

    test('alt suppresses snapping', async () => {
      await add('card', { x: 400, y: 400, w: 200, h: 120 });
      const mover = await add('card', { x: 100, y: 100, w: 200, h: 120 });

      const r = await page.rect(mover);
      await page.drag({ x: r.cx, y: r.cy }, { x: r.cx + 296, y: r.cy + 300 }, { modifiers: ALT });
      assert.equal((await pos(mover)).x, 396);
    });

    test('guides appear during a snap and clear on release', async () => {
      await add('card', { x: 400, y: 400, w: 200, h: 120 });
      const mover = await add('card', { x: 100, y: 100, w: 200, h: 120 });
      const r = await page.rect(mover);

      await page.mouse('mousePressed', r.cx, r.cy);
      await page.mouse('mouseMoved', r.cx + 150, r.cy + 150);
      await page.mouse('mouseMoved', r.cx + 296, r.cy + 300);
      await page.sleep(60);
      assert.ok(await page.eval(`document.querySelectorAll('#overlay .guide').length > 0`));

      await page.mouse('mouseReleased', r.cx + 296, r.cy + 300);
      await page.sleep(60);
      assert.equal(await page.eval(`document.querySelectorAll('#overlay .guide').length`), 0);
    });

    test('a click below the drag threshold selects without recording history', async () => {
      const id = await add('card', { x: 100, y: 100 });
      await page.eval('app.store.past.length = 0');
      const r = await page.rect(id);
      await page.drag({ x: r.cx, y: r.cy }, { x: r.cx + 1, y: r.cy + 1 }, { steps: 2 });
      assert.deepEqual(await selected(), [id]);
      assert.equal(await page.eval('app.store.past.length'), 0);
      assert.deepEqual(await pos(id), { x: 100, y: 100, w: 200, h: 120 });
    });

    test('shift extends the selection and drags the whole group', async () => {
      const a = await add('card', { x: 100, y: 100 });
      const b = await add('card', { x: 500, y: 100 });
      const ra = await page.rect(a);
      await page.click(ra.cx, ra.cy);
      const rb = await page.rect(b);
      await page.drag({ x: rb.cx, y: rb.cy }, { x: rb.cx + 200, y: rb.cy }, { modifiers: SHIFT });

      assert.equal((await selected()).length, 2);
      assert.equal((await pos(a)).x, 300);
      assert.equal((await pos(b)).x, 700);
    });

    test('shift-clicking a selected object removes it and cancels the drag', async () => {
      const a = await add('card', { x: 100, y: 100 });
      await page.eval(`app.selection.set(["${a}"])`);
      const r = await page.rect(a);
      await page.drag({ x: r.cx, y: r.cy }, { x: r.cx + 80, y: r.cy }, { modifiers: SHIFT });
      assert.deepEqual(await selected(), []);
      assert.equal((await pos(a)).x, 100);
    });

    test('dragging is undoable as one step', async () => {
      const id = await add('card', { x: 100, y: 100 });
      await page.eval('app.store.past.length = 0');
      const r = await page.rect(id);
      await page.drag({ x: r.cx, y: r.cy }, { x: r.cx + 250, y: r.cy + 250 }, { modifiers: ALT });
      assert.equal(await page.eval('app.store.past.length'), 1);
      await page.key('z', { code: 'KeyZ', vk: 90, modifiers: CTRL });
      assert.deepEqual(await pos(id), { x: 100, y: 100, w: 200, h: 120 });
    });

    test('an envelope carries everything inside it', async () => {
      const env = await add('envelope', { x: 100, y: 100, w: 400, h: 300 });
      const inside = await add('card', { x: 150, y: 150, w: 150, h: 100 });
      const outside = await add('card', { x: 700, y: 150, w: 150, h: 100 });

      const r = await page.rect(env);
      await page.drag({ x: r.x + 10, y: r.y + r.h - 6 }, { x: r.x + 10 + 120, y: r.y + r.h - 6 + 90 }, { modifiers: ALT });

      assert.deepEqual(await pos(env), { x: 220, y: 190, w: 400, h: 300 });
      assert.equal((await pos(inside)).x, 270);
      assert.equal((await pos(outside)).x, 700, 'objects outside stay put');
    });

    test('dragging brings a card to the front but leaves envelopes behind', async () => {
      const a = await add('card', { x: 100, y: 100 });
      const b = await add('card', { x: 400, y: 100 });
      const env = await add('envelope', { x: 900, y: 900, w: 300, h: 200 });

      const ra = await page.rect(a);
      await page.drag({ x: ra.cx, y: ra.cy }, { x: ra.cx + 30, y: ra.cy }, { modifiers: ALT });
      let order = await page.eval('app.store.order.slice()');
      assert.equal(order[order.length - 1], a);
      assert.ok(order.indexOf(env) < order.indexOf(b), 'the envelope stays underneath');

      // already on top — the raise must be a no-op rather than churn the order
      await page.drag({ x: ra.cx + 30, y: ra.cy }, { x: ra.cx + 60, y: ra.cy }, { modifiers: ALT });
      assert.deepEqual(await page.eval('app.store.order.slice()'), order);

      const re = await page.rect(env);
      await page.drag({ x: re.x + 8, y: re.y + re.h - 6 }, { x: re.x + 18, y: re.y + re.h - 6 }, { modifiers: ALT });
      order = await page.eval('app.store.order.slice()');
      assert.equal(order[0], env, 'dragging an envelope does not raise it');
    });
  });

  describe('resizing', () => {
    test('each handle resizes from its own anchor', async () => {
      const id = await add('card', { x: 300, y: 300, w: 200, h: 200 });
      await page.eval(`app.selection.set(["${id}"])`);
      await page.sleep(50);

      const cases = [
        ['se', 40, 40, { x: 300, y: 300, w: 240, h: 240 }],
        ['nw', 40, 40, { x: 340, y: 340, w: 200, h: 200 }],
        ['e', 30, 0, { x: 340, y: 340, w: 230, h: 200 }],
        ['w', 30, 0, { x: 370, y: 340, w: 200, h: 200 }],
        ['s', 0, 30, { x: 370, y: 340, w: 200, h: 230 }],
        ['n', 0, 30, { x: 370, y: 370, w: 200, h: 200 }],
        ['ne', 20, -20, { x: 370, y: 350, w: 220, h: 220 }],
        ['sw', -20, 20, { x: 350, y: 350, w: 240, h: 240 }],
      ];

      for (const [dir, dx, dy, expected] of cases) {
        const box = await page.eval(`(() => {
          const r = document.querySelector('[data-id="${id}"] [data-handle="${dir}"]').getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        })()`);
        await page.drag({ x: box.cx, y: box.cy }, { x: box.cx + dx, y: box.cy + dy });
        assert.deepEqual(await pos(id), expected, `handle ${dir}`);
      }
    });

    test('objects cannot be resized below the minimum', async () => {
      const id = await add('card', { x: 300, y: 300, w: 200, h: 200 });
      await page.eval(`app.selection.set(["${id}"])`);
      await page.sleep(50);
      const box = await page.eval(`(() => {
        const r = document.querySelector('[data-id="${id}"] [data-handle="se"]').getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })()`);
      await page.drag({ x: box.cx, y: box.cy }, { x: box.cx - 400, y: box.cy - 400 }, { steps: 10 });
      assert.deepEqual(await pos(id), { x: 300, y: 300, w: 48, h: 48 });
    });

    test('a resize is one undo step', async () => {
      const id = await add('card', { x: 300, y: 300, w: 200, h: 200 });
      await page.eval(`app.selection.set(["${id}"]); app.store.past.length = 0;`);
      await page.sleep(50);
      const box = await page.eval(`(() => {
        const r = document.querySelector('[data-id="${id}"] [data-handle="se"]').getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })()`);
      await page.drag({ x: box.cx, y: box.cy }, { x: box.cx + 60, y: box.cy + 60 });
      assert.equal(await page.eval('app.store.past.length'), 1);
      await page.key('z', { code: 'KeyZ', vk: 90, modifiers: CTRL });
      assert.deepEqual(await pos(id), { x: 300, y: 300, w: 200, h: 200 });
    });

    test('a handle press that never moves records nothing', async () => {
      const id = await add('card', { x: 300, y: 300, w: 200, h: 200 });
      await page.eval(`app.selection.set(["${id}"]); app.store.past.length = 0;`);
      await page.sleep(50);
      const box = await page.eval(`(() => {
        const r = document.querySelector('[data-id="${id}"] [data-handle="se"]').getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })()`);
      await page.mouse('mousePressed', box.cx, box.cy);
      await page.mouse('mouseReleased', box.cx, box.cy);
      await page.sleep(50);
      assert.equal(await page.eval('app.store.past.length'), 0);
    });
  });

  describe('marquee', () => {
    test('selects everything it touches', async () => {
      const a = await add('card', { x: 100, y: 100, w: 150, h: 100 });
      const b = await add('card', { x: 400, y: 100, w: 150, h: 100 });
      await add('card', { x: 100, y: 600, w: 150, h: 100 });

      await page.drag({ x: 60, y: 60 }, { x: 620, y: 260 }, { steps: 8 });
      assert.deepEqual((await selected()).sort(), [a, b].sort());
      assert.equal(await page.eval(`document.getElementById('marquee')`), null, 'the box is removed on release');
    });

    test('shift keeps the previous selection', async () => {
      const a = await add('card', { x: 100, y: 100, w: 150, h: 100 });
      const b = await add('card', { x: 100, y: 600, w: 150, h: 100 });
      await page.eval(`app.selection.set(["${a}"])`);
      await page.drag({ x: 60, y: 560 }, { x: 320, y: 760 }, { steps: 6, modifiers: SHIFT });
      assert.deepEqual((await selected()).sort(), [a, b].sort());
    });

    test('clicking empty space clears the selection', async () => {
      const a = await add('card', { x: 100, y: 100 });
      await page.eval(`app.selection.set(["${a}"])`);
      await page.click(900, 700);
      assert.deepEqual(await selected(), []);
    });
  });

  describe('text editing', () => {
    test('double-click focuses the field and typing reaches the store', async () => {
      const id = await add('card', { x: 200, y: 200, text: '' });
      const r = await page.rect(id);
      await page.dblclick(r.cx, r.cy);
      assert.equal(await page.eval(`document.activeElement.dataset.field`), 'text');
      assert.ok(await page.eval(`document.querySelector('[data-id="${id}"]').classList.contains('editing')`));
      assert.equal(await page.eval('app.input.editingId'), id);

      await page.type('typed');
      assert.equal(await page.eval(`app.store.get("${id}").text`), 'typed');

      await blur();
      assert.equal(await page.eval('app.input.editingId'), null);
    });

    test('an edit is one undo step, and a no-op edit records nothing', async () => {
      const id = await add('card', { x: 200, y: 200, text: 'start' });
      const r = await page.rect(id);

      await page.eval('app.store.past.length = 0');
      await page.dblclick(r.cx, r.cy);
      await page.type('!');
      await blur();
      await page.sleep(50);
      assert.equal(await page.eval('app.store.past.length'), 1);
      await page.key('z', { code: 'KeyZ', vk: 90, modifiers: CTRL });
      assert.equal(await page.eval(`app.store.get("${id}").text`), 'start');

      await page.eval('app.store.past.length = 0');
      await page.dblclick(r.cx, r.cy);
      await blur();
      await page.sleep(50);
      assert.equal(await page.eval('app.store.past.length'), 0);
    });

    test('clicking inside the field being edited keeps the caret rather than dragging', async () => {
      const id = await add('card', { x: 200, y: 200, text: 'some words here' });
      const r = await page.rect(id);
      await page.dblclick(r.x + 20, r.y + 20);
      await page.click(r.x + 40, r.y + 20);
      assert.equal(await page.eval(`document.activeElement.dataset.field`), 'text');
      assert.deepEqual(await pos(id), { x: 200, y: 200, w: 200, h: 120 });
      await blur();
    });

    test('clicking another object ends the edit', async () => {
      const a = await add('card', { x: 200, y: 200, text: 'a' });
      const b = await add('card', { x: 500, y: 200, text: 'b' });
      const ra = await page.rect(a);
      await page.dblclick(ra.cx, ra.cy);
      const rb = await page.rect(b);
      await page.click(rb.cx, rb.cy);
      assert.equal(await page.eval(`document.querySelectorAll('#layer .editing').length`), 0);
    });

    test('editing survives the object being deleted underneath it', async () => {
      const id = await add('card', { x: 200, y: 200, text: 'doomed' });
      const r = await page.rect(id);
      await page.dblclick(r.cx, r.cy);
      await page.type('x');
      await page.eval(`app.store.apply([{ t: 'del', id: "${id}" }])`);
      await blur();
      await page.sleep(50);
      assert.deepEqual(page.errors, []);
    });

    test('double-clicking empty canvas creates a card there', async () => {
      await page.dblclick(500, 400);
      const cards = await page.eval(`app.store.all().filter(o => o.type === 'card').map(o => ({x: o.x, y: o.y}))`);
      assert.deepEqual(cards, [{ x: 400, y: 340 }]);
      await blur();
    });

    test('caret placement degrades gracefully without caretPositionFromPoint', async () => {
      const id = await add('card', { x: 200, y: 200, text: 'fallback path' });
      const r = await page.rect(id);

      await page.eval('window.__cpfp = document.caretPositionFromPoint; document.caretPositionFromPoint = undefined;');
      await page.dblclick(r.x + 30, r.y + 20);
      assert.equal(await page.eval(`document.activeElement.dataset.field`), 'text');
      await blur();

      await page.eval('window.__crfp = document.caretRangeFromPoint; document.caretRangeFromPoint = undefined;');
      await page.dblclick(r.x + 30, r.y + 20);
      assert.equal(await page.eval(`document.activeElement.dataset.field`), 'text');
      await blur();

      await page.eval('document.caretPositionFromPoint = window.__cpfp; document.caretRangeFromPoint = window.__crfp;');
    });

    test('paste is inserted as plain text', async () => {
      const id = await add('card', { x: 200, y: 200, text: '' });
      const r = await page.rect(id);
      await page.dblclick(r.cx, r.cy);
      await page.eval(`(() => {
        const field = document.activeElement;
        const data = new DataTransfer();
        data.setData('text/plain', 'plain <b>text</b>');
        field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      })()`);
      await page.sleep(60);
      assert.equal(await page.eval(`app.store.get("${id}").text`), 'plain <b>text</b>');
      await blur();
    });

    test('paste outside an editable is left alone', async () => {
      await add('card', { x: 200, y: 200 });
      await page.eval(`(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'nope');
        document.querySelector('#layer .obj').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      })()`);
      assert.deepEqual(page.errors, []);
    });

    test('input on an element with no field is ignored', async () => {
      await add('card', { x: 200, y: 200 });
      await page.eval(`document.querySelector('#layer .obj').dispatchEvent(new InputEvent('input', { bubbles: true }))`);
      assert.deepEqual(page.errors, []);
    });
  });

  describe('lists', () => {
    const firstItemBox = (id) => page.eval(`(() => {
      const r = document.querySelector('[data-id="${id}"] [data-item-id] [data-field="item"]').getBoundingClientRect();
      return { cx: r.left + r.width - 3, cy: r.top + r.height / 2 };
    })()`);

    test('the add button appends an item and focuses it', async () => {
      const id = await add('list', { x: 200, y: 200 });
      const before = await page.eval(`app.store.get("${id}").items.length`);
      const btn = await page.eval(`(() => {
        const r = document.querySelector('[data-id="${id}"] .list-add').getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })()`);
      await page.click(btn.cx, btn.cy);
      await page.sleep(80);
      assert.equal(await page.eval(`app.store.get("${id}").items.length`), before + 1);
      assert.equal(await page.eval(`document.activeElement.dataset.field`), 'item');
      await blur();
    });

    test('Enter splits into a new item below', async () => {
      const id = await add('list', { x: 200, y: 200 });
      const box = await firstItemBox(id);
      await page.dblclick(box.cx, box.cy);
      await page.type('first');
      await page.key('Enter', { code: 'Enter', vk: 13 });
      await page.type('second');
      assert.deepEqual(await page.eval(`app.store.get("${id}").items.map(i => i.text)`), ['first', 'second']);
      await blur();
    });

    test('Backspace in an empty item removes it and moves the caret up', async () => {
      const id = await add('list', { x: 200, y: 200 });
      const box = await firstItemBox(id);
      await page.dblclick(box.cx, box.cy);
      await page.type('one');
      await page.key('Enter', { code: 'Enter', vk: 13 });
      assert.equal(await page.eval(`app.store.get("${id}").items.length`), 2);

      await page.key('Backspace', { code: 'Backspace', vk: 8 });
      assert.deepEqual(await page.eval(`app.store.get("${id}").items.map(i => i.text)`), ['one']);
      assert.equal(await page.eval(`document.activeElement.dataset.field`), 'item');
      await blur();
    });

    test('Backspace on the only item leaves it alone', async () => {
      const id = await add('list', { x: 200, y: 200 });
      const box = await firstItemBox(id);
      await page.dblclick(box.cx, box.cy);
      await page.key('Backspace', { code: 'Backspace', vk: 8 });
      assert.equal(await page.eval(`app.store.get("${id}").items.length`), 1);
      await blur();
    });

    test('Escape leaves the field', async () => {
      const id = await add('list', { x: 200, y: 200 });
      const box = await firstItemBox(id);
      await page.dblclick(box.cx, box.cy);
      await page.key('Escape', { code: 'Escape', vk: 27 });
      assert.equal(await page.eval(`document.activeElement.dataset?.field ?? null`), null);
    });

    test('shift+Enter inserts a line break instead of a new item', async () => {
      const id = await add('list', { x: 200, y: 200 });
      const box = await firstItemBox(id);
      await page.dblclick(box.cx, box.cy);
      await page.type('x');
      await page.key('Enter', { code: 'Enter', vk: 13, modifiers: SHIFT });
      assert.equal(await page.eval(`app.store.get("${id}").items.length`), 1);
      await blur();
    });

    test('the checkbox toggles done without selecting the list for a drag', async () => {
      const id = await add('list', { x: 200, y: 200 });
      const box = await page.eval(`(() => {
        const r = document.querySelector('[data-id="${id}"] .li-check').getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })()`);
      await page.click(box.cx, box.cy);
      assert.equal(await page.eval(`app.store.get("${id}").items[0].done`), true);
      await page.click(box.cx, box.cy);
      assert.equal(await page.eval(`app.store.get("${id}").items[0].done`), false);
    });

    test('a keystroke outside an item field is left to the browser', async () => {
      const id = await add('list', { x: 200, y: 200, title: 'T' });
      const r = await page.eval(`(() => {
        const el = document.querySelector('[data-id="${id}"] [data-field="title"]').getBoundingClientRect();
        return { cx: el.left + el.width / 2, cy: el.top + el.height / 2 };
      })()`);
      await page.dblclick(r.cx, r.cy);
      await page.key('Enter', { code: 'Enter', vk: 13 });
      assert.equal(await page.eval(`app.store.get("${id}").items.length`), 1);
      await blur();
    });
  });

  describe('keyboard', () => {
    test('Delete removes the selection but spares an envelope\'s contents', async () => {
      const env = await add('envelope', { x: 100, y: 100, w: 400, h: 300 });
      const inside = await add('card', { x: 150, y: 150, w: 100, h: 80 });
      await page.eval(`app.selection.set(["${env}"])`);
      await page.key('Delete', { code: 'Delete', vk: 46 });
      assert.equal(await page.eval(`app.store.get("${env}") ?? null`), null);
      assert.ok(await page.eval(`!!app.store.get("${inside}")`));
      assert.deepEqual(await selected(), []);
    });

    test('Delete with nothing selected does nothing', async () => {
      await add('card', { x: 100, y: 100 });
      await page.eval('app.selection.clear()');
      await page.key('Delete', { code: 'Delete', vk: 46 });
      assert.equal(await page.eval('app.store.order.length'), 1);
    });

    test('Escape clears the selection', async () => {
      const id = await add('card', { x: 100, y: 100 });
      await page.eval(`app.selection.set(["${id}"])`);
      await page.key('Escape', { code: 'Escape', vk: 27 });
      assert.deepEqual(await selected(), []);
    });

    test('ctrl+A selects everything', async () => {
      await add('card', { x: 100, y: 100 });
      await add('card', { x: 400, y: 100 });
      await page.key('a', { code: 'KeyA', vk: 65, modifiers: CTRL });
      assert.equal((await selected()).length, 2);
    });

    test('ctrl+D duplicates with an offset', async () => {
      const id = await add('card', { x: 100, y: 100, text: 'orig' });
      await page.eval(`app.selection.set(["${id}"])`);
      await page.key('d', { code: 'KeyD', vk: 68, modifiers: CTRL });
      const all = await page.eval('app.store.all().map(o => ({x: o.x, y: o.y, text: o.text}))');
      assert.equal(all.length, 2);
      assert.deepEqual(all[1], { x: 124, y: 124, text: 'orig' });
      assert.equal((await selected()).length, 1);
    });

    test('ctrl+shift+Z redoes', async () => {
      const id = await add('card', { x: 100, y: 100 });
      await page.eval(`app.selection.set(["${id}"]);`);
      await page.key('Delete', { code: 'Delete', vk: 46 });
      await page.key('z', { code: 'KeyZ', vk: 90, modifiers: CTRL });
      assert.ok(await page.eval(`!!app.store.get("${id}")`));
      await page.key('z', { code: 'KeyZ', vk: 90, modifiers: CTRL | SHIFT });
      assert.equal(await page.eval(`app.store.get("${id}") ?? null`), null);
    });

    test('arrows nudge, shift nudges further, and the whole envelope moves', async () => {
      const env = await add('envelope', { x: 100, y: 100, w: 400, h: 300 });
      const inside = await add('card', { x: 150, y: 150, w: 100, h: 80 });
      await page.eval(`app.selection.set(["${env}"])`);

      await page.key('ArrowRight', { code: 'ArrowRight', vk: 39 });
      await page.key('ArrowDown', { code: 'ArrowDown', vk: 40 });
      assert.deepEqual(await pos(env), { x: 101, y: 101, w: 400, h: 300 });
      assert.equal((await pos(inside)).x, 151);

      await page.key('ArrowLeft', { code: 'ArrowLeft', vk: 37, modifiers: SHIFT });
      await page.key('ArrowUp', { code: 'ArrowUp', vk: 38, modifiers: SHIFT });
      assert.deepEqual(await pos(env), { x: 81, y: 81, w: 400, h: 300 });
    });

    test('arrows with nothing selected are ignored', async () => {
      await add('card', { x: 100, y: 100 });
      await page.eval('app.selection.clear()');
      await page.key('ArrowRight', { code: 'ArrowRight', vk: 39 });
      assert.equal(await page.eval('app.store.all()[0].x'), 100);
    });

    test('c, e and l create each object type at the centre of the view', async () => {
      await page.key('c', { code: 'KeyC', vk: 67 });
      await blur();
      await page.key('e', { code: 'KeyE', vk: 69 });
      await blur();
      await page.key('l', { code: 'KeyL', vk: 76 });
      await blur();
      assert.deepEqual(await page.eval(`app.store.all().map(o => o.type).sort()`), ['card', 'envelope', 'list']);
    });

    /**
     * Real keystrokes, not `insertText`. The shortcuts hang off `keydown`, and
     * inserted text fires none — so the same test written with `page.type`
     * passes whether the guard is there or not, which is the shape of a test
     * that has never been true of anything.
     */
    test('shortcuts are inert while typing', async () => {
      const id = await add('card', { x: 200, y: 200, text: '' });
      const r = await page.rect(id);
      await page.dblclick(r.cx, r.cy);
      for (const [key, code, vk] of LETTERS) await page.key(key, { code, vk, text: key });
      assert.equal(await page.eval('app.store.order.length'), 1);
      assert.equal(await page.eval(`app.store.get("${id}").text`), 'cel');
      await blur();
    });

    test('an unbound key does nothing', async () => {
      await add('card', { x: 100, y: 100 });
      await page.key('q', { code: 'KeyQ', vk: 81 });
      assert.equal(await page.eval('app.store.order.length'), 1);
    });
  });

  /**
   * The canvas listens for keys on `window`, which is the only way to hear a
   * shortcut pressed while nothing in particular has focus. The cost is that
   * it hears everything else too — including what is typed into the app's own
   * chrome, which is on the same page and is not the board.
   *
   * The board title is the field to test it on: it is the one text input on
   * the board route, and it is where somebody types the name of a board.
   */
  describe('keys typed into a field', () => {
    const TITLE = '.board-bar-title';

    const focusTitle = () => page.eval(`document.querySelector('${TITLE}').focus()`);
    const titleValue = () => page.eval(`document.querySelector('${TITLE}').value`);

    // The title is not part of the board, so `beforeEach` does not reset it.
    // Left alone, one test's keystrokes are the next one's starting value.
    afterEach(async () => {
      await page.eval(`(() => {
        const el = document.querySelector('${TITLE}');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, 'Untitled board');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.blur();
      })()`);
    });

    test('space types a space instead of arming the pan cursor', async () => {
      await focusTitle();
      await page.key(' ', { code: 'Space', vk: 32, text: ' ' });

      assert.equal(await titleValue(), 'Untitled board ', 'the space never reached the field');
      assert.equal(
        await page.eval(`document.getElementById('stage').classList.contains('space')`),
        false,
        'the canvas armed its pan cursor from a keystroke in a text field',
      );
    });

    test('the object shortcuts stay out of it', async () => {
      await add('card', { x: 100, y: 100 });
      await focusTitle();
      for (const [key, code, vk] of LETTERS) await page.key(key, { code, vk, text: key });

      assert.equal(await page.eval('app.store.order.length'), 1, 'typing in the title built a board');
      assert.equal(await titleValue(), 'Untitled boardcel');
    });

    test('backspace deletes a letter, not the selection', async () => {
      const id = await add('card', { x: 100, y: 100 });
      await page.eval(`app.selection.set(["${id}"])`);
      await focusTitle();
      await page.key('Backspace', { code: 'Backspace', vk: 8 });

      assert.ok(await page.eval(`!!app.store.get("${id}")`), 'the selected card was deleted by a keystroke in the title');
      assert.equal(await titleValue(), 'Untitled boar');
    });

    test('the arrows move the caret, not the cards', async () => {
      const id = await add('card', { x: 100, y: 100 });
      await page.eval(`app.selection.set(["${id}"])`);
      await focusTitle();
      await page.key('ArrowLeft', { code: 'ArrowLeft', vk: 37 });

      const { x, y } = await pos(id);
      assert.deepEqual({ x, y }, { x: 100, y: 100 }, 'a keystroke in the title nudged the board');
    });

    /**
     * The undo the browser gives a text field, not the board's. Two different
     * histories answer to the same chord, and the one that answers should be
     * the one holding the thing in front of you.
     */
    test('ctrl+Z is the field\'s own', async () => {
      const id = await add('card', { x: 100, y: 100 });
      await focusTitle();
      await page.key('z', { code: 'KeyZ', vk: 90, modifiers: CTRL });

      assert.ok(await page.eval(`!!app.store.get("${id}")`), 'ctrl+Z in the title undid the board');
    });
  });
});
