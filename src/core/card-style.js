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

/**
 * Named backgrounds, kept for the boards that already use them.
 *
 * A card off the picker's palette is still written as a name: a token means
 * "whatever the stylesheet says blue is", which is the one kind of colour that
 * follows a retune and can differ between themes. A colour mixed by hand has
 * no name to write and is stored as hex, which is what `isCustomColour` below
 * is for. `none` is transparent: the card keeps its text and loses its paper.
 */
export const CARD_FILLS = ['yellow', 'blue', 'green', 'pink', 'white', 'none'];

/** Named text colours. `ink` is the default near-black the stylesheet uses. */
export const CARD_INKS = ['ink', 'muted', 'red', 'blue', 'white'];

/** No background at all — the one colour a picker cannot express. */
export const TRANSPARENT = 'none';

/**
 * A colour a card may carry, beyond the named ones.
 *
 * Hex only, and matched strictly. This value ends up in a CSS custom property,
 * and it does not come only from the person at the keyboard: a card arrives
 * over the board's channel from anyone authorised to edit it. `url(...)`,
 * `image-set(...)` and friends in a custom property are a way to make a
 * browser fetch something, so what is not plainly a colour is not passed
 * through — the same reason `cardStyle` refuses tokens it does not know.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const isCustomColour = (value) => typeof value === 'string' && HEX.test(value);

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

/** Which fields carry a colour, and so may hold a hex value as well as a token. */
const COLOUR_FIELDS = new Set(['fill', 'ink']);

export const isCardStyleValue = (field, value) =>
  (VOCABULARY[field]?.includes(value) ?? false)
  || (COLOUR_FIELDS.has(field) && isCustomColour(value));

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
 *
 * A colour field answers either a name the stylesheet knows or a hex value the
 * card carries itself. `namedColour` below is what tells a caller which it has
 * — the view needs an attribute for one and an inline property for the other,
 * and the PNG export needs the stylesheet for one and the value for the other.
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

/** Whether a resolved colour is a stylesheet name rather than the card's own. */
export const namedColour = (value) => !isCustomColour(value);
