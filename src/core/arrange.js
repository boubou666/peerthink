/**
 * Lining objects up, and spacing them evenly.
 *
 * Two things a canvas asks for constantly and a pointer is bad at: six cards
 * dropped roughly in a row are roughly in a row, and no amount of dragging with
 * snapping on makes them exactly one. Snapping aligns a card to *one* other
 * card as it moves; this is about a set of them at once, which is a different
 * question and has an exact answer.
 *
 * Answers in deltas rather than in positions, and that is deliberate: an
 * envelope carries what it holds, so what the board does with "this one moves
 * 40 to the left" is not what it would do with "this one is now at x=120". The
 * caller applies them, and knows about containment; this file knows about
 * rectangles.
 *
 * Pure, in core, and rounded to whole units — the same rounding a drag, a
 * resize and a paste already do, so a card that has been centred is at a
 * coordinate somebody could have dragged it to.
 */

import { bbox } from './geometry.js';

/** The six edges and middles a set of objects can be lined up on. */
export const EDGES = ['left', 'center', 'right', 'top', 'middle', 'bottom'];

/** `center` rather than `centre`, to match the text alignment already stored. */
export const AXES = ['horizontal', 'vertical'];

/** Which way each edge measures, and where in the box it sits. */
const ALONG = {
  left: 'x', center: 'x', right: 'x',
  top: 'y', middle: 'y', bottom: 'y',
};

const SIZE = { x: 'w', y: 'h' };

const AXIS_OF = { horizontal: 'x', vertical: 'y' };

/**
 * How far each object has to move to line up on `edge`.
 *
 * Against the bounding box of the set rather than against one chosen object.
 * "Align left" then means the left edge of everything selected — which is the
 * left edge of whichever object is furthest left, so the thing that does not
 * move is the one already in the right place, and nobody has to be told which
 * object was the reference.
 *
 * Fewer than two objects is nothing to line up: one object is already aligned
 * with itself, and moving it somewhere would be an answer to a question nobody
 * asked.
 */
export function alignment(objects, edge) {
  const axis = ALONG[edge];
  if (!axis || objects.length < 2) return [];

  const size = SIZE[axis];
  const box = bbox(objects);

  const target = (obj) => {
    if (edge === 'left' || edge === 'top') return box[axis];
    if (edge === 'right' || edge === 'bottom') return box[axis] + box[size] - obj[size];
    return box[axis] + box[size] / 2 - obj[size] / 2;
  };

  return objects.map((obj) => ({
    id: obj.id,
    dx: axis === 'x' ? Math.round(target(obj) - obj.x) : 0,
    dy: axis === 'y' ? Math.round(target(obj) - obj.y) : 0,
  }));
}

/**
 * How far each object has to move for the *gaps* between them to be equal.
 *
 * Equal gaps rather than equal centres, because the objects on a board are not
 * the same size: three cards and a wide envelope spaced by their centres look
 * wrong in exactly the way somebody reaching for this is trying to fix.
 *
 * The two on the ends stay where they are, so the set keeps the width somebody
 * gave it — spacing is about what is between them. Fewer than three is nothing
 * to space: with two, the gap between them is whatever it is, and there is no
 * second gap for it to be equal to.
 *
 * Objects that overlap give a negative gap, and it is applied rather than
 * refused: what comes back is an even overlap, which is what "space these
 * evenly" means for a stack of cards and is one undo away either way.
 */
export function spacing(objects, direction) {
  const axis = AXIS_OF[direction];
  if (!axis || objects.length < 3) return [];

  const size = SIZE[axis];
  const inOrder = [...objects].sort((a, b) => a[axis] - b[axis]);

  const first = inOrder[0];
  const last = inOrder[inOrder.length - 1];
  const span = last[axis] + last[size] - first[axis];
  const filled = inOrder.reduce((total, obj) => total + obj[size], 0);
  const gap = (span - filled) / (inOrder.length - 1);

  const moves = new Map();
  let at = first[axis];
  for (const obj of inOrder) {
    const shift = Math.round(at - obj[axis]);
    moves.set(obj.id, { id: obj.id, dx: axis === 'x' ? shift : 0, dy: axis === 'y' ? shift : 0 });
    at += obj[size] + gap;
  }

  // In the order they arrived, so a caller can pair them with what it sent.
  return objects.map((obj) => moves.get(obj.id));
}
