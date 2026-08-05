/**
 * Who the session belongs to.
 *
 * Everything above this file works with an *account* — `{ id, email, guest }`
 * — never a Supabase session. That is what lets the same shell run against a
 * project, against nothing at all, and against a fake in a test: the guard and
 * the account menu are written once, in terms a local build can also satisfy.
 *
 * A first visit signs in anonymously. That is a real row in auth.users, so the
 * boards are server-backed and covered by row level security from the first
 * card, rather than sitting in localStorage until someone decides to register.
 * `register()` then attaches an email to that same user, which keeps the
 * boards; signing out and signing in as someone else is what abandons them.
 */

const toAccount = (session) => {
  const user = session?.user;
  if (!user) return null;
  return { id: user.id, email: user.email ?? null, guest: user.is_anonymous === true };
};

/** Supabase's errors are already written for people; a fallback covers the rest. */
const failed = (error, fallback) => ({ ok: false, message: error?.message || fallback });

/**
 * "That address is spoken for" — under whichever name the endpoint gives it.
 *
 * The two register paths disagree: attaching an email to a guest answers
 * `email_exists`, and signing up with no session answers `user_already_exists`.
 * Same situation, two words for it, so both are named here rather than one
 * being assumed to cover the other.
 */
const TAKEN = new Set(['email_exists', 'user_already_exists']);

/**
 * The one failure worth more than Supabase's wording.
 *
 * "User already registered" is accurate and useless: the person reading it has
 * an account they have forgotten owning, and — if they are a guest — a browser
 * full of boards that belongs to the guest, not to that account. Signing in is
 * the way to the account, and it leaves those boards behind, exactly as
 * signing out would. A form that only prints the error sends them round the
 * loop again; `taken` is what lets it offer the other door and say the cost.
 */
const alreadyTaken = (guest) => ({
  ok: false,
  taken: true,
  message: guest
    ? 'That email already has an account. Sign in to reach it — but the boards on this device belong to the guest you are now, and stay behind.'
    : 'That email already has an account. Sign in instead.',
});

/**
 * Run a call that is supposed to answer with `{ error }`, and make sure it
 * does. A transport that rejects instead — no network, a request that never
 * came back — would otherwise escape as an unhandled rejection out of a port
 * whose whole contract is that it answers.
 */
const answering = async (fallback, call) => {
  try {
    return await call();
  } catch (error) {
    return failed(error, fallback);
  }
};

/**
 * `captcha` is a function answering a fresh token, or null when the project is
 * not checking for one. Injected rather than imported so both branches are
 * reachable from a test, and so the port stays ignorant of whose CAPTCHA it is.
 */
export function createSupabaseAuth({ client, captcha = null }) {
  let account = null;
  let starting = null;
  const listeners = new Set();

  const publish = (session) => {
    account = toAccount(session);
    for (const listener of [...listeners]) listener(account);
  };

  // onAuthStateChange is the single source of truth for `account`: a token
  // refresh, a sign-out in another tab, and a call made here all arrive
  // through it, so no code path below has to remember to publish its own
  // result. The callback only assigns — calling back into the client from
  // inside it is what deadlocks supabase-js.
  const { data: subscription } = client.auth.onAuthStateChange((_event, session) => {
    publish(session);
  });

  // The gate is a .then() with nowhere to put a rejection: a client that
  // throws here left it on "Loading…" for good, with no retry.
  const startOnce = () => answering('Could not start a session.', resolveSession);

  const resolveSession = async () => {
    const { data, error } = await client.auth.getSession();
    if (error) return failed(error, 'Could not read the stored session.');
    if (data.session) {
      publish(data.session);
      return { ok: true };
    }

    // The token is taken here rather than at construction: it is single-use and
    // short-lived, so one fetched at load would already be spent or stale by
    // the time a retry needed it. A CAPTCHA that will not issue one fails the
    // start the same way a refused sign-in does — answered, not thrown, so the
    // gate shows it and offers the retry.
    let options;
    if (captcha) {
      try {
        options = { options: { captchaToken: await captcha() } };
      } catch (error) {
        return failed(error, 'Could not verify this browser.');
      }
    }

    const created = await client.auth.signInAnonymously(options);
    if (created.error) return failed(created.error, 'Could not start a session.');
    publish(created.data.session);
    return { ok: true };
  };

  return {
    configured: true,

    current: () => account,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Resolve a session, creating an anonymous one if there is none.
     *
     * The promise is memoised because StrictMode mounts every effect twice and
     * two concurrent starts would sign in anonymously twice — two users, two
     * empty workspaces, and the second one is what sticks. A failed start
     * clears the memo so the retry button is not permanently answering with
     * the cached rejection.
     */
    start() {
      starting ??= startOnce().then((result) => {
        if (!result.ok) starting = null;
        return result;
      });
      return starting;
    },

    async signIn({ email, password }) {
      return answering('Could not sign in.', async () => {
        const { error } = await client.auth.signInWithPassword({ email, password });
        return error ? failed(error, 'Could not sign in.') : { ok: true };
      });
    },

    /**
     * Turn the current guest into an account, keeping their boards.
     *
     * updateUser() attaches the credentials to the signed-in anonymous user,
     * so every board they already own stays theirs. signUp() would create a
     * *second* user and leave the first one's boards unreachable — it is only
     * correct with no session at all, which is what signing out leaves behind.
     *
     * With email confirmations on (the deployed default; local dev has them
     * off) the address is not live until the link is clicked, so the returned
     * `pending` is the difference between "you are registered" and "check your
     * email" — the session itself is usable either way.
     */
    async register({ email, password }) {
      return answering('Could not create an account.', async () => {
        if (!account) {
          const { data, error } = await client.auth.signUp({ email, password });
          if (error) {
            return TAKEN.has(error.code)
              ? alreadyTaken(false)
              : failed(error, 'Could not create an account.');
          }
          return { ok: true, pending: !data.session };
        }

        const { data, error } = await client.auth.updateUser({ email, password });
        if (error) {
          return TAKEN.has(error.code)
            ? alreadyTaken(true)
            : failed(error, 'Could not save the account.');
        }
        return { ok: true, pending: data.user?.email !== email };
      });
    },

    /**
     * Always succeeds. A revocation that fails server-side — an expired token,
     * no network — has still dropped the session on this machine, and leaving
     * the user staring at their old boards because the server already forgot
     * them is the wrong end of the trade.
     */
    async signOut() {
      // Answered rather than awaited bare: a rejected sign-out must not stop
      // the session being dropped locally, which is the part that matters.
      await answering('', () => client.auth.signOut());
      publish(null); // the state-change callback publishes too; this is idempotent
      starting = null;
      return { ok: true };
    },

    destroy() {
      subscription?.subscription?.unsubscribe();
      listeners.clear();
    },
  };
}

/**
 * No project configured: one implicit local user, forever. The shell still
 * gets an account so the guard has something to let through, and hides the
 * account menu because there is nothing behind it to sign in or out of.
 */
export function createOfflineAuth() {
  const account = { id: 'local', email: null, guest: true };
  return {
    configured: false,
    current: () => account,
    subscribe: () => () => {},
    start: async () => ({ ok: true }),
    signIn: async () => ({ ok: false, message: 'This build has no accounts.' }),
    register: async () => ({ ok: false, message: 'This build has no accounts.' }),
    signOut: async () => ({ ok: true }),
    destroy: () => {},
  };
}
