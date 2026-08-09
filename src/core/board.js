import {
  CONNECTOR,
  connectorBetween,
  connectorsTouching,
  isConnector,
  isPlaced,
} from './connectors.js';
import { bbox, rectContains, rectsIntersect } from './geometry.js';

/**
 * The domain layer: what a board *is*, in terms the UI never has to restate.
 *
 * Board owns the vocabulary (cards, envelopes, lists), the rules that follow
 * from it (an envelope carries what sits inside it; envelopes stay behind
 * loose objects), and the geometry the pointer code needs (snapping, hit
 * testing). None of it touches the DOM, so all of it is testable in isolation.
 */

export const OBJECT_DEFAULTS = {
  // No `fill`: the palette cycle in add() gives one, and a card made without
  // it renders the default from core/card-style.js. A literal here would also
  // win over a board's older `color`, painting a pink card yellow.
  card: () => ({ w: 200, h: 120, text: '' }),
  envelope: () => ({ w: 440, h: 320, title: 'Envelope' }),
  list: () => ({ w: 260, h: 230, title: 'List', items: [] }),
  /**
   * An image is the one type nobody creates empty: it arrives from a clipboard
   * with its own proportions, and both the size and the `src` are handed in.
   * The defaults are what an image with neither would be — a box of nothing,
   * which is what a picture that failed to arrive should look like rather than
   * a full-width blank.
   */
  image: () => ({ w: 240, h: 180, src: '' }),
};

export const CARD_COLORS = ['yellow', 'blue', 'green', 'pink', 'white'];

/** How deep envelope-inside-envelope nesting is followed. */
const MAX_NESTING = 8;

export class Board {
  constructor({ store, selection, newId, colors = CARD_COLORS }) {
    this.store = store;
    this.selection = selection;
    this.newId = newId;
    this.colors = colors;
    this.colorCursor = 0;
  }

  // ---------- creation ----------

  /** Build an object without inserting it. */
  make(type, props = {}) {
    const defaults = OBJECT_DEFAULTS[type];
    if (!defaults) throw new Error(`unknown object type: ${type}`);
    return { id: this.newId(), type, x: 0, y: 0, ...defaults(), ...props };
  }

  newItem(text = '') {
    return { id: this.newId(), text, done: false };
  }

  /**
   * Insert an object and select it. Cards cycle through the palette, lists
   * start with one empty row, and envelopes drop to the back of the z-order so
   * anything placed on them lands on top.
   */
  add(type, props = {}) {
    const obj = this.make(type, props);
    // `fill`, which is what the style vocabulary calls it. `color` is still
    // read when a board carries it — see core/card-style.js — but nothing
    // writes it any more.
    if (type === 'card' && props.fill === undefined && props.color === undefined) {
      obj.fill = this.colors[this.colorCursor++ % this.colors.length];
    }
    if (type === 'list' && props.items === undefined) obj.items = [this.newItem()];

    this.store.apply([{ t: 'add', obj, index: type === 'envelope' ? 0 : undefined }]);
    this.selection.set([obj.id]);
    return obj;
  }

  // ---------- connectors ----------

  /**
   * Join two objects with an arrow, pointing from the first to the second.
   *
   * The selection is left alone rather than moved to the new connector: the two
   * objects stay selected, which is what keeps the control that made it on
   * screen and able to take it away again.
   *
   * Refused rather than duplicated when the two are already joined — in either
   * direction, since a second arrow between the same pair is drawn on top of the
   * first and says nothing the first did not.
   */
  connect(fromId, toId) {
    if (fromId === toId) return null;
    if (!isPlaced(this.store.get(fromId)) || !isPlaced(this.store.get(toId))) return null;
    if (connectorBetween(this.store.all(), fromId, toId)) return null;

    const obj = { id: this.newId(), type: CONNECTOR, from: fromId, to: toId };
    this.store.apply([{ t: 'add', obj }]);
    return obj;
  }

