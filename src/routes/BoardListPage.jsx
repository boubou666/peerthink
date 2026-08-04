import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { createIdGenerator } from '../core/ids.js';
import { DEFAULT_TITLE } from '../platform/storage.js';
import { repository } from '../shell/storage.js';

const newId = createIdGenerator();
const EMPTY_BOARD = { v: 1, order: [], objects: [] };

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

  const refresh = useCallback(() => repository.list().then(setBoards), []);

  useEffect(() => {
    let live = true;
    repository.list().then((found) => {
      if (live) setBoards(found);
    });
    return () => {
      live = false;
    };
  }, []);

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
        setError('Could not create a board — storage is full or unavailable.');
        return;
      }
      setError(null);
      navigate(`/b/${id}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = (id, title) => {
    if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
    return mutate(() => repository.remove(id));
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
        <button
          type="button"
          className="primary"
          data-action="new-board"
          disabled={busy}
          onClick={create}
        >
          New board
        </button>
      </header>

      {error && <p className="error" role="alert" data-error>{error}</p>}

      {boards === null ? (
        <p className="empty" data-loading>Loading…</p>
      ) : boards.length === 0 ? (
        <p className="empty" data-empty>No boards yet. Create one to get started.</p>
      ) : (
        <ul className="board-grid">
          {boards.map((board) => (
            <li key={board.id} className="board-card" data-board-id={board.id}>
              <button
                type="button"
                className="board-card-open"
                onClick={() => navigate(`/b/${board.id}`)}
              >
                <span className="board-card-title">{board.title}</span>
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
                <button
                  type="button"
                  data-action="delete"
                  disabled={busy}
                  onClick={() => remove(board.id, board.title)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
