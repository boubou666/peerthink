import { LOCAL, REMOTE, Store } from './core/store.js';
import { Selection } from './core/selection.js';
import { Viewport } from './core/viewport.js';
import { Board } from './core/board.js';
import { createAutosave } from './core/autosave.js';
import { createIdGenerator } from './core/ids.js';
import { UNLOADED, createSaveStatus } from './core/save-status.js';
import { createScheduler } from './core/scheduler.js';
import { seedBoard } from './core/seed.js';
import { exportFrame, fileName } from './core/export.js';

import { createViews } from './platform/views.js';
import { createRenderer } from './platform/renderer.js';
import { createInput } from './platform/input.js';
import { createCursors } from './platform/cursors.js';
import { createFlushOnHide } from './platform/lifecycle.js';
import { createPngExporter } from './platform/export-png.js';
import { DEFAULT_BOARD_ID, createLocalStorageRepository, createNullRepository } from './platform/storage.js';

/**
 * The composition root.
 *
 * Nothing below this file reaches for a global: the document, the window, the
 * clock, the elements and the storage backend all arrive as arguments. That is
 * what lets the whole app be constructed twice on one page, driven by a fake
 * clock in a test, or repointed at a different persistence backend without
 * touching a line of the core.
 *
 * `elements` is required — the React shell hands over refs, which is the whole
 * integration between the framework and the imperative canvas.
 */