  /** Take away whatever joins two objects. Answers whether anything did. */
  disconnect(a, b) {
    const found = connectorBetween(this.store.all(), a, b);
    if (!found) return false;
    this.store.apply([{ t: 'del', id: found.id }]);
    return true;
  }

  /**
   * The connectors whose *both* ends are among these ids.
   *
   * The rule everything that copies a group follows: an arrow with one end
   * outside what is being taken has nothing to point at when it lands, and one
   * with both ends inside is part of the picture rather than a decoration on it.
   */
  connectorsWithin(ids) {
    const inside = new Set(ids);
    return this.store.all().filter(
      (obj) => isConnector(obj) && inside.has(obj.from) && inside.has(obj.to),
    );
  }

  /** Place an object centred on a world point. */
  addCenteredOn(type, point, props = {}) {
    const size = { ...OBJECT_DEFAULTS[type](), ...props };
    return this.add(type, {
      ...props,
      x: Math.round(point.x - size.w / 2),
      y: Math.round(point.y - size.h / 2),
    });
  }

  /**
   * The selection as objects to copy, in the order they are stacked.
   *
   * An envelope brings what it holds, exactly as dragging one does: an envelope
   * is a container, and copying a container that arrives empty is not what
   * anybody selecting one meant. The same transitive rule, so an envelope of
   * envelopes copies whole.
   *
   * Ordered by the z-order rather than by the selection, because depth is part
   * of what is being copied — `store.all()` is already back-to-front, and
   * `paste` puts them back in the order it receives them.
   */
  copyable() {
    const wanted = new Set(this.withEnvelopeChildren(this.selection.list()));

    /**
     * A connector comes along when both the things it joins do, whether or not
     * it was selected — and is left behind when they do not, even if it was.
     * Copying two joined cards should paste two joined cards; copying one of
     * them cannot paste an arrow into the middle of nothing.
     */
    for (const obj of this.store.all()) {
      if (!isConnector(obj)) continue;
      if (wanted.has(obj.from) && wanted.has(obj.to)) wanted.add(obj.id);
      else wanted.delete(obj.id);
    }

    return this.store.all().filter((obj) => wanted.has(obj.id)).map((obj) => structuredClone(obj));
  }

  /**
   * Place copied objects, centred on a world point, and select them.
   *
   * New ids, always: these may be a copy of objects still on this sheet, and
   * two objects sharing an id is a document where an op means two things. Item
   * ids inside a list are left alone, as `duplicate` and `Sheets#duplicate`
   * leave them — they are addressed within their list and no op names one from
   * outside.
   *
   * Types this build does not know are dropped here rather than added. The
   * renderer builds an element by asking `views` for the type, so an object
   * from a newer client would not draw wrong — it would throw, and take the
   * sheet's rendering with it. Board is where the vocabulary lives, so this is
   * where the question is answered.
   *
   * Centred on the point rather than offset from where they were copied,
   * because the point is where the person is looking: the objects may have come
   * from another sheet, another board or another window, and "24 pixels down and
   * right of wherever this was" is a place off the side of the screen.
   */
  paste(objects, point) {
    const usable = objects.filter((obj) => OBJECT_DEFAULTS[obj?.type]);
    // Nothing to place, so nothing for a connector to join either — a payload
    // of arrows alone is a payload of nothing.
    if (!usable.length) return [];

    const box = bbox(usable);
    const dx = point.x - (box.x + box.w / 2);
    const dy = point.y - (box.y + box.h / 2);

    const clones = usable.map((obj) => ({
      ...structuredClone(obj),
      id: this.newId(),
      x: Math.round(obj.x + dx),
      y: Math.round(obj.y + dy),
    }));

    /**
     * The arrows, pointed at the copies rather than at the originals.
     *
     * Every id in the payload is being replaced, so a connector carrying the
     * old ones would join whatever those ids happen to name on *this* sheet —
     * which is the objects it was copied from, if they are still here. Hence
     * the map, and hence dropping the ones whose ends did not come along.
     */
    const renamed = new Map(usable.map((obj, at) => [obj.id, clones[at].id]));
    const joins = objects
      .filter((obj) => isConnector(obj) && renamed.has(obj.from) && renamed.has(obj.to))
      .map((obj) => ({
        ...structuredClone(obj),
        id: this.newId(),
        from: renamed.get(obj.from),
        to: renamed.get(obj.to),
      }));

    /**
     * Envelopes go in at the back, in their own order, and everything else on
     * top — the rule `add` follows, applied to a group. Appending a pasted
     * envelope where it happens to fall in the copied order would drop it over
     * the objects already on the board and bury them.
     */
    let depth = 0;
    this.store.apply([...clones, ...joins].map((obj) => (obj.type === 'envelope'
      ? { t: 'add', obj, index: depth++ }
      : { t: 'add', obj })));

    // The selection is what was placed. A connector follows its ends about, so
    // there is nothing to do to it and nothing gained by ringing it.
    this.selection.set(clones.map((obj) => obj.id));
    return [...clones, ...joins];
  }

