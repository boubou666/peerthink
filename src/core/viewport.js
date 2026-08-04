import { clamp } from './geometry.js';

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 6;

/**
 * Camera over an unbounded world.
 *
 * (x, y) is the world coordinate sitting at the stage's top-left, so
 *   screen = (world - origin) * scale
 * and the whole camera collapses into one translate+scale the GPU applies.
 */
export class Viewport {
  constructor({ minScale = MIN_SCALE, maxScale = MAX_SCALE } = {}) {
    this.x = 0;
    this.y = 0;
    this.scale = 1;
    this.minScale = minScale;
    this.maxScale = maxScale;
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  toWorld(sx, sy) {
    return { x: sx / this.scale + this.x, y: sy / this.scale + this.y };
  }

  toScreen(wx, wy) {
    return { x: (wx - this.x) * this.scale, y: (wy - this.y) * this.scale };
  }

  moveTo(x, y) {
    this.x = x;
    this.y = y;
    this.emit();
  }

  panBy(dxScreen, dyScreen) {
    this.x -= dxScreen / this.scale;
    this.y -= dyScreen / this.scale;
    this.emit();
  }

  /** Zoom by `factor`, keeping the world point under (sx, sy) pinned. */
  zoomAt(sx, sy, factor) {
    const next = clamp(this.scale * factor, this.minScale, this.maxScale);
    if (next === this.scale) return;
    const anchor = this.toWorld(sx, sy);
    this.scale = next;
    this.x = anchor.x - sx / next;
    this.y = anchor.y - sy / next;
    this.emit();
  }

  setScaleAt(sx, sy, scale) {
    this.zoomAt(sx, sy, clamp(scale, this.minScale, this.maxScale) / this.scale);
  }

  /** World rectangle visible in a stage of `w` × `h` screen pixels. */
  visibleRect(w, h) {
    return { x: this.x, y: this.y, w: w / this.scale, h: h / this.scale };
  }

  center(w, h) {
    const r = this.visibleRect(w, h);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  /** Frame `rect` inside a `w` × `h` stage. */
  fit(rect, w, h, { padding = 80, maxScale = 1.5 } = {}) {
    if (!rect || rect.w <= 0 || rect.h <= 0) return false;
    const scale = clamp(
      Math.min((w - padding * 2) / rect.w, (h - padding * 2) / rect.h),
      this.minScale,
      maxScale,
    );
    this.scale = scale;
    this.x = rect.x + rect.w / 2 - w / 2 / scale;
    this.y = rect.y + rect.h / 2 - h / 2 / scale;
    this.emit();
    return true;
  }
}
