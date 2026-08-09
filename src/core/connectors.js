/**
 * Connectors: the arrows between two objects on a sheet.
 *
 * A connector is an object in the document like any other — `{ type:
 * 'connector', from, to }` — so it is added, deleted, synced and undone by the
 * same four ops as everything else, and nothing new had to be invented to make
 * one cross to the other people on a board.
 *
 * **It is the one object with no box of its own.** Where a card is a rectangle
 * somebody placed, a connector is a relation between two of them: its geometry
 * is worked out from wherever its endpoints are *now*, which is what lets a card
 * be dragged across the sheet without writing a single op for the arrows
 * following it. That is also the invariant every other part of the app has to
 * know about, and `isPlaced` is how it asks — bounds, snapping, marquee
 * selection, nudging and dragging are all about boxes, and a connector has none
 * to offer.
 *
 * Called a connector rather than an edge because this file is full of the other
 * kind: `board.js` snaps to "every edge and midline", and a word that means two
 * things in the same paragraph is a word that will be read wrong.
 */

import { bbox } from './geometry.js';

export const CONNECTOR = 'connector';

export const isConnector = (obj) => obj?.type === CONNECTOR;

/** Whether an object has a rectangle of its own — everything but a connector. */
export const isPlaced = (obj) => Boolean(obj) && !isConnector(obj);

/**
 * How a connector is drawn, in world units.
 *
 * World units, not screen pixels, because a connector is *content* rather than
 * an affordance: it scales with the board exactly as a card's text and padding
 * do, and for the reason the README gives for that line — a selection ring is
 * about your pointer and stays the same size, an arrow is about the board and
 * does not.
 */
export const HEAD = 15;   // how far back from the point the arrowhead reaches
export const SPREAD = 9;  // and how wide it is there, either side of the line
export const GAP = 5;     // clear air between an object's edge and the arrow

/** The middle of a rectangle. */
const centreOf = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

/**
 * Where the line from the middle of `rect` towards `point` crosses its border.
 *
 * The slab method: how far along the direction each pair of sides is, and the
 * nearer pair is the one the line leaves through. A direction of nothing — two
 * objects stacked exactly on each other — has no answer, and says so.
 *
 * Corners are treated as square even on a rounded object. The difference is a
 * few units at one radius, on a line that is about to be pulled back by `GAP`
 * anyway, and every reader of this file can hold "it meets the box" in their
 * head where nobody can hold the other thing.
 */
export function borderPoint(rect, point) {
  const centre = centreOf(rect);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  if (!dx && !dy) return null;

  const tx = dx ? (rect.w / 2) / Math.abs(dx) : Infinity;
  const ty = dy ? (rect.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);

  return { x: centre.x + dx * t, y: centre.y + dy * t };
}

/**
 * The line and the arrowhead for a connector between two boxes, or null when
 * there is no room to draw one.
 *
 * Null is a real answer and not a failure: two objects that overlap, or one
 * dropped inside the other, have no space between their borders — and a stub of
 * arrow drawn across a card would say something about the board that is not
 * true. The connector is still there, and reappears as soon as they are apart.
 *
 * The head is a triangle rather than a stroke that happens to look like one, so
 * it fills at any zoom and the export can draw the same three points.
 */
export function connectorGeometry(from, to, { gap = GAP, head = HEAD, spread = SPREAD } = {}) {
  const here = centreOf(from);
  const there = centreOf(to);

  const span = Math.hypot(there.x - here.x, there.y - here.y);
  if (!span) return null;

  const ux = (there.x - here.x) / span;
  const uy = (there.y - here.y) / span;

  const start = borderPoint(from, there);
  const end = borderPoint(to, here);
  if (!start || !end) return null;

  /**
   * How much of the line is outside both boxes — measured *along* the direction
   * they lie in, so overlapping objects give a negative answer rather than a
   * short positive one. Two boxes that intersect have their far borders in the
   * wrong order, and the distance between those two points says nothing about
   * whether there is room between them.
   */
  const room = (end.x - start.x) * ux + (end.y - start.y) * uy;
  // Two gaps and a head have to fit, or there is nothing to draw between them.
  if (room <= gap * 2 + head) return null;

  // The point of the arrow, one gap back from the border it points at.
  const tip = { x: end.x - ux * gap, y: end.y - uy * gap };
  const base = { x: tip.x - ux * head, y: tip.y - uy * head };
  const tail = { x: start.x + ux * gap, y: start.y + uy * gap };

  return {
    // The line stops at the head's base rather than at its point: a stroke
    // running under a filled triangle shows through its edges while it is
    // being drawn at an angle.
    line: { x1: tail.x, y1: tail.y, x2: base.x, y2: base.y },
    head: [
      [tip.x, tip.y],
      [base.x - uy * spread, base.y + ux * spread],
      [base.x + uy * spread, base.y - ux * spread],
    ],
  };
}

/**
 * Where a connector's label sits: the middle of the line it is about.
 *
 * The middle of the *line* rather than of the two objects, so a label stays on
 * its arrow when one end is a wide envelope and the other a small card — and so
 * the two renderers, the screen and the picture, put it in the same place
 * without either restating the arithmetic.
 */
export const labelPoint = (drawn) => ({
  x: (drawn.line.x1 + drawn.line.x2) / 2,
  y: (drawn.line.y1 + drawn.line.y2) / 2,
});

/** The connectors in `objects` that touch any of `ids`. */
export const connectorsTouching = (objects, ids) => {
  const wanted = new Set(ids);
  return objects.filter((obj) => isConnector(obj) && (wanted.has(obj.from) || wanted.has(obj.to)));
};

/**
 * The connector between two objects, in either direction, or null.
 *
 * Either direction, because "are these two joined" is the question the control
 * asks, and offering to connect two objects that are already connected the
 * other way round would draw a second arrow on top of the first.
 */
export const connectorBetween = (objects, a, b) =>
  objects.find((obj) => isConnector(obj)
    && ((obj.from === a && obj.to === b) || (obj.from === b && obj.to === a))) ?? null;

/**
 * Whether a connector has both its ends: an object can be deleted by somebody
 * else on the board while this one is drawing.
 */
export const isHanging = (connector, has) => !has(connector.from) || !has(connector.to);

/**
 * The box a connector covers, for the things that need one anyway — the format
 * bar sitting above a selection, and a picture wide enough to hold it.
 *
 * Derived, never stored: the whole point is that it is a fact about where the
 * endpoints are at this moment. Null when the geometry is, which is when there
 * is nothing on screen to be above.
 */
export function connectorBox(from, to, options) {
  const drawn = connectorGeometry(from, to, options);
  if (!drawn) return null;

  return bbox([
    { x: drawn.line.x1, y: drawn.line.y1, w: 0, h: 0 },
    { x: drawn.line.x2, y: drawn.line.y2, w: 0, h: 0 },
    ...drawn.head.map(([x, y]) => ({ x, y, w: 0, h: 0 })),
  ]);
}
