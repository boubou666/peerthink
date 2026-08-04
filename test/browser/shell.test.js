import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { LIST_PATH, openApp } from '../helpers/browser.js';

/**
 * The React shell: routing, the board list, and the hand-off to the canvas.
 * Everything here is driven through the rendered UI rather than the app
 * object, because the point of this layer is what a user can reach.
 */
describe('shell', () => {
  let page;

  before(async () => {
    page = await openApp({ path: LIST_PATH });
  });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  beforeEach(async () => {
    await page.eval('localStorage.clear()');
    await page.goto(LIST_PATH);
  });

  const boxOf = (sel) => page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  })()`);

  const clickOn = async (sel) => {
    const box = await boxOf(sel);
    assert.ok(box, `no element matched ${sel}`);
    await page.click(box.cx, box.cy);
    await page.sleep(120);
  };

  const hash = () => page.eval('location.hash');
  const titles = () => page.eval(`[...document.querySelectorAll('.board-card-title')].map(el => el.textContent)`);

  /** Native dialogs would block the page, so answer them in JS. */
  const answerPrompt = (value) => page.eval(`window.prompt = () => ${JSON.stringify(value)};`);
  const answerConfirm = (value) => page.eval(`window.confirm = () => ${value};`);

  describe('board list', () => {
    test('starts empty and says so', async () => {
      assert.equal(await page.eval(`document.querySelector('[data-empty]') !== null`), true);
      assert.deepEqual(await titles(), []);
    });

    test('New board creates one and opens it', async () => {
      await clickOn('[data-action="new-board"]');
      await page.sleep(400);

      assert.match(await hash(), /^#\/b\/.+/, 'navigated to the new board');
      assert.equal(await page.eval('Boolean(window.app?.store)'), true, 'the canvas mounted');
      assert.equal(await page.eval('app.store.order.length'), 0, 'a new board starts empty, not seeded');
    });

    test('a created board shows up in the list, with its id in the route', async () => {
      await clickOn('[data-action="new-board"]');
      await page.sleep(400);
      const id = (await hash()).replace('#/b/', '');

      await page.goto(LIST_PATH);
      assert.deepEqual(await titles(), ['Untitled board']);
      assert.equal(await page.eval(`document.querySelector('[data-board-id="${id}"]') !== null`), true);
      assert.equal(await page.eval('window.app?.boardId ?? null'), null, 'no canvas on the list route');
    });

    test('clicking a card opens that board', async () => {
      await page.eval(`(() => {
        const board = { v: 1, order: [], objects: [] };
        localStorage.setItem('peerthink:board:alpha', JSON.stringify({ v: 1, id: 'alpha', title: 'Alpha', updatedAt: 2, board }));
        localStorage.setItem('peerthink:board:beta', JSON.stringify({ v: 1, id: 'beta', title: 'Beta', updatedAt: 1, board }));
      })()`);
      await page.goto(LIST_PATH);

      assert.deepEqual(await titles(), ['Alpha', 'Beta'], 'newest first');

      await clickOn('[data-board-id="beta"] .board-card-open');
      await page.sleep(400);
      assert.equal(await hash(), '#/b/beta');
      assert.equal(await page.eval('app.boardId'), 'beta');
    });

    test('rename updates the card and survives a reload', async () => {
      await clickOn('[data-action="new-board"]');
      await page.sleep(400);
      await page.goto(LIST_PATH);

      await answerPrompt('Q3 planning');
      await clickOn('[data-action="rename"]');
      assert.deepEqual(await titles(), ['Q3 planning']);

      await page.goto(LIST_PATH);
      assert.deepEqual(await titles(), ['Q3 planning']);
    });

    test('a cancelled or blank rename changes nothing', async () => {
      await clickOn('[data-action="new-board"]');
      await page.sleep(400);
      await page.goto(LIST_PATH);

      await page.eval('window.prompt = () => null;');
      await clickOn('[data-action="rename"]');
      assert.deepEqual(await titles(), ['Untitled board']);

      await answerPrompt('   ');
      await clickOn('[data-action="rename"]');
      assert.deepEqual(await titles(), ['Untitled board']);
    });

    test('delete asks first, and removes the board when confirmed', async () => {
      await clickOn('[data-action="new-board"]');
      await page.sleep(400);
      await page.goto(LIST_PATH);

      await answerConfirm(false);
      await clickOn('[data-action="delete"]');
      assert.deepEqual(await titles(), ['Untitled board'], 'declining keeps it');

      await answerConfirm(true);
      await clickOn('[data-action="delete"]');
      assert.deepEqual(await titles(), []);
      assert.equal(await page.eval(`document.querySelector('[data-empty]') !== null`), true);
    });
  });

  describe('board route', () => {
    test('the back link returns to the list and unmounts the canvas', async () => {
      await clickOn('[data-action="new-board"]');
      await page.sleep(400);
      assert.equal(await page.eval('Boolean(window.app)'), true);

      await clickOn('.board-bar-back');
      await page.sleep(200);
      assert.equal(await hash(), '#/');
      assert.equal(await page.eval('Boolean(window.app)'), false, 'destroy ran on unmount');
      assert.equal(await page.eval(`document.querySelector('#stage') === null`), true);
    });

    test('the title in the bar renames the board', async () => {
      await clickOn('[data-action="new-board"]');
      await page.sleep(400);

      await page.eval(`(() => {
        const input = document.querySelector('.board-bar-title');
        input.focus();
        input.value = 'Renamed from the bar';
        input.blur();
      })()`);
      await page.sleep(150);

      await page.goto(LIST_PATH);
      assert.deepEqual(await titles(), ['Renamed from the bar']);
    });

    test('an unknown route falls back to the list', async () => {
      await page.goto('/#/nonsense');
      assert.equal(await hash(), '#/');
      assert.equal(await page.eval(`document.querySelector('.shell') !== null`), true);
    });
  });
});
