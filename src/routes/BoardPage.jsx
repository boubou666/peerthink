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
 * What the canvas layer's problem codes mean, in words.
 *
 * The codes come up from `platform/clipboard.js`, which knows that a file could
 * not be turned into an image and has no business knowing how to say so — and
 * from the format bar, which knows that the words it measured are not there any
 * more. Every other sentence the user reads is written in the shell, and so are
 * these.
 */
const PROBLEMS = {
  'image-refused': 'Could not paste that image — it may not be a format this browser reads, or it may be too large to store on a board.',
  'link-lost': 'Could not add that link — the text it was for has changed since you selected it.',
};

/**
 * The board's stored name, and where it lives. A board with no record yet —
 * one seeded on a first visit — has neither, and the placeholder and a null
 * organization are the right answers for it.
 *
 * Rejects when the read itself failed, which is a different thing and is
 * handled at the call site rather than flattened into the placeholder here.
 */
const detailsOf = async (boardId) => {
  const record = await repository.load(boardId);
  return { title: record?.title ?? DEFAULT_TITLE, orgId: record?.orgId ?? null };
};

export function BoardPage() {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [draft, setDraft] = useState(DEFAULT_TITLE);
  const [showShare, setShowShare] = useState(false);
  /**
   * The organization holding this board, if any. Read here rather than in the
   * dialog because it comes free with the load the title already needs, and
   * the dialog is the one place it is used: a board in an organization is
   * reachable by everyone in it, and a list of "people with access" that
   * leaves them out is a list that is wrong.
   */
  const [orgId, setOrgId] = useState(null);
  // setState is a stable identity, which is what lets it be handed straight to
  // BoardCanvas — a new function every render would re-run the effect that
  // mounts the canvas, tearing down and rebuilding the board on every keystroke
  // in the title field.
  const [saveStatus, setSaveStatus] = useState(SAVED);
  const [exporting, setExporting] = useState(false);
  /**
   * The one thing the page has to say, as `{ kind, text }`, or null.
   *
   * One banner and not two: it is a fixed strip over the canvas rather than
   * something in a flow, so a second would be drawn on top of the first. The
   * newest thing that went wrong is also the one the person just did, which is
   * the one worth reading — `kind` is there so that what the banner is about is
   * legible to a test, rather than only to whoever reads the sentence.
   */
  const [notice, setNotice] = useState(null);
  const app = useRef(null);
  const cancelled = useRef(false);
  /**
   * The user has taken the field over for this board, by typing in it or by
   * committing a rename. Set on the first keystroke rather than at commit: a
   * read still in flight resolves into `setDraft`, and half-typed text is just
   * as much theirs to keep as a finished rename.
   */
  const claimed = useRef(false);
  /**
   * Which board the page is on, readable from inside a promise.
   *
   * `boardId` in a closure is the board that was on screen when the closure was
   * made, which is exactly what a result arriving late must not be compared
   * against. The effect below keeps this current, so anything that resolves
   * after a board change can tell that it did.
   */
  const showing = useRef(boardId);

  // The router reuses this component when only :boardId changes, so both the
  // committed title and the field have to follow the parameter. A controlled
  // input is what makes that possible — defaultValue is read once at mount and
  // ignored afterwards.
  useEffect(() => {
    let live = true;
    claimed.current = false;
    showing.current = boardId;

    // The router reuses this component when only :boardId changes, so anything
    // said about the last board has to go with it. A banner left up would be
    // reporting something that happened on a board no longer on screen, against
    // a button that would now do something different.
    setNotice(null);
    setExporting(false);

    detailsOf(boardId).then(
      (current) => {
        if (!live) return;
        // Not guarded by `claimed`: where the board lives is not something the
        // title field can be in the middle of editing, and a board whose
        // organization went unrecorded because someone was typing is one whose
        // Share dialog then under-reports who can see it.
        setOrgId(current.orgId);

        // Two ways this result is no longer wanted: the route moved on, or the
        // user is editing the name while the read was still in flight. Applying
        // it in either case puts a stale title back on screen — invisible
        // against Web Storage, routine once the repository is a network away.
        if (claimed.current) return;
        setTitle(current.title);
        setDraft(current.title);
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
        if (!live) return;
        setOrgId(null);
        if (claimed.current) return;
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

  /**
   * Something the canvas could not do, in words. `useCallback` because
   * BoardCanvas mounts the whole board in an effect keyed on its props — a new
   * function each render would tear the board down and rebuild it on every
   * keystroke in the title field.
   */
  const handleProblem = useCallback((code) => {
    setNotice({ kind: 'paste', text: PROBLEMS[code] ?? 'That did not work.' });
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
    setNotice(null);
    /**
     * Which board this export is of. A large board spends real time in
     * `toBlob`, which is long enough to press the back arrow and open another
     * one — and the report belongs to the board that was exported, so if that
     * is no longer the board on screen there is nobody to give it to. The same
     * rule the title read follows, and the same rule the effect above applies
     * to a banner already up.
     */
    const of = boardId;
    const said = (text) => {
      if (showing.current !== of) return;
      setNotice({ kind: 'export', text });
    };

    try {
      // The bar renders before the canvas hands its instance back, so this is
      // reachable — briefly — by a fast click on a slow load. It is its own
      // message: naming a size or an empty board would be inventing a cause
      // for something that has not been attempted yet.
      const board = app.current;
      if (!board) {
        said('The board is still opening — try again in a moment.');
        return;
      }

      const result = await board.commands.exportPng();
      if (result === 'empty') said('Nothing to export — this board is empty.');
      else if (result !== 'ok') said('Could not export this board. It may be too large.');
    } catch {
      said('Could not export this board.');
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

      {notice && (
        <p className="error board-notice" role="alert" data-board-notice={notice.kind}>
          <span>{notice.text}</span>
          {/*
            Dismissible, unlike the list's errors: this one floats over the
            canvas rather than sitting above a list, and a red banner parked
            on someone's board until they happen to try exporting again is
            not a report, it is furniture.
          */}
          <button type="button" data-action="dismiss-notice" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}

      {showShare && (
        <ShareDialog
          boardId={boardId}
          title={title}
          orgId={orgId}
          onClose={() => setShowShare(false)}
          // Leaving a board you are looking at means you can no longer look
          // at it; the list is the only place left to be.
          onLeave={() => navigate('/', { replace: true })}
        />
      )}

      <BoardCanvas
        boardId={boardId}
        onReady={handleReady}
        onSaveStatus={setSaveStatus}
        onProblem={handleProblem}
      />
    </div>
  );
}
