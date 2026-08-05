// Sweeping abandoned guests, exercised as the scheduler will run it.
//
// The interesting half of this function is what it leaves alone. A guest who
// owns a board is someone's work and a guest on somebody else's board is a
// person that owner shared with — deleting either would take boards or
// memberships with it, silently, on a timer nobody is watching. So every test
// here is paired: one row that should go, one that should not, swept together.
//
// Requires DATABASE_URL to point at a database the migrations have been
// applied to, exactly like rls.test.js.
//
// `test:db` runs its files one at a time on purpose. There is one database
// behind all of them and rls.test.js clears `public.boards` before every test
// of its own; run concurrently, that wipe lands in the middle of the fixtures
// here and the failure reads as a foreign key bug in the sweep rather than as
// two suites sharing a table.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

const URL = process.env.DATABASE_URL;

describe('sweeping anonymous users', { skip: URL ? false : 'DATABASE_URL is not set' }, () => {
  let client;
  const mine = [];

  const guest = async ({ anonymous = true, lastSeen = '8 days' } = {}) => {
    const id = randomUUID();
    await client.query(
      `insert into auth.users (id, is_anonymous, created_at, last_sign_in_at)
       values ($1, $2, now() - $3::interval, now() - $3::interval)`,
      [id, anonymous, lastSeen],
    );
    mine.push(id);
    return id;
  };

  const board = async (owner, id = randomUUID().slice(0, 12)) => {
    await client.query(
      'insert into public.boards (id, owner_id, title, doc) values ($1, $2, $3, $4)',
      [id, owner, 'Kept', { v: 1, order: [], objects: [] }],
    );
    return id;
  };

  /** Sweep, and answer whether a given user survived it. */
  const survives = async (id) => {
    await client.query('select public.sweep_anonymous_users()');
    const { rowCount } = await client.query('select 1 from auth.users where id = $1', [id]);
    return rowCount === 1;
  };

  before(async () => {
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });

  after(async () => {
    if (client) await client.end();
  });

  // Every test runs inside a transaction that is rolled back.
  //
  // Not tidiness — safety. `sweep_anonymous_users()` deletes every eligible
  // row in the database, not only the ones made here, and with autocommit on
  // it would do that for real against whatever DATABASE_URL happens to name.
  // Point it at the hosted project and an unwary `npm run test:db` deletes
  // real people's guests. Rolling back means the sweep is exercised without
  // its effects outliving the assertion.
  beforeEach(async () => {
    mine.length = 0;
    await client.query('begin');
  });

  afterEach(async () => {
    await client.query('rollback');
  });

  test('an old guest with nothing to their name is swept', async () => {
    const empty = await guest();
    assert.equal(await survives(empty), false);
  });

  test('a guest who owns a board is kept, however long they have been gone', async () => {
    const owner = await guest({ lastSeen: '400 days' });
    await board(owner);
    assert.equal(await survives(owner), true, 'sweeping this takes a board with it');
  });

  test('a guest on somebody else’s board is kept', async () => {
    const owner = await guest({ lastSeen: '1 hour' });
    const id = await board(owner);
    const member = await guest();
    await client.query(
      'insert into public.board_members (board_id, user_id, role) values ($1, $2, $3)',
      [id, member, 'editor'],
    );

    assert.equal(await survives(member), true, 'they were shared with, not abandoned');
  });

  test('a guest seen recently is kept, even with nothing to their name', async () => {
    const here = await guest({ lastSeen: '1 hour' });
    assert.equal(await survives(here), true);
  });

  test('a registered user is never swept, whatever else is true of them', async () => {
    // The one that would be a catastrophe rather than a bug: `is_anonymous`
    // is the whole guard between housekeeping and deleting the customers.
    const person = await guest({ anonymous: false, lastSeen: '400 days' });
    assert.equal(await survives(person), true);
  });

  test('the count answers how many went', async () => {
    await guest();
    await guest();
    const kept = await guest({ lastSeen: '1 hour' });

    const { rows } = await client.query('select public.sweep_anonymous_users() as n');
    assert.ok(rows[0].n >= 2, `expected at least the two abandoned guests, got ${rows[0].n}`);
    assert.equal(await survives(kept), true);
  });

  test('the window is an argument, so a caller can be more or less patient', async () => {
    const recent = await guest({ lastSeen: '2 hours' });

    await client.query(`select public.sweep_anonymous_users('1 hour'::interval)`);
    const { rowCount } = await client.query('select 1 from auth.users where id = $1', [recent]);
    assert.equal(rowCount, 0, 'an hour of patience should not have kept a two-hour-old guest');
  });

  test('no visitor can call it', async () => {
    // authenticated covers every signed-in visitor, anonymous ones included —
    // a callable sweep would be a button each guest could press on the others.
    // Savepoints, not transactions: the whole test is already inside one, and
    // a rejected statement poisons the block it is in until something unwinds.
    for (const role of ['anon', 'authenticated']) {
      await client.query('savepoint as_role');
      await client.query(`set local role ${role}`);
      await assert.rejects(
        () => client.query('select public.sweep_anonymous_users()'),
        /permission denied/i,
        `${role} must not be able to run the sweep`,
      );
      await client.query('rollback to savepoint as_role');
      await client.query('reset role');
    }
  });
});
