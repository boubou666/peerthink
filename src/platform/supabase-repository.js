import { DEFAULT_TITLE, RECORD_VERSION, isBoard } from './storage.js';

/**
 * The board repository, against Postgres.
 *
 * Same contract as the Web Storage one — list / load / save / rename / remove,
 * every call async, and every call total but `list()`. Nothing above this file
 * knows which of the two it is holding, which is the whole reason the contract
 * was made async before there was anything asynchronous behind it.
 *
 * Access is not enforced here. Every statement goes through row level
 * security, so "your boards" is not a filter this code applies — it is what
 * the database will answer with. A `list()` with no `where` clause is correct
 * and is exactly what the policies are for; a filter here would be a second,
 * weaker copy of a rule that already exists in one place.
 *
 * Failures are answered, never thrown — except by `list()`. Offline, a dropped
 * connection, a policy that says no: a write comes back false and an absent
 * board comes back null, and the session keeps working from memory. The canvas
 * is not worth losing over a failed write.
 *
 * `list()` cannot play along, because it has no honest value to fail with. The
 * empty list it used to return is what the board list renders as "No boards
 * yet" — an account reported empty on the strength of a query that never
 * arrived, which to the person reading it is indistinguishable from having lost
 * everything. So it rejects, and the page above says it could not load rather
 * than saying there is nothing to load.
 */

/** Postgres hands back an ISO timestamp; the contract wants epoch millis. */
const toMillis = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

const toSummary = (row) => ({
  id: row.id,
  title: typeof row.title === 'string' ? row.title : DEFAULT_TITLE,
  updatedAt: toMillis(row.updated_at),
});

export function createSupabaseRepository({ client, auth, table = 'boards' }) {
  const from = () => client.from(table);

  /**
   * The version of each board this repository has actually read, and the
   * version each of its own writes produced.
   *
   * This is what makes a save a claim rather than an assertion: "replace the
   * document I last saw" instead of "replace whatever is there". A client
   * whose view has fallen behind — one that lost the live channel and kept
   * editing — writes a version that is no longer current and is refused,
   * rather than overwriting work it never received.
   *
   * A board absent from this map has never been read here, so no such claim
   * can be made about it; that write is a creation, and is unguarded.
   */
  const versions = new Map();

  return {
    /**
     * Every board the caller can see, newest first — theirs and any shared
     * with them. One query against the (owner_id, updated_at desc) index,
     * where the local repository has to parse every stored board to answer.
     *
     * Rejects when the query fails; see the note at the top of this file. A
     * caller that wants the old behaviour can `.catch(() => [])`, but it then
     * owns the claim that the account is empty.
     */
    async list() {
      const { data, error } = await from()
        .select('id, title, updated_at, owner_id')
        .order('updated_at', { ascending: false });

      if (error) throw new Error(`could not list boards: ${error.message}`, { cause: error });

      // `owned` is the difference between a board you can delete and one you
      // can only walk away from. The list is where that choice is offered, so
      // it is the list that has to know — and one extra column answers it,
      // where asking board_role() per row would be a query each.
      const me = auth.current()?.id;
      return data.map((row) => ({ ...toSummary(row), owned: row.owner_id === me }));
    },

    /**
     * maybeSingle, not single: a board that is not there — deleted, never
     * created, or simply not yours — is a null answer, not an error. The
     * caller seeds a fresh board on null, which is the right response to all
     * three.
     */
    async load(id) {
      const { data, error } = await from()
        .select('id, title, doc, updated_at, version')
        .eq('id', id)
        .maybeSingle();

      if (error || !data || !isBoard(data.doc)) return null;

      // Reading is what earns the right to write: from here on, this
      // repository's saves say which version they are replacing.
      versions.set(id, data.version);
      return { v: RECORD_VERSION, ...toSummary(data), board: data.doc };
    },

    /**
     * Update, then insert if there was nothing to update.
     *
     * Not an upsert, and the reason is the trigger: an upsert has to name
     * owner_id in its payload, and an editor saving a board someone else owns
     * would be sending their own id for a column `freeze_board_owner` refuses
     * to let change. Update-then-insert sends owner_id only on the path that
     * genuinely creates the row, so the editor's save is a plain update and
     * the owner's first save still works.
     *
     * The cost is a second round trip on the first save of a board, and a
     * third in the rare case below. Every later save — which is to say every
     * autosave — is one statement.
     */
    async save(id, board, { title } = {}) {
      if (!isBoard(board)) return false;

      // A save with no title must not overwrite one: autosave calls this on
      // every settled edit, and it has no idea what the board is called.
      const patch = title === undefined ? { doc: board } : { doc: board, title };
      const expected = versions.get(id);

      const write = async () => {
        const query = from().update(patch).eq('id', id);
        const guarded = expected === undefined ? query : query.eq('version', expected);
        const { data, error } = await guarded.select('version');

        if (error || !data.length) return { error, wrote: false };
        versions.set(id, data[0].version);
        return { wrote: true };
      };

      const updated = await write();
      if (updated.wrote) return true;
      if (updated.error) return false;

      /**
       * Nothing was updated, and this board has been read here — so the row
       * is not missing, it is no longer ours to replace. Someone else's
       * version is current, or the board has been deleted out from under us,
       * and the insert below would answer the second case by resurrecting a
       * board its owner threw away.
       */
      if (expected !== undefined) return false;

      const ownerId = auth.current()?.id;
      if (!ownerId) return false;

      const inserted = await from().insert({ id, owner_id: ownerId, ...patch }).select('version');
      if (!inserted.error) {
        // The row is normally returned; a policy that permits the insert and
        // not the read would hand back nothing, and indexing that would throw
        // out of a method whose whole contract is that it answers.
        const version = inserted.data?.[0]?.version;
        if (version !== undefined) versions.set(id, version);
        return true;
      }

      // Two tabs opening the same new board both find nothing to update and
      // both insert; one of them loses on the primary key. The row it wanted
      // now exists, so the update it should have done is available — and
      // this is also the path a viewer takes, where that update finds no row
      // it is allowed to touch and the answer is an honest false.
      if (inserted.error.code !== '23505') return false;
      return (await write()).wrote;
    },

    /**
     * False when nothing was renamed — the board does not exist yet, or is
     * not yours to rename. The caller distinguishes the two by what it does
     * next: BoardPage falls back to save(), which creates the row it owns and
     * still fails for a board it does not.
     */
    async rename(id, title) {
      const { data, error } = await from().update({ title }).eq('id', id).select('id');
      return !error && data.length > 0;
    },

    /**
     * True when the delete was accepted, matching the local repository: a
     * board that was already gone is not a failure to report. Only the owner
     * gets past the policy, so an editor's delete removes nothing and still
     * answers true — the list refresh that follows is what tells the truth.
     */
    async remove(id) {
      const { error } = await from().delete().eq('id', id);
      return !error;
    },

    /**
     * Nothing to adopt. The legacy key is a Web Storage address, and a board
     * kept there belongs to a browser rather than to an account — moving it
     * into one is a decision about whose boards those are, not a detail this
     * repository can settle on its own.
     */
    async migrateLegacy() {
      return false;
    },
  };
}