  duplicate(offset = 24) {
    if (!this.selection.size) return [];

    // Only what has somewhere to go. A connector's copy is made below, from the
    // pair it joins — offsetting one by hand would mean giving it coordinates,
    // which is the one thing it does not have.
    const sources = this.selection.list().map((id) => this.store.get(id)).filter(isPlaced);
    if (!sources.length) return [];

    const clones = sources.map((src) => ({
      ...structuredClone(src),
      id: this.newId(),
      x: src.x + offset,
      y: src.y + offset,
    }));

    const renamed = new Map(sources.map((obj, at) => [obj.id, clones[at].id]));
    const joins = this.connectorsWithin(renamed.keys()).map((obj) => ({
      ...structuredClone(obj),
      id: this.newId(),
      from: renamed.get(obj.from),
      to: renamed.get(obj.to),
    }));

    this.store.apply([...clones, ...joins].map((obj) => ({ t: 'add', obj })));
    this.selection.set(clones.map((o) => o.id));
    return [...clones, ...joins];
  }

  // ---------- editing ----------

  /**
   * Delete the selection. An envelope's contents are not swept up with it.
   *
   * The connectors that pointed at what is going do go, though — an arrow to
   * something that is not there is not a thing anybody drew — and in the same
   * batch, so one undo puts the whole picture back rather than the cards first
   * and the arrows after.
   */
  deleteSelected() {
    const ids = this.selection.list();
    if (!ids.length) return false;

    const doomed = new Set(ids);
    for (const obj of connectorsTouching(this.store.all(), ids)) doomed.add(obj.id);

    this.store.apply([...doomed].map((id) => ({ t: 'del', id })));
    this.selection.clear();
    return true;
  }

  moveBy(ids, dx, dy, record = true) {
    if (!ids.length || (!dx && !dy)) return;
    this.store.apply(
      ids.map((id) => {
        const o = this.store.get(id);
        return { t: 'set', id, patch: { x: o.x + dx, y: o.y + dy } };
      }),
      record,
    );
  }

  /** Nudge the selection, carrying whatever its envelopes contain. */
  nudgeSelection(dx, dy) {
    this.moveBy(this.movable(this.withEnvelopeChildren(this.selection.list())), dx, dy);
  }

  /**
   * The ids in a list that can actually be moved.
   *
   * A connector has no x and no y, so `moveBy` would write `NaN` into the
   * document and broadcast it — the arrow moves by having its ends move, which
   * is the whole reason it has no coordinates of its own.
   */
  movable(ids) {
    return ids.filter((id) => isPlaced(this.store.get(id)));
  }

  setItems(id, items) {
    this.store.apply([{ t: 'set', id, patch: { items } }]);
  }

  toggleItem(id, itemId) {
    const items = this.store.get(id).items.map((i) => (i.id === itemId ? { ...i, done: !i.done } : i));
    this.setItems(id, items);
  }

  /** Insert a blank row after `index` and return it. */
  insertItemAfter(id, index) {
    const item = this.newItem();
    const items = this.store.get(id).items.slice();
    items.splice(index + 1, 0, item);
    this.setItems(id, items);
    return item;
  }

