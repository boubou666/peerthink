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

export class Store {
  constructor() {
    this.objects = new Map();
    this.order = [];
    this.past = [];
    this.future = [];
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ids) {
    for (const fn of this.listeners) fn(ids);
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
  apply(ops, record = true) {
    const inverse = [];
    const touched = new Set();

    for (const op of ops) {
      switch (op.t) {
        case 'add': {
          const obj = structuredClone(op.obj);
          const index = op.index ?? this.order.length;
          this.objects.set(obj.id, obj);
          this.order.splice(index, 0, obj.id);
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
          this.order = op.order.slice();
          for (const id of this.order) touched.add(id);
          break;
        }
      }
    }

    if (record && ops.length) this.pushHistory(ops, inverse);
    if (ops.length) this.emit(touched);
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

  load(data) {
    this.objects = new Map(data.objects.map((o) => [o.id, structuredClone(o)]));
    this.order = data.order.filter((id) => this.objects.has(id));
    this.past.length = 0;
    this.future.length = 0;
    this.emit(null);
  }
}
