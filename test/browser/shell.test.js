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

  /**
   * This suite is about the Web Storage build, and a Vite dev server reads
   * `.env.local` — so a developer who has run the app against a local stack
   * would silently be testing the Supabase one instead, and every assertion
   * here about localStorage would be about the wrong thing. test/run.js blanks
   * the variables for this origin; this is what notices if it stops.
   */
  test('this origin is the build with no project behind it', async () => {
    assert.equal(
      await page.eval(`Boolean(document.querySelector('[data-account-gate], .account-menu, [data-action="share"]'))`),
      false,
      'the plain origin is serving a Supabase build',
    );
  });

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

  /**
   * Whether the board is stored, said out loud.
   *
   * All of this was already known to the autosave and told to nobody: a
   * refused write left the document dirty behind a bar that looked exactly
   * like a saved one, and the edits inside the debounce went with the tab.
   */
  describe('saving', () => {
    const key = `'peerthink:board:' + location.hash.replace('#/b/', '')`;
    const saveState = () => page.eval(`document.querySelector('.save-state')?.dataset.saveStatus ?? null`);
    const stored = () => page.eval(`localStorage.getItem(${key}) ?? ''`);
    const settled = (status) =>
      page.waitFor(`document.querySelector('.save-state')?.dataset.saveStatus === '${status}'`, {
        label: `the board to report ${status}`,
      });

    const breakStorage = () => page.eval(`(() => {
      window.__setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    })()`);
    const fixStorage = () => page.eval('Storage.prototype.setItem = window.__setItem;');

    test('an edit is reported until it is stored', async () => {
      await newBoard();
      assert.equal(await saveState(), 'saved', 'a board nobody has touched');

      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'reported' })`);
      assert.match(
        await page.eval(`document.querySelector('.save-state').textContent`),
        /^Saving/,
        'the edit was not acknowledged',
      );

      await settled('saved');
      assert.match(await stored(), /reported/, 'said saved without saving');
    });

    test('a write that does not land is not reported as one that did', async () => {
      await newBoard();
      await breakStorage();

      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'never landed' })`);
      await settled('failed');

      assert.match(
        await page.eval(`document.querySelector('.save-state').textContent`),
        /Unsaved changes/,
      );
      assert.equal(await page.eval('app.store.order.length'), 1, 'the work is still on the canvas');
      assert.doesNotMatch(await stored(), /never landed/, 'it claimed to fail and wrote anyway');

      // and the way out is on screen, rather than a wait for the backoff
      await fixStorage();
      await clickOn('.save-state [data-action="retry-save"]');
      await settled('saved');
      assert.match(await stored(), /never landed/);
    });

    test('closing the tab writes what the debounce is still holding', async () => {
      await newBoard();
      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'unsaved when the tab went' })`);
      assert.doesNotMatch(await stored(), /unsaved when the tab went/, 'the debounce had already fired');

      // no wait, no settle: the write has to have landed by the time the
      // handler returns, because a page on its way out runs nothing after it
      await page.eval(`window.dispatchEvent(new Event('pagehide'))`);
      assert.match(await stored(), /unsaved when the tab went/, 'the last edits went with the tab');
    });

    test('a board left alone with a failed write keeps trying on its own', async () => {
      await newBoard();
      await breakStorage();

      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'retried unattended' })`);
      await settled('failed');

      // nothing touches the board from here — no edit, no click, no reload
      await fixStorage();
      await settled('saved');
      assert.match(await stored(), /retried unattended/);
    });

    /**
     * Both repositories answer rather than throw — that is the contract, and
     * both of them keep it. It is still only a promise made in a comment, and
     * the page above it used to be written as though it could not be broken:
     * a rejected read left "Loading…" on screen for good and an unhandled
     * rejection in the console.
     *
     * Patching the shell's repository is the only way to see that, precisely
     * because no shipped implementation does it. The object is a module
     * singleton, so replacing a method on it is what the page is holding.
     */
    describe('a repository that rejects', () => {
      const patch = (method, body) => page.eval(`(async () => {
        const mod = await import('/src/shell/storage.js');
        window.__real ??= {};
        window.__real['${method}'] ??= mod.repository['${method}'].bind(mod.repository);
        mod.repository['${method}'] = ${body};
      })()`);

      const unpatch = (method) => page.eval(`(async () => {
        const mod = await import('/src/shell/storage.js');
        mod.repository['${method}'] = window.__real['${method}'];
      })()`);

      const reject = (method) => patch(method, `() => Promise.reject(new Error('offline'))`);

      /** Reach the list without a reload, which would undo the patch. */
      const backToList = () => clickAndWaitFor('.board-bar-back', onList, 'the list to come back');

      test('a failed read is reported rather than shown as an empty workspace', async () => {
        await newBoard();
        await reject('list');
        await backToList();

        await page.waitFor(`document.querySelector('[data-error]') !== null`, {
          label: 'the failed read to be reported',
        });
        assert.equal(
          await page.eval(`document.querySelector('[data-loading]') !== null`),
          false,
          'still loading, forever',
        );
        assert.equal(
          await page.eval(`document.querySelector('[data-empty]') !== null`),
          false,
          'told someone with boards that they have none',
        );

        await unpatch('list');
        await clickOn('[data-action="retry-list"]');
        await settle();
        assert.deepEqual(await titles(), ['Untitled board']);
        assert.equal(await page.eval(`document.querySelector('[data-error]') === null`), true);
      });

      test('a failed change says nothing was changed', async () => {
        await newBoard();
        await backToList();
        await reject('remove');

        await answerConfirm(true);
        await clickOn('[data-action="delete"]');
        await page.waitFor(`document.querySelector('[data-error]') !== null`, {
          label: 'the failed delete to be reported',
        });

        await unpatch('remove');
        await page.eval(`document.querySelector('[data-error]')?.textContent`);
        assert.deepEqual(await titles(), ['Untitled board'], 'and the board is still there');
      });

      test('a board that could not be created is reported, not opened', async () => {
        await reject('save');
        await clickOn('[data-action="new-board"]');
        await page.waitFor(`document.querySelector('[data-error]') !== null`, {
          label: 'the failed create to be reported',
        });

        assert.equal(await hash(), '#/', 'stayed on the list');
        assert.equal(await page.eval('Boolean(window.app)'), false, 'no canvas mounted');
        await unpatch('save');
      });
    });
  });
});
