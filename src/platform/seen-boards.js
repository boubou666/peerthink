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

/**
 * How many ids the record keeps.
 *
 * The record used to be pruned to whatever was listed, which bounded it for
 * free — but the list is a page now, and pruning against one page would drop
 * every board below it and hand them all a "New" badge on the way back. So the
 * record only grows, and this is what stops it growing for ever.
 *
 * Freshest first, so what falls off the end is what this browser has not seen
 * mentioned in the longest time. A board that falls off and is later listed
 * again is announced as new when it is not — the cost of the cap, paid by
 * whoever has had several thousand boards through one browser, and cheap
 * against a badge on everything.
 */
export const RECORD_LIMIT = 2000;

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

  /** Answers whether the record was actually kept, which the caller needs. */
  const write = (ids) => {
    if (!storage) return false;
    try {
      storage.setItem(key, JSON.stringify([...ids]));
      return true;
    } catch {
      // A full or refused store costs a badge, not a board.
      return false;
    }
  };

  return {
    /**
     * Reconcile the stored record against the boards just listed, and answer
     * which of those the user has not seen here.
     *
     * The first call for an account seeds instead of answering. Everything
     * already in the workspace when this browser first looks is not new — it
     * is simply the workspace — and flagging all of it would make the badge
     * mean nothing on the one visit where it is most visible.
     *
     * What arrives here is one *page* of one scope, which is why nothing is
     * pruned against it any more. Dropping the ids it does not mention used to
     * be how the record stayed bounded; against a page it would forget every
     * board further down the list and every board in the other scope, and hand
     * each of them a badge the next time they were listed. `RECORD_LIMIT`
     * bounds it instead.
     *
     * Nothing is *added* either, which is the older rule and the more
     * important one: being listed is not being looked at. `markSeen` is what
     * records that a board has been shown, and a reconcile that recorded the
     * boards it announced would clear every badge on the next refresh —
     * before anyone had read them.
     *
     * So the write here changes nothing, and is still worth making: it is what
     * asks whether the record can be written at all. A store that reads and
     * refuses to write cannot clear a badge later either, and is handled below.
     *
     * `seed` extends the first-look rule across a paginated first look. The
     * record's absence marks the first page; every later page of that same
     * visit is still the workspace as found rather than news, and the caller
     * is the only one that knows the visit is still going on.
     */
    reconcile(listed, { seed = false } = {}) {
      const ids = [...listed];
      const seen = read();

      if (seen === null || seed) {
        // Listed first, so the cap keeps what was seen most recently. A Set
        // preserves insertion order, and re-adding an id already present does
        // not move it.
        write([...new Set([...ids, ...(seen ?? [])])].slice(0, RECORD_LIMIT));
        return new Set();
      }

      const kept = write([...seen].slice(0, RECORD_LIMIT));
      const unseen = new Set(ids.filter((id) => !seen.has(id)));

      /**
       * A store that reads but will not write — a full quota, or a privacy
       * mode that allows one and not the other — leaves the old record in
       * place, so `markSeen` cannot clear anything either. Every badge shown
       * now would come back on every visit for ever, which is precisely the
       * noise nobody can switch off that the absent-storage case is careful to
       * avoid. Readable and unwritable is the same situation as no storage at
       * all, and is answered the same way.
       */
      return kept ? unseen : new Set();
    },

    /**
     * Whether this account has a record here yet — which is to say, whether
     * this browser has ever shown it a list.
     *
     * Asked before the first page of a visit, so the caller can tell a first
     * look from a return visit and go on seeding for the pages that follow.
     * `reconcile` cannot answer it on the caller's behalf: an empty answer
     * from it means "nothing here is new", and a first look and a settled
     * workspace both produce exactly that.
     */
    hasRecord: () => read() !== null,

    /** This board has now been shown. Opening one is what clears its badge. */
    markSeen(id) {
      const seen = read() ?? new Set();
      if (seen.has(id)) return;
      // At the front, and capped like `reconcile` writes: the board being
      // opened right now is the last one that should fall off the end.
      write([id, ...seen].slice(0, RECORD_LIMIT));
    },
  };
}
