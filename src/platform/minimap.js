/**
 * The sheet, drawn small, and pressed to go somewhere.
 *
 * **A map, not a picture.** Every object is a rectangle: no text, no corners,
 * no shadows, no images. The PNG export is this app's second renderer and its
 * comment says what that costs — every change to how an object looks has to
 * land in two places or the two drift apart. A third one would be worse, and it
 * would be worse *for nothing*, because nobody reads a card at four pixels
 * tall. What a map has to answer is "what is out there, and where am I", and
 * shape and position answer both.
 *
 * Cards keep their colour, which is the one exception and earns it: a board is
 * navigated by remembering that the blue ones are over there. The colour comes
 * from the same probe the format bar's swatches do, so the stylesheet stays the
 * only place a colour is decided.
 *
 * Drawn straight from the events rather than through the scheduler. Both
 * sources — the store and the viewport — emit at most once per pointer event,
 * which is already at most once per frame, so a coalescing pass would buy a
 * frame of latency and no work saved.
 */

import { cardStyle, namedColour, TRANSPARENT } from '../core/card-style.js';
import { isPlaced } from '../core/connectors.js';
import { centredOn, mapFit, toMap, toWorld } from '../core/minimap.js';

/**
 * The smallest an object is drawn, in map pixels.
 *
 * A sheet twenty screens wide puts a card below one pixel, where a rectangle
 * rounds away to nothing and a whole cluster of work disappears from the map
 * that exists to say it is there. Two pixels is a dot, and a dot is the truth
 * at that scale.
 */
const MIN_MARK = 2;

/** Tokens the map draws with, asked of the stylesheet that decides them. */
const readTokens = (window, el) => {
  const style = window.getComputedStyle(el);
  const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    accent: token('--accent', '#3b82f6'),
    muted: token('--muted', '#71717a'),
  };
};

