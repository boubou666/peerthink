/**
 * Where floating chrome sits, in viewport coordinates.
 *
 * Pure arithmetic, and in core/ so it can be tested without a browser — the
 * clamping is the fiddly part of both the format bar and the link popover, and
 * the part most worth pinning. A component in a .jsx file cannot be imported by
 * `node --test`, and neither can anything that reaches for a DOM rectangle.
 */

const GAP = 14;
const MIN_MARGIN = 8;

/**
 * Where the bar sits, in viewport coordinates, given what is selected.
 *
 * `x` is the bar's *centre*, because that is what the transform positions by.
 * Clamping it therefore has to allow for half the bar's own width — clamping
 * the centre alone still leaves half the controls off-screen, which is exactly
 * the failure the clamp is here to prevent. `width` is measured rather than
 * assumed, and is 0 on the first paint, when the clamp simply does less.
 *
 * `below` derives from the selection's *bottom*, not its top. Flipping the
 * transform while keeping the top would draw the bar downwards from above the
 * objects and cover them.
 */
export function barPosition(objects, viewport, stage, width = 0) {
  if (!objects.length) return null;

  const left = Math.min(...objects.map((obj) => obj.x));
  const right = Math.max(...objects.map((obj) => obj.x + obj.w));
  const top = Math.min(...objects.map((obj) => obj.y));
  const bottom = Math.max(...objects.map((obj) => obj.y + obj.h));

  const topLeft = viewport.toScreen(left, top);
  const topRight = viewport.toScreen(right, top);
  const under = viewport.toScreen(left, bottom);

  const half = width / 2;
  const lowest = MIN_MARGIN + half;
  const highest = stage.width - MIN_MARGIN - half;

  const centre = (topLeft.x + topRight.x) / 2;
  const below = topLeft.y - GAP < MIN_MARGIN;

  /**
   * A bar wider than the stage cannot satisfy both margins. Centring it is the
   * least bad answer — it clips evenly at both ends instead of pinning the
   * left margin and pushing everything else off the right, which is what a
   * plain clamp does when the bounds cross.
   */
  const x = highest < lowest ? stage.width / 2 : Math.min(Math.max(centre, lowest), highest);

  return {
    x,
    y: below ? under.y + GAP : topLeft.y - GAP,
    below,
  };
}

/**
 * Where a popover sits relative to the thing it is about.
 *
 * Below it, which is where a tooltip goes and where the pointer already is not —
 * a panel over the word being hovered hides the word and then the pointer is
 * inside it. Above only when below will not fit, measured against the whole
 * popover rather than its top edge, since the reason to flip is that the bottom
 * would be off screen.
 *
 * `x` is the popover's **left edge**, not its centre: it is anchored to the
 * start of the link rather than centred on it, because a link can be a whole
 * line wide and a panel centred on a long one drifts away from where the
 * pointer is. Clamped so it stays on screen, and centred instead when it is
 * wider than the stage, which is the same "clip evenly rather than pin one
 * edge" answer `barPosition` gives.
 *
 * `rect` is the link's box in viewport coordinates — what
 * `getBoundingClientRect` returns. `size` is 0 on the first paint, when the
 * clamp simply does less.
 */
export function popoverPosition(rect, stage, size = { width: 0, height: 0 }) {
  const room = stage.height - (rect.y + rect.h) - GAP - MIN_MARGIN;
  const below = room >= size.height;

  const lowest = MIN_MARGIN;
  const highest = stage.width - MIN_MARGIN - size.width;

  return {
    x: highest < lowest
      ? Math.round((stage.width - size.width) / 2)
      : Math.min(Math.max(rect.x, lowest), highest),
    y: below ? rect.y + rect.h + GAP : rect.y - GAP,
    below,
  };
}
