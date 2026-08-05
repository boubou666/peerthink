import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createOfflineAuth, createSupabaseAuth } from '../../src/platform/auth.js';
import { createSupabaseClient, readSupabaseConfig } from '../../src/platform/supabase.js';

/**
 * The auth port, against a stub client.
 *
 * The stub is the Supabase auth surface this code actually calls — six
 * methods and the state-change callback — and every test drives the port
 * through it. What is being checked is the part we wrote: that a session is
 * resolved exactly once, that every path publishes through one channel, and
 * that a failure leaves the port usable rather than stuck.
 */

const sessionFor = (user) => ({ access_token: 'token', user });
const GUEST = { id: 'u-guest', email: null, is_anonymous: true };
const MEMBER = { id: 'u-guest', email: 'ada@example.com' };

function stubClient({ session = null, ...responses } = {}) {
  const calls = [];
  let emit = () => {};

  // Every argument is recorded, not just the first. A test asserting that a
  // call was *not* given something — updateUser and its absent captchaToken —
  // can only say so if the stub can see a second argument arriving.
  const answer = (name, fallback) => async (...args) => {
    const entry = [name, args[0]];
    entry.args = args;
    calls.push(entry);
    const reply = responses[name] ?? fallback;
    return typeof reply === 'function' ? reply(args[0]) : reply;
  };

  const client = {
    auth: {
      onAuthStateChange(listener) {
        emit = listener;
        return { data: { subscription: { unsubscribe: () => calls.push(['unsubscribe']) } } };
      },
      getSession: answer('getSession', { data: { session }, error: null }),
      signInAnonymously: answer('signInAnonymously', {
        data: { session: sessionFor(GUEST) },
        error: null,
      }),
      signInWithPassword: answer('signInWithPassword', { data: {}, error: null }),
      signUp: answer('signUp', { data: { session: sessionFor(MEMBER) }, error: null }),
      updateUser: answer('updateUser', { data: { user: MEMBER }, error: null }),
      signOut: answer('signOut', { error: null }),
    },
  };

  return { client, calls, names: () => calls.map(([name]) => name), emit: (s) => emit('EVENT', s) };
}

const countOf = (names, name) => names.filter((n) => n === name).length;

