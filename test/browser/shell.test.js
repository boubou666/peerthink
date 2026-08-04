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
  };

  /** Click, then wait for the route or the DOM to actually catch up. */
  const clickAndWaitFor = async (sel, expression, label) => {
    await clickOn(sel);
    await page.waitFor(expression, { label });
  };

  const onCanvas = "Boolean(window.app?.store) && location.hash.startsWith('#/b/')";
  // Leaving a board is not just the list appearing — BoardCanvas's effect
  // cleanup has to have run too. Waiting on `.shell` alone lets an assertion
  // about teardown race a teardown that is still in flight.
  const onList =
    "Boolean(document.querySelector('.shell')) && !window.app && !document.querySelector('#stage')";
  const newBoard = () => clickAndWaitFor('[data-action="new-board"]', onCanvas, 'the new board to open');

  /**
   * Rename through the title field: focus, select the existing text, type over
   * it. The typing is real key input, so React's onChange drives the state —
   * assigning `.value` would not, now that the field is controlled.
   */
  const typeInBar = async (value) => {
    await page.eval(`(() => {
      const el = document.querySelector('.board-bar-title');
      el.focus();
      el.select();
    })()`);
    await page.type(value);
  };

  const renameInBar = async (value) => {
    await typeInBar(value);
    await page.eval(`document.querySelector('.board-bar-title').blur()`);
  };

  const hash = () => page.eval('location.hash');

  /**
   * "The page rendered" is not "the list is showing" — reading the boards is a
   * round trip, and so is re-reading them after a rename or a delete. Every
   * assertion about what is listed goes through here, so none of them can
   * catch the list mid-flight.
   */
  const listSettled = [
    "Boolean(document.querySelector('.shell'))",
    "!document.querySelector('[data-loading]')",
    "!document.querySelector('[data-busy]')",
  ].join(' && ');

  const settle = () => page.waitFor(listSettled, { label: 'the board list to settle' });

  const titles = async () => {
    await settle();
    return page.eval(`[...document.querySelectorAll('.board-card-title')].map(el => el.textContent)`);
  };

  const showsEmptyState = async () => {
    await settle();
    return page.eval(`document.querySelector('[data-empty]') !== null`);
  };

  /** Native dialogs would block the page, so answer them in JS. */
  const answerPrompt = (value) => page.eval(`window.prompt = () => ${JSON.stringify(value)};`);
  const answerConfirm = (value) => page.eval(`window.confirm = () => ${value};`);

  describe('board list', () => {
    test('starts empty and says so', async () => {
      assert.equal(await showsEmptyState(), true);
      assert.deepEqual(await titles(), []);
    });

    test('says nothing about being empty until the boards have been read', async () => {
      // "No boards yet" is a claim about the workspace. Making it while the
      // read is still in flight tells a user with boards that they have none.
      await page.goto(LIST_PATH);
      const seen = await page.eval(`(() => {
        const el = document.querySelector('.shell');
        return {
          empty: el?.querySelector('[data-empty]') !== null && el?.querySelector('[data-empty]') !== undefined,
          resolved: el?.querySelector('[data-loading]') === null,
        };
      })()`);

      // whichever side of the read this landed on, the two states are exclusive
      assert.equal(seen.empty && !seen.resolved, false, 'never both loading and empty');
      assert.equal(await showsEmptyState(), true, 'and it settles on empty');
    });

    test('New board creates one and opens it', async () => {
      await newBoard();

      assert.match(await hash(), /^#\/b\/.+/, 'navigated to the new board');
      assert.equal(await page.eval('Boolean(window.app?.store)'), true, 'the canvas mounted');
      assert.equal(await page.eval('app.store.order.length'), 0, 'a new board starts empty, not seeded');
    });

    test('a created board shows up in the list, with its id in the route', async () => {
      await newBoard();
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

      await clickAndWaitFor('[data-board-id="beta"] .board-card-open', onCanvas, 'board beta to open');
      assert.equal(await hash(), '#/b/beta');
      assert.equal(await page.eval('app.boardId'), 'beta');
    });

    test('rename updates the card and survives a reload', async () => {
      await newBoard();
      await page.goto(LIST_PATH);

      await answerPrompt('Q3 planning');
      await clickOn('[data-action="rename"]');
      assert.deepEqual(await titles(), ['Q3 planning']);

      await page.goto(LIST_PATH);
      assert.deepEqual(await titles(), ['Q3 planning']);
    });

    test('a cancelled or blank rename changes nothing', async () => {
      await newBoard();
      await page.goto(LIST_PATH);

      await page.eval('window.prompt = () => null;');
      await clickOn('[data-action="rename"]');
      assert.deepEqual(await titles(), ['Untitled board']);

      await answerPrompt('   ');
      await clickOn('[data-action="rename"]');
      assert.deepEqual(await titles(), ['Untitled board']);
    });

    test('a board that cannot be saved is reported, not opened', async () => {
      // navigating anyway would open a route with no stored record, which
      // createApp treats as a first visit — handing back a seeded board
      await page.eval(`(() => {
        window.__setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
      })()`);

      await clickOn('[data-action="new-board"]');
      await page.waitFor(`document.querySelector('[data-error]') !== null`, { label: 'the error to show' });

      assert.equal(await hash(), '#/', 'stayed on the list');
      assert.equal(await page.eval('Boolean(window.app)'), false, 'no canvas mounted');

      await page.eval('Storage.prototype.setItem = window.__setItem;');
    });

    test('delete asks first, and removes the board when confirmed', async () => {
      await newBoard();
      await page.goto(LIST_PATH);

      await answerConfirm(false);
      await clickOn('[data-action="delete"]');
      assert.deepEqual(await titles(), ['Untitled board'], 'declining keeps it');

      await answerConfirm(true);
      await clickOn('[data-action="delete"]');
      assert.deepEqual(await titles(), []);
      assert.equal(await showsEmptyState(), true);
    });
  });

  describe('board route', () => {
    test('the back link returns to the list and unmounts the canvas', async () => {
      await newBoard();
      assert.equal(await page.eval('Boolean(window.app)'), true);

      await clickAndWaitFor('.board-bar-back', onList, 'the list to come back');
      assert.equal(await hash(), '#/');
      assert.equal(await page.eval('Boolean(window.app)'), false, 'destroy ran on unmount');
      assert.equal(await page.eval(`document.querySelector('#stage') === null`), true);
    });

    test('the title in the bar renames the board', async () => {
      await newBoard();

      await renameInBar('Renamed from the bar');
      await page.waitFor(
        `(localStorage.getItem('peerthink:board:' + location.hash.replace('#/b/', '')) ?? '').includes('Renamed from the bar')`,
        { label: 'the rename to be written' },
      );

      await page.goto(LIST_PATH);
      assert.deepEqual(await titles(), ['Renamed from the bar']);
    });

    test('Enter commits the rename without a manual blur', async () => {
      await newBoard();

      await typeInBar('Committed with Enter');
      await page.key('Enter');
      await page.waitFor(
        `(localStorage.getItem('peerthink:board:' + location.hash.replace('#/b/', '')) ?? '').includes('Committed with Enter')`,
        { label: 'Enter to commit the rename' },
      );

      await page.goto(LIST_PATH);
      assert.deepEqual(await titles(), ['Committed with Enter']);
    });

    test('Escape abandons the edit instead of committing it', async () => {
      await newBoard();
      const key = `'peerthink:board:' + location.hash.replace('#/b/', '')`;

      await typeInBar('Typed then abandoned');
      assert.equal(
        await page.eval(`document.querySelector('.board-bar-title').value`),
        'Typed then abandoned',
        'the field really did take the text',
      );

      // Escape blurs, and blur commits — so this is the case where a cancelled
      // edit could still be persisted by the onBlur that Escape itself causes
      await page.key('Escape');
      await page.waitFor(
        `document.querySelector('.board-bar-title').value === 'Untitled board'`,
        { label: 'the field to snap back' },
      );

      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'force a save' })`);
      await page.eval('app.autosave.flush()');
      assert.equal(
        await page.eval(`JSON.parse(localStorage.getItem(${key})).title`),
        'Untitled board',
        'the abandoned title was never written',
      );

      await page.goto(LIST_PATH);
      assert.deepEqual(await titles(), ['Untitled board']);
    });

    test('renaming a seeded board that has never been stored still sticks', async () => {
      // a first visit seeds in memory; there is no record for rename() to
      // touch, and the next autosave would write the default name back
      await page.goto('/#/b/default');
      assert.equal(await page.eval('app.store.order.length'), 7, 'the starter board');
      assert.equal(await page.eval(`localStorage.getItem('peerthink:board:default')`), null, 'nothing stored yet');

      await renameInBar('Named before the first save');
      await page.waitFor(
        `(localStorage.getItem('peerthink:board:default') ?? '').includes('Named before the first save')`,
        { label: 'the rename to create the record' },
      );

      // let the debounced autosave run and confirm it did not clobber the name
      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'after rename' })`);
      await page.eval('app.autosave.flush()');
      assert.equal(
        await page.eval(`JSON.parse(localStorage.getItem('peerthink:board:default')).title`),
        'Named before the first save',
      );
    });

    test('the title follows the route when only the board id changes', async () => {
      await page.eval(`(() => {
        const board = { v: 1, order: [], objects: [] };
        localStorage.setItem('peerthink:board:one', JSON.stringify({ v: 1, id: 'one', title: 'Board One', updatedAt: 2, board }));
        localStorage.setItem('peerthink:board:two', JSON.stringify({ v: 1, id: 'two', title: 'Board Two', updatedAt: 1, board }));
      })()`);

      await page.goto('/#/b/one');
      assert.equal(await page.eval(`document.querySelector('.board-bar-title').value`), 'Board One');

      // in-place param change: the router reuses the component
      await page.eval(`location.hash = '#/b/two'`);
      await page.waitFor(`window.app?.boardId === 'two'`, { label: 'board two to mount' });
      assert.equal(await page.eval(`document.querySelector('.board-bar-title').value`), 'Board Two');
    });

    test('an unknown route falls back to the list', async () => {
      await page.goto('/#/nonsense');
      assert.equal(await hash(), '#/');
      assert.equal(await page.eval(`document.querySelector('.shell') !== null`), true);
    });
  });
});
