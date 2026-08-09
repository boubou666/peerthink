/**
 * What a page says about itself.
 *
 * A title, a description and a thumbnail, read out of the head of an HTML
 * document with string work — no parser, because a parser is a dependency, and
 * this repository has none outside React and the Supabase client. The head's
 * meta tags are a regular enough shape for that, and the failure mode of getting
 * it wrong is a panel with no title in it rather than a wrong page or a hole in
 * anything.
 *
 * **Nothing here evaluates what it read.** No `eval`, no `new Function`, no
 * dynamic import, no template that becomes markup. Scripts in the document are
 * ignored as text like everything else, and what comes out the other end is
 * plain strings that the client puts into the page with `textContent`.
 *
 * Pure, so the suite drives it with documents written by hand rather than by
 * fetching the web.
 */

/** As much of a document as is read for a head. Bounded work on any input. */
const HEAD_LIMIT = 200_000;

/**
 * The entities that actually turn up in titles. A general decoder would be a
 * table of two thousand names; a title reading `Tom &amp; Jerry` is the case
 * that matters, and an unrecognised entity is left as the characters it is.
 */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', eacute: 'é',
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? whole;

    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);

    // Out of range, or a surrogate half, is left alone rather than turned into a
    // replacement character nobody typed.
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    return String.fromCodePoint(code);
  });
}

/** A tag's attribute, whether it is quoted with ", ' or nothing at all. */
const attribute = (tag, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
};

const clean = (value) => {
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text || null;
};

/**
 * Title, description and thumbnail, in the order a page means them.
 *
 * OpenGraph first, because a page that has bothered to write `og:title` has said
 * what it wants shown; `<title>` is what the tab says, which is often the site's
 * name as well as the page's. Twitter's tags are read as a third choice for the
 * same reason — a page that has them has been thinking about previews.
 *
 * Only the head is looked at, and only the first `HEAD_LIMIT` characters of it,
 * so a page that never closes its head costs the same as one that does.
 */
export function extractMeta(html) {
  const source = String(html ?? '').slice(0, HEAD_LIMIT);
  const head = source.split(/<\/head\s*>/i)[0];

  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const named = new Map();
  for (const tag of metas) {
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name') ?? '').toLowerCase();
    const content = attribute(tag, 'content');
    // First occurrence wins: a page repeating a tag means the first one, and a
    // later one is usually a framework's fallback.
    if (key && content && !named.has(key)) named.set(key, content);
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);

  const pick = (...keys) => {
    for (const key of keys) {
      const value = clean(named.get(key));
      if (value) return value;
    }
    return null;
  };

  return {
    title: pick('og:title', 'twitter:title') ?? clean(titleTag?.[1]),
    description: pick('og:description', 'description', 'twitter:description'),
    image: pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'),
  };
}

/**
 * A thumbnail's address, made absolute against the page it was found on.
 *
 * `og:image` is routinely a path, and a path is only a URL once you know where
 * it came from — which is the page's *final* URL, after redirects, not the one
 * that was asked for. Answers null for anything unparseable, and the caller runs
 * it through the same guard as the page itself, because fetching it is another
 * request this function makes on somebody's behalf.
 */
export function absoluteUrl(base, value) {
  if (!value) return null;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}