describe('supabase auth', () => {
  test('a first visit signs in anonymously and reports a guest', async () => {
    const { client, names } = stubClient();
    const auth = createSupabaseAuth({ client });

    assert.equal(auth.current(), null, 'nobody until start() has run');
    assert.deepEqual(await auth.start(), { ok: true });
    assert.deepEqual(auth.current(), { id: 'u-guest', email: null, guest: true });
    assert.equal(countOf(names(), 'signInAnonymously'), 1);
  });

  test('a stored session is used as it stands', async () => {
    const { client, names } = stubClient({ session: sessionFor(MEMBER) });
    const auth = createSupabaseAuth({ client });

    await auth.start();
    assert.deepEqual(auth.current(), { id: 'u-guest', email: 'ada@example.com', guest: false });
    assert.equal(countOf(names(), 'signInAnonymously'), 0, 'signed in again over a live session');
  });

  /**
   * The one that matters: StrictMode mounts every effect twice, and two
   * anonymous sign-ins are two users — the second of which is the one that
   * sticks, with none of the first one's boards.
   */
  test('concurrent starts sign in once', async () => {
    const { client, names } = stubClient();
    const auth = createSupabaseAuth({ client });

    await Promise.all([auth.start(), auth.start(), auth.start()]);
    assert.equal(countOf(names(), 'signInAnonymously'), 1);
  });

  test('a failed start can be retried', async () => {
    let attempt = 0;
    const { client, names } = stubClient({
      signInAnonymously: () =>
        ++attempt === 1
          ? { data: {}, error: { message: 'offline' } }
          : { data: { session: sessionFor(GUEST) }, error: null },
    });
    const auth = createSupabaseAuth({ client });

    assert.deepEqual(await auth.start(), { ok: false, message: 'offline' });
    assert.equal(auth.current(), null);

    // the memo has to have been dropped, or the retry answers with the
    // cached failure and the gate never lets anyone through
    assert.deepEqual(await auth.start(), { ok: true });
    assert.equal(auth.current().guest, true);
    assert.equal(countOf(names(), 'signInAnonymously'), 2);
  });

  test('an unreadable stored session is reported, not signed over', async () => {
    const { client, names } = stubClient({
      getSession: { data: {}, error: { message: 'storage is unreadable' } },
    });
    const auth = createSupabaseAuth({ client });

    assert.deepEqual(await auth.start(), { ok: false, message: 'storage is unreadable' });
    assert.equal(countOf(names(), 'signInAnonymously'), 0);
  });

  /**
   * The port's contract is that it answers. One path did not: a client that
   * throws left RequireAccount's .then() with nowhere to put the rejection,
   * and the gate sat on "Loading…" with no retry.
   */
  test('a client that throws is reported, not propagated', async () => {
    for (const method of ['getSession', 'signInAnonymously']) {
      const { client } = stubClient({
        [method]: () => {
          throw new Error('the transport gave up');
        },
      });
      const auth = createSupabaseAuth({ client });

      const result = await auth.start();
      assert.equal(result.ok, false, `${method} threw and start() did not answer`);
      assert.match(result.message, /transport gave up/);

      // and the memo was dropped, so the retry button is not answering with it
      assert.equal(auth.current(), null);
    }
  });

  test('an error with no message still says something', async () => {
    const { client } = stubClient({ signInAnonymously: { data: {}, error: {} } });
    const result = await createSupabaseAuth({ client }).start();

    assert.equal(result.ok, false);
    assert.match(result.message, /session/);
  });

  test('subscribers hear every change, including ones this tab did not make', async () => {
    const { client, emit } = stubClient();
    const auth = createSupabaseAuth({ client });

    const seen = [];
    const unsubscribe = auth.subscribe((account) => seen.push(account));

    await auth.start();
    emit(sessionFor(MEMBER)); // a token refresh, or a sign-in in another tab
    unsubscribe();
    emit(null);

    assert.deepEqual(seen.map((a) => a?.email ?? null), [null, 'ada@example.com']);
    assert.equal(auth.current(), null, 'the port itself keeps following after an unsubscribe');
  });

  test('signing in reports the failure rather than throwing it', async () => {
    const { client } = stubClient({ signInWithPassword: { error: { message: 'wrong password' } } });
    const auth = createSupabaseAuth({ client });

    assert.deepEqual(await auth.signIn({ email: 'ada@example.com', password: 'nope' }), {
      ok: false,
      message: 'wrong password',
    });
    assert.deepEqual(await createSupabaseAuth({ client: stubClient().client }).signIn({}), {
      ok: true,
    });
  });

  describe('register', () => {
    test('attaches the email to the guest, keeping their boards', async () => {
      const { client, calls, names } = stubClient();
      const auth = createSupabaseAuth({ client });
      await auth.start();

      const result = await auth.register({ email: 'ada@example.com', password: 'secret1' });

      assert.deepEqual(result, { ok: true, pending: false });
      assert.equal(countOf(names(), 'signUp'), 0, 'signUp would have made a second user');
      assert.deepEqual(calls.find(([n]) => n === 'updateUser')[1], {
        email: 'ada@example.com',
        password: 'secret1',
      });
    });

    test('is pending while the address is unconfirmed', async () => {
      const { client } = stubClient({ updateUser: { data: { user: GUEST }, error: null } });
      const auth = createSupabaseAuth({ client });
      await auth.start();

      assert.deepEqual(await auth.register({ email: 'ada@example.com', password: 'secret1' }), {
        ok: true,
        pending: true,
      });
    });

    test('signs up from scratch when there is no session to attach to', async () => {
      const { client, names } = stubClient();
      const auth = createSupabaseAuth({ client });

      assert.deepEqual(await auth.register({ email: 'ada@example.com', password: 'secret1' }), {
        ok: true,
        pending: false,
      });
      assert.equal(countOf(names(), 'updateUser'), 0);
    });

    test('a signup awaiting confirmation has no session yet', async () => {
      const { client } = stubClient({ signUp: { data: { session: null }, error: null } });

      assert.deepEqual(
        await createSupabaseAuth({ client }).register({ email: 'a@b.co', password: 'secret1' }),
        { ok: true, pending: true },
      );
    });

    test('every captcha-guarded door gets its own fresh token', async () => {
      // signInAnonymously, signUp and signInWithPassword each take an
      // options.captchaToken; updateUser does not, because PUT /auth/v1/user
      // is not a protected endpoint. Enabling protection with any of the
      // first three unsent is what locks everyone out.
      const { client, calls } = stubClient();
      let issued = 0;
      const auth = createSupabaseAuth({ client, captcha: async () => `token-${++issued}` });

      await auth.start(); // signInAnonymously
      await auth.signIn({ email: 'ada@example.com', password: 'secret1' });

      const anonArgs = calls.find(([n]) => n === 'signInAnonymously')[1];
      const inArgs = calls.find(([n]) => n === 'signInWithPassword')[1];
      assert.equal(anonArgs.options.captchaToken, 'token-1');
      assert.equal(inArgs.options.captchaToken, 'token-2');
      assert.equal(inArgs.email, 'ada@example.com', 'the credentials survived the spread');

      // and a signed-out registration, which is the signUp branch
      const fresh = stubClient();
      let more = 0;
      await createSupabaseAuth({
        client: fresh.client,
        captcha: async () => `fresh-${++more}`,
      }).register({ email: 'ada@example.com', password: 'secret1' });

      const upArgs = fresh.calls.find(([n]) => n === 'signUp')[1];
      assert.equal(upArgs.options.captchaToken, 'fresh-1');
      assert.equal(upArgs.password, 'secret1');
    });

    test('a guest attaching an email sends no token, because that door is not guarded', async () => {
      const { client, calls } = stubClient();
      const auth = createSupabaseAuth({ client, captcha: async () => 'token' });
      await auth.start();

      await auth.register({ email: 'ada@example.com', password: 'secret1' });

      // updateUser takes only emailRedirectTo — a captchaToken here would be
      // an argument the client has no field for. Asserted on the whole
      // argument list, because a token smuggled into a second parameter is
      // exactly the mistake this test exists to catch, and reading only the
      // first argument would not see it.
      const call = calls.find(([n]) => n === 'updateUser');
      assert.deepEqual(call.args, [{ email: 'ada@example.com', password: 'secret1' }]);
    });

    test('a captcha token is taken per sign-in and handed to Supabase', async () => {
      const { client, calls } = stubClient();
      let taken = 0;
      const auth = createSupabaseAuth({
        client,
        captcha: async () => `token-${++taken}`,
      });

      await auth.start();

      const args = calls.find(([n]) => n === 'signInAnonymously')[1];
      assert.deepEqual(args, { options: { captchaToken: 'token-1' } });
      assert.equal(taken, 1, 'one token per sign-in, not one per app');
    });

    test('no captcha configured sends no options at all', async () => {
      // Not `{ options: { captchaToken: undefined } }`: a project that is not
      // checking ignores the field, but sending a shape nobody asked for is
      // how the next version of the client starts rejecting it.
      const { client, calls } = stubClient();
      await createSupabaseAuth({ client }).start();

      assert.equal(calls.find(([n]) => n === 'signInAnonymously')[1], undefined);
    });

    test('a captcha that will not issue a token fails the start, answered not thrown', async () => {
      const { client, names } = stubClient();
      const auth = createSupabaseAuth({
        client,
        captcha: async () => {
          throw new Error('Turnstile refused to issue a token.');
        },
      });

      const result = await auth.start();
      assert.equal(result.ok, false);
      assert.match(result.message, /refused to issue/i);
      assert.equal(countOf(names(), 'signInAnonymously'), 0, 'signed in without a token');
    });

    test('an address that is already an account is its own answer, not an error', async () => {
      // Attaching to a guest and signing up fresh disagree on the word for it —
      // `email_exists` and `user_already_exists` — so both are checked here.
      // Supabase's own message is accurate and leads nowhere; `taken` is what
      // the form turns into a way out.
      const { client } = stubClient({
        updateUser: { error: { code: 'email_exists', message: 'User already registered' } },
      });
      const guest = createSupabaseAuth({ client });
      await guest.start();

      const attached = await guest.register({ email: 'ada@example.com', password: 'secret1' });
      assert.equal(attached.ok, false);
      assert.equal(attached.taken, true);
      assert.match(attached.message, /stay behind/, 'says what switching costs');

      const fresh = createSupabaseAuth({
        client: stubClient({
          signUp: { error: { code: 'user_already_exists', message: 'User already registered' } },
        }).client,
      });
      const signedUp = await fresh.register({ email: 'ada@example.com', password: 'secret1' });
      assert.equal(signedUp.taken, true);
      assert.doesNotMatch(
        signedUp.message,
        /stay behind/,
        'with no session there are no boards to leave behind',
      );
    });

    test('a failure that is not a taken address is left in Supabase words', async () => {
      const { client } = stubClient({
        updateUser: { error: { code: 'weak_password', message: 'Password is too short' } },
      });
      const auth = createSupabaseAuth({ client });
      await auth.start();

      const result = await auth.register({ email: 'ada@example.com', password: 'x' });
      assert.deepEqual(result, { ok: false, message: 'Password is too short' });
      assert.equal(result.taken, undefined, 'only a taken address offers the other door');
    });

    test('reports both failures', async () => {
      const taken = { error: { message: 'already registered' } };
      const fresh = createSupabaseAuth({ client: stubClient({ signUp: taken }).client });
      assert.deepEqual(await fresh.register({}), { ok: false, message: 'already registered' });

      const guest = createSupabaseAuth({ client: stubClient({ updateUser: taken }).client });
      await guest.start();
      assert.deepEqual(await guest.register({}), { ok: false, message: 'already registered' });
    });
  });

  test('signing out succeeds even when the server refuses', async () => {
    const { client, names } = stubClient({ signOut: { error: { message: 'token expired' } } });
    const auth = createSupabaseAuth({ client });
    await auth.start();

    assert.deepEqual(await auth.signOut(), { ok: true });
    assert.equal(auth.current(), null);

    // and the gate's "continue without an account" still works afterwards
    await auth.start();
    assert.equal(auth.current().guest, true);
    assert.equal(countOf(names(), 'signInAnonymously'), 2);
  });

  test('destroy drops the subscription and the listeners', async () => {
    const { client, names, emit } = stubClient();
    const auth = createSupabaseAuth({ client });

    let heard = 0;
    auth.subscribe(() => heard++);
    auth.destroy();
    emit(sessionFor(MEMBER));

    assert.equal(heard, 0);
    assert.equal(countOf(names(), 'unsubscribe'), 1);
  });

  test('destroy survives a client that hands back no subscription', () => {
    const client = { auth: { onAuthStateChange: () => ({ data: null }) } };
    assert.doesNotThrow(() => createSupabaseAuth({ client }).destroy());
  });
});

