import { Store } from './core/store.js';
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
    // Adopt anything a single-board version of the app left behind, then load
    // before autosave is wired so a restore never writes itself back.
    await boardRepository.migrateLegacy({ toId: boardId });
    const saved = await boardRepository.load(boardId);

    // destroy() can run while that is in flight — React unmounts a route far
    // faster than a round trip completes. Writing to the store now would
    // repopulate a torn-down app and start an autosave that nothing is left
    // to stop, so a cancelled hydrate has to stay silent.
    if (destroyed) return app;

    if (saved) store.load(saved.board);
    else seed(board);

    app.title = saved?.title ?? null;
    app.restoredFromStorage = Boolean(saved);

    autosave = createAutosave({
      store,
      repository: boardRepository,
      boardId,
      scheduler: clock,
      delay: autosaveDelay,
    });
    app.autosave = autosave;
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
    hydrate,
    destroy() {
      destroyed = true;
      autosave?.stop();
      toolbar.destroy();
      input.destroy();
      renderer.destroy();
    },
  };

  return app;
}
