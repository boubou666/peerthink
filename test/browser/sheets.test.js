// Several named canvases on one board, and the strip that moves between them.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';
import { answerAsk, clickSelector, dismissAsk } from '../helpers/browser.js';

describe('sheets', () => {
  let page;

  before(async () => { page = await openApp(); });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  /**
   * A fresh board each time, and off the board route before clearing.
   *
   * A canvas that is still mounted when the document goes away flushes on the
   * way out, which lands *after* a clear and hands the next page the last
   * test's board — sheets and all. `main.test.js` met this first; here it is
   * the difference between one sheet and five.
   */
  beforeEach(async () => {
    await page.goto('/#/');
    await page.eval('localStorage.clear()');
    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
    // A first visit seeds the starter board; these tests are about what is put
    // on a sheet, so the sheet starts empty.
    await page.eval('app.store.load({ v: 1, order: [], objects: [] })');
  });

  const tabs = () => page.eval(`[...document.querySelectorAll('[data-sheet-tabs] .sheet-name')].map((el) => el.textContent)`);
  const current = () => page.eval(`document.querySelector('[data-sheet-tabs] .sheet-tab[data-current] .sheet-name').textContent`);
  const objectIds = () => page.eval('app.store.order');

  const addCard = (text) =>
    page.eval(`app.board.add('card', { x: 200, y: 200, text: ${JSON.stringify(text)} }).id`);

  /** Click a tab by the name on it. */
  const clickTab = async (name) => {
    const found = await page.eval(`(() => {
      const el = [...document.querySelectorAll('[data-sheet-tabs] .sheet-name')].find((t) => t.textContent === ${JSON.stringify(name)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    })()`);
    assert.ok(found, `no tab called ${name}`);
    await page.click(found.cx, found.cy);
  };

  const openMenu = async () => {
    await clickSelector(page, '[data-sheet-tabs] [data-action="sheet-menu"]');
    await page.waitFor(`document.querySelector('[data-sheet-tabs] .sheet-menu') !== null`, { label: 'the sheet menu' });
  };

  test('a board opens with one sheet', async () => {
    assert.deepEqual(await tabs(), ['Sheet 1']);
    assert.equal(await current(), 'Sheet 1');
  });

  test('adding one shows it, empty, and the first is still there', async () => {
    const first = await addCard('on the first');
    await clickSelector(page, '[data-sheet-tabs] [data-action="add-sheet"]');
    await page.waitFor(`document.querySelectorAll('[data-sheet-tabs] .sheet-name').length === 2`, {
      label: 'the second tab',
    });

    assert.deepEqual(await tabs(), ['Sheet 1', 'Sheet 2']);
    assert.equal(await current(), 'Sheet 2');
    assert.deepEqual(await objectIds(), [], 'the new sheet came up with the old one\'s objects');

    // Waited for rather than asserted: the store changes on the click and the
    // renderer catches up on a frame, so reading the DOM straight afterwards
    // is a race that passes on a fast machine.
    await page.waitFor(`document.querySelector('[data-id="${first}"]') === null`, {
      label: 'the first sheet to stop being drawn',
    });

    await clickTab('Sheet 1');
    assert.deepEqual(await objectIds(), [first], 'the first sheet did not come back');
  });

  test('what is on a sheet is drawn only while that sheet is up', async () => {
    const first = await addCard('first');
    await clickSelector(page, '[data-sheet-tabs] [data-action="add-sheet"]');
    const second = await addCard('second');

    await page.waitFor(`document.querySelector('[data-id="${second}"]') !== null`, { label: 'the second card' });
    assert.equal(await page.eval(`document.querySelector('[data-id="${first}"]') === null`), true);

    await clickTab('Sheet 1');
    await page.waitFor(`document.querySelector('[data-id="${first}"]') !== null`, { label: 'the first card' });
    assert.equal(await page.eval(`document.querySelector('[data-id="${second}"]') === null`), true);
  });

  /** Undo belongs to the sheet you are looking at. */
  test('undo does not reach back into another sheet', async () => {
    const first = await addCard('first');
    await clickSelector(page, '[data-sheet-tabs] [data-action="add-sheet"]');
    await addCard('second');

    await page.eval('app.store.undo()');
    assert.deepEqual(await objectIds(), [], 'undo on the second sheet did not undo its own edit');

    await page.eval('app.store.undo()');
    await clickTab('Sheet 1');
    assert.deepEqual(await objectIds(), [first], 'undo walked back into the other sheet');
  });

  test('a switch clears the selection, so the delete key cannot reach off screen', async () => {
    const first = await addCard('first');
    await page.eval(`app.selection.set(["${first}"])`);

    await clickSelector(page, '[data-sheet-tabs] [data-action="add-sheet"]');
    await page.waitFor(`document.querySelectorAll('[data-sheet-tabs] .sheet-name').length === 2`, {
      label: 'the sheet to be added',
    });
    assert.equal(await page.eval('app.selection.size'), 0);
  });

  describe('the menu', () => {
    test('renames through the dialog', async () => {
      await openMenu();
      await clickSelector(page, '[data-action="rename-sheet"]');
      await answerAsk(page, 'Discovery');

      await page.waitFor(`document.querySelector('[data-sheet-tabs] .sheet-name').textContent === 'Discovery'`, {
        label: 'the tab to be renamed',
      });
      assert.deepEqual(await tabs(), ['Discovery']);
    });

    test('a rename that is cancelled changes nothing', async () => {
      await openMenu();
      await clickSelector(page, '[data-action="rename-sheet"]');
      await dismissAsk(page);
      assert.deepEqual(await tabs(), ['Sheet 1']);
    });

    test('duplicates the sheet, with its own copies of the objects', async () => {
      const first = await addCard('copy me');
      await openMenu();
      await clickSelector(page, '[data-action="duplicate-sheet"]');

      await page.waitFor(`document.querySelectorAll('[data-sheet-tabs] .sheet-name').length === 2`, {
        label: 'the copy',
      });
      assert.deepEqual(await tabs(), ['Sheet 1', 'Sheet 1 (copy)']);
      assert.equal(await current(), 'Sheet 1 (copy)');

      const copied = await objectIds();
      assert.equal(copied.length, 1);
      assert.notEqual(copied[0], first, 'the copy shares an object with its original');
      assert.equal(await page.eval(`app.store.get(${JSON.stringify(copied[0])}).text`), 'copy me');
    });

    test('deletes, after asking', async () => {
      await clickSelector(page, '[data-sheet-tabs] [data-action="add-sheet"]');
      await openMenu();
      await clickSelector(page, '[data-action="delete-sheet"]');
      await answerAsk(page);

      await page.waitFor(`document.querySelectorAll('[data-sheet-tabs] .sheet-name').length === 1`, {
        label: 'the sheet to go',
      });
      assert.deepEqual(await tabs(), ['Sheet 1']);
    });

    test('a deletion that is turned down keeps the sheet', async () => {
      await clickSelector(page, '[data-sheet-tabs] [data-action="add-sheet"]');
      await openMenu();
      await clickSelector(page, '[data-action="delete-sheet"]');
      await dismissAsk(page);
      assert.deepEqual(await tabs(), ['Sheet 1', 'Sheet 2']);
    });

    /** A board with no sheets has no canvas, so there is nothing to offer. */
    test('the last sheet has no delete to offer', async () => {
      await openMenu();
      assert.equal(
        await page.eval(`document.querySelector('[data-action="delete-sheet"]') === null`),
        true,
        'the only sheet was offered a delete',
      );
    });

    /**
     * The menu is placed once, from the button's box, and drawn fixed. A wheel
     * over the strip moves the button without any pointer going down, so the
     * dismissal listeners never hear about it and the menu is left pointing at
     * where the tab used to be.
     */
    test('closes when the strip scrolls under it', async () => {
      await openMenu();
      await page.eval(`(() => {
        const strip = document.querySelector('[data-sheet-tabs]');
        strip.scrollLeft = 40;
        strip.dispatchEvent(new Event('scroll'));
      })()`);

      await page.waitFor(`document.querySelector('[data-sheet-tabs] .sheet-menu') === null`, {
        label: 'the menu to close',
      });
    });

    test('closes on Escape, leaving the selection alone', async () => {
      const first = await addCard('first');
      await page.eval(`app.selection.set(["${first}"])`);

      await openMenu();
      await page.key('Escape', { code: 'Escape', vk: 27 });
      await page.waitFor(`document.querySelector('[data-sheet-tabs] .sheet-menu') === null`, {
        label: 'the menu to close',
      });
      assert.equal(await page.eval('app.selection.size'), 1, 'Escape reached the canvas behind the menu');
    });
  });

  test('sheets survive a reload, contents and names', async () => {
    await addCard('on the first');
    await clickSelector(page, '[data-sheet-tabs] [data-action="add-sheet"]');
    const second = await addCard('on the second');

    await page.waitFor(`(localStorage.getItem('peerthink:board:default') ?? '').includes('on the second')`, {
      label: 'the debounced save to land',
    });

    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });

    assert.deepEqual(await tabs(), ['Sheet 1', 'Sheet 2'], 'the sheets did not come back');
    assert.equal(await current(), 'Sheet 1', 'it came back on a sheet other than the first');

    await clickTab('Sheet 2');
    assert.deepEqual(await objectIds(), [second]);
  });

  /**
   * The board a stale tab reads. `isBoard` wants these two arrays, and a
   * document without them is read as a board that is not there — which the app
   * answers by seeding a starter board over the top of it.
   */
  test('what is stored keeps a board where a board has always been', async () => {
    await addCard('on the first');
    await clickSelector(page, '[data-sheet-tabs] [data-action="add-sheet"]');
    await addCard('on the second');

    await page.waitFor(`(localStorage.getItem('peerthink:board:default') ?? '').includes('on the second')`, {
      label: 'the debounced save to land',
    });

    const stored = await page.eval(`JSON.parse(localStorage.getItem('peerthink:board:default')).board`);
    assert.equal(stored.v, 2);
    assert.equal(stored.sheets.length, 2);
    assert.ok(Array.isArray(stored.order) && Array.isArray(stored.objects), 'no board at the top level');
    assert.deepEqual(stored.order, stored.sheets[0].order, 'the top level is not the first sheet');
  });

  /** Every board that exists was written before sheets did. */
  test('a board from before sheets opens as one sheet', async () => {
    // Off the board route before planting it, for the reason `beforeEach`
    // gives: the canvas is still mounted and sitting on a debounced save, and
    // one that lands after this write replaces the v1 document with a v2 one.
    await page.goto('/#/');
    await page.eval(`localStorage.setItem('peerthink:board:default', JSON.stringify({
      v: 1,
      id: 'default',
      title: 'Old board',
      updatedAt: 1,
      board: { v: 1, order: ['old'], objects: [{ id: 'old', type: 'card', x: 0, y: 0, w: 200, h: 120, text: 'from before' }] },
    }))`);

    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });

    assert.deepEqual(await tabs(), ['Sheet 1']);
    assert.deepEqual(await objectIds(), ['old'], 'the old board did not become the first sheet');
  });
});
