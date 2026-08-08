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

  /**
   * A guest, for the one rule that distinguishes them: an anonymous session
   * may be invited into an organization but may not create one.
   */
  let gus;

  before(async () => {
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    alice = randomUUID();
    bob = randomUUID();
    gus = randomUUID();
    await client.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [
      alice, 'alice@example.test', bob, 'bob@example.test',
    ]);
    await client.query('insert into auth.users (id, is_anonymous) values ($1, true)', [gus]);
  });

  after(async () => {
    if (!client) return;
    await client.query('delete from auth.users where id = any($1)', [[alice, bob, gus]]);
    await client.end();
  });

  /**
   * Clear what the last test made, and nothing else.
   *
   * Scoped to this run's users rather than `delete from public.boards`.
   * `DATABASE_URL` naming the hosted project is a documented workflow, and an
   * unscoped delete here empties real people's workspaces the first time
   * someone follows it — the suite's own fixtures are the only rows it has any
   * business removing. Every board these tests create is owned by alice or
   * bob; the one exception makes its own user and takes it away again.
   *
   * Organizations go the same way, and take their members, their invite and
   * their boards' placement with them by cascade.
   */
  beforeEach(async () => {
    await client.query('delete from public.boards where owner_id = any($1)', [[alice, bob, gus]]);
    await client.query('delete from public.organizations where owner_id = any($1)', [[alice, bob, gus]]);
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
    for (const table of [
      'boards',
      'board_members',
      'board_invites',
      'organizations',
      'organization_members',
      'organization_invites',
    ]) {
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
      // Scoped to the board, like the membership case above. Counting every
      // invite in the database only ever worked because `beforeEach` used to
      // empty `public.boards` outright — so this asserted "the database has no
      // invites in it", which is a fact about the last statement to run rather
      // than about the cascade under test.
      assert.equal(
        (await client.query('select 1 from public.board_invites where board_id = $1', [id])).rowCount,
        0,
      );
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
   * Organizations: access to everything inside, granted once.
   *
   * The board tests above ask whether one person can reach one board. These
   * ask the question organizations actually change — whether access granted at
   * the organization arrives at the boards in it, at the right strength, and
   * stops at the edge of it.
   */
  describe('organizations', () => {
    /** Alice's organization, written as superuser so the fixture is not the thing under test. */
    const givenAliceHasAnOrg = async (id = 'acme', name = 'Acme') => {
      await client.query('insert into public.organizations (id, owner_id, name) values ($1, $2, $3)',
        [id, alice, name]);
      return id;
    };

    const joins = (org, user, role) =>
      client.query('insert into public.organization_members (org_id, user_id, role) values ($1, $2, $3)',
        [org, user, role]);

    /** One of Alice's boards, inside one of Alice's organizations. */
    const givenABoardIn = async (org, id = 'alpha') => {
      await client.query(
        'insert into public.boards (id, owner_id, title, doc, org_id) values ($1, $2, $3, $4, $5)',
        [id, alice, 'Alpha', board(), org],
      );
      return id;
    };

    const roleOn = async (user, id) =>
      (await as(user, 'select public.board_role($1) as role', [id])).rows[0].role;

    /** Who, if anyone, is the organization's second owner. */
    const coOwnerAfter = async (org) =>
      (await client.query('select co_owner_id from public.organizations where id = $1', [org]))
        .rows[0].co_owner_id;

    /** The role a membership row records, which is not always the role in force. */
    const roleOf = async (org, user) =>
      (await client.query(
        'select role from public.organization_members where org_id = $1 and user_id = $2',
        [org, user],
      )).rows[0]?.role ?? null;

    describe('who can make one', () => {
      test('a registered user can', async () => {
        const made = await as(alice,
          'insert into public.organizations (id, owner_id, name) values ($1, $2, $3)',
          ['acme', alice, 'Acme']);
        assert.equal(made.rowCount, 1);
      });

      /**
       * The one thing here a guest cannot do. Every visitor is signed in
       * anonymously, so this is the rule that keeps an organization — and the
       * invite links pointing at it — from belonging to a browser session
       * nobody can get back into.
       */
      test('a guest cannot', async () => {
        await refuses(
          gus,
          'insert into public.organizations (id, owner_id, name) values ($1, $2, $3)',
          ['ghost', gus, 'Ghosts'],
          /row-level security/i,
        );
      });

      test('and not in someone else\'s name', async () => {
        await refuses(
          bob,
          'insert into public.organizations (id, owner_id, name) values ($1, $2, $3)',
          ['forged', alice, 'Not mine'],
          /row-level security/i,
        );
      });

      test('an organization is never nameless', async () => {
        await refuses(
          alice,
          'insert into public.organizations (id, owner_id, name) values ($1, $2, $3)',
          ['blank', alice, '   '],
          /organizations_name_shape/,
        );
      });

      test('caller_is_registered reads the table, not the token', async () => {
        // The gate above is only as good as its source. A JWT claim is a copy
        // of `is_anonymous` from whenever the token was minted, so a guest who
        // has just registered would still be refused until it refreshed —
        // asserting the definer property is what stops someone "simplifying"
        // this into auth.jwt(), where no behavioural test would notice.
        const { rows } = await client.query(
          `select prosecdef from pg_proc
            where proname = 'caller_is_registered' and pronamespace = 'public'::regnamespace`,
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].prosecdef, true, 'it reads auth.users, which authenticated cannot');
      });
    });

    describe('who can see one', () => {
      test('the owner and its members; nobody else', async () => {
        const org = await givenAliceHasAnOrg();

        assert.equal((await as(alice, 'select id from public.organizations')).rowCount, 1);
        assert.equal((await as(bob, 'select id from public.organizations')).rowCount, 0);

        await joins(org, bob, 'viewer');
        assert.equal((await as(bob, 'select id from public.organizations')).rowCount, 1);
      });

      test('only the owner renames it', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');

        assert.equal((await as(bob, 'update public.organizations set name = $2 where id = $1',
          [org, 'Bobs'])).rowCount, 0, 'the row is invisible to the update, not an error');
        assert.equal((await as(alice, 'update public.organizations set name = $2 where id = $1',
          [org, 'Acme Ltd'])).rowCount, 1);
      });

      /**
       * There is no transfer, and the `with check` is what makes that true
       * rather than the absence of a button. An owner who could write another
       * id into the column would be handing over every board in the
       * organization and every outstanding invite along with it.
       */
      test('and cannot hand it to somebody else', async () => {
        const org = await givenAliceHasAnOrg();
        await refuses(
          alice,
          'update public.organizations set owner_id = $2 where id = $1',
          [org, bob],
          /row-level security/i,
        );
      });

      test('only the owner deletes it', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');

        assert.equal((await as(bob, 'delete from public.organizations where id = $1', [org])).rowCount, 0);
        assert.equal((await as(alice, 'delete from public.organizations where id = $1', [org])).rowCount, 1);
      });

      test('an owner sees every member; a member sees only themselves', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');
        await joins(org, gus, 'viewer');

        assert.equal((await as(alice, 'select user_id from public.organization_members')).rowCount, 2);
        assert.equal((await as(bob, 'select user_id from public.organization_members')).rowCount, 1);
      });

      test('a member can walk out, and an editor cannot promote themselves', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'viewer');

        assert.equal((await as(bob,
          'update public.organization_members set role = $3 where org_id = $1 and user_id = $2',
          [org, bob, 'editor'])).rowCount, 0);

        assert.equal((await as(bob, 'delete from public.organization_members where org_id = $1',
          [org])).rowCount, 1);
        assert.equal((await as(bob, 'select id from public.organizations')).rowCount, 0,
          'and loses sight of the organization');
      });
    });

    /**
     * The point of the whole feature: a role in the organization is a role on
     * every board in it, without anybody being named on the boards themselves.
     */
    describe('access reaching the boards', () => {
      test('an org viewer can read a board in it but not write', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);
        await joins(org, bob, 'viewer');

        assert.equal((await as(bob, 'select id from public.boards')).rowCount, 1);
        assert.equal(await roleOn(bob, id), 'viewer');
        assert.equal((await as(bob, 'update public.boards set title = $2 where id = $1',
          [id, 'Hijacked'])).rowCount, 0);
      });

      test('an org editor can write it but not delete it', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);
        await joins(org, bob, 'editor');

        assert.equal(await roleOn(bob, id), 'editor');
        assert.equal((await as(bob, 'update public.boards set title = $2 where id = $1',
          [id, 'Edited'])).rowCount, 1);
        assert.equal((await as(bob, 'delete from public.boards where id = $1', [id])).rowCount, 0,
          'deleting is still not something being an editor buys');
      });

      /**
       * Owning the organization is an editor's role on its boards, not an
       * owner's — a board has exactly one owner, and it is whoever made it.
       * The extra powers are named in the policies, and this is the first of
       * them: a board made by somebody who has since left would otherwise be
       * undeletable by anyone still there.
       */
      test('the org owner can edit and delete a board a member made', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');
        await client.query(
          'insert into public.boards (id, owner_id, title, doc, org_id) values ($1, $2, $3, $4, $5)',
          ['bobs', bob, 'Bob\'s', board(), org],
        );

        assert.equal(await roleOn(alice, 'bobs'), 'editor', 'not owner — bob made it');
        assert.equal((await as(alice, 'update public.boards set title = $2 where id = $1',
          ['bobs', 'Tidied'])).rowCount, 1);
        assert.equal((await as(alice, 'delete from public.boards where id = $1', ['bobs'])).rowCount, 1);
      });

      test('a personal board is untouched by any of it', async () => {
        await givenAliceHasAnOrg();
        const id = await givenAliceHasABoard();
        await joins('acme', bob, 'editor');

        assert.equal(await roleOn(bob, id), null);
        assert.equal((await as(bob, 'select id from public.boards')).rowCount, 0);
      });

      test('being in the org does not reach another org\'s boards', async () => {
        await givenAliceHasAnOrg('acme');
        await givenAliceHasAnOrg('zenith', 'Zenith');
        const id = await givenABoardIn('zenith');
        await joins('acme', bob, 'editor');

        assert.equal(await roleOn(bob, id), null);
      });

      /** Two grants can disagree, and the stronger one holds — both ways round. */
      test('a direct editor is not demoted by being an org viewer', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);
        await joins(org, bob, 'viewer');
        await share(id, 'editor');

        assert.equal(await roleOn(bob, id), 'editor');
        assert.equal((await as(bob, 'update public.boards set title = $2 where id = $1',
          [id, 'Edited'])).rowCount, 1);
      });

      test('a direct viewer is not held back by being an org editor', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);
        await joins(org, bob, 'editor');
        await share(id, 'viewer');

        assert.equal(await roleOn(bob, id), 'editor');
      });

      test('the owner of a board in an org is still its owner', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);
        assert.equal(await roleOn(alice, id), 'owner');
      });

      /** The live channel resolves through the same function, so it follows. */
      test('an org member may listen on a board\'s channel', async () => {
        const org = await givenAliceHasAnOrg();
        await givenABoardIn(org);
        await joins(org, bob, 'viewer');

        await client.query('begin');
        try {
          await client.query('insert into realtime.messages (topic, extension) values ($1, $2)',
            ['board:alpha', 'broadcast']);
          await client.query('select set_config($1, $2, true)',
            ['request.jwt.claims', JSON.stringify({ sub: bob })]);
          await client.query('select set_config($1, $2, true)', ['realtime.topic', 'board:alpha']);
          await client.query('set local role authenticated');
          assert.equal((await client.query('select id from realtime.messages')).rowCount, 1);
        } finally {
          await client.query('rollback');
        }
      });
    });

    describe('putting a board somewhere', () => {
      test('an org editor can create one there; a viewer cannot', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');

        assert.equal((await as(bob,
          'insert into public.boards (id, owner_id, doc, org_id) values ($1, $2, $3, $4)',
          ['bobs', bob, board(), org])).rowCount, 1);

        await joins(org, gus, 'viewer');
        await refuses(
          gus,
          'insert into public.boards (id, owner_id, doc, org_id) values ($1, $2, $3, $4)',
          ['guests', gus, board(), org],
          /row-level security/i,
        );
      });

      test('a stranger cannot create one there', async () => {
        const org = await givenAliceHasAnOrg();
        await refuses(
          bob,
          'insert into public.boards (id, owner_id, doc, org_id) values ($1, $2, $3, $4)',
          ['sneaked', bob, board(), org],
          /row-level security/i,
        );
      });

      test('the board\'s owner can move it in and back out', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenAliceHasABoard();

        assert.equal((await as(alice, 'update public.boards set org_id = $2 where id = $1',
          [id, org])).rowCount, 1);
        assert.equal((await as(alice, 'update public.boards set org_id = null where id = $1',
          [id])).rowCount, 1);
      });

      /**
       * The reason `freeze_board_org` exists. Being an editor of a team is
       * what lets Bob write this row at all, and without the trigger the same
       * grant would let him write the column that says whose board it is —
       * carrying the team's work into an organization he controls, past a
       * policy that only ever sees the row he is proposing.
       */
      test('an org editor cannot walk off with a board', async () => {
        const org = await givenAliceHasAnOrg('acme');
        const id = await givenABoardIn(org);
        await joins(org, bob, 'editor');
        await client.query('insert into public.organizations (id, owner_id, name) values ($1, $2, $3)',
          ['bobcorp', bob, 'Bobcorp']);

        await refuses(bob, 'update public.boards set org_id = $2 where id = $1', [id, 'bobcorp'],
          /only the board.s owner or the organization.s owner/);
        await refuses(bob, 'update public.boards set org_id = null where id = $1', [id],
          /only the board.s owner or the organization.s owner/);
      });

      test('the org owner can take a member\'s board out of it', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');
        await client.query(
          'insert into public.boards (id, owner_id, doc, org_id) values ($1, $2, $3, $4)',
          ['bobs', bob, board(), org],
        );

        assert.equal((await as(alice, 'update public.boards set org_id = null where id = $1',
          ['bobs'])).rowCount, 1);
      });

      /**
       * The half of the trigger that a bare `not in` would have waved through:
       * org_role() answers null for an organization you are not in, and `null
       * not in (...)` is null rather than true.
       */
      test('a board cannot be moved into an organization you are not in', async () => {
        await givenAliceHasAnOrg('zenith', 'Zenith');
        await client.query(
          'insert into public.boards (id, owner_id, doc) values ($1, $2, $3)',
          ['bobs', bob, board()],
        );

        await refuses(bob, 'update public.boards set org_id = $2 where id = $1', ['bobs', 'zenith'],
          /cannot be moved into an organization/);
        assert.equal(
          (await client.query('select org_id from public.boards where id = $1', ['bobs'])).rows[0].org_id,
          null,
        );
      });

      test('an org viewer cannot move their own board in either', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'viewer');
        await client.query('insert into public.boards (id, owner_id, doc) values ($1, $2, $3)',
          ['bobs', bob, board()]);

        await refuses(bob, 'update public.boards set org_id = $2 where id = $1', ['bobs', org],
          /cannot be moved into an organization/);
      });

      test('a save that does not touch org_id is not a move', async () => {
        // The trigger runs on every update, and autosave writes one per
        // settled edit. An editor's ordinary save names no org_id at all, and
        // must not be refused by the rule that guards moving one.
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);
        await joins(org, bob, 'editor');

        assert.equal((await as(bob, 'update public.boards set doc = $2 where id = $1',
          [id, board({ order: ['a'] })])).rowCount, 1);
      });
    });

    /**
     * Deleting an organization is a decision about the organization. The
     * boards in it are several people's work, and they fall back to whoever
     * made them rather than going with it.
     */
    test('deleting an org returns its boards to their creators', async () => {
      const org = await givenAliceHasAnOrg();
      const id = await givenABoardIn(org);
      await joins(org, bob, 'editor');
      await client.query('insert into public.boards (id, owner_id, doc, org_id) values ($1, $2, $3, $4)',
        ['bobs', bob, board(), org]);

      await as(alice, 'delete from public.organizations where id = $1', [org]);

      const { rows } = await client.query(
        'select id, org_id from public.boards where id = any($1) order by id', [[id, 'bobs']]);
      assert.deepEqual(rows, [{ id: 'alpha', org_id: null }, { id: 'bobs', org_id: null }]);

      assert.equal(await roleOn(bob, id), null, 'and everyone else loses sight of them');
      assert.equal(await roleOn(bob, 'bobs'), 'owner', 'while the creator keeps their own');
      assert.equal((await client.query('select 1 from public.organization_members where org_id = $1',
        [org])).rowCount, 0, 'the membership goes with the organization');
    });

    /**
     * A second owner.
     *
     * The line under test throughout: everything that goes through
     * `org_role()` is shared, and the four acts on the organization's own row
     * — rename, delete, transfer, and this appointment — are not.
     */
    describe('a second owner', () => {
      const appoint = (userId, org, who) =>
        as(userId, 'update public.organizations set co_owner_id = $2 where id = $1', [org, who]);

      const coOwnerOf = async (org) =>
        (await client.query('select co_owner_id from public.organizations where id = $1', [org]))
          .rows[0].co_owner_id;

      /** Alice's organization with bob appointed alongside her. */
      const givenBobIsCoOwner = async (org = 'acme') => {
        await givenAliceHasAnOrg(org);
        await joins(org, bob, 'editor');
        assert.equal((await appoint(alice, org, bob)).rowCount, 1, 'the fixture could not appoint');
        return org;
      };

      test('an organization starts with one, and it is optional', async () => {
        const org = await givenAliceHasAnOrg();
        assert.equal(await coOwnerOf(org), null);
      });

      test('the owner can appoint a member, and take it back', async () => {
        const org = await givenBobIsCoOwner();
        assert.equal(await coOwnerOf(org), bob);

        assert.equal((await appoint(alice, org, null)).rowCount, 1);
        assert.equal(await coOwnerOf(org), null);
        assert.equal(await roleOf(org, bob), 'editor', 'removing the appointment removed the member');
      });

      /** The appointment is the stronger grant and is what every policy sees. */
      test('org_role answers owner for both, whatever the member row says', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'viewer');
        await appoint(alice, org, bob);

        assert.equal((await as(alice, 'select public.org_role($1) as role', [org])).rows[0].role, 'owner');
        assert.equal((await as(bob, 'select public.org_role($1) as role', [org])).rows[0].role, 'owner');
      });

      test('and their member row is left alone, so removing the appointment restores it', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'viewer');
        await appoint(alice, org, bob);
        assert.equal(await roleOf(org, bob), 'viewer', 'the appointment rewrote the member row');

        await appoint(alice, org, null);
        assert.equal((await as(bob, 'select public.org_role($1) as role', [org])).rows[0].role, 'viewer');
      });

      describe('what the two share', () => {
        test('the second owner runs the people', async () => {
          const org = await givenBobIsCoOwner();
          await joins(org, gus, 'editor');

          // the roster, which a member cannot read at all
          assert.equal((await as(bob, 'select * from public.organization_people($1)', [org])).rowCount, 3);

          // the link
          const minted = await as(bob,
            'insert into public.organization_invites (org_id, role, created_by) values ($1, $2, $3)',
            [org, 'editor', bob]);
          assert.equal(minted.rowCount, 1);
          assert.equal((await as(bob, 'select token from public.organization_invites')).rowCount, 1);

          // and taking somebody off
          assert.equal((await as(bob,
            'delete from public.organization_members where org_id = $1 and user_id = $2',
            [org, gus])).rowCount, 1);
        });

        test('and every board power inside it', async () => {
          const org = await givenBobIsCoOwner();
          const id = await givenABoardIn(org);

          assert.equal(await roleOn(bob, id), 'editor', 'a board has one owner, and alice made this');
          assert.equal((await as(bob, 'update public.boards set title = $2 where id = $1',
            [id, 'Edited'])).rowCount, 1);
          // what owning the organization buys, and the second owner has it
          assert.equal((await as(bob, 'update public.boards set org_id = null where id = $1',
            [id])).rowCount, 1);
        });

        test('including deleting a board somebody else made in it', async () => {
          const org = await givenBobIsCoOwner();
          await client.query(
            'insert into public.boards (id, owner_id, doc, org_id) values ($1, $2, $3, $4)',
            ['gusboard', gus, board(), org],
          );
          await joins(org, gus, 'editor');

          assert.equal((await as(bob, 'delete from public.boards where id = $1', ['gusboard'])).rowCount, 1);
        });
      });

      describe('what stays with the first', () => {
        test('the second owner cannot rename or delete the organization', async () => {
          const org = await givenBobIsCoOwner();

          assert.equal((await as(bob, 'update public.organizations set name = $2 where id = $1',
            [org, 'Bobs'])).rowCount, 0, 'the row is invisible to them, not an error');
          assert.equal((await as(bob, 'delete from public.organizations where id = $1',
            [org])).rowCount, 0);
          assert.equal((await client.query('select 1 from public.organizations where id = $1',
            [org])).rowCount, 1);
        });

        test('the second owner cannot hand the organization on', async () => {
          const org = await givenBobIsCoOwner();
          await joins(org, gus, 'editor');

          assert.equal(
            (await as(bob, 'select public.transfer_organization($1, $2) as ok', [org, gus])).rows[0].ok,
            false,
          );
          assert.equal(
            (await client.query('select owner_id from public.organizations where id = $1', [org]))
              .rows[0].owner_id,
            alice,
          );
        });

        /**
         * The one that would make the whole split meaningless: a second owner
         * who can appoint is a second owner who can replace the first.
         */
        test('the second owner cannot appoint anyone, including themselves', async () => {
          const org = await givenAliceHasAnOrg();
          await joins(org, bob, 'editor');

          // before being appointed
          assert.equal((await appoint(bob, org, bob)).rowCount, 0);
          assert.equal(await coOwnerOf(org), null);

          // and after
          await appoint(alice, org, bob);
          await joins(org, gus, 'editor');
          assert.equal((await appoint(bob, org, gus)).rowCount, 0,
            'a second owner replaced themselves with somebody else');
          assert.equal(await coOwnerOf(org), bob);
        });
      });

      describe('who may be appointed', () => {
        test('somebody who is not in the organization cannot be', async () => {
          const org = await givenAliceHasAnOrg();
          await refuses(alice, 'update public.organizations set co_owner_id = $2 where id = $1',
            [org, bob], /must already be a member/);
          assert.equal(await coOwnerOf(org), null);
        });

        /** The same rule that keeps an organization from being owned by a browser session. */
        test('a guest cannot be', async () => {
          const org = await givenAliceHasAnOrg();
          await joins(org, gus, 'editor');

          await refuses(alice, 'update public.organizations set co_owner_id = $2 where id = $1',
            [org, gus], /must be a registered account/);
        });

        test('the owner cannot appoint themselves', async () => {
          const org = await givenAliceHasAnOrg();
          await refuses(alice, 'update public.organizations set co_owner_id = $2 where id = $1',
            [org, alice], /already an owner/);
        });
      });

      /**
       * The appointment and the membership have to end together. A Remove that
       * left somebody running the organization is the one outcome nobody would
       * expect from that button.
       */
      describe('when they stop being a member', () => {
        test('the owner removing them takes the appointment too', async () => {
          const org = await givenBobIsCoOwner();

          await as(alice, 'delete from public.organization_members where org_id = $1 and user_id = $2',
            [org, bob]);

          assert.equal(await coOwnerOf(org), null, 'they were removed and still ran the organization');
          assert.equal((await as(bob, 'select public.org_role($1) as role', [org])).rows[0].role, null);
        });

        test('and so does them walking out', async () => {
          const org = await givenBobIsCoOwner();

          assert.equal((await as(bob, 'delete from public.organization_members where org_id = $1',
            [org])).rowCount, 1, 'a second owner could not leave');
          assert.equal(await coOwnerOf(org), null);
          assert.equal((await as(bob, 'select id from public.organizations')).rowCount, 0);
        });

        test('the organization itself is untouched by either', async () => {
          const org = await givenBobIsCoOwner();
          const id = await givenABoardIn(org);

          await as(bob, 'delete from public.organization_members where org_id = $1', [org]);

          assert.equal((await client.query('select 1 from public.organizations where id = $1',
            [org])).rowCount, 1);
          assert.equal(await roleOn(alice, id), 'owner');
        });
      });

      test('the roster names them as one, and the first owner leads', async () => {
        const org = await givenBobIsCoOwner();
        await joins(org, gus, 'viewer');

        const { rows } = await as(alice, 'select * from public.organization_people($1)', [org]);
        assert.deepEqual(rows.map((r) => r.role), ['owner', 'co-owner', 'viewer']);
        assert.deepEqual(rows.map((r) => r.email), ['alice@example.test', 'bob@example.test', null]);
      });

      test('a member still cannot read the roster', async () => {
        const org = await givenBobIsCoOwner();
        await joins(org, gus, 'editor');

        assert.equal((await as(gus, 'select * from public.organization_people($1)', [org])).rowCount, 0);
      });
    });

    /**
     * Handing an organization over.
     *
     * The policy still refuses the naive update, so everything here is about
     * the function that does it properly: who may call it, who may receive,
     * and whether the three changes it makes actually land together.
     */
    describe('transferring it', () => {
      const transfer = (userId, org, to) =>
        as(userId, 'select public.transfer_organization($1, $2) as ok', [org, to]);

      const ownerOf = async (org) =>
        (await client.query('select owner_id from public.organizations where id = $1', [org]))
          .rows[0].owner_id;

      test('the naive update is still refused', async () => {
        // The policy this function exists beside. If a plain update ever
        // starts working, the rules below stop being rules.
        const org = await givenAliceHasAnOrg();
        await refuses(
          alice,
          'update public.organizations set owner_id = $2 where id = $1',
          [org, bob],
          /row-level security/i,
        );
      });

      test('the owner can hand it to a member, and the books balance', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');

        assert.equal((await transfer(alice, org, bob)).rows[0].ok, true);

        assert.equal(await ownerOf(org), bob, 'the organization did not move');
        assert.equal(await roleOf(org, bob), null, 'the new owner kept a membership row');
        assert.equal(await roleOf(org, alice), 'editor', 'the old owner lost their access');
      });

      test('and the roles that follow from it move too', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);
        await joins(org, bob, 'editor');
        await transfer(alice, org, bob);

        assert.equal((await as(bob, 'select public.org_role($1) as role', [org])).rows[0].role, 'owner');
        assert.equal((await as(alice, 'select public.org_role($1) as role', [org])).rows[0].role, 'editor');

        // The board is still alice's — transferring the organization is not
        // transferring the boards in it, and `boards.owner_id` never moved.
        assert.equal(await roleOn(alice, id), 'owner');
        // and bob now holds what owning the organization buys
        assert.equal((await as(bob, 'delete from public.boards where id = $1', [id])).rowCount, 1);
      });

      test('the new owner can hand it back, and the old one cannot take it', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');
        await transfer(alice, org, bob);

        assert.equal((await transfer(alice, org, alice)).rows[0].ok, false,
          'the former owner took the organization back');
        assert.equal(await ownerOf(org), bob);

        assert.equal((await transfer(bob, org, alice)).rows[0].ok, true);
        assert.equal(await ownerOf(org), alice);
        assert.equal(await roleOf(org, bob), 'editor');
      });

      test('a member cannot transfer it, to themselves or to anyone', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');
        await joins(org, gus, 'editor');

        assert.equal((await transfer(bob, org, bob)).rows[0].ok, false);
        assert.equal((await transfer(bob, org, gus)).rows[0].ok, false);
        assert.equal(await ownerOf(org), alice);
      });

      /** There is no way to name somebody you have not already been handed. */
      test('the recipient has to already be in it', async () => {
        const org = await givenAliceHasAnOrg();

        assert.equal((await transfer(alice, org, bob)).rows[0].ok, false);
        assert.equal(await ownerOf(org), alice);
        assert.equal(await roleOf(org, alice), null, 'a failed transfer left the owner a member row');
      });

      /**
       * The same rule `organizations_insert` keeps, one step later: an
       * organization owned by an anonymous session is one nobody can get back
       * into once that session is gone.
       */
      test('and has to be a real account, not a guest', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, gus, 'editor');

        assert.equal((await transfer(alice, org, gus)).rows[0].ok, false);
        assert.equal(await ownerOf(org), alice);
        assert.equal(await roleOf(org, gus), 'editor', 'the guest lost their membership anyway');
      });

      /** Nothing is wrong and there is nothing to do; a failure would be a lie. */
      test('handing it to yourself changes nothing and is not an error', async () => {
        const org = await givenAliceHasAnOrg();

        assert.equal((await transfer(alice, org, alice)).rows[0].ok, true);
        assert.equal(await ownerOf(org), alice);
        assert.equal(await roleOf(org, alice), null, 'the owner was given a membership row');
      });

      test('an organization that is not yours, or not there, is refused', async () => {
        await givenAliceHasAnOrg();
        assert.equal((await transfer(bob, 'acme', bob)).rows[0].ok, false);
        assert.equal((await transfer(alice, 'no-such-org', bob)).rows[0].ok, false);
        assert.equal((await transfer(alice, null, bob)).rows[0].ok, false);
        assert.equal((await transfer(alice, 'acme', null)).rows[0].ok, false);
      });

      /**
       * Nobody can be both, so the appointment has to go in the same breath as
       * the handover — and it cannot be cleared afterwards by the new owner,
       * because by then it names them and only they could clear it, from a
       * screen that would be telling them they are their own second owner.
       */
      test('handing it to the second owner clears the appointment', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');
        await as(alice, 'update public.organizations set co_owner_id = $2 where id = $1', [org, bob]);

        assert.equal((await transfer(alice, org, bob)).rows[0].ok, true);

        const { rows } = await client.query(
          'select owner_id, co_owner_id from public.organizations where id = $1', [org]);
        assert.equal(rows[0].owner_id, bob);
        assert.equal(rows[0].co_owner_id, null, 'the new owner is also their own second owner');
        assert.equal(await roleOf(org, alice), 'editor');
      });

      test('handing it to somebody else leaves the second owner in place', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');
        await joins(org, gus, 'editor');
        await client.query('update public.organizations set co_owner_id = $2 where id = $1', [org, bob]);

        // gus is a guest, so the recipient has to be somebody registered —
        // carol stands in, made and taken away by this test alone.
        const carol = randomUUID();
        await client.query('insert into auth.users (id, email) values ($1, $2)',
          [carol, 'carol@example.test']);
        await joins(org, carol, 'editor');

        assert.equal((await transfer(alice, org, carol)).rows[0].ok, true);
        assert.equal(await coOwnerAfter(org), bob, 'the second owner went with the handover');

        await client.query('delete from auth.users where id = $1', [carol]);
      });

      test('an unauthenticated caller cannot reach it', async () => {
        await givenAliceHasAnOrg();
        await refuses(null, 'select public.transfer_organization($1, $2)', ['acme', alice],
          /permission denied/i);
      });

      test('it runs with definer rights, or it could not do any of this', async () => {
        const { rows } = await client.query(
          `select prosecdef from pg_proc
            where proname = 'transfer_organization' and pronamespace = 'public'::regnamespace`,
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].prosecdef, true);
      });
    });

    /**
     * `boards.org_id` is `on delete set null`, and that update fires
     * `freeze_board_org` on every board it detaches — a trigger whose whole
     * job is to refuse moves. So the cascade has to get past a rule written
     * about people moving boards on purpose, for boards it does not own and,
     * in the second case, with no session at all.
     *
     * Neither path is exercised by the deletion tests above: those detach a
     * board the caller owns or one in an organization they still own, and both
     * satisfy the trigger's first disjunct without the interesting question
     * being asked.
     */
    describe('detaching boards is not a move', () => {
      const withBoardsFrom = async (org = 'acme') => {
        await givenAliceHasAnOrg(org);
        await joins(org, bob, 'editor');
        await client.query(
          'insert into public.boards (id, owner_id, doc, org_id) values ($1, $2, $3, $4)',
          ['bobs', bob, board(), org],
        );
        return org;
      };

      test('deleting the organization detaches a board somebody else owns', async () => {
        const org = await withBoardsFrom();

        await as(alice, 'delete from public.organizations where id = $1', [org]);

        const { rows } = await client.query('select org_id from public.boards where id = $1', ['bobs']);
        assert.equal(rows.length, 1, 'the board went with the organization');
        assert.equal(rows[0].org_id, null);
      });

      /**
       * The same detach, one cascade further out and with no identity at all.
       *
       * `organizations.owner_id` is `on delete cascade`, so the account going
       * takes its organizations with it, and those reach the boards through
       * `boards.org_id`'s `on delete set null`. Nobody is signed in for any of
       * it, so `auth.uid()` is null.
       *
       * What lets this through is the trigger's explicit cascade branch —
       * `new.org_id is null` and the old organization no longer there — and
       * nothing else: the identity test below it is `coalesce`d to false, so a
       * null caller is refused rather than waved through.
       *
       * Take the branch away and this fails — which is how the pair was
       * arrived at. Before either existed the cascade got through only because
       * `null or null` made the `if` not fire, and hardening that test with the
       * `coalesce` it plainly wanted turned deleting an account into an error.
       */
      test('and so does the owner’s account going, with nobody signed in', async () => {
        // The address is per-run and the user is cleaned up in a `finally`,
        // because the whole point of this test is a delete that might not
        // happen — and a fixed address left behind by a failure makes every
        // later run fail on the unique index instead of on the thing under
        // test, which is a much worse thing to read.
        const gone = randomUUID();
        try {
          await client.query('insert into auth.users (id, email) values ($1, $2)',
            [gone, `gone-${gone}@example.test`]);
          await client.query('insert into public.organizations (id, owner_id, name) values ($1, $2, $3)',
            ['doomed', gone, 'Doomed']);
          await client.query(
            'insert into public.boards (id, owner_id, doc, org_id) values ($1, $2, $3, $4)',
            ['orphan', bob, board(), 'doomed'],
          );

          await client.query('delete from auth.users where id = $1', [gone]);

          const { rows } = await client.query('select org_id from public.boards where id = $1', ['orphan']);
          assert.equal(rows.length, 1, 'somebody else’s board went with the deleted account');
          assert.equal(rows[0].org_id, null);
        } finally {
          await client.query('delete from public.boards where id = $1', ['orphan']);
          await client.query('delete from auth.users where id = $1', [gone]);
        }
      });
    });

    describe('invites', () => {
      const invite = async (org, role = 'editor') => {
        const { rows } = await client.query(
          'insert into public.organization_invites (org_id, role, created_by) values ($1, $2, $3) returning token',
          [org, role, alice],
        );
        return rows[0].token;
      };

      const redeem = (userId, token) =>
        as(userId, 'select public.redeem_organization_invite($1) as org', [token]);

      test('only the owner can create, read or revoke a link', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');
        await invite(org);

        assert.equal((await as(bob, 'select token from public.organization_invites')).rowCount, 0);
        assert.equal((await as(alice, 'select token from public.organization_invites')).rowCount, 1);

        await refuses(
          bob,
          'insert into public.organization_invites (org_id, role, created_by) values ($1, $2, $3)',
          [org, 'editor', bob],
          /row-level security/i,
        );
        await as(bob, 'delete from public.organization_invites where org_id = $1', [org]);
        assert.equal((await as(alice, 'select token from public.organization_invites')).rowCount, 1,
          'a member revoked their owner\'s link');
      });

      test('a token is random rather than derived from the organization', async () => {
        const first = await invite(await givenAliceHasAnOrg('acme'));
        const second = await invite(await givenAliceHasAnOrg('zenith', 'Zenith'));

        assert.match(first, /^[0-9a-f]{32}$/);
        assert.notEqual(first, second);
        assert.ok(!first.includes('acme'), 'the token gives away the organization it opens');
      });

      /** Joining once is what makes every board in it, and every later one, reachable. */
      test('redeeming joins at the role the link grants, and reaches the boards', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);
        const token = await invite(org, 'viewer');

        assert.equal((await redeem(bob, token)).rows[0].org, org);
        assert.equal((await as(bob, 'select id from public.boards')).rowCount, 1);
        assert.equal(await roleOn(bob, id), 'viewer');
      });

      test('a board made after someone joined is theirs to open too', async () => {
        const org = await givenAliceHasAnOrg();
        await redeem(bob, await invite(org, 'editor'));

        await givenABoardIn(org, 'later');
        assert.equal(await roleOn(bob, 'later'), 'editor');
      });

      /** Creating one takes an account; joining one does not. */
      test('a guest can follow the link', async () => {
        const org = await givenAliceHasAnOrg();
        const id = await givenABoardIn(org);

        assert.equal((await redeem(gus, await invite(org, 'editor'))).rows[0].org, org);
        assert.equal(await roleOn(gus, id), 'editor');
      });

      test('redeeming twice is a no-op, not a failure', async () => {
        const org = await givenAliceHasAnOrg();
        const token = await invite(org);

        await redeem(bob, token);
        assert.equal((await redeem(bob, token)).rows[0].org, org);
        assert.equal((await client.query('select 1 from public.organization_members where org_id = $1',
          [org])).rowCount, 1);
      });

      test('a viewer link cannot demote an editor', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');

        await redeem(bob, await invite(org, 'viewer'));
        assert.equal((await as(bob, 'select public.org_role($1) as role', [org])).rows[0].role, 'editor');
      });

      test('the owner following their own link stays the owner', async () => {
        const org = await givenAliceHasAnOrg();
        assert.equal((await redeem(alice, await invite(org, 'viewer'))).rows[0].org, org);
        assert.equal((await as(alice, 'select public.org_role($1) as role', [org])).rows[0].role, 'owner');
      });

      test('a token that buys nothing says so quietly', async () => {
        await givenAliceHasAnOrg();
        assert.equal((await redeem(bob, 'deadbeef'.repeat(4))).rows[0].org, null);
        assert.equal((await redeem(bob, null)).rows[0].org, null);
        assert.equal((await as(bob, 'select id from public.organizations')).rowCount, 0);
      });

      test('a revoked link stops working, and the people who used it stay', async () => {
        const org = await givenAliceHasAnOrg();
        const token = await invite(org);
        await redeem(bob, token);

        await as(alice, 'delete from public.organization_invites where org_id = $1', [org]);

        assert.equal((await redeem(bob, token)).rows[0].org, null, 'a revoked token still worked');
        assert.equal((await as(bob, 'select id from public.organizations')).rowCount, 1,
          'revoking the link removed someone who had already joined');
      });

      test('an unauthenticated caller cannot redeem anything', async () => {
        const token = await invite(await givenAliceHasAnOrg());
        await refuses(null, 'select public.redeem_organization_invite($1)', [token], /permission denied/i);
      });

      test('deleting an org takes its link with it', async () => {
        const org = await givenAliceHasAnOrg();
        await invite(org);

        await as(alice, 'delete from public.organizations where id = $1', [org]);
        assert.equal((await client.query('select 1 from public.organization_invites where org_id = $1',
          [org])).rowCount, 0);
      });
    });

    describe('who is in the organization', () => {
      test('the owner sees everyone, with something to call them', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');

        const { rows } = await as(alice, 'select * from public.organization_people($1)', [org]);
        assert.deepEqual(rows.map((r) => [r.email, r.role]), [
          ['alice@example.test', 'owner'],
          ['bob@example.test', 'editor'],
        ]);
      });

      /** A guest has no address, and is listed anyway — as a member, without one. */
      test('a guest who followed a link is in the list', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, gus, 'viewer');

        const { rows } = await as(alice, 'select * from public.organization_people($1)', [org]);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r.role), ['owner', 'viewer']);
        assert.equal(rows[1].email, null, 'a guest is a member without an address, not a missing row');
      });

      /** It resolves addresses, so it must not be a way to go looking for one. */
      test('a member cannot use it to read the others\' addresses', async () => {
        const org = await givenAliceHasAnOrg();
        await joins(org, bob, 'editor');

        assert.equal((await as(bob, 'select * from public.organization_people($1)', [org])).rowCount, 0);
      });

      test('the definer functions run with definer rights', async () => {
        const { rows } = await client.query(
          `select proname, prosecdef from pg_proc
            where proname in ('org_role', 'organization_people', 'redeem_organization_invite')
              and pronamespace = 'public'::regnamespace`,
        );
        assert.equal(rows.length, 3);
        assert.ok(rows.every((r) => r.prosecdef), `all three must be SECURITY DEFINER: ${
          rows.filter((r) => !r.prosecdef).map((r) => r.proname).join(', ')}`);
      });

      test('an unauthenticated caller cannot reach org_role', async () => {
        await refuses(null, `select public.org_role('acme')`, [], /permission denied/i);
      });
    });
  });

  /**
   * `board_summaries` — the view the board list pages over.
   *
   * A view is a new way into `boards`, and the only thing stopping it being a
   * way *around* the policies is `security_invoker`. That is one word in a
   * migration, it has no behavioural tell when it is right, and getting it
   * wrong hands every board to everybody — so it is asserted directly, the
   * same way `prosecdef` is for the definer functions.
   */
  describe('the board summaries view', () => {
    const orgWithBoard = async (org = 'acme') => {
      await client.query('insert into public.organizations (id, owner_id, name) values ($1, $2, $3)',
        [org, alice, 'Acme']);
      await client.query(
        'insert into public.boards (id, owner_id, title, doc, org_id) values ($1, $2, $3, $4, $5)',
        ['alpha', alice, 'Alpha', board(), org],
      );
      return org;
    };

    test('runs as the caller, so the policies still apply', async () => {
      const { rows } = await client.query(
        `select c.reloptions from pg_class c
          where c.relname = 'board_summaries' and c.relnamespace = 'public'::regnamespace`,
      );
      assert.equal(rows.length, 1, 'the view is defined exactly once');
      assert.ok(
        (rows[0].reloptions ?? []).includes('security_invoker=on'),
        `board_summaries must be security_invoker; got ${JSON.stringify(rows[0].reloptions)}`,
      );
    });

    test('a stranger sees nothing through it either', async () => {
      await givenAliceHasABoard();

      assert.equal((await as(alice, 'select id from public.board_summaries')).rowCount, 1);
      assert.equal((await as(bob, 'select id from public.board_summaries')).rowCount, 0);
    });

    test('no session sees nothing at all', async () => {
      await givenAliceHasABoard();
      await refuses(null, 'select id from public.board_summaries', [], /permission denied/i);
    });

    /**
     * `personal` is the whole reason the view exists, and the rule is "not
     * filed under an organization I can open" rather than "org_id is null".
     */
    test('a board in an organization you are in is not personal', async () => {
      const org = await orgWithBoard();
      await client.query('insert into public.organization_members (org_id, user_id, role) values ($1, $2, $3)',
        [org, bob, 'editor']);

      const forAlice = await as(alice, 'select personal from public.board_summaries where id = $1', ['alpha']);
      assert.equal(forAlice.rows[0].personal, false, 'the owner is in the organization');

      const forBob = await as(bob, 'select personal from public.board_summaries where id = $1', ['alpha']);
      assert.equal(forBob.rows[0].personal, false);
    });

    /**
     * The case that makes `org_id is null` the wrong filter: reachable, in an
     * organization, and that organization is not somewhere you can open. The
     * personal list is the only place it can appear.
     */
    test('a board shared with you from an organization you are not in is personal', async () => {
      const org = await orgWithBoard();
      await share('alpha', 'editor');

      assert.equal((await as(bob, `select public.org_role($1) as role`, [org])).rows[0].role, null,
        'bob must not be in the organization for this to be the case under test');

      const { rows } = await as(bob, 'select personal from public.board_summaries where id = $1', ['alpha']);
      assert.equal(rows.length, 1, 'he cannot see the board at all');
      assert.equal(rows[0].personal, true, 'his only board would appear nowhere');
    });

    test('a plain board is personal', async () => {
      await givenAliceHasABoard();
      const { rows } = await as(alice, 'select personal from public.board_summaries where id = $1', ['alpha']);
      assert.equal(rows[0].personal, true);
    });

    /** A list has no use for the document, and now cannot ask for it by mistake. */
    test('the document is not exposed through it', async () => {
      await givenAliceHasABoard();
      await refuses(alice, 'select doc from public.board_summaries', [], /column .*doc.* does not exist/i);
    });

    test('anon holds no privilege on it', async () => {
      const { rows } = await client.query(
        `select coalesce(bool_or(has_table_privilege('anon', 'public.board_summaries', priv)), false) as held
           from unnest(array['select', 'insert', 'update', 'delete']) as priv`,
      );
      assert.equal(rows[0].held, false);
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
