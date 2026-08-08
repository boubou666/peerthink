/**
 * The document: a bag of objects plus a z-order, mutated only through ops.
 *
 * The store knows nothing about cards or envelopes — that vocabulary lives in
 * Board. What it guarantees is that every change is expressed as a list of
 * plain, serialisable ops with a computable inverse. That is the seam a sync
 * layer plugs into: the same array that drives the local render is what you
 * would broadcast, append to a log, or replay on load.
 *
 *   { t:'add',   obj, index? }
 *   { t:'del',   id }
 *   { t:'set',   id, patch }
 *   { t:'order', order }
 */

const HISTORY_LIMIT = 300;

/**
 * Whether an op is one of ours, and complete enough to apply.
 *
 * `apply` trusts what it is given, which is right for a caller in this
 * process and wrong for one that arrived over a wire — an `add` with no `obj`
 * throws on the way in and takes the receiver's session with it. The vocabulary
 * is defined here, so the check belongs here too rather than in the transport.
 */
export function isOp(op) {
  if (!op || typeof op !== 'object') return false;
  switch (op.t) {
    case 'add':
      return Boolean(op.obj) && typeof op.obj === 'object' && typeof op.obj.id === 'string';
    case 'del':
      return typeof op.id === 'string';
    case 'set':
      // A patch may not carry `id`. `apply` assigns the patch over the object,
      // and the id is also the key in `objects` and the entry in `order` —
      // changing it in one place only would leave an object nothing can
      // address, and free the old id for a later `add` to duplicate.
      return (
        typeof op.id === 'string'
        && Boolean(op.patch)
        && typeof op.patch === 'object'
        && !Object.hasOwn(op.patch, 'id')
      );
    case 'order':
      return Array.isArray(op.order) && op.order.every((id) => typeof id === 'string');
    default:
      return false;
  }
}

/** Where a change came from. Remote ops are applied but never sent back. */
export const LOCAL = 'local';
export const REMOTE = 'remote';

/**
 * Reconcile an incoming z-order against the one in hand.
 *
 * An `order` op names the whole array, which is fine on one machine and
 * destructive on two: the sender's array cannot mention an object they had not
 * received yet, and taking it literally would drop that object out of the
 * z-order — out of `all()`, out of the render, and out of the next snapshot.
 * The object would still be in the map, and gone from the document.
 *
 * So the incoming order decides the relative depth of everything it names, and
 * anything it does not name keeps the depth it has here. That leaves a
 * concurrent add where its author put it — an envelope at the bottom, a card
 * on top — and makes the op idempotent, which a message that can arrive twice
 * has to be. Two people reordering at once still resolve last-writer-wins,
 * which is what "bring to front" means anyway.
 */
export function mergeOrder(current, incoming, objects) {
  const kept = incoming.filter((id) => objects.has(id));
  const named = new Set(kept);
  const merged = kept.slice();

  // ascending index, so each unnamed id lands at the depth it already had
  current.forEach((id, index) => {
    if (!named.has(id) && objects.has(id)) merged.splice(Math.min(index, merged.length), 0, id);
  });
  return merged;
}

export class Store {
  constructor() {
    this.objects = new Map();
    this.order = [];
    this.past = [];
    this.future = [];
    this.listeners = new Set();
    this.opListeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ids) {
    for (const fn of this.listeners) fn(ids);
  }

  /**
   * Every applied op, with where it came from — the seam a sync layer plugs
   * into. `on` reports which objects changed, which is what a renderer needs;
   * this reports what happened, which is what a wire needs.
   */
  onOps(fn) {
    this.opListeners.add(fn);
    return () => this.opListeners.delete(fn);
  }

  emitOps(ops, origin) {
    for (const fn of this.opListeners) fn(ops, origin);
  }

  get(id) {
    return this.objects.get(id);
  }

  has(id) {
    return this.objects.has(id);
  }

