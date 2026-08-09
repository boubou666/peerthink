import { isImageSource } from '../core/image.js';
import { hostOf } from '../core/links.js';

/**
 * Asking the server what is at a link.
 *
 * This exists because the browser cannot answer the question. A cross-origin
 * `fetch` in `cors` mode is refused unless the page sends an
 * `Access-Control-Allow-Origin` that names this origin, which an arbitrary page
 * has no reason to do — the promise rejects and what the server actually said
 * never arrives. `no-cors` resolves instead, with an opaque response: status 0,
 * body unreadable, a 404 indistinguishable from a 200. "Answered 2xx, and here
 * is its title" is not something one origin is allowed to learn about another,
 * so an edge function does the fetch and this asks it.
 *
 * The function is invoked through the Supabase client, which is what puts the
 * user's access token on the request: the function verifies it, so a preview is
 * something people signed in to this app can ask for rather than an open proxy
 * for anybody who finds the URL.
 *
 * Everything that comes back is treated as data from outside, because it is —
 * it went through somebody else's web page on the way. This file's whole job
 * beyond the call is to answer in a shape the popover can draw without deciding
 * anything: `ok` or not, and strings that are strings.
 */

/** The function's name, which is also its path on the project. */
export const FUNCTION = 'link-preview';

/** Longest title and description worth carrying to a panel three lines tall. */
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 400;

const asText = (value, limit) => {
  if (typeof value !== 'string') return null;
  // Collapsed, because a page's meta description is often laid out across
  // several lines of source and a panel wants a sentence.
  const text = value.replace(/\s+/g, ' ').trim().slice(0, limit);
  return text || null;
};

/**
 * What the function said, as the popover's four fields.
 *
 * Exported for its own tests: this is the boundary where a stranger's page
 * becomes something this app draws, and every rule about what is allowed
 * through is here rather than spread across the view.
 */
export function normalisePreview(payload, href) {
  const status = Number.isInteger(payload?.status) ? payload.status : 0;
  const ok = payload?.ok === true && status >= 200 && status < 300;

  if (!ok) return { ok: false, status };

  return {
    ok: true,
    status,
    title: asText(payload.title, TITLE_LIMIT),
    description: asText(payload.description, DESCRIPTION_LIMIT),
    // The function reports where it ended up, which is not always where it was
    // sent — a redirect is worth seeing. Falls back to the link's own host.
    host: asText(payload.host, 120) ?? hostOf(href),
    // Only a base64 data URL of a raster type is drawn, which is the same rule
    // an image object on the board follows. The function inlines the thumbnail
    // precisely so that the browser makes no request to the previewed site.
    image: isImageSource(payload.image) ? payload.image : null,
  };
}

/**
 * A fetcher for `createLinks`, or null when there is no project to ask.
 *
 * Rejects only when the *asking* failed — the function is not deployed, the
 * network went, the session is not accepted. That is a different thing from a
 * link that could not be reached, and the popover says so differently: one is
 * "this page did not answer", the other is "we could not check".
 */
export function createLinkPreview({ client, functionName = FUNCTION } = {}) {
  if (!client) return null;

  return async function preview(href) {
    const { data, error } = await client.functions.invoke(functionName, { body: { url: href } });
    if (error) throw error;
    return normalisePreview(data, href);
  };
}
