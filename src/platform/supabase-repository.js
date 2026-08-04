import { DEFAULT_TITLE, RECORD_VERSION, isBoard } from './storage.js';

/**
 * The board repository, against Postgres.
 *
 * Same contract as the Web Storage one — list / load / save / rename / remove,
 * every call async, every call total. Nothing above this file knows which of
 * the two it is holding, which is the whole reason the contract was made async
 * before there was anything asynchronous behind it.
 *
 * Access is not enforced here. Every statement goes through row level
 * security, so "your boards" is not a filter this code applies — it is what
 * the database will answer with. A `list()` with no `where` clause is correct
 * and is exactly what the policies are for; a filter here would be a second,
 * weaker copy of a rule that already exists in one place.
 *
 * Failures are answered, never thrown. Offline, a dropped connection, a
 * policy that says no: all of them come back as the contract's `false` / null
 * / empty list, and the session keeps working from memory. The canvas is not
 * worth losing over a failed write.
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

  return {
    /**
     * Every board the caller can see, newest first — theirs and any shared
     * with them. One query against the (owner_id, updated_at desc) index,
     * where the local repository has to parse every stored board to answer.
     */
    async list() {
      const { data, error } = await from()
        .select('id, title, updated_at')
        .order('updated_at', { ascending: false });

      return error ? [] : data.map(toSummary);
    },

    /**
     * maybeSingle, not single: a board that is not there — deleted, never
     * created, or simply not yours — is a null answer, not an error. The
     * caller seeds a fresh board on null, which is the right response to all
     * three.
     */
    async load(id) {
      const { data, error } = await from()
        .select('id, title, doc, updated_at')
        .eq('id', id)
        .maybeSingle();

      if (error || !data || !isBoard(data.doc)) return null;
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

      const updated = await from().update(patch).eq('id', id).select('id');
      if (updated.error) return false;
      if (updated.data.length) return true;

      const ownerId = auth.current()?.id;
      if (!ownerId) return false;

      const { error } = await from().insert({ id, owner_id: ownerId, ...patch });
      if (!error) return true;

      // Two tabs opening the same new board both find nothing to update and
      // both insert; one of them loses on the primary key. The row it wanted
      // now exists, so the update it should have done is available — and
      // this is also the path a viewer takes, where that update finds no row
      // it is allowed to touch and the answer is an honest false.
      if (error.code !== '23505') return false;
      const retried = await from().update(patch).eq('id', id).select('id');
      return !retried.error && retried.data.length > 0;
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
