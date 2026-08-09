import { absoluteUrl, extractMeta } from './extract.js';
import {
  MAX_BYTES,
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  checkUrl,
  isBlockedAddress,
} from './guard.js';

/**
 * What is at a link — fetched here, because a browser is not allowed to know.
 *
 * A page cannot learn the status of a cross-origin response: `cors` mode rejects
 * whatever the server said, and `no-cors` mode hands back an opaque object whose
 * status is 0 and whose body cannot be read, identically for a 200 and a 404. So
 * "did it answer 2xx, and what is it" is a question only something outside the
 * browser can answer, and this is that something.
 *
 * It is deliberately the smallest thing that answers it:
 *
 *   POST { url }  →  { ok: true,  status, host, title, description, image }
 *                 →  { ok: false, status }
 *
 * **It evaluates nothing it fetched.** The page is read as text, its head is
 * matched for meta tags, and strings come out. There is no parser, no `eval`, no
 * dynamic import and no rendering — nothing that could run a script the page
 * wanted run. The client puts what comes back into the document with
 * `textContent`, and the thumbnail through the same data-URL guard an image
 * pasted onto a board goes through.
 *
 * **It is not an open proxy.** `verify_jwt` is on, so the caller is somebody
 * signed in to this app; `guard.js` decides what may be fetched, and is applied
 * to the URL, to every address its name resolves to, and to every redirect.
 *
 * Written in plain JavaScript rather than TypeScript, so its two halves that
 * contain all the judgement — the guard and the extraction — are modules the
 * repository's own `node --test` suite imports directly. Nothing else here is
 * TypeScript either.
 */

const JSON_HEADERS = {
  'content-type': 'application/json',
  // The caller is a static site on another origin, and the function is invoked
  // with an Authorization header, so the preflight has to be answered. `*` grants
  // nothing here: every request is checked against a JWT, and there are no
  // cookies in play for a wildcard to widen.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const answer = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/**
 * The one thing a caller is told when a URL is refused: nothing.
 *
 * A refusal and a silence answer identically, and that is the point. Any
 * difference between "that host is not allowed" and "that host did not reply"
 * turns this into a scanner for the private network it runs inside, reporting
 * which internal addresses exist a few hundred times a second.
 */
const NO_ANSWER = { ok: false, status: 0 };

/** What to call ourselves, so a site's logs can see who came asking and why. */
const USER_AGENT = 'PeerThink link preview (+https://boubou666.github.io/peerthink/)';

/**
 * Whether a name resolves anywhere it must not be fetched.
 *
 * The literal checks in `guard.js` catch `http://127.0.0.1/` and
 * `http://[::1]/`; this catches `http://internal.example.com/` that happens to
 * be an A record for `10.0.0.5`, which is the form the attack actually takes.
 *
 * **The residual risk is DNS rebinding**, and it is not closed here: the name is
 * resolved, checked, and then handed to `fetch`, which resolves it again. A
 * server that answers with a public address once and a private one a moment later
 * gets through. Closing it means connecting to a checked address and carrying the
 * host in a header, which `fetch` gives no way to do. It is written down rather
 * than papered over.
 */
async function resolvesSomewhereBlocked(hostname) {
  if (typeof Deno?.resolveDns !== 'function') return false;

  const records = await Promise.all(['A', 'AAAA'].map((type) =>
    Deno.resolveDns(hostname, type).catch(() => [])));

  const addresses = records.flat();
  // No records at all is not a refusal — it is a name that will not resolve for
  // `fetch` either, and that is an unreachable link rather than a blocked one.
  return addresses.some((address) => isBlockedAddress(address));
}

/** Read at most `limit` bytes of a body, then stop pulling. */
async function readCapped(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= limit) break;
    }
  } finally {
    // Cancelled rather than left open: this is a page we have stopped caring
    // about, and the connection should go with the interest.
    await reader.cancel().catch(() => {});
  }

  const body = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= body.length) break;
    body.set(chunk.subarray(0, body.length - at), at);
    at += chunk.length;
  }
  return body;
}

/**
 * Fetch, following redirects by hand so each hop can be checked.
 *
 * `redirect: 'follow'` would let a public URL redirect into the private network
 * on a hop nothing looked at, which is the standard way around a guard that only
 * checks what it was given.
 */
