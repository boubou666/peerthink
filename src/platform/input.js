import { bbox, rectFromPoints } from '../core/geometry.js';

export const SNAP_PX = 6;       // snap radius, screen px
export const DRAG_SLOP = 3;     // screen px before a click becomes a drag
export const MIN_SIZE = 48;     // world units
export const ZOOM_RATE = 0.002; // ≈1.27× per mouse-wheel notch

const RESIZE_DIRS = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
  ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1],
};

/**
 * Pointer and keyboard behaviour.
 *
 * One gesture is active at a time and each is a small object with move/end, so
 * the event plumbing stays flat and every gesture owns its own state. The
 * intermediate frames of a drag or resize are applied without recording, then
 * collapsed into a single undo entry on release.
 *
 * Everything domain-shaped — what an envelope contains, where things snap,
 * what z-order means — is delegated to Board. What is left here is genuinely
 * about input.
 */
export function createInput({ document, window, elements, store, selection, viewport, board, commands }) {
  const { stage, layer, overlay } = elements;

  let gesture = null;
  let spaceDown = false;
  let editingId = null;
  let editSnapshot = null;

  const listeners = [];
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };

  // ---------- coordinates ----------

  const stagePoint = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const worldPoint = (e) => {
    const p = stagePoint(e);
    return viewport.toWorld(p.x, p.y);
  };

  // ---------- pointer dispatch ----------

  function onPointerDown(e) {
    if (e.button === 1 || e.button === 2 || spaceDown) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (e.button !== 0) return;

    const objEl = e.target.closest?.('[data-id]');
    const id = objEl?.dataset.id;

    // inside the object being edited, let the caret do its job
    if (id && id === editingId && e.target.isContentEditable) return;

    if (!objEl) {
      if (!e.shiftKey) selection.clear();
      startMarquee(e);
      return;
    }

    if (e.target.closest('.li-check')) {
      e.preventDefault();
      board.toggleItem(id, e.target.closest('[data-item-id]').dataset.itemId);
      return;
    }
    if (e.target.closest('.list-add')) {
      e.preventDefault();
      appendItem(id);
      return;
    }

    const handle = e.target.closest('[data-handle]');
    if (handle && selection.has(id)) {
      e.preventDefault();
      startResize(e, id, handle.dataset.handle);
      return;
    }

    e.preventDefault(); // suppress default caret placement and text selection
    if (e.shiftKey) selection.toggle(id);
    else if (!selection.has(id)) selection.set([id]);

    if (selection.has(id)) {
      board.raise(selection.list());
      startDrag(e);
    }
  }

  function onPointerUp(e) {
    if (!gesture) return;
    const active = gesture;
    gesture = null;
    active.end(e);
    stage.classList.remove('panning');
  }

  // ---------- pan & zoom ----------

  function startPan(e) {
    const from = { x: e.clientX, y: e.clientY };
    const origin = { x: viewport.x, y: viewport.y };
    stage.classList.add('panning');
    gesture = {
      move(ev) {
        viewport.moveTo(
          origin.x - (ev.clientX - from.x) / viewport.scale,
          origin.y - (ev.clientY - from.y) / viewport.scale,
        );
      },
      end() {},
    };
  }

  function onWheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // ctrlKey is also how browsers report a trackpad pinch
    if (e.ctrlKey || e.metaKey) {
      const p = stagePoint(e);
      viewport.zoomAt(p.x, p.y, Math.exp(-e.deltaY * unit * ZOOM_RATE));
    } else {
      viewport.panBy(-e.deltaX * unit, -e.deltaY * unit);
    }
  }

  // ---------- drag ----------

  function startDrag(e) {
    const ids = board.withEnvelopeChildren(selection.list());
    const start = worldPoint(e);
    const from = { x: e.clientX, y: e.clientY };
    const origins = new Map(ids.map((id) => {
      const o = store.get(id);
      return [id, { x: o.x, y: o.y }];
    }));
    const box = bbox(ids.map((id) => store.get(id)));
    const targets = board.snapTargets(new Set(ids));
    let moved = false;

    gesture = {
      move(ev) {
        if (!moved && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_SLOP) return;
        moved = true;

        const p = worldPoint(ev);
        let dx = p.x - start.x;
        let dy = p.y - start.y;

        if (ev.altKey) {
          drawGuides([]);
        } else {
          const snapped = board.resolveSnap(box, dx, dy, targets, SNAP_PX / viewport.scale);
          dx = snapped.dx;
          dy = snapped.dy;
          drawGuides(snapped.guides);
        }

        store.apply(
          ids.map((id) => {
            const origin = origins.get(id);
            return { t: 'set', id, patch: { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) } };
          }),
          false,
        );
      },
      end() {
        drawGuides([]);
        if (!moved) return;
        const forward = [];
        const inverse = [];
        for (const id of ids) {
          const o = store.get(id);
          forward.push({ t: 'set', id, patch: { x: o.x, y: o.y } });
          inverse.unshift({ t: 'set', id, patch: origins.get(id) });
        }
        store.pushHistory(forward, inverse);
      },
    };
  }

  function drawGuides(guides) {
    for (const el of overlay.querySelectorAll('.guide')) el.remove();
    for (const guide of guides) {
      const el = document.createElement('div');
      el.className = `guide ${guide.axis}`;
      const p = viewport.toScreen(guide.at, guide.at);
      if (guide.axis === 'v') el.style.left = `${p.x}px`;
      else el.style.top = `${p.y}px`;
      overlay.appendChild(el);
    }
  }

  // ---------- resize ----------

  function startResize(e, id, dir) {
    const o = store.get(id);
    const start = { x: o.x, y: o.y, w: o.w, h: o.h };
    const from = worldPoint(e);
    const [hx, hy] = RESIZE_DIRS[dir];
    let moved = false;

    gesture = {
      move(ev) {
        moved = true;
        const p = worldPoint(ev);
        const dx = p.x - from.x;
        const dy = p.y - from.y;
        let { x, y, w, h } = start;

        if (hx === 1) w = Math.max(MIN_SIZE, start.w + dx);
        if (hx === -1) { w = Math.max(MIN_SIZE, start.w - dx); x = start.x + start.w - w; }
        if (hy === 1) h = Math.max(MIN_SIZE, start.h + dy);
        if (hy === -1) { h = Math.max(MIN_SIZE, start.h - dy); y = start.y + start.h - h; }

        store.apply([{
          t: 'set',
          id,
          patch: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
        }], false);
      },
      end() {
        if (!moved) return;
        const now = store.get(id);
        store.pushHistory(
          [{ t: 'set', id, patch: { x: now.x, y: now.y, w: now.w, h: now.h } }],
          [{ t: 'set', id, patch: start }],
        );
      },
    };
  }

  // ---------- marquee ----------

  function startMarquee(e) {
    const anchor = stagePoint(e);
    const additive = e.shiftKey;
    const base = selection.list();
    const el = document.createElement('div');
    el.id = 'marquee';
    overlay.appendChild(el);

    gesture = {
      move(ev) {
        const p = stagePoint(ev);
        const screen = rectFromPoints(anchor, p);
        Object.assign(el.style, {
          left: `${screen.x}px`,
          top: `${screen.y}px`,
          width: `${screen.w}px`,
          height: `${screen.h}px`,
        });

        const world = rectFromPoints(
          viewport.toWorld(screen.x, screen.y),
          viewport.toWorld(screen.x + screen.w, screen.y + screen.h),
        );
        const hits = board.idsIntersecting(world);
        selection.set(additive ? [...base, ...hits] : hits);
      },
      end() {
        el.remove();
      },
    };
  }

  // ---------- text editing ----------

  function onDoubleClick(e) {
    const objEl = e.target.closest?.('[data-id]');
    if (!objEl) {
      commands.addAt('card', worldPoint(e));
      return;
    }
    const field = e.target.closest('[contenteditable]') ?? objEl.querySelector('[contenteditable]');
    if (field) focusEditable(field, e.clientX, e.clientY);
  }

  function focusEditable(el, clientX, clientY) {
    el.focus();
    let range = null;
    const position = document.caretPositionFromPoint?.(clientX, clientY);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    } else {
      range = document.caretRangeFromPoint?.(clientX, clientY) ?? null;
    }
    if (!range) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function onFocusIn(e) {
    const objEl = e.target.closest('[data-id]');
    if (!objEl || !e.target.isContentEditable) return;
    editingId = objEl.dataset.id;
    editSnapshot = structuredClone(store.get(editingId));
    objEl.classList.add('editing');
  }

  function onFocusOut(e) {
    e.target.closest('[data-id]')?.classList.remove('editing');
    commitEdit();
    editingId = null;
  }

  /** Collapse a whole editing session into one undo entry. */
  function commitEdit() {
    const before = editSnapshot;
    editSnapshot = null;
    if (!before) return;

    const now = store.get(before.id);
    if (!now) return; // deleted while being edited

    const forward = {};
    const inverse = {};
    for (const key of ['text', 'title', 'items']) {
      if (key in before && JSON.stringify(before[key]) !== JSON.stringify(now[key])) {
        forward[key] = structuredClone(now[key]);
        inverse[key] = structuredClone(before[key]);
      }
    }
    if (!Object.keys(forward).length) return;
    store.pushHistory(
      [{ t: 'set', id: before.id, patch: forward }],
      [{ t: 'set', id: before.id, patch: inverse }],
    );
  }

  function onInput(e) {
    const objEl = e.target.closest('[data-id]');
    const field = e.target.dataset.field;
    if (!objEl || !field) return;
    const id = objEl.dataset.id;

    if (field === 'item') {
      const itemId = e.target.closest('[data-item-id]').dataset.itemId;
      const items = store.get(id).items.map((i) => (i.id === itemId ? { ...i, text: e.target.innerText } : i));
      store.apply([{ t: 'set', id, patch: { items } }], false);
    } else {
      store.apply([{ t: 'set', id, patch: { [field]: e.target.innerText } }], false);
    }
  }

  /** The store holds strings, so paste has to arrive as one. */
  function onPaste(e) {
    if (!e.target.isContentEditable) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  }

  // ---------- list rows ----------

  function onListKeyDown(e) {
    if (e.target.dataset?.field !== 'item') return;
    const row = e.target.closest('[data-item-id]');
    const id = row.closest('[data-id]').dataset.id;
    const index = store.get(id).items.findIndex((i) => i.id === row.dataset.itemId);

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
      const item = board.insertItemAfter(id, index);
      resnapshot(id);
      focusItemSoon(id, item.id);
    } else if (e.key === 'Backspace' && !e.target.innerText) {
      const previous = store.get(id).items[index - 1];
      commitEdit();
      if (!board.removeItemAt(id, index)) return;
      e.preventDefault();
      resnapshot(id);
      if (previous) focusItemSoon(id, previous.id, true);
    } else if (e.key === 'Escape') {
      e.target.blur();
    }
  }

  /** A structural change was recorded separately; restart the text snapshot. */
  function resnapshot(id) {
    if (editingId === id) editSnapshot = structuredClone(store.get(id));
  }

  function appendItem(id) {
    commitEdit();
    const item = board.insertItemAfter(id, store.get(id).items.length - 1);
    resnapshot(id);
    focusItemSoon(id, item.id);
  }

  function focusItemSoon(id, itemId, atEnd = false) {
    window.requestAnimationFrame(() => {
      const el = layer.querySelector(`[data-id="${id}"] [data-item-id="${itemId}"] [data-field="item"]`);
      if (!el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(!atEnd);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }

  // ---------- keyboard ----------

  function onKeyDown(e) {
    if (e.code === 'Space' && !spaceDown && !editingId) {
      spaceDown = true;
      stage.classList.add('space');
      e.preventDefault();
    }
    if (editingId || e.target.isContentEditable) return;

    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
    } else if (mod && key === 'a') {
      e.preventDefault();
      selection.set(store.order);
    } else if (mod && key === 'd') {
      e.preventDefault();
      board.duplicate();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!selection.size) return;
      e.preventDefault();
      board.deleteSelected();
    } else if (e.key === 'Escape') {
      selection.clear();
    } else if (e.key.startsWith('Arrow')) {
      if (!selection.size) return;
      e.preventDefault();
      const step = e.shiftKey ? 20 : 1;
      board.nudgeSelection(
        ((e.key === 'ArrowRight') - (e.key === 'ArrowLeft')) * step,
        ((e.key === 'ArrowDown') - (e.key === 'ArrowUp')) * step,
      );
    } else if (!mod && e.key.length === 1 && 'cel'.includes(key)) {
      commands.addAtCenter({ c: 'card', e: 'envelope', l: 'list' }[key]);
    }
  }

  function releaseSpace() {
    spaceDown = false;
    stage.classList.remove('space');
  }

  // ---------- wiring ----------

  listen(stage, 'pointerdown', onPointerDown);
  listen(window, 'pointermove', (e) => gesture?.move(e));
  listen(window, 'pointerup', onPointerUp);
  listen(stage, 'wheel', onWheel, { passive: false });
  listen(stage, 'dblclick', onDoubleClick);
  listen(stage, 'contextmenu', (e) => e.preventDefault());

  listen(layer, 'focusin', onFocusIn);
  listen(layer, 'focusout', onFocusOut);
  listen(layer, 'input', onInput);
  listen(layer, 'paste', onPaste);
  listen(layer, 'keydown', onListKeyDown);

  listen(window, 'keydown', onKeyDown);
  listen(window, 'keyup', (e) => {
    if (e.code === 'Space') releaseSpace();
  });
  listen(window, 'blur', releaseSpace);

  return {
    get editingId() {
      return editingId;
    },
    destroy() {
      for (const off of listeners) off();
      listeners.length = 0;
    },
  };
}
