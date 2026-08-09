import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { search, step } from '../core/search.js';

/**
 * Find words on the board.
 *
 * The browser's own find cannot do this: objects off screen are culled out of
 * the document, so `⌘F` searches the handful of cards that happen to be in
 * view. This searches the *board* — every sheet, not only the one on screen —
 * and takes you to what it finds.
 *
 * React chrome, because it is state and changes when that state does: a query,
 * a position in a list, and whether it is open at all. What it acts on is the
 * canvas, through two commands and a set of ids the renderer draws — nothing
 * here reaches into the board's DOM.
 *
 * The shortcut is listened for here rather than in the input layer, the way
 * BoardCanvas listens for the two view keys, and for the same reason: it
 * belongs to the thing that answers it. It is heard *before* the "keys typed
 * into a field are that field's" rule, which is deliberate — `⌘F` while a card
 * is being edited is still a search of the board, and the browser's find would
 * be looking at a document with most of the board missing from it.
 */
export function FindBar({ app }) {
  const { commands, found, store, sheets } = app;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Where in the list the person is, and −1 for "a query, but nowhere yet". */
  const [at, setAt] = useState(-1);
  const field = useRef(null);

  /**
   * The board changes under a search: an edit, an undo, somebody else's op.
   * The *count* is what the list below depends on — the dispatch is stable, so
   * a memo listing it would never be invalidated by anything.
   */
  const [revision, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    const stops = [store.on(bump), sheets.on(bump)];
    return () => stops.forEach((stop) => stop());
  }, [store, sheets, bump]);

  useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      setOpen(true);
      // Focusing an input that is already focused does nothing, so the select
      // is what makes a second ⌘F mean "search for something else".
      field.current?.focus();
      field.current?.select();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const matches = useMemo(
    () => (open ? search(commands.contents(), query) : []),
    // `revision` is not read, and is a dependency on purpose: the answer is
    // about a board that changes underneath it.
    [open, query, commands, revision],
  );

  /**
   * Everything holding the words, drawn with a ring, for as long as the bar is
   * open. Kept in an effect rather than written during render, because it is a
   * change to something outside React and two renders must not mean two
   * different boards.
   */
  useEffect(() => {
    found.set(matches.filter((match) => match.sheetId === sheets.activeId).map((match) => match.id));
    return () => found.clear();
  }, [found, matches, sheets]);

  const go = (by) => {
    if (!matches.length) return;
    const next = step(at, matches.length, by);
    setAt(next);
    commands.reveal(matches[next]);
  };

  const close = () => {
    setOpen(false);
    setQuery('');
    setAt(-1);
  };

  if (!open) return null;

  const elsewhere = matches.filter((match) => match.sheetId !== sheets.activeId).length;
  const alsoThere = elsewhere ? ` · ${elsewhere} on other sheets` : '';

  /**
   * How many there are until one has been stepped to, and which one after
   * that. "1 of 3" before anybody has gone anywhere would name a match the
   * camera is not looking at.
   */
  const said = () => {
    if (!query.trim()) return '';
    if (!matches.length) return 'Nothing';
    if (at < 0) return `${matches.length} found${alsoThere}`;
    return `${Math.min(at, matches.length - 1) + 1} of ${matches.length}${alsoThere}`;
  };

  return (
    <div
      className="find-bar"
      data-find-bar
      // Chrome over the canvas: a press that reached the stage would start a
      // marquee behind it and clear whatever is selected.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        ref={field}
        className="find-field"
        data-find-field
        autoFocus
        value={query}
        placeholder="Find on this board"
        aria-label="Find on this board"
        onChange={(event) => {
          setQuery(event.target.value);
          // A new query is a new list, and the second match of the last one is
          // nowhere in particular in this one.
          setAt(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
          else if (event.key === 'Enter') go(event.shiftKey ? -1 : 1);
          else return;
          event.preventDefault();
          // The board's own shortcuts listen on the window, and Escape there
          // clears the selection — including the match just stepped to.
          event.stopPropagation();
        }}
      />

      {/*
        The count says what there is, and where. "Elsewhere" is the whole
        reason this searches the board rather than the sheet: a match on
        another canvas is one you would otherwise never learn about.
      */}
      <span className="find-count" data-find-count>{said()}</span>

      <button
        type="button"
        className="find-step"
        data-action="find-previous"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!matches.length}
        onClick={() => go(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="find-step"
        data-action="find-next"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!matches.length}
        onClick={() => go(1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="find-step"
        data-action="find-close"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={close}
      >
        ✕
      </button>
    </div>
  );
}
