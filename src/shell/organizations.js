import { createOrganizations } from '../platform/organizations.js';
import { auth, client } from './auth.js';

/**
 * Organizations, if there is a project to have them in. Null otherwise — a
 * board that lives in one browser has nobody to share it with, so there is
 * nothing for an organization to be, and the switcher is not offered.
 *
 * The same decision `sharing` makes, from the same `client`, so the two are
 * never in disagreement about whether this build has a backend.
 */
export const organizations = client ? createOrganizations({ client, auth }) : null;