  /** Remove a row, unless it is the last one. Returns the row above it. */
  removeItemAt(id, index) {
    const current = this.store.get(id).items;
    if (current.length <= 1) return null;
    this.setItems(id, current.filter((_, i) => i !== index));
    return current[index - 1] ?? null;
  }

  // ---------- z-order ----------

  /**
   * Bring objects to the front, preserving their relative order. Envelopes are
   * deliberately excluded: raising one would bury the cards it holds.
   */
  raise(ids) {
    const targets = ids.filter((id) => this.store.get(id)?.type !== 'envelope');
    if (!targets.length) return false;

    const wanted = new Set(targets);
    const top = this.store.order.slice(-targets.length);
    if (top.length === targets.length && top.every((id) => wanted.has(id))) return false;

    this.store.apply([{
      t: 'order',
      order: [
        ...this.store.order.filter((id) => !wanted.has(id)),
        ...this.store.order.filter((id) => wanted.has(id)),
      ],
    }], false);
    return true;
  }

  // ---------- spatial queries ----------

  /** Grow a set of ids to include everything the selected envelopes contain. */
  withEnvelopeChildren(ids) {
    const out = new Set(ids);
    const all = this.store.all();

    for (let pass = 0, grew = true; grew && pass < MAX_NESTING; pass++) {
      grew = false;
      for (const id of [...out]) {
        const envelope = this.store.get(id);
        if (envelope?.type !== 'envelope') continue;
        for (const obj of all) {
          if (out.has(obj.id) || obj.id === id) continue;
          // A connector is not "inside" anything: it is wherever its ends are,
          // and it follows them without being carried.
          if (!isPlaced(obj)) continue;
          if (rectContains(envelope, obj)) {
            out.add(obj.id);
            grew = true;
          }
        }
      }
    }
    return [...out];
  }

  /**
   * Ids of every object touching `rect` — and the connectors between them.
   *
   * A marquee is drawn round a piece of the board, and the arrows joining the
   * things inside it are part of that piece. Included by their *ends* rather
   * than by where the line runs, which is the same rule copying follows and
   * needs no geometry: an arrow crossing the marquee between two objects
   * outside it belongs to them, not to what was dragged round.
   */
  idsIntersecting(rect) {
    const hit = this.store.all().filter((o) => isPlaced(o) && rectsIntersect(o, rect)).map((o) => o.id);
    return [...hit, ...this.connectorsWithin(hit).map((o) => o.id)];
  }

  bounds() {
    return bbox(this.store.all().filter(isPlaced));
  }

  // ---------- snapping ----------

  /** Candidate alignment lines: every edge and midline except the ids given. */
  snapTargets(exclude = new Set()) {
    const xs = [];
    const ys = [];
    for (const o of this.store.all()) {
      if (exclude.has(o.id) || !isPlaced(o)) continue;
      xs.push(o.x, o.x + o.w / 2, o.x + o.w);
      ys.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
    return { xs, ys };
  }

  /**
   * Nudge a proposed (dx, dy) so the moving box lands on a target line.
   * Returns the adjusted delta plus the guides worth drawing.
   */
  resolveSnap(box, dx, dy, targets, tolerance) {
    const guides = [];
    const nearest = (edges, candidates) => {
      let best = null;
      for (const edge of edges) {
        for (const candidate of candidates) {
          const d = candidate - edge;
          if (Math.abs(d) <= tolerance && (!best || Math.abs(d) < Math.abs(best.d))) {
            best = { d, at: candidate };
          }
        }
      }
      return best;
    };

    const x = box.x + dx;
    const y = box.y + dy;
    const sx = nearest([x, x + box.w / 2, x + box.w], targets.xs);
    const sy = nearest([y, y + box.h / 2, y + box.h], targets.ys);

    if (sx) {
      dx += sx.d;
      guides.push({ axis: 'v', at: sx.at });
    }
    if (sy) {
      dy += sy.d;
      guides.push({ axis: 'h', at: sy.at });
    }
    return { dx, dy, guides };
  }
}
