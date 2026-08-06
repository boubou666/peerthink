import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { LIST_PATH, openApp, supabaseOrigin } from '../helpers/browser.js';

/**
 * Accounts, against a real Supabase.
 *
 * This suite runs on its own origin — a build that was handed a project — and
 * talks to a local stack over HTTP: real GoTrue, real anonymous users, real
 * rejected passwords. Nothing here is stubbed, because the parts worth
 * doubting are the ones a stub would have to invent: that a first visit
 * produces exactly one guest, that registering keeps the *same* user, and that
 * signing out puts the gate back.
 *
 * No stack, no suite. `npx supabase start` is what turns it on, and test/run.js
 * says so on the way past when it is off.
 */
const origin = supabaseOrigin();

/**
 * The gate and the list both render `.shell`, so "the page rendered" says
 * nothing about which of them is on screen. The header only exists on the
 * list, and `[data-account-gate]` only on the gate.
 */
const SIGNED_IN = "Boolean(document.querySelector('.shell-header'))";
const GATE = "Boolean(document.querySelector('[data-account-gate]'))";

describe('accounts', { skip: origin ? false : 'no local supabase (npx supabase start)' }, () => {
  let page;

  // Every registration is a row that outlives the run, so addresses cannot be
  // constants — the second run would meet its own leftovers from the first.
  const uniqueEmail = () => `peerthink-${process.pid}-${counter++}@example.com`;
  let counter = 0;

  before(async () => {
    page = await openApp({ path: LIST_PATH, origin, readyWhen: SIGNED_IN });
  });

  after(async () => {
    // A rejected password is a 400 and an address that is already an account
    // is a 422, both by design, and Chrome logs every failed request at error
    // level whether or not the page handled it. Those are filtered by status
    // rather than by dropping network noise wholesale, so a 500 from the stack
    // still fails this suite.
    const expected = /Failed to load resource.*status of (400|422)/;
    const errors = page.errors.filter((e) => !expected.test(e));

    // Closed before the assertion, not after: close() is what writes this
    // page's coverage and releases the CDP session, and a failing assertion
    // that skips it takes the rest of the run down with it.
    await page.close();
    assert.deepEqual(errors, [], 'the page logged errors');
  });

  beforeEach(async () => {
    // A cleared session is what makes each test a first visit. The reload is
    // the point: the account is resolved once, at load.
    await page.eval('localStorage.clear()');
    await page.goto(LIST_PATH, { ready: SIGNED_IN });
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

  /** Real key input, so React's onChange drives the controlled field. */
  const fill = async (selector, value) => {
    await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      el.select();
    })()`);
    await page.type(value);
  };

  const submitAccountForm = async ({ email, password }) => {
    await fill('.account-form input[name="email"]', email);
    await fill('.account-form input[name="password"]', password);
    await click('[data-action="submit-account"]');
  };

  const text = (selector) =>
    page.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);

  /**
   * The signed-in user's id, read out of the session the client stored.
   *
   * This is the only way to ask "is this still the same user?" from outside
   * the app, and that question is the whole difference between attaching an
   * email to a guest and quietly creating a second account beside them.
   */
  const userId = () =>
    page.eval(`(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!/auth-token/.test(key)) continue;
        try { return JSON.parse(localStorage.getItem(key))?.user?.id ?? null; } catch { return null; }
      }
      return null;
    })()`);

  test('a first visit is signed in as a guest, with no sign-in to do', async () => {
    assert.equal(await text('[data-account="guest"] [data-action="save-account"]'), 'Save your boards');
    assert.equal(await page.eval(`document.querySelector('[data-account-gate]') !== null`), false);
    assert.ok(await userId(), 'no session was stored');
  });

  /**
   * The claim StrictMode makes expensive to get wrong: two mounts of the same
   * effect must not be two users. The id is read, the page reloaded, and the
   * id read again — a second guest would have replaced the first.
   */
  test('a reload keeps the same guest rather than minting another', async () => {
    const first = await userId();
    await page.goto(LIST_PATH, { ready: SIGNED_IN });

    assert.equal(await userId(), first);
  });

  test('registering attaches the email to the guest who is already here', async () => {
    const email = uniqueEmail();
    const guest = await userId();

    await click('[data-action="save-account"]');
    await submitAccountForm({ email, password: 'correct horse' });
    await page.waitFor(`document.querySelector('[data-account="user"]') !== null`, {
      label: 'the account menu to show a registered user',
    });

    assert.equal(await text('.account-email'), email);
    // the same row in auth.users — which is what keeps the boards
    assert.equal(await userId(), guest);
  });

  test('signing out puts the gate back, and the account is still there to return to', async () => {
    const email = uniqueEmail();
    const password = 'correct horse';

    await click('[data-action="save-account"]');
    await submitAccountForm({ email, password });
    await page.waitFor(`document.querySelector('[data-account="user"]') !== null`);
    const registered = await userId();

    await click('[data-action="sign-out"]');
    await page.waitFor(GATE, { label: 'the gate to come back' });
    assert.equal(await userId(), null, 'the session outlived the sign-out');

    await submitAccountForm({ email, password });
    await page.waitFor(SIGNED_IN, { label: 'the board list to come back' });

    assert.equal(await userId(), registered);
    assert.equal(await text('.account-email'), email);
  });

  test('a wrong password is reported on the form, not thrown away', async () => {
    const email = uniqueEmail();

    await click('[data-action="save-account"]');
    await submitAccountForm({ email, password: 'correct horse' });
    await page.waitFor(`document.querySelector('[data-account="user"]') !== null`);

    await click('[data-action="sign-out"]');
    await page.waitFor(GATE);
    await submitAccountForm({ email, password: 'not the password' });

    await page.waitFor(`document.querySelector('[data-account-gate] [data-error]') !== null`, {
      label: 'the error to appear',
    });
    assert.match(await text('[data-account-gate] [data-error]'), /credential|password|invalid/i);
    assert.equal(await page.eval(GATE), true, 'a rejected password let someone through');
  });

  test('continue without an account signs in a new guest', async () => {
    await click('[data-action="save-account"]');
    await submitAccountForm({ email: uniqueEmail(), password: 'correct horse' });
    await page.waitFor(`document.querySelector('[data-account="user"]') !== null`);

    await click('[data-action="sign-out"]');
    await page.waitFor(GATE);

    await click('[data-action="continue-as-guest"]');
    await page.waitFor(SIGNED_IN, { label: 'a fresh guest to land on the list' });

    assert.equal(await text('[data-account="guest"] [data-action="save-account"]'), 'Save your boards');
  });

  test('the form offers the other way round for someone who already has an account', async () => {
    const email = uniqueEmail();
    const password = 'correct horse';

    await click('[data-action="save-account"]');
    await submitAccountForm({ email, password });
    await page.waitFor(`document.querySelector('[data-account="user"]') !== null`);

    // a second browser: a fresh guest, who wants their own account instead
    await page.eval('localStorage.clear()');
    await page.goto(LIST_PATH, { ready: SIGNED_IN });
    await click('[data-action="save-account"]');
    await click('[data-action="switch-mode"]');
    await submitAccountForm({ email, password });

    await page.waitFor(`document.querySelector('.account-email') !== null`, {
      label: 'the signed-in account',
    });
    assert.equal(await text('.account-email'), email);
  });

  /**
   * The bug this pair exists for: signing in from the account menu never
   * passes through the gate, because the guest was let through long ago. The
   * pages under it had read their boards on mount and had no reason to read
   * them again, so the list on screen stayed the one that belonged to whoever
   * was here before — and a reload was the only way to see your own boards.
   */
  test('signing in shows that account\'s boards, with no reload to ask for', async () => {
    const email = uniqueEmail();
    const password = 'correct horse';

    await click('[data-action="save-account"]');
    await submitAccountForm({ email, password });
    await page.waitFor(`document.querySelector('[data-account="user"]') !== null`);

    // A board of their own, so the assertion below is about this account's
    // list rather than about any list at all.
    await click('[data-action="new-board"]');
    await page.waitFor(`location.hash.startsWith('#/b/')`, { label: 'the new board to open' });
    const id = (await page.eval('location.hash')).replace('#/b/', '');

    // a second browser: a fresh guest, whose workspace really is empty
    await page.eval('localStorage.clear()');
    await page.goto(LIST_PATH, { ready: SIGNED_IN });
    await page.waitFor(`document.querySelector('[data-empty]') !== null`, {
      label: 'the guest to settle on an empty list',
    });

    await click('[data-action="save-account"]');
    await click('[data-action="switch-mode"]');
    await submitAccountForm({ email, password });

    // Nothing below reloads: this is the same document that was showing the
    // guest's empty workspace a moment ago.
    await page.waitFor(`document.querySelector('[data-board-id="${id}"]') !== null`, {
      label: 'the board of the account just signed into',
    });
    assert.equal(await text('.account-email'), email);
  });

  /**
   * And the other half of the same decision. The subtree is rebuilt when the
   * *user* changes, which is not the same as when the account object changes:
   * every token refresh publishes a fresh one for the same person, and hourly
   * is often enough that rebuilding the page under someone would be a bug of
   * its own. So this refreshes for real and holds the rendered node to it.
   */
  test('a refreshed token does not rebuild the page underneath', async () => {
    await page.eval(`(async () => {
      const { auth } = await import('/src/shell/auth.js');
      window.__published = [];
      auth.subscribe((account) => window.__published.push(account?.id ?? null));
      window.__shell = document.querySelector('.shell');
    })()`);

    const failure = await page.eval(`(async () => {
      const { client } = await import('/src/shell/auth.js');
      const { error } = await client.auth.refreshSession();
      return error?.message ?? null;
    })()`);
    assert.equal(failure, null, 'the session could not be refreshed');

    // The account really was published again — without this the assertion
    // below would hold for a page nothing had happened to yet.
    await page.waitFor('window.__published.length > 0', {
      label: 'the refreshed session to reach the shell',
    });
    assert.equal(
      await page.eval(`window.__shell === document.querySelector('.shell')`),
      true,
      'a token refresh tore the workspace down and built it again',
    );
  });

  test('an address that is already an account says so, and says what switching costs', async () => {
    const email = uniqueEmail();
    const password = 'correct horse';

    await click('[data-action="save-account"]');
    await submitAccountForm({ email, password });
    await page.waitFor(`document.querySelector('[data-account="user"]') !== null`);

    // a second browser: a fresh guest, who tries to register the same address
    await page.eval('localStorage.clear()');
    await page.goto(LIST_PATH, { ready: SIGNED_IN });
    await click('[data-action="save-account"]');
    await submitAccountForm({ email, password });

    await page.waitFor(`document.querySelector('[data-error]') !== null`, {
      label: 'the address to be reported as taken',
    });
    // Not Supabase's "User already registered", which says nothing about the
    // boards this guest is about to walk away from.
    assert.match(await text('[data-error]'), /already has an account/i);
    assert.match(await text('[data-error]'), /stay behind/i, 'the cost is stated');

    // and the way out is offered rather than left to be guessed at
    await click('[data-action="sign-in-instead"]');
    await page.waitFor(`document.querySelector('[data-account-form="sign-in"]') !== null`, {
      label: 'the form to switch to signing in',
    });
  });
});
