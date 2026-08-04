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
    // flush rather than sleep — it hands back the repository's own promise, so
    // this waits for the write itself rather than for the debounce to expire
    await page.eval('window.app.autosave.flush()');

    await page.goto(`/#/b/${id}`, { ready: ON_CANVAS });
    await page.waitFor('window.app.store.toJSON().objects.length === 1', {
      label: 'the board to come back from the server',
    });

    assert.equal(
      await page.eval(`window.app.store.toJSON().objects[0].text`),
      'from the server',
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
