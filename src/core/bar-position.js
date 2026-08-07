/**
 * Where a floating bar sits above a selection, in viewport coordinates.
 *
 * Pure arithmetic, and in core/ so it can be tested without a browser — the
 * clamping is the fiddly part of the format bar and the part most worth
 * pinning, and a component in a .jsx file cannot be imported by `node --test`.
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
 * cards and cover them.
 */
export function barPosition(cards, viewport, stage, width = 0) {
  if (!cards.length) return null;

  const left = Math.min(...cards.map((card) => card.x));
  const right = Math.max(...cards.map((card) => card.x + card.w));
  const top = Math.min(...cards.map((card) => card.y));
  const bottom = Math.max(...cards.map((card) => card.y + card.h));

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

