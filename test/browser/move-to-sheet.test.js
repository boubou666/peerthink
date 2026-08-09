// Sending the selection to another sheet, and following it there.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('moving objects between sheets', () => {
  let page;

  before(async () => { page = await openApp(); });

  after(async () => {
    const { errors } = page;
    await page.close();
    assert.deepEqual(errors, [], 'the page logged errors');
  });

  beforeEach(async () => {
    await page.eval('localStorage.clear()');
    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
    // The whole board, so a sheet left behind by the last test is not read as
    // part of this one.
    await page.eval('app.sheets.load({})');
    await page.eval('app.viewport.scale = 1; app.viewport.moveTo(0, 0)');
  });

  /** A second sheet, and back to the first. Answers both ids. */
  const twoSheets = () => page.eval(`(() => {
    const first = app.sheets.activeId;
    const second = app.commands.addSheet({ name: 'Later' });
    app.commands.selectSheet(first);
    return { first, second };
  })()`);

  /** Cards in a row, all selected. */
  const place = (texts) => page.eval(`(() => {
    const made = ${JSON.stringify(texts)}.map((text, at) => app.board.add('card', {
      x: at * 300, y: 0, w: 200, h: 120, text,
    }));
    app.selection.set(made.map((obj) => obj.id));
    return made.map((obj) => obj.id);
  })()`);

  const texts = () => page.eval(`app.store.all().filter((o) => o.type === 'card').map((o) => o.text).sort()`);

  /**
   * The menu of the sheet on screen, which is the only tab that has one — and
   * the one that offers where the selection can go.
   */
  const openMenu = async () => {
    await page.eval(`document.querySelector('.sheet-tab[data-current] [data-action="sheet-menu"]').click()`);
    await page.waitFor(`document.querySelector('.sheet-menu') !== null`, { label: 'the sheet menu' });
  };

  const moveTo = async (sheetId) => {
    await openMenu();
    await page.eval(`document.querySelector('[data-action="move-to"][data-target="${sheetId}"]').click()`);
    await page.waitFor(`app.sheets.activeId === '${sheetId}'`, { label: 'the sheet to change' });
  };

  test('the menu offers the other sheets, and only while something is selected', async () => {
    const { first, second } = await twoSheets();
    await place(['one']);

    await openMenu();
    assert.deepEqual(
      await page.eval(`[...document.querySelectorAll('[data-action="move-to"]')].map((el) => el.dataset.target)`),
      [second],
      'the sheet it is not on, and no offer to move it to itself',
    );
    assert.match(
      await page.eval(`document.querySelector('[data-action="move-to"]').textContent`),
      /Later/,
      'named, rather than left to be worked out',
    );
    assert.equal(await page.eval(`app.sheets.activeId === '${first}'`), true);

    await page.eval('app.selection.clear()');
    await page.waitFor(`document.querySelector('[data-action="move-to"]') === null`, {
      label: 'the offer to go with the selection',
    });
  });

  test('takes the objects there, and takes you with them', async () => {
    const { second } = await twoSheets();
    const ids = await place(['one', 'two']);

    await moveTo(second);

    assert.deepEqual(await texts(), ['one', 'two'], 'both arrived');
    assert.equal(await page.eval('app.selection.size'), 2, 'and are selected where they landed');
    assert.equal(
      await page.eval(`app.selection.list().some((id) => ${JSON.stringify(ids)}.includes(id))`),
      false,
      'as copies, since two objects cannot share an id',
    );
  });

  test('and leaves nothing behind on the sheet they left', async () => {
    const { first, second } = await twoSheets();
    await place(['one', 'two']);

    await moveTo(second);

    await page.eval(`app.commands.selectSheet('${first}')`);
    assert.deepEqual(await texts(), []);
  });

  test('the arrows between them come too', async () => {
    const { second } = await twoSheets();
    const ids = await place(['one', 'two']);
    await page.eval(`(() => {
      app.board.connect('${ids[0]}', '${ids[1]}');
      app.selection.set(${JSON.stringify(ids)});
    })()`);

    await moveTo(second);

    const arrows = await page.eval(`app.store.all().filter((o) => o.type === 'connector')`);
    assert.equal(arrows.length, 1, 'the arrow arrived');

    const cardIds = await page.eval(`app.store.all().filter((o) => o.type === 'card').map((o) => o.id)`);
    assert.ok(cardIds.includes(arrows[0].from) && cardIds.includes(arrows[0].to), 'joining the copies');
  });

  /**
   * A sheet's history travels with the sheet, so a move is one change on each:
   * undo where they arrived takes them away, undo where they were puts them
   * back. Either way there is one of them, which is the thing that matters.
   */
  test('each sheet undoes its own half', async () => {
    const { first, second } = await twoSheets();
    await place(['one']);

    await moveTo(second);

    await page.eval('app.store.undo()');
    assert.deepEqual(await texts(), [], 'undone where they landed');

    await page.eval(`app.commands.selectSheet('${first}')`);
    await page.eval('app.store.undo()');
    assert.deepEqual(await texts(), ['one'], 'and put back where they came from');
  });

  test('an empty selection moves nothing', async () => {
    const { second } = await twoSheets();
    await place(['one']);
    await page.eval('app.selection.clear()');

    assert.equal(await page.eval(`app.commands.moveSelectionTo('${second}')`), false);
    assert.deepEqual(await texts(), ['one'], 'still here');
  });

  test('and neither does a sheet that is not there, or the one already showing', async () => {
    const { first } = await twoSheets();
    await place(['one']);

    assert.equal(await page.eval(`app.commands.moveSelectionTo('nobody')`), false);
    assert.equal(await page.eval(`app.commands.moveSelectionTo('${first}')`), false);
    assert.deepEqual(await texts(), ['one']);
  });
});
