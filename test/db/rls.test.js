// Row level security, exercised as the database sees it.
//
// Every statement here runs as `authenticated` with a JWT claim, which is what
// PostgREST does for a real request — so these are the same code paths the
// browser will hit, not an approximation of them. Requires DATABASE_URL to
// point at a database the migrations have been applied to.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

const URL = process.env.DATABASE_URL;

describe('row level security', { skip: URL ? false : 'DATABASE_URL is not set' }, () => {
  let client;
  let alice;
  let bob;

  const board = (extra = {}) => ({ v: 1, order: [], objects: [], ...extra });

  /**
   * Run a statement as a signed-in user.
   *
   * `set local role` and the claim both last exactly as long as the
   * transaction, so no test can leak an identity into the next one. The
   * connection itself stays superuser, which is what lets the fixtures below
   * write rows the policies would otherwise refuse.
   */
  const as = async (userId, sql, params = []) => {
    await client.query('begin');
    try {
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        userId ? JSON.stringify({ sub: userId }) : '',
      ]);
      await client.query(`set local role ${userId ? 'authenticated' : 'anon'}`);
      const result = await client.query(sql, params);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };

  /** Assert that a statement is refused outright rather than silently doing nothing. */
  const refuses = async (userId, sql, params, match) => {
    await assert.rejects(() => as(userId, sql, params), match);
  };

  before(async () => {
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    alice = randomUUID();
    bob = randomUUID();
    await client.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [
      alice, 'alice@example.test', bob, 'bob@example.test',
    ]);
  });

  after(async () => {
    if (!client) return;
    await client.query('delete from auth.users where id = any($1)', [[alice, bob]]);
    await client.end();
  });

  beforeEach(async () => {
    await client.query('delete from public.boards');
  });

  /** Alice's board, written as superuser so the fixture is not the thing under test. */
  const givenAliceHasABoard = async (id = 'alpha', title = 'Alpha') => {
    await client.query(
      'insert into public.boards (id, owner_id, title, doc) values ($1, $2, $3, $4)',
      [id, alice, title, board()],
    );
    return id;
  };

  const share = (id, role) =>
    client.query('insert into public.board_members (board_id, user_id, role) values ($1, $2, $3)', [id, bob, role]);

  describe('boards', () => {
    test('an owner sees their own board and a stranger sees nothing', async () => {
      await givenAliceHasABoard();

      assert.equal((await as(alice, 'select id from public.boards')).rowCount, 1);
      assert.equal((await as(bob, 'select id from public.boards')).rowCount, 0);
    });

    test('no session sees nothing at all', async () => {
      await givenAliceHasABoard();
      await refuses(null, 'select id from public.boards', [], /permission denied/i);
    });

    test('a board cannot be created in someone else\'s name', async () => {
      await refuses(
        bob,
        'insert into public.boards (id, owner_id, title, doc) values ($1, $2, $3, $4)',
        ['forged', alice, 'Not mine', board()],
        /row-level security/i,
      );
    });

    test('a shared board is readable by its member', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'viewer');

      const seen = await as(bob, 'select id, title from public.boards');
      assert.equal(seen.rowCount, 1);
      assert.equal(seen.rows[0].title, 'Alpha');
    });

    test('a viewer can read but not write', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'viewer');

      const wrote = await as(bob, 'update public.boards set title = $2 where id = $1', [id, 'Hijacked']);
      assert.equal(wrote.rowCount, 0, 'the row is invisible to the update, not an error');

      const { rows } = await client.query('select title from public.boards where id = $1', [id]);
      assert.equal(rows[0].title, 'Alpha');
    });

    test('an editor can write but not delete', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'editor');

      const wrote = await as(bob, 'update public.boards set title = $2 where id = $1', [id, 'Edited']);
      assert.equal(wrote.rowCount, 1);

      const deleted = await as(bob, 'delete from public.boards where id = $1', [id]);
      assert.equal(deleted.rowCount, 0, 'an editor can empty a board but not remove it from everyone');
      assert.equal((await client.query('select 1 from public.boards where id = $1', [id])).rowCount, 1);
    });

    test('an owner can delete their own board', async () => {
      const id = await givenAliceHasABoard();
      assert.equal((await as(alice, 'delete from public.boards where id = $1', [id])).rowCount, 1);
    });

    test('an editor cannot make the board their own', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'editor');

      await refuses(
        bob,
        'update public.boards set owner_id = $2 where id = $1',
        [id, bob],
        /owner cannot be changed/,
      );
    });

    test('updated_at is stamped by the server, not by the client', async () => {
      const id = await givenAliceHasABoard();
      const before = (await client.query('select updated_at from public.boards where id = $1', [id])).rows[0].updated_at;

      // a client lying about when it wrote is how a stale board wins a merge
      await as(alice, `update public.boards set title = $2, updated_at = 'epoch' where id = $1`, [id, 'Later']);

      const after = (await client.query('select updated_at from public.boards where id = $1', [id])).rows[0].updated_at;
      assert.ok(after > before, `expected a fresh timestamp, got ${after.toISOString()}`);
    });

    test('a malformed id or document is refused', async () => {
      await refuses(
        alice,
        'insert into public.boards (id, owner_id, doc) values ($1, $2, $3)',
        ['not a valid id!', alice, board()],
        /boards_id_shape/,
      );

      await refuses(
        alice,
        'insert into public.boards (id, owner_id, doc) values ($1, $2, $3)',
        ['shapeless', alice, { v: 1, objects: 'nope' }],
        /boards_doc_shape/,
      );
    });
  });

  describe('the access function itself', () => {
    test('board_role runs with definer rights', async () => {
      // No behavioural test can catch this. Under invoker rights the policies
      // still answer correctly, because each one tests owner_id first and OR
      // short-circuits before board_role is reached — so the recursion that
      // invoker rights would cause is only ever one reordered disjunct away.
      // Asserting the property directly is the only guard against someone
      // dropping the keyword and seeing a green suite.
      const { rows } = await client.query(
        `select prosecdef from pg_proc where proname = 'board_role' and pronamespace = 'public'::regnamespace`,
      );
      assert.equal(rows.length, 1, 'board_role is defined exactly once');
      assert.equal(rows[0].prosecdef, true, 'board_role must be SECURITY DEFINER');
    });

    test('an unauthenticated caller cannot reach it', async () => {
      await refuses(null, `select public.board_role('alpha')`, [], /permission denied/i);
    });
  });

  describe('membership', () => {
    test('only the owner can share a board', async () => {
      const id = await givenAliceHasABoard();

      await refuses(
        bob,
        'insert into public.board_members (board_id, user_id, role) values ($1, $2, $3)',
        [id, bob, 'editor'],
        /row-level security/i,
      );

      const granted = await as(alice,
        'insert into public.board_members (board_id, user_id, role) values ($1, $2, $3)', [id, bob, 'editor']);
      assert.equal(granted.rowCount, 1);
    });

    test('an editor cannot promote themselves or invite others', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'editor');

      const promoted = await as(bob, 'update public.board_members set role = $3 where board_id = $1 and user_id = $2',
        [id, bob, 'editor']);
      assert.equal(promoted.rowCount, 0);

      await refuses(
        bob,
        'insert into public.board_members (board_id, user_id, role) values ($1, $2, $3)',
        [id, randomUUID(), 'editor'],
        /row-level security/i,
      );
    });

    test('a member can hand back their own access', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'editor');

      assert.equal((await as(bob, 'delete from public.board_members where board_id = $1', [id])).rowCount, 1);
      assert.equal((await as(bob, 'select id from public.boards')).rowCount, 0, 'and loses sight of the board');
    });

    test('an owner sees every member; a member sees only themselves', async () => {
      const id = await givenAliceHasABoard();
      const carol = randomUUID();
      await client.query('insert into auth.users (id) values ($1)', [carol]);
      await share(id, 'editor');
      await client.query('insert into public.board_members (board_id, user_id, role) values ($1, $2, $3)',
        [id, carol, 'viewer']);

      assert.equal((await as(alice, 'select user_id from public.board_members')).rowCount, 2);
      assert.equal((await as(bob, 'select user_id from public.board_members')).rowCount, 1);

      await client.query('delete from auth.users where id = $1', [carol]);
    });

    test('deleting a board takes its memberships with it', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'editor');

      await as(alice, 'delete from public.boards where id = $1', [id]);
      assert.equal((await client.query('select 1 from public.board_members where board_id = $1', [id])).rowCount, 0);
    });
  });
});
