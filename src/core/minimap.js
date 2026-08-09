/**
 * The whole sheet in a small box: what it has to cover, and how the two
 * coordinate spaces line up.
 *
 * A minimap is one transform and its inverse. Drawing it needs world → map, so
 * every object lands somewhere in the box; navigating with it needs map →
 * world, because a press on the box is a place on the sheet. Both are here,
 * pure, for the reason `bar-position.js` is: the arithmetic is the part with
 * the judgement in it, and a `<canvas>` is not needed to have an opinion about
 * where a rectangle goes.
 */

import { bbox } from './geometry.js';

/** Map pixels kept clear around everything, so an edge object is not cut off. */
const PADDING = 6;

/**
 * The world rectangle a map has to cover: everything on the sheet, and the part
 * of it being looked at.
 *
 * The view is in it deliberately. A map of the objects alone would push the
 * view rectangle off its own edge the moment somebody panned away from their
 * work — and a rectangle you cannot see is a rectangle that cannot tell you
 * where you are. Including it means the map zooms out to hold both, which is
 * the honest picture: this is where your things are, and this is where you are.
 *
 * `bbox` of the two, because a bounding box of rectangles *is* their union, and
 * a sheet with nothing on it has only the view to show.
 */
export const covered = (content, view) => bbox([content, view].filter(Boolean));

/**
 * How world coordinates sit inside a box of `size` map pixels: `scale`, and the
 * offset that centres what is covered.
 *
 * `map = world * scale + offset`, one uniform scale for both axes so nothing is
 * stretched — a squashed map is a map that lies about shape, which is most of
 * what anyone reads one for. What is left over goes half to each side, so the
 * covered region sits in the middle of the box rather than in a corner.
 *
 * Null when there is nothing to cover or nowhere to draw it: a box that has not
 * been laid out yet has no size, and there is no scale that means anything for
 * it.
 */
export function mapFit(content, view, size, padding = PADDING) {
  const region = covered(content, view);
  if (!region || region.w <= 0 || region.h <= 0) return null;

  const width = size.w - padding * 2;
  const height = size.h - padding * 2;
  if (width <= 0 || height <= 0) return null;

  const scale = Math.min(width / region.w, height / region.h);

  return {
    scale,
    x: (size.w - region.w * scale) / 2 - region.x * scale,
    y: (size.h - region.h * scale) / 2 - region.y * scale,
    region,
  };
}

/** A world rectangle, in map pixels. */
export const toMap = (rect, fit) => ({
  x: rect.x * fit.scale + fit.x,
  y: rect.y * fit.scale + fit.y,
  w: rect.w * fit.scale,
  h: rect.h * fit.scale,
});

/** A point in the box, on the sheet. The inverse, and the whole of navigation. */
export const toWorld = (point, fit) => ({
  x: (point.x - fit.x) / fit.scale,
  y: (point.y - fit.y) / fit.scale,
});
