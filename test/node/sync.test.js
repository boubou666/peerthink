import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '@supabase/supabase-js';

import { REMOTE, Store } from '../../src/core/store.js';
import { createManualScheduler } from '../../src/core/scheduler.js';
import { createSupabaseRepository } from '../../src/platform/supabase-repository.js';
import { createBoardSync, electWriter, topicFor } from '../../src/platform/sync.js';
import { localSupabase } from '../helpers/supabase.js';

/**
 * Two people on one board, over real Realtime.
 *
 * Nothing is stubbed: two signed-in clients, a private channel, and the
 * authorization policy from the migration deciding who gets to join it. The
 * claims worth proving are the ones a fake channel would have granted for
 * free — that an op crosses, that it does not come straight back, that it
 * stays out of the receiver's undo stack, and that someone with no access to
 * the board cannot listen to it.
 */
const stack = localSupabase();

describe('board sync', { skip: stack ? false : 'no local supabase (npx supabase start)' }, () => {
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
      repository: createSupabaseRepository({ client, auth: { current: () => account } }),
    };
  };

  /**
   * A store wired to a board's channel, with the timers driven by hand. The
   * first op of a burst goes out on its own; `flushTimers()` is what releases
   * the ones the throttle held back.
   */
  const join = async (user, boardId, extra = {}) => {
    const store = new Store();
    const scheduler = createManualScheduler();
    const sync = createBoardSync({ client: user.client, boardId, store, scheduler, ...extra });
    const status = await sync.ready;
    return { store, scheduler, sync, status };
  };

  const card = (id, text = 'hello') => ({ id, type: 'card', x: 0, y: 0, w: 100, h: 60, text });
  const board = () => ({ v: 1, order: [], objects: [] });

  let n = 0;
  const newBoardId = () => {
    const id = `s${process.pid.toString(36)}${(n++).toString(36)}${Date.now().toString(36)}`;
    boards.push(id);
    return id;
  };

  /** Alice's board, with Bob added as an editor unless told otherwise. */
  const sharedBoard = async ({ role = 'editor' } = {}) => {
    const id = newBoardId();
    assert.equal(await alice.repository.save(id, board()), true);
    if (role) {
      const { error } = await alice.client
        .from('board_members')
        .insert({ board_id: id, user_id: bob.id, role });
      assert.ok(!error, `could not share: ${error?.message}`);
    }
    return id;
  };

  /** Poll rather than sleep: delivery is a network hop, not a known delay. */
  const waitFor = async (predicate, label, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  const settle = () => new Promise((r) => setTimeout(r, 250));

  before(async () => {
    alice = await signIn();
    bob = await signIn();
  });

  after(async () => {
    for (const id of boards) await alice.repository.remove(id);

    // A realtime socket is a live handle: leave one open and the runner
    // finishes its last test and then sits there, with nothing to report and
    // no reason to exit.
    for (const user of [alice, bob]) {
      await user.client.removeAllChannels();
      user.client.realtime.disconnect();
    }
  });

  test('an op applied by one editor arrives at the other', async () => {
    const id = await sharedBoard();
    const hers = await join(alice, id);
    const his = await join(bob, id);

    assert.equal(hers.status, 'SUBSCRIBED');
    assert.equal(his.status, 'SUBSCRIBED');

    hers.store.apply([{ t: 'add', obj: card('c1', 'from alice') }]);
    hers.scheduler.flushTimers();

    assert.ok(
      await waitFor(() => his.store.has('c1'), 'the op to arrive'),
      'the card never reached Bob',
    );
    assert.equal(his.store.get('c1').text, 'from alice');
    assert.deepEqual(his.store.order, ['c1']);

    await hers.sync.destroy();
    await his.sync.destroy();
  });

  test('a received op is not sent back, and does not become the receiver\'s undo', async () => {
    const id = await sharedBoard();
    const hers = await join(alice, id);
    const his = await join(bob, id);

    hers.store.apply([{ t: 'add', obj: card('c1') }]);
    hers.scheduler.flushTimers();
    await waitFor(() => his.store.has('c1'), 'the op to arrive');

    // Applying it locally would have queued a send; the timers are released
    // so an echo would have every chance to go out.
    his.scheduler.flushTimers();
    await settle();

    assert.equal(his.store.canUndo, false, "someone else's edit landed in Bob's history");
    assert.equal(hers.store.order.length, 1, 'the op came back and was applied twice');

    await hers.sync.destroy();
    await his.sync.destroy();
  });

  test('edits cross in both directions', async () => {
    const id = await sharedBoard();
    const hers = await join(alice, id);
    const his = await join(bob, id);

    hers.store.apply([{ t: 'add', obj: card('a1', 'hers') }]);
    hers.scheduler.flushTimers();
    his.store.apply([{ t: 'add', obj: card('b1', 'his') }]);
    his.scheduler.flushTimers();

    assert.ok(await waitFor(() => his.store.has('a1') && hers.store.has('b1'), 'both ops'));
    assert.equal(hers.store.get('b1').text, 'his');
    assert.equal(his.store.get('a1').text, 'hers');

    await hers.sync.destroy();
    await his.sync.destroy();
  });

  test('a burst of ops does not become a message each', async () => {
    const id = await sharedBoard();
    const hers = await join(alice, id);
    const his = await join(bob, id);

    let deliveries = 0;
    his.store.onOps((_ops, origin) => {
      if (origin === REMOTE) deliveries += 1;
    });

    // three ops, applied in the same throttle window
    hers.store.apply([{ t: 'add', obj: card('c1', 'first') }]);
    hers.store.apply([{ t: 'set', id: 'c1', patch: { text: 'second' } }], false);
    hers.store.apply([{ t: 'set', id: 'c1', patch: { text: 'third' } }], false);
    hers.scheduler.flushTimers();

    assert.ok(await waitFor(() => his.store.get('c1')?.text === 'third', 'the last op'));
    // the leading op goes out alone; the two behind it share the next message
    assert.ok(deliveries <= 2, `a burst of 3 ops became ${deliveries} messages`);

    await hers.sync.destroy();
    await his.sync.destroy();
  });

  test('destroy stops sending, and stops receiving', async () => {
    const id = await sharedBoard();
    const hers = await join(alice, id);
    const his = await join(bob, id);

    await his.sync.destroy();

    hers.store.apply([{ t: 'add', obj: card('c1') }]);
    hers.scheduler.flushTimers();
    await settle();

    assert.equal(his.store.has('c1'), false, 'a destroyed sync was still listening');
  });

  describe('authorization', () => {
    /**
     * The policy is the point. A private channel with no policy refuses
     * everyone, so a stranger joining a board's topic is refused by the same
     * board_role() that guards the table — not by anything in the client.
     */
    test('a stranger cannot join the channel at all', async () => {
      const id = await sharedBoard({ role: null });
      const hers = await join(alice, id);
      const his = await join(bob, id);

      assert.equal(hers.status, 'SUBSCRIBED');
      assert.notEqual(his.status, 'SUBSCRIBED', 'a stranger was let onto the board');

      hers.store.apply([{ t: 'add', obj: card('c1', 'private') }]);
      hers.scheduler.flushTimers();
      await settle();
      assert.equal(his.store.has('c1'), false, "a stranger received the board's contents");

      await hers.sync.destroy();
      await his.sync.destroy();
    });

    /** A viewer watches the board change; they do not get to change it. */
    test('a viewer receives ops but cannot send them', async () => {
      const id = await sharedBoard({ role: 'viewer' });
      const hers = await join(alice, id);
      const his = await join(bob, id);

      assert.equal(his.status, 'SUBSCRIBED', 'a viewer could not watch');

      hers.store.apply([{ t: 'add', obj: card('c1', 'from alice') }]);
      hers.scheduler.flushTimers();
      assert.ok(await waitFor(() => his.store.has('c1'), 'the op to reach the viewer'));

      his.store.apply([{ t: 'set', id: 'c1', patch: { text: 'from bob' } }]);
      his.scheduler.flushTimers();
      await settle();

      assert.equal(hers.store.get('c1').text, 'from alice', "a viewer's edit was broadcast");

      await hers.sync.destroy();
      await his.sync.destroy();
    });
  });

  test('the topic is the board, and nothing else', () => {
    assert.equal(topicFor('abc123'), 'board:abc123');
  });

  /**
   * One writer, chosen by everyone independently and reaching the same answer.
   * Election is what stops several editors autosaving over each other; the
   * version guard in the repository is what covers the case it cannot see.
   */
  describe('write authority', () => {
    test('the earliest joiner writes, and a newcomer does not take over', async () => {
      const id = await sharedBoard();
      const hers = await join(alice, id);
      await waitFor(() => hers.sync.isWriter(), 'alice to take authority');
      assert.equal(hers.sync.isWriter(), true, 'the only client on a board does not write it');

      const his = await join(bob, id);

      // both sides have to settle on the same person, from the same state
      assert.ok(
        await waitFor(() => his.sync.isWriter() === false, 'bob to stand down'),
        'two clients both believed they were the writer',
      );
      assert.equal(hers.sync.isWriter(), true, 'the incumbent lost authority to a newcomer');

      await hers.sync.destroy();
      await his.sync.destroy();
    });

    test('authority passes on when the writer leaves', async () => {
      const id = await sharedBoard();
      const taken = [];
      const hers = await join(alice, id);
      await waitFor(() => hers.sync.isWriter(), 'alice to take authority');
      const his = await join(bob, id, { onWriter: (is) => taken.push(is) });
      await waitFor(() => his.sync.isWriter() === false, 'bob to stand down');

      await hers.sync.destroy();

      assert.ok(
        await waitFor(() => his.sync.isWriter(), 'bob to take over'),
        'nobody was left writing the board',
      );
      // the handover is announced, not just observable — it is what tells the
      // new writer to save what the old one may not have got round to
      assert.deepEqual(taken, [false, true]);

      await his.sync.destroy();
    });

    /**
     * A board this client cannot join is a board it is alone on as far as it
     * can tell — and it must keep saving, or an unshared board would stop
     * being written the moment realtime was unreachable.
     */
    test('a client that cannot join the channel still writes', async () => {
      const id = await sharedBoard({ role: null });
      const his = await join(bob, id);

      assert.notEqual(his.status, 'SUBSCRIBED');
      assert.equal(his.sync.isWriter(), true);

      await his.sync.destroy();
    });
  });
});

describe('electWriter', () => {
  const at = (id, when) => ({ id, at: when });

  test('picks the earliest joiner', () => {
    assert.equal(electWriter([at('b', 20), at('a', 10), at('c', 30)]).id, 'a');
  });

  test('breaks a tie on id, so every client agrees', () => {
    const members = [at('b', 10), at('a', 10)];
    assert.equal(electWriter(members).id, 'a');
    assert.equal(electWriter([...members].reverse()).id, 'a');
  });

  test('an empty board elects nobody', () => {
    assert.equal(electWriter([]), null);
  });
});
