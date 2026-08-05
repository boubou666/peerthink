/**
 * Move the boards in this browser into the account.
 *
 * Before there was a backend, every board lived in Web Storage. The moment a
 * project is configured the board list reads Postgres instead — and those
 * boards stop being listed. They are still on disk, and there is no longer any
 * way to reach them, which is indistinguishable from having lost them.
 *
 * So they are adopted: once, on the first sign-in that finds them, silently.
 * Nobody is asked a question they have no context for, and nothing vanishes
 * while they think about it.
 *
 * Two rules make this safe to run more than once, which matters because a
 * half-finished adoption has to be able to finish later:
 *
 *   - a board that already exists in the account is left alone. The browser's
 *     copy is never written over the server's; the server's is the one other
 *     people may have edited.
 *   - the originals stay in Web Storage. Copying is reversible and deleting is
 *     not, and the cost of leaving them is some bytes in a browser that has
 *     already stopped reading them.
 */

export const ADOPTED_KEY = 'peerthink:adopted';

const isDone = (storage, key) => {
  try {
    return storage.getItem(key) !== null;
  } catch {
    // Not "already adopted" — just unknown. Storage that cannot be read cannot
    // be adopted from either, and `list()` below rejects rather than answering
    // nothing, so the run ends as unfinished and the gate offers it again.
    return false;
  }
};

const markDone = (storage, key, now) => {
  try {
    storage.setItem(key, now());
  } catch {
    // The adoption still happened; only the note that it did is lost, and the
    // next run skips every board it already moved rather than duplicating it.
  }
};

/**
 * Returns what it did: `{ adopted, kept, failed, done }`. `kept` counts boards
 * the account already had, `failed` counts the ones that could not be settled
 * — a write that did not land, or a read that did not answer — and any failure
 * leaves the marker unset, so the next sign-in tries again.
 *
 * Rejects only when the browser's board *list* cannot be read, because then
 * there is nothing to iterate and no count to report. The caller reads that the
 * same way it reads an unfinished run: the marker stays unset, and the boards
 * stay where they are.
 */
export async function adoptBoards({
  local,
  remote,
  storage,
  key = ADOPTED_KEY,
  // What the marker records. Injected like every other dependency down here —
  // the value is only ever read by a person looking at storage, but a module
  // in platform/ that reaches for a global is one a test cannot pin down.
  now = () => new Date().toISOString(),
}) {
  const result = { adopted: 0, kept: 0, failed: 0, done: false };
  if (isDone(storage, key)) return { ...result, done: true };

  for (const summary of await local.list()) {
    try {
      // Asking the account first is what stops a stale browser copy landing on
      // top of a board that has moved on without it. A read that failed is not
      // an answer to that question — taking it for "the account does not have
      // this" is how the copy lands anyway — so it throws, and the board is
      // counted unfinished instead of overwritten.
      if (await remote.load(summary.id)) {
        result.kept += 1;
        continue;
      }

      // Null, not a failure: the browser listed this board and no longer has
      // it, or what it has will not parse. Neither is adoptable and neither
      // gets better on a retry, so it is skipped rather than counted.
      const record = await local.load(summary.id);
      if (!record) continue;

      const saved = await remote.save(summary.id, record.board, { title: record.title });
      if (saved) result.adopted += 1;
      else result.failed += 1;
    } catch {
      // One board that could not be settled does not stop the others: the rest
      // still move, and the marker stays unset so this one is tried again.
      result.failed += 1;
    }
  }

  if (!result.failed) {
    markDone(storage, key, now);
    result.done = true;
  }
  return result;
}