export function createMinimap({
  document,
  window,
  canvas,
  stage,
  store,
  board,
  viewport,
  /** The named card colours, from `shell/palette.js` — probed once per page. */
  palette = { fill: [] },
}) {
  /**
   * Read once and again when the theme changes, rather than on every draw.
   *
   * `getComputedStyle` during a pan is a style recalculation per frame, which
   * is the cost `shell/palette.js` is careful not to pay — and the answer only
   * changes when the scheme does. The card colours are the exception in the
   * other direction: they are the same in both themes, which is why the palette
   * really is probed once.
   */
  let tokens = readTokens(window, canvas);
  const fills = new Map(palette.fill.map((swatch) => [swatch.name, swatch.hex]));

  const listeners = [];
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };

  /** The size of the box, in CSS pixels — the stylesheet's to decide. */
  const size = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });

  /** What is on screen, in world coordinates. */
  const view = () => viewport.visibleRect(stage.clientWidth, stage.clientHeight);

  /**
   * The transform, held still for as long as a press lasts.
   *
   * What the map covers includes where you are looking, so panning past the
   * edge of the work makes the map zoom out — which is right, and is exactly
   * wrong while a pointer is down on it. The point under the pointer would keep
   * moving as the scale changed: press near the right edge and the camera goes
   * right, which grows the region, which puts that same pixel further right
   * again, and the board slides away for as long as the button is held.
   *
   * So a press freezes the transform it was made against, for the drawing as
   * well as for the arithmetic — the map you are dragging on is the map you
   * pressed. It settles to the new fit on release.
   */
  let held = null;

  const fitNow = () => held ?? mapFit(board.bounds(), view(), size());

  /**
   * What an object is painted, or null for one that is only outlined.
   *
   * A card with no background is drawn as an outline for the same reason it is
   * on the board: it is a card, and it is not painted. An envelope is a
   * container and holds the things drawn on top of it, so filling it would hide
   * exactly what the map is for.
   */
  const paintFor = (obj) => {
    if (obj.type !== 'card') return obj.type === 'envelope' ? null : tokens.muted;
    const fill = cardStyle(obj).fill;
    if (fill === TRANSPARENT) return null;
    return namedColour(fill) ? fills.get(fill) ?? tokens.muted : fill;
  };

  function draw() {
    const box = size();
    const ratio = window.devicePixelRatio || 1;
    if (box.w <= 0 || box.h <= 0) return;

    // The backing store is device pixels and the drawing is in CSS pixels;
    // assigning either dimension also clears the canvas, so this is both the
    // resize and the wipe.
    canvas.width = Math.round(box.w * ratio);
    canvas.height = Math.round(box.h * ratio);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const fit = fitNow();
    if (!fit) return;

    ctx.lineWidth = 1;
    for (const obj of store.all()) {
      /**
       * Objects only. A connector has no box to draw, and drawing the line
       * anyway would fill a map the size of a postage stamp with threads
       * between marks two pixels wide — what is out there and where you are,
       * which is what this answers, is a question about the things.
       */
      if (!isPlaced(obj)) continue;
      const at = toMap(obj, fit);
      const w = Math.max(at.w, MIN_MARK);
      const h = Math.max(at.h, MIN_MARK);
      const paint = paintFor(obj);

      if (paint) {
        ctx.fillStyle = paint;
        ctx.fillRect(at.x, at.y, w, h);
      } else {
        ctx.strokeStyle = tokens.muted;
        // Half a pixel, so a one-pixel line lands on a pixel rather than
        // across two of them and comes out grey.
        ctx.strokeRect(at.x + 0.5, at.y + 0.5, Math.max(w - 1, MIN_MARK), Math.max(h - 1, MIN_MARK));
      }
    }

    /**
     * Where you are, last and on top of everything, because a rectangle drawn
     * under the objects it contains is a rectangle you cannot follow.
     */
    const here = toMap(view(), fit);
    ctx.fillStyle = tokens.accent;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(here.x, here.y, here.w, here.h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = tokens.accent;
    ctx.strokeRect(here.x + 0.5, here.y + 0.5, Math.max(here.w - 1, 1), Math.max(here.h - 1, 1));
  }

  /**
   * Go to where the pointer is: that point becomes the middle of the screen.
   *
   * Pressing anywhere jumps, rather than only a press inside the rectangle
   * dragging it. Both readings of a press are common in other software, and
   * this one is the one that always does something — a rectangle can be smaller
   * than the pointer at a zoom where the map is most useful.
   */
  const goTo = (event) => {
    const fit = fitNow();
    if (!fit) return;

    const box = canvas.getBoundingClientRect();
    const world = toWorld({ x: event.clientX - box.left, y: event.clientY - box.top }, fit);
    const at = centredOn(world, view());
    viewport.moveTo(at.x, at.y);
  };

  function onPointerDown(event) {
    if (event.button !== 0) return;
    // The board's own gestures listen on the stage and on the window; this is
    // neither a marquee nor a pan of the canvas, and the press must not also
    // land as one.
    event.preventDefault();
    event.stopPropagation();

    canvas.setPointerCapture?.(event.pointerId);
    held = mapFit(board.bounds(), view(), size());
    goTo(event);
  }

  /**
   * Only while a press *this map started* is still down.
   *
   * `buttons` alone says a button is down somewhere, which is also true of a
   * card being dragged across the board — and nothing captures that pointer, so
   * those moves arrive here the moment it passes over the panel. Whoever is
   * dragging a card past the corner did not ask to be taken somewhere else.
   * `held` is set by our own `pointerdown` and by nothing else, so it is the
   * question worth asking; `buttons` then covers the release we did not see.
   */
  const onPointerMove = (event) => {
    if (held && event.buttons & 1) goTo(event);
  };

  /**
   * On the window rather than the canvas: a press that ends anywhere ends the
   * gesture, and the map is drawn again now that it is free to rescale.
   */
  const onPointerUp = () => {
    if (!held) return;
    held = null;
    draw();
  };

  listen(canvas, 'pointerdown', onPointerDown);
  listen(canvas, 'pointermove', onPointerMove);
  listen(window, 'pointerup', onPointerUp);
  listen(window, 'pointercancel', onPointerUp);

  listeners.push(store.on(draw), viewport.on(draw));
  // The stage's size is half of what the view rectangle means, and nothing
  // publishes it.
  listen(window, 'resize', draw);

  // The theme is the operating system's here — there is no switch in the app —
  // so it can change under a page that is already open, and a canvas holds what
  // it was painted rather than what a token now says.
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (scheme) {
    const onScheme = () => {
      tokens = readTokens(window, canvas);
      draw();
    };
    scheme.addEventListener('change', onScheme);
    listeners.push(() => scheme.removeEventListener('change', onScheme));
  }

  draw();

  return {
    draw,
    destroy() {
      for (const off of listeners) off();
      listeners.length = 0;
    },
  };
}
