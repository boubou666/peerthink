import { useEffect, useRef } from 'react';

import { createApp } from '../app.js';
import { repository } from '../shell/storage.js';

/**
 * The canvas, mounted once.
 *
 * React renders this markup a single time and then keeps out of the way —
 * pan, zoom and drag run at frame rate and have no business going through a
 * reconciler. `createApp` takes the elements as an argument, so handing it
 * refs is the whole integration; `destroy()` is the cleanup.
 */
export function BoardCanvas({ boardId, onReady }) {
  const stage = useRef(null);
  const bg = useRef(null);
  const layer = useRef(null);
  const overlay = useRef(null);
  const toolbar = useRef(null);
  const zoomLabel = useRef(null);

  useEffect(() => {
    const app = createApp({
      document,
      window,
      boardId,
      repository,
      elements: {
        stage: stage.current,
        bg: bg.current,
        layer: layer.current,
        overlay: overlay.current,
        toolbar: toolbar.current,
        zoomLabel: zoomLabel.current,
      },
    });

    window.app = app; // console and test surface
    onReady?.(app);

    return () => {
      app.destroy();
      if (window.app === app) delete window.app;
    };
  }, [boardId, onReady]);

  return (
    <>
      <div id="stage" ref={stage}>
        <div id="bg" ref={bg} />
        <div id="layer" ref={layer} />
        <div id="overlay" ref={overlay} />
      </div>

      <div id="toolbar" ref={toolbar}>
        <button type="button" data-add="card" title="New card (C)">Card</button>
        <button type="button" data-add="envelope" title="New envelope (E)">Envelope</button>
        <button type="button" data-add="list" title="New list (L)">List</button>
        <span className="sep" />
        <button type="button" data-act="undo" title="Undo (Ctrl+Z)">↶</button>
        <button type="button" data-act="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
        <span className="sep" />
        <button type="button" data-act="fit" title="Zoom to fit (Shift+1)">Fit</button>
        <button type="button" data-act="reset" title="Reset zoom (Shift+0)">
          <span id="zoom" ref={zoomLabel}>100%</span>
        </button>
      </div>

      <div id="hint">
        drag empty space to select · space or middle-drag to pan · ⌘/ctrl+wheel to zoom · double-click to edit
      </div>
    </>
  );
}
