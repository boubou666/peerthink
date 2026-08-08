import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { LIST_PATH, answerAsk, dismissAsk, openApp } from '../helpers/browser.js';

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

  /**
   * Wait for the target before clicking it, rather than querying once.
   *
   * `goto` waits for `.shell`, and the account gate's "Loading…" screen is a
   * `.shell` too — so a navigation resolves while the gate is still up and the
   * page underneath has not rendered. Asserting on the first query turns that
   * ordinary gap into "no element matched", which is the shape every flake
   * this suite has thrown has had. Assertions about the list already go
   * through `settle()`; this is the same patience for the clicks between them.
   */
  const clickOn = async (sel) => {
    await page.waitFor(`document.querySelector(${JSON.stringify(sel)}) !== null`, {
      label: `element ${sel}`,
    });
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

  /**
   * The board's name, without the "New" badge that shares its element.
   *
   * The badge sits inside the title so that a long name wraps and takes it
   * along rather than colliding with something pinned to a corner — which
   * means `textContent` here would read "Alpha New" for a board this browser
   * has not shown yet. `firstChild` is the title's own text node.
   */
  const titles = async () => {
    await settle();
    return page.eval(
      `[...document.querySelectorAll('.board-card-title')].map(el => el.firstChild?.textContent ?? '')`,
    );
  };

  const showsEmptyState = async () => {
    await settle();
    return page.eval(`document.querySelector('[data-empty]') !== null`);
  };

  /** The question is a real dialog now: click first, then answer what appears. */
  const answerPrompt = (value) => answerAsk(page, value);
  const answerConfirm = () => answerAsk(page);

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

    /**
     * A board can turn up in the list with nothing having announced it: the
     * same account on a second device finds one it joined elsewhere, and an
     * owner may add a member directly, which the policies permit. The badge
     * says "you have not opened this here", which is the only claim this side
     * can actually make.
     */
    describe('a board that turned up', () => {
      const badges = () =>
        page.eval(`[...document.querySelectorAll('.board-card')]
          .filter((card) => card.querySelector('[data-new]'))
          .map((card) => card.dataset.boardId)`);

      /** Put a board in storage without this browser ever having shown it. */
      const plant = (id, title) => page.eval(`(() => {
        const board = { v: 1, order: [], objects: [] };
        localStorage.setItem('peerthink:board:${id}', JSON.stringify(
          { v: 1, id: '${id}', title: ${JSON.stringify(title)}, updatedAt: 3, board },
        ));
      })()`);

      test('is marked, and the ones already here are not', async () => {
        await newBoard();
        await page.goto(LIST_PATH);
        await settle();
        assert.deepEqual(await badges(), [], 'a board this browser made was called new');

        await plant('gamma', 'From somebody else');
        await page.goto(LIST_PATH);
        await settle();

        assert.deepEqual(await badges(), ['gamma']);
      });

      test('stops being marked once it is opened', async () => {
        await newBoard();
        await page.goto(LIST_PATH);
        await settle();

        await plant('gamma', 'From somebody else');
        await page.goto(LIST_PATH);
        await settle();
        assert.deepEqual(await badges(), ['gamma']);

        await clickAndWaitFor('[data-board-id="gamma"] .board-card-open', onCanvas, 'the board to open');
        await page.goto(LIST_PATH);
        await settle();

        assert.deepEqual(await badges(), [], 'opening a board did not clear its badge');
      });

      test('the first look at a workspace marks nothing', async () => {
        /**
         * Everything already there is the workspace, not news. This is the
         * visit where the badge would be loudest and least useful.
         *
         * The reload before the clear is what makes that testable. `settle()`
         * answers once the shell is up with nothing loading, and the account
         * gate renders *inside* the shell — so a list can still be on its way
         * when the previous test finishes, and the record it seeds can land
         * after the clear below. Then this workspace is not a first look any
         * more, both planted boards are news, and the run that catches it is
         * whichever one was slow enough. Navigating first unloads the document
         * that would have written it.
         */
        await page.goto(LIST_PATH);
        await settle();

        await page.eval('localStorage.clear()');
        await plant('alpha', 'Alpha');
        await plant('beta', 'Beta');
        await page.goto(LIST_PATH);
        await settle();

        // Both are planted at the same `updatedAt`, so this is the tiebreak
        // rather than the recency: id descending, which is the order the
        // server-backed list pages in and the reason a keyset walk over a tie
        // cannot skip a board. It used to come out in whatever order storage
        // happened to enumerate.
        assert.deepEqual(await titles(), ['Beta', 'Alpha']);
        assert.deepEqual(await badges(), []);
      });
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

      await clickOn('[data-action="rename"]');
      await answerPrompt('Q3 planning');
      assert.deepEqual(await titles(), ['Q3 planning']);

      await page.goto(LIST_PATH);
      assert.deepEqual(await titles(), ['Q3 planning']);
    });

    test('a cancelled or blank rename changes nothing', async () => {
      await newBoard();
      await page.goto(LIST_PATH);

      await clickOn('[data-action="rename"]');
      await dismissAsk(page);
      assert.deepEqual(await titles(), ['Untitled board']);

      /**
       * A name of nothing but spaces cannot be submitted at all now — the
       * dialog disables its own confirming button rather than taking the click
       * and discarding the answer, which is what the old prompt did.
       */
      await clickOn('[data-action="rename"]');
      await page.eval(`(() => {
        const el = document.querySelector('[data-ask-field]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, '   ');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      assert.equal(
        await page.eval(`document.querySelector('[data-action="ask-confirm"]').disabled`),
        true,
        'a blank name could be submitted',
      );

      await dismissAsk(page);
      assert.deepEqual(await titles(), ['Untitled board']);
    });

    /**
     * `aria-modal` says a dialog is modal; it does nothing to the tab order.
     * Without a trap the next Tab walks into the page behind — and where the
     * question is asked from inside another dialog, the first thing out there
     * is that dialog's close button.
     *
     * What is asserted is the wrap itself, at both ends. "Focus is still
     * somewhere inside" is too weak: a trap that simply refused to move would
     * satisfy it, and so would one that parked on the last control for ever.
     */
    test('tabbing wraps at both ends instead of leaving the question', async () => {
      await newBoard();
      await page.goto(LIST_PATH);
      await clickOn('[data-action="rename"]');
      await page.waitFor(`Boolean(document.querySelector('[data-ask]'))`, { label: 'the question' });

      // Discovered rather than hard-coded: what is tabbable depends on the
      // kind of question and on whether its confirming button is disabled.
      const STOPS = `[...document.querySelectorAll(
        '[data-ask] form button:not([disabled]), [data-ask] form input:not([disabled])')]`;
      const NAME = `((el) => el?.dataset?.action ?? el?.tagName ?? null)`;

      const stops = await page.eval(`${STOPS}.map(${NAME})`);
      assert.ok(stops.length >= 2, `expected more than one stop to wrap between, got ${stops}`);

      const focused = () => page.eval(`${NAME}(document.activeElement)`);
      const focusStop = (i) => page.eval(`${STOPS}.at(${i}).focus()`);

      // Forward off the end comes back to the beginning.
      await focusStop(-1);
      assert.equal(await focused(), stops[stops.length - 1], 'could not reach the last stop');
      await page.key('Tab', { vk: 9 });
      const afterTab = await focused();
      assert.equal(afterTab, stops[0], `Tab off the end went to ${afterTab}, not ${stops[0]}`);

      // And backwards off the beginning goes to the end.
      await focusStop(0);
      assert.equal(await focused(), stops[0], 'could not reach the first stop');
      await page.key('Tab', { vk: 9, modifiers: 8 });
      const afterShiftTab = await focused();
      assert.equal(
        afterShiftTab,
        stops[stops.length - 1],
        `Shift+Tab off the front went to ${afterShiftTab}, not ${stops[stops.length - 1]}`,
      );

      await dismissAsk(page);
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

      await clickOn('[data-action="delete"]');
      await dismissAsk(page);
      assert.deepEqual(await titles(), ['Untitled board'], 'declining keeps it');

      await clickOn('[data-action="delete"]');
      await answerConfirm();
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
      // The toolbar is React's now rather than createApp's, so leaving the
      // route is what takes it away — nothing in destroy() removes it.
      assert.equal(await page.eval(`document.querySelector('#toolbar') === null`), true);
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
      // The `*` route lives inside RequireAccount (see App.jsx), so nothing
      // redirects until the gate lets the routes mount — and `goto` returns on
      // `.shell`, which the gate's own "Loading…" screen is one of. Reading
      // the hash straight after the navigation reads it before the router has
      // had its turn, which is a pass on a fast machine and a flake on a
      // loaded one.
      await page.waitFor("location.hash === '#/'", {
        label: 'the unknown route to redirect to the list',
      });
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
      window.__setItem ??= Storage.prototype.setItem;
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

      // Both in one turn of the event loop. Asserting that the record is
      // *absent* between the edit and the event would be a race against the
      // debounce dressed up as a precondition — this way no timer can fire
      // in between, so the write that lands is provably the one `pagehide`
      // asked for rather than the debounce getting there first.
      await page.eval(`(() => {
        app.board.add('card', { x: 0, y: 0, text: 'unsaved when the tab went' });
        window.dispatchEvent(new Event('pagehide'));
      })()`);

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
     * The contract is that a repository answers rather than throws, with one
     * carve-out both implementations now use: `list()` rejects when the store
     * would not answer, because an empty list reads as "you have no boards"
     * and a failed read has not earned that. So the first test below drives a
     * path the shipped code really takes.
     *
     * The others do not — no implementation rejects from `save` or `remove` —
     * and they stay because the page used to be written as though none of this
     * could happen: a rejected call left "Loading…" on screen for good and an
     * unhandled rejection in the console.
     *
     * Patching is how both get exercised here. The repository is a module
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

      /**
       * The board route reads twice — the canvas loads the document, the bar
       * loads its name — and both used to treat a failed read as an answer.
       * The bar's was the quieter half: the component is reused when only
       * :boardId changes, so a failed read left the *previous* board's title
       * sitting over this one.
       */
      test('a board whose read failed is not labelled with the last one\'s name', async () => {
        await page.eval(`(() => {
          const board = { v: 1, order: [], objects: [] };
          localStorage.setItem('peerthink:board:one', JSON.stringify({ v: 1, id: 'one', title: 'Board One', updatedAt: 2, board }));
          localStorage.setItem('peerthink:board:two', JSON.stringify({ v: 1, id: 'two', title: 'Board Two', updatedAt: 1, board }));
        })()`);

        await page.goto('/#/b/one');
        assert.equal(await page.eval(`document.querySelector('.board-bar-title').value`), 'Board One');

        await reject('load');
        await page.eval(`location.hash = '#/b/two'`);
        await page.waitFor(`window.app?.boardId === 'two'`, { label: 'board two to mount' });

        await page.waitFor(
          `document.querySelector('[data-save-status="unloaded"]') !== null`,
          { label: 'the board to stop claiming it is stored' },
        );
        assert.equal(
          await page.eval(`document.querySelector('.board-bar-title').value`),
          'Untitled board',
          'wore the previous board\'s name',
        );

        await unpatch('load');
      });

      /**
       * The title read resolves into the field, so it has to lose to the
       * person using it. A failure is the sharp case: it arrives as fast as
       * the request can fail, which is easily mid-word, where a slow success
       * at least tends to land before anyone has typed.
       */
      test('a read that fails mid-keystroke does not take the name being typed', async () => {
        await newBoard();
        await backToList();

        // Held open rather than timed out. A read that fails on a timer can
        // fail before the typing starts, and then the typing simply overwrites
        // the reset field — the assertion below would hold whether or not the
        // guard exists. Keeping the rejection in hand is what puts it
        // *after* the keystrokes, which is the only ordering that tests
        // anything.
        await patch('load', `() => new Promise((_, no) => { (window.__loads ??= []).push(no); })`);
        await clickAndWaitFor('.board-card-open', onCanvas, 'the board to open');

        await typeInBar('Named during a failing read');
        await page.waitFor(
          `document.querySelector('.board-bar-title').value === 'Named during a failing read'`,
          { label: 'the name to be typed' },
        );

        await page.eval(`(() => {
          const waiting = window.__loads ?? [];
          window.__loads = [];
          waiting.forEach((no) => no(new Error('offline')));
        })()`);

        await page.waitFor(
          `document.querySelector('[data-save-status="unloaded"]') !== null`,
          { label: 'the failed read to land' },
        );

        assert.equal(
          await page.eval(`document.querySelector('.board-bar-title').value`),
          'Named during a failing read',
          'the failure reset a field the user was typing in',
        );

        // Abandon the edit rather than leaving it half-made: unmounting the
        // field blurs it, and blur commits, so a test that walked away here
        // would rename this board from inside the next one.
        await page.key('Escape');
        await unpatch('load');

        // Any read taken out after the drain above is still being held; left
        // pending it would outlive this test attached to a torn-down page.
        await page.eval(`(() => {
          const waiting = window.__loads ?? [];
          window.__loads = [];
          waiting.forEach((no) => no(new Error('offline')));
        })()`);
      });

      test('a failed change says nothing was changed', async () => {
        await newBoard();
        await backToList();
        await reject('remove');

        await clickOn('[data-action="delete"]');
        await answerConfirm();
        await page.waitFor(`document.querySelector('[data-error]') !== null`, {
          label: 'the failed delete to be reported',
        });

        await unpatch('remove');
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
