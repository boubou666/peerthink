import { createLinkPreview } from '../platform/link-preview.js';
import { client } from './auth.js';

/**
 * Asking what is at a link, if there is a project to ask — null otherwise,
 * which `createLinks` reads as "say that a link cannot be checked from here".
 * The same load-time decision the repository, the auth gate and live editing
 * make.
 *
 * The fetcher itself rather than a factory: there is nothing per-call for a
 * caller to supply, so there is no list of option names here for an option to
 * go missing from — which is how `heldUntil` came to be dropped by
 * `shell/sync.js` while every test passed. If this ever takes options, spread
 * them and apply the client after, as that file now does.
 */
export const linkPreview = createLinkPreview({ client });
