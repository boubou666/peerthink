import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../../public/js/core/store.js';

const card = (id, props = {}) => ({ id, type: 'card', x: 0, y: 0, w: 200, h: 120, text: '', ...props });

describe('Store', () => {
  let store;
  beforeEach(() => {
    store = new Store();
  });

  const order = () => store.order.join(',');

  describe('apply', () => {
    test('add appends by default and honours an explicit index', () => {
      store.apply([{ t: 'add', obj: card('a') }, { t: 'add', obj: card('b') }]);
      store.apply([{ t: 'add', obj: card('c'), index: 0 }]);
      assert.equal(order(), 'c,a,b');
      assert.equal(store.all().length, 3);
      assert.ok(store.has('a'));
    });

    test('stored objects are clones, not the caller\'s reference', () => {
      const obj = card('a', { items: [{ id: 'i1', text: 'x' }] });
      store.apply([{ t: 'add', obj }]);
      obj.items[0].text = 'mutated';
      assert.equal(store.get('a').items[0].text, 'x');
    });

    test('set patches only the named fields', () => {
      store.apply([{ t: 'add', obj: card('a', { text: 'hello' }) }]);
      store.apply([{ t: 'set', id: 'a', patch: { x: 10 } }]);
      assert.equal(store.get('a').x, 10);
      assert.equal(store.get('a').text, 'hello');
    });

    test('del removes the object and its slot in the order', () => {
      store.apply([{ t: 'add', obj: card('a') }, { t: 'add', obj: card('b') }]);
      store.apply([{ t: 'del', id: 'a' }]);
      assert.equal(store.get('a'), undefined);
      assert.equal(order(), 'b');
    });

    test('order replaces the z-order wholesale', () => {
      store.apply([{ t: 'add', obj: card('a') }, { t: 'add', obj: card('b') }]);
      store.apply([{ t: 'order', order: ['b', 'a'] }]);
      assert.equal(order(), 'b,a');
    });

    test('ops against a missing object are ignored, not fatal', () => {
      store.apply([{ t: 'set', id: 'nope', patch: { x: 1 } }, { t: 'del', id: 'nope' }]);
      assert.equal(store.order.length, 0);
    });

    test('unknown op types are skipped', () => {
      store.apply([{ t: 'nonsense' }]);
      assert.equal(store.order.length, 0);
    });

    test('an empty batch changes nothing and notifies nobody', () => {
      let calls = 0;
      store.on(() => calls++);
      assert.deepEqual(store.apply([]), []);
      assert.equal(calls, 0);
    });

    test('returns an inverse that undoes the batch exactly', () => {
      store.apply([{ t: 'add', obj: card('a', { text: 'first' }) }]);
      const snapshot = JSON.stringify(store.toJSON());

      const inverse = store.apply([
        { t: 'add', obj: card('b') },
        { t: 'set', id: 'a', patch: { text: 'changed' } },
        { t: 'del', id: 'a' },
        { t: 'order', order: ['b'] },
      ], false);

      store.apply(inverse, false);
      assert.equal(JSON.stringify(store.toJSON()), snapshot);
    });

    test('notifies listeners with the touched ids, and honours unsubscribe', () => {
      const seen = [];
      const off = store.on((touched) => seen.push(touched && [...touched]));
      store.apply([{ t: 'add', obj: card('a') }]);
      assert.deepEqual(seen, [['a']]);
      off();
      store.apply([{ t: 'set', id: 'a', patch: { x: 1 } }]);
      assert.equal(seen.length, 1);
    });
  });

  describe('history', () => {
    test('undo and redo walk a recorded change', () => {
      store.apply([{ t: 'add', obj: card('a') }]);
      store.apply([{ t: 'set', id: 'a', patch: { x: 100 } }]);

      assert.ok(store.canUndo);
      assert.equal(store.undo(), true);
      assert.equal(store.get('a').x, 0);
      assert.ok(store.canRedo);
      assert.equal(store.redo(), true);
      assert.equal(store.get('a').x, 100);
    });

    test('record:false keeps a change out of history', () => {
      store.apply([{ t: 'add', obj: card('a') }]);
      store.apply([{ t: 'set', id: 'a', patch: { x: 100 } }], false);
      store.undo();
      assert.equal(store.get('a'), undefined, 'the undo popped the add, not the silent move');
    });

    test('undo and redo on an empty stack report that they did nothing', () => {
      assert.equal(store.canUndo, false);
      assert.equal(store.canRedo, false);
      assert.equal(store.undo(), false);
      assert.equal(store.redo(), false);
    });

    test('a new change clears the redo branch', () => {
      store.apply([{ t: 'add', obj: card('a') }]);
      store.apply([{ t: 'set', id: 'a', patch: { x: 1 } }]);
      store.undo();
      store.apply([{ t: 'set', id: 'a', patch: { x: 2 } }]);
      assert.equal(store.canRedo, false);
      store.redo();
      assert.equal(store.get('a').x, 2);
    });

    test('pushHistory ignores an empty batch', () => {
      store.pushHistory([], []);
      assert.equal(store.past.length, 0);
    });

    test('history is capped so a long session cannot grow without bound', () => {
      store.apply([{ t: 'add', obj: card('a') }]);
      for (let i = 0; i < 400; i++) store.apply([{ t: 'set', id: 'a', patch: { x: i } }]);
      assert.equal(store.past.length, 300);
    });
  });

  describe('serialisation', () => {
    test('round-trips through toJSON and load', () => {
      store.apply([
        { t: 'add', obj: card('a', { text: 'keep me' }) },
        { t: 'add', obj: { id: 'b', type: 'list', x: 0, y: 0, w: 1, h: 1, items: [{ id: 'i', text: 't', done: true }] } },
      ]);

      const restored = new Store();
      restored.load(JSON.parse(JSON.stringify(store.toJSON())));
      assert.equal(restored.order.length, 2);
      assert.equal(restored.get('a').text, 'keep me');
      assert.equal(restored.get('b').items[0].done, true);
    });

    test('load drops order entries with no object, and resets history', () => {
      store.apply([{ t: 'add', obj: card('a') }]);
      store.load({ order: ['a', 'ghost'], objects: [card('a')] });
      assert.deepEqual(store.order, ['a']);
      assert.equal(store.past.length, 0);
      assert.equal(store.future.length, 0);
    });

    test('load clones, so the caller can keep using its own data', () => {
      const data = { order: ['a'], objects: [card('a', { text: 'mine' })] };
      store.load(data);
      data.objects[0].text = 'changed';
      assert.equal(store.get('a').text, 'mine');
    });

    test('load notifies listeners that everything changed', () => {
      const seen = [];
      store.on((ids) => seen.push(ids));
      store.load({ order: [], objects: [] });
      assert.deepEqual(seen, [null]);
    });
  });
});
