/**
 * What copied objects look like on a clipboard.
 *
 * The system clipboard is a bag of strings keyed by MIME type, and the only key
 * every browser, every tab and every other program agrees about is
 * `text/plain`. So a copied selection travels as text: a JSON envelope with a
 * marker, which `readClipboard` recognises and everything else ignores.
 *
 * The cost is visible and accepted — copy three cards, paste into a text editor
 * and you get JSON. The alternative is a custom clipboard type, which pastes
 * into a text editor as nothing at all and, more importantly, is not carried
 * between browsers or reliably between tabs. Text is what makes a card copied
 * on one board appear on another, which is most of the point.
 *
 * Nothing here knows what a card is. This file decides that a payload is *ours*
 * and structurally sound; `Board#paste` decides whether the vocabulary is one it
 * speaks, because Board is where the vocabulary lives.
 */

/**
 * The marker. Namespaced, because the thing being read is arbitrary text from
 * an arbitrary program — a bare `{ objects: [...] }` is a shape somebody else's
 * JSON can also have, and pasting their file into a board should do nothing
 * rather than something surprising.
 */
export const CLIPBOARD_KIND = 'peerthink/objects';

/**
 * The payload format. Read strictly: a version this build does not know is a
 * payload whose fields may mean something else, and a newer client's copy is
 * better refused than half-understood — the same call `sync.js` makes about an
 * op it cannot read.
 */
export const CLIPBOARD_VERSION = 1;

/** Whether a copied entry is enough of an object to place. */
const isPlaceable = (obj) =>
  Boolean(obj)
  && typeof obj === 'object'
  && typeof obj.type === 'string'
  && [obj.x, obj.y, obj.w, obj.h].every((n) => typeof n === 'number' && Number.isFinite(n))
  && obj.w > 0
  && obj.h > 0;

/**
 * Objects as clipboard text.
 *
 * The objects go in whole, ids included. The ids are not what a paste uses —
 * `Board#paste` mints new ones, because the same object cannot be in a document
 * twice — but a copy is a copy of what was there, and deciding here which
 * fields a future version of the app will care about is how a clipboard format
 * loses information nobody meant to drop.
 */
export function writeClipboard(objects) {
  return JSON.stringify({
    kind: CLIPBOARD_KIND,
    v: CLIPBOARD_VERSION,
    objects: objects.map((obj) => structuredClone(obj)),
  });
}

/**
 * Clipboard text as objects, or null when it is not ours.
 *
 * Null covers every ordinary way this ends: an empty clipboard, a paragraph
 * copied from a web page, a payload from a version that writes something else.
 * None of them is an error — they are simply not a paste this board can make,
 * and the browser's own handling is left to it.
 *
 * Entries that are not placeable are dropped rather than taking the payload
 * with them. Unlike an op batch — where one unreadable op means the rest are
 * being misread too — a clipboard is a flat list of independent things, and
 * pasting four of the five cards somebody copied beats pasting none.
 */
export function readClipboard(text) {
  // Before JSON.parse, which is the expensive part and would run on every
  // paste of every unrelated thing — including a document-sized one.
  if (typeof text !== 'string' || !text.includes(CLIPBOARD_KIND)) return null;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }

  if (payload?.kind !== CLIPBOARD_KIND || payload.v !== CLIPBOARD_VERSION) return null;
  if (!Array.isArray(payload.objects)) return null;

  const objects = payload.objects.filter(isPlaceable);
  return objects.length ? objects : null;
}
