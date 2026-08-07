import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { LIST_PATH, openApp, supabaseOrigin } from '../helpers/browser.js';

/**
 * The shell, with its boards in Postgres.
 *
 * The repository contract is covered against the database in
 * test/node/supabase-repository.test.js. What is left — and what only a
 * browser can answer — is whether the shell picked that repository at all,
 * and whether the round trip actually survives a reload: a board list that
 * reads from the server, a canvas whose autosave lands there, and a workspace
 * that is empty again for the next person to sign in.
 *
 * No stack, no suite; test/run.js says so on the way past.
 */
const origin = supabaseOrigin();

const SETTLED = [
  "Boolean(document.querySelector('.shell-header'))",
  "!document.querySelector('[data-loading]')",
  "!document.querySelector('[data-busy]')",
].join(' && ');

const ON_CANVAS = "Boolean(window.app?.store) && location.hash.startsWith('#/b/')";

describe('boards on supabase', { skip: origin ? false : 'no local supabase (npx supabase start)' }, () => {
  let page;

  before(async () => {
    page = await openApp({ path: LIST_PATH, origin, readyWhen: SETTLED });
  });

  after(async () => {
    const expected = /Failed to load resource.*status of 400/;
    const errors = page.errors.filter((e) => !expected.test(e));
    await page.close();
    assert.deepEqual(errors, [], 'the page logged errors');
  });

  /**
   * A cleared session is a new anonymous user, which is the cleanest empty
   * workspace available: the previous test's boards still exist, they just
   * belong to someone else now. That is also the isolation being tested.
   */
  beforeEach(async () => {
    await page.eval('localStorage.clear()');
    await page.goto(LIST_PATH, { ready: SETTLED });
  });

  /** Click a selector on any page — the owner's, or somebody else's. */
  const clickIn = async (target, selector) => {
    const box = await target.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    })()`);
    assert.ok(box, `no element matched ${selector}`);
    await target.click(box.cx, box.cy);
  };

  const click = (selector) => clickIn(page, selector);

  const settle = () => page.waitFor(SETTLED, { label: 'the board list to settle' });

  const titles = async () => {
    await settle();
    return page.eval(`[...document.querySelectorAll('.board-card-title')].map(el => el.textContent)`);
  };

  const newBoard = async () => {
    await click('[data-action="new-board"]');
    await page.waitFor(ON_CANVAS, { label: 'the new board to open' });
    return page.eval('window.app.boardId');
  };

  test('a new board starts an empty workspace and is listed on the way back', async () => {
    assert.deepEqual(await titles(), [], 'a fresh account already had boards');

    await newBoard();
    await page.goto(LIST_PATH, { ready: SETTLED });

    assert.deepEqual(await titles(), ['Untitled board']);
  });

  /**
   * The end-to-end one: an edit on the canvas, flushed through autosave to
   * Postgres, and still there after a reload that shares nothing with the
   * previous page but the session.
   */
  test('an edit survives a reload, because it was written to the server', async () => {
    const id = await newBoard();

    await page.eval(`window.app.board.add('card', { x: 40, y: 40, text: 'from the server' })`);

    // The canvas is usable before hydrate() has finished, so the card above is
    // deliberately made during the load — but autosave does not exist until it
    // has, and reaching for it early is a race in the test rather than a fact
    // about the app.
    await page.waitFor('Boolean(window.app.autosave)', { label: 'the board to finish loading' });

    /**
     * Flushed until it lands, rather than once.
     *
     * The edit above also arms the debounce, so an explicit flush can race the
     * automatic one — both read the version the board is at, one writes it,
     * and the other is refused for holding a version that is no longer
     * current. That is the guard doing its job rather than a failure, and in a
     * session it is invisible: the board stays dirty and the next settled edit
     * retries. A test that asserted on a single attempt was asserting on which
     * of the two got there first.
     */
    await page.waitFor('window.app.autosave.flush()', { label: 'the edit to be written' });

    await page.goto(`/#/b/${id}`, { ready: ON_CANVAS });
    await page.waitFor('window.app.restoredFromStorage || window.app.store.order.length > 0', {
      label: 'the reloaded board to settle',
    });

    // Asserted rather than waited on, so a board that came back wrong says
    // what it came back as — a seeded starter board is the tell that the
    // reload could not read the row at all.
    assert.deepEqual(
      await page.eval(`window.app.store.toJSON().objects.map(o => o.text)`),
      ['from the server'],
    );
    assert.equal(await page.eval('window.app.restoredFromStorage'), true);
  });

  test('renaming on the board page is what the list shows afterwards', async () => {
    await newBoard();

    await page.eval(`(() => {
      const el = document.querySelector('.board-bar-title');
      el.focus();
      el.select();
    })()`);
    await page.type('Retro');
    await page.eval(`document.querySelector('.board-bar-title').blur()`);

    await page.goto(LIST_PATH, { ready: SETTLED });
    assert.deepEqual(await titles(), ['Retro']);
  });

  test('deleting removes it from the server, not just from the page', async () => {
    await newBoard();
    await page.goto(LIST_PATH, { ready: SETTLED });
    await settle();

    await page.eval('window.confirm = () => true');
    await click('[data-action="delete"]');
    await settle();

    assert.deepEqual(await titles(), []);
    await page.goto(LIST_PATH, { ready: SETTLED });
    assert.deepEqual(await titles(), [], 'the board came back after a reload');
  });

  /**
   * Two windows, one board, one account — the same thing two people on one
   * board is, minus the sharing. The op crosses a real channel and lands in
   * the second canvas without either page reloading, which is the whole
   * claim; the sync layer's own behaviour is covered in test/node/sync.test.js.
   */
  test('an edit on one page shows up on another that has the same board open', async () => {
    const id = await newBoard();

    // `window.app` exists from the first render; the channel is joined at the
    // end of hydrate, so both pages have to be waited for separately.
    const joined = async (target) => {
      await target.waitFor('Boolean(window.app?.sync)', { label: 'the channel to be joined' });
      assert.equal(await target.eval('window.app.sync.ready'), 'SUBSCRIBED');
    };

    await joined(page);
    const second = await openApp({ path: `/#/b/${id}`, origin, readyWhen: ON_CANVAS });
    try {
      await joined(second);

      await page.eval(`window.app.board.add('card', { x: 10, y: 10, text: 'live' })`);
      await second.waitFor('window.app.store.toJSON().objects.length === 1', {
        label: 'the card to arrive on the second page',
      });

      assert.equal(await second.eval('window.app.store.toJSON().objects[0].text'), 'live');
      // it arrived as somebody else's edit, so it is not this page's to undo
      assert.equal(await second.eval('window.app.store.canUndo'), false);
      assert.equal(
        await second.eval(`document.querySelectorAll('#layer [data-id]').length`),
        1,
        'the remote op did not reach the renderer',
      );
    } finally {
      await second.close();
    }
  });

  /**
   * Somebody else's pointer, drawn on this board.
   *
   * The position travels in world coordinates, so what is checked is not that
   * a marker turned up somewhere — it is that panning the *receiving* page
   * moves the cursor with the board, which is the whole difference between
   * pointing at a place on a screen and pointing at a thing on a board.
   */
  test("another person's pointer is drawn, named, and anchored to the board", async () => {
    const id = await newBoard();
    await page.waitFor('Boolean(window.app?.sync)', { label: 'the first page to join' });

    const second = await openApp({ path: `/#/b/${id}`, origin, readyWhen: ON_CANVAS });
    try {
      await second.waitFor('Boolean(window.app?.cursors)', { label: 'the second page to join' });

      // Delivery is asserted on state and drawing on the DOM, because they
      // cost differently: a message crosses in about a millisecond, while the
      // node it produces needs a frame — and headless gives a page that is not
      // the active one a frame every few seconds. Waiting on the DOM for every
      // step turned a test about cursors into five seconds of waiting for the
      // compositor, three times over.
      await page.mouse('mouseMoved', 400, 300);
      await second.waitFor('window.app.cursors.list().length === 1', {
        label: "the first page's cursor to arrive",
      });
      await second.waitFor("document.querySelector('.cursor') !== null", {
        label: 'the cursor to be drawn',
        timeout: 15_000,
      });

      const at = () => second.eval(`(() => {
        const el = document.querySelector('.cursor');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), name: el.textContent };
      })()`);

      // Both pages are the same anonymous account, which has no email — so
      // presence labels it `Guest`. Waited for rather than sampled: the label
      // travels with presence and the position with a broadcast, so a cursor
      // can be drawn before anyone has said what to call it. Until then it
      // reads `Someone`, and asserting immediately was a race that only looked
      // safe while the unnamed fallback was also the word "Guest".
      await second.waitFor(`document.querySelector('.cursor')?.textContent === 'Guest'`, {
        label: 'presence to name the cursor',
      });

      const before = await at();
      assert.equal(before.name, 'Guest');
      assert.deepEqual(await second.eval('window.app.cursors.list().length'), 1);

      // pan the receiving page: the cursor is pinned to the board, not the glass
      await second.eval('window.app.viewport.panBy(-120, -60)');
      await second.waitFor(`Math.round(document.querySelector('.cursor').getBoundingClientRect().left) !== ${before.x}`, {
        label: 'the cursor to follow the pan',
      });

      // panBy shifts what is on screen by the delta it is given, so a cursor
      // pinned to the board moves by exactly that and one pinned to the glass
      // would not move at all
      const after = await at();
      assert.equal(after.x - before.x, -120, 'the cursor did not move with the board');
      assert.equal(after.y - before.y, -60);

      // a pointer that leaves the board is gone, not parked at the edge of it
      await page.eval(`document.getElementById('stage').dispatchEvent(
        new PointerEvent('pointerleave', { bubbles: false }))`);
      await second.waitFor('window.app.cursors.list().length === 0', {
        label: 'the cursor to leave with the pointer',
      });

      // presence is the backstop: someone who has gone takes theirs with them
      await page.mouse('mouseMoved', 420, 320);
      await second.waitFor('window.app.cursors.list().length === 1');
      await second.eval('window.app.cursors.setMembers([])');
      assert.deepEqual(await second.eval('window.app.cursors.list()'), []);

      // Leaving the board takes the whole layer with it. Driven through
      // destroy() rather than by navigating, because a navigation would take
      // the teardown with it and prove nothing about what it unwound.
      await page.mouse('mouseMoved', 440, 340);
      await second.waitFor('window.app.cursors.list().length === 1');

      await second.eval('window.app.destroy()');
      assert.equal(await second.eval(`document.querySelector('.cursor') === null`), true);
      assert.deepEqual(await second.eval('window.app.cursors.list()'), []);
    } finally {
      await second.close();
    }
  });

  /**
   * The reason write authority exists, from the outside.
   *
   * Two pages on one board both have the whole document and both have an
   * autosave. Only one of them writes it, so the other cannot save a view of
   * the board that is missing what it has not applied yet — and what survives
   * a reload is everything, from both of them.
   */
  test('two pages on one board do not overwrite each other', async () => {
    const id = await newBoard();
    await page.waitFor('Boolean(window.app?.sync)', { label: 'the first page to join' });

    const second = await openApp({ path: `/#/b/${id}`, origin, readyWhen: ON_CANVAS });
    try {
      await second.waitFor('Boolean(window.app?.sync)', { label: 'the second page to join' });
      await second.waitFor('window.app.sync.isWriter() === false', {
        label: 'the second page to stand down',
      });
      assert.equal(await page.eval('window.app.sync.isWriter()'), true, 'nobody was writing');

      await page.eval(`window.app.board.add('card', { x: 10, y: 10, text: 'from the first' })`);
      await second.waitFor('window.app.store.toJSON().objects.length === 1');
      await second.eval(`window.app.board.add('card', { x: 200, y: 10, text: 'from the second' })`);
      await page.waitFor('window.app.store.toJSON().objects.length === 2');

      // the page without authority declines rather than writing its own view
      assert.equal(await second.eval('window.app.autosave.flush()'), false);
      assert.equal(await page.eval('window.app.autosave.flush()'), true);

      await second.goto(`/#/b/${id}`, { ready: ON_CANVAS });
      await second.waitFor('window.app.restoredFromStorage === true');

      assert.deepEqual(
        (await second.eval('window.app.store.toJSON().objects.map(o => o.text)')).sort(),
        ['from the first', 'from the second'],
        'a reload lost one of the two edits',
      );
    } finally {
      await second.close();
    }
  });

  /**
   * The upgrade path: someone who has been using the Web Storage build opens
   * one with a project behind it. Their boards were written to localStorage by
   * the old build and are read from Postgres by this one — so unless they are
   * moved, the list they meet is empty and their work is unreachable.
   */
  describe('boards made before there was an account', () => {
    /**
     * Write boards the way the Web Storage build did, then load the app.
     *
     * The ids are unique per run: they end up as rows in a database that
     * outlives the run, and a fixed id adopted by one anonymous user is a
     * primary key the next run's user cannot have — which is a failure of the
     * fixture, indistinguishable from a failure of adoption. A pid is not
     * enough on its own; operating systems reuse those, and a truncated uuid
     * is the birthday bound this project already refuses for object ids —
     * 32 bits starts colliding in the tens of thousands. The whole thing fits
     * inside the 64 characters the id column allows, so there is nothing to
     * buy by trimming it.
     */
    const run = randomUUID().replaceAll('-', '');
    let seeded = 0;
    const givenABrowserWithBoards = async (titlesById) => {
      const boards = Object.fromEntries(
        Object.entries(titlesById).map(([name, title]) => [`${name}${run}${seeded++}`, title]),
      );
      await page.eval('localStorage.clear()');
      for (const [id, title] of Object.entries(boards)) {
        await page.eval(`localStorage.setItem('peerthink:board:${id}', ${JSON.stringify(JSON.stringify({
          v: 1, id, title, updatedAt: 1,
          board: { v: 1, order: [id], objects: [{ id, type: 'card', x: 0, y: 0, w: 200, h: 120, text: `made in ${id}` }] },
        }))})`);
      }
      await page.goto(LIST_PATH, { ready: SETTLED });
      return Object.keys(boards);
    };

    test('are adopted into the account, once, without being asked', async () => {
      await givenABrowserWithBoards({ alpha: 'Roadmap', beta: 'Retro' });

      assert.deepEqual((await titles()).sort(), ['Retro', 'Roadmap']);

      // on the server, not merely on screen: a reload reads Postgres
      await page.goto(LIST_PATH, { ready: SETTLED });
      assert.deepEqual((await titles()).sort(), ['Retro', 'Roadmap']);
      assert.equal(
        await page.eval(`document.querySelector('[data-action="delete"]') !== null`),
        true,
        'the adopted boards are not owned by this account',
      );

      // and the board itself came across, not just its name
      await clickIn(page, '.board-card-open');
      await page.waitFor(ON_CANVAS);
      await page.waitFor('window.app.restoredFromStorage === true');
      assert.match(
        await page.eval(`window.app.store.toJSON().objects[0].text`),
        /^made in (alpha|beta)/,
        'the board opened without the card it was seeded with',
      );
    });

    /**
     * Adopted once per page, not once per mount. StrictMode runs the gate's
     * effect twice, and two adoptions racing each other both find the board
     * missing from the account and both create it — one losing on the primary
     * key. The `after` hook is what notices: a 409 reaches the page as a
     * console error, and this suite allows none.
     */
    test('the browser keeps its own copies, and does not adopt them twice', async () => {
      const [id] = await givenABrowserWithBoards({ gamma: 'Kept' });
      assert.deepEqual(await titles(), ['Kept']);

      // still in Web Storage — copying is reversible, deleting is not
      assert.equal(
        await page.eval(`localStorage.getItem('peerthink:board:' + ${JSON.stringify(id)}) !== null`),
        true,
        'adoption deleted the browser copy',
      );

      // a second visit is the same account and the same list, not a doubled one
      await page.goto(LIST_PATH, { ready: SETTLED });
      assert.deepEqual(await titles(), ['Kept']);
    });

    /**
     * An adoption that cannot land must not open the gate on a list with
     * boards missing from it — that is the thing adoption exists to prevent.
     *
     * The failure is real rather than simulated: a board id that already
     * belongs to somebody else is invisible to this account, so the write
     * falls through to an insert, loses on the primary key, and is refused the
     * retry. Exactly what a browser carrying a board someone else now owns
     * would meet.
     */
    test('a board that cannot be moved holds the gate, and can be retried', async () => {
      // This test provokes a real primary-key conflict, so it owns the console
      // errors that come with it — consumed here rather than tolerated by the
      // suite, because an unexplained 409 is what exposed the double-adoption
      // race and this suite should keep being able to notice one.
      const before = page.errors.length;

      await page.eval('localStorage.clear()');
      await page.goto(LIST_PATH, { ready: SETTLED });
      const taken = await newBoard();
      await page.goto(LIST_PATH, { ready: SETTLED });

      // a different person, carrying a board with that id in their browser
      await page.eval('localStorage.clear()');
      await page.eval(`localStorage.setItem('peerthink:board:' + ${JSON.stringify(taken)}, JSON.stringify({
        v: 1, id: ${JSON.stringify(taken)}, title: 'mine, allegedly', updatedAt: 1,
        board: { v: 1, order: [], objects: [] },
      }))`);

      await page.goto(LIST_PATH, { ready: "Boolean(document.querySelector('[data-unadopted]'))" });
      assert.equal(await page.eval(`document.querySelector('.board-grid') === null`), true,
        'the workspace was shown with boards missing from it');

      // and it is a choice rather than a dead end
      await clickIn(page, '[data-action="skip-adoption"]');
      await page.waitFor(SETTLED, { label: 'the list, entered deliberately' });
      assert.deepEqual(await titles(), []);

      const provoked = page.errors.splice(before);
      assert.deepEqual(
        provoked.filter((e) => !/status of 409/.test(e)),
        [],
        'the test logged something other than the conflict it set out to cause',
      );
      assert.ok(provoked.length, 'the conflict this test depends on did not happen');
    });

    /**
     * The account's copy is the one other people may have edited, so a browser
     * that has been sitting closed must not put its version on top of it.
     */
    test('a board the account already has is not overwritten', async () => {
      await page.eval('localStorage.clear()');
      await page.goto(LIST_PATH, { ready: SETTLED });

      const id = await newBoard();
      await page.eval(`window.app.board.add('card', { x: 10, y: 10, text: 'the account version' })`);
      await page.waitFor('Boolean(window.app.autosave)');
      assert.equal(await page.eval('window.app.autosave.flush()'), true);

      // The same id turns up in Web Storage holding an older, emptier board —
      // as a browser that had been closed since before the backend would — and
      // the marker is cleared so adoption considers it afresh.
      await page.eval(`(() => {
        localStorage.removeItem('peerthink:adopted');
        localStorage.setItem('peerthink:board:' + ${JSON.stringify(id)}, JSON.stringify({
          v: 1, id: ${JSON.stringify(id)}, title: 'the browser version', updatedAt: 1,
          board: { v: 1, order: [], objects: [] },
        }));
      })()`);
      await page.goto(LIST_PATH, { ready: SETTLED });

      assert.deepEqual(await titles(), ['Untitled board'], 'the browser copy renamed the account board');

      await clickIn(page, '.board-card-open');
      await page.waitFor(ON_CANVAS);
      await page.waitFor('window.app.restoredFromStorage === true');
      assert.deepEqual(
        await page.eval(`window.app.store.toJSON().objects.map(o => o.text)`),
        ['the account version'],
        'the emptier browser copy replaced the account board',
      );
    });
  });

  /**
   * Sharing, end to end and between two accounts.
   *
   * The second page clears its session first, so it is a different person —
   * which is what makes the link do any work. Without it the two pages share a
   * guest and the board would be reachable anyway.
   */
  describe('sharing', () => {
    const shareUrl = async () => {
      await click('[data-action="share"]');
      await page.waitFor("document.querySelector('[data-share-dialog]') !== null", {
        label: 'the share dialog',
      });
      await page.waitFor("document.querySelector('[data-action=\"create-link\"], [data-share-url]') !== null", {
        label: 'the dialog to load',
      });

      if (await page.eval(`document.querySelector('[data-action="create-link"]') !== null`)) {
        await click('[data-action="create-link"]');
      }
      await page.waitFor("document.querySelector('[data-share-url]') !== null", {
        label: 'the link to be minted',
      });
      return page.eval(`document.querySelector('[data-share-url]').value`);
    };

    /**
     * Open a link as somebody else.
     *
     * `isolated` is what makes them somebody else: a plain second tab shares
     * this origin's Web Storage, so signing it in would take the owner's own
     * session away — which is right for a browser and would quietly turn this
     * into a test of one person sharing with themselves.
     */
    const joinAsSomeoneElse = async (url) => {
      const other = await openApp({
        path: `/${url.slice(url.indexOf('#'))}`,
        origin,
        isolated: true,
        readyWhen: `${ON_CANVAS} || Boolean(document.querySelector('[data-join-failed]'))`,
      });
      return other;
    };

    test('a link lets someone else onto the board, and it is listed for them', async () => {
      const id = await newBoard();
      await page.eval(`window.app.board.add('card', { x: 20, y: 20, text: 'shared work' })`);
      await page.waitFor('Boolean(window.app.autosave)');
      await page.eval('window.app.autosave.flush()');

      const url = await shareUrl();
      assert.match(url, /#\/join\/[0-9a-f]{32}$/);

      const other = await joinAsSomeoneElse(url);
      try {
        assert.equal(await other.eval('location.hash'), `#/b/${id}`, 'the link did not open the board');
        await other.waitFor('window.app.store.toJSON().objects.length === 1');
        assert.equal(
          await other.eval(`window.app.store.toJSON().objects[0].text`),
          'shared work',
        );

        // and it is theirs to come back to
        await other.goto(LIST_PATH, { ready: SETTLED });
        assert.deepEqual(
          await other.eval(`[...document.querySelectorAll('.board-card-title')].map(el => el.textContent)`),
          ['Untitled board'],
        );
      } finally {
        await other.close();
      }
    });

    test('the owner sees who joined, and can put them off again', async () => {
      await newBoard();
      const url = await shareUrl();

      const other = await joinAsSomeoneElse(url);
      try {
        await other.waitFor(ON_CANVAS);

        // the dialog is still open on the owner's page; reopen it to re-read
        await click('[data-action="close-share"]');
        await shareUrl();
        await page.waitFor(`document.querySelectorAll('.share-people li').length === 2`, {
          label: 'the new member to be listed',
        });

        assert.deepEqual(
          await page.eval(`[...document.querySelectorAll('.share-person-role')].map(el => el.textContent)`),
          ['owner', 'editor'],
        );

        await click('[data-action="remove-person"]');
        await page.waitFor(`document.querySelectorAll('.share-people li').length === 1`, {
          label: 'the member to be removed',
        });

        // and the board is gone for them on the next read
        await other.goto(LIST_PATH, { ready: SETTLED });
        assert.deepEqual(
          await other.eval(`[...document.querySelectorAll('.board-card-title')].map(el => el.textContent)`),
          [],
          'a removed member could still see the board',
        );
      } finally {
        await other.close();
      }
    });

    test('the link can be copied, and says so', async () => {
      await newBoard();
      const url = await shareUrl();

      // Headless Chrome refuses the clipboard without this, and the refusal is
      // handled — but "Copied" is the path a person actually takes.
      await page.session.send('Browser.grantPermissions', {
        origin,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });

      await click('[data-action="copy-link"]');
      await page.waitFor(
        `document.querySelector('[data-action="copy-link"]').textContent === 'Copied'`,
        { label: 'the copy to be confirmed' },
      );
      assert.equal(await page.eval('navigator.clipboard.readText()'), url);
    });

    /** Escape closes it, like every other dialog. */
    test('the dialog closes on escape', async () => {
      await newBoard();
      await shareUrl();

      await page.key('Escape', { code: 'Escape', vk: 27 });
      await page.waitFor("document.querySelector('[data-share-dialog]') === null", {
        label: 'the dialog to close',
      });
    });

    /**
     * A shared board is not yours to delete — the policies would refuse, and
     * refusing quietly would look like a board that came back. So the card
     * offers the thing that is actually available.
     */
    test('a shared board offers Leave where an owned one offers Delete', async () => {
      await newBoard();
      const url = await shareUrl();

      const other = await joinAsSomeoneElse(url);
      try {
        await other.waitFor(ON_CANVAS);
        await other.goto(LIST_PATH, { ready: SETTLED });

        assert.equal(
          await other.eval(`document.querySelector('[data-action="delete"]') === null`),
          true,
          'a member was offered Delete on a board that is not theirs',
        );
        assert.equal(
          await other.eval(`document.querySelector('[data-action="leave"]').textContent`),
          'Leave',
        );

        await other.eval('window.confirm = () => true');
        await clickIn(other, '[data-action="leave"]');

        await other.waitFor("document.querySelector('[data-empty]') !== null", {
          label: 'the board to leave the list',
        });

        // and it left nobody else's list
        await page.goto(LIST_PATH, { ready: SETTLED });
        assert.equal((await titles()).length, 1, 'leaving a board deleted it');
      } finally {
        await other.close();
      }
    });

    test('a member can leave from the share dialog, and lands back on the list', async () => {
      await newBoard();
      const url = await shareUrl();

      const other = await joinAsSomeoneElse(url);
      try {
        await other.waitFor(ON_CANVAS);
        await clickIn(other, '[data-action="share"]');
        await other.waitFor("document.querySelector('[data-action=\"leave-board\"]') !== null", {
          label: 'the leave option',
        });
        await clickIn(other, '[data-action="leave-board"]');

        await other.waitFor("location.hash === '#/' && document.querySelector('[data-empty]') !== null", {
          label: 'the list, without the board',
        });
      } finally {
        await other.close();
      }
    });

    test('a revoked link stops opening the board', async () => {
      await newBoard();
      const url = await shareUrl();
      await click('[data-action="revoke-link"]');
      await page.waitFor(`document.querySelector('[data-action="create-link"]') !== null`, {
        label: 'the link to be revoked',
      });

      const other = await joinAsSomeoneElse(url);
      try {
        assert.equal(
          await other.eval(`document.querySelector('[data-join-failed]') !== null`),
          true,
          'a revoked link still opened the board',
        );
      } finally {
        await other.close();
      }
    });

    test('someone who is only a member is told it is not theirs to share', async () => {
      await newBoard();
      const url = await shareUrl();

      const other = await joinAsSomeoneElse(url);
      try {
        await other.waitFor(ON_CANVAS);
        await clickIn(other, '[data-action="share"]');

        await other.waitFor("document.querySelector('[data-not-owner]') !== null", {
          label: 'the not-yours message',
        });
        assert.equal(await other.eval(`document.querySelector('[data-share-url]') === null`), true);
      } finally {
        await other.close();
      }
    });
  });

  /**
   * The policies are tested directly in test/db/, and through the repository
   * in test/node/. This is the same claim from the outside: whatever the
   * previous test left behind, the next account does not see it.
   */
  test('signing in as someone else shows their boards, not the last account\'s', async () => {
    await newBoard();
    await page.goto(LIST_PATH, { ready: SETTLED });
    assert.equal((await titles()).length, 1);

    await page.eval('localStorage.clear()');
    await page.goto(LIST_PATH, { ready: SETTLED });

    assert.deepEqual(await titles(), []);
  });
});
