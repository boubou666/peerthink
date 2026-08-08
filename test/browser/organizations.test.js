import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { LIST_PATH, openApp, supabaseOrigin } from '../helpers/browser.js';

/**
 * Organizations, in a real browser against a real stack.
 *
 * The policies are covered in test/db/ and the adapter in
 * test/node/organizations.test.js. What is left — and what only a browser can
 * answer — is whether the shell puts a board where the person looking at it
 * thinks it is going: that a board made inside an organization is not on the
 * personal list, that the link actually admits a second session, and that
 * everything the invited person then sees is what the policies would allow
 * rather than what this page hoped.
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

describe('organizations', { skip: origin ? false : 'no local supabase (npx supabase start)' }, () => {
  let page;

  /** Registrations outlive the run, so an address cannot be a constant. */
  let counter = 0;
  const uniqueEmail = () => `peerthink-org-${process.pid}-${counter++}@example.com`;
  const uniqueName = (label) => `${label} ${process.pid}-${counter++}`;

  before(async () => {
    page = await openApp({ path: LIST_PATH, origin, readyWhen: SETTLED });

    /**
     * One registered account for the whole suite, rather than a fresh guest
     * per test.
     *
     * Creating an organization is the one thing a guest cannot do, so a
     * `localStorage.clear()` in `beforeEach` — which is how the other suites
     * get an empty workspace — would leave every test here unable to reach the
     * feature it is testing.
     */
    await clickIn(page, '[data-action="save-account"]');
    await fill('.account-form input[name="email"]', uniqueEmail());
    await fill('.account-form input[name="password"]', 'correct horse');
    await clickIn(page, '[data-action="submit-account"]');
    await page.waitFor(`document.querySelector('[data-account="user"]') !== null`, {
      label: 'the account menu to show a registered user',
    });
  });

  after(async () => {
    // Three of these are by design and one is the point of a test here: a
    // refused write is a 400, an address that is already an account is a 422,
    // a conflicting upsert is a 409, and a policy refusing an insert — the
    // guest who may not create an organization — is a 403. Chrome logs every
    // failed request at error level whether or not the page handled it.
    // Filtered by status, so a 500 from the stack still fails this suite.
    const expected = /Failed to load resource.*status of (400|403|409|422)/;
    const errors = page.errors.filter((e) => !expected.test(e));
    await page.close();
    assert.deepEqual(errors, [], 'the page logged errors');
  });

  beforeEach(async () => {
    // Back to the personal list, without clearing the session — see above.
    await page.goto(LIST_PATH, { ready: SETTLED });
  });

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

  const fill = async (selector, value) => {
    await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      el.select();
    })()`);
    await page.type(value);
  };

  /**
   * Choose an option in a `<select>`.
   *
   * Assigning through the prototype's setter rather than to `el.value`: React
   * keeps its own record of what it last wrote, and a plain assignment leaves
   * that record in agreement with the new value — so the change event is
   * dispatched and React decides nothing happened.
   */
  const choose = async (target, selector, value) => {
    const ok = await target.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.ok(ok, `no select matched ${selector}`);
    /**
     * React having processed the event, which is what the fixed delay here
     * used to stand in for. What the change then *triggers* is each caller's
     * own business to wait on.
     *
     * "Or the select is gone" is not slack in the condition — it is the other
     * half of it. Moving a board out of the scope on screen takes its card
     * with it, so that `<select>` unmounts rather than settling on the value
     * it was given; waiting only for the value would wait for an element that
     * no longer exists. Either outcome is React having handled the change,
     * which is the whole question being asked.
     */
    await target.waitFor(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return !el || el.value === ${JSON.stringify(value)};
      })()`,
      { label: `${selector} to take ${value} or go away` },
    );
  };

  const settle = (target = page) => target.waitFor(SETTLED, { label: 'the board list to settle' });

  /**
   * The titles on screen, without the "New" badge.
   *
   * `textContent` picks the badge up, and a board that arrived from somebody
   * else always carries one — so reading the whole node would compare
   * "Roadmap New" against "Roadmap" on exactly the pages this suite is about.
   */
  const titles = async (target = page) => {
    await settle(target);
    return target.eval(
      `[...document.querySelectorAll('.board-card-title')].map(el => el.firstChild.textContent.trim())`,
    );
  };

  const scope = () => page.eval(`document.querySelector('[data-scope-name]')?.textContent ?? null`);

  const errorText = (target = page) =>
    target.eval(`document.querySelector('[data-error]')?.textContent ?? null`);

  /** Make an organization through the header button, and land on its list. */
  const newOrg = async (name = uniqueName('Acme')) => {
    await page.eval(`window.prompt = () => ${JSON.stringify(name)}`);
    await click('[data-action="new-org"]');
    await page.waitFor(`location.hash.startsWith('#/o/')`, { label: 'the organization to open' });
    await settle();
    return { name, id: await page.eval(`location.hash.replace('#/o/', '')`) };
  };

  const newBoard = async () => {
    await click('[data-action="new-board"]');
    await page.waitFor(ON_CANVAS, { label: 'the new board to open' });
    return page.eval('window.app.boardId');
  };

  /**
   * A second browser, signed in as a fresh registered account.
   *
   * Registered rather than the guest a first visit produces, because the two
   * things this suite hands to somebody else — the organization itself, and a
   * share of running it — both refuse an anonymous session.
   */
  const aRegisteredPage = async () => {
    const other = await openApp({ path: LIST_PATH, origin, readyWhen: SETTLED, isolated: true });
    await clickIn(other, '[data-action="save-account"]');
    for (const [field, value] of [['email', uniqueEmail()], ['password', 'correct horse']]) {
      await other.eval(`(() => {
        const el = document.querySelector('.account-form input[name="${field}"]');
        el.focus(); el.select();
      })()`);
      await other.type(value);
    }
    await clickIn(other, '[data-action="submit-account"]');
    await other.waitFor(`document.querySelector('[data-account="user"]') !== null`, {
      label: 'the second account to register',
    });
    return other;
  };

  /** Mint an invite link for the organization currently on screen. */
  const inviteLink = async (role = 'editor') => {
    await click('[data-action="org-people"]');
    await page.waitFor(`Boolean(document.querySelector('[data-org-dialog]'))`, {
      label: 'the people dialog',
    });
    await page.waitFor(`!document.querySelector('[data-org-dialog] [data-loading]')`, {
      label: 'the dialog to load',
    });

    await click('[data-action="create-org-link"]');
    await page.waitFor(`Boolean(document.querySelector('[data-org-url]'))`, {
      label: 'the link to be minted',
    });
    if (role !== 'editor') {
      await choose(page, '[data-action="org-link-role"]', role);
      // Changing the role rewrites the invite row, and the link is read on the
      // next line — so the round trip has to have landed, not merely started.
      await settle();
    }

    const url = await page.eval(`document.querySelector('[data-org-url]').value`);
    await click('[data-action="close-org"]');
    // The whole URL is built from the page; only the route matters here.
    return url.slice(url.indexOf('#'));
  };

  test('creating one opens it and puts it in the switcher', async () => {
    const { name, id } = await newOrg();

    assert.equal(await scope(), name);
    assert.equal(
      await page.eval(`[...document.querySelectorAll('[data-action="scope"] option')]
        .some(o => o.value === ${JSON.stringify(id)})`),
      true,
      'the new organization is not in the switcher',
    );
    assert.deepEqual(await titles(), [], 'a new organization already had boards');
  });

  /**
   * The claim the whole feature rests on: a board made in an organization
   * belongs to it, and is not quietly sitting on the personal list as well.
   */
  test('a board made in an organization is in it, and not on the personal list', async () => {
    const { id } = await newOrg();
    await newBoard();

    await page.goto(`/#/o/${id}`, { ready: SETTLED });
    assert.deepEqual(await titles(), ['Untitled board']);

    await page.goto(LIST_PATH, { ready: SETTLED });
    assert.equal((await titles()).includes('Untitled board'), false, 'it leaked onto the personal list');
  });

  test('the switcher moves between the two lists', async () => {
    const { name, id } = await newOrg();

    await page.goto(LIST_PATH, { ready: SETTLED });
    assert.equal(await scope(), 'Boards');

    await choose(page, '[data-action="scope"]', id);
    await page.waitFor(`location.hash === '#/o/${id}'`, { label: 'the organization list' });
    await settle();
    assert.equal(await scope(), name);

    await choose(page, '[data-action="scope"]', '');
    await page.waitFor(`location.hash === '#/'`, { label: 'the personal list' });
    assert.equal(await scope(), 'Boards');
  });

  test('a board can be moved into an organization and back out', async () => {
    const { id } = await newOrg();

    await page.goto(LIST_PATH, { ready: SETTLED });
    await click('[data-action="new-board"]');
    await page.waitFor(ON_CANVAS, { label: 'the new board to open' });
    await page.goto(LIST_PATH, { ready: SETTLED });

    await choose(page, '.board-card [data-action="move"]', id);
    await settle();
    assert.equal((await titles()).includes('Untitled board'), false, 'it stayed on the personal list');

    await page.goto(`/#/o/${id}`, { ready: SETTLED });
    assert.deepEqual(await titles(), ['Untitled board']);

    await choose(page, '.board-card [data-action="move"]', '');
    await settle();
    assert.deepEqual(await titles(), [], 'it stayed in the organization');
  });

  /**
   * The end-to-end one. A second session — a guest, with no account at all —
   * follows the link and finds the boards, including the one made before they
   * were invited.
   */
  test('the link admits a second session, and its boards come with it', async () => {
    const { name, id } = await newOrg();
    await newBoard();
    await page.goto(`/#/o/${id}`, { ready: SETTLED });

    const join = await inviteLink();

    const guest = await openApp({ path: LIST_PATH, origin, readyWhen: SETTLED, isolated: true });
    try {
      assert.deepEqual(await titles(guest), [], 'the guest already had boards');

      await guest.goto(join, { ready: SETTLED });
      await guest.waitFor(`location.hash === '#/o/${id}'`, {
        label: 'the guest to land on the organization',
        context: 'document.body.innerText',
      });
      await settle(guest);

      assert.equal(await guest.eval(`document.querySelector('[data-scope-name]').textContent`), name);
      assert.deepEqual(await titles(guest), ['Untitled board']);

      // and it is the organization giving them this, not a board membership:
      // the personal list stays empty
      await guest.goto(LIST_PATH, { ready: SETTLED });
      assert.deepEqual(await titles(guest), []);

      // a member is not shown a way to hand the organization on
      await guest.goto(`/#/o/${id}`, { ready: SETTLED });
      await clickIn(guest, '[data-action="org-people"]');
      await guest.waitFor(`Boolean(document.querySelector('[data-not-owner]'))`, {
        label: 'the dialog to say it is not theirs',
      });
      assert.equal(
        await guest.eval(`Boolean(document.querySelector('[data-action="create-org-link"]'))`),
        false,
        'a member was offered a link to hand out',
      );

      // leaving gives the boards back up
      await guest.eval('window.confirm = () => true');
      await clickIn(guest, '[data-action="leave-org"]');
      await guest.waitFor(`location.hash === '#/'`, { label: 'the guest to be sent back' });
      await settle(guest);
      assert.deepEqual(await titles(guest), []);
      assert.equal(
        await guest.eval(`[...document.querySelectorAll('[data-action="scope"] option')]
          .some(o => o.value === ${JSON.stringify(id)})`),
        false,
        'the organization is still in the switcher after leaving',
      );
    } finally {
      await guest.close();
    }
  });

  /**
   * Deleting is offered behind a confirm that promises the boards survive, so
   * this is the test that keeps that promise honest.
   */
  test('deleting the organization hands its boards back to their creator', async () => {
    const { id } = await newOrg();
    await newBoard();
    await page.goto(`/#/o/${id}`, { ready: SETTLED });
    assert.deepEqual(await titles(), ['Untitled board']);

    await click('[data-action="org-people"]');
    await page.waitFor(`!document.querySelector('[data-org-dialog] [data-loading]')`, {
      label: 'the dialog to load',
    });
    await page.eval('window.confirm = () => true');
    await click('[data-action="delete-org"]');

    await page.waitFor(`location.hash === '#/'`, { label: 'the personal list' });
    await settle();

    assert.equal((await titles()).includes('Untitled board'), true, 'the board went with the organization');
    assert.equal(
      await page.eval(`[...document.querySelectorAll('[data-action="scope"] option')]
        .some(o => o.value === ${JSON.stringify(id)})`),
      false,
      'the deleted organization is still in the switcher',
    );
  });

  /**
   * A second owner, through the dialog.
   *
   * The split is covered in test/db/ and the adapter in test/node/. What only
   * a browser answers is that the two people see different screens: a second
   * owner gets the roster and the link like an owner, and does not get the
   * four controls that are not theirs — offering a button the database will
   * refuse is worse than not offering it.
   */
  test('a second owner runs the organization without owning it', async () => {
    const { id } = await newOrg();
    const join = await inviteLink();

    const deputy = await aRegisteredPage();
    try {
      await deputy.goto(join, { ready: SETTLED });
      await deputy.waitFor(`location.hash === '#/o/${id}'`, { label: 'the deputy to join' });

      // Before being appointed: an ordinary member, and told so.
      await clickIn(deputy, '[data-action="org-people"]');
      await deputy.waitFor(`Boolean(document.querySelector('[data-not-owner]'))`, {
        label: 'the member view',
      });
      await clickIn(deputy, '[data-action="close-org"]');

      // The owner appoints them.
      await page.goto(`/#/o/${id}`, { ready: SETTLED });
      await click('[data-action="org-people"]');
      await page.waitFor(`Boolean(document.querySelector('[data-action="make-co-owner"]'))`, {
        label: 'a member who can be made a second owner',
      });
      await click('[data-action="make-co-owner"]');
      await page.waitFor(`Boolean(document.querySelector('[data-action="unmake-co-owner"]'))`, {
        label: 'the appointment to land',
        context: `document.querySelector('.share-people')?.innerText`,
      });

      // Now the deputy gets the owner's half of the dialog...
      await deputy.goto(`/#/o/${id}`, { ready: SETTLED });
      await clickIn(deputy, '[data-action="org-people"]');
      await deputy.waitFor(`Boolean(document.querySelector('[data-org-url]'))`, {
        label: 'the second owner to be given the link',
      });

      // ...and not the four controls that stayed with the first.
      assert.deepEqual(
        await deputy.eval(`['delete-org', 'rename-org', 'make-owner', 'make-co-owner']
          .filter((a) => document.querySelector('[data-action="' + a + '"]'))`),
        [],
        'a second owner was offered controls that are not theirs',
      );
      assert.equal(
        await deputy.eval(`Boolean(document.querySelector('[data-second-owner]'))`),
        true,
        'nothing said why those controls are missing',
      );

      // Taking it back puts them where they were.
      await page.goto(`/#/o/${id}`, { ready: SETTLED });
      await click('[data-action="org-people"]');
      await page.waitFor(`Boolean(document.querySelector('[data-action="unmake-co-owner"]'))`, {
        label: 'the appointment to still be there',
      });
      await click('[data-action="unmake-co-owner"]');
      await page.waitFor(`Boolean(document.querySelector('[data-action="make-co-owner"]'))`, {
        label: 'the appointment to be taken back',
      });

      await deputy.goto(`/#/o/${id}`, { ready: SETTLED });
      await clickIn(deputy, '[data-action="org-people"]');
      await deputy.waitFor(`Boolean(document.querySelector('[data-not-owner]'))`, {
        label: 'the member view to come back',
      });
    } finally {
      await deputy.close();
    }
  });

  /**
   * Handing an organization over, through the dialog.
   *
   * The rules are covered in test/db/ and the round trip in test/node/. What
   * only a browser answers is the bit that is easy to get wrong on this side:
   * the screen the outgoing owner is left looking at. Every control in this
   * dialog was theirs a moment ago and none of them is now, so a dialog that
   * kept showing the link and the roster would be offering buttons the
   * database will refuse.
   */
  test('handing it over leaves the outgoing owner looking at a member’s dialog', async () => {
    const { id, name } = await newOrg();
    const join = await inviteLink();

    const heir = await aRegisteredPage();
    try {
      await heir.goto(join, { ready: SETTLED });
      await heir.waitFor(`location.hash === '#/o/${id}'`, { label: 'the heir to join' });

      // Back on the owner's page: hand it over.
      await page.goto(`/#/o/${id}`, { ready: SETTLED });
      await click('[data-action="org-people"]');
      await page.waitFor(`Boolean(document.querySelector('[data-action="make-owner"]'))`, {
        label: 'a member who can be made owner',
      });

      await page.eval('window.confirm = () => true');
      await click('[data-action="make-owner"]');

      // The dialog discovers it is not theirs, because people() now answers
      // nobody — which is the same thing any member sees.
      await page.waitFor(`Boolean(document.querySelector('[data-not-owner]'))`, {
        label: 'the dialog to become a member’s',
        context: `document.querySelector('.share')?.innerText`,
      });
      assert.equal(
        await page.eval(`Boolean(document.querySelector('[data-action="delete-org"]'))`),
        false,
        'the former owner was still offered Delete organization',
      );

      // And the organization is still theirs to open — handing over is not
      // leaving.
      await page.goto(`/#/o/${id}`, { ready: SETTLED });
      assert.equal(await scope(), name, 'the organization stopped being one they can open');
      assert.equal(
        await page.eval(`[...document.querySelectorAll('[data-action="scope"] option')]
          .some(o => o.value === ${JSON.stringify(id)})`),
        true,
        'handing it over dropped it from the switcher',
      );

      // The heir now holds what the owner held.
      await heir.goto(`/#/o/${id}`, { ready: SETTLED });
      await clickIn(heir, '[data-action="org-people"]');
      await heir.waitFor(`Boolean(document.querySelector('[data-action="delete-org"]'))`, {
        label: 'the heir to be offered the owner’s controls',
      });
    } finally {
      await heir.close();
    }
  });

  test('renaming it is what the switcher and the heading show afterwards', async () => {
    const { id } = await newOrg();
    const renamed = uniqueName('Renamed');

    await click('[data-action="org-people"]');
    await page.waitFor(`!document.querySelector('[data-org-dialog] [data-loading]')`, {
      label: 'the dialog to load',
    });
    await page.eval(`window.prompt = () => ${JSON.stringify(renamed)}`);
    await click('[data-action="rename-org"]');

    await page.waitFor(
      `document.querySelector('[data-scope-name]').textContent === ${JSON.stringify(renamed)}`,
      { label: 'the heading to follow the rename' },
    );

    await page.goto(`/#/o/${id}`, { ready: SETTLED });
    assert.equal(await scope(), renamed);
  });

  /** Every reason gets one answer, so the page is not somewhere to test guesses. */
  test('a link that buys nothing says so', async () => {
    await page.goto(`/#/join/org/${'0'.repeat(32)}`, {
      ready: "Boolean(document.querySelector('[data-join-failed]'))",
    });

    assert.match(await page.eval('document.body.innerText'), /does not work/);
  });

  test('an organization that is not yours is not somewhere you can look', async () => {
    await page.goto('/#/o/notmine', {
      ready: "Boolean(document.querySelector('[data-no-org]'))",
    });

    await click('[data-action="back-personal"]');
    await page.waitFor(`location.hash === '#/'`, { label: 'the personal list' });
  });

  /**
   * A guest cannot make one, and has to be told rather than left looking at a
   * button that did nothing. Last, because it signs the account out and the
   * rest of the suite depends on being registered.
   */
  test('a guest is told why they cannot create one', async () => {
    await click('[data-action="sign-out"]');
    await page.waitFor("Boolean(document.querySelector('[data-account-gate]'))", {
      label: 'the gate to come back',
    });

    // The gate's own way through, which is what a first visit takes silently.
    await click('[data-action="continue-as-guest"]');
    await page.waitFor(SETTLED, { label: 'the guest to be let in' });

    await page.eval(`window.prompt = () => 'Ghosts'`);
    await click('[data-action="new-org"]');
    await page.waitFor(`Boolean(document.querySelector('[data-error]'))`, {
      label: 'the refusal to be reported',
    });

    assert.match(await errorText(), /Registered accounts/);
    assert.equal(await page.eval(`location.hash`), '#/', 'a guest was navigated into an organization');
  });
});
