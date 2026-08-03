/** Which objects are selected, with its own change notification. */
export class Selection {
  constructor() {
    this.ids = new Set();
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.ids);
  }

  get size() {
    return this.ids.size;
  }

  has(id) {
    return this.ids.has(id);
  }

  list() {
    return [...this.ids];
  }

  /** Replace the selection. Equivalent sets do not notify. */
  set(ids) {
    const next = new Set(ids);
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return;
    this.ids = next;
    this.emit();
  }

  toggle(id) {
    this.ids.has(id) ? this.ids.delete(id) : this.ids.add(id);
    this.emit();
  }

  clear() {
    if (!this.ids.size) return;
    this.ids.clear();
    this.emit();
  }
}