  all() {
    return this.order.map((id) => this.objects.get(id));
  }

  /**
   * Apply ops in order and return the inverse list.
   * `record: false` keeps a change out of history — used for the many
   * intermediate states of a drag, collapsed into one entry at drop.
   */
  apply(ops, record = true, origin = LOCAL) {
    const inverse = [];
    const touched = new Set();

    for (const op of ops) {
      switch (op.t) {
        case 'add': {
          const obj = structuredClone(op.obj);
          const index = op.index ?? this.order.length;
          this.objects.set(obj.id, obj);
          // An id already in the order is an add that has arrived twice — a
          // resent message, or a snapshot that already contained it. Adding
          // the id again would put the same object in the document twice,
          // which the renderer and toJSON would both faithfully reproduce.
          if (!this.order.includes(obj.id)) this.order.splice(index, 0, obj.id);
          inverse.unshift({ t: 'del', id: obj.id });
          touched.add(obj.id);
          break;
        }
        case 'del': {
          const obj = this.objects.get(op.id);
          if (!obj) break;
          const index = this.order.indexOf(op.id);
          this.objects.delete(op.id);
          this.order.splice(index, 1);
          inverse.unshift({ t: 'add', obj, index });
          touched.add(op.id);
          break;
        }
        case 'set': {
          const obj = this.objects.get(op.id);
          if (!obj) break;
          const prev = {};
          for (const key of Object.keys(op.patch)) prev[key] = structuredClone(obj[key]);
          Object.assign(obj, structuredClone(op.patch));
          inverse.unshift({ t: 'set', id: op.id, patch: prev });
          touched.add(op.id);
          break;
        }
        case 'order': {
          inverse.unshift({ t: 'order', order: this.order.slice() });
          this.order = mergeOrder(this.order, op.order, this.objects);
          for (const id of this.order) touched.add(id);
          break;
        }
      }
    }

    if (record && ops.length) this.pushHistory(ops, inverse);
    if (ops.length) {
      this.emit(touched);
      this.emitOps(ops, origin);
    }
    return inverse;
  }

  pushHistory(forward, inverse) {
    if (!forward.length) return;
    this.past.push({ forward, inverse });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  undo() {
    const entry = this.past.pop();
    if (!entry) return false;
    this.apply(entry.inverse, false);
    this.future.push(entry);
    return true;
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return false;
    this.apply(entry.forward, false);
    this.past.push(entry);
    return true;
  }

  toJSON() {
    return { v: 1, order: this.order.slice(), objects: this.all().map((o) => structuredClone(o)) };
  }

  /**
   * Everything this store is, history included.
   *
   * `toJSON` is the document — what gets stored, and what another client would
   * be sent. This is the document *plus* the undo stacks, which are nobody
   * else's business and are not worth saving, but are worth keeping while a
   * sheet is put aside: coming back to a sheet and finding that ctrl+Z no
   * longer knows what you did on it is the kind of forgetting that reads as a
   * bug. See `core/sheets.js`, which is the only caller.
   */
  checkpoint() {
    return {
      ...this.toJSON(),
      past: structuredClone(this.past),
      future: structuredClone(this.future),
    };
  }

  /**
   * Become that document again, history and all.
   *
   * One emit at the end rather than one per part: everything downstream — the
   * renderer, the toolbar's undo buttons, the format bar — is reading a store
   * that has half-changed until this returns.
   */
  restore(state) {
    this.objects = new Map(state.objects.map((o) => [o.id, structuredClone(o)]));
    this.order = state.order.filter((id) => this.objects.has(id));
    this.past = structuredClone(state.past ?? []);
    this.future = structuredClone(state.future ?? []);
    this.emit(null);
  }

  /**
   * A document arrives from storage or from another client. History is dropped
   * rather than kept: undo should not walk back past a board loading, into a
   * document that is no longer the one on screen.
   */
  load(data) {
    this.restore({ ...data, past: [], future: [] });
  }
}
