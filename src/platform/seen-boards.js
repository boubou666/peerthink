/**
 * Which boards this browser has already shown its owner.
 *
 * A board can appear in the list without anything announcing it. Redeeming a
 * share link lands you on the board, so on that device you know — but the same
 * account on a second device just finds it there among the rest, and an owner
 * may add a member directly, which the policies permit and no screen does.
 * Marking what is new is the smallest honest answer: it says "you have not
 * looked at this here" rather than "somebody shared this with you", which is a
 * claim this side cannot actually make.
 *
 * Per account, because signing in as somebody else must not inherit the last
 * person's idea of what is new — the same reason the boards themselves are
 * scoped. Per browser, because it is a fact about what this screen has shown.
 *
 * Storage is injected and allowed to be absent: in a privacy mode with no Web
 * Storage every board reads as seen, which is the right way to be wrong. A
 * badge that never appears is a missing nicety; one that appears on everything,
 * every visit, is noise the user cannot switch off.
 */

const KEY = 'peerthink:seen';

export function createSeenBoards({ storage, accountId }) {
  const key = `${KEY}:${accountId}`;

  /** null — as distinct from an empty set — means this account has no record here yet. */
  const read = () => {
    if (!storage) return null;
    try {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      const ids = JSON.parse(raw);
      return Array.isArray(ids) ? new Set(ids.filter((id) => typeof id === 'string')) : null;
    } catch {
      // Unreadable or not JSON: treat it as no record rather than as an empty
      // one, so the next reconcile seeds a baseline instead of announcing the
      // whole workspace as new.
      return null;
    }
  };

  const write = (ids) => {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify([...ids]));
    } catch {
      // A full or refused store costs a badge, not a board.
    }
  };

  return {
    /**
     * Reconcile the stored record against what is actually listed, and answer
     * which of those the user has not seen here.
     *
     * The first call for an account seeds instead of answering. Everything
     * already in the workspace when this browser first looks is not new — it
     * is simply the workspace — and flagging all of it would make the badge
     * mean nothing on the one visit where it is most visible.
     *
     * Ids that are no longer listed are dropped, so the record cannot grow for
     * ever on an account whose boards come and go.
     */
    reconcile(listed) {
      const ids = [...listed];
      const seen = read();

      if (seen === null) {
        write(ids);
        return new Set();
      }

      write(ids.filter((id) => seen.has(id)));
      return new Set(ids.filter((id) => !seen.has(id)));
    },

    /** This board has now been shown. Opening one is what clears its badge. */
    markSeen(id) {
      const seen = read() ?? new Set();
      if (seen.has(id)) return;
      seen.add(id);
      write(seen);
    },
  };
}
