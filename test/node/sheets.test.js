// Several named canvases on one board, one of them on screen.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../../src/core/store.js';
import {
  DOCUMENT_VERSION,
  FIRST_SHEET_NAME,
  createSheets,
  readDocument,
  writeDocument,
} from '../../src/core/sheets.js';

/** Ids in sequence, so a test can name the sheet it expects. */
const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

const card = (id, props = {}) => ({ id, type: 'card', x: 0, y: 0, w: 200, h: 120, ...props });

const v1 = (...objects) => ({ v: 1, order: objects.map((o) => o.id), objects });

const build = (doc = null) => {
  const store = new Store();
  const sheets = createSheets({ store, newId: ids() });
  if (doc) sheets.load(doc);
  return { store, sheets };
};

describe('reading a stored document', () => {
  test('a board from before sheets is one sheet', () => {
    const read = readDocument(v1(card('a'), card('b')), ids());
    assert.equal(read.length, 1);
    assert.equal(read[0].name, FIRST_SHEET_NAME);
    assert.deepEqual(read[0].order, ['a', 'b']);
    assert.equal(read[0].objects.length, 2);
  });

  /**
   * Total on purpose. This is the first thing a board goes through on the way
   * in, and the alternative to reading junk as an empty sheet is a board that
   * will not open at all.
   */
  test('junk is an empty sheet rather than a thrown error', () => {
    for (const doc of [null, undefined, {}, { sheets: 'no' }, { sheets: [] }, 42]) {
      const read = readDocument(doc, ids());
      assert.equal(read.length, 1, `${JSON.stringify(doc)} did not read as one sheet`);
      assert.deepEqual(read[0].objects, []);
    }
  });

  test('sheets are read with their names and contents', () => {
    const read = readDocument({
      v: 2,
      sheets: [
        { id: 's1', name: 'Discovery', order: ['a'], objects: [card('a')] },
        { id: 's2', name: 'Themes', order: [], objects: [] },
      ],
    }, ids());

    assert.deepEqual(read.map((s) => [s.id, s.name]), [['s1', 'Discovery'], ['s2', 'Themes']]);
  });

  /**
   * An id is what an op addresses a sheet by, so two sheets sharing one would
   * take each other's edits.
   */
  test('a missing or repeated id is replaced rather than trusted', () => {
    const read = readDocument({
      v: 2,
      sheets: [{ name: 'A' }, { id: '', name: 'B' }, { id: 's3', name: 'C' }],
    }, ids());

    assert.equal(new Set(read.map((s) => s.id)).size, 3);
    assert.equal(read[2].id, 's3', 'an id that was fine was replaced anyway');
  });

  test('an unnamed sheet is numbered by where it sits', () => {
    const read = readDocument({ v: 2, sheets: [{ id: 'a' }, { id: 'b', name: '   ' }] }, ids());
    assert.deepEqual(read.map((s) => s.name), ['Sheet 1', 'Sheet 2']);
  });
});

/**
 * The first sheet is written twice — once in `sheets`, once where a board has
 * always kept its objects — so `isBoard` and the database's check constraint
 * still pass, and a client running the previous build finds a real board
 * rather than one it reads as absent and seeds over.
 */
describe('writing a document', () => {
  test('keeps the first sheet where a board has always kept it', () => {
    const doc = writeDocument([
      { id: 's1', name: 'One', order: ['a'], objects: [card('a')] },
      { id: 's2', name: 'Two', order: ['b'], objects: [card('b')] },
    ]);

    assert.equal(doc.v, DOCUMENT_VERSION);
    assert.deepEqual(doc.order, ['a'], 'the top level is not the first sheet');
    assert.deepEqual(doc.objects.map((o) => o.id), ['a']);
    assert.equal(doc.sheets.length, 2);
  });

  test('what it writes is what it reads back', () => {
    const sheets = [
      { id: 's1', name: 'One', order: ['a'], objects: [card('a')] },
      { id: 's2', name: 'Two', order: [], objects: [] },
    ];
    assert.deepEqual(readDocument(writeDocument(sheets), ids()), sheets);
  });
});

