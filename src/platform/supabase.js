import { createClient } from '@supabase/supabase-js';

/**
 * The Supabase client, and the decision of whether there is one at all.
 *
 * The app has to keep working with no backend configured: the browser tests
 * run against a bare dev server, and the published site is static hosting with
 * no project behind it. So configuration is a value that can be absent, not an
 * assumption — `readSupabaseConfig` answers null and everything above it falls
 * back to the local repository and no accounts.
 *
 * Nothing here reads import.meta.env directly; the environment arrives as an
 * argument so both branches are reachable from a test.
 */

/**
 * Somewhere it is safe to send a session.
 *
 * Every request this client makes carries the user's access token, so the
 * scheme is not cosmetic: an `http:` project URL puts that token on the wire in
 * clear text for anyone on the path. Loopback is the exception, because there
 * is no path — it is the stack running on this machine, which is how the tests
 * and `npm run dev` reach it.
 *
 * A malformed URL is refused for the same reason a missing one is: the app
 * runs on Web Storage instead, which is a working app rather than one making
 * requests nobody can vouch for.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isSafeProjectUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname);
}

/** Both halves or nothing — a URL without a key cannot make a request. */
export function readSupabaseConfig(env = {}) {
  const url = env.VITE_SUPABASE_URL?.trim();
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey || !isSafeProjectUrl(url)) return null;
  return { url, anonKey };
}

/**
 * `storage` is passed through rather than left to default to window
 * .localStorage, because the same privacy modes that make Web Storage throw
 * would take the client's constructor down with them. A client given null
 * storage keeps the session in memory for the tab, which is a worse session
 * but a working app.
 */
export function createSupabaseClient({ url, anonKey }, { storage } = {}) {
  return createClient(url, anonKey, {
    auth: {
      storage: storage ?? undefined,
      persistSession: Boolean(storage),
      autoRefreshToken: true,
      // The session never arrives in a URL fragment: HashRouter owns the hash,
      // and letting the client rewrite it would fight the router for the route.
      detectSessionInUrl: false,
    },
  });
}
