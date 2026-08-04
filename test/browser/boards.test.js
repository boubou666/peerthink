import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

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

  const click = async (selector) => {
    const box = await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    })()`);
    assert.ok(box, `no element matched ${selector}`);
    await page.click(box.cx, box.cy);
  };

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

    // flush rather than sleep — it hands back the repository's own promise, so
    // this waits for the write itself rather than for the debounce to expire
    assert.equal(await page.eval('window.app.autosave.flush()'), true, 'the write was refused');

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

      await page.mouse('mouseMoved', 400, 300);
      await second.waitFor("document.querySelector('.cursor') !== null", {
        label: "the first page's cursor to appear",
      });

      const at = () => second.eval(`(() => {
        const el = document.querySelector('.cursor');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), name: el.textContent };
      })()`);

      const before = await at();
      // both pages are the same anonymous account, which has no email
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
      await second.waitFor("document.querySelector('.cursor') === null", {
        label: 'the cursor to leave with the pointer',
      });
      assert.deepEqual(await second.eval('window.app.cursors.list()'), []);

      // and presence is the backstop: someone who has gone takes theirs with them
      await page.mouse('mouseMoved', 420, 320);
      await second.waitFor("document.querySelector('.cursor') !== null");
      await second.eval('window.app.cursors.setMembers([])');
      assert.equal(await second.eval(`document.querySelector('.cursor') === null`), true);

      // Leaving the board takes the whole layer with it. Driven through
      // destroy() rather than by navigating, because a navigation would take
      // the teardown with it and prove nothing about what it unwound.
      await page.mouse('mouseMoved', 440, 340);
      await second.waitFor("document.querySelector('.cursor') !== null");

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
        const box = await other.eval(`(() => {
          const el = document.querySelector('[data-action="share"]');
          const r = el.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        })()`);
        await other.click(box.cx, box.cy);

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