describe('sheets', () => {
  let store;
  let sheets;

  beforeEach(() => {
    ({ store, sheets } = build(v1(card('a'))));
  });

  test('a loaded board has one sheet, on screen', () => {
    assert.deepEqual(sheets.list().map((s) => s.name), [FIRST_SHEET_NAME]);
    assert.equal(sheets.activeId, sheets.list()[0].id);
    assert.deepEqual(store.order, ['a'], 'the sheet did not reach the store');
  });

  test('adding a sheet shows it, empty', () => {
    const id = sheets.add();
    assert.equal(sheets.activeId, id);
    assert.deepEqual(store.order, [], 'the new sheet came up with the old one\'s objects');
    assert.deepEqual(sheets.list().map((s) => s.name), [FIRST_SHEET_NAME, 'Sheet 2']);
  });

  test('a name is taken if it is free, and numbered past what is taken', () => {
    sheets.rename(sheets.activeId, 'Sheet 2');
    sheets.add();
    assert.deepEqual(sheets.list().map((s) => s.name), ['Sheet 2', 'Sheet 3']);
  });

  test('switching carries the objects with it, both ways', () => {
    const first = sheets.activeId;
    const second = sheets.add();

    store.apply([{ t: 'add', obj: card('b') }]);
    assert.deepEqual(store.order, ['b']);

    sheets.select(first);
    assert.deepEqual(store.order, ['a'], 'the first sheet came back changed');

    sheets.select(second);
    assert.deepEqual(store.order, ['b'], 'the second sheet lost what was put on it');
  });

  test('selecting the sheet already on screen is not a switch', () => {
    let changes = 0;
    sheets.on(() => { changes++; });
    assert.equal(sheets.select(sheets.activeId), false);
    assert.equal(sheets.select('nothing'), false);
    assert.equal(changes, 0);
  });

  /**
   * Undo belongs to the sheet you are looking at. Walking back into edits made
   * on a canvas nobody is showing is not what anybody means by ctrl+Z.
   */
  test('undo history travels with the sheet', () => {
    const first = sheets.activeId;
    store.apply([{ t: 'add', obj: card('b') }]);

    const second = sheets.add();
    assert.equal(store.canUndo, false, 'a new sheet came up with somebody else\'s history');
    store.apply([{ t: 'add', obj: card('c') }]);

    sheets.select(first);
    assert.equal(store.canUndo, true);
    store.undo();
    assert.deepEqual(store.order, ['a'], 'undo did not walk back this sheet');

    sheets.select(second);
    assert.deepEqual(store.order, ['c'], 'the other sheet was undone too');
    assert.equal(store.canUndo, true, 'the sheet came back without its history');
  });

  test('renaming, and refusing a name that says nothing', () => {
    const id = sheets.activeId;
    assert.equal(sheets.rename(id, '  Discovery  '), true);
    assert.equal(sheets.list()[0].name, 'Discovery');

    assert.equal(sheets.rename(id, '   '), false, 'a blank name was taken');
    assert.equal(sheets.rename(id, 'Discovery'), false, 'renaming to the same name reported a change');
    assert.equal(sheets.rename('nothing', 'x'), false);
    assert.equal(sheets.list()[0].name, 'Discovery');
  });

  test('a name is cut to something that fits a tab', () => {
    sheets.rename(sheets.activeId, 'x'.repeat(200));
    assert.equal(sheets.list()[0].name.length, 64);
  });

  describe('duplicating', () => {
    test('copies the objects as new objects, and shows the copy', () => {
      const copy = sheets.duplicate(sheets.activeId);

      assert.equal(sheets.activeId, copy);
      assert.deepEqual(sheets.list().map((s) => s.name), [FIRST_SHEET_NAME, `${FIRST_SHEET_NAME} (copy)`]);
      assert.equal(store.order.length, 1);
      assert.notEqual(store.order[0], 'a', 'the copy shares an object id with its original');
      assert.equal(store.get(store.order[0]).type, 'card');
    });

    test('the copy is not the original', () => {
      const first = sheets.activeId;
      sheets.duplicate(first);
      store.apply([{ t: 'set', id: store.order[0], patch: { text: 'changed' } }]);

      sheets.select(first);
      assert.equal(store.get('a').text, undefined, 'editing the copy changed the original');
    });

    test('it goes next to what it copies, not at the end', () => {
      const first = sheets.activeId;
      const last = sheets.add();
      const copy = sheets.duplicate(first);
      assert.deepEqual(sheets.list().map((s) => s.id), [first, copy, last]);
    });

    test('there is nothing to copy from a sheet that is not there', () => {
      assert.equal(sheets.duplicate('nothing'), null);
      assert.equal(sheets.size, 1);
    });
  });

  describe('removing', () => {
    test('the last sheet stays: a board with no canvas is not a board', () => {
      assert.equal(sheets.remove(sheets.activeId), false);
      assert.equal(sheets.size, 1);
    });

    test('removing the sheet on screen shows its neighbour', () => {
      const first = sheets.activeId;
      const second = sheets.add();

      assert.equal(sheets.remove(second), true);
      assert.equal(sheets.activeId, first);
      assert.deepEqual(store.order, ['a'], 'the neighbour did not come up');
    });

    test('removing one that is not on screen leaves the screen alone', () => {
      const first = sheets.activeId;
      const second = sheets.add();

      assert.equal(sheets.remove(first), true);
      assert.equal(sheets.activeId, second);
      assert.equal(sheets.remove('nothing'), false);
    });
  });

  describe('ops from another client', () => {
    test('land on the sheet they were made on, whichever is on screen', () => {
      const first = sheets.activeId;
      const second = sheets.add();

      assert.equal(sheets.applyRemote(first, [{ t: 'add', obj: card('remote') }]), true);
      assert.deepEqual(store.order, [], 'an op for another sheet reached the screen');

      sheets.select(first);
      assert.deepEqual(store.order, ['a', 'remote'], 'the op did not reach the sheet it was for');
      assert.equal(sheets.activeId, first);
      assert.equal(second, sheets.list()[1].id);
    });

    test('and are applied to the store when they are for what is on screen', () => {
      sheets.applyRemote(sheets.activeId, [{ t: 'add', obj: card('remote') }]);
      assert.deepEqual(store.order, ['a', 'remote']);
    });

    /** They are somebody else's edits: undoing them is not this client's to do. */
    test('never enter this client\'s history', () => {
      sheets.applyRemote(sheets.activeId, [{ t: 'add', obj: card('remote') }]);
      assert.equal(store.canUndo, false);
    });

    test('an inactive sheet keeps the history it had', () => {
      const first = sheets.activeId;
      store.apply([{ t: 'add', obj: card('b') }]);
      sheets.add();

      sheets.applyRemote(first, [{ t: 'add', obj: card('remote') }]);
      sheets.select(first);
      assert.equal(store.canUndo, true, 'a remote op cleared the sheet\'s undo stack');
    });

    /**
     * A sheet somebody else has just made, whose creation is still on its way.
     * Inventing a document for it would be inventing a sheet nothing agrees
     * exists.
     */
    test('for a sheet this client has not got are dropped', () => {
      assert.equal(sheets.applyRemote('nothing', [{ t: 'add', obj: card('x') }]), false);
      assert.equal(sheets.size, 1);
    });
  });

  describe('what gets stored', () => {
    test('holds every sheet, including the one on screen', () => {
      const first = sheets.activeId;
      sheets.add();
      store.apply([{ t: 'add', obj: card('b') }]);

      const doc = sheets.toJSON();
      assert.equal(doc.sheets.length, 2);
      assert.deepEqual(doc.sheets[0].order, ['a'], 'the sheet put aside was not written');
      assert.deepEqual(doc.sheets[1].order, ['b'], 'the sheet on screen was written from a stale copy');
      assert.equal(doc.sheets[0].id, first);
    });

    test('carries no undo stacks — they are nobody else\'s business', () => {
      store.apply([{ t: 'add', obj: card('b') }]);
      const [sheet] = sheets.toJSON().sheets;
      assert.deepEqual(Object.keys(sheet).sort(), ['id', 'name', 'objects', 'order']);
    });

    test('a board saved and loaded again is the same board', () => {
      sheets.rename(sheets.activeId, 'Discovery');
      const second = sheets.add();
      store.apply([{ t: 'add', obj: card('b') }]);
      sheets.rename(second, 'Themes');

      const again = build(sheets.toJSON());
      assert.deepEqual(again.sheets.list().map((s) => s.name), ['Discovery', 'Themes']);
      assert.deepEqual(again.store.order, ['a'], 'it did not come back on its first sheet');

      again.sheets.select(again.sheets.list()[1].id);
      assert.deepEqual(again.store.order, ['b']);
    });
  });

  test('every change tells whoever is listening', () => {
    let changes = 0;
    const stop = sheets.on(() => { changes++; });

    const added = sheets.add();
    sheets.rename(added, 'x');
    sheets.duplicate(added);
    sheets.select(added);
    sheets.remove(added);
    assert.equal(changes, 5);

    stop();
    sheets.add();
    assert.equal(changes, 5, 'it went on reporting after being stopped');
  });
});
