/**
 * Whether the map is showing, remembered by this browser.
 *
 * Per browser rather than per board, and not in the store, for the reason
 * `recent-colours.js` gives at length: a board's ops are broadcast to everyone
 * editing it and enter the undo stack, and "I would rather not look at the map"
 * is a fact about a person at a screen, not about the document. Minimizing it on
 * one board minimizes it on all of them, which is what a panel does everywhere
 * else.
 *
 * Showing is the default, because a panel nobody has met yet has to be met.
 * Anything that is not the word this wrote — a missing record, a store that
 * throws, a value from a future version — reads as showing for the same reason.
 */

const KEY = 'peerthink:minimap';

const CLOSED = 'closed';
const OPEN = 'open';

export function createMinimapState({ storage, key = KEY } = {}) {
  return {
    open() {
      try {
        return storage?.getItem(key) !== CLOSED;
      } catch {
        // Reading can throw outright in a privacy mode, not merely answer null.
        return true;
      }
    },

    set(open) {
      try {
        storage?.setItem(key, open ? OPEN : CLOSED);
      } catch {
        // A full or refused store costs the memory of the choice, not the
        // choice: this session has already made it.
      }
    },
  };
}
