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
 *
 * Both kinds of link are built here, next to each other, rather than each
 * beside the adapter that mints its token. They are the same construction, and
 * a second copy of it in another file is how one of them comes to be right on
 * a sub-path while the other is not.
 */
const linkTo = (path, location) => `${location.origin}${location.pathname}#${path}`;

export function joinUrl(token, location = window.location) {
  return linkTo(`/join/${token}`, location);
}

/**
 * An organization's link. A separate route from a board's, rather than one
 * that tries a board token and then an organization token: two round trips to
 * answer one link, and a page that has to say which of the two failed when
 * "this link does not work" is the whole of what a holder should learn.
 */
export function orgJoinUrl(token, location = window.location) {
  return linkTo(`/join/org/${token}`, location);
}
