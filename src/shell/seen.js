import { createSeenBoards } from '../platform/seen-boards.js';
import { safeLocalStorage } from './web-storage.js';

/**
 * The record of what this browser has shown, for whoever is signed in.
 *
 * Built per call rather than once at module load: the account can change while
 * the page stays up — signing in from the menu is exactly that — and a record
 * captured at import would go on answering for the previous person.
 *
 * One argument, so there is nothing here to forward and nothing to drop —
 * unlike `shell/sync.js`, which named the options it passed on and quietly
 * lost one. If this ever grows a second, spread rather than name them.
 */
export const seenBoardsFor = (accountId) =>
  createSeenBoards({ storage: safeLocalStorage(), accountId });
