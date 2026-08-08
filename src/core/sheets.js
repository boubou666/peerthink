import { REMOTE, Store } from './store.js';

/**
 * The sheets of a board: several named canvases, one of them on screen.
 *
 * A board was one infinite surface, which sounds like enough room until a
 * project has three subjects and they either sprawl into each other or get
 * split across boards that then have nothing to do with one another. Sheets
 * are the tabbed answer every tool with this problem arrives at.
 *
 * **Only the active sheet is a live `Store`.** The rest are documents held
 * here beside it. That is the whole design, and what it buys is that `store`
 * is the same object for the life of the app: the renderer, the input layer,
 * the selection and the format bar never learn that sheets exist, and an
 * inactive sheet costs no listeners, no rendering and no reconciliation —
 * only correct content, which is all anyone can see of it.
 *
 * Switching is `checkpoint` on the way out and `restore` on the way in, so the
 * undo stack travels with the sheet rather than with the screen. Undo on the
 * sheet you are looking at is what "undo" means here; walking back into edits
 * on a canvas nobody is showing is not.
 *
 * Nothing in this file touches the DOM or the network. What is a *policy* of
 * the app rather than of the document — clearing the selection on a switch,
 * where the camera points — lives in `app.js`.
 */

/** The document format this writes. v1 is a board from before sheets. */
export const DOCUMENT_VERSION = 2;

/** What a board's first sheet is called when nobody has named it. */
export const FIRST_SHEET_NAME = 'Sheet 1';

/** How long a sheet name may be. Long enough to say what it is; short enough to be a tab. */
export const NAME_LIMIT = 64;

const asName = (value, fallback) => {
  const name = typeof value === 'string' ? value.trim().slice(0, NAME_LIMIT) : '';
  return name || fallback;
};

/** The `{ order, objects }` half of a sheet, guarded the way a document is. */
const asDocument = (raw) => ({
  order: Array.isArray(raw?.order) ? raw.order.filter((id) => typeof id === 'string') : [],
  objects: Array.isArray(raw?.objects) ? raw.objects.filter((obj) => typeof obj?.id === 'string') : [],
});

/**
 * A stored document as sheets, whatever version wrote it.
 *
 * Total, and deliberately so. This is the first thing a board goes through on
 * the way in, from Web Storage or from a server, and the alternative to
 * reading junk as an empty sheet is a board that will not open. Every board
 * that existed before sheets is a single sheet, and is read as one here rather
 * than migrated in place — there is no moment where a board has to be
 * converted, and nothing to run against boards that are not being opened.
 */
export function readDocument(doc, newId) {
  const sheets = Array.isArray(doc?.sheets) ? doc.sheets : null;

  if (!sheets?.length) {
    return [{ id: newId(), name: FIRST_SHEET_NAME, ...asDocument(doc) }];
  }

  return sheets.map((sheet, index) => ({
    // An id is what ops address a sheet by, so one that is missing or repeated
    // has to be replaced rather than trusted — two sheets with one id would
    // take each other's edits.
    id: typeof sheet?.id === 'string' && sheet.id ? sheet.id : newId(),
    name: asName(sheet?.name, `Sheet ${index + 1}`),
    ...asDocument(sheet),
  }));
}

/**
 * Sheets as a document that older clients can still read.
 *
 * The first sheet is written twice: once in `sheets`, once at the top level
 * where a board has always kept its objects. That is what `isBoard` in
 * `platform/storage.js` checks and what the `boards_doc_shape` constraint in
 * the database checks, so a sheeted board needs no migration and no policy
 * changes — and a tab still running the previous build finds a real board
 * rather than a document it reads as absent, which it would answer by seeding
 * a starter board over the top.
 *
 * It is insurance, not a guarantee: that older client saving would write a v1
 * document back and drop the other sheets. There is no version of this that
 * fixes a client already running.
 */
export function writeDocument(sheets) {
  const [first] = sheets;
  return {
    v: DOCUMENT_VERSION,
    sheets: sheets.map(({ id, name, order, objects }) => ({ id, name, order, objects })),
    order: first?.order ?? [],
    objects: first?.objects ?? [],
  };
}

