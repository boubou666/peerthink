import { useEffect, useRef, useState } from 'react';

import { createMinimap } from '../platform/minimap.js';
import { minimapState } from '../shell/minimap.js';
import { cardPalette } from '../shell/palette.js';

/**
 * The sheet in the corner, and a way to go somewhere on it.
 *
 * The split here is the one BoardCanvas draws one level up, for the same
 * reason. Whether the map is showing is *state*, it changes when somebody
 * presses a button, and React is what renders it. What is inside the box
 * changes on every frame of a pan, a zoom and a drag, so it is a `<canvas>`
 * handed to `platform/minimap.js` and never reconciled — handing over the ref
 * is the whole integration, and `destroy()` is the cleanup.
 *
 * Which is also why the effect is keyed on `open`: minimizing unmounts the
 * canvas, so the subscriptions to the store and the viewport go with it and a
 * map nobody is looking at costs nothing to keep.
 */
export function Minimap({ app, stage }) {
  /**
   * The remembered choice, read once. In a ref rather than read on each render
   * because reading is Web Storage and this renders whenever the board around
   * it does.
   */
  const remembered = useRef(null);
  remembered.current ??= minimapState();

  const [open, setOpen] = useState(() => remembered.current.open());
  const canvas = useRef(null);

  useEffect(() => {
    if (!open || !canvas.current || !stage) return undefined;

    const map = createMinimap({
      document,
      window,
      canvas: canvas.current,
      stage,
      store: app.store,
      board: app.board,
      viewport: app.viewport,
      palette: cardPalette(),
    });
    return () => map.destroy();
  }, [app, stage, open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    remembered.current.set(next);
  };

  return (
    <div
      className="minimap"
      data-minimap={open ? 'open' : 'closed'}
      // Chrome over the canvas: a press that reached the stage would start a
      // marquee behind the panel and clear whatever is selected.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {open && <canvas ref={canvas} className="minimap-canvas" data-minimap-canvas />}

      <button
        type="button"
        className="minimap-toggle"
        data-action="minimap-toggle"
        aria-expanded={open}
        aria-label={open ? 'Minimize the map' : 'Show the map'}
        title={open ? 'Minimize the map' : 'Show the map'}
        onClick={toggle}
      >
        {/* A bar, the shape every window's minimize is, while there is
            something to minimize — and the word once there is not, because a
            button showing a bar and doing the opposite says nothing. */}
        {open ? <span className="minimap-bar" /> : 'Map'}
      </button>
    </div>
  );
}
