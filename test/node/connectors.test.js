// The arrows between two objects: where they run, and what carries them.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../../src/core/board.js';
import {
  CONNECTOR,
  borderPoint,
  connectorBetween,
  connectorBox,
  connectorGeometry,
  connectorsTouching,
  isConnector,
  isPlaced,
  labelPoint,
} from '../../src/core/connectors.js';
import { createSequentialIds } from '../../src/core/ids.js';
import { Selection } from '../../src/core/selection.js';
import { Store } from '../../src/core/store.js';

const BOX = { x: 0, y: 0, w: 100, h: 100 };

describe('where a connector meets a box', () => {
  test('leaves through the side it is pointing at', () => {
    assert.deepEqual(borderPoint(BOX, { x: 500, y: 50 }), { x: 100, y: 50 }, 'right');
    assert.deepEqual(borderPoint(BOX, { x: -500, y: 50 }), { x: 0, y: 50 }, 'left');
    assert.deepEqual(borderPoint(BOX, { x: 50, y: -500 }), { x: 50, y: 0 }, 'top');
    assert.deepEqual(borderPoint(BOX, { x: 50, y: 500 }), { x: 50, y: 100 }, 'bottom');
  });

  /** The nearer pair of sides is the one the line gets to first. */
  test('a diagonal leaves through whichever pair is nearer', () => {
    const wide = { x: 0, y: 0, w: 400, h: 100 };
    const at = borderPoint(wide, { x: 300, y: 900 });
    assert.equal(at.y, 100, 'through the bottom of a wide box, not its side');
  });

  test('a point on the middle has no direction to leave in', () => {
    assert.equal(borderPoint(BOX, { x: 50, y: 50 }), null);
  });
});

describe('the line and the head', () => {
  const FAR = { x: 300, y: 0, w: 100, h: 100 };

  test('start at one border and point at the other, a gap short of it', () => {
    const drawn = connectorGeometry(BOX, FAR, { gap: 5, head: 15, spread: 9 });

    assert.deepEqual(drawn.line, { x1: 105, y1: 50, x2: 280, y2: 50 });
    assert.deepEqual(drawn.head, [[295, 50], [280, 59], [280, 41]]);
  });

  test('the head points where the line goes, whichever way that is', () => {
    const above = connectorGeometry(BOX, { x: 0, y: -300, w: 100, h: 100 }, { gap: 5, head: 15 });
    const [[tipX, tipY]] = above.head;

    assert.ok(tipY < above.line.y2, `the point is beyond the line: ${JSON.stringify(above)}`);
    assert.equal(tipX, 50, 'straight up');
  });

  /**
   * Overlapping boxes have their far borders in the wrong order, which is not a
   * short line — it is a line running backwards. Measuring along the direction
   * the two lie in is what tells them apart.
   */
  test('there is nothing to draw between objects that overlap', () => {
    assert.equal(connectorGeometry(BOX, { x: 50, y: 0, w: 100, h: 100 }), null, 'overlapping');
    assert.equal(connectorGeometry(BOX, { x: 20, y: 20, w: 20, h: 20 }), null, 'one inside the other');
    assert.equal(connectorGeometry(BOX, BOX), null, 'the same box twice');
    assert.equal(connectorGeometry(BOX, { x: 101, y: 0, w: 100, h: 100 }), null, 'a hair apart');
  });

  test('a label sits in the middle of the line, not of the two objects', () => {
    const wide = { x: 0, y: 0, w: 400, h: 100 };
    const small = { x: 800, y: 25, w: 50, h: 50 };
    const drawn = connectorGeometry(wide, small, { gap: 5, head: 15 });

    const at = labelPoint(drawn);
    assert.equal(at.x, (drawn.line.x1 + drawn.line.x2) / 2);
    assert.equal(at.y, (drawn.line.y1 + drawn.line.y2) / 2);
    assert.ok(at.x > 400 && at.x < 800, `between the two of them: ${at.x}`);
  });

  test('and the box it covers is the line and the head together', () => {
    const box = connectorBox(BOX, FAR, { gap: 5, head: 15, spread: 9 });
    assert.deepEqual(box, { x: 105, y: 41, w: 190, h: 18 });
    assert.equal(connectorBox(BOX, BOX), null);
  });
});

