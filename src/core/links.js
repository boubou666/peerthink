/**
 * Links inside a board's text: finding them, and deciding which are real.
 *
 * Text on this board is a plain string — that is what the store holds, what a
 * paste is forced into, and what `innerText` reads back. Nothing marks a link
 * up, so a link is whatever *looks* like one, which makes this a recogniser
 * rather than a parser. It runs on the way out, in the view, and the document
 * keeps the characters the person typed.
 *
 * Pure, and in core, because "is that a link and where does it end" is the part
 * with all the judgement in it and none of the browser. The view turns runs into
 * elements; the input layer decides what a click does; both ask this.
 */

/**
 * What a link looks like in prose.
 *
 * An explicit scheme, or `www.`. Deliberately not bare domains: `readme.md`,
 * `e.g.something`, `3.14` and half the file names anyone writes on a card would
 * all become links, and a link nobody asked for is worse than a link they have
 * to type six characters for. `www.` is the one exception because it is
 * unambiguous — nothing else is spelled that way.
 *
 * `<`, `>`, quotes and backticks end a match, so `<https://x>` and "https://x"
 * give up the punctuation somebody wrapped them in.
 */
const LINK = /(?:https?:\/\/|www\.)[^\s<>"'`\\]+/gi;

/** Sentence punctuation that is far more likely to be prose than URL. */
const TRAILING = /[.,;:!?…'"”’»]+$/;

/** Brackets a URL may legitimately contain, and so cannot simply be stripped. */
const PAIRS = [['(', ')'], ['[', ']'], ['{', '}']];

const occurrences = (text, ch) => {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
};

/**
 * Where a link stops, when prose continues after it.
 *
 * "see https://example.com/a." ends a sentence; the full stop is not part of
 * the address. But Wikipedia's URLs are full of brackets, so a closing one is
 * only dropped when nothing in the match opened it — which is exactly the
 * difference between `(see https://en.wikipedia.org/wiki/Ruby_(gem))` and
 * `https://en.wikipedia.org/wiki/Ruby_(gem)`.
 *
 * A trailing slash is left alone: it is part of the path, and every URL that
 * ends in one means it.
 */
export function trimTrailing(raw) {
  let text = raw.replace(TRAILING, '');

  for (;;) {
    const pair = PAIRS.find(([open, close]) =>
      text.endsWith(close) && occurrences(text, close) > occurrences(text, open));
    if (!pair) return text;
    text = text.slice(0, -1).replace(TRAILING, '');
  }
}

/**
 * The address a matched run points at, or null when it does not point anywhere
 * this app will follow.
 *
 * **The scheme allow-list is a security boundary, not tidiness.** This text
 * arrives from anyone authorised to edit the board, and the result ends up in an
 * `href` that somebody is going to click: `javascript:` there runs in this
 * origin, with this session. So the answer is parsed rather than pattern-matched
 * — `\njavascript:alert(1)` and `JaVaScRiPt:` are both what `new URL` says they
 * are — and only http and https come back.
 *
 * Credentials are refused too. `https://docs.example.com@evil.test/` reads as
 * the first host and *is* the second one, which is a trick played on the person
 * reading the card rather than on the browser.
 */
export function hrefFor(raw) {
  const text = trimTrailing(String(raw ?? ''));
  if (!text) return null;

  // `www.` has no scheme to parse. https, not http: a bare `www.` in 2026 means
  // the secure one, and a host that only answers on http will redirect.
  const candidate = /^www\./i.test(text) ? `https://${text}` : text;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;

  return url.href;
}

/**
 * Text as a list of runs: `{ text }` for prose, `{ text, href }` for a link.
 *
 * The whole string is always covered, in order, so a caller can rebuild it
 * exactly — the view depends on that, because what it renders has to read back
 * through `innerText` as the string the store holds. A run that looks like a
 * link but points nowhere followable comes back as prose, which is what it is.
 *
 * Adjacent prose runs are merged for the same reason: fewer text nodes than
 * characters is the difference between a card and a card the browser has to
 * reconcile.
 */
export function linkRuns(text) {
  const source = String(text ?? '');
  const runs = [];
  let at = 0;

  const prose = (piece) => {
    if (!piece) return;
    const last = runs[runs.length - 1];
    if (last && !last.href) last.text += piece;
    else runs.push({ text: piece });
  };

  for (const match of source.matchAll(LINK)) {
    const raw = trimTrailing(match[0]);
    const href = hrefFor(raw);

    prose(source.slice(at, match.index));
    if (href) runs.push({ text: raw, href });
    else prose(raw);

    // What `trimTrailing` gave back stays in the string: the punctuation after
    // a link is prose, and the next iteration has to see it.
    at = match.index + raw.length;
  }

  prose(source.slice(at));
  return runs;
}

/** Whether text holds anything worth rendering as a link. Cheap early out. */
export const hasLink = (text) => linkRuns(text).some((run) => Boolean(run.href));

/**
 * The host, for a popover to show under a title.
 *
 * What the browser would put in the address bar, minus a `www.` nobody reads.
 * Answers null rather than throwing for an href that is not one, because the
 * only caller is display.
 */
export function hostOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}
