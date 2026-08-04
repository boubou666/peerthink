import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '@supabase/supabase-js';

import { DEFAULT_TITLE } from '../../src/platform/storage.js';
import { createSupabaseRepository } from '../../src/platform/supabase-repository.js';
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

  describe('save and load', () => {
    test('a first save creates the board, and load hands it back', async () => {
      const id = newId();
      const doc = board({ objects: [card('c1')], order: ['c1'] });

      assert.equal(await alice.repository.save(id, doc), true);

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
      assert.deepEqual(Object.keys(mine[0]).sort(), ['id', 'title', 'updatedAt']);
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
