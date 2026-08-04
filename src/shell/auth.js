import { useSyncExternalStore } from 'react';

import { createOfflineAuth, createSupabaseAuth } from '../platform/auth.js';
import { createSupabaseClient, readSupabaseConfig } from '../platform/supabase.js';
import { safeLocalStorage } from './storage.js';

/**
 * One auth for the whole shell, chosen once at load.
 *
 * A build with no Supabase project configured is not a broken build — it is
 * the local one, and the published static site. It gets the offline auth, the
 * guard lets everyone through, and the account menu stays hidden.
 */
const config = readSupabaseConfig(import.meta.env);

/** Also what the Supabase repository will be built on; exported for it. */
export const client = config
  ? createSupabaseClient(config, { storage: safeLocalStorage() })
  : null;

export const auth = client ? createSupabaseAuth({ client }) : createOfflineAuth();

/**
 * The signed-in account, or null. Subscribing through React rather than an
 * effect is what keeps a token refresh or a sign-out in another tab from
 * rendering against an account this tab no longer has.
 */
export function useAccount() {
  return useSyncExternalStore(auth.subscribe, auth.current);
}
