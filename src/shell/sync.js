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
        identity: { label: auth.current()?.email ?? 'Guest' },
      })
  : null;