describe('what a connector is', () => {
  const arrow = { id: 'c', type: CONNECTOR, from: 'a', to: 'b' };

  test('a type, and the one object with no box', () => {
    assert.equal(isConnector(arrow), true);
    assert.equal(isConnector({ type: 'card' }), false);
    assert.equal(isPlaced(arrow), false);
    assert.equal(isPlaced({ type: 'card' }), true);
    assert.equal(isPlaced(null), false);
  });

  test('touching an id, from either end', () => {
    const all = [arrow, { id: 'd', type: CONNECTOR, from: 'x', to: 'y' }];
    assert.deepEqual(connectorsTouching(all, ['a']).map((o) => o.id), ['c']);
    assert.deepEqual(connectorsTouching(all, ['b']).map((o) => o.id), ['c']);
    assert.deepEqual(connectorsTouching(all, ['z']), []);
  });

  test('between two objects, whichever way round it was drawn', () => {
    assert.equal(connectorBetween([arrow], 'a', 'b'), arrow);
    assert.equal(connectorBetween([arrow], 'b', 'a'), arrow, 'the other way round is the same pair');
    assert.equal(connectorBetween([arrow], 'a', 'z'), null);
  });
});

describe('a board with connectors on it', () => {
  let store;
  let selection;
  let board;

  beforeEach(() => {
    store = new Store();
    selection = new Selection();
    board = new Board({ store, selection, newId: createSequentialIds() });
  });

  const two = () => [
    board.add('card', { x: 0, y: 0 }),
    board.add('card', { x: 600, y: 0 }),
  ];

  test('connect joins two objects, pointing from the first', () => {
    const [a, b] = two();
    const joined = board.connect(a.id, b.id);

    assert.equal(joined.type, CONNECTOR);
    assert.deepEqual([joined.from, joined.to], [a.id, b.id]);
    assert.equal(store.get(joined.id).from, a.id, 'and it is in the document');
  });

  test('and leaves the selection where it was, so the control stays put', () => {
    const [a, b] = two();
    selection.set([a.id, b.id]);
    board.connect(a.id, b.id);

    assert.deepEqual(selection.list(), [a.id, b.id]);
  });

  test('what it refuses', () => {
    const [a, b] = two();
    assert.equal(board.connect(a.id, a.id), null, 'an object to itself');
    assert.equal(board.connect(a.id, 'nobody'), null, 'something that is not there');

    board.connect(a.id, b.id);
    assert.equal(board.connect(a.id, b.id), null, 'a second one between the same pair');
    assert.equal(board.connect(b.id, a.id), null, 'or the same pair the other way round');
  });

  test('a connector cannot be joined to anything', () => {
    const [a, b] = two();
    const joined = board.connect(a.id, b.id);
    assert.equal(board.connect(a.id, joined.id), null);
  });

  test('disconnect takes it away, from either side', () => {
    const [a, b] = two();
    board.connect(a.id, b.id);

    assert.equal(board.disconnect(b.id, a.id), true);
    assert.equal(store.all().filter(isConnector).length, 0);
    assert.equal(board.disconnect(a.id, b.id), false, 'and says so when there was none');
  });

  test('deleting an object takes its connectors with it, in one step', () => {
    const [a, b] = two();
    board.connect(a.id, b.id);

    selection.set([a.id]);
    board.deleteSelected();
    assert.deepEqual(store.all().map((o) => o.id), [b.id]);

    store.undo();
    assert.equal(store.all().length, 3, 'one undo puts the card and the arrow back');
  });

  test('a connector can be deleted on its own, and nothing goes with it', () => {
    const [a, b] = two();
    const joined = board.connect(a.id, b.id);

    selection.set([joined.id]);
    board.deleteSelected();
    assert.deepEqual(store.all().map((o) => o.id), [a.id, b.id]);
  });

  test('duplicating a pair duplicates what joins them', () => {
    const [a, b] = two();
    board.connect(a.id, b.id);

    selection.set([a.id, b.id]);
    const made = board.duplicate();
    const copied = made.find(isConnector);

    assert.ok(copied, 'the arrow was copied');
    assert.deepEqual(
      [copied.from, copied.to],
      made.filter(isPlaced).map((o) => o.id),
      'and points at the copies rather than at the originals',
    );
  });

  test('duplicating one end of one does not', () => {
    const [a, b] = two();
    board.connect(a.id, b.id);

    selection.set([a.id]);
    assert.equal(board.duplicate().some(isConnector), false);
  });

  test('a selection of nothing but connectors has nothing to duplicate', () => {
    const [a, b] = two();
    const joined = board.connect(a.id, b.id);
    selection.set([joined.id]);

    assert.deepEqual(board.duplicate(), []);
  });

  test('copying two joined objects copies the join, selected or not', () => {
    const [a, b] = two();
    board.connect(a.id, b.id);

    selection.set([a.id, b.id]);
    assert.equal(board.copyable().filter(isConnector).length, 1);

    selection.set([a.id]);
    assert.equal(board.copyable().filter(isConnector).length, 0, 'one end is not a join');
  });

  test('and a connector selected without its ends is left behind', () => {
    const [a, b] = two();
    const joined = board.connect(a.id, b.id);

    selection.set([joined.id, a.id]);
    assert.equal(board.copyable().filter(isConnector).length, 0);
  });

  test('pasting points the copies at each other', () => {
    const [a, b] = two();
    const original = board.connect(a.id, b.id);
    selection.set([a.id, b.id]);

    const payload = board.copyable();
    const placed = board.paste(payload, { x: 1000, y: 1000 });
    const copied = placed.find(isConnector);

    const ids = placed.filter(isPlaced).map((o) => o.id);
    assert.deepEqual([copied.from, copied.to], ids);

    // Every id in the payload is replaced, the arrow's own included: two
    // objects sharing an id is a document where an op means two things.
    assert.notEqual(copied.id, original.id, 'the copy is its own object');
    assert.ok(!ids.includes(a.id) && !ids.includes(b.id), 'and so are the cards it joins');
  });

  test('a payload of connectors alone pastes nothing', () => {
    const [a, b] = two();
    board.connect(a.id, b.id);
    const arrows = store.all().filter(isConnector);

    assert.deepEqual(board.paste(arrows, { x: 0, y: 0 }), []);
  });

  test('a connector whose ends did not come is dropped', () => {
    const [a, b] = two();
    board.connect(a.id, b.id);
    selection.set([a.id, b.id]);
    const payload = board.copyable();

    // One card and the arrow that needed two of them.
    const half = payload.filter((obj) => obj.id !== b.id);
    assert.equal(board.paste(half, { x: 0, y: 0 }).some(isConnector), false);
  });

  describe('the geometry it stays out of', () => {
    test('bounds are the boxes, and a connector has none', () => {
      const [a, b] = two();
      board.connect(a.id, b.id);

      assert.deepEqual(board.bounds(), { x: 0, y: 0, w: 800, h: 120 });
    });

    test('nothing snaps to it', () => {
      const [a, b] = two();
      board.connect(a.id, b.id);

      const targets = board.snapTargets(new Set([a.id, b.id]));
      assert.deepEqual(targets, { xs: [], ys: [] });
    });

    test('and it cannot be moved, only followed', () => {
      const [a, b] = two();
      const joined = board.connect(a.id, b.id);

      selection.set([a.id, joined.id]);
      board.nudgeSelection(10, 0);

      assert.equal(store.get(a.id).x, 10);
      assert.equal(store.get(joined.id).x, undefined, 'it was never given a coordinate');
      assert.deepEqual(board.movable([a.id, joined.id]), [a.id]);
    });

    test('a marquee takes the arrows between what it caught', () => {
      const [a, b] = two();
      const joined = board.connect(a.id, b.id);

      const all = board.idsIntersecting({ x: -50, y: -50, w: 1000, h: 500 });
      assert.ok(all.includes(joined.id), 'both ends are inside it');

      const half = board.idsIntersecting({ x: -50, y: -50, w: 300, h: 500 });
      assert.deepEqual(half, [a.id], 'and one end is not enough');
    });
  });
});
