import { useCallback, useSyncExternalStore } from 'react';

/**
 * The floating toolbar.
 *
 * The two view shortcuts that used to live with it are in BoardCanvas now.
 * They are window-level and must work the moment the app does, and a listener
 * registered here would attach one commit later — long enough for a key
 * pressed on load to be missed, which is what `shift+1 fits and shift+0
 * resets` caught when they were moved into this file.
 *
 * This is the one part of the canvas that is worth rendering: it shows state
 * rather than drawing at frame rate. The stage below it is left alone for the
 * opposite reason — pan, zoom and drag have no business going through a
 * reconciler, which is what BoardCanvas's comment is about and still true.
 *
 * It reads the store and the viewport through `useSyncExternalStore` rather
 * than mirroring them into state. Both already publish to subscribers, and a
 * copy kept alongside is a second answer to the same question — the one that
 * is stale after an undo made by somebody else's op arriving.
 */

/** A subscribable with `.on(fn)` becomes a snapshot React can read. */
const useLive = (source, read) =>
  useSyncExternalStore(
    useCallback((notify) => source.on(notify), [source]),
    useCallback(() => read(source), [source, read]),
  );

const readZoom = (viewport) => Math.round(viewport.scale * 100);
const readHistory = (store) => (store.canUndo ? 'u' : '') + (store.canRedo ? 'r' : '');

export function Toolbar({ app }) {
  const { store, viewport, commands } = app;

  const zoom = useLive(viewport, readZoom);
  /**
   * Both flags as one string, because getSnapshot must return something that
   * is `Object.is`-equal between renders when nothing has changed — an object
   * built here would be a new one every time and loop for ever. Two hooks
   * would work too; one subscription is cheaper and they always change
   * together.
   */
  const history = useLive(store, readHistory);

  return (
    <div id="toolbar">
      <button type="button" data-add="card" title="New card (C)" onClick={() => commands.addAtCenter('card')}>Card</button>
      <button type="button" data-add="envelope" title="New envelope (E)" onClick={() => commands.addAtCenter('envelope')}>Envelope</button>
      <button type="button" data-add="list" title="New list (L)" onClick={() => commands.addAtCenter('list')}>List</button>
      <span className="sep" />
      {/*
        Disabled when there is nothing to undo, which the imperative version
        could not say: it had no reason to watch the store, so both buttons
        were always live and a click on an empty history did nothing without
        looking like it.
      */}
      <button
        type="button"
        data-act="undo"
        title="Undo (Ctrl+Z)"
        disabled={!history.includes('u')}
        onClick={() => store.undo()}
      >
        ↶
      </button>
      <button
        type="button"
        data-act="redo"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!history.includes('r')}
        onClick={() => store.redo()}
      >
        ↷
      </button>
      <span className="sep" />
      <button type="button" data-act="fit" title="Zoom to fit (Shift+1)" onClick={() => commands.fit()}>Fit</button>
      <button type="button" data-act="reset" title="Reset zoom (Shift+0)" onClick={() => commands.resetZoom()}>
        <span id="zoom">{zoom}%</span>
      </button>
    </div>
  );
}
