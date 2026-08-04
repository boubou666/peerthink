import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

import { BoardCanvas } from '../components/BoardCanvas.jsx';
import { DEFAULT_TITLE } from '../platform/storage.js';
import { repository } from '../shell/storage.js';

const EMPTY_BOARD = { v: 1, order: [], objects: [] };
const titleOf = (boardId) => repository.load(boardId)?.title ?? DEFAULT_TITLE;

export function BoardPage() {
  const { boardId } = useParams();
  const [title, setTitle] = useState(() => titleOf(boardId));
  const [draft, setDraft] = useState(title);
  const app = useRef(null);
  const cancelled = useRef(false);

  // The router reuses this component when only :boardId changes, so both the
  // committed title and the field have to follow the parameter. A controlled
  // input is what makes that possible — defaultValue is read once at mount and
  // ignored afterwards.
  useEffect(() => {
    const current = titleOf(boardId);
    setTitle(current);
    setDraft(current);
  }, [boardId]);

  const handleReady = useCallback((instance) => {
    app.current = instance;
  }, []);

  const commit = () => {
    // Escape blurs the field, and blur() runs onBlur synchronously — before
    // React has re-rendered with the restored draft. Reading `draft` here would
    // still see the typed-and-cancelled value and persist exactly what the user
    // just rejected, so the keydown handler flags the intent instead.
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(title);
      return;
    }

    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) {
      setDraft(title);
      return;
    }
    setTitle(trimmed);

    if (repository.rename(boardId, trimmed)) return;

    // A board seeded on a first visit has no stored record until autosave
    // fires, and rename() cannot touch what does not exist. Write one now —
    // otherwise the next autosave stores it under the default name and the
    // rename silently disappears. save() without a title keeps this one.
    repository.save(boardId, app.current?.store.toJSON() ?? EMPTY_BOARD, { title: trimmed });
  };

  return (
    <div className="board-page">
      <header className="board-bar">
        <Link className="board-bar-back" to="/" title="All boards">←</Link>
        <input
          className="board-bar-title"
          aria-label="Board title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              cancelled.current = true;
              setDraft(title);
              e.currentTarget.blur();
            }
          }}
        />
      </header>

      <BoardCanvas boardId={boardId} onReady={handleReady} />
    </div>
  );
}
