// Lining objects up, and spacing them evenly.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { alignment, spacing } from '../../src/core/arrange.js';
import { Board } from '../../src/core/board.js';
import { CONNECTOR } from '../../src/core/connectors.js';
import { createSequentialIds } from '../../src/core/ids.js';
import { Selection } from '../../src/core/selection.js';
import { Store } from '../../src/core/store.js';

const box = (id, x, y, w = 100, h = 50) => ({ id, type: 'card', x, y, w, h });

/** Three boxes of different sizes, roughly in a row and roughly down a slope. */
const three = () => [box('a', 0, 0), box('b', 200, 40, 60, 80), box('c', 500, 90)];

describe('lining up', () => {
  test('on the outside edges of everything selected', () => {
    assert.deepEqual(alignment(three(), 'left').map((move) => move.dx), [0, -200, -500]);
    assert.deepEqual(alignment(three(), 'right').map((move) => move.dx), [500, 340, 0]);
    assert.deepEqual(alignment(three(), 'top').map((move) => move.dy), [0, -40, -90]);
    assert.deepEqual(alignment(three(), 'bottom').map((move) => move.dy), [90, 20, 0]);
  });

  /**
   * Against the bounding box rather than against one chosen object, so the one
   * that does not move is the one already in the right place and nobody has to
   * be told which was the reference.
   */
  test('and on the middle of the box they make', () => {
    // The box is 600 across and 140 down, so the middles are at 300 and 70.
    assert.deepEqual(alignment(three(), 'center').map((move) => move.dx), [250, 70, -250]);
    assert.deepEqual(alignment(three(), 'middle').map((move) => move.dy), [45, -10, -45]);
  });

  test('only across the axis it is about', () => {
    assert.deepEqual(alignment(three(), 'left').map((move) => move.dy), [0, 0, 0]);
    assert.deepEqual(alignment(three(), 'top').map((move) => move.dx), [0, 0, 0]);
  });

  /**
   * Whole units, like every other move on this board — and *rounded* rather
   * than cut off, which is the difference this case is chosen to show: the box
   * is 101 across, so its middle is at 50.5 and the second card has half a unit
   * to travel.
   */
  test('to whole units, like every other move on this board', () => {
    const odd = [box('a', 0, 0, 101, 50), box('b', 40, 0, 20, 50)];
    assert.deepEqual(alignment(odd, 'center').map((move) => move.dx), [0, 1]);
  });

  test('and not at all when there is nothing to line up against', () => {
    assert.deepEqual(alignment([box('a', 0, 0)], 'left'), [], 'one object is aligned with itself');
    assert.deepEqual(alignment([], 'left'), []);
    assert.deepEqual(alignment(three(), 'sideways'), [], 'an edge this does not have');
  });
});

describe('spacing evenly', () => {
  test('makes the gaps equal and leaves the ends where they are', () => {
    const moves = spacing(three(), 'horizontal');

    assert.deepEqual(moves.map((move) => move.dx), [0, 70, 0]);

    // 600 across, 260 of it filled: two gaps of 170.
    const placed = three().map((obj, at) => ({ ...obj, x: obj.x + moves[at].dx }));
    assert.equal(placed[1].x - (placed[0].x + placed[0].w), 170);
    assert.equal(placed[2].x - (placed[1].x + placed[1].w), 170);
  });

  test('down the page as well as across it', () => {
    const column = [box('a', 0, 0), box('b', 0, 60), box('c', 0, 400)];
    const moves = spacing(column, 'vertical');

    // 450 down, 150 of it filled: two gaps of 150, so the middle one starts at 200.
    assert.deepEqual(moves.map((move) => move.dy), [0, 140, 0]);
    assert.deepEqual(moves.map((move) => move.dx), [0, 0, 0]);
  });

  /** Whatever order they were selected in, the arrangement is by position. */
  test('by where they are, not by the order they arrived in', () => {
    const shuffled = [box('c', 500, 0), box('a', 0, 0), box('b', 200, 0, 60)];
    const moves = spacing(shuffled, 'horizontal');

    assert.deepEqual(moves.map((move) => move.id), ['c', 'a', 'b'], 'answered in the order it was asked');
    assert.equal(moves.find((move) => move.id === 'a').dx, 0, 'the first stays');
    assert.equal(moves.find((move) => move.id === 'c').dx, 0, 'and so does the last');
  });

  /**
   * A stack of overlapping cards has a negative gap, and evening it out is what
   * "space these" means for them — it is one undo away either way.
   */
  test('an overlap is spread evenly rather than refused', () => {
    const stack = [box('a', 0, 0), box('b', 90, 0), box('c', 20, 0)];
    const moves = spacing(stack, 'horizontal');

    const placed = stack
      .map((obj, at) => ({ ...obj, x: obj.x + moves[at].dx }))
      .sort((one, two) => one.x - two.x);

    const gaps = [
      placed[1].x - (placed[0].x + placed[0].w),
      placed[2].x - (placed[1].x + placed[1].w),
    ];
    assert.ok(gaps[0] < 0, `they still overlap: ${gaps}`);
    assert.equal(gaps[0], gaps[1], 'and overlap each other equally');
  });

  test('and nothing to do without a second gap to be equal to', () => {
    assert.deepEqual(spacing(three().slice(0, 2), 'horizontal'), []);
    assert.deepEqual(spacing(three(), 'sideways'), []);
  });
});

