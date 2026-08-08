import { LOCAL, REMOTE, Store } from './store.js';

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

/**
 * The id every board's first sheet gets, rather than a fresh one.
 *
 * A sheet id is what an op is addressed to, so it has to mean the same thing
 * on every client — and the first sheet is the one nobody ever agreed on. It
 * is not created by anybody: it is what a board from before sheets *becomes*
 * when it is read, and what a board with nothing stored yet starts as. Two
 * clients doing that independently must arrive at the same id or their ops
 * pass each other addressed to sheets neither has.
 *
 * Fixed rather than derived from the board, because it is scoped to one: ids
 * only ever have to be unique within a document, and a channel only ever
 * carries one board.
 *
 * Every other sheet is made by somebody, on a client, at a moment — those get
 * a generated id, and reach other clients along with the sheet itself.
 */
export const FIRST_SHEET_ID = 'sheet-1';

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
    return [{ id: FIRST_SHEET_ID, name: FIRST_SHEET_NAME, ...asDocument(doc) }];
  }

  /**
   * An id is what an op is addressed to, so one that is missing or already
   * taken is replaced rather than trusted. Two sheets sharing an id is not a
   * cosmetic fault: everything here finds a sheet by the first match, so the
   * second would be unreachable — impossible to switch to, taking the other's
   * remote ops — and `writeDocument` would store the collision for next time.
   */
  const taken = new Set();
  const idFor = (id) => {
    const usable = typeof id === 'string' && id && !taken.has(id) ? id : newId();
    taken.add(usable);
    return usable;
  };

  return sheets.map((sheet, index) => ({
    id: idFor(sheet?.id),
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

/**
 * A change to the *set* of sheets, as something that can cross a wire.
 *
 * The store's ops say what happened on a canvas; these say what happened to
 * the board. Same shape and same reason: one vocabulary of plain serialisable
 * records, applied through one path, so what another client receives is what
 * this one did rather than a second implementation of it.
 *
 *   { t:'sheet-add',    id, name, index, order, objects }
 *   { t:'sheet-rename', id, name }
 *   { t:'sheet-del',    id }
 *
 * `sheet-add` carries the contents because that is what makes duplicating a
 * sheet one change rather than a change plus every object on it — and it
 * carries the ids, so the copy is the same copy everywhere. An empty sheet is
 * the same record with nothing in it.
 *
 * There is no `sheet-order`: nothing reorders sheets yet, and a vocabulary
 * with a word nothing says is a word that will be wrong when something does.
 */
export function isSheetChange(change) {
  if (!change || typeof change !== 'object' || typeof change.id !== 'string') return false;
  switch (change.t) {
    case 'sheet-add':
      return (
        typeof change.name === 'string'
        && Number.isInteger(change.index)
        && Array.isArray(change.order)
        && Array.isArray(change.objects)
      );
    case 'sheet-rename':
      return typeof change.name === 'string';
    case 'sheet-del':
      return true;
    default:
      return false;
  }
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

  /**
   * Whether these are the board's sheets, or the placeholder standing in until
   * it arrives.
   *
   * The canvas is interactive from the first frame, which is the point of
   * loading separately — but until the board lands, the one sheet here is not
   * one of the board's, and `load` is about to replace every entry. A sheet
   * added to a placeholder is a sheet added to nothing: it is wiped by the
   * load, and announcing it to the other clients would be announcing a sheet
   * this one no longer has.
   *
   * So the set of sheets is fixed until `ready()`. What can be done in that
   * window is what could always be done in it — drawing on the canvas — and
   * those ops are replayed onto the board when it arrives, which works because
   * there is exactly one canvas to replay them onto.
   */
  let settled = false;

  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(); };

  /**
   * Every change to the set of sheets, with where it came from — the seam the
   * sync layer plugs into, exactly as `store.onOps` is for the canvas.
   *
   * `on` above says "something changed, draw again", which is what a tab strip
   * needs. This says what happened, which is what a wire needs.
   */
  const changeListeners = new Set();
  const emitChanges = (changes, origin) => {
    for (const fn of changeListeners) fn(changes, origin);
  };

  /** Announce a local change and tell whoever is drawing. */
  const changed = (change) => {
    emit();
    emitChanges([change], LOCAL);
  };

  /**
   * Take a sheet out, wherever the request came from.
   *
   * The last one stays: a board with no sheets has no canvas, and that has to
   * hold on every client rather than only on the one that pressed Delete — two
   * people removing the last two sheets at once would otherwise leave a board
   * that cannot be drawn on. The neighbour on the right takes over, or the one
   * on the left when there is no right.
   */
  const drop = (id) => {
    if (entries.length < 2 || !find(id)) return false;

    const index = at(id);
    const wasActive = id === activeId;
    entries.splice(index, 1);
    if (wasActive) {
      activeId = null;
      show(entries[Math.min(index, entries.length - 1)].id);
    }
    return true;
  };

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

    onChanges(fn) {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },

    get activeId() {
      return activeId;
    },

    /** Whether the board has arrived, and so whether its sheets can be changed. */
    get settled() {
      return settled;
    },

    /**
     * The board has landed — from storage, or by being seeded because there
     * was none. Called by `hydrate` for both, since what matters is that the
     * sheets on screen are now the board's and not a placeholder.
     */
    ready() {
      if (settled) return;
      settled = true;
      emit();
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
      if (!settled) return null;
      const sheet = { id: newId(), name: asName(name, nextName()), state: asState() };
      entries.push(sheet);
      show(sheet.id);
      changed({ t: 'sheet-add', id: sheet.id, name: sheet.name, index: entries.length - 1, order: [], objects: [] });
      return sheet.id;
    },

    rename(id, name) {
      if (!settled) return false;
      const entry = find(id);
      if (!entry) return false;
      const next = asName(name, entry.name);
      if (next === entry.name) return false;
      entry.name = next;
      changed({ t: 'sheet-rename', id, name: next });
      return true;
    },

    /**
     * A copy of a sheet, right after it, and on screen — duplicating something
     * in order to work on the copy is the reason anybody duplicates it.
     */
    duplicate(id) {
      const entry = settled ? find(id) : null;
      if (!entry) return null;

      const copy = {
        id: newId(),
        name: asName(`${entry.name} (copy)`, nextName()),
        state: asState(copyObjects(stateOf(entry))),
      };

      const index = at(id) + 1;
      entries.splice(index, 0, copy);

      // Read before `show`, which hands the copy's contents to the store and
      // leaves the entry holding null — the active sheet's state is the
      // store's, and that is the whole point of it being null.
      //
      // The objects travel with the change, ids and all: a copy announced as
      // "make a sheet, and here is everything on it" would be the same board
      // twice over, and the two clients would disagree about the ids.
      const { order, objects } = copy.state;
      show(copy.id);
      changed({ t: 'sheet-add', id: copy.id, name: copy.name, index, order, objects });
      return copy.id;
    },

    /**
     * Remove a sheet, unless it is the only one — a board with no sheets is a
     * board with no canvas, and "delete the last one" is a request to empty it
     * rather than to remove it. The neighbour on the right takes over, or the
     * one on the left when there is no right.
     */
    remove(id) {
      if (!settled || !drop(id)) return false;
      changed({ t: 'sheet-del', id });
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
    /**
     * Somebody else added, renamed, duplicated or removed a sheet.
     *
     * Every one of these is written to survive arriving twice, or arriving for
     * something that is not here: a channel can resend, and a client can be
     * told about a sheet it has already been told about. Ignoring is always the
     * answer — none of these changes is worth guessing at, and a wrong guess
     * would put a sheet on one client that no other client agrees exists.
     *
     * A sheet arriving does *not* become the sheet on screen. Somebody else
     * made it, on their screen; moving this person off what they were doing
     * because a colleague pressed `+` is the kind of thing that makes a
     * collaborative tool unusable. Their own `add` shows it, because that one
     * goes through `add`.
     */
    applyChanges(changes) {
      let touched = false;

      for (const change of changes) {
        if (!isSheetChange(change)) continue;

        if (change.t === 'sheet-add') {
          if (find(change.id)) continue;
          const at = Math.min(Math.max(change.index, 0), entries.length);
          entries.splice(at, 0, {
            id: change.id,
            name: asName(change.name, `Sheet ${at + 1}`),
            state: asState({ order: change.order, objects: change.objects }),
          });
          touched = true;
        } else if (change.t === 'sheet-rename') {
          const entry = find(change.id);
          const name = asName(change.name, entry?.name);
          if (!entry || entry.name === name) continue;
          entry.name = name;
          touched = true;
        } else if (change.t === 'sheet-del') {
          touched = drop(change.id) || touched;
        }
      }

      if (touched) {
        emit();
        emitChanges(changes, REMOTE);
      }
      return touched;
    },

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
