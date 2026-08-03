import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

const KEY = 'peerthink:board';

describe('app shell', () => {
  let page;

  before(async () => {
    page = await openApp();
  });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  /** Reload with a chosen localStorage state. */
  async function boot(raw) {
    await page.eval(raw === null ? `localStorage.removeItem(${JSON.stringify(KEY)})` : `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(raw)})`);
    await page.goto();
  }

  const button = (sel) => page.eval(`(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  })()`);
  const clickButton = async (sel) => {
    const b = await button(sel);
    await page.click(b.cx, b.cy);
  };

  describe('first run', () => {
    beforeEach(async () => {
      await boot(null);
    });

    test('seeds a starter board and frames it', async () => {
      assert.equal(await page.eval('app.store.order.length'), 7);
      assert.deepEqual(await page.eval(`[...new Set(app.store.all().map(o => o.type))].sort()`), ['card', 'envelope', 'list']);
      assert.ok(await page.eval('app.viewport.scale > 0 && app.viewport.scale <= 1.5'));
      assert.match(await page.eval(`document.getElementById('zoom').textContent`), /^\d+%$/);
    });

    test('the seed is not undoable — there is nothing before it', async () => {
      assert.equal(await page.eval('app.store.past.length'), 0);
    });
  });

  describe('persistence', () => {
    test('a board survives a reload', async () => {
      await boot(null);
      const id = await page.eval(`app.board.add('card', { x: 5000, y: 5000, text: 'persisted' }).id`);
      await page.sleep(600); // debounced save

      await page.goto();
      assert.equal(await page.eval(`app.store.get("${id}")?.text ?? null`), 'persisted');
    });

    test('corrupt storage falls back to the starter board', async () => {
      await boot('{not json');
      assert.equal(await page.eval('app.store.order.length'), 7);
    });

    test('an empty board in storage falls back too', async () => {
      await boot(JSON.stringify({ v: 1, order: [], objects: [] }));
      assert.equal(await page.eval('app.store.order.length'), 7);
    });

    test('a stored board is loaded verbatim', async () => {
      const board = { v: 1, order: ['solo'], objects: [{ id: 'solo', type: 'card', x: 0, y: 0, w: 200, h: 120, text: 'only me', color: 'white' }] };
      await boot(JSON.stringify(board));
      assert.equal(await page.eval('app.store.order.length'), 1);
      assert.equal(await page.eval(`app.store.get('solo').text`), 'only me');
    });

    test('a storage failure does not break the board', async () => {
      await boot(null);
      await page.eval(`(() => {
        window.__setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
      })()`);
      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'unsaveable' })`);
      await page.sleep(600);
      assert.deepEqual(page.errors, []);
      assert.ok(await page.eval('app.store.order.length > 7'));
      await page.eval('Storage.prototype.setItem = window.__setItem;');
    });
  });

  describe('toolbar', () => {
    beforeEach(async () => {
      await boot(null);
    });

    test('each button creates its object type at the centre of the view', async () => {
      for (const [sel, type] of [['[data-add="card"]', 'card'], ['[data-add="envelope"]', 'envelope'], ['[data-add="list"]', 'list']]) {
        const before = await page.eval(`app.store.all().filter(o => o.type === '${type}').length`);
        await clickButton(sel);
        await page.eval('document.activeElement?.blur?.()');
        assert.equal(await page.eval(`app.store.all().filter(o => o.type === '${type}').length`), before + 1);
      }
      const newest = await page.eval('app.store.all().at(-1)');
      const centre = await page.eval(`(() => { const r = app.viewport.visibleRect(document.getElementById("stage").clientWidth, document.getElementById("stage").clientHeight); return { x: r.x + r.w/2, y: r.y + r.h/2 }; })()`);
      assert.ok(Math.abs(newest.x + newest.w / 2 - centre.x) < 2);
    });

    test('a new envelope goes to the back and a new list starts with one item', async () => {
      await clickButton('[data-add="envelope"]');
      await page.eval('document.activeElement?.blur?.()');
      assert.equal(await page.eval(`app.store.get(app.store.order[0]).type`), 'envelope');

      await clickButton('[data-add="list"]');
      await page.eval('document.activeElement?.blur?.()');
      assert.equal(await page.eval('app.store.all().at(-1).items.length'), 1);
    });

    test('new cards cycle through the palette', async () => {
      const colors = [];
      for (let i = 0; i < 6; i++) {
        await clickButton('[data-add="card"]');
        await page.eval('document.activeElement?.blur?.()');
        colors.push(await page.eval('app.store.all().at(-1).color'));
      }
      assert.equal(new Set(colors).size, 5, 'five distinct colours');
      assert.equal(colors[0], colors[5], 'then it wraps');
    });

    test('undo and redo buttons drive history', async () => {
      await clickButton('[data-add="card"]');
      await page.eval('document.activeElement?.blur?.()');
      const count = await page.eval('app.store.order.length');

      await clickButton('[data-act="undo"]');
      assert.equal(await page.eval('app.store.order.length'), count - 1);
      await clickButton('[data-act="redo"]');
      assert.equal(await page.eval('app.store.order.length'), count);
    });

    test('fit frames the board and reset returns to 100%', async () => {
      await page.eval('app.viewport.setScaleAt(0, 0, 4)');
      await clickButton('[data-act="fit"]');
      assert.ok(await page.eval('app.viewport.scale < 2'));

      await clickButton('[data-act="reset"]');
      assert.equal(await page.eval('app.viewport.scale'), 1);
      assert.equal(await page.eval(`document.getElementById('zoom').textContent`), '100%');
    });

    test('fit on an empty board leaves the camera alone', async () => {
      await page.eval(`app.store.load({ order: [], objects: [] }); app.viewport.setScaleAt(0, 0, 2);`);
      await clickButton('[data-act="fit"]');
      assert.equal(await page.eval('app.viewport.scale'), 2);
    });

    test('a click on the toolbar background is ignored', async () => {
      const before = await page.eval('app.store.order.length');
      await page.eval(`document.getElementById('toolbar').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      assert.equal(await page.eval('app.store.order.length'), before);
    });
  });

  describe('view shortcuts', () => {
    beforeEach(async () => {
      await boot(null);
    });

    const press = (key, code) => page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, shiftKey: true, bubbles: true }))`);

    test('shift+1 fits and shift+0 resets', async () => {
      await page.eval('app.viewport.setScaleAt(0, 0, 5)');
      await press('!', 'Digit1');
      await page.sleep(60);
      assert.ok(await page.eval('app.viewport.scale < 2'));

      await press(')', 'Digit0');
      await page.sleep(60);
      assert.equal(await page.eval('app.viewport.scale'), 1);
    });

    test('layouts that report only the code still work', async () => {
      await page.eval('app.viewport.setScaleAt(0, 0, 5)');
      await press('&', 'Digit1');
      await page.sleep(60);
      assert.ok(await page.eval('app.viewport.scale < 2'));
      await press('à', 'Digit0');
      await page.sleep(60);
      assert.equal(await page.eval('app.viewport.scale'), 1);
    });

    test('they are inert inside a text field', async () => {
      await page.eval('app.viewport.setScaleAt(0, 0, 3)');
      await page.eval(`(() => {
        const field = document.querySelector('#layer [contenteditable]');
        field.focus();
        field.dispatchEvent(new KeyboardEvent('keydown', { key: ')', code: 'Digit0', shiftKey: true, bubbles: true }));
        field.blur();
      })()`);
      assert.equal(await page.eval('app.viewport.scale'), 3);
    });
  });

  describe('duplicate', () => {
    test('does nothing with an empty selection', async () => {
      await boot(null);
      await page.eval('app.selection.clear()');
      const before = await page.eval('app.store.order.length');
      await page.eval('app.commands.duplicate()');
      assert.equal(await page.eval('app.store.order.length'), before);
    });

    test('copies a multi-selection', async () => {
      await boot(null);
      await page.eval('app.selection.set(app.store.order.slice(0, 3))');
      const before = await page.eval('app.store.order.length');
      await page.eval('app.commands.duplicate()');
      assert.equal(await page.eval('app.store.order.length'), before + 3);
      assert.equal(await page.eval('app.selection.ids.size'), 3);
    });
  });
});
