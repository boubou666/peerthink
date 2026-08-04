import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Board, CARD_COLORS, OBJECT_DEFAULTS } from '../../src/core/board.js';
import { Store } from '../../src/core/store.js';
import { Selection } from '../../src/core/selection.js';
import { createSequentialIds } from '../../src/core/ids.js';

describe('Board', () => {
  let store;
  let selection;
  let board;

  beforeEach(() => {
    store = new Store();
    selection = new Selection();
    board = new Board({ store, selection, newId: createSequentialIds() });
  });

  const at = (type, props) => board.add(type, props);

  describe('make', () => {
    test('applies the defaults for each type', () => {
      assert.deepEqual(board.make('card'), { id: 'p1', type: 'card', x: 0, y: 0, ...OBJECT_DEFAULTS.card() });
      assert.deepEqual(board.make('envelope').title, 'Envelope');
      assert.deepEqual(board.make('list').items, []);
    });

    test('props override defaults', () => {
      const card = board.make('card', { x: 5, color: 'blue' });
      assert.equal(card.x, 5);
      assert.equal(card.color, 'blue');
    });

    test('rejects an unknown type rather than making a broken object', () => {
      assert.throws(() => board.make('widget'), /unknown object type: widget/);
    });
  });

  describe('add', () => {
    test('inserts, selects, and returns the object', () => {
      const card = at('card', { x: 10, y: 20 });
      assert.deepEqual(store.order, [card.id]);
      assert.deepEqual(selection.list(), [card.id]);
      assert.equal(store.get(card.id).x, 10);
    });

    test('cards cycle through the palette and then wrap', () => {
      const colors = Array.from({ length: CARD_COLORS.length + 1 }, () => at('card').color);
      assert.deepEqual(colors.slice(0, CARD_COLORS.length), CARD_COLORS);
      assert.equal(colors.at(-1), CARD_COLORS[0]);
    });

    test('an explicit colour does not consume a palette slot', () => {
      at('card', { color: 'pink' });
      assert.equal(at('card').color, CARD_COLORS[0]);
    });

    test('lists start with one empty row unless given items', () => {
      assert.equal(at('list').items.length, 1);
      assert.equal(at('list', { items: [] }).items.length, 0);
    });

    test('envelopes drop to the back so objects land on top of them', () => {
      const card = at('card');
      const envelope = at('envelope');
      assert.deepEqual(store.order, [envelope.id, card.id]);
    });

    test('addCenteredOn positions by centre, not corner', () => {
      const card = board.addCenteredOn('card', { x: 500, y: 400 });
      assert.deepEqual({ x: card.x, y: card.y }, { x: 400, y: 340 });

      const wide = board.addCenteredOn('card', { x: 0, y: 0 }, { w: 100, h: 50 });
      assert.deepEqual({ x: wide.x, y: wide.y, w: wide.w }, { x: -50, y: -25, w: 100 });
    });
  });

  describe('duplicate', () => {
    test('copies the selection with an offset and selects the copies', () => {
      const card = at('card', { x: 100, y: 100, text: 'original' });
      const [clone] = board.duplicate();

      assert.notEqual(clone.id, card.id);
      assert.deepEqual({ x: clone.x, y: clone.y, text: clone.text }, { x: 124, y: 124, text: 'original' });
      assert.deepEqual(selection.list(), [clone.id]);
      assert.equal(store.order.length, 2);
    });

    test('takes a custom offset', () => {
      at('card', { x: 0, y: 0 });
      assert.equal(board.duplicate(5)[0].x, 5);
    });

    test('deep-copies nested data', () => {
      const list = at('list', { items: [{ id: 'i1', text: 'a', done: false }] });
      const [clone] = board.duplicate();
      store.apply([{ t: 'set', id: clone.id, patch: { items: [{ id: 'i1', text: 'changed', done: false }] } }]);
      assert.equal(store.get(list.id).items[0].text, 'a');
    });

    test('does nothing with an empty selection', () => {
      assert.deepEqual(board.duplicate(), []);
      assert.equal(store.order.length, 0);
    });
  });

  describe('deleteSelected', () => {
    test('removes the selection and clears it', () => {
      const card = at('card');
      assert.equal(board.deleteSelected(), true);
      assert.equal(store.get(card.id), undefined);
      assert.equal(selection.size, 0);
    });

    test('an envelope\'s contents survive it', () => {
      const inside = at('card', { x: 150, y: 150, w: 100, h: 80 });
      const envelope = at('envelope', { x: 100, y: 100, w: 400, h: 300 });
      selection.set([envelope.id]);

      board.deleteSelected();
      assert.equal(store.get(envelope.id), undefined);
      assert.ok(store.has(inside.id));
    });

    test('reports that it did nothing when the selection is empty', () => {
      selection.clear();
      assert.equal(board.deleteSelected(), false);
    });
  });

  describe('moving', () => {
    test('moveBy shifts every id given', () => {
      const a = at('card', { x: 0, y: 0 });
      const b = at('card', { x: 100, y: 100 });
      board.moveBy([a.id, b.id], 10, -5);
      assert.deepEqual([store.get(a.id).x, store.get(b.id).y], [10, 95]);
    });

    test('moveBy ignores a zero delta or an empty list', () => {
      const a = at('card', { x: 0, y: 0 });
      store.past.length = 0;
      board.moveBy([a.id], 0, 0);
      board.moveBy([], 5, 5);
      assert.equal(store.past.length, 0);
    });

    test('nudgeSelection carries an envelope\'s contents', () => {
      const inside = at('card', { x: 150, y: 150, w: 100, h: 80 });
      const outside = at('card', { x: 900, y: 900, w: 100, h: 80 });
      const envelope = at('envelope', { x: 100, y: 100, w: 400, h: 300 });
      selection.set([envelope.id]);

      board.nudgeSelection(7, 3);
      assert.equal(store.get(envelope.id).x, 107);
      assert.equal(store.get(inside.id).x, 157);
      assert.equal(store.get(outside.id).x, 900);
    });
  });

  describe('list items', () => {
    test('toggleItem flips just that row', () => {
      const list = at('list', { items: [{ id: 'i1', text: 'a', done: false }, { id: 'i2', text: 'b', done: false }] });
      board.toggleItem(list.id, 'i2');
      assert.deepEqual(store.get(list.id).items.map((i) => i.done), [false, true]);
      board.toggleItem(list.id, 'i2');
      assert.deepEqual(store.get(list.id).items.map((i) => i.done), [false, false]);
    });

    test('insertItemAfter puts a blank row in the right place', () => {
      const list = at('list', { items: [{ id: 'i1', text: 'a' }, { id: 'i2', text: 'b' }] });
      const item = board.insertItemAfter(list.id, 0);
      assert.deepEqual(store.get(list.id).items.map((i) => i.id), ['i1', item.id, 'i2']);
      assert.deepEqual({ text: item.text, done: item.done }, { text: '', done: false });
    });

    test('removeItemAt returns the row above and refuses to empty the list', () => {
      const list = at('list', { items: [{ id: 'i1', text: 'a' }, { id: 'i2', text: 'b' }] });
      assert.equal(board.removeItemAt(list.id, 1).id, 'i1');
      assert.deepEqual(store.get(list.id).items.map((i) => i.id), ['i1']);
      assert.equal(board.removeItemAt(list.id, 0), null, 'the last row stays');
    });

    test('removing the first of several has no row above it', () => {
      const list = at('list', { items: [{ id: 'i1', text: 'a' }, { id: 'i2', text: 'b' }] });
      assert.equal(board.removeItemAt(list.id, 0), null);
      assert.deepEqual(store.get(list.id).items.map((i) => i.id), ['i2']);
    });
  });

  describe('raise', () => {
    test('moves objects to the front, keeping their relative order', () => {
      const [a, b, c, d] = [at('card'), at('card'), at('card'), at('card')];
      assert.equal(board.raise([a.id, c.id]), true);
      assert.deepEqual(store.order, [b.id, d.id, a.id, c.id]);
    });

    test('is a no-op when the objects are already on top', () => {
      const a = at('card');
      const b = at('card');
      assert.equal(board.raise([b.id]), false);
      assert.deepEqual(store.order, [a.id, b.id]);
    });

    test('never raises an envelope out from under its contents', () => {
      const envelope = at('envelope');
      const card = at('card');
      assert.equal(board.raise([envelope.id]), false);
      assert.deepEqual(store.order, [envelope.id, card.id]);
    });

    test('raising is not undoable — it is a side effect of selecting', () => {
      const a = at('card');
      at('card');
      store.past.length = 0;
      board.raise([a.id]);
      assert.equal(store.past.length, 0);
    });
  });

  describe('withEnvelopeChildren', () => {
    test('includes objects fully inside an envelope', () => {
      const inside = at('card', { x: 150, y: 150, w: 100, h: 80 });
      const straddling = at('card', { x: 450, y: 150, w: 200, h: 80 });
      const envelope = at('envelope', { x: 100, y: 100, w: 400, h: 300 });

      const ids = board.withEnvelopeChildren([envelope.id]);
      assert.deepEqual(ids.sort(), [envelope.id, inside.id].sort());
      assert.ok(!ids.includes(straddling.id));
    });

    test('follows nesting', () => {
      const leaf = at('card', { x: 160, y: 160, w: 50, h: 50 });
      const inner = at('envelope', { x: 140, y: 140, w: 200, h: 200 });
      const outer = at('envelope', { x: 100, y: 100, w: 500, h: 500 });

      assert.deepEqual(board.withEnvelopeChildren([outer.id]).sort(), [outer.id, inner.id, leaf.id].sort());
    });

    test('passes non-envelopes straight through', () => {
      const card = at('card');
      assert.deepEqual(board.withEnvelopeChildren([card.id]), [card.id]);
    });
  });

  describe('queries', () => {
    test('idsIntersecting finds everything a rect touches', () => {
      const a = at('card', { x: 0, y: 0, w: 100, h: 100 });
      at('card', { x: 500, y: 500, w: 100, h: 100 });
      assert.deepEqual(board.idsIntersecting({ x: 50, y: 50, w: 10, h: 10 }), [a.id]);
    });

    test('bounds spans the board, and is null when empty', () => {
      assert.equal(board.bounds(), null);
      at('card', { x: 0, y: 0, w: 100, h: 100 });
      at('card', { x: 200, y: 50, w: 100, h: 100 });
      assert.deepEqual(board.bounds(), { x: 0, y: 0, w: 300, h: 150 });
    });
  });

  describe('snapping', () => {
    test('offers every edge and midline, except the excluded ids', () => {
      const a = at('card', { x: 0, y: 0, w: 100, h: 60 });
      at('card', { x: 500, y: 500, w: 100, h: 60 });

      const all = board.snapTargets();
      assert.deepEqual(all.xs, [0, 50, 100, 500, 550, 600]);
      assert.deepEqual(all.ys, [0, 30, 60, 500, 530, 560]);

      assert.deepEqual(board.snapTargets(new Set([a.id])).xs, [500, 550, 600]);
    });

    test('pulls a near-miss onto the line and reports the guide', () => {
      const box = { x: 0, y: 0, w: 100, h: 100 };
      const targets = { xs: [204], ys: [] };
      const { dx, dy, guides } = board.resolveSnap(box, 200, 50, targets, 6);

      assert.equal(dx, 204);
      assert.equal(dy, 50);
      assert.deepEqual(guides, [{ axis: 'v', at: 204 }]);
    });

    test('leaves a delta alone when nothing is within tolerance', () => {
      const { dx, dy, guides } = board.resolveSnap({ x: 0, y: 0, w: 10, h: 10 }, 200, 50, { xs: [500], ys: [500] }, 6);
      assert.deepEqual({ dx, dy, guides }, { dx: 200, dy: 50, guides: [] });
    });

    test('prefers the closest candidate on each axis', () => {
      const { dx, dy, guides } = board.resolveSnap(
        { x: 0, y: 0, w: 100, h: 100 },
        0, 0,
        { xs: [5, 2], ys: [-3] },
        6,
      );
      assert.equal(dx, 2, 'the 2px pull beats the 5px one');
      assert.equal(dy, -3);
      assert.deepEqual(guides, [{ axis: 'v', at: 2 }, { axis: 'h', at: -3 }]);
    });

    test('snaps a trailing edge or a midline, not just the leading one', () => {
      const box = { x: 0, y: 0, w: 100, h: 100 };
      assert.equal(board.resolveSnap(box, 0, 0, { xs: [102], ys: [] }, 6).dx, 2, 'right edge');
      assert.equal(board.resolveSnap(box, 0, 0, { xs: [52], ys: [] }, 6).dx, 2, 'centre line');
    });
  });
});
