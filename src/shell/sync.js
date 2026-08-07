import { createBoardSync } from '../platform/sync.js';
import { auth, client } from './auth.js';

/**
 * Live collaboration, if there is a project to collaborate through — null
 * otherwise, which `createApp` reads as "this board has nobody else on it".
 * The same load-time decision the repository and the auth gate make.
 */
/**
 * Everything the caller passes is forwarded, rather than a list of names.
 *
 * This adapter exists to supply two things — the client and the identity — and
 * naming the rest one by one made it a place options go to disappear. That is
 * not hypothetical: `heldUntil` was added to createBoardSync and to the call
 * in createApp, both unit-tested, and silently dropped here, so the feature
 * was inert in the only build that has a channel at all. Nothing failed,
 * because every test that exercises the buffer talks to createBoardSync
 * directly and never comes through this door.
 *
 * The two the shell owns are applied after the spread, so they are this file's
 * to decide and not something a caller can quietly replace.
 */
export const createSync = client
  ? (options) =>
      createBoardSync({
        ...options,
        client,
        // What the people on this board see above each other's cursors. An
        // address is shared with the board's members, who are people it has
        // been shared with — a guest has none to share and is just a guest.
        // `||` rather than `??`, for the same reason toAccount now normalises:
        // a label is a thing to write above a pointer, and an empty string is
        // not one. Belt and braces now that the account is normalised — this
        // is the side that fails visibly, so it is the side worth over-guarding.
        identity: { label: auth.current()?.email || 'Guest' },
      })
  : null;
