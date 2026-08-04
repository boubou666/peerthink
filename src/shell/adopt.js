import { adoptBoards } from '../platform/adopt.js';
import { createLocalStorageRepository } from '../platform/storage.js';
import { client } from './auth.js';
import { repository } from './storage.js';
import { safeLocalStorage } from './web-storage.js';

/**
 * Adopt this browser's boards into the account, or null in a build with no
 * account to adopt them into — where they are still the boards being read and
 * there is nothing to move them to.
 *
 * The local repository is built here rather than imported: `shell/storage.js`
 * exports whichever one the app is using, which in this build is the Supabase
 * one. This needs the other side of that decision.
 */
async function adoptOnce() {
  const storage = safeLocalStorage();
  if (!storage) return null;

  return adoptBoards({
    local: createLocalStorageRepository({ storage }),
    remote: repository,
    storage,
  });
}

/**
 * Memoised for the life of the page, for the same reason `auth.start()` is:
 * StrictMode mounts every effect twice, and two adoptions running at once both
 * find the marker unset, both find the board missing from the account, and
 * both create it — one of them losing on the primary key. The marker is
 * written at the end, so it cannot separate two runs that started together.
 */
let adopting = null;

export const adoptLocalBoards = client ? () => (adopting ??= adoptOnce()) : null;
