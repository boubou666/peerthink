import { createSharing } from '../platform/sharing.js';
import { auth, client } from './auth.js';

/**
 * Sharing, if there is a project to share through. Null otherwise — a board
 * that lives in one browser has nobody to share it with, and the Share button
 * is not offered.
 */
export const sharing = client ? createSharing({ client, auth }) : null;

/**
 * The address of an invite. Built from the page rather than from configuration
 * so it is right on localhost, on GitHub Pages under a sub-path, and anywhere
 * else this is served — and hash-based, because that is what the router reads.
 */
export function joinUrl(token, location = window.location) {
  return `${location.origin}${location.pathname}#/join/${token}`;
}
