import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createOrganizations } from '../../src/platform/organizations.js';
import { createSupabaseRepository } from '../../src/platform/supabase-repository.js';
import { createSupabaseClient } from '../../src/platform/supabase.js';
import { localSupabase } from '../helpers/supabase.js';

/**
 * Organizations, against a real stack.
 *
 * The policies are covered directly in test/db/. What is covered here is the
 * client's half: that the round trip a dialog makes gives back the answers the
 * dialog is written against, and that the things a non-owner must not be able
 * to do come back as refusals rather than as exceptions.
 *
 * The interesting case throughout is the one sharing a board cannot express —
 * access granted once, arriving at boards that did not exist when it was
 * granted.
 */
const stack = localSupabase();

describe('organizations', { skip: stack ? false : 'no local supabase (npx supabase start)' }, () => {
  let alice;
  let bob;
  const made = [];

  /**
   * A signed-in person, with the adapters the app would hand them.
   *
   * `registered` is the one distinction this feature makes: creating an
   * organization needs a real account, so alice signs up with an address and
   * bob stays the anonymous guest every visitor starts as. Local dev has
   * `enable_confirmations = false`, so a sign-up is a session immediately.
   */
  const signIn = async ({ registered = false } = {}) => {
    const client = createSupabaseClient(stack);

    const { data, error } = registered
      ? await client.auth.signUp({
        email: `org-${randomUUID()}@example.test`,
        password: randomUUID(),
      })
      : await client.auth.signInAnonymously();
    assert.ok(!error, `could not sign in: ${error?.message}`);
    assert.ok(data.session, 'expected a session; are email confirmations on?');

    const account = { id: data.user.id, email: data.user.email || null, guest: !registered };
    const auth = { current: () => account };
    return {
      client,
      id: account.id,
      auth,
      organizations: createOrganizations({ client, auth }),
      repository: createSupabaseRepository({ client, auth }),
    };
  };

  const board = () => ({ v: 1, order: [], objects: [] });

  let n = 0;
  /** Every board these tests plant, so `after` can take them away again. */
  const planted = [];

  /** A short id in the shape the constraint wants, unique across parallel runs. */
  const newId = (prefix) => {
    const id = `${prefix}${process.pid.toString(36)}${(n++).toString(36)}${Date.now().toString(36)}`
      .slice(0, 60);
    // Recorded here rather than at each save, because every board id in this
    // file comes through here and several of the saves are meant to fail.
    if (prefix === 'b') planted.push(id);
    return id;
  };

  const anOrg = async (name = 'Acme', by = alice) => {
    const id = newId('o');
    const org = await by.organizations.create(id, name);
    assert.ok(org, 'the fixture could not create an organization');
    made.push(id);
    return id;
  };

  before(async () => {
    alice = await signIn({ registered: true });
    bob = await signIn();
  });

  after(async () => {
    /**
     * Boards first, while alice may still hold what owning the organization
     * buys — deleting the organization hands each board back to whoever made
     * it rather than deleting it, so they genuinely do have to go separately.
     *
     * Both suite accounts are asked for every id: they own all but one of the
     * boards here between them, and `remove` on somebody else's board is a
     * delete the policies match nothing for, which is a no-op rather than an
     * error.
     */
    for (const id of planted) {
      await alice.repository.remove(id);
      await bob.repository.remove(id);
    }
    for (const id of made) await alice.organizations.remove(id);
  });

  describe('making one', () => {
    test('a registered user can, and is its owner', async () => {
      const id = newId('o');
      made.push(id);

      // `primary` is the one distinction above this file: 'owner' is what
      // org_role() answers for both owners, and `primary` is who owns the row.
      assert.deepEqual(await alice.organizations.create(id, 'Acme'), {
        id,
        name: 'Acme',
        role: 'owner',
        primary: true,
      });
      assert.deepEqual(
        (await alice.organizations.list()).find((o) => o.id === id),
        { id, name: 'Acme', role: 'owner', primary: true },
      );
    });

    /**
     * The refusal comes from the policy, and it has to arrive as an answer
     * rather than as an exception — the form is written against null, and a
     * throw here would take the page down instead of showing the message.
     */
    test('a guest cannot, and is told so rather than crashed', async () => {
      assert.equal(await bob.organizations.create(newId('o'), 'Ghosts'), null);
    });

    test('with nobody signed in, there is nothing to own it', async () => {
      const signedOut = createOrganizations({ client: alice.client, auth: { current: () => null } });
      assert.equal(await signedOut.create(newId('o'), 'Nobody'), null);
      assert.deepEqual(await signedOut.list(), []);
    });

    test('an unnamed organization is refused', async () => {
      assert.equal(await alice.organizations.create(newId('o'), '   '), null);
    });
  });

  describe('the link', () => {
    test('starts absent, and asking again gives the same one', async () => {
      const id = await anOrg();
      assert.equal(await alice.organizations.invite(id), null);

      const link = await alice.organizations.share(id, 'editor');
      assert.match(link.token, /^[0-9a-f]{32}$/);
      assert.deepEqual(await alice.organizations.invite(id), link);
    });

    /** A link already pasted into a chat starts granting the new role rather than dying. */
    test('changing what it grants keeps the link', async () => {
      const id = await anOrg();
      const first = await alice.organizations.share(id, 'editor');

      const changed = await alice.organizations.share(id, 'viewer');
      assert.equal(changed.token, first.token);
      assert.equal(changed.role, 'viewer');
    });

    test('a member cannot mint one, or read the owner’s', async () => {
      const id = await anOrg();
      const { token } = await alice.organizations.share(id, 'editor');
      await bob.organizations.redeem(token);

      assert.equal(await bob.organizations.share(id, 'editor'), null);
      assert.equal(await bob.organizations.invite(id), null, 'a member could read the link');
      assert.equal(await bob.organizations.revoke(id), false);
      assert.ok(await alice.organizations.invite(id), 'the link was actually revoked');
    });

    test('revoking stops the link and keeps the people', async () => {
      const id = await anOrg();
      const { token } = await alice.organizations.share(id, 'editor');
      await bob.organizations.redeem(token);

      assert.equal(await alice.organizations.revoke(id), true);
      assert.equal(await alice.organizations.invite(id), null);
      assert.equal(await alice.organizations.revoke(id), false, 'revoked the same link twice');

      assert.equal((await bob.organizations.list()).some((o) => o.id === id), true,
        'revoking the link evicted someone who had joined');

      const carol = await signIn();
      assert.equal(await carol.organizations.redeem(token), null);
    });

    test('a token that buys nothing is null', async () => {
      assert.equal(await bob.organizations.redeem('0'.repeat(32)), null);
      assert.equal(await bob.organizations.redeem(''), null);
    });
  });

  /**
   * The whole point of the feature, and the thing a board link cannot do:
   * one grant, and every board — including the ones made afterwards.
   */
  describe('what joining buys', () => {
    test('a guest can follow the link and reach the boards', async () => {
      const org = await anOrg();
      const before = newId('b');
      assert.equal(await alice.repository.save(before, board(), { title: 'Before', orgId: org }), true);

      const { token } = await alice.organizations.share(org, 'editor');
      assert.equal(await bob.organizations.redeem(token), org);

      assert.ok(await bob.repository.load(before), 'joining did not reach the board');

      const after = newId('b');
      await alice.repository.save(after, board(), { title: 'After', orgId: org });
      assert.ok(await bob.repository.load(after), 'a board made after joining was not reachable');
    });

    test('an editor can write those boards; a viewer cannot', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });

      const editor = await signIn();
      await editor.organizations.redeem((await alice.organizations.share(org, 'editor')).token);
      assert.equal(await editor.repository.save(id, { v: 1, order: ['c'], objects: [{ id: 'c' }] }), true);

      const viewer = await signIn();
      await viewer.organizations.redeem((await alice.organizations.share(org, 'viewer')).token);
      assert.ok(await viewer.repository.load(id), 'a viewer could not read');
      assert.equal(await viewer.repository.rename(id, 'Mine now'), false);
    });

    /**
     * The scope is the database's answer, not a filter the client applies —
     * so the board has to be under the organization it is in and *absent*
     * from the personal list, which is the half a client-side filter used to
     * get wrong for a board you own.
     */
    test('a board is listed under its organization and not on the personal list', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });

      const inOrg = (await alice.repository.list({ scope: org })).boards.find((b) => b.id === id);
      assert.equal(inOrg.orgId, org);
      assert.equal((await alice.repository.load(id)).orgId, org);

      const personal = (await alice.repository.list()).boards;
      assert.equal(personal.some((b) => b.id === id), false, 'it was on the personal list too');
    });

    /**
     * The case `personal` exists for: a board you own, in an organization you
     * are not in. There is no organization page you can open for it, so the
     * personal list is the only place it can appear — and `org_id is null`
     * would have left it with nowhere at all.
     */
    test('a board in an organization you are not in falls back to the personal list', async () => {
      const org = await anOrg();
      const id = newId('b');
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);
      assert.equal(await bob.repository.save(id, board(), { title: 'Bob’s', orgId: org }), true);

      assert.equal((await bob.repository.list()).boards.some((b) => b.id === id), false,
        'while he is still in it, it belongs under the organization');

      await bob.organizations.leave(org);
      assert.equal((await bob.repository.list()).boards.some((b) => b.id === id), true,
        'leaving the organization lost sight of his own board');
    });

    test('leaving gives the boards back up', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      assert.equal(await bob.organizations.leave(org), true);
      assert.equal(await bob.repository.load(id), null);
      assert.equal(await bob.organizations.leave(org), false, 'left twice');
    });

    /**
     * An owner has no membership row to hand back, and an organization with no
     * owner is one nobody can rename, share or delete.
     */
    test('an owner cannot leave their own organization', async () => {
      const org = await anOrg();
      assert.equal(await alice.organizations.leave(org), false);
      assert.equal((await alice.organizations.list()).some((o) => o.id === org), true);
    });
  });

  describe('putting boards in and taking them out', () => {
    test('the owner can move their own board in, and back out', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Personal' });

      assert.equal(await alice.repository.move(id, org), true);
      assert.equal((await alice.repository.load(id)).orgId, org);

      assert.equal(await alice.repository.move(id, null), true);
      assert.equal((await alice.repository.load(id)).orgId, null);
    });

    /**
     * `freeze_board_org` raises rather than matching no rows, so this is the
     * path where PostgREST reports an error and `move` still has to answer
     * false instead of throwing out of a total method.
     */
    test('a member cannot walk off with a board, and is not crashed for trying', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      assert.equal(await bob.repository.move(id, null), false);
      assert.equal((await alice.repository.load(id)).orgId, org, 'the board moved anyway');
    });

    test('a board cannot be moved into an organization you are not in', async () => {
      const org = await anOrg();
      const id = newId('b');
      assert.equal(await bob.repository.save(id, board(), { title: 'Bob’s' }), true);

      assert.equal(await bob.repository.move(id, org), false);
      assert.equal((await bob.repository.load(id)).orgId, null);
    });

    test('a guest editor can create a board in the organization', async () => {
      const org = await anOrg();
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      const id = newId('b');
      assert.equal(await bob.repository.save(id, board(), { title: 'Bob’s', orgId: org }), true);
      assert.ok(await alice.repository.load(id), 'the owner could not see it');
    });

    test('a viewer cannot create one there', async () => {
      const org = await anOrg();
      const viewer = await signIn();
      await viewer.organizations.redeem((await alice.organizations.share(org, 'viewer')).token);

      assert.equal(await viewer.repository.save(newId('b'), board(), { orgId: org }), false);
    });

    /**
     * Every autosave is an update, and the trigger that polices moves runs on
     * all of them. A save that names no organization must not be read as one.
     */
    test('an ordinary save by an editor is not a move', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      await bob.repository.load(id);
      assert.equal(await bob.repository.save(id, { v: 1, order: ['c'], objects: [{ id: 'c' }] }), true);
      assert.equal((await alice.repository.load(id)).orgId, org, 'a save moved the board');
    });
  });

  describe('who is in it', () => {
    test('the owner is listed first, and a guest is a guest', async () => {
      const org = await anOrg();
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      const people = await alice.organizations.people(org);
      assert.deepEqual(people.map((p) => p.role), ['owner', 'editor']);
      assert.deepEqual(people.map((p) => p.id), [alice.id, bob.id]);
      assert.equal(people[1].email, null, 'an anonymous member has no address');
    });

    /** A member asking gets nobody — which is what the dialog reads as "not yours". */
    test('a member cannot list the others', async () => {
      const org = await anOrg();
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      assert.deepEqual(await bob.organizations.people(org), []);
    });

    test('removing someone ends their access to everything in it', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      assert.equal(await alice.organizations.removeMember(org, bob.id), true);
      assert.equal(await bob.repository.load(id), null);
      assert.ok(await alice.repository.load(id), 'removing a member removed the board');
    });

    test('a member cannot remove another member', async () => {
      const org = await anOrg();
      const { token } = await alice.organizations.share(org, 'editor');
      await bob.organizations.redeem(token);

      const carol = await signIn();
      await carol.organizations.redeem(token);
      assert.equal((await alice.organizations.people(org)).length, 3, 'carol did not join');

      assert.equal(await bob.organizations.removeMember(org, carol.id), false);
      assert.equal((await alice.organizations.people(org)).length, 3, 'a member removed another');

      // nor the owner, who has no membership row to take away in the first place
      assert.equal(await bob.organizations.removeMember(org, alice.id), false);
    });
  });

  /**
   * A second owner. The split is covered exhaustively in test/db/; what
   * matters here is that the dialog gets the two answers it is written
   * against — `role` for what somebody may do, and `primary` for which
   * controls to offer.
   */
  describe('a second owner', () => {
    const aMemberOf = async (org, role = 'editor') => {
      const person = await signIn({ registered: true });
      await person.organizations.redeem((await alice.organizations.share(org, role)).token);
      return person;
    };

    test('is optional, and the owner appoints one from the members', async () => {
      const org = await anOrg();
      const carol = await aMemberOf(org);

      assert.equal((await carol.organizations.list()).find((o) => o.id === org).role, 'editor');

      assert.equal(await alice.organizations.setCoOwner(org, carol.id), true);

      const hers = (await carol.organizations.list()).find((o) => o.id === org);
      assert.deepEqual(hers, { id: org, name: 'Acme', role: 'owner', primary: false });

      // and the person who appointed her is still the one who owns the row
      assert.equal((await alice.organizations.list()).find((o) => o.id === org).primary, true);
    });

    test('runs the organization: the link, the roster and the people', async () => {
      const org = await anOrg();
      const carol = await aMemberOf(org);
      await alice.organizations.setCoOwner(org, carol.id);

      assert.ok(await carol.organizations.invite(org), 'a second owner could not read the link');
      assert.ok(await carol.organizations.share(org, 'viewer'));
      assert.deepEqual((await carol.organizations.people(org)).map((p) => p.role),
        ['owner', 'co-owner']);

      const dave = await aMemberOf(org);
      assert.equal(await carol.organizations.removeMember(org, dave.id), true);
    });

    test('and every board power in it', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });
      const carol = await aMemberOf(org);
      await alice.organizations.setCoOwner(org, carol.id);

      assert.equal(await carol.repository.move(id, null), true, 'a second owner could not move it out');
      assert.equal(await carol.repository.remove(id), true);
    });

    /** The four acts on the organization's own row are not shared. */
    test('but cannot rename, delete, transfer or appoint', async () => {
      const org = await anOrg('Before');
      const carol = await aMemberOf(org);
      const dave = await aMemberOf(org);
      await alice.organizations.setCoOwner(org, carol.id);

      assert.equal(await carol.organizations.rename(org, 'Carol’s'), false);
      assert.equal(await carol.organizations.remove(org), false);
      assert.equal(await carol.organizations.transfer(org, dave.id), false);
      assert.equal(await carol.organizations.setCoOwner(org, dave.id), false);

      // none of which happened
      const still = (await alice.organizations.list()).find((o) => o.id === org);
      assert.equal(still.name, 'Before');
      assert.equal(still.primary, true);
      assert.deepEqual((await alice.organizations.people(org)).map((p) => p.role),
        ['owner', 'co-owner', 'editor']);
    });

    test('the appointment can be taken back, and their member role returns', async () => {
      const org = await anOrg();
      const carol = await aMemberOf(org, 'viewer');
      await alice.organizations.setCoOwner(org, carol.id);
      assert.equal((await carol.organizations.list()).find((o) => o.id === org).role, 'owner');

      assert.equal(await alice.organizations.setCoOwner(org, null), true);
      assert.equal((await carol.organizations.list()).find((o) => o.id === org).role, 'viewer');
    });

    /** A Remove that left somebody running the organization would be a surprise. */
    test('leaving takes the appointment with it', async () => {
      const org = await anOrg();
      const carol = await aMemberOf(org);
      await alice.organizations.setCoOwner(org, carol.id);

      assert.equal(await carol.organizations.leave(org), true);
      assert.deepEqual((await carol.organizations.list()).filter((o) => o.id === org), []);
      assert.deepEqual((await alice.organizations.people(org)).map((p) => p.role), ['owner']);
    });

    test('a guest cannot be appointed, and is refused rather than crashed', async () => {
      const org = await anOrg();
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      assert.equal(await alice.organizations.setCoOwner(org, bob.id), false);
      assert.deepEqual((await alice.organizations.people(org)).map((p) => p.role), ['owner', 'editor']);
    });

    test('somebody who is not in the organization cannot be', async () => {
      const org = await anOrg();
      const stranger = await signIn({ registered: true });

      assert.equal(await alice.organizations.setCoOwner(org, stranger.id), false);
    });

    test('handing the organization to the second owner clears the appointment', async () => {
      const org = await anOrg();
      const carol = await aMemberOf(org);
      await alice.organizations.setCoOwner(org, carol.id);

      assert.equal(await alice.organizations.transfer(org, carol.id), true);

      const hers = (await carol.organizations.list()).find((o) => o.id === org);
      assert.deepEqual(hers, { id: org, name: 'Acme', role: 'owner', primary: true });
      assert.deepEqual((await carol.organizations.people(org)).map((p) => p.role), ['owner', 'editor']);
    });
  });

  /**
   * Handing it over. The rules are the database's and are covered in
   * test/db/; what matters here is that the dialog's round trip gives the
   * answers it is written against — and that what the outgoing owner is left
   * holding is what the confirm promised them.
   */
  describe('handing it over', () => {
    /** Someone registered and already in the organization: the only valid recipient. */
    const aMember = async (org, role = 'editor') => {
      const person = await signIn({ registered: true });
      await person.organizations.redeem((await alice.organizations.share(org, role)).token);
      return person;
    };

    test('the owner can hand it to a member, and swaps places with them', async () => {
      const org = await anOrg();
      const carol = await aMember(org);

      assert.equal(await alice.organizations.transfer(org, carol.id), true);

      assert.equal((await carol.organizations.list()).find((o) => o.id === org).role, 'owner');
      assert.equal((await alice.organizations.list()).find((o) => o.id === org).role, 'editor');
    });

    /** The whole point: what the owner could do, they can no longer do. */
    test('the powers move with it', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });
      const carol = await aMember(org);
      await alice.organizations.transfer(org, carol.id);

      assert.deepEqual(await alice.organizations.people(org), [],
        'the former owner can still read the roster');
      assert.equal(await alice.organizations.share(org, 'editor'), null);
      assert.equal(await alice.organizations.rename(org, 'Mine again'), false);
      assert.equal(await alice.organizations.remove(org), false);

      assert.deepEqual((await carol.organizations.people(org)).map((p) => p.role),
        ['owner', 'editor']);
      assert.equal(await carol.organizations.rename(org, 'Carol’s'), true);

      // and she can now delete a board she did not make, which is what owning
      // the organization buys
      assert.equal(await carol.repository.remove(id), true);
      assert.equal(await alice.repository.load(id), null);
    });

    /** Handing over is not leaving: the boards are still reachable afterwards. */
    test('the outgoing owner keeps access, as the confirm promises', async () => {
      const org = await anOrg();
      const id = newId('b');
      await alice.repository.save(id, board(), { title: 'Team', orgId: org });
      const carol = await aMember(org);

      await alice.organizations.transfer(org, carol.id);

      assert.ok(await alice.repository.load(id), 'she lost the board she was handing over');
      assert.equal((await alice.repository.list({ scope: org })).boards.some((b) => b.id === id), true);
    });

    test('a member cannot hand it to themselves', async () => {
      const org = await anOrg();
      const carol = await aMember(org);

      assert.equal(await carol.organizations.transfer(org, carol.id), false);
      assert.equal((await alice.organizations.list()).find((o) => o.id === org).role, 'owner');
    });

    test('a guest cannot be made the owner', async () => {
      const org = await anOrg();
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      assert.equal(await alice.organizations.transfer(org, bob.id), false);
      assert.equal((await alice.organizations.list()).find((o) => o.id === org).role, 'owner');
    });

    test('somebody who is not in it cannot be made the owner', async () => {
      const org = await anOrg();
      const stranger = await signIn({ registered: true });

      assert.equal(await alice.organizations.transfer(org, stranger.id), false);
    });

    /** Nothing is wrong and nothing to do — a false here would report a failure. */
    test('handing it to yourself is answered true', async () => {
      const org = await anOrg();
      assert.equal(await alice.organizations.transfer(org, alice.id), true);
      assert.equal((await alice.organizations.list()).find((o) => o.id === org).role, 'owner');
    });
  });

  describe('renaming and deleting', () => {
    test('the owner can rename it; a member cannot', async () => {
      const org = await anOrg('Before');
      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);

      assert.equal(await bob.organizations.rename(org, 'Bob’s now'), false);
      assert.equal(await alice.organizations.rename(org, 'After'), true);
      assert.equal((await alice.organizations.list()).find((o) => o.id === org).name, 'After');
    });

    /**
     * Deleting ends the sharing, not the work. The boards fall back to whoever
     * made them — which is what `on delete set null` is for, and the reason
     * this is safe to offer behind one confirm.
     */
    test('deleting hands the boards back to their creators', async () => {
      const org = await anOrg();
      const hers = newId('b');
      await alice.repository.save(hers, board(), { title: 'Hers', orgId: org });

      await bob.organizations.redeem((await alice.organizations.share(org, 'editor')).token);
      const his = newId('b');
      await bob.repository.save(his, board(), { title: 'His', orgId: org });

      assert.equal(await bob.organizations.remove(org), false, 'a member deleted the organization');
      assert.equal(await alice.organizations.remove(org), true);

      assert.equal((await alice.repository.load(hers)).orgId, null, 'her board went with it');
      assert.equal(await alice.repository.load(his), null, 'she can still see his board');
      assert.equal((await bob.repository.load(his)).orgId, null, 'his board went with it');
      assert.equal(await bob.repository.load(hers), null, 'he can still see her board');
    });
  });

  /**
   * `list()` rejects where everything else answers. The board list partitions
   * boards by which organizations you are in, so an empty answer is not a
   * harmless "none" — it is a claim that every board in a team is a personal
   * one, made on the strength of a request that never arrived.
   */
  test('a list that could not be read rejects rather than reporting none', async () => {
    const broken = createOrganizations({
      client: {
        from: () => ({
          select: () => ({
            order: async () => ({ data: null, error: { message: 'network' } }),
            eq: async () => ({ data: [], error: null }),
          }),
        }),
      },
      auth: alice.auth,
    });

    await assert.rejects(() => broken.list(), /could not list organizations/);
  });

  test('a membership read that failed rejects too', async () => {
    const broken = createOrganizations({
      client: {
        from: () => ({
          select: () => ({
            order: async () => ({ data: [], error: null }),
            eq: async () => ({ data: null, error: { message: 'network' } }),
          }),
        }),
      },
      auth: alice.auth,
    });

    await assert.rejects(() => broken.list(), /could not read your memberships/);
  });
});
