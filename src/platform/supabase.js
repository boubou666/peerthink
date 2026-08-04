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

/** Both halves or nothing — a URL without a key cannot make a request. */
export function readSupabaseConfig(env = {}) {
  const url = env.VITE_SUPABASE_URL?.trim();
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
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
