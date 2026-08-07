/**
 * Other people's pointers, on the board.
 *
 * Positions travel in **world** coordinates, so a cursor points at the thing
 * its owner is pointing at rather than at a place on their screen. Two people
 * at different zooms, or looking at different corners, still agree about what
 * is being pointed at — which is the only reason to draw someone else's
 * pointer at all.
 *
 * They are drawn in the overlay, which is screen space and untransformed, so
 * the arrow and the name stay the same size at any zoom — the same reasoning
 * that keeps selection handles constant. The cost is that every pan and zoom
 * has to reposition them, which is why this listens to the viewport.
 *
 * A cursor is removed when presence says its owner has left, not on a timer.
 * A person who is here and still is still here.
 */

/** Stable per person, and the same for everyone looking at them. */
export function colourFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 70% 45%)`;
}

/**
 * What a pointer is called when presence has not named it.
 *
 * Deliberately not "Guest". A signed-out person really is labelled `Guest` by
 * `shell/sync.js`, so using the same word here made two different situations
 * read identically on screen: someone anonymous is on this board, and a
 * pointer arrived bearing an id presence has never mentioned. The first is
 * ordinary and the second is a bug, and telling them apart from a screenshot
 * was impossible while they shared a word.
 *
 * Presence carries a label for every real member, so this should be unreachable
 * in a healthy session — which is exactly why it should not look ordinary.
 */
const NAMELESS = 'Someone';

export function createCursors({ document, elements, viewport, sync, scheduler }) {
  const { stage, overlay } = elements;

  /** id → last known world position. */
  const cursors = new Map();
  /** id → what to call them, from presence. */
  const labels = new Map();
  const nodes = new Map();
  let destroyed = false;

  const nodeFor = (id) => {
    const existing = nodes.get(id);
    if (existing) return existing;

    const el = document.createElement('div');
    el.className = 'cursor';
    el.dataset.cursor = id;
    el.style.setProperty('--cursor-colour', colourFor(id));

    const arrow = document.createElement('div');
    arrow.className = 'cursor-arrow';
    const name = document.createElement('div');
    name.className = 'cursor-name';

    el.append(arrow, name);
    overlay.appendChild(el);

    const node = { el, name };
    nodes.set(id, node);
    return node;
  };

  const remove = (id) => {
    nodes.get(id)?.el.remove();
    nodes.delete(id);
    cursors.delete(id);
  };

  /**
   * Position every cursor. Coalesced to a frame: a burst of arriving messages
   * and a pan in the same frame are one layout, not one each.
   */
  const render = scheduler.onFrame(() => {
    if (destroyed) return;
    for (const [id, point] of cursors) {
      const { x, y } = viewport.toScreen(point.x, point.y);
      const { el, name } = nodeFor(id);
      el.style.transform = `translate(${x}px, ${y}px)`;

      const label = labels.get(id) ?? NAMELESS;
      if (name.textContent !== label) name.textContent = label;
    }
  });

  const onPointerMove = (event) => {
    const rect = stage.getBoundingClientRect();
    sync.moveCursor(viewport.toWorld(event.clientX - rect.left, event.clientY - rect.top));
  };

  // A pointer that has left the board is not at the edge of it, it is gone.
  const onPointerLeave = () => sync.moveCursor(null);

  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerleave', onPointerLeave);
  const unsubscribeViewport = viewport.on(render);

  return {
    /** A pointer arriving from someone else — or leaving. */
    receive({ id, x, y, gone }) {
      if (destroyed) return;
      if (gone) remove(id);
      else cursors.set(id, { x, y });
      render();
    },

    /**
     * Presence, which is the authority on who is here. Anyone who has gone
     * takes their pointer with them; anyone still here may have brought a
     * name since last time.
     */
    setMembers(members) {
      if (destroyed) return;
      const here = new Set();
      labels.clear();

      for (const { id, label } of members) {
        here.add(id);
        if (label) labels.set(id, label);
      }
      for (const id of [...cursors.keys()]) if (!here.has(id)) remove(id);
      render();
    },

    /** For tests and for the console: who is being drawn right now. */
    list: () => [...cursors.keys()],

    destroy() {
      destroyed = true;
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerleave', onPointerLeave);
      unsubscribeViewport();
      for (const id of [...nodes.keys()]) remove(id);
    },
  };
}
