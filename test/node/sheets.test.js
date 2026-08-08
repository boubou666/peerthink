// Several named canvases on one board, one of them on screen.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../../src/core/store.js';
import {
  DOCUMENT_VERSION,
  FIRST_SHEET_ID,
  FIRST_SHEET_NAME,
  createSheets,
  isSheetChange,
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
  sheets.load(doc);
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
   * The one every client has to agree about.
   *
   * An op is addressed to a sheet id. The first sheet is not created by
   * anybody — it is what a board from before sheets becomes when it is read —
   * so two clients reading the same board have to arrive at the same id, or
   * their edits pass each other addressed to sheets neither of them has. This
   * is the property that broke live collaboration when the id was generated,
   * and it broke it for every board that existed.
   */
  test('the first sheet has the same id wherever it is read', () => {
    const here = readDocument(v1(card('a')), ids());
    const there = readDocument(v1(card('a')), ids());
    const fresh = readDocument(null, ids());

    assert.equal(here[0].id, FIRST_SHEET_ID);
    assert.equal(there[0].id, FIRST_SHEET_ID, 'two clients read one board as two sheets');
    assert.equal(fresh[0].id, FIRST_SHEET_ID, 'a board with nothing stored yet started somewhere else');
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
  test('a missing id is replaced rather than trusted', () => {
    const read = readDocument({
      v: 2,
      sheets: [{ name: 'A' }, { id: '', name: 'B' }, { id: 's3', name: 'C' }],
    }, ids());

    assert.equal(new Set(read.map((s) => s.id)).size, 3);
    assert.equal(read[2].id, 's3', 'an id that was fine was replaced anyway');
  });

  /**
   * And a repeated one, which is worse than a missing one: everything here
   * finds a sheet by the first match, so the second would be unreachable —
   * impossible to switch to, and taking the first's remote ops — and it would
   * be written back for next time.
   */
  test('a repeated id is replaced too, and the first keeps it', () => {
    const read = readDocument({
      v: 2,
      sheets: [
        { id: 'same', name: 'A', order: ['a'], objects: [card('a')] },
        { id: 'same', name: 'B', order: ['b'], objects: [card('b')] },
      ],
    }, ids());

    assert.equal(read[0].id, 'same');
    assert.notEqual(read[1].id, 'same', 'two sheets came back with one id');
    assert.deepEqual(read[1].order, ['b'], 'the wrong sheet was renamed');
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
     * Two people on one board, which is what the addressing is for.
     *
     * Each client reads the board for itself, so "the sheet Alice is on" has
     * to be the same id as "the sheet Bob is on" without either of them being
     * told. When it was not, every op crossed the wire addressed to a sheet
     * the receiver did not have, and live collaboration stopped working on
     * every board there was.
     */
    test('cross a client that read the same board separately', () => {
      const alice = build(v1(card('a')));
      const bob = build(v1(card('a')));

      assert.equal(alice.sheets.activeId, bob.sheets.activeId, 'two readings of one board disagree');

      bob.sheets.applyRemote(alice.sheets.activeId, [{ t: 'add', obj: card('hers') }]);
      assert.deepEqual(bob.store.order, ['a', 'hers'], "Alice's edit did not reach Bob");
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

  /**
   * What crosses to the other people on the board.
   *
   * `on` says "draw again", which is what a tab strip needs. This is the other
   * seam — what happened, in words another client can act on — and it is the
   * same shape the store uses for ops, for the same reason: one vocabulary,
   * one path, no second implementation of what a change means.
   */
  describe('changes on the wire', () => {
    /** Everything a local change announced, in order. */
    const recorded = () => {
      const seen = [];
      sheets.onChanges((changes, origin) => seen.push(...changes.map((c) => ({ ...c, origin }))));
      return seen;
    };

    test('adding announces the sheet, empty and in its place', () => {
      const seen = recorded();
      const id = sheets.add({ name: 'Themes' });

      assert.deepEqual(seen, [
        { t: 'sheet-add', id, name: 'Themes', index: 1, order: [], objects: [], origin: 'local' },
      ]);
    });

    /**
     * The contents travel with it. A copy announced as "make a sheet, then
     * here is everything on it" would be the board twice over, and the two
     * clients would disagree about the ids.
     */
    test('duplicating announces the copy with its objects', () => {
      const seen = recorded();
      const copy = sheets.duplicate(sheets.activeId);

      assert.equal(seen.length, 1);
      assert.equal(seen[0].t, 'sheet-add');
      assert.equal(seen[0].id, copy);
      assert.equal(seen[0].index, 1);
      assert.equal(seen[0].objects.length, 1);
      assert.notEqual(seen[0].objects[0].id, 'a', 'the copy was announced sharing an object with its original');
      assert.deepEqual(seen[0].order, seen[0].objects.map((o) => o.id));
    });

    test('renaming and removing announce themselves', () => {
      const second = sheets.add();
      const seen = recorded();

      sheets.rename(second, 'Themes');
      sheets.remove(second);

      assert.deepEqual(seen, [
        { t: 'sheet-rename', id: second, name: 'Themes', origin: 'local' },
        { t: 'sheet-del', id: second, origin: 'local' },
      ]);
    });

    test('a rename that changes nothing announces nothing', () => {
      const seen = recorded();
      sheets.rename(sheets.activeId, '   ');
      sheets.remove(sheets.activeId);
      assert.deepEqual(seen, [], 'a refused change was put on the wire');
    });

    test('what arrives is not announced back as local', () => {
      const seen = recorded();
      sheets.applyChanges([{ t: 'sheet-add', id: 'hers', name: 'Hers', index: 1, order: [], objects: [] }]);

      assert.equal(seen.length, 1);
      assert.equal(seen[0].origin, 'remote', 'a remote change would have been sent straight back out');
    });
  });

  describe('sheet changes from another client', () => {
    test('a sheet somebody else made turns up, without taking the screen', () => {
      const mine = sheets.activeId;
      sheets.applyChanges([
        { t: 'sheet-add', id: 'hers', name: 'Hers', index: 1, order: ['x'], objects: [card('x')] },
      ]);

      assert.deepEqual(sheets.list().map((s) => s.name), [FIRST_SHEET_NAME, 'Hers']);
      assert.equal(sheets.activeId, mine, 'somebody else adding a sheet moved this person onto it');
      assert.deepEqual(store.order, ['a'], 'the canvas changed under the person looking at it');

      sheets.select('hers');
      assert.deepEqual(store.order, ['x'], 'the sheet arrived without what was on it');
    });

    test('a rename arrives', () => {
      sheets.applyChanges([{ t: 'sheet-rename', id: sheets.activeId, name: 'Discovery' }]);
      assert.deepEqual(sheets.list().map((s) => s.name), ['Discovery']);
    });

    /**
     * Deleting the sheet somebody is looking at is the one change that moves
     * them: there is nothing else to show. The neighbour takes over, exactly
     * as it does when they delete it themselves.
     */
    test('deleting the sheet on screen moves this person to its neighbour', () => {
      const first = sheets.activeId;
      const second = sheets.add();
      assert.equal(sheets.activeId, second);

      sheets.applyChanges([{ t: 'sheet-del', id: second }]);
      assert.equal(sheets.activeId, first);
      assert.deepEqual(store.order, ['a'], 'the neighbour did not come up');
    });

    /**
     * A channel can resend, and a client can be told about a sheet it already
     * has. None of these is worth guessing at.
     */
    test('are ignored when they say something already true, or nothing at all', () => {
      const add = { t: 'sheet-add', id: 'hers', name: 'Hers', index: 1, order: [], objects: [] };
      assert.equal(sheets.applyChanges([add]), true);
      assert.equal(sheets.applyChanges([add]), false, 'a sheet arrived twice');
      assert.equal(sheets.size, 2);

      assert.equal(sheets.applyChanges([{ t: 'sheet-rename', id: 'nothing', name: 'x' }]), false);
      assert.equal(sheets.applyChanges([{ t: 'sheet-del', id: 'nothing' }]), false);
    });

    /** The invariant is the board's, not one client's. */
    test('cannot delete the last sheet either', () => {
      assert.equal(sheets.applyChanges([{ t: 'sheet-del', id: sheets.activeId }]), false);
      assert.equal(sheets.size, 1);
    });

    /**
     * The round trip, without a wire: what one client announces, applied by
     * another that read the same board.
     *
     * The wire is covered against real Realtime in `sync.test.js`, which only
     * CI can run. This is the same claim where it can be checked here — and it
     * is the claim that broke last time, when two clients derived different
     * ids for the same thing and every message crossed addressed to nothing.
     */
    test('what one client announces is what another applies', () => {
      const hers = build(v1(card('a')));
      const his = build(v1(card('a')));

      const announced = [];
      hers.sheets.onChanges((changes, origin) => {
        if (origin === 'local') announced.push(...changes);
      });

      const copy = hers.sheets.duplicate(hers.sheets.activeId);
      hers.sheets.rename(copy, 'Themes');

      for (const change of announced) his.sheets.applyChanges([change]);

      assert.deepEqual(
        his.sheets.list(),
        hers.sheets.list(),
        'the two clients ended up with different sheets',
      );

      his.sheets.select(copy);
      hers.sheets.select(copy);
      assert.deepEqual(
        his.store.order,
        hers.store.order,
        'the copy arrived with different object ids',
      );
      assert.equal(his.store.order.length, 1);
    });

    test('anything that is not a change this client understands is skipped', () => {
      assert.equal(sheets.applyChanges([
        { t: 'sheet-reorder', id: 'a', to: 2 },
        null,
        { t: 'sheet-rename', id: sheets.activeId },
      ]), false);
      assert.deepEqual(sheets.list().map((s) => s.name), [FIRST_SHEET_NAME]);
    });
  });
});

/**
 * The wire's own vocabulary check, which is a version boundary rather than a
 * security one: everyone on the channel is an authorised editor, and a change
 * this client cannot read is one from a client that means something by it.
 */
describe('isSheetChange', () => {
  const add = { t: 'sheet-add', id: 's', name: 'S', index: 0, order: [], objects: [] };

  test('accepts the three it knows', () => {
    assert.equal(isSheetChange(add), true);
    assert.equal(isSheetChange({ t: 'sheet-rename', id: 's', name: 'S' }), true);
    assert.equal(isSheetChange({ t: 'sheet-del', id: 's' }), true);
  });

  test('refuses a change with nothing to act on', () => {
    for (const missing of ['id', 'name', 'index', 'order', 'objects']) {
      const change = { ...add };
      delete change[missing];
      assert.equal(isSheetChange(change), false, `an add with no ${missing} was accepted`);
    }
    assert.equal(isSheetChange({ t: 'sheet-add', ...add, index: 1.5 }), false, 'a fractional index');
    assert.equal(isSheetChange({ t: 'sheet-rename', id: 's' }), false);
    assert.equal(isSheetChange({ t: 'sheet-del' }), false);
  });

  test('refuses what it has never heard of', () => {
    assert.equal(isSheetChange({ t: 'sheet-reorder', id: 's', to: 1 }), false);
    assert.equal(isSheetChange({ t: 'add', obj: {} }), false, 'an op is not a sheet change');
    assert.equal(isSheetChange(null), false);
    assert.equal(isSheetChange('sheet-del'), false);
  });
});
