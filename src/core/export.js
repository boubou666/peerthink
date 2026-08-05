/**
 * What an export covers, and how big the image is.
 *
 * Separate from the drawing because none of this is about a canvas: it is the
 * content's bounding box, a margin, and the arithmetic that turns world units
 * into device pixels. The drawing needs a browser and cannot be tested without
 * one; this is the part that decides what the picture *is*, and it is decided
 * the same way whether anything ever renders it.
 */

import { bbox } from './geometry.js';

/** World units of air left around the content, so nothing touches the edge. */
export const PADDING = 24;

/**
 * Device pixels per world unit. Two, not one: an export is looked at on the
 * same screens the board is, and a 1× image of a 14px label is soft on every
 * one of them. The file is four times the size, which for a PNG someone is
 * about to paste into a document is the right trade.
 */
export const SCALE = 2;

/**
 * The most pixels a single side may have.
 *
 * The board is infinite and a canvas is not — past roughly this size browsers
 * stop allocating and hand back a blank or a null blob, which would turn a
 * large board's export into a silent failure. Shrinking is the honest answer:
 * the picture stays complete and gets less crisp, where a cap on the *area*
 * exported would quietly leave objects out of it.
 */
export const MAX_EDGE = 8192;

/**
 * The most pixels a canvas may hold in total, however its sides are arranged.
 *
 * A per-side cap is not the whole constraint: Safari before iOS 18 refuses any
 * canvas over 16,777,216 pixels, so an 8192 × 2100 board sits inside `MAX_EDGE`
 * on both sides and is still too large. Without this the export would fail on a
 * phone for a board that exports fine on a desktop — reported honestly, but
 * reported rather than delivered.
 *
 * The answer is the same one `MAX_EDGE` gives: reduce the scale, keep every
 * object.
 */
export const MAX_PIXELS = 16_777_216;

/**
 * Characters a file system will not take, plus the control range. Accents and
 * scripts other than Latin are left alone — a board called "Rétrospective"
 * should arrive as itself, not as a transliteration of itself.
 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** What the downloaded file is called. Falls back for a board with no name. */
export function fileName(title, extension = 'png') {
  const base = String(title ?? '')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Long enough for any real title, short of the limits that start to bite
    // once a browser has appended " (1)" a few times.
    .slice(0, 80)
    // A name ending in a dot is refused outright on Windows and silently
    // trimmed elsewhere, which would take the extension's separator with it.
    .replace(/\.+$/, '')
    .trim();

  return `${base || 'board'}.${extension}`;
}

/**
 * The frame for a set of objects, or null when there is nothing to draw.
 *
 * Returns the world rectangle to cover, the scale actually used — which is the
 * requested one unless the cap intervened — and the pixel dimensions that
 * follow from the two.
 */
export function exportFrame(objects, {
  padding = PADDING,
  scale = SCALE,
  maxEdge = MAX_EDGE,
  maxPixels = MAX_PIXELS,
} = {}) {
  const content = bbox(objects ?? []);
  if (!content) return null;

  const rect = {
    x: content.x - padding,
    y: content.y - padding,
    w: content.w + padding * 2,
    h: content.h + padding * 2,
  };

  // Both sides are checked against the per-side cap, and the smaller allowance
  // wins — a board that is wide and short is limited by its width alone.
  //
  // Area is the third constraint and takes a square root, because shrinking by
  // a linear factor takes the pixel count down by its square: halving the scale
  // quarters the canvas.
  const area = rect.w * scale * rect.h * scale;
  const room = Math.min(
    1,
    maxEdge / (rect.w * scale),
    maxEdge / (rect.h * scale),
    Math.sqrt(maxPixels / area),
  );
  const applied = scale * room;

  return {
    rect,
    scale: applied,
    // A rectangle narrower than one device pixel still has to be an image.
    width: Math.max(1, Math.round(rect.w * applied)),
    height: Math.max(1, Math.round(rect.h * applied)),
  };
}
