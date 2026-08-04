import { createBoardSync } from '../platform/sync.js';
import { client } from './auth.js';

/**
 * Live collaboration, if there is a project to collaborate through — null
 * otherwise, which `createApp` reads as "this board has nobody else on it".
 * The same load-time decision the repository and the auth gate make.
 */
export const createSync = client
  ? ({ boardId, store, scheduler }) => createBoardSync({ client, boardId, store, scheduler })
  : null;