export function createApp({
  document,
  window,
  elements,
  storage,
  repository,
  // Optional: given one, hydrate() joins the board's live channel once the
  // snapshot is in. Absent — no project configured, or a build that does not
  // want it — the board is simply a board with nobody else on it.
  createSync,
  scheduler,
  newId = createIdGenerator(),
  ResizeObserver = window.ResizeObserver,
  autosaveDelay = 400,
  boardId = DEFAULT_BOARD_ID,
  namespace,
  now,
  seed = seedBoard,
} = {}) {
  const dom = elements;

  const clock = scheduler ?? createScheduler({
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  });

  const boardRepository = repository ?? (storage
    ? createLocalStorageRepository({ storage, ...(namespace ? { namespace } : {}), ...(now ? { now } : {}) })
    : createNullRepository());

  const store = new Store();
  const selection = new Selection();
  const viewport = new Viewport();
  const board = new Board({ store, selection, newId });

  const stageSize = () => [dom.stage.clientWidth, dom.stage.clientHeight];

  /** Focus a freshly created object so the user can just start typing. */
  const focusNew = (id) => clock.nextFrame(() => {
    dom.layer.querySelector(`[data-id="${id}"] [contenteditable]`)?.focus();
  });

  const commands = {
    addAt(type, point) {
      const obj = board.addCenteredOn(type, point);
      focusNew(obj.id);
      return obj;
    },
    addAtCenter(type) {
      return commands.addAt(type, viewport.center(...stageSize()));
    },
    duplicate: () => board.duplicate(),

    /**
     * The board as a PNG — the selection when there is one, everything
     * otherwise, which is the same rule every other command here follows.
     *
     * Answers what happened rather than throwing, because three different
     * things can stop a download and the bar above has to say which: `empty`
     * for a board with nothing on it, `failed` for a canvas the browser would
     * not encode, `ok` for a file that was handed over. Reporting nothing is
     * the one option that is not available — a button that silently does
     * nothing is indistinguishable from a broken one.
     */
    async exportPng() {
      const chosen = selection.size
        ? selection.list().map((id) => store.get(id)).filter(Boolean)
        : store.all();

      const frame = exportFrame(chosen);
      if (!frame) return 'empty';

      const blob = await exporter.render(chosen, frame);
      if (!blob) return 'failed';

      exporter.save(blob, fileName(app.title));
      return 'ok';
    },

    fit: () => viewport.fit(board.bounds(), ...stageSize()),
    resetZoom: () => {
      const [w, h] = stageSize();
      viewport.setScaleAt(w / 2, h / 2, 1);
    },
  };

  const exporter = createPngExporter({ document, window });
  const views = createViews({ document });
  const renderer = createRenderer({ document, elements: dom, store, viewport, selection, views, scheduler: clock, ResizeObserver });
  const input = createInput({ document, window, elements: dom, store, selection, viewport, board, commands });

  let autosave = null;
  let sync = null;
  let cursors = null;
  let onHide = null;
  let destroyed = false;

  // Built before hydrate() rather than by the autosave it reports on: the
  // shell subscribes when the canvas mounts, which is before there is an
  // autosave, and the case that matters most — a board that never loaded —
  // is the case where there never will be one.
  const saveStatus = createSaveStatus();

  /**
   * Load the stored board — or seed a fresh one — and start autosaving.
   *
   * This is split out of construction because it is the only part that talks
   * to the repository, and a repository can be a network away. Everything
   * above has already been built and mounted by the time this is called, so
   * the canvas is on screen and interactive while the board is still in
   * flight, rather than the whole app waiting on a round trip.
   */
  async function hydrate() {
    /**
     * Anything the user does while the board is still in flight.
     *
     * The canvas is on screen and interactive from the first frame, which is
     * the point of loading separately — but `store.load()` replaces the
     * document, so a card made in that window used to vanish when the snapshot
     * landed on top of it. Against Web Storage the window was a microtask and
     * nobody ever saw it; against a network it is however long the round trip
     * takes, and it is exactly the moment an impatient person starts typing.
     *
     * So the ops are kept and replayed onto the snapshot. They are the same
     * ops a remote client would have sent, and they are replayed the same way
     * — which is why they can be: `add` is idempotent, `del` and `set` ignore
     * what is not there, and `order` merges.
     */
    const early = [];
    const stopBuffering = store.onOps((ops, origin) => {
      if (origin === LOCAL) early.push(...ops);
    });

    /**
     * Settled once there is a document for remote ops to land on.
     *
     * The channel is joined below rather than at the end of this function.
     * Joining afterwards left a window — the length of a round trip — in which
     * another editor's ops were broadcast to a client that was not listening
     * yet, and so were not missed briefly but missed entirely, until something
     * reloaded the page.
     *
     * The caught rejection is not decoration: when there is no project the
     * sync is never built, nobody is waiting on this, and a rejection with no
     * handler takes the process down in Node and logs an unhandled rejection
     * in the browser.
     */
    let landed;
    const hydrated = new Promise((resolve, reject) => { landed = { resolve, reject }; });
    hydrated.catch(() => {});

    // Before the load, holding what arrives. The ops the channel delivers in
    // that window are replayed onto the snapshot afterwards, exactly as the
    // local edits buffered above are, and for the same reason they can be.
    if (createSync) {
      sync = createSync({
        boardId,
        store,
        scheduler: clock,
        heldUntil: hydrated,
        // Both can arrive before `cursors` below has been assigned, on a fast
        // channel with someone already moving — hence the optional calls.
        onCursor: (cursor) => cursors?.receive(cursor),
        onMembers: (members) => cursors?.setMembers(members),
        // Taking over means the previous writer has gone, possibly mid-edit
        // and possibly before its own debounce fired. This client has those
        // ops — it just was not allowed to write them until now. `autosave` is
        // not built until the load has finished, so early on there is nothing
        // to flush and nothing that needs flushing.
        onWriter: (isWriter) => {
          if (isWriter) autosave?.flush().catch(() => {});
        },
      });
      cursors = createCursors({ document, elements: dom, viewport, sync, scheduler: clock });
      app.sync = sync;
      app.cursors = cursors;
    }

    let saved;
    try {
      // Adopt anything a single-board version of the app left behind, then load
      // before autosave is wired so a restore never writes itself back.
      await boardRepository.migrateLegacy({ toId: boardId });
      saved = await boardRepository.load(boardId);
    } catch (error) {
      // A board that did not load is not a board that can be saved: autosave
      // is never wired below, so every edit from here on lives in this tab and
      // nowhere else. The canvas stays up — throwing it away would take the
      // user's work with it — but it stops claiming to be stored.
      saveStatus.set(UNLOADED);
      // Nothing landed, so the held ops are dropped rather than replayed onto
      // a document that is not the board and cannot be saved.
      landed.reject(error);
      throw error;
    } finally {
      stopBuffering();
    }

    // destroy() can run while that is in flight — React unmounts a route far
    // faster than a round trip completes. Writing to the store now would
    // repopulate a torn-down app and start an autosave that nothing is left
    // to stop, so a cancelled hydrate has to stay silent.
    if (destroyed) {
      // The sync is already being torn down by destroy(); settling this is
      // what stops it sitting on a buffer waiting for a load that stopped
      // mattering.
      landed.reject(new Error('the app was destroyed while loading'));
      return app;
    }

    if (saved) {
      store.load(saved.board);
      /**
       * The user's own edits, back on top of the snapshot that replaced them.
       *
       * Replayed as REMOTE rather than LOCAL, now that the sync exists before
       * the load: LOCAL is what puts an op on the wire, and these were already
       * handed to the channel when they happened, so replaying them as local
       * would send every one of them a second time. Whether the channel had
       * come up by then is a separate question — the send is best effort — but
       * sending twice is not the answer to it.
       *
       * Not recorded either way: undo should not walk back past the board
       * loading.
       */
      if (early.length) store.apply(early, false, REMOTE);
    } else {
      // The seed adds to the board rather than replacing it, so a card made
      // mid-load survives this branch unaided — it is `store.load` above that
      // needed the replay.
      seed(board);
    }

    // There is a document now, so whatever the channel delivered while there
    // was not can be replayed onto it. Before autosave is wired, so the ops
    // held from other editors are treated exactly as ops arriving a moment
    // later would be.
    landed.resolve();

    app.title = saved?.title ?? null;
    app.restoredFromStorage = Boolean(saved);

    autosave = createAutosave({
      store,
      repository: boardRepository,
      boardId,
      scheduler: clock,
      delay: autosaveDelay,
      // Alone, or with no channel to be elected on, this client writes.
      canWrite: () => sync?.isWriter() ?? true,
      onStatus: saveStatus.set,
    });
    app.autosave = autosave;

    // A tab being closed does not run the debounce it is sitting inside.
    onHide = createFlushOnHide({ window, document, autosave });

    // Autosave subscribes *after* the load, so that a restore never writes
    // itself straight back — which also means the replay above happened with
    // nobody listening. Those ops are the user's own edits and nothing else
    // will save them, so the write they should have scheduled is made here.
    if (early.length) autosave.flush().catch(() => {});

    commands.fit();
    return app;
  }

  const app = {
    boardId,
    // Both are only meaningful once hydrate() has resolved; before that the
    // board genuinely is empty and untitled rather than unknown.
    title: null,
    restoredFromStorage: false,
    store,
    selection,
    viewport,
    board,
    commands,
    renderer,
    input,
    exporter,
    repository: boardRepository,
    autosave,
    sync,
    saveStatus,
    hydrate,
    destroy() {
      destroyed = true;
      onHide?.destroy();
      autosave?.stop();
      cursors?.destroy();
      // leaves the channel; the promise is nobody's to wait for
      sync?.destroy();
      input.destroy();
      renderer.destroy();
    },
  };

  return app;
}
