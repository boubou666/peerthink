/**
 * Whether an object's corners are rounded, as a token.
 *
 * Every object on the board has been drawn with the same 8px radius since there
 * was a board — which is a choice, and one nobody could disagree with. A
 * diagram of boxes and a wireframe of panels want square corners; sticky notes
 * want round ones. So it becomes a property of the object rather than of the
 * stylesheet.
 *
 * A token, not a number, for the reason `card-style.js` gives for colours: the
 * radius itself belongs to `canvas.css`, which is where it can be retuned once
 * and where the PNG export reads it back from. A card carrying `corners: 8`
 * would be a card that has to be found and rewritten the day the radius
 * changes, and a card carrying `corners: 400` is a card nobody meant to make.
 *
 * Kept apart from `card-style.js` deliberately. That file is what a *card*
 * looks like — fill, ink, font, size, alignment — and none of it means anything
 * for an envelope. This applies to every object with an edge, so it lives on
 * its own and the format bar can offer it to a selection with no cards in it.
 */

/** `round` is what every object has always been; `square` is the new one. */
export const CORNERS = ['round', 'square'];

/**
 * The value an object with no `corners` field renders as — which is every
 * object made before this existed. The default lives here rather than being
 * written into each object at creation, so a board file stays small and boards
 * already out there keep the look they were drawn with.
 */
export const DEFAULT_CORNERS = 'round';

/**
 * The types this applies to.
 *
 * Named rather than "anything on the board", because the attribute is what a
 * stylesheet rule matches: a type from a newer client would take an attribute
 * no rule here answers for, and — more to the point — the format bar would
 * offer a control for something it cannot draw.
 */
export const CORNERED_TYPES = ['card', 'envelope', 'list', 'image'];

export const hasCorners = (obj) => CORNERED_TYPES.includes(obj?.type);

/**
 * An object's corner style, resolved.
 *
 * Unknown values fall back rather than reaching the DOM — the same rule
 * `cardStyle` follows, and for the same reason: a board can arrive from a
 * client that knows a token this one does not.
 */
export const cornersOf = (obj) => (CORNERS.includes(obj?.corners) ? obj.corners : DEFAULT_CORNERS);
