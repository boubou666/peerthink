import { useState } from 'react';
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
  const [boards, setBoards] = useState(() => repository.list());
  const [error, setError] = useState(null);
  const refresh = () => setBoards(repository.list());

  /**
   * A board created here starts empty. Only a first-ever visit gets the
   * starter board, which is a tour rather than content you asked for.
   *
   * Navigating before confirming the write would open a route with no stored
   * record, which createApp treats as a first visit and seeds — so a failed
   * save would hand back a board full of starter content.
   */
  const create = () => {
    const id = newId();
    if (!repository.save(id, EMPTY_BOARD, { title: DEFAULT_TITLE })) {
      setError('Could not create a board — storage is full or unavailable.');
      return;
    }
    setError(null);
    navigate(`/b/${id}`);
  };

  const remove = (id, title) => {
    if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
    repository.remove(id);
    refresh();
  };

  const rename = (id, current) => {
    const next = window.prompt('Board name', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    repository.rename(id, trimmed);
    refresh();
  };

  return (
    <div className="shell">
      <header className="shell-header">
        <h1>Boards</h1>
        <button type="button" className="primary" data-action="new-board" onClick={create}>
          New board
        </button>
      </header>

      {error && <p className="error" role="alert" data-error>{error}</p>}

      {boards.length === 0 ? (
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
                <button type="button" data-action="rename" onClick={() => rename(board.id, board.title)}>
                  Rename
                </button>
                <button type="button" data-action="delete" onClick={() => remove(board.id, board.title)}>
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
