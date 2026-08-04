import { LOCAL, Store } from './core/store.js';
import { Selection } from './core/selection.js';
import { Viewport } from './core/viewport.js';
import { Board } from './core/board.js';
import { createAutosave } from './core/autosave.js';
import { createIdGenerator } from './core/ids.js';
import { createScheduler } from './core/scheduler.js';
import { seedBoard } from './core/seed.js';

import { createViews } from './platform/views.js';
import { createRenderer } from './platform/renderer.js';
import { createInput } from './platform/input.js';
import { createToolbar } from './platform/toolbar.js';
import { createCursors } from './platform/cursors.js';
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
    fit: () => viewport.fit(board.bounds(), ...stageSize()),
    resetZoom: () => {
      const [w, h] = stageSize();
      viewport.setScaleAt(w / 2, h / 2, 1);
    },
  };

  const views = createViews({ document });
  const renderer = createRenderer({ document, elements: dom, store, viewport, selection, views, scheduler: clock, ResizeObserver });
  const input = createInput({ document, window, elements: dom, store, selection, viewport, board, commands });
  const toolbar = createToolbar({ window, elements: dom, store, viewport, commands });

  let autosave = null;
  let sync = null;
  let cursors = null;
  let destroyed = false;

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

    let saved;
    try {
      // Adopt anything a single-board version of the app left behind, then load
      // before autosave is wired so a restore never writes itself back.
      await boardRepository.migrateLegacy({ toId: boardId });
      saved = await boardRepository.load(boardId);
    } finally {
      stopBuffering();
    }

    // destroy() can run while that is in flight — React unmounts a route far
    // faster than a round trip completes. Writing to the store now would
    // repopulate a torn-down app and start an autosave that nothing is left
    // to stop, so a cancelled hydrate has to stay silent.
    if (destroyed) return app;

    if (saved) {
      store.load(saved.board);
      // not recorded: undo should not walk back past the board loading
      if (early.length) store.apply(early, false);
    } else {
      // The seed adds to the board rather than replacing it, so a card made
      // mid-load survives this branch unaided — it is `store.load` above that
      // needed the replay.
      seed(board);
    }

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
    });
    app.autosave = autosave;

    // Autosave subscribes *after* the load, so that a restore never writes
    // itself straight back — which also means the replay above happened with
    // nobody listening. Those ops are the user's own edits and nothing else
    // will save them, so the write they should have scheduled is made here.
    if (early.length) autosave.flush().catch(() => {});

    // After the load, not before: ops that arrive while the snapshot is still
    // in flight would be overwritten by it. The gap between the two is a
    // window where another editor's change is missed until the next reload —
    // narrow, and the price of loading a snapshot rather than replaying a log.
    if (createSync) {
      sync = createSync({
        boardId,
        store,
        scheduler: clock,
        // Both arrive before `cursors` below has been assigned, on a fast
        // channel with someone already moving — hence the optional calls.
        onCursor: (cursor) => cursors?.receive(cursor),
        onMembers: (members) => cursors?.setMembers(members),
        // Taking over means the previous writer has gone, possibly mid-edit
        // and possibly before its own debounce fired. This client has those
        // ops — it just was not allowed to write them until now.
        onWriter: (isWriter) => {
          if (isWriter) autosave?.flush().catch(() => {});
        },
      });
      cursors = createCursors({ document, elements: dom, viewport, sync, scheduler: clock });
      app.sync = sync;
      app.cursors = cursors;
    }

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
    toolbar,
    repository: boardRepository,
    autosave,
    sync,
    hydrate,
    destroy() {
      destroyed = true;
      autosave?.stop();
      cursors?.destroy();
      // leaves the channel; the promise is nobody's to wait for
      sync?.destroy();
      toolbar.destroy();
      input.destroy();
      renderer.destroy();
    },
  };

  return app;
}
