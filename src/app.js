import { connectorBox, isPlaced } from './core/connectors.js';
import { LOCAL, REMOTE, Store } from './core/store.js';
import { Selection } from './core/selection.js';
import { Viewport } from './core/viewport.js';
import { Board } from './core/board.js';
import { createSheets } from './core/sheets.js';
import { createAutosave } from './core/autosave.js';
import { createIdGenerator } from './core/ids.js';
import { UNLOADED, createSaveStatus } from './core/save-status.js';
import { createScheduler } from './core/scheduler.js';
import { seedBoard } from './core/seed.js';
import { exportFrame, fileName } from './core/export.js';
import { search } from './core/search.js';

import { createConnectorLayer } from './platform/connectors.js';
import { createViews } from './platform/views.js';
import { createRenderer } from './platform/renderer.js';
import { createInput } from './platform/input.js';
import { createClipboard } from './platform/clipboard.js';
import { createImageImport } from './platform/images.js';
import { createLinks } from './platform/links.js';
import { createTextLinks } from './platform/text-link.js';
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
  /**
   * What is at a link, asked of something that can actually fetch it — see
   * `platform/links.js` for why that cannot be this browser. Absent, a hovered
   * link says it cannot be checked from here, which is the honest state of a
   * board running with no project.
   */
  fetchPreview,
  /**
   * Something the user did that produced nothing, by a code the shell turns
   * into a sentence — a pasted file that was not a picture this can hold, so
   * far. The wording lives up there with every other message a person reads,
   * and the canvas layer does not acquire an opinion about copy.
   */
  onProblem,
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
  /**
   * What a search has turned up, which is a set of ids that something draws —
   * exactly what `Selection` is, so it is one. Separate from the selection
   * proper because the two mean different things to every key on the keyboard:
   * Delete takes what is selected, and nobody searching for a word means to
   * delete every card holding it.
   */
  const found = new Selection();
  const viewport = new Viewport();
  const board = new Board({ store, selection, newId });

  /**
   * The board's sheets, of which `store` is always the one on screen.
   *
   * Built loaded with an empty sheet rather than left empty until `hydrate`:
   * the canvas is interactive from the first frame, so there has to be a sheet
   * to draw on and a sheet id for an early op to name before anything has come
   * back from the repository.
   */
  const sheets = createSheets({ store, newId });
  sheets.load(null);

  const stageSize = () => [dom.stage.clientWidth, dom.stage.clientHeight];

  /**
   * Focus an object's text so the user can just start typing — a card that has
   * only this moment been made, or the label on a connector, which is the same
   * question asked of a different element.
   */
  const focusNew = (id) => clock.nextFrame(() => {
    dom.layer.querySelector(`[data-id="${id}"] [contenteditable]`)?.focus();
  });

  /**
   * Where each sheet was last being looked at.
   *
   * In memory and not in the document: a camera is where *this* person is
   * standing, and storing it would send it to everyone else on the board and
   * make a save out of scrolling. Coming back to a sheet and finding it where
   * you left it is worth this much and no more — a reload starts everyone in
   * the same place, framed on what is there.
   */
  const cameras = new Map();

  /**
   * Put the screen in order whenever the sheet on it changes.
   *
   * Subscribed rather than wrapped around the commands, because a switch is no
   * longer always this person's doing: someone else deleting the sheet you are
   * looking at moves you to its neighbour, and that arrives through the channel
   * with no command of yours to hang this on. One subscription covers both, and
   * cannot be forgotten by a command added later.
   *
   * The selection is emptied because it names objects on the sheet being left,
   * and a selection of things nobody can see is a delete key pointed at
   * something off screen. The camera is the arriving sheet's own if it has one
   * yet, and otherwise frames whatever is on it — a sheet with nothing on it
   * goes to its origin, because there is nothing to frame and `fit` leaves an
   * empty board's camera exactly where the last sheet had it.
   */
  let showing = sheets.activeId;
  sheets.on(() => {
    if (sheets.activeId === showing) return;

    // The camera has not moved yet, so it is still the outgoing sheet's.
    cameras.set(showing, { x: viewport.x, y: viewport.y, scale: viewport.scale });
    showing = sheets.activeId;

    selection.clear();
    const camera = cameras.get(showing);
    if (camera) {
      viewport.scale = camera.scale;
      viewport.moveTo(camera.x, camera.y);
    } else if (store.order.length) {
      commands.fit();
    } else {
      viewport.scale = 1;
      viewport.moveTo(0, 0);
    }
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
     * Put the caret in an object's text. The format bar's way of starting a
     * connector's label, which has no double-click of its own until there are
     * words to double-click.
     */
    editText: (id) => focusNew(id),

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
      /**
       * The selection, plus the arrows *between* what is in it — the rule
       * copying follows, and for the same reason: a picture of two joined cards
       * that leaves out what joins them is a picture of something else.
       */
      const picked = new Set(selection.list());
      for (const obj of board.connectorsWithin(picked)) picked.add(obj.id);

      const chosen = selection.size
        ? store.all().filter((obj) => picked.has(obj.id))
        : store.all();

      const frame = exportFrame(chosen);
      if (!frame) return 'empty';

      const blob = await exporter.render(chosen, frame);
      if (!blob) return 'failed';

      exporter.save(blob, fileName(app.title));
      return 'ok';
    },

    /**
     * Where words are on this board: every sheet, in reading order.
     *
     * The *answer* rather than the documents it was worked out from. Here
     * because "the board" is several documents and only one of them is the
     * store — which is the fact `sheets` exists to keep from spreading — and
     * because handing a component the objects themselves would put a live
     * document, editable behind the store's back, in the hands of anything that
     * asked. What comes back is a small list of ids and positions.
     */
    search: (query) => search(sheets.contents(), query),

    /**
     * Show a match: the sheet it is on, then the object, in the middle of the
     * screen at the zoom already in use.
     *
     * Selecting it rather than only pointing the camera at it, because "this
     * one" is what a step through matches means and the selection is how this
     * board says that — and because whatever is done next, from formatting to
     * Delete, is then about the thing that was found.
     */
    reveal(match) {
      if (!match) return false;
      if (match.sheetId && match.sheetId !== sheets.activeId) sheets.select(match.sheetId);

      const obj = store.get(match.id);
      if (!obj) return false;

      selection.set([obj.id]);
      const box = isPlaced(obj) ? obj : connectorBox(store.get(obj.from), store.get(obj.to));
      // An arrow whose ends overlap has nothing on screen to be taken to; it is
      // still selected, and the camera stays where the person left it.
      if (box) viewport.centreOn({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, ...stageSize());
      return true;
    },

    fit: () => viewport.fit(board.bounds(), ...stageSize()),
    resetZoom: () => {
      const [w, h] = stageSize();
      viewport.setScaleAt(w / 2, h / 2, 1);
    },

    /**
     * The sheet commands are the model's, unwrapped: what the screen does when
     * the sheet on it changes is the subscription above, which does not care
     * whether the change came from this person or another one.
     */
    selectSheet: (id) => sheets.select(id),
    addSheet: (options) => sheets.add(options),
    duplicateSheet: (id) => sheets.duplicate(id),
    removeSheet: (id) => sheets.remove(id),
    renameSheet: (id, name) => sheets.rename(id, name),
  };

  const exporter = createPngExporter({ document, window });
  const views = createViews({ document });
  /**
   * The arrows, in one SVG behind everything. Built here rather than inside the
   * renderer because it is a piece of the browser like the views are, and the
   * renderer is what tells it that the document changed.
   */
  const connectors = createConnectorLayer({ document, elements: dom, store, selection, found, views });
  const renderer = createRenderer({
    document,
    elements: dom,
    store,
    viewport,
    selection,
    views,
    connectors,
    found,
    scheduler: clock,
    ResizeObserver,
  });
  const input = createInput({
    document,
    window,
    elements: dom,
    store,
    selection,
    found,
    viewport,
    board,
    commands,
    // Leaving a field applies no op, so nothing else would redraw it — and the
    // view will not touch a field while it is focused. This is what turns a URL
    // just typed into a link.
    relink: (id) => renderer.sync(new Set([id])),
    // The other way round, on the way in: a link with a label is drawn as its
    // label, and what is about to be edited has to be the string the store
    // holds.
    showSource: (el) => views.showSource(el),
    // For the one gesture that draws before it writes: an arrow being dragged
    // from one object towards another.
    connectors,
  });
  const images = createImageImport({ document, window });
  const links = createLinks({ document, elements: dom, viewport, scheduler: clock, fetchPreview });
  /**
   * Turning selected words into a link — the browser's half of it, which the
   * format bar drives. Built here like everything else that touches the
   * document, so the component above holds no opinion about selections.
   */
  const textLinks = createTextLinks({ document, window, store });
  const clipboard = createClipboard({ document, elements: dom, selection, viewport, board, images, onProblem });

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
        sheets,
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
      // Through the sheets, which is what turns a stored document — with
      // sheets or from before there were any — into this board and puts its
      // first sheet on screen.
      sheets.load(saved.board);
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

    /**
     * The sheets on screen are the board's now, in both branches — loaded, or
     * seeded because there was nothing to load. Until this, they are a
     * placeholder that `sheets.load` is about to replace, and the tab strip
     * offers nothing that would be wiped by it.
     */
    sheets.ready();

    // There is a document now, so whatever the channel delivered while there
    // was not can be replayed onto it. Before autosave is wired, so the ops
    // held from other editors are treated exactly as ops arriving a moment
    // later would be.
    landed.resolve();

    app.title = saved?.title ?? null;
    app.restoredFromStorage = Boolean(saved);

    autosave = createAutosave({
      // The whole board, not the sheet on screen: saving the store would store
      // whichever canvas happened to be showing and drop the rest.
      document: sheets,
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
    sheets,
    selection,
    found,
    viewport,
    board,
    commands,
    renderer,
    input,
    links,
    textLinks,
    clipboard,
    images,
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
      // Before the renderer, for the same reason autosave is stopped before
      // anything else: an image still being decoded would otherwise land in a
      // store nothing is drawing.
      clipboard.destroy();
      links.destroy();
      renderer.destroy();
    },
  };

  return app;
}
