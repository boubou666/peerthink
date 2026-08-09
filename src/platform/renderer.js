import { isPlaced } from '../core/connectors.js';
import { cornersOf, hasCorners } from '../core/corners.js';
import { rectsIntersect } from '../core/geometry.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const GRID = 20; // background dot spacing, world units

/**
 * Reconciles the store into the world layer.
 *
 * Pan and zoom touch exactly one transform, so they never walk the object
 * list. The per-object work is culling: offscreen elements stay in the DOM
 * (cheap to keep, expensive to rebuild) but are hidden, which drops them from
 * layout and paint.
 */
export function createRenderer({
  document,
  elements,
  store,
  viewport,
  selection,
  views,
  /**
   * The arrows, which are drawn somewhere else entirely — one SVG element
   * rather than one element each, and behind everything rather than in the
   * z-order. They are still objects in the store, so this is what tells them
   * that it changed.
   */
  connectors,
  scheduler,
  ResizeObserver,
}) {
  const { stage, bg, layer } = elements;
  const els = new Map();
  const unsubscribe = [];

  const cull = scheduler.onFrame(() => {
    const view = viewport.visibleRect(stage.clientWidth, stage.clientHeight);
    // pad by a screenful so a fast pan never reveals empty space
    const padded = { x: view.x - view.w / 2, y: view.y - view.h / 2, w: view.w * 2, h: view.h * 2 };
    for (const [id, el] of els) {
      const obj = store.get(id);
      if (obj) el.hidden = !rectsIntersect(obj, padded);
    }
  });

  function createElement(obj) {
    const el = views[obj.type].create();
    el.dataset.id = obj.id;
    el.dataset.type = obj.type;

    const handles = document.createElement('div');
    handles.className = 'handles';
    for (const dir of HANDLES) {
      const handle = document.createElement('div');
      handle.className = 'handle';
      handle.dataset.handle = dir;
      handles.appendChild(handle);
    }
    el.appendChild(handles);
    return el;
  }

  function updateElement(el, obj) {
    el.style.left = `${obj.x}px`;
    el.style.top = `${obj.y}px`;
    el.style.width = `${obj.w}px`;
    el.style.height = `${obj.h}px`;
    /**
     * Corners are the one piece of style every type shares, so they are resolved
     * here rather than inside each view — four copies of the same line would be
     * four places to forget it the next time a type is added. Everything else
     * about how an object looks is per type and stays in `views`.
     */
    if (hasCorners(obj)) el.dataset.corners = cornersOf(obj);
    views[obj.type].update(el, obj);
  }

  function applySelection() {
    const single = selection.size === 1;
    for (const [id, el] of els) {
      const on = selection.has(id);
      el.classList.toggle('selected', on);
      el.classList.toggle('handles-on', on && single);
    }
    connectors?.applySelection();
  }

  function applyTransform() {
    const { x, y, scale } = viewport;
    layer.style.transform = `translate(${-x * scale}px, ${-y * scale}px) scale(${scale})`;
    layer.style.setProperty('--z', scale);

    bg.style.backgroundSize = `${GRID * scale}px ${GRID * scale}px`;
    bg.style.backgroundPosition = `${-x * scale}px ${-y * scale}px`;
    bg.style.opacity = scale < 0.35 ? 0 : 1;

    cull();
  }

  /** @param {Set<string>|null} ids — null means "assume everything changed" */
  function sync(ids) {
    for (const [id, el] of els) {
      if (!store.has(id)) {
        el.remove();
        els.delete(id);
      }
    }

    let previous = null;
    for (const id of store.order) {
      const obj = store.get(id);
      // A connector has no element of its own here and no place in the z-order:
      // it is a line under everything, drawn by the layer below.
      if (!isPlaced(obj)) continue;
      let el = els.get(id);
      if (!el) {
        el = createElement(obj);
        els.set(id, el);
        ids?.add(id);
      }
      // keep DOM order == z-order, touching the DOM only where they diverge
      if (el.parentNode !== layer || el.previousElementSibling !== previous) {
        layer.insertBefore(el, previous ? previous.nextSibling : layer.firstChild);
      }
      previous = el;
      if (!ids || ids.has(id)) updateElement(el, obj);
    }

    /**
     * After the objects, and on every change rather than only when a connector
     * itself changed: an arrow is drawn from where its ends are, and they move
     * without it being touched.
     */
    connectors?.sync();

    applySelection();
    cull();
  }

  unsubscribe.push(store.on(sync));
  unsubscribe.push(selection.on(applySelection));
  unsubscribe.push(viewport.on(applyTransform));

  const observer = new ResizeObserver(applyTransform);
  observer.observe(stage);

  applyTransform();
  sync(null);

  return {
    elementFor: (id) => els.get(id),
    sync,
    applyTransform,
    cull,
    destroy() {
      observer.disconnect();
      for (const off of unsubscribe) off();
      connectors?.destroy();
      for (const el of els.values()) el.remove();
      els.clear();
    },
  };
}
