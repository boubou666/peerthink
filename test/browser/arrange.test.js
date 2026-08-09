// Lining objects up and spacing them out, from the bar above them.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('arranging', () => {
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
    await page.eval('app.sheets.load({})');
    await page.eval('app.viewport.scale = 1; app.viewport.moveTo(-40, -40)');
  });

  const control = (value) => `[data-format-bar] .fmt-arrange[data-value="${value}"]`;

  /** Cards at the places given, all selected. */
  const place = (boxes) => page.eval(`(() => {
    const made = ${JSON.stringify(boxes)}.map((box) => app.board.add('card', box));
    app.selection.set(made.map((obj) => obj.id));
    return made.map((obj) => obj.id);
  })()`);

  const boxesOf = (ids) => page.eval(`${JSON.stringify(ids)}.map((id) => {
    const obj = app.store.get(id);
    return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
  })`);

  const press = async (value) => {
    await page.waitFor(`document.querySelector('${control(value)}') !== null`, {
      label: `the ${value} control`,
      context: 'document.querySelector("[data-format-bar]")?.innerText ?? "no bar"',
    });
    await page.eval(`document.querySelector('${control(value)}').click()`);
  };

  test('the controls are there for two objects and not for one', async () => {
    const ids = await place([
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 300, y: 90, w: 100, h: 60 },
    ]);

    await page.waitFor(`document.querySelectorAll('.fmt-arrange').length === 8`, { label: 'the group' });

    await page.eval(`app.selection.set(['${ids[0]}'])`);
    await page.waitFor(`document.querySelectorAll('.fmt-arrange').length === 0`, {
      label: 'the group to go for one object',
    });
  });

  /**
   * Two objects have one gap between them, and one gap is already even. The
   * control says so by being there and refusing, rather than by disappearing
   * as a third object is selected and appearing again.
   */
  test('spacing waits for a third object', async () => {
    await place([
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 300, y: 0, w: 100, h: 60 },
    ]);
    await page.waitFor(`document.querySelector('${control('horizontal')}')?.disabled === true`, {
      label: 'spacing to be refused',
    });

    await page.eval(`(() => {
      const made = app.board.add('card', { x: 600, y: 0, w: 100, h: 60 });
      app.selection.set([...app.store.order].filter((id) => app.store.get(id).type === 'card'));
      return made.id;
    })()`);
    await page.waitFor(`document.querySelector('${control('horizontal')}')?.disabled === false`, {
      label: 'spacing to be offered',
    });
  });

  test('align puts the edges in a line, and one undo puts them back', async () => {
    const ids = await place([
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 300, y: 90, w: 140, h: 80 },
      { x: 600, y: 40, w: 100, h: 60 },
    ]);

    await press('left');
    assert.deepEqual((await boxesOf(ids)).map((box) => box.x), [0, 0, 0]);

    await page.eval('app.store.undo()');
    assert.deepEqual((await boxesOf(ids)).map((box) => box.x), [0, 300, 600], 'all three, in one step');
  });

  test('and middles line up on the middle of the box they make', async () => {
    const ids = await place([
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 300, y: 100, w: 100, h: 100 },
    ]);

    await press('middle');
    const boxes = await boxesOf(ids);
    assert.deepEqual(
      boxes.map((box) => box.y + box.h / 2),
      [100, 100],
      'both centres on the middle of the two of them',
    );
  });

  test('spacing makes the gaps between them equal', async () => {
    const ids = await place([
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 150, y: 0, w: 60, h: 60 },
      { x: 700, y: 0, w: 100, h: 60 },
    ]);

    await press('horizontal');
    const boxes = await boxesOf(ids);

    assert.equal(boxes[0].x, 0, 'the ends stay where they were');
    assert.equal(boxes[2].x, 700);
    assert.equal(
      boxes[1].x - (boxes[0].x + boxes[0].w),
      boxes[2].x - (boxes[1].x + boxes[1].w),
      'and the two gaps are the same',
    );
  });

  test('an envelope takes what it holds along with it', async () => {
    const inside = await page.eval(`(() => {
      const envelope = app.board.add('envelope', { x: 400, y: 0, w: 300, h: 200 });
      const card = app.board.add('card', { x: 450, y: 40, w: 100, h: 60 });
      const other = app.board.add('card', { x: 0, y: 0, w: 100, h: 60 });
      app.selection.set([envelope.id, other.id]);
      return { envelope: envelope.id, card: card.id };
    })()`);

    await press('left');
    const [envelope, card] = await boxesOf([inside.envelope, inside.card]);

    assert.equal(envelope.x, 0, 'the envelope moved');
    assert.equal(card.x, 50, 'and the card inside it kept its place in it');
  });

  /** An arrow has no box; a selection holding one must not write NaN anywhere. */
  test('an arrow in the selection is left out of it', async () => {
    const ids = await place([
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 400, y: 200, w: 100, h: 60 },
    ]);
    const arrow = await page.eval(`(() => {
      const made = app.board.connect('${ids[0]}', '${ids[1]}');
      app.selection.set(['${ids[0]}', '${ids[1]}', made.id]);
      return made.id;
    })()`);

    await press('top');
    assert.deepEqual((await boxesOf(ids)).map((box) => box.y), [0, 0]);
    assert.equal(await page.eval(`app.store.get('${arrow}').y`), undefined);
  });
});
