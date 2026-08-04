import { createLocalStorageRepository, createNullRepository } from '../platform/storage.js';
import { createSupabaseRepository } from '../platform/supabase-repository.js';
import { auth, client } from './auth.js';
import { safeLocalStorage } from './web-storage.js';

/**
 * One repository for the whole shell, so the board list and the board itself
 * are looking at the same store rather than two views that can disagree.
 *
 * Which one it is follows the same decision auth made: a build with a project
 * behind it puts the boards in Postgres, where they are covered by the
 * policies and reachable from a second device; a build without one keeps them
 * in this browser. Nothing above here can tell the difference — that is what
 * the shared contract is for.
 */
export const repository = (() => {
  if (client) return createSupabaseRepository({ client, auth });
  const storage = safeLocalStorage();
  return storage ? createLocalStorageRepository({ storage }) : createNullRepository();
})();