async function fetchGuarded(target, { accept }) {
  let url = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = checkUrl(url);
    if (checked.refused) return { refused: checked.refused };
    if (await resolvesSomewhereBlocked(checked.url.hostname)) return { refused: 'resolves-private' };

    let response;
    try {
      response = await fetch(checked.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept, 'user-agent': USER_AGENT, 'accept-language': 'en' },
      });
    } catch {
      // Refused, timed out, DNS failure, TLS failure: from here they are all
      // "no answer", which is what the person hovering needs to know.
      return { status: 0 };
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = absoluteUrl(checked.url.href, location);
      // Nothing to follow, so the redirect itself is the answer — and it is not
      // a 2xx, so it reads as unreachable.
      if (!next) return { status: response.status };
      await response.body?.cancel().catch(() => {});
      url = next;
      continue;
    }

    return { response, url: checked.url, status: response.status };
  }

  // Still redirecting after MAX_REDIRECTS. A loop, or a chain nobody needs.
  return { status: 0 };
}

/** A thumbnail as a data URL, or null. Every way this can fail ends in null. */
async function inlineImage(source) {
  const found = await fetchGuarded(source, { accept: 'image/*' });
  if (found.refused || !found.response) return null;
  if (found.status < 200 || found.status >= 300) {
    await found.response.body?.cancel().catch(() => {});
    return null;
  }

  const type = (found.response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  // The same set the board draws, so what comes back is something the client's
  // own guard will accept rather than something it silently drops.
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) {
    await found.response.body?.cancel().catch(() => {});
    return null;
  }

  const bytes = await readCapped(found.response, MAX_IMAGE_BYTES + 1);
  // Over the cap means a picture that arrived truncated, which would draw as a
  // broken image. Better none than half of one.
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;

  let binary = '';
  // In chunks: `String.fromCharCode(...bytes)` with a hundred thousand arguments
  // overflows the call stack.
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** A file name from a path, for a link to something that is not a page. */
const fileNameOf = (url) => decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '') || url.hostname;

const KILOBYTE = 1024;
const readableSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < KILOBYTE) return `${bytes} bytes`;
  if (bytes < KILOBYTE * KILOBYTE) return `${Math.round(bytes / KILOBYTE)} KB`;
  return `${(bytes / KILOBYTE / KILOBYTE).toFixed(1)} MB`;
};

async function preview(raw) {
  const found = await fetchGuarded(raw, { accept: 'text/html,*/*' });

  // Both answer the same thing on purpose — see NO_ANSWER.
  if (found.refused) {
    console.log(`refused: ${found.refused}`);
    return NO_ANSWER;
  }
  if (!found.response) return { ok: false, status: found.status ?? 0 };

  const { response, url, status } = found;
  if (status < 200 || status >= 300) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status };
  }

  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const host = url.hostname.replace(/^www\./, '');

  // Not a page: there is no title to read, and the honest preview of a PDF is
  // that it is a PDF and how big.
  if (type && !/^(text\/html|application\/xhtml\+xml|text\/plain)$/.test(type)) {
    const size = readableSize(Number(response.headers.get('content-length')));
    await response.body?.cancel().catch(() => {});
    return {
      ok: true,
      status,
      host,
      title: fileNameOf(url),
      description: size ? `${type}, ${size}` : type,
      image: null,
    };
  }

  const bytes = await readCapped(response, MAX_BYTES);
  // `fatal: false` — a page in an encoding this does not know, or bytes cut in
  // half by the cap, gives replacement characters rather than an exception. A
  // title with one odd glyph in it beats no preview at all.
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const meta = extractMeta(html);

  return {
    ok: true,
    status,
    host,
    title: meta.title,
    description: meta.description,
    image: await inlineImage(absoluteUrl(url.href, meta.image)),
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (request.method !== 'POST') return answer({ error: 'POST a { url }' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return answer({ error: 'POST a { url }' }, 400);
  }

  if (typeof body?.url !== 'string') return answer({ error: 'POST a { url }' }, 400);

  try {
    return answer(await preview(body.url));
  } catch (error) {
    // A fault of ours is not the link being unreachable, and the client draws
    // the two differently — so this is a 500 rather than a tidy `ok: false`.
    console.error('link-preview failed', error);
    return answer({ error: 'the preview could not be made' }, 500);
  }
});