export function createSheets({ store, newId }) {
  /**
   * Every sheet, in tab order, as `{ id, name, state }`.
   *
   * `state` is a checkpoint — the document plus its undo stacks — and is null
   * for the sheet on screen, whose content is the store's. A copy kept here
   * for the active sheet would be a second answer that goes stale on the first
   * edit, so `stateOf` asks the store for that one.
   */
  let entries = [];
  let activeId = null;

  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(); };

  /**
   * An edit on the sheet on screen is a change to the board.
   *
   * Whoever is watching the board — the autosave, above all — cannot watch the
   * store instead: it would hear the sheet being edited and miss a sheet being
   * added, renamed or removed, and a board would go unsaved until somebody
   * happened to move a card.
   *
   * Only emits that carry what changed are forwarded. A store emits null when
   * its whole document is replaced, which here means a board loading or a
   * sheet being put on screen — neither is an edit, and treating a sheet
   * switch as one would write the board out again on every tab click.
   */
  store.on((changed) => {
    if (changed) emit();
  });

  const find = (id) => entries.find((entry) => entry.id === id);
  const at = (id) => entries.findIndex((entry) => entry.id === id);

  const stateOf = (entry) => (entry.id === activeId ? store.checkpoint() : entry.state);

  const asState = ({ order = [], objects = [] } = {}) => ({ order, objects, past: [], future: [] });

  /** Put a sheet on screen, taking a copy of the one leaving it. */
  const show = (id) => {
    const leaving = find(activeId);
    if (leaving) leaving.state = store.checkpoint();

    const arriving = find(id);
    const { state } = arriving;
    activeId = id;
    arriving.state = null;
    store.restore(state);
  };

  /** `Sheet 2`, or the first number after it that is not taken. */
  const nextName = () => {
    const taken = new Set(entries.map((entry) => entry.name));
    for (let n = entries.length + 1; ; n++) {
      const name = `Sheet ${n}`;
      if (!taken.has(name)) return name;
    }
  };

  /**
   * A sheet's objects, copied as new objects.
   *
   * New ids, because two sheets holding the same object id is a document where
   * an op means two things — and because that is what duplicating anything
   * else here does (`Board#duplicate`). Item ids inside a list are left alone,
   * also as `Board#duplicate` leaves them: they are addressed within their
   * list, and no op names one from outside.
   */
  const copyObjects = ({ order, objects }) => {
    const ids = new Map(objects.map((obj) => [obj.id, newId()]));
    return {
      order: order.filter((id) => ids.has(id)).map((id) => ids.get(id)),
      objects: objects.map((obj) => ({ ...structuredClone(obj), id: ids.get(obj.id) })),
    };
  };

  const sheets = {
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    get activeId() {
      return activeId;
    },

    /** Name and id only: what a tab strip draws, without the documents. */
    list: () => entries.map(({ id, name }) => ({ id, name })),

    get size() {
      return entries.length;
    },

    has: (id) => Boolean(find(id)),

    /** A stored board becomes this board. Its first sheet is the one shown. */
    load(doc) {
      entries = readDocument(doc, newId).map(({ id, name, order, objects }) => ({
        id,
        name,
        state: asState({ order, objects }),
      }));
      activeId = null;
      show(entries[0].id);
      emit();
    },

    select(id) {
      if (id === activeId || !find(id)) return false;
      show(id);
      emit();
      return true;
    },

    /** A new empty sheet, which becomes the one on screen. */
    add({ name } = {}) {
      const sheet = { id: newId(), name: asName(name, nextName()), state: asState() };
      entries.push(sheet);
      show(sheet.id);
      emit();
      return sheet.id;
    },

    rename(id, name) {
      const entry = find(id);
      if (!entry) return false;
      const next = asName(name, entry.name);
      if (next === entry.name) return false;
      entry.name = next;
      emit();
      return true;
    },

    /**
     * A copy of a sheet, right after it, and on screen — duplicating something
     * in order to work on the copy is the reason anybody duplicates it.
     */
    duplicate(id) {
      const entry = find(id);
      if (!entry) return null;

      const copy = {
        id: newId(),
        name: asName(`${entry.name} (copy)`, nextName()),
        state: asState(copyObjects(stateOf(entry))),
      };

      entries.splice(at(id) + 1, 0, copy);
      show(copy.id);
      emit();
      return copy.id;
    },

    /**
     * Remove a sheet, unless it is the only one — a board with no sheets is a
     * board with no canvas, and "delete the last one" is a request to empty it
     * rather than to remove it. The neighbour on the right takes over, or the
     * one on the left when there is no right.
     */
    remove(id) {
      if (entries.length < 2 || !find(id)) return false;

      const index = at(id);
      const wasActive = id === activeId;
      entries.splice(index, 1);
      if (wasActive) {
        activeId = null;
        show(entries[Math.min(index, entries.length - 1)].id);
      }
      emit();
      return true;
    },

    /**
     * Ops from another client, for whichever sheet they were made on.
     *
     * The active sheet is the store, and this is what it has always done. An
     * inactive one is a document, and the ops are applied to it through a
     * throwaway `Store` — so there is exactly one implementation of what an op
     * means, `mergeOrder` and all, rather than a second one here that would
     * drift from it.
     *
     * A sheet this client does not have is dropped. It is a sheet somebody
     * else has just made, whose creation is on its way; guessing at a document
     * to put the ops in would invent a sheet that nothing else agrees exists.
     */
    applyRemote(sheetId, ops) {
      const entry = find(sheetId);
      if (!entry) return false;

      if (entry.id === activeId) {
        store.apply(ops, false, REMOTE);
        return true;
      }

      const aside = new Store();
      aside.load(entry.state);
      aside.apply(ops, false, REMOTE);
      entry.state = { ...aside.toJSON(), past: entry.state.past, future: entry.state.future };
      emit();
      return true;
    },

    toJSON() {
      return writeDocument(entries.map((entry) => {
        const { order, objects } = stateOf(entry);
        return { id: entry.id, name: entry.name, order, objects };
      }));
    },
  };

  return sheets;
}