describe('offline auth', () => {
  test('is always signed in, and says there are no accounts', async () => {
    const auth = createOfflineAuth();

    assert.equal(auth.configured, false);
    assert.deepEqual(auth.current(), { id: 'local', email: null, guest: true });
    assert.equal(typeof auth.subscribe(() => {}), 'function');
    assert.deepEqual(await auth.start(), { ok: true });
    assert.deepEqual(await auth.signOut(), { ok: true });
    assert.doesNotThrow(() => auth.destroy());

    for (const result of [await auth.signIn({}), await auth.register({})]) {
      assert.equal(result.ok, false);
      assert.match(result.message, /no accounts/);
    }
  });

  test('unsubscribing is a no-op rather than a crash', () => {
    assert.doesNotThrow(() => createOfflineAuth().subscribe(() => {})());
  });
});

describe('supabase configuration', () => {
  test('needs both halves', () => {
    const url = 'https://project.supabase.co';
    assert.deepEqual(readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: 'k' }), {
      url,
      anonKey: 'k',
    });
    assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: url }), null);
    assert.equal(readSupabaseConfig({ VITE_SUPABASE_ANON_KEY: 'k' }), null);
    assert.equal(readSupabaseConfig(), null);
  });

  /** A shell that exports an empty variable is a build with no project. */
  test('blank is absent', () => {
    assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: '  ', VITE_SUPABASE_ANON_KEY: 'k' }), null);
  });

  test('trims what it is given', () => {
    assert.deepEqual(
      readSupabaseConfig({ VITE_SUPABASE_URL: ' https://p.co \n', VITE_SUPABASE_ANON_KEY: ' k ' }),
      { url: 'https://p.co', anonKey: 'k' },
    );
  });

  /**
   * Every request carries the session, so an `http:` project URL puts the
   * access token on the wire in clear. Loopback is the exception because there
   * is no wire — it is the stack on this machine.
   */
  test('refuses a project it would not be safe to send a session to', () => {
    const key = 'k';
    const config = (url) => readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key });

    for (const url of ['https://project.supabase.co', 'http://localhost:54321', 'http://127.0.0.1:54321', 'http://[::1]:54321']) {
      assert.ok(config(url), `refused ${url}`);
    }
    for (const url of ['http://project.supabase.co', 'http://192.168.1.10:54321', 'ftp://project.supabase.co', 'not a url', '//project.supabase.co']) {
      assert.equal(config(url), null, `accepted ${url}`);
    }
  });

  test('a client without storage keeps its session in memory', () => {
    const config = { url: 'https://project.supabase.co', anonKey: 'k' };
    assert.ok(createSupabaseClient(config).auth, 'no storage — private mode');

    const storage = new Map();
    const client = createSupabaseClient(config, {
      storage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, v),
        removeItem: (k) => storage.delete(k),
      },
    });
    assert.ok(client.auth);
  });
});
