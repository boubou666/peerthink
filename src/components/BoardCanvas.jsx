import { useEffect, useRef } from 'react';

import { createApp } from '../app.js';
import { repository } from '../shell/storage.js';
import { createSync } from '../shell/sync.js';

/**
 * The canvas, mounted once.
 *
 * React renders this markup a single time and then keeps out of the way —
 * pan, zoom and drag run at frame rate and have no business going through a
 * reconciler. `createApp` takes the elements as an argument, so handing it
 * refs is the whole integration; `destroy()` is the cleanup.
 *
 * Construction is synchronous and loading the board is not, so the effect
 * mounts an empty canvas and lets `hydrate()` fill it in. There is nothing to
 * await here: `destroy()` cancels an in-flight hydrate on its own, which is
 * exactly what unmounting mid-load needs.
 */
export function BoardCanvas({ boardId, onReady, onSaveStatus }) {
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
      createSync,
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

    // Subscribed before hydrate, and told the current value straight away:
    // the states worth reporting include the ones reached on the way in, and
    // a board switch has to reset a header still showing the last board's.
    const stopWatchingStatus = app.saveStatus.subscribe((status) => onSaveStatus?.(status));
    onSaveStatus?.(app.saveStatus.get());

    // A board that cannot be loaded leaves the canvas empty and usable rather
    // than taking the route down with it — `saveStatus` is what says so, and
    // is why there is nothing to do with the rejection here.
    app.hydrate().catch(() => {});

    return () => {
      stopWatchingStatus();
      app.destroy();
      if (window.app === app) delete window.app;
    };
  }, [boardId, onReady, onSaveStatus]);

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
