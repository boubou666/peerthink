// Arrows between objects: drawing them, following them, and taking them away.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('connectors', () => {
  let page;

  before(async () => { page = await openApp(); });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  beforeEach(async () => {
    await page.eval('localStorage.clear()');
    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
    await page.eval('app.store.load({ v: 1, order: [], objects: [] })');
    await page.eval('app.viewport.scale = 1; app.viewport.moveTo(-100, -100)');
  });

  const CONNECT = '[data-format-bar] [data-action="connect"]';

  /** Two cards, far enough apart for an arrow to fit between them. */
  const twoCards = () => page.eval(`(() => {
    const a = app.board.add('card', { x: 0, y: 0, w: 200, h: 120 });
    const b = app.board.add('card', { x: 500, y: 0, w: 200, h: 120 });
    app.selection.set([a.id, b.id]);
    return [a.id, b.id];
  })()`);

  const connectors = () => page.eval(`app.store.all().filter((o) => o.type === 'connector')`);

  /** The drawn line, in screen coordinates, or null. */
  const drawn = () => page.eval(`(() => {
    const line = document.querySelector('.connectors [data-id] .connector-line');
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  })()`);

  const clickControl = () => page.eval(`document.querySelector('${CONNECT}').click()`);

  const offered = () => page.waitFor(`document.querySelector('${CONNECT}') !== null`, {
    label: 'the connect control',
    context: 'document.querySelector("[data-format-bar]")?.innerText ?? "no bar"',
  });

  test('two selected objects can be joined, and the arrow is drawn', async () => {
    const [a, b] = await twoCards();
    await offered();
    await clickControl();

    await page.waitFor(`document.querySelector('.connectors [data-id]') !== null`, {
      label: 'the arrow on the board',
    });

    const [made] = await connectors();
    assert.deepEqual([made.from, made.to], [a, b], 'from the first selected to the second');
    assert.equal(made.x, undefined, 'and it carries no coordinates of its own');
  });

  test('the same control takes it away again', async () => {
    await twoCards();
    await offered();
    await clickControl();
    await page.waitFor(`document.querySelector('${CONNECT}').textContent === 'Disconnect'`, {
      label: 'the control to offer the other thing',
    });

    await clickControl();
    await page.waitFor(`document.querySelector('.connectors [data-id]') === null`, {
      label: 'the arrow to go',
    });
    assert.deepEqual(await connectors(), []);
  });

  test('it is not offered for one object, or for three', async () => {
    const [a, b] = await twoCards();
    const c = await page.eval(`app.board.add('card', { x: 0, y: 400, w: 200, h: 120 }).id`);

    await page.eval(`app.selection.set(['${a}'])`);
    await page.waitFor(`document.querySelector('${CONNECT}') === null`, { label: 'no control for one' });

    await page.eval(`app.selection.set(['${a}', '${b}', '${c}'])`);
    await page.waitFor(`document.querySelector('${CONNECT}') === null`, { label: 'nor for three' });
  });

  test('the arrow follows what it joins', async () => {
    await twoCards();
    await offered();
    await clickControl();
    await page.waitFor(`document.querySelector('.connectors [data-id]') !== null`, { label: 'the arrow' });

    const before = await drawn();
    await page.eval(`(() => {
      const [a] = app.store.all();
      app.store.apply([{ t: 'set', id: a.id, patch: { y: a.y - 300 } }]);
    })()`);

    const after = await drawn();
    assert.ok(Math.abs(after.cy - before.cy) > 50, `the line moved with the card: ${before.cy} → ${after.cy}`);
  });

  test('and disappears while its ends overlap, without being deleted', async () => {
    const [a] = await twoCards();
    await offered();
    await clickControl();
    await page.waitFor(`document.querySelector('.connectors [data-id]') !== null`, { label: 'the arrow' });

    await page.eval(`app.store.apply([{ t: 'set', id: '${a}', patch: { x: 480 } }])`);
    assert.equal(
      await page.eval(`document.querySelector('.connectors [data-id]').style.display`),
      'none',
      'there is no room between them to draw one',
    );
    assert.equal((await connectors()).length, 1, 'but it is still on the board');
  });

  test('a press on the line selects it, and Delete removes it', async () => {
    await twoCards();
    await offered();
    await clickControl();
    await page.waitFor(`document.querySelector('.connectors [data-id]') !== null`, { label: 'the arrow' });

    const line = await drawn();
    await page.click(line.cx, line.cy);

    const [made] = await connectors();
    assert.deepEqual(await page.eval('app.selection.list()'), [made.id], 'the arrow, and nothing else');

    await page.key('Delete', { vk: 46 });
    assert.deepEqual(await connectors(), []);
  });

  test('deleting an object takes its arrows with it, and one undo brings both back', async () => {
    const [a] = await twoCards();
    await offered();
    await clickControl();
    await page.waitFor(`document.querySelector('.connectors [data-id]') !== null`, { label: 'the arrow' });

    await page.eval(`app.selection.set(['${a}'])`);
    await page.key('Delete', { vk: 46 });
    await page.waitFor(`document.querySelector('.connectors [data-id]') === null`, { label: 'the arrow to go' });

    await page.eval('app.store.undo()');
    assert.equal((await connectors()).length, 1);
    assert.equal(await page.eval(`Boolean(app.store.get('${a}'))`), true);
  });

  /**
   * The arrow has no box, so every one of these would have written `NaN` into
   * the document and broadcast it to everyone else on the board.
   */
  test('a selection holding one can still be dragged and nudged', async () => {
    const [a, b] = await twoCards();
    await offered();
    await clickControl();
    const [made] = await connectors();

    await page.eval(`app.selection.set(['${a}', '${b}', '${made.id}'])`);
    await page.key('ArrowRight', { code: 'ArrowRight', vk: 39 });

    assert.equal(await page.eval(`app.store.get('${a}').x`), 1);
    assert.equal(await page.eval(`app.store.get('${made.id}').x`), undefined);

    const card = await page.rect(a);
    await page.drag({ x: card.cx, y: card.cy }, { x: card.cx, y: card.cy + 120 });
    assert.equal(await page.eval(`Number.isFinite(app.store.get('${a}').y)`), true);
    assert.equal(await page.eval(`app.store.get('${made.id}').y`), undefined);
  });

  test('a marquee round both ends takes the arrow too', async () => {
    await twoCards();
    await offered();
    await clickControl();
    const [made] = await connectors();

    await page.eval('app.selection.clear()');
    // Below the toolbar, which owns the top left corner and would have taken
    // the press instead of the stage.
    await page.drag({ x: 30, y: 80 }, { x: 900, y: 400 });

    assert.ok((await page.eval('app.selection.list()')).includes(made.id));
  });

  test('duplicating a joined pair joins the copies', async () => {
    await twoCards();
    await offered();
    await clickControl();

    await page.eval('app.board.duplicate()');
    const made = await connectors();

    assert.equal(made.length, 2, 'the copy has an arrow of its own');
    assert.notEqual(made[0].from, made[1].from, 'pointing at the copies');
  });

  test('the map leaves them out', async () => {
    await twoCards();
    await offered();
    await clickControl();

    // Nothing to assert about pixels here beyond this: a connector has no box,
    // and a map that tried to draw one would have thrown or drawn nothing at
    // a coordinate of NaN. The page's error log is checked when the file ends.
    assert.equal(await page.eval(`document.querySelector('[data-minimap-canvas]') !== null`), true);
  });
});
