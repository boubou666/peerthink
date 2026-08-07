import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { AccountMenu } from '../components/AccountMenu.jsx';
import { createIdGenerator } from '../core/ids.js';
import { DEFAULT_TITLE } from '../platform/storage.js';
import { auth } from '../shell/auth.js';
import { seenBoardsFor } from '../shell/seen.js';
import { sharing } from '../shell/sharing.js';
import { repository } from '../shell/storage.js';

const newId = createIdGenerator();
const EMPTY_BOARD = { v: 1, order: [], objects: [] };

/**
 * A repository is allowed to reject — the contract says it answers rather than
 * throws, but the contract is a promise made by two implementations and not
 * something this page can enforce. Every call it makes now says so when it
 * fails, because the alternative is what this page used to do: sit on
 * "Loading…" for good, and throw an unhandled rejection on the way.
 */
const COULD_NOT_LIST = 'Could not load your boards. Check your connection and try again.';
const COULD_NOT_CREATE = 'Could not create a board — storage is full or unavailable.';
const COULD_NOT_CHANGE = 'That change did not go through. Nothing was altered.';

const formatDate = (ms) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function BoardListPage() {
  const navigate = useNavigate();
  // null is "not read yet", which is a different thing from "no boards" — the
  // empty state is a claim about the workspace and it should not be made until
  // the repository has actually answered.
  const [boards, setBoards] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // A read that failed is not an empty workspace. `boards` keeps whatever it
  // last had — nothing, on a first load — so the page never claims there are
  // no boards on the strength of a request that did not arrive.
  /**
   * Boards this browser has not shown for this account.
   *
   * Reconciled against every list that arrives, so a board that turns up while
   * the page is open is marked as readily as one that was there on load. The
   * record is per account and built per read rather than held, because the
   * account can change under a page that stays mounted.
   */
  const [unseen, setUnseen] = useState(() => new Set());

  const reconcile = useCallback((found) => {
    const id = auth.current()?.id;
    // No account is no record to keep. Nothing below here renders without one
    // — RequireAccount sees to that — but a read in flight across a sign-out
    // can still land here, and inventing a key for nobody would file this
    // browser's history under a user that does not exist.
    if (!id) return;
    setUnseen(seenBoardsFor(id).reconcile(found.map((board) => board.id)));
  }, []);

  const refresh = useCallback(
    () => repository.list().then(
      (found) => {
        setBoards(found);
        reconcile(found);
        setError(null);
      },
      () => setError(COULD_NOT_LIST),
    ),
    [reconcile],
  );

  useEffect(() => {
    let live = true;
    repository.list().then(
      (found) => {
        if (!live) return;
        setBoards(found);
        reconcile(found);
      },
      () => {
        if (live) setError(COULD_NOT_LIST);
      },
    );
    return () => {
      live = false;
    };
  }, [reconcile]);

  /**
   * Opening a board is what clears its badge — not listing it. A mark made on
   * the way past would be gone before it had been read.
   */
  const open = useCallback((id) => {
    const account = auth.current()?.id;
    if (account) seenBoardsFor(account).markSeen(id);
    navigate(`/b/${id}`);
  }, [navigate]);

  /**
   * Run a mutation, then re-read. `busy` is what stops a second click landing
   * on a list that the first click has already invalidated but not yet
   * refreshed — a window that does not exist against Web Storage and is wide
   * open against a server.
   */
  const mutate = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch {
      // Only the mutation can land here — `refresh` reports its own failure —
      // so this is the one message that can promise nothing changed.
      setError(COULD_NOT_CHANGE);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A retry is a read in flight like any other. Without `busy` the button that
   * started it stays enabled over a list that is still `null`, so a second
   * click starts a second read and the answers land in whichever order they
   * come back — and the browser tests, which wait on `data-busy`, would think
   * the page had settled while it had not.
   */
  const retryList = async () => {
    setBusy(true);
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /**
   * A board created here starts empty. Only a first-ever visit gets the
   * starter board, which is a tour rather than content you asked for.
   *
   * Navigating before confirming the write would open a route with no stored
   * record, which createApp treats as a first visit and seeds — so a failed
   * save would hand back a board full of starter content.
   */
  const create = async () => {
    setBusy(true);
    try {
      const id = newId();
      if (!(await repository.save(id, EMPTY_BOARD, { title: DEFAULT_TITLE }))) {
        setError(COULD_NOT_CREATE);
        return;
      }
      setError(null);
      // Through `open`, so a board you just made is not waiting with a "New"
      // badge when you come back to the list. You have seen it — you are about
      // to be looking at it.
      open(id);
    } catch {
      // Refusing and rejecting are the same event to the person clicking the
      // button, and neither one navigated anywhere.
      setError(COULD_NOT_CREATE);
    } finally {
      setBusy(false);
    }
  };

  const remove = (id, title) => {
    if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
    return mutate(() => repository.remove(id));
  };

  /**
   * A board someone shared with you is not yours to delete — the policies
   * would refuse, and refusing quietly would look like a board that came back.
   * So the card offers what is actually available: hand the access back, and
   * it leaves your list without leaving anyone else's.
   */
  const leave = (id, title) => {
    if (!window.confirm(`Leave “${title}”? You will need a new link to get back in.`)) return;
    return mutate(() => sharing.leave(id));
  };

  const rename = (id, current) => {
    const next = window.prompt('Board name', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    return mutate(() => repository.rename(id, trimmed));
  };

  return (
    // data-busy marks a read or write in flight. It drives nothing visually on
    // its own — the disabled buttons do that — but it is the one honest signal
    // that the list on screen is settled, which is what the browser tests wait
    // on instead of assuming a click has already landed.
    <div className="shell" {...(busy ? { 'data-busy': '' } : {})}>
      <header className="shell-header">
        <h1>Boards</h1>
        <div className="shell-header-actions">
          <AccountMenu />
          <button
            type="button"
            className="primary"
            data-action="new-board"
            disabled={busy}
            onClick={create}
          >
            New board
          </button>
        </div>
      </header>

      {error && (
        <p className="error" role="alert" data-error>
          {error}
          {error === COULD_NOT_LIST && (
            <button type="button" data-action="retry-list" disabled={busy} onClick={retryList}>
              Try again
            </button>
          )}
        </p>
      )}

      {boards === null ? (
        // A first read that failed has no list to show, and "no boards yet" is
        // a claim about someone's account that a request which never arrived
        // cannot support. The message above is the whole of what is known.
        error ? null : <p className="empty" data-loading>Loading…</p>
      ) : boards.length === 0 ? (
        <p className="empty" data-empty>No boards yet. Create one to get started.</p>
      ) : (
        <ul className="board-grid">
          {boards.map((board) => (
            <li key={board.id} className="board-card" data-board-id={board.id}>
              <button
                type="button"
                className="board-card-open"
                onClick={() => open(board.id)}
              >
                <span className="board-card-title">
                  {board.title}
                  {/* "New here", not "newly shared" — this side knows what it
                      has shown, and cannot tell why a board turned up. */}
                  {unseen.has(board.id) && (
                    <span className="board-card-new" data-new> New</span>
                  )}
                </span>
                <span className="board-card-meta">Edited {formatDate(board.updatedAt)}</span>
              </button>

              <div className="board-card-actions">
                <button
                  type="button"
                  data-action="rename"
                  disabled={busy}
                  onClick={() => rename(board.id, board.title)}
                >
                  Rename
                </button>

                {board.owned === false ? (
                  <button
                    type="button"
                    data-action="leave"
                    disabled={busy}
                    onClick={() => leave(board.id, board.title)}
                  >
                    Leave
                  </button>
                ) : (
                  <button
                    type="button"
                    data-action="delete"
                    disabled={busy}
                    onClick={() => remove(board.id, board.title)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
