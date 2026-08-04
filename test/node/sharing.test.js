import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '@supabase/supabase-js';

import { createSharing } from '../../src/platform/sharing.js';
import { createSupabaseRepository } from '../../src/platform/supabase-repository.js';
import { localSupabase } from '../helpers/supabase.js';

/**
 * Sharing a board with somebody who is not you.
 *
 * The policies are covered directly in test/db/. What is covered here is the
 * client's half of it — that the round trip a dialog makes gives the answers
 * the dialog is written against, and that the things a non-owner must not be
 * able to do come back as refusals rather than as exceptions.
 */
const stack = localSupabase();

describe('sharing', { skip: stack ? false : 'no local supabase (npx supabase start)' }, () => {
  let alice;
  let bob;
  const boards = [];

  const signIn = async () => {
    const client = createClient(stack.url, stack.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInAnonymously();
    assert.ok(!error, `could not sign in: ${error?.message}`);

    const account = { id: data.user.id, email: null, guest: true };
    return {
      client,
      id: account.id,
      auth: { current: () => account },
      repository: createSupabaseRepository({ client, auth: { current: () => account } }),
      sharing: createSharing({ client, auth: { current: () => account } }),
    };
  };

  const board = () => ({ v: 1, order: [], objects: [] });

  let n = 0;
  const aliceBoard = async (title = 'Shared') => {
    const id = `h${process.pid.toString(36)}${(n++).toString(36)}${Date.now().toString(36)}`;
    boards.push(id);
    assert.equal(await alice.repository.save(id, board(), { title }), true);
    return id;
  };

  before(async () => {
    alice = await signIn();
    bob = await signIn();
  });

  after(async () => {
    for (const id of boards) await alice.repository.remove(id);
  });

  test('a board starts unshared', async () => {
    assert.equal(await alice.sharing.invite(await aliceBoard()), null);
  });

  test('sharing mints a link, and asking again gives the same one', async () => {
    const id = await aliceBoard();

    const made = await alice.sharing.share(id, 'editor');
    assert.match(made.token, /^[0-9a-f]{32}$/);
    assert.equal(made.role, 'editor');

    assert.deepEqual(await alice.sharing.invite(id), made);
  });

  /**
   * The link outlives a role change, on purpose: a link already pasted into a
   * chat starts granting the new role rather than quietly dying.
   */
  test('changing what the link grants keeps the link', async () => {
    const id = await aliceBoard();
    const made = await alice.sharing.share(id, 'editor');

    const changed = await alice.sharing.share(id, 'viewer');
    assert.equal(changed.token, made.token);
    assert.equal(changed.role, 'viewer');
  });

  test('redeeming puts you on the board at the role the link grants', async () => {
    const id = await aliceBoard();
    const { token } = await alice.sharing.share(id, 'viewer');

    assert.equal(await bob.repository.load(id), null, 'the board was reachable before joining');
    assert.equal(await bob.sharing.redeem(token), id);

    assert.ok(await bob.repository.load(id), 'joining did not grant access');
    assert.equal((await bob.repository.list()).some((b) => b.id === id), true);
  });

  test('a viewer can read the board and cannot write it', async () => {
    const id = await aliceBoard();
    const { token } = await alice.sharing.share(id, 'viewer');
    await bob.sharing.redeem(token);

    assert.equal(await bob.repository.save(id, board({ objects: [] })), false);
    assert.equal(await bob.repository.rename(id, 'Mine now'), false);
  });

  test('an editor can write it', async () => {
    const id = await aliceBoard();
    const { token } = await alice.sharing.share(id, 'editor');
    await bob.sharing.redeem(token);

    assert.equal(
      await bob.repository.save(id, { v: 1, order: ['c1'], objects: [{ id: 'c1', type: 'card' }] }),
      true,
    );
  });

  test('a token that buys nothing is null, and joins nothing', async () => {
    assert.equal(await bob.sharing.redeem('0'.repeat(32)), null);
    assert.equal(await bob.sharing.redeem(''), null);
  });

  describe('who is on the board', () => {
    test('the owner is listed first, and a guest is a guest', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      const people = await alice.sharing.people(id);
      assert.deepEqual(people.map((p) => p.role), ['owner', 'editor']);
      assert.deepEqual(people.map((p) => p.email), [null, null], 'anonymous users have no address');
      assert.deepEqual(people.map((p) => p.id), [alice.id, bob.id]);
    });

    /** A member asking gets nobody — which is what the dialog reads as "not yours". */
    test('a member cannot list the people on it', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      assert.deepEqual(await bob.sharing.people(id), []);
    });
  });

  describe('taking access away', () => {
    test('removing someone ends their access without touching the board', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      assert.equal(await alice.sharing.remove(id, bob.id), true);
      assert.equal(await bob.repository.load(id), null);
      assert.ok(await alice.repository.load(id), 'removing a member removed the board');
    });

    test('a member cannot remove anyone else', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      await bob.sharing.remove(id, alice.id);
      assert.equal((await alice.sharing.people(id)).length, 2, 'an editor removed the owner');
    });

    test('revoking stops the link and keeps the people', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      assert.equal(await alice.sharing.revoke(id), true);
      assert.equal(await alice.sharing.invite(id), null);
      assert.ok(await bob.repository.load(id), 'revoking the link evicted someone who had joined');

      // and the token is spent for anyone who had not used it yet
      const carol = await signIn();
      assert.equal(await carol.sharing.redeem(token), null);
    });

    test('a member can hand their own access back', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      assert.equal(await bob.sharing.leave(id), true);
      assert.equal(await bob.repository.load(id), null);
      assert.equal((await bob.repository.list()).some((b) => b.id === id), false);

      // and it is only their own access they handed back
      assert.ok(await alice.repository.load(id), 'leaving a board deleted it');
      assert.deepEqual((await alice.sharing.people(id)).map((p) => p.role), ['owner']);
    });

    test('leaving twice, or leaving a board you were never on, is false', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      assert.equal(await bob.sharing.leave(id), true);
      assert.equal(await bob.sharing.leave(id), false);

      const carol = await signIn();
      assert.equal(await carol.sharing.leave(id), false);
    });

    /**
     * An owner has no membership row to hand back, and a board with no owner
     * is one nobody can share or delete. Getting rid of your own board is
     * what delete is for.
     */
    test('an owner cannot leave their own board', async () => {
      const id = await aliceBoard();

      assert.equal(await alice.sharing.leave(id), false);
      assert.ok(await alice.repository.load(id), 'the board went anyway');
    });

    test('leaving and coming back needs the link again', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);
      await bob.sharing.leave(id);

      assert.equal(await bob.sharing.redeem(token), id);
      assert.ok(await bob.repository.load(id));
    });

    /**
     * A delete the policies refuse matches nothing and reports no error, so
     * "no error" is not "it happened" — the dialog was clearing a link that
     * was still live.
     */
    test('a refused revoke or removal says so', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      assert.equal(await bob.sharing.revoke(id), false, 'a member revoked their owner\'s link');
      assert.ok(await alice.sharing.invite(id), 'the link was actually revoked');

      assert.equal(await bob.sharing.remove(id, alice.id), false);
      assert.equal((await alice.sharing.people(id)).length, 2);
    });

    test('revoking what is not there is not a success', async () => {
      const id = await aliceBoard();
      assert.equal(await alice.sharing.revoke(id), false, 'revoked a link that never existed');

      await alice.sharing.share(id, 'editor');
      assert.equal(await alice.sharing.revoke(id), true);
      assert.equal(await alice.sharing.revoke(id), false, 'revoked the same link twice');
    });

    /** Sharing is the owner's alone; an editor cannot hand the board on. */
    test('a member cannot mint a link of their own', async () => {
      const id = await aliceBoard();
      const { token } = await alice.sharing.share(id, 'editor');
      await bob.sharing.redeem(token);

      assert.equal(await bob.sharing.share(id, 'editor'), null);
      assert.equal(await bob.sharing.invite(id), null, 'a member could read the link');
    });
  });

  test('a repository with no account cannot share', async () => {
    const signedOut = createSharing({ client: alice.client, auth: { current: () => null } });
    assert.equal(await signedOut.share(await aliceBoard(), 'editor'), null);
  });
});
