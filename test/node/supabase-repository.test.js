import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TITLE } from '../../src/platform/storage.js';
import { createSupabaseRepository } from '../../src/platform/supabase-repository.js';
import { createSupabaseClient } from '../../src/platform/supabase.js';
import { localSupabase } from '../helpers/supabase.js';

/**
 * The server-backed repository, against a real Postgres over a real PostgREST.
 *
 * These are the same assertions the Web Storage repository answers in
 * storage.test.js — the point of one contract is that both sides satisfy it —
 * plus the ones only a shared database can have: that a board is invisible to
 * the person who does not own it, and that two writers racing the same new
 * board both come away with it saved.
 *
 * Two clients, two anonymous users, no service role. Everything here runs with
 * exactly the authority the browser has, so a policy that would refuse the app
 * refuses this too.
 */
const stack = localSupabase();

describe('supabase repository', { skip: stack ? false : 'no local supabase (npx supabase start)' }, () => {
  let alice;
  let bob;
  const created = [];

  /** A signed-in client and a repository on top of it, as the shell builds it. */
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

  const board = (extra = {}) => ({ v: 1, order: [], objects: [], ...extra });
  const card = (id, text = 'hello') => ({ id, type: 'card', x: 0, y: 0, w: 100, h: 60, text });

  // Ids are client-generated and the column constrains their shape, so these
  // look like the real thing rather than being anything the test made up.
  let n = 0;
  const newId = () => {
    const id = `t${process.pid.toString(36)}${(n++).toString(36)}${Date.now().toString(36)}`;
    created.push(id);
    return id;
  };

  before(async () => {
    alice = await signIn();
    bob = await signIn();
  });

  after(async () => {
    // Anonymous users cannot be deleted without the service role, but their
    // boards can go — leaving rows behind would make list() grow without
    // bound across runs and eventually make these assertions meaningless.
    for (const id of created) await alice.repository.remove(id);
  });

  /**
   * Save, and if it refuses, say what the database had to say about it.
   *
   * `save()` answers false and discards the reason — deliberately, since a
   * repository answers rather than throws — so a refusal here asserts as
   * `false !== true` and nothing else. That is survivable for a failure that
   * reproduces, and this one has flaked on CI and passed on re-run, where the
   * single report is all the evidence there will ever be. So the reason is
   * fetched on the way to failing rather than reconstructed afterwards from a
   * run nobody can repeat.
   */
  const savedOrWhy = async (user, id, doc, options) => {
    if (await user.repository.save(id, doc, options)) return;

    // The read is allowed to fail without taking the refusal with it. A
    // diagnostic that throws would replace "save was refused" — the thing
    // actually being reported — with whatever went wrong while explaining it.
    const detail = await user.client
      .from('boards')
      .select('id, owner_id, version')
      .eq('id', id)
      .then(({ data, error }) => `row = ${JSON.stringify(data ?? null)}, read error = ${error?.message ?? 'none'}`)
      .catch((error) => `the row could not be read back either: ${error.message}`);

    assert.fail(`save was refused for ${id} — ${detail}`);
  };

  describe('save and load', () => {
    test('a first save creates the board, and load hands it back', async () => {
      const id = newId();
      const doc = board({ objects: [card('c1')], order: ['c1'] });

      await savedOrWhy(alice, id, doc);

      const record = await alice.repository.load(id);
      assert.deepEqual(record.board, doc);
      assert.equal(record.id, id);
      assert.equal(record.title, DEFAULT_TITLE, 'a save with no title takes the default');
      assert.ok(record.updatedAt > 0, 'updatedAt was not stamped');
    });

    test('a later save updates in place rather than adding a second row', async () => {
      const id = newId();
      await alice.repository.save(id, board(), { title: 'Roadmap' });
      await alice.repository.save(id, board({ objects: [card('c1')], order: ['c1'] }));

      const record = await alice.repository.load(id);
      assert.equal(record.board.order.length, 1);
      // the whole reason save() patches instead of upserting: autosave passes
      // no title, and must not be able to reset one
      assert.equal(record.title, 'Roadmap');
      assert.equal((await alice.repository.list()).filter((b) => b.id === id).length, 1);
    });

    test('a save with a title sets it', async () => {
      const id = newId();
      assert.equal(await alice.repository.save(id, board(), { title: 'Q3' }), true);
      assert.equal((await alice.repository.load(id)).title, 'Q3');
    });

    test('a document that is not a board is refused before it reaches the wire', async () => {
      const id = newId();
      for (const junk of [null, undefined, {}, { objects: [] }, { order: [] }, 'board']) {
        assert.equal(await alice.repository.save(id, junk), false);
      }
      assert.equal(await alice.repository.load(id), null, 'a refused save wrote something anyway');
    });

    test('loading a board that does not exist is null, not an error', async () => {
      assert.equal(await alice.repository.load(newId()), null);
    });

    /** The id column is constrained; a save that cannot land says so. */
    test('an id the column will not accept comes back false', async () => {
      assert.equal(await alice.repository.save('not a valid id!', board()), false);
    });
  });

  describe('list', () => {
    test('is newest first, and summarises rather than loading', async () => {
      const older = newId();
      const newer = newId();
      await alice.repository.save(older, board(), { title: 'Older' });
      await alice.repository.save(newer, board(), { title: 'Newer' });

      const mine = (await alice.repository.list()).filter((b) => [older, newer].includes(b.id));
      assert.deepEqual(mine.map((b) => b.title), ['Newer', 'Older']);
      assert.deepEqual(Object.keys(mine[0]).sort(), ['id', 'owned', 'title', 'updatedAt']);
    });

    /**
     * The list is where "delete" and "leave" are chosen between, so it has to
     * say which of the two a board is.
     */
    test('says which boards are yours', async () => {
      const mine = newId();
      await alice.repository.save(mine, board());

      const theirs = newId();
      await alice.repository.save(theirs, board());
      await alice.client.from('board_members').insert({ board_id: theirs, user_id: bob.id, role: 'editor' });

      const forBob = await bob.repository.list();
      assert.deepEqual(forBob.filter((b) => b.id === theirs).map((b) => b.owned), [false]);
      assert.equal(forBob.some((b) => b.id === mine), false);

      const forAlice = await alice.repository.list();
      assert.deepEqual(
        forAlice.filter((b) => [mine, theirs].includes(b.id)).map((b) => b.owned),
        [true, true],
      );
    });

    test('a save moves a board back to the front', async () => {
      const first = newId();
      const second = newId();
      await alice.repository.save(first, board());
      await alice.repository.save(second, board());
      await alice.repository.save(first, board({ objects: [card('c1')], order: ['c1'] }));

      const ids = (await alice.repository.list()).map((b) => b.id);
      assert.ok(ids.indexOf(first) < ids.indexOf(second), 'updated_at was not restamped');
    });

    /**
     * The one call in either repository that reports failure by rejecting.
     *
     * It used to answer [], which the board list can only render as "No boards
     * yet" — an account declared empty because the query did not come back. A
     * missing table is a real PostgREST error rather than a stubbed one, so
     * this exercises the path the network failure takes, not a mock of it.
     */
    test('a read that fails rejects instead of reporting an empty account', async () => {
      const id = newId();
      await alice.repository.save(id, board());

      const broken = createSupabaseRepository({
        client: alice.client,
        auth: { current: () => ({ id: alice.id }) },
        table: 'boards_that_do_not_exist',
      });

      await assert.rejects(() => broken.list(), /could not list boards/);

      // And the working repository still answers, so the rejection is the
      // failure talking rather than this account genuinely having nothing.
      assert.equal((await alice.repository.list()).some((b) => b.id === id), true);
    });
  });

  /**
   * The failure that could destroy a document rather than misreport one.
   *
   * A null load is answered upstream by seeding a starter board, and a board
   * this repository never read has no version recorded — so saving it back is
   * unguarded and lands on whatever is there. Rejecting is what keeps a failed
   * read from becoming a write.
   */
  describe('a load that fails', () => {
    const broken = (who) => createSupabaseRepository({
      client: who.client,
      auth: { current: () => ({ id: who.id }) },
      table: 'boards_that_do_not_exist',
    });

    test('rejects instead of reporting a board that is not there', async () => {
      const id = newId();
      await alice.repository.save(id, board({ objects: [card('c1')], order: ['c1'] }));

      await assert.rejects(() => broken(alice).load(id), /could not load board/);
    });

    test('a board that is genuinely absent still answers null', async () => {
      assert.equal(await alice.repository.load(newId()), null);
    });

    /**
     * What the rejection is protecting against, stated as the write it stops.
     *
     * This is the second half of the danger and it is real on its own: a
     * repository that never read a board writes without a version guard, so
     * the starter document a caller would seed lands on top of the stored one.
     * That behaviour is correct — it is how a board gets created — which is
     * exactly why `load()` must not hand back null for a read that failed.
     *
     * `app.js` is where the two halves meet, and the browser test there holds
     * the other end: a throwing load never wires autosave.
     */
    test('an unread board is written unguarded, which is what the rejection prevents', async () => {
      const id = newId();
      await alice.repository.save(id, board({ objects: [card('c1', 'the real work')], order: ['c1'] }));

      // A second repository on the same account, exactly like a fresh page
      // load — it has read nothing, so it holds no version for this board.
      const fresh = createSupabaseRepository({
        client: alice.client,
        auth: { current: () => ({ id: alice.id }) },
      });

      assert.equal(await fresh.save(id, board()), true, 'the unguarded write did not land');
      const reread = await alice.repository.load(id);
      assert.deepEqual(reread.board.objects, [], 'the starter board did not overwrite');
    });
  });

  describe('rename', () => {
    test('renames, and stamps the board as touched', async () => {
      const id = newId();
      await alice.repository.save(id, board(), { title: 'Before' });

      assert.equal(await alice.repository.rename(id, 'After'), true);
      assert.equal((await alice.repository.load(id)).title, 'After');
    });

    test('is false for a board that does not exist', async () => {
      assert.equal(await alice.repository.rename(newId(), 'Nothing'), false);
    });
  });

  describe('remove', () => {
    test('removes, and the board stops being listed', async () => {
      const id = newId();
      await alice.repository.save(id, board());

      assert.equal(await alice.repository.remove(id), true);
      assert.equal(await alice.repository.load(id), null);
      assert.equal((await alice.repository.list()).some((b) => b.id === id), false);
    });

    test('removing what is already gone is not a failure', async () => {
      assert.equal(await alice.repository.remove(newId()), true);
    });
  });

  describe('other people', () => {
    test('a board is invisible to someone it was not shared with', async () => {
      const id = newId();
      await alice.repository.save(id, board({ objects: [card('c1')], order: ['c1'] }));

      assert.equal(await bob.repository.load(id), null);
      assert.equal((await bob.repository.list()).some((b) => b.id === id), false);
    });

    /**
     * The one that would be a data-loss bug rather than an access one: Bob
     * cannot see the board, so his save finds nothing to update and falls
     * through to the insert — which must not overwrite Alice's row.
     */
    test("a stranger's save cannot land on a board that already exists", async () => {
      const id = newId();
      const mine = board({ objects: [card('c1')], order: ['c1'] });
      await alice.repository.save(id, mine);

      assert.equal(await bob.repository.save(id, board({ objects: [], order: [] })), false);
      assert.deepEqual((await alice.repository.load(id)).board, mine, "Alice's board was overwritten");
    });

    test('a stranger cannot rename or delete', async () => {
      const id = newId();
      await alice.repository.save(id, board(), { title: 'Mine' });

      assert.equal(await bob.repository.rename(id, 'Yours'), false);
      await bob.repository.remove(id);

      const record = await alice.repository.load(id);
      assert.ok(record, 'the board was deleted by someone who does not own it');
      assert.equal(record.title, 'Mine');
    });
  });

  /**
   * Two tabs, one new board, no row yet: both updates find nothing and both
   * insert. One loses on the primary key and has to notice that the row it
   * wanted now exists rather than reporting a failed save.
   */
  /**
   * The half of write authority that election cannot provide.
   *
   * Election stops the overwrite while everyone can see each other. This stops
   * it when they cannot: a client that has lost the live channel elects itself
   * and keeps autosaving a document that has fallen behind. It writes the
   * version it last read, and there is no longer a row at that version.
   */
  describe('write authority', () => {
    /** Bob, editing the same board as an invited editor. */
    const shared = async () => {
      const id = newId();
      await alice.repository.save(id, board(), { title: 'Shared' });
      const { error } = await alice.client
        .from('board_members')
        .insert({ board_id: id, user_id: bob.id, role: 'editor' });
      assert.ok(!error, `could not share: ${error?.message}`);
      return id;
    };

    test('a save from a version that has moved on is refused', async () => {
      const id = await shared();
      await alice.repository.load(id);
      await bob.repository.load(id);

      const his = board({ objects: [card('b1')], order: ['b1'] });
      assert.equal(await bob.repository.save(id, his), true);

      // Alice has not seen Bob's write; hers is the document she loaded
      assert.equal(await alice.repository.save(id, board({ objects: [card('a1')], order: ['a1'] })), false);
      assert.deepEqual((await bob.repository.load(id)).board, his, "Bob's work was overwritten");
    });

    test('a writer that keeps up keeps writing', async () => {
      const id = await shared();
      await alice.repository.load(id);

      for (const text of ['one', 'two', 'three']) {
        assert.equal(
          await alice.repository.save(id, board({ objects: [card('c1', text)], order: ['c1'] })),
          true,
          `save "${text}" was refused`,
        );
      }
      assert.equal((await alice.repository.load(id)).board.objects[0].text, 'three');
    });

    test('a refused writer can carry on once it has read the board again', async () => {
      const id = await shared();
      await alice.repository.load(id);
      await bob.repository.load(id);
      await bob.repository.save(id, board({ objects: [card('b1')], order: ['b1'] }));

      assert.equal(await alice.repository.save(id, board()), false);

      // re-reading is what re-earns the claim
      await alice.repository.load(id);
      assert.equal(await alice.repository.save(id, board({ objects: [card('a1')], order: ['a1'] })), true);
    });

    /**
     * The counter is on the document. A rename is not a competing edit to it,
     * and treating one as though it were would refuse the next honest save.
     */
    test('a rename by someone else does not refuse the writer', async () => {
      const id = await shared();
      await alice.repository.load(id);

      assert.equal(await bob.repository.rename(id, 'Renamed by Bob'), true);

      assert.equal(await alice.repository.save(id, board({ objects: [card('a1')], order: ['a1'] })), true);
      assert.equal((await alice.repository.load(id)).title, 'Renamed by Bob', 'the rename was lost');
    });

    test('a save of an unchanged document does not spend a version', async () => {
      const id = await shared();
      await alice.repository.load(id);
      const same = board({ objects: [card('c1')], order: ['c1'] });

      assert.equal(await alice.repository.save(id, same), true);
      assert.equal(await bob.repository.load(id) && await bob.repository.save(id, same), true);
      // Bob's save changed nothing, so Alice's claim is still current
      assert.equal(await alice.repository.save(id, same), true);
    });

    /**
     * Deleting is not an edit to race with — it is the board being gone. The
     * insert that creates a board must not be reachable from a client that
     * has one open, or a stray autosave brings back what its owner deleted.
     */
    test('a board deleted underneath a writer is not resurrected', async () => {
      const id = newId();
      await alice.repository.save(id, board(), { title: 'Doomed' });
      await alice.repository.load(id);
      await alice.repository.remove(id);

      assert.equal(await alice.repository.save(id, board({ objects: [card('c1')], order: ['c1'] })), false);
      assert.equal(await alice.repository.load(id), null, 'the board came back');
    });
  });

  test('two writers racing the same new board both come away saved', async () => {
    const id = newId();
    const [first, second] = await Promise.all([
      alice.repository.save(id, board({ objects: [card('a')], order: ['a'] })),
      alice.repository.save(id, board({ objects: [card('b')], order: ['b'] })),
    ]);

    assert.deepEqual([first, second], [true, true]);
    assert.equal((await alice.repository.load(id)).board.order.length, 1);
  });

  test('a repository with no account cannot create a board', async () => {
    const signedOut = createSupabaseRepository({
      client: alice.client,
      auth: { current: () => null },
    });

    assert.equal(await signedOut.save(newId(), board()), false);
  });

  test('migrateLegacy has nothing to adopt', async () => {
    assert.equal(await alice.repository.migrateLegacy({ toId: 'default' }), false);
  });
});
