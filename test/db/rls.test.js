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

  describe('what anon holds', () => {
    // The behavioural test above — `no session sees nothing at all` — passes on
    // a local stack whether or not anon has been revoked, because locally the
    // grant never existed to begin with. A hosted project grants every table in
    // `public` to anon by default privilege, and that difference stayed
    // invisible until the suite was first pointed at production. Asserting the
    // privilege directly is what makes the revoke testable in both places, for
    // the same reason `prosecdef` is asserted directly above.
    for (const table of ['boards', 'board_members', 'board_invites']) {
      test(`anon holds no privilege on ${table}`, async () => {
        const { rows } = await client.query(
          `select coalesce(bool_or(has_table_privilege('anon', $1, priv)), false) as held
             from unnest(array['select', 'insert', 'update', 'delete']) as priv`,
          [`public.${table}`],
        );
        assert.equal(rows[0].held, false, `anon must hold nothing on public.${table}`);
      });
    }
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

  /**
   * Sharing by link. The token is the whole secret, so what matters is that
   * holding it is the only way it can be used — it must not be reachable by
   * looking, and it must not be usable for anything except the board and the
   * role its owner chose.
   */
  describe('invites', () => {
    const invite = async (id, role = 'editor') => {
      const { rows } = await client.query(
        'insert into public.board_invites (board_id, role, created_by) values ($1, $2, $3) returning token',
        [id, role, alice],
      );
      return rows[0].token;
    };

    const redeem = (userId, token) =>
      as(userId, 'select public.redeem_board_invite($1) as board', [token]);

    test('a token is random rather than derived from the board', async () => {
      const first = await invite(await givenAliceHasABoard('alpha'));
      const second = await invite(await givenAliceHasABoard('beta'));

      assert.match(first, /^[0-9a-f]{32}$/);
      assert.notEqual(first, second);
      assert.ok(!first.includes('alpha'), 'the token gives away the board it opens');
    });

    test('only the owner can create, read or revoke a link', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'editor');
      await invite(id);

      // an editor is on the board and still cannot see how to hand it out
      assert.equal((await as(bob, 'select token from public.board_invites')).rowCount, 0);
      assert.equal((await as(alice, 'select token from public.board_invites')).rowCount, 1);

      await refuses(
        bob,
        'insert into public.board_invites (board_id, role, created_by) values ($1, $2, $3)',
        [id, 'editor', bob],
        /row-level security/i,
      );
      await as(bob, 'delete from public.board_invites where board_id = $1', [id]);
      assert.equal((await as(alice, 'select token from public.board_invites')).rowCount, 1,
        'an editor revoked their owner\'s link');
    });

    test('redeeming joins the board at the role the link grants', async () => {
      const id = await givenAliceHasABoard();
      const token = await invite(id, 'viewer');

      assert.equal((await redeem(bob, token)).rows[0].board, id);
      assert.equal((await as(bob, 'select id from public.boards where id = $1', [id])).rowCount, 1);
      assert.equal((await as(bob, `select public.board_role($1)`, [id])).rows[0].board_role, 'viewer');
    });

    test('redeeming twice is a no-op, not a failure', async () => {
      const id = await givenAliceHasABoard();
      const token = await invite(id, 'editor');

      await redeem(bob, token);
      assert.equal((await redeem(bob, token)).rows[0].board, id);
      assert.equal(
        (await client.query('select 1 from public.board_members where board_id = $1', [id])).rowCount,
        1,
      );
    });

    /** Following a weaker link must not cost someone the access they have. */
    test('a viewer link cannot demote an editor', async () => {
      const id = await givenAliceHasABoard();
      await share(id, 'editor');
      const token = await invite(id, 'viewer');

      await redeem(bob, token);
      assert.equal((await as(bob, `select public.board_role($1)`, [id])).rows[0].board_role, 'editor');
    });

    test('the owner redeeming their own link stays the owner', async () => {
      const id = await givenAliceHasABoard();
      const token = await invite(id, 'viewer');

      assert.equal((await redeem(alice, token)).rows[0].board, id);
      assert.equal((await as(alice, `select public.board_role($1)`, [id])).rows[0].board_role, 'owner');
    });

    test('a token that buys nothing says so quietly', async () => {
      await givenAliceHasABoard();
      assert.equal((await redeem(bob, 'deadbeef'.repeat(4))).rows[0].board, null);
      assert.equal((await redeem(bob, null)).rows[0].board, null);
      assert.equal((await as(bob, 'select id from public.boards')).rowCount, 0);
    });

    test('a revoked link stops working, and the people who used it stay', async () => {
      const id = await givenAliceHasABoard();
      const token = await invite(id);
      await redeem(bob, token);

      await as(alice, 'delete from public.board_invites where board_id = $1', [id]);

      assert.equal((await redeem(bob, token)).rows[0].board, null, 'a revoked token still worked');
      assert.equal((await as(bob, 'select id from public.boards where id = $1', [id])).rowCount, 1,
        'revoking the link removed someone who had already joined');
    });

    test('an unauthenticated caller cannot redeem anything', async () => {
      const token = await invite(await givenAliceHasABoard());
      await refuses(null, 'select public.redeem_board_invite($1)', [token], /permission denied/i);
    });

    test('deleting a board takes its link with it', async () => {
      const id = await givenAliceHasABoard();
      await invite(id);

      await as(alice, 'delete from public.boards where id = $1', [id]);
      assert.equal((await client.query('select 1 from public.board_invites')).rowCount, 0);
    });

    describe('who is on the board', () => {
      test('the owner sees everyone, with something to call them', async () => {
        const id = await givenAliceHasABoard();
        await share(id, 'editor');

        const { rows } = await as(alice, 'select * from public.board_people($1)', [id]);
        assert.deepEqual(rows.map((r) => [r.email, r.role]), [
          ['alice@example.test', 'owner'],
          ['bob@example.test', 'editor'],
        ]);
      });

      /**
       * With an editor the old ordering passed by luck — descending on the
       * role text happens to put 'owner' above 'editor'. A viewer is what
       * exposes it: 'viewer' sorts above 'owner', so the owner was not first.
       */
      test('the owner leads even when a viewer would sort above them', async () => {
        const id = await givenAliceHasABoard();
        await share(id, 'viewer');

        const { rows } = await as(alice, 'select * from public.board_people($1)', [id]);
        assert.deepEqual(rows.map((r) => r.role), ['owner', 'viewer']);
      });

      /** It resolves addresses, so it must not be a way to go looking for one. */
      test('a member cannot use it to read the other members\' addresses', async () => {
        const id = await givenAliceHasABoard();
        await share(id, 'editor');

        assert.equal((await as(bob, 'select * from public.board_people($1)', [id])).rowCount, 0);
      });

      test('runs with definer rights, or it could not resolve anyone at all', async () => {
        const { rows } = await client.query(
          `select prosecdef from pg_proc
           where proname in ('board_people', 'redeem_board_invite')
             and pronamespace = 'public'::regnamespace`,
        );
        assert.equal(rows.length, 2);
        assert.ok(rows.every((r) => r.prosecdef), 'both must be SECURITY DEFINER');
      });
    });
  });

  /**
   * The live channel — who may join a board's broadcast, and who may write to
   * it.
   *
   * These are the policies on `realtime.messages` from
   * `20260804154000_board_broadcast.sql`, and until now nothing tested them at
   * all: the migration was known to apply and its behaviour was assumed. They
   * are the whole of the protection on live collaboration, so an assumption is
   * a poor thing for them to rest on.
   *
   * What authorises a join is the *session's* topic, not any row's — that is
   * how Realtime asks the question, and why the policies read
   * `realtime.topic()` rather than `messages.topic`. So a single row is enough
   * to see a decision: whether it comes back says whether this session may
   * listen at all.
   *
   * Every case is rolled back rather than cleaned up. `DATABASE_URL` can name
   * the hosted project — that is a documented workflow — and a test that
   * inserts into realtime.messages there should leave nothing behind, whatever
   * it asserts.
   */
  describe('the live channel', () => {
    const BROADCAST = { topic: 'board:alpha', extension: 'broadcast' };

    /** Somebody, on a channel, with one message already on it. Always undone. */
    const asListener = async (userId, topic, sql, params = []) => {
      await client.query('begin');
      try {
        await client.query('insert into realtime.messages (topic, extension) values ($1, $2)', [
          BROADCAST.topic,
          BROADCAST.extension,
        ]);
        await client.query('select set_config($1, $2, true)', [
          'request.jwt.claims',
          JSON.stringify({ sub: userId }),
        ]);
        await client.query('select set_config($1, $2, true)', ['realtime.topic', topic]);
        await client.query('set local role authenticated');
        return await client.query(sql, params);
      } finally {
        // Unconditional: a refused statement has poisoned the transaction and
        // a successful one has written a row, and neither may survive.
        await client.query('rollback');
      }
    };

    const hears = async (userId, topic) =>
      (await asListener(userId, topic, 'select id from realtime.messages')).rowCount;

    const sends = (userId, topic) =>
      asListener(userId, topic, 'insert into realtime.messages (topic, extension) values ($1, $2)', [
        BROADCAST.topic,
        BROADCAST.extension,
      ]);

    describe('listening', () => {
      test('an owner hears their own board', async () => {
        await givenAliceHasABoard();
        assert.equal(await hears(alice, 'board:alpha'), 1);
      });

      test('a viewer hears it too — watching is the point of being a viewer', async () => {
        const id = await givenAliceHasABoard();
        await share(id, 'viewer');
        assert.equal(await hears(bob, 'board:alpha'), 1);
      });

      test('a stranger hears nothing', async () => {
        await givenAliceHasABoard();
        assert.equal(await hears(bob, 'board:alpha'), 0);
      });

      /**
       * The default the migration's comment claims: a topic that is not a
       * board's parses to something board_role() knows nothing about, and is
       * refused. Worth its own case because it is the one that holds for every
       * channel this project might broadcast on later.
       */
      test('a topic that is not a board is refused, even from a real user', async () => {
        await givenAliceHasABoard();
        assert.equal(await hears(alice, 'presence:lobby'), 0);
        assert.equal(await hears(alice, 'board:no-such-board'), 0);
      });
    });

    describe('sending', () => {
      test('an owner may write to their board', async () => {
        await givenAliceHasABoard();
        assert.equal((await sends(alice, 'board:alpha')).rowCount, 1);
      });

      test('an editor may write to it', async () => {
        const id = await givenAliceHasABoard();
        await share(id, 'editor');
        assert.equal((await sends(bob, 'board:alpha')).rowCount, 1);
      });

      /** The split the policies exist to make: watching is not editing. */
      test('a viewer may listen but not write', async () => {
        const id = await givenAliceHasABoard();
        await share(id, 'viewer');

        assert.equal(await hears(bob, 'board:alpha'), 1);
        await assert.rejects(() => sends(bob, 'board:alpha'), /row-level security/i);
      });

      test('a stranger may not write', async () => {
        await givenAliceHasABoard();
        await assert.rejects(() => sends(bob, 'board:alpha'), /row-level security/i);
      });

      /**
       * The mirror of the listening case above, and it was missing: every
       * other sending case here names a real board, so a regression that let
       * writes through whenever the topic was not an authorised board would
       * have passed the lot. The two policies are separate objects and can
       * rot separately, which is the reason to ask each of them the same
       * question rather than to ask one and infer the other.
       */
      test('a topic that is not a board takes no writes either', async () => {
        await givenAliceHasABoard();

        await assert.rejects(() => sends(alice, 'presence:lobby'), /row-level security/i);
        await assert.rejects(() => sends(alice, 'board:no-such-board'), /row-level security/i);
      });
    });
  });
});