describe('a board arranging its selection', () => {
  let store;
  let selection;
  let board;

  beforeEach(() => {
    store = new Store();
    selection = new Selection();
    board = new Board({ store, selection, newId: createSequentialIds() });
  });

  const cards = (...at) => at.map(([x, y]) => board.add('card', { x, y, w: 100, h: 50 }));

  test('lines up what is selected, in one change', () => {
    const [a, b] = cards([0, 0], [300, 0]);
    selection.set([a.id, b.id]);

    assert.equal(board.alignSelection('left'), true);
    assert.equal(store.get(b.id).x, 0);

    store.undo();
    assert.equal(store.get(b.id).x, 300, 'one undo puts them back');
  });

  test('and says no when there is nothing to arrange', () => {
    const [a] = cards([0, 0]);
    selection.set([a.id]);

    assert.equal(board.alignSelection('left'), false);
    assert.equal(board.spaceSelection('horizontal'), false);
  });

  test('a selection already lined up is not a change', () => {
    const [a, b] = cards([0, 0], [0, 200]);
    selection.set([a.id, b.id]);

    assert.equal(board.alignSelection('left'), false, 'nothing moved, so nothing was recorded');
    assert.deepEqual([store.get(a.id).x, store.get(b.id).x], [0, 0]);
  });

  /** An arrow has no box to line up, and follows its ends without being told. */
  test('the arrows in a selection are left out of it', () => {
    const [a, b] = cards([0, 0], [300, 0]);
    const arrow = board.connect(a.id, b.id);
    selection.set([a.id, b.id, arrow.id]);

    assert.equal(board.alignSelection('left'), true);
    assert.equal(store.get(arrow.id).x, undefined);
    assert.equal(store.get(b.id).x, 0);
  });

  test('an envelope carries what it holds, the way dragging one does', () => {
    const envelope = board.add('envelope', { x: 400, y: 0, w: 300, h: 200 });
    const inside = board.add('card', { x: 450, y: 50, w: 100, h: 50 });
    const [other] = cards([0, 0]);

    selection.set([other.id, envelope.id]);
    assert.equal(board.alignSelection('left'), true);

    assert.equal(store.get(envelope.id).x, 0, 'the envelope moved');
    assert.equal(store.get(inside.id).x, 50, 'and what it holds moved with it');
  });

  /**
   * An object selected *and* inside a selected envelope was asked to go
   * somewhere itself, which is more specific than what the envelope round it
   * was asked to do.
   */
  test('an object with a delta of its own keeps it', () => {
    const envelope = board.add('envelope', { x: 400, y: 0, w: 300, h: 200 });
    const inside = board.add('card', { x: 450, y: 50, w: 100, h: 50 });

    selection.set([envelope.id, inside.id]);
    assert.equal(board.alignSelection('left'), true);

    assert.equal(store.get(envelope.id).x, 400, 'the envelope is already leftmost');
    assert.equal(store.get(inside.id).x, 400, 'and the card lines up with it rather than following it');
  });
});
