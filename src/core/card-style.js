/**
 * How a card looks, as tokens rather than colours.
 *
 * A card stores `fill: 'blue'`, not `#b4d5ff`. The stylesheet owns what blue
 * is, which is what lets the two themes disagree about it and lets a value be
 * retuned in one place — and it is why the PNG export reads its palette out of
 * the document instead of keeping a copy that can drift.
 *
 * Every field is optional on the object. An older card, or one made before any
 * of this existed, has none of them and renders exactly as it did; the
 * defaults live here rather than being written into every card at creation, so
 * a board file stays small and "unset" stays distinguishable from "set to the
 * default".
 */

/** Backgrounds. `none` is transparent — the card keeps its text and loses its paper. */
export const CARD_FILLS = ['yellow', 'blue', 'green', 'pink', 'white', 'none'];

/** Text colours. `ink` is the default near-black the stylesheet already uses. */
export const CARD_INKS = ['ink', 'muted', 'red', 'blue', 'white'];

export const CARD_FONTS = ['sans', 'serif', 'mono'];
export const CARD_SIZES = ['sm', 'md', 'lg', 'xl'];
export const CARD_ALIGNS = ['left', 'center', 'right'];

export const CARD_STYLE_DEFAULTS = {
  fill: 'yellow',
  ink: 'ink',
  font: 'sans',
  size: 'md',
  align: 'left',
};

const VOCABULARY = {
  fill: CARD_FILLS,
  ink: CARD_INKS,
  font: CARD_FONTS,
  size: CARD_SIZES,
  align: CARD_ALIGNS,
};

/** The style fields, in the order the format bar offers them. */
export const CARD_STYLE_FIELDS = Object.keys(VOCABULARY);

export const isCardStyleValue = (field, value) => VOCABULARY[field]?.includes(value) ?? false;

/**
 * A card's style, with every field resolved.
 *
 * Unknown values fall back rather than reaching the DOM: a board can arrive
 * from another client running a version that knows a token this one does not,
 * and an attribute no stylesheet matches would render a card with no
 * background at all. Falling back shows the wrong colour; passing it through
 * shows no card.
 *
 * `color` is read as a fallback for `fill` because that is what cards were
 * called before this existed, and boards made then are still out there.
 */
export function cardStyle(obj = {}) {
  const chosen = { ...CARD_STYLE_DEFAULTS };
  const fill = obj.fill ?? obj.color;

  for (const field of CARD_STYLE_FIELDS) {
    const value = field === 'fill' ? fill : obj[field];
    if (isCardStyleValue(field, value)) chosen[field] = value;
  }

  return chosen;
}
