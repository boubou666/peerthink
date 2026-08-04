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

export function createSupabaseAuth({ client }) {
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

  const startOnce = async () => {
    try {
      return await resolveSession();
    } catch (error) {
      // The port promises an answer, and one path did not keep that promise:
      // a client that *throws* — a transport that never came back, a storage
      // that blew up — left the gate on "Loading…" with no retry, because the
      // caller is a .then() with nowhere to put a rejection.
      return failed(error, 'Could not start a session.');
    }
  };

  const resolveSession = async () => {
    const { data, error } = await client.auth.getSession();
    if (error) return failed(error, 'Could not read the stored session.');
    if (data.session) {
      publish(data.session);
      return { ok: true };
    }

    const created = await client.auth.signInAnonymously();
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
      const { error } = await client.auth.signInWithPassword({ email, password });
      return error ? failed(error, 'Could not sign in.') : { ok: true };
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
      if (!account) {
        const { data, error } = await client.auth.signUp({ email, password });
        return error
          ? failed(error, 'Could not create an account.')
          : { ok: true, pending: !data.session };
      }

      const { data, error } = await client.auth.updateUser({ email, password });
      return error
        ? failed(error, 'Could not save the account.')
        : { ok: true, pending: data.user?.email !== email };
    },

    /**
     * Always succeeds. A revocation that fails server-side — an expired token,
     * no network — has still dropped the session on this machine, and leaving
     * the user staring at their old boards because the server already forgot
     * them is the wrong end of the trade.
     */
    async signOut() {
      await client.auth.signOut();
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
