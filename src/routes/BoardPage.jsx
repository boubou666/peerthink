import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { BoardCanvas } from '../components/BoardCanvas.jsx';
import { SaveIndicator } from '../components/SaveIndicator.jsx';
import { ShareDialog } from '../components/ShareDialog.jsx';
import { SAVED } from '../core/save-status.js';
import { DEFAULT_TITLE } from '../platform/storage.js';
import { sharing } from '../shell/sharing.js';
import { repository } from '../shell/storage.js';

const EMPTY_BOARD = { v: 1, order: [], objects: [] };

/**
 * The board's stored name. A board with no record yet — one seeded on a first
 * visit — has no name to read, and the placeholder is the right answer for it.
 *
 * Rejects when the read itself failed, which is a different thing and is
 * handled at the call site rather than flattened into the placeholder here.
 */
const titleOf = async (boardId) => (await repository.load(boardId))?.title ?? DEFAULT_TITLE;

export function BoardPage() {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [draft, setDraft] = useState(DEFAULT_TITLE);
  const [showShare, setShowShare] = useState(false);
  // setState is a stable identity, which is what lets it be handed straight to
  // BoardCanvas — a new function every render would re-run the effect that
  // mounts the canvas, tearing down and rebuilding the board on every keystroke
  // in the title field.
  const [saveStatus, setSaveStatus] = useState(SAVED);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const app = useRef(null);
  const cancelled = useRef(false);
  /**
   * The user has taken the field over for this board, by typing in it or by
   * committing a rename. Set on the first keystroke rather than at commit: a
   * read still in flight resolves into `setDraft`, and half-typed text is just
   * as much theirs to keep as a finished rename.
   */
  const claimed = useRef(false);

  // The router reuses this component when only :boardId changes, so both the
  // committed title and the field have to follow the parameter. A controlled
  // input is what makes that possible — defaultValue is read once at mount and
  // ignored afterwards.
  useEffect(() => {
    let live = true;
    claimed.current = false;

    titleOf(boardId).then(
      (current) => {
        // Two ways this result is no longer wanted: the route moved on, or the
        // user is editing the name while the read was still in flight. Applying
        // it in either case puts a stale title back on screen — invisible
        // against Web Storage, routine once the repository is a network away.
        if (!live || claimed.current) return;
        setTitle(current);
        setDraft(current);
      },
      () => {
        // A read that failed knows nothing about the name — but this component
        // is reused when only :boardId changes, so leaving the field alone
        // would label this board with the previous one's title. The
        // placeholder claims nothing; SaveIndicator is what reports that the
        // board did not load.
        //
        // Guarded exactly like the success path, and for a sharper reason: a
        // failure arrives as fast as the request can fail, which is easily
        // mid-keystroke, and resetting the field then would take the name the
        // user was in the middle of typing.
        if (!live || claimed.current) return;
        setTitle(DEFAULT_TITLE);
        setDraft(DEFAULT_TITLE);
      },
    );

    return () => {
      live = false;
    };
  }, [boardId]);

  const handleReady = useCallback((instance) => {
    app.current = instance;
  }, []);

  // Autosave retries on its own, on a backoff that reaches half a minute. This
  // is for the person who has fixed whatever it was and does not want to wait
  // out the timer to find out.
  const retrySave = () => app.current?.autosave?.flush().catch(() => {});

  /**
   * Export the board to a PNG.
   *
   * `exporting` disables the button for the same reason the list has `busy`:
   * a large board spends real time in `toBlob`, and a second click would
   * encode the whole thing again for a file the first click is already
   * downloading.
   *
   * Every way this ends says so. A board with nothing on it and a canvas the
   * browser refused are both cases where the click produces no file, and a
   * button that goes quiet is the thing that looks broken.
   */
  const exportPng = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const result = await app.current?.commands.exportPng();
      if (result === 'empty') setExportError('Nothing to export — this board is empty.');
      else if (result !== 'ok') setExportError('Could not export this board. It may be too large.');
    } catch {
      setExportError('Could not export this board.');
    } finally {
      setExporting(false);
    }
  };

  const commit = async () => {
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
    claimed.current = true;

    if (await repository.rename(boardId, trimmed)) return;

    // A board seeded on a first visit has no stored record until autosave
    // fires, and rename() cannot touch what does not exist. Write one now —
    // otherwise the next autosave stores it under the default name and the
    // rename silently disappears. save() without a title keeps this one.
    await repository.save(boardId, app.current?.store.toJSON() ?? EMPTY_BOARD, { title: trimmed });
  };

  return (
    <div className="board-page">
      <header className="board-bar">
        <Link className="board-bar-back" to="/" title="All boards">←</Link>
        <input
          className="board-bar-title"
          aria-label="Board title"
          value={draft}
          onChange={(e) => {
            // The field is theirs from the first keystroke, so a read that is
            // still in flight cannot land on top of what they are typing.
            claimed.current = true;
            setDraft(e.target.value);
          }}
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

        <SaveIndicator status={saveStatus} onRetry={retrySave} />

        <button
          type="button"
          data-action="export"
          disabled={exporting}
          onClick={exportPng}
        >
          {exporting ? 'Exporting…' : 'Export'}
        </button>

        {sharing && (
          <button type="button" data-action="share" onClick={() => setShowShare(true)}>
            Share
          </button>
        )}
      </header>

      {exportError && (
        <p className="error" role="alert" data-export-error>
          {exportError}
        </p>
      )}

      {showShare && (
        <ShareDialog
          boardId={boardId}
          title={title}
          onClose={() => setShowShare(false)}
          // Leaving a board you are looking at means you can no longer look
          // at it; the list is the only place left to be.
          onLeave={() => navigate('/', { replace: true })}
        />
      )}

      <BoardCanvas boardId={boardId} onReady={handleReady} onSaveStatus={setSaveStatus} />
    </div>
  );
}
