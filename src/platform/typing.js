/**
 * Whether a keystroke belongs to what has focus, rather than to the board.
 *
 * The board's shortcuts listen on `window`, which is the only way to hear one
 * pressed while nothing in particular has focus — the usual case on a canvas,
 * where the thing you are acting on is selected rather than focused. The cost
 * is that those listeners hear every other key on the page too, and the app's
 * own chrome is on the same page: the board title, the colour picker's hex
 * field, the format bar's selects, whatever is added next.
 *
 * Typing a board's name used to run the board's commands — `c` made a card and
 * `e` an envelope, Backspace deleted the selected cards, the arrows nudged
 * them, ctrl+Z undid the board instead of the field, and space armed the pan
 * cursor rather than being a space, which alone made a two-word board name
 * impossible to type.
 *
 * So: ask the element what it is. The listeners used to check
 * `isContentEditable`, which covers the objects on the board because those are
 * the editable the canvas knows about — and nothing else, because a list of
 * the fields we happened to remember is a list that goes stale the next time
 * one is added.
 *
 * `select` is in it for the format bar's font and size: a select takes letters
 * to jump between options, and Backspace and the arrows to move through them,
 * all of which mean something else on a board.
 *
 * A plain function of the element, not of the document, so it costs nothing to
 * test and works for any element from any window.
 */

const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export const isTyping = (el) => Boolean(el) && (Boolean(el.isContentEditable) || FIELDS.has(el.tagName));
