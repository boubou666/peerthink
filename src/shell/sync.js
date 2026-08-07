import { createBoardSync } from '../platform/sync.js';
import { auth, client } from './auth.js';

/**
 * Live collaboration, if there is a project to collaborate through — null
 * otherwise, which `createApp` reads as "this board has nobody else on it".
 * The same load-time decision the repository and the auth gate make.
 */
export const createSync = client
  ? ({ boardId, store, scheduler, onWriter, onCursor, onMembers }) =>
      createBoardSync({
        client,
        boardId,
        store,
        scheduler,
        onWriter,
        onCursor,
        onMembers,
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
