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
import { createLocalStorageRepository, createNullRepository } from './platform/storage.js';

const ELEMENT_IDS = {
  stage: 'stage',
  bg: 'bg',
  layer: 'layer',
  overlay: 'overlay',
  toolbar: 'toolbar',
  zoomLabel: 'zoom',
};

/**
 * The composition root.
 *
 * Nothing below this file reaches for a global: the document, the window, the
 * clock and the storage backend all arrive as arguments. That is what lets the
 * whole app be constructed twice on one page, driven by a fake clock in a
 * test, or repointed at a different persistence backend without touching a
 * line of the core.
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
  storageKey,
  seed = seedBoard,
} = {}) {
  const dom = elements ?? Object.fromEntries(
    Object.entries(ELEMENT_IDS).map(([name, id]) => [name, document.getElementById(id)]),
  );

  const clock = scheduler ?? createScheduler({
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  });

  const boardRepository = repository
    ?? (storage ? createLocalStorageRepository({ storage, ...(storageKey ? { key: storageKey } : {}) }) : createNullRepository());

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

  // load before autosave is wired, so a restore never writes itself back
  const saved = boardRepository.load();
  if (saved) store.load(saved);
  else seed(board);

  const autosave = createAutosave({ store, repository: boardRepository, scheduler: clock, delay: autosaveDelay });
  commands.fit();

  return {
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
    restoredFromStorage: Boolean(saved),
    destroy() {
      autosave.stop();
      toolbar.destroy();
      input.destroy();
      renderer.destroy();
    },
  };
}
