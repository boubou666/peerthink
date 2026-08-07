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

  /** Place an object centred on a world point. */
  addCenteredOn(type, point, props = {}) {
    const size = { ...OBJECT_DEFAULTS[type](), ...props };
    return this.add(type, {
      ...props,
      x: Math.round(point.x - size.w / 2),
      y: Math.round(point.y - size.h / 2),
    });
  }

  duplicate(offset = 24) {
    if (!this.selection.size) return [];
    const clones = this.selection.list().map((id) => {
      const src = this.store.get(id);
      return { ...structuredClone(src), id: this.newId(), x: src.x + offset, y: src.y + offset };
    });
    this.store.apply(clones.map((obj) => ({ t: 'add', obj })));
    this.selection.set(clones.map((o) => o.id));
    return clones;
  }

  // ---------- editing ----------

  /** Delete the selection. An envelope's contents are not swept up with it. */
  deleteSelected() {
    const ids = this.selection.list();
    if (!ids.length) return false;
    this.store.apply(ids.map((id) => ({ t: 'del', id })));
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
    this.moveBy(this.withEnvelopeChildren(this.selection.list()), dx, dy);
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
          if (rectContains(envelope, obj)) {
            out.add(obj.id);
            grew = true;
          }
        }
      }
    }
    return [...out];
  }

  /** Ids of every object touching `rect`. */
  idsIntersecting(rect) {
    return this.store.all().filter((o) => rectsIntersect(o, rect)).map((o) => o.id);
  }

  bounds() {
    return bbox(this.store.all());
  }

  // ---------- snapping ----------

  /** Candidate alignment lines: every edge and midline except the ids given. */
  snapTargets(exclude = new Set()) {
    const xs = [];
    const ys = [];
    for (const o of this.store.all()) {
      if (exclude.has(o.id)) continue;
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
