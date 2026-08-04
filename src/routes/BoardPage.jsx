import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';

import { BoardCanvas } from '../components/BoardCanvas.jsx';
import { repository } from '../shell/storage.js';

export function BoardPage() {
  const { boardId } = useParams();
  const [title, setTitle] = useState(() => repository.load(boardId)?.title ?? 'Untitled board');

  // identity is stable, so mounting the canvas does not depend on this render
  const handleReady = useCallback(() => {}, []);

  const rename = (next) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === title) return;
    setTitle(trimmed);
    repository.rename(boardId, trimmed);
  };

  return (
    <div className="board-page">
      <header className="board-bar">
        <Link className="board-bar-back" to="/" title="All boards">←</Link>
        <input
          className="board-bar-title"
          aria-label="Board title"
          defaultValue={title}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') {
              e.target.value = title;
              e.target.blur();
            }
          }}
        />
      </header>

      <BoardCanvas boardId={boardId} onReady={handleReady} />
    </div>
  );
}
