import { normaliseHex } from '../core/colour.js';

/**
 * The colours this browser has mixed lately.
 *
 * The palette answers for the colours the app has a name for. Everything else
 * is mixed in the square or typed into the hex field, and until now the second
 * card to be given that colour had to have it mixed again — a picker that
 * forgets is one you use once and then work around.
 *
 * Per browser rather than per board, because it is a fact about the person
 * doing the colouring rather than about the document: a palette carried from
 * one board to the next is what makes a set of boards look like they belong to
 * the same hand. It is also why this is not in the store — a board's ops are
 * broadcast to everyone editing it and enter the undo stack, and neither is
 * true of "I used this colour once".
 *
 * Only colours the palette does not already have a name for are worth keeping:
 * a row that repeats the swatches directly above it is a row that says nothing.
 * That is the caller's judgement, since only it knows what the palette holds.
 *
 * Storage is injected and allowed to be absent — in a privacy mode with no Web
 * Storage the row simply never appears, which is a missing convenience rather
 * than a broken picker.
 */

const KEY = 'peerthink:recent-colours';

/**
 * How many are kept: one row of the panel, at the panel's width.
 *
 * A second row would push the hex field further from the square it belongs to,
 * and a list long enough to scan is a list you have to read — by which point
 * mixing the colour again is quicker.
 */
export const RECENT_LIMIT = 6;

export function createRecentColours({ storage, key = KEY } = {}) {
  const read = () => {
    if (!storage) return [];
    try {
      const raw = storage.getItem(key);
      const list = raw === null ? [] : JSON.parse(raw);
      // Anything that is not a colour is dropped rather than shown: this is
      // read back out of a store anything on this origin can write to, and it
      // ends up in a CSS custom property — the same reason `card-style.js`
      // refuses what is not plainly a colour.
      return Array.isArray(list) ? list.map(normaliseHex).filter(Boolean).slice(0, RECENT_LIMIT) : [];
    } catch {
      // Unreadable or not JSON: no history rather than a broken picker.
      return [];
    }
  };

  return {
    list: read,

    /**
     * Remember a colour, most recent first, and answer the list as it now
     * stands.
     *
     * Re-using a colour moves it to the front rather than adding it twice —
     * the list is "what you have been working with", and a duplicate spends a
     * slot saying the same thing.
     *
     * The answer is read back rather than assumed, so it is the list the next
     * visit will see. A store that is absent or refuses the write answers what
     * it had before, and the row stays as it was instead of filling up with
     * colours that will be gone on reload — a picker that forgets between
     * sessions is a shame, and one that forgets between two clicks is a bug
     * report.
     */
    add(value) {
      const hex = normaliseHex(value);
      if (!hex) return read();

      const next = [hex, ...read().filter((seen) => seen !== hex)].slice(0, RECENT_LIMIT);
      try {
        storage?.setItem(key, JSON.stringify(next));
      } catch {
        // A full or refused store costs the memory of a colour, not the colour.
      }
      return read();
    },
  };
}
