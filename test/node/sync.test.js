import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { REMOTE, Store } from '../../src/core/store.js';
import { createManualScheduler } from '../../src/core/scheduler.js';
import { createSupabaseRepository } from '../../src/platform/supabase-repository.js';
import { createBoardSync, electWriter, topicFor } from '../../src/platform/sync.js';
import { createSupabaseClient } from '../../src/platform/supabase.js';
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
    // The app's own adapter, not a client this file assembles: a test that
    // builds its own is a test of a client the app does not use.
    const client = createSupabaseClient(stack);
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
    const taps = new Set();
    const sync = createBoardSync({
      client: user.client,
      boardId,
      store,
      scheduler,
      ...extra,
      onCursor: (cursor) => {
        extra.onCursor?.(cursor);
        for (const tap of taps) tap(cursor);
      },
    });
    const status = await sync.ready;
    return {
      store,
      scheduler,
      sync,
      status,
      /** Listen in on cursors without displacing whatever else is listening. */
      onCursor(fn) {
        taps.add(fn);
        return () => taps.delete(fn);
      },
    };
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

  /**
   * Poll rather than sleep: delivery is a network hop, not a known delay.
   *
   * Throws on timeout rather than answering false. Returning false made every
   * bare `await waitFor(...)` a no-op — the thing never arrived, the test
   * carried on, and whatever it asserted next passed for the wrong reason.
   */
  const waitFor = async (predicate, label, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /**
   * A barrier for "this did not arrive" assertions.
   *
   * A fixed sleep is a guess: too short and the assertion passes because the
   * message was still in flight, too long and every run pays for it. Instead a
   * cursor is sent — a message on the same channel, in the same order, that
   * touches no document — and the assertion is made once *that* has landed.
   * Whatever was supposed not to arrive has had its turn on the wire.
   */
  const overtake = async (from, to) => {
    const seen = [];
    const stop = to.onCursor((cursor) => seen.push(cursor));
    from.sync.moveCursor({ x: 1, y: 1 });
    from.scheduler.flushTimers();
    try {
      await waitFor(() => seen.length > 0, 'the barrier message to come through');
    } finally {
      stop();
    }
  };

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

    await waitFor(() => his.store.has('c1'), 'the card to reach Bob');
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
    // so an echo would have every chance to go out, and then a message that
    // *is* expected overtakes it — if that has arrived and the echo has not,
    // the echo was never sent.
    his.scheduler.flushTimers();
    await overtake(his, hers);

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

    await waitFor(() => his.store.has('a1') && hers.store.has('b1'), 'both ops to cross');
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

    await waitFor(() => his.store.get('c1')?.text === 'third', 'the last op of the burst');
    // the leading op goes out alone; the two behind it share the next message
    assert.ok(deliveries <= 2, `a burst of 3 ops became ${deliveries} messages`);

    await hers.sync.destroy();
    await his.sync.destroy();
  });

  /**
   * The receiver applies whatever arrives, so what arrives has to be checked.
   * An `add` with no `obj` used to throw inside apply() and take the session
   * with it — one bad client wedging everyone else on the board.
   */
  test('a malformed batch is dropped, and the next good one still lands', async () => {
    const id = await sharedBoard();
    const hers = await join(alice, id);
    const his = await join(bob, id);

    await hers.sync.ready;
    // sent past the store, because the store is what would have refused it
    await alice.client.channel(topicFor(id)).send({
      type: 'broadcast',
      event: 'ops',
      payload: { ops: [{ t: 'add' }, { t: 'add', obj: card('poison') }] },
    });
    await new Promise((r) => setTimeout(r, 250));

    assert.equal(his.store.order.length, 0, 'a malformed batch was half applied');

    hers.store.apply([{ t: 'add', obj: card('c1') }]);
    hers.scheduler.flushTimers();
    await waitFor(() => his.store.has('c1'), 'the receiver to still be working');

    await hers.sync.destroy();
    await his.sync.destroy();
  });

  test('destroy stops sending, and stops receiving', async () => {
    const id = await sharedBoard();
    const hers = await join(alice, id);
    const his = await join(bob, id);

    await his.sync.destroy();

    // Positive and deterministic: the channel is gone from the client, which
    // is the thing destroy() is for. Nothing can be delivered to it after
    // this, so the store check below needs no waiting to be meaningful.
    assert.equal(
      bob.client.getChannels().some((c) => c.topic === `realtime:${his.sync.topic}`),
      false,
      'the channel outlived the sync that opened it',
    );

    hers.store.apply([{ t: 'add', obj: card('c1') }]);
    hers.scheduler.flushTimers();
    await new Promise((r) => setTimeout(r, 250));

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

      // The refusal is the assertion — a channel that was never joined cannot
      // deliver anything, so the store check is a consequence of it rather
      // than a race to be waited out.
      hers.store.apply([{ t: 'add', obj: card('c1', 'private') }]);
      hers.scheduler.flushTimers();
      await new Promise((r) => setTimeout(r, 250));
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
      await waitFor(() => his.store.has('c1'), 'the op to reach the viewer');

      his.store.apply([{ t: 'set', id: 'c1', patch: { text: 'from bob' } }]);
      his.scheduler.flushTimers();
      // Alice sends something to herself-ward that Bob will see, which cannot
      // land before Bob's refused edit would have; then his edit has had its
      // chance and demonstrably did not take it.
      await overtake(hers, his);

      assert.equal(hers.store.get('c1').text, 'from alice', "a viewer's edit was broadcast");

      await hers.sync.destroy();
      await his.sync.destroy();
    });
  });

  test('the topic is the board, and nothing else', () => {
    assert.equal(topicFor('abc123'), 'board:abc123');
  });

  /**
   * Pointers share the channel with ops and share nothing else: they are not
   * applied, not recorded, and not part of the document.
   */
  describe('cursors', () => {
    test('a pointer crosses as a cursor, and changes nothing', async () => {
      const id = await sharedBoard();
      const seen = [];
      const his = await join(bob, id, { onCursor: (cursor) => seen.push(cursor) });
      const hers = await join(alice, id);

      hers.sync.moveCursor({ x: 120, y: -40 });

      await waitFor(() => seen.length > 0, 'the cursor to arrive');
      assert.deepEqual(seen[0], { id: hers.sync.clientId, x: 120, y: -40 });
      assert.equal(his.store.order.length, 0, 'a pointer became a change to the board');
      assert.equal(his.store.canUndo, false);

      await hers.sync.destroy();
      await his.sync.destroy();
    });

    test('a pointer that leaves says so', async () => {
      const id = await sharedBoard();
      const seen = [];
      const his = await join(bob, id, { onCursor: (cursor) => seen.push(cursor) });
      const hers = await join(alice, id);

      hers.sync.moveCursor({ x: 1, y: 1 });
      await waitFor(() => seen.length > 0, 'the cursor');

      hers.sync.moveCursor(null);
      hers.scheduler.flushTimers();

      await waitFor(
        () => seen.some((cursor) => cursor.gone),
        'the departure — a pointer left the board and its cursor stayed',
      );

      await hers.sync.destroy();
      await his.sync.destroy();
    });

    /** Positions are sent at pointer rate; the name is not sent with them. */
    test('presence carries the name, and does not report you to yourself', async () => {
      const id = await sharedBoard();
      const rosters = [];
      const his = await join(bob, id, { onMembers: (members) => rosters.push(members) });
      const hers = await join(alice, id, { identity: { label: 'ada@example.com' } });

      await waitFor(
        () => rosters.at(-1)?.some((member) => member.label === 'ada@example.com'),
        'alice to appear on the roster by name',
      );
      assert.equal(
        rosters.at(-1).some((member) => member.id === his.sync.clientId),
        false,
        'the roster included the client it was sent to',
      );

      await hers.sync.destroy();
      await his.sync.destroy();
    });
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
      await waitFor(
        () => his.sync.isWriter() === false,
        'bob to stand down — two clients both believed they were the writer',
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

      await waitFor(
        () => his.sync.isWriter(),
        'bob to take over — nobody was left writing the board',
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
