import { useEffect, useRef, useState } from 'react';

import { createApp } from '../app.js';
import { isTyping } from '../platform/typing.js';
import { linkPreview } from '../shell/link-preview.js';
import { repository } from '../shell/storage.js';
import { createSync } from '../shell/sync.js';
import { FormatBar } from './FormatBar.jsx';
import { SheetTabs } from './SheetTabs.jsx';
import { Toolbar } from './Toolbar.jsx';

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
export function BoardCanvas({ boardId, onReady, onSaveStatus, onProblem }) {
  const stage = useRef(null);
  const bg = useRef(null);
  const layer = useRef(null);
  const overlay = useRef(null);

  /**
   * The app, once there is one, so the toolbar can render from it.
   *
   * The stage below is still handed to `createApp` as bare elements and left
   * alone — that is the part that draws at frame rate. The toolbar is the part
   * that shows state, and state is what React is for. Holding the app in state
   * costs one extra render on mount and nothing after.
   */
  const [app, setApp] = useState(null);

  useEffect(() => {
    const app = createApp({
      document,
      window,
      boardId,
      repository,
      createSync,
      fetchPreview: linkPreview,
      onProblem,
      elements: {
        stage: stage.current,
        bg: bg.current,
        layer: layer.current,
        overlay: overlay.current,
      },
    });

    window.app = app; // console and test surface
    setApp(app);
    onReady?.(app);

    /**
     * Zoom to fit and reset zoom, from the keyboard.
     *
     * Registered here rather than in the toolbar that shows them, because they
     * belong to the board: they are on the window, they work with nothing
     * focused, and they must be live the moment `window.app` is. A listener
     * added by the toolbar attaches a commit later — long enough to miss a key
     * pressed on load, which the suite noticed as soon as they were moved
     * there.
     *
     * `!` and `)` are those keys on a US layout; the `code` check covers the
     * layouts where they are not. Whatever is being typed into keeps its own
     * keys — `!` is a character before it is a shortcut, and a board title is
     * allowed to end in one.
     */
    const onKeyDown = (event) => {
      if (isTyping(event.target)) return;
      if (event.key === '!' || (event.shiftKey && event.code === 'Digit1')) app.commands.fit();
      else if (event.key === ')' || (event.shiftKey && event.code === 'Digit0')) app.commands.resetZoom();
    };
    window.addEventListener('keydown', onKeyDown);

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
      window.removeEventListener('keydown', onKeyDown);
      stopWatchingStatus();
      app.destroy();
      // Cleared before the toolbar's next render, so it never reads a store
      // and a viewport belonging to an app that has been torn down.
      setApp(null);
      if (window.app === app) delete window.app;
    };
  }, [boardId, onReady, onSaveStatus, onProblem]);

  return (
    <>
      <div id="stage" ref={stage}>
        <div id="bg" ref={bg} />
        <div id="layer" ref={layer} />
        <div id="overlay" ref={overlay} />
      </div>

      {app && <Toolbar app={app} />}
      {app && <FormatBar app={app} stage={stage.current} />}
      {app && <SheetTabs app={app} />}

      <div id="hint">
        drag empty space to select · space or middle-drag to pan · ⌘/ctrl+wheel to zoom · double-click to edit
      </div>
    </>
  );
}
