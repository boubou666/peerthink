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
const BARE = String.raw`(?:https?:\/\/|www\.)[^\s<>"'\`\\]+`;

/**
 * A link that reads as words rather than as an address: `[our roadmap](https://…)`.
 *
 * This is the one shape of link the document does not simply happen to contain
 * — it is written by "add a link" over a selection, because a label and an
 * address are two things and a plain string has room for one. Markdown's
 * spelling, because it is the one people already know and already type, and
 * because a card holding these characters says what it means to somebody
 * reading the text rather than the screen.
 *
 * The label stops at the first `]`, so nothing has to be escaped and no reader
 * has to know an escape. A label *containing* one is therefore not a link: the
 * characters stay as they are, which is what everything unrecognised does here,
 * and is why the control that writes these is not offered for such a selection.
 *
 * One level of balanced parentheses in the address, for the same Wikipedia URLs
 * `trimTrailing` exists for — `[Ruby](https://en.wikipedia.org/wiki/Ruby_(gem))`
 * would otherwise end at the wrong bracket.
 */
const LABELLED = String.raw`\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)`;

/** Both shapes, in one pass. Labelled first: its address is a bare link too. */
const LINK = new RegExp(`${LABELLED}|${BARE}`, 'gi');

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
  return addressOf(trimTrailing(String(raw ?? '')));
}

/**
 * The same judgement, on characters that are already exactly the address.
 *
 * Trailing punctuation is a question prose asks. The address inside
 * `[label](…)` is delimited by the bracket that closes it, and one typed into a
 * field that asks for an address is all of what was typed — so neither goes
 * through `trimTrailing`, and a URL ending in a full stop survives being
 * written down deliberately.
 */
function addressOf(text) {
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
 * `source` is the characters the document holds, and is there only when they are
 * not the characters on screen — which is exactly the labelled links, whose
 * whole point is that the two differ. So "rebuild the string" is
 * `run.source ?? run.text`, and everything that reads a field back has to say
 * that or lose the address: `innerText` over a labelled link reads its label.
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
    const [whole, label, address] = match;
    prose(source.slice(at, match.index));

    // A labelled one, which the alternation matched first. Its address is
    // already exactly an address — see `addressOf`.
    if (label !== undefined) {
      const href = addressOf(address);
      if (href) runs.push({ text: label, href, source: whole });
      else prose(whole);
      at = match.index + whole.length;
      continue;
    }

    const raw = trimTrailing(whole);
    const href = hrefFor(raw);
    if (href) runs.push({ text: raw, href });
    else prose(raw);

    // What `trimTrailing` gave back stays in the string: the punctuation after
    // a link is prose, and the next iteration has to see it.
    at = match.index + raw.length;
  }

  prose(source.slice(at));
  return runs;
}

/**
 * What text reads as, with every labelled link showing its label.
 *
 * The screen gets this from the runs; the PNG export and anything else drawing
 * a string rather than elements gets it from here, so a picture of a board says
 * "our roadmap" where the board does rather than the address in brackets.
 */
export const displayText = (text) => linkRuns(text).map((run) => run.text).join('');

/** The characters that put `label` in a document as a link to `href`. */
const linkSource = (label, href) => `[${label}](${href})`;

/**
 * An address somebody typed into a field that asked for one, as an href.
 *
 * A bare domain counts here, and deliberately does not in prose: `example.com`
 * on a card is as likely to be a file or a sentence, but the same six
 * characters answering "where should this go" are an address and nothing else.
 * Everything past that is `addressOf`'s judgement — the scheme allow-list and
 * the credentials refusal are the same ones, because this href ends up in the
 * same `href` attribute.
 */
export function linkFrom(typed) {
  const text = String(typed ?? '').trim();
  if (!text) return null;

  const parsed = addressOf(text);
  if (parsed) return parsed;

  // Something with a dot in it and no scheme, path or query in front of the
  // dot: `example.com/x` yes, `javascript:alert(1)` no, `hello there` no.
  return /^[^\s:/?#]+\.[^\s:/?#]/.test(text) ? addressOf(`https://${text}`) : null;
}

/**
 * `text` with the characters in `[start, end)` turned into a link to `href`.
 *
 * The offsets are into the string, not into anything a browser knows about —
 * whoever has a selection is responsible for turning it into two numbers, and
 * this stays the pure half that can be tested without one. Out-of-range offsets
 * are clamped rather than refused, because the alternative is a caller that has
 * to bounds-check the string it just measured.
 *
 * An empty range gives the text back: a link with no label is a link nobody can
 * click, and `[](https://…)` is not recognised as one anyway.
 */
export function linkedText(text, start, end, href) {
  const source = String(text ?? '');
  const from = Math.min(Math.max(start, 0), source.length);
  const to = Math.min(Math.max(end, from), source.length);
  const label = source.slice(from, to);
  if (!label) return source;
  return source.slice(0, from) + linkSource(label, href) + source.slice(to);
}

/**
 * Whether a run of text can become a link's label.
 *
 * Empty, or nothing but spaces: there is nothing to click. Already a link: the
 * answer to "make this a link" is that it is one, and wrapping it would make an
 * address that reads as an address point at a different place — which is the
 * trick `hrefFor` refuses credentials over. A `]` in it: see `LABELLED`, where
 * the label ends.
 */
export const canLabel = (text) => {
  const label = String(text ?? '');
  return Boolean(label.trim()) && !label.includes(']') && !hasLink(label);
};

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
