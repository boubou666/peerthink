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

  /**
   * A line is a relation between two cards and belongs behind them. It is also
   * the one part of the layer the renderer does not own: it rewrites the order
   * of the children it draws on every sync, so anything parked at the front of
   * that list is pushed to the back of it — and painted over the board.
   */
  test('the line is drawn behind the objects, and stays there', async () => {
    await twoCards();
    await offered();
    await clickControl();
    await page.waitFor(`document.querySelector('.connectors [data-id]') !== null`, { label: 'the arrow' });

    const line = await drawn();
    // A third card, dropped on the middle of the line — and made after the
    // arrow, so the renderer has re-ordered the layer since it was built.
    await page.eval(`(() => {
      const at = app.viewport.toWorld(${Math.round(line.cx)} - document.getElementById('stage').getBoundingClientRect().left, ${Math.round(line.cy)});
      app.board.add('card', { x: Math.round(at.x) - 60, y: Math.round(at.y) - 40, w: 120, h: 80 });
    })()`);
    /**
     * Deselected before asking. A selected object is lifted by `z-index: 1`,
     * which would put it over the line whatever the layer did — and that is a
     * different rule being tested by accident.
     */
    await page.eval('app.selection.clear()');

    const over = await page.eval(`(() => {
      const el = document.elementFromPoint(${Math.round(line.cx)}, ${Math.round(line.cy)});
      return { type: el?.closest?.('[data-id]')?.dataset?.type ?? null, cls: el?.getAttribute?.('class') ?? null };
    })()`);

    assert.equal(over.type, 'card', `the card is on top of the line, not under it: ${JSON.stringify(over)}`);
  });

  describe('dragging one out of an object', () => {
    const handleOf = (id, dir = 'e') => page.eval(`(() => {
      const el = document.querySelector('[data-id="${id}"] .connect-handle[data-connect="${dir}"]');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

    const shown = (id) => page.eval(
      `getComputedStyle(document.querySelector('[data-id="${id}"] .connect-handles')).display`,
    );

    const PREVIEW = `document.querySelector('.connector-preview').style.display`;

    /** Put the pointer on an object and wait for what that offers to appear. */
    const hover = async (id, at) => {
      await page.mouse('mouseMoved', at.x, at.y);
      await page.waitFor(`getComputedStyle(document.querySelector('[data-id="${id}"] .connect-handles')).display === 'block'`, {
        label: 'the handles to be offered',
      });
    };

    const hoverOn = async (id) => {
      const box = await page.rect(id);
      await hover(id, { x: box.cx, y: box.cy });
    };

    /**
     * Press a handle, move through the points given, and release at the last.
     *
     * Waited on twice, at the two moments that mean something. After the first
     * move, for the arrow to be *being drawn*: the preview is hidden before a
     * press as well as after one, so a test that only waited for it to be gone
     * would pass whether or not the gesture ever started — and every assertion
     * about what a drag did would be about a drag that did not happen. Then
     * after the release, for it to be gone again, which is true whether an
     * arrow was made or not.
     *
     * The moves in between are not waited on: CDP dispatches them in order and
     * the release is processed after them.
     */
    const dragFrom = async (at, [first, ...rest]) => {
      await page.mouse('mousePressed', at.x, at.y);

      await page.mouse('mouseMoved', first.x, first.y, { buttons: 1 });
      await page.waitFor(`${PREVIEW} !== 'none'`, { label: 'the arrow being drawn' });

      for (const point of rest) await page.mouse('mouseMoved', point.x, point.y, { buttons: 1 });

      const last = rest[rest.length - 1] ?? first;
      await page.mouse('mouseReleased', last.x, last.y);
      await page.waitFor(`${PREVIEW} === 'none'`, { label: 'the gesture to end' });
    };

    test('the handles are there on hover, and not before it', async () => {
      const [a] = await twoCards();
      await page.eval('app.selection.clear()');

      await page.mouse('mouseMoved', 5, 400);
      await page.waitFor(`getComputedStyle(document.querySelector('[data-id="${a}"] .connect-handles')).display === 'none'`, {
        label: 'nothing offered until the pointer is on it',
      });

      await hoverOn(a);
      assert.equal(await shown(a), 'block');
    });

    test('and not while its text is being edited, where the pointer is a caret', async () => {
      const [a] = await twoCards();
      await page.eval(`document.querySelector('[data-id="${a}"] [contenteditable]').focus()`);

      const box = await page.rect(a);
      await page.mouse('mouseMoved', box.cx, box.cy);
      await page.waitFor(`getComputedStyle(document.querySelector('[data-id="${a}"] .connect-handles')).display === 'none'`, {
        label: 'the handles to stay away',
      });
    });

    test('a drag from one object to another joins them, in that order', async () => {
      const [a, b] = await twoCards();
      await page.eval('app.selection.clear()');

      const target = await page.rect(b);
      await hoverOn(a);
      await dragFrom(await handleOf(a), [{ x: target.cx, y: target.cy }]);

      const made = await connectors();
      assert.equal(made.length, 1);
      assert.deepEqual([made[0].from, made[0].to], [a, b]);
    });

    /**
     * The press belongs to the arrow being drawn, not to the card it started
     * on: it must not select it, raise it, or take it for a drag.
     */
    test('and leaves the object it started from alone', async () => {
      const [a, b] = await twoCards();
      await page.eval('app.selection.clear()');
      const before = await page.eval(`app.store.get('${a}').x`);

      const target = await page.rect(b);
      await hoverOn(a);
      await dragFrom(await handleOf(a), [{ x: target.cx, y: target.cy }]);

      assert.equal(await page.eval(`app.store.get('${a}').x`), before, 'it did not move');
      assert.deepEqual(await page.eval('app.selection.list()'), [], 'and it was not selected');
    });

    test('a drag that lands on nothing makes nothing', async () => {
      const [a] = await twoCards();
      await page.eval('app.selection.clear()');

      await hoverOn(a);
      await dragFrom(await handleOf(a), [{ x: 700, y: 600 }]);

      assert.deepEqual(await connectors(), []);
      assert.equal(await page.eval(PREVIEW), 'none', 'and the line it was drawing is gone');
    });

    test('nor does one that lands back on the object it came from', async () => {
      const [a] = await twoCards();
      await page.eval('app.selection.clear()');

      const box = await page.rect(a);
      await hoverOn(a);
      // Out over open board and back, so the arrow is genuinely being drawn
      // before it is dropped where it started — a press and release without
      // the journey would prove nothing about the landing.
      await dragFrom(await handleOf(a), [{ x: box.cx + 240, y: box.cy }, { x: box.cx, y: box.cy }]);

      assert.deepEqual(await connectors(), []);
    });

    test('Escape gives up on the arrow rather than on the selection', async () => {
      const [a, b] = await twoCards();
      await page.eval(`app.selection.set(['${a}'])`);

      const target = await page.rect(b);
      await hoverOn(a);

      const handle = await handleOf(a);
      await page.mouse('mousePressed', handle.x, handle.y);
      await page.mouse('mouseMoved', target.cx, target.cy, { buttons: 1 });
      await page.waitFor(`${PREVIEW} !== 'none'`, { label: 'the arrow being drawn' });

      await page.key('Escape', { code: 'Escape', vk: 27 });
      await page.waitFor(`${PREVIEW} === 'none'`, { label: 'the arrow to be given up on' });
      await page.mouse('mouseReleased', target.cx, target.cy);

      assert.deepEqual(await connectors(), [], 'no arrow was made');
      assert.deepEqual(await page.eval('app.selection.list()'), [a], 'and the selection is where it was');
    });

    /**
     * A selected object that is also hovered shows both sets. They are drawn on
     * the same four edges, so what matters is that neither is standing on the
     * other: the resize handles reach from five pixels outside the border to
     * four inside it, and these start twenty out.
     */
    test('a selected object offers both sets, and each one still does its own job', async () => {
      const [a, b] = await twoCards();
      await page.eval(`app.selection.set(['${a}'])`);
      await hoverOn(a);

      const resize = await page.eval(`(() => {
        const el = document.querySelector('[data-id="${a}"] .handle[data-handle="e"]');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: r.left };
      })()`);
      const connect = await handleOf(a);

      assert.ok(connect.x > resize.left, 'the connector handle is the further out of the two');

      // The resize handle still resizes.
      const before = await page.eval(`app.store.get('${a}').w`);
      await page.drag({ x: resize.x, y: resize.y }, { x: resize.x + 60, y: resize.y });
      assert.ok(await page.eval(`app.store.get('${a}').w`) > before, 'the edge handle resized it');

      // And the connector handle still connects.
      await hoverOn(a);
      const target = await page.rect(b);
      await dragFrom(await handleOf(a), [{ x: target.cx, y: target.cy }]);
      assert.equal((await connectors()).length, 1);
    });

    test('a second drag between the same pair adds nothing', async () => {
      const [a, b] = await twoCards();
      await page.eval('app.selection.clear()');

      const target = await page.rect(b);

      for (let go = 0; go < 2; go++) {
        await hoverOn(a);
        await dragFrom(await handleOf(a), [{ x: target.cx, y: target.cy }]);
      }

      assert.equal((await connectors()).length, 1);
    });
  });

  describe('labels', () => {
    const LABEL = '[data-label] .connector-text';

    const label = () => page.eval(`(() => {
      const el = document.querySelector('${LABEL}');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    })()`);

    const joinTwo = async () => {
      await twoCards();
      await offered();
      await clickControl();
      await page.waitFor(`document.querySelector('.connectors [data-id]') !== null`, { label: 'the arrow' });
      const [made] = await connectors();
      return made.id;
    };

    test('a double-click on the line writes on it', async () => {
      const id = await joinTwo();
      const line = await drawn();

      await page.dblclick(line.cx, line.cy);
      await page.type('blocks');
      await page.waitFor(`app.store.get('${id}').text === 'blocks'`, {
        label: 'the label to reach the document',
        context: `JSON.stringify(app.store.get('${id}'))`,
      });

      await page.eval('document.activeElement.blur()');
      assert.equal((await label()).text, 'blocks', 'and it is drawn on the arrow');
    });

    /**
     * An arrow with nothing written on it still has a field — focusing one is
     * how a label is started — and that field must not stand between the
     * pointer and the line it sits on.
     */
    test('an empty one is invisible and takes no press', async () => {
      const id = await joinTwo();
      const line = await drawn();

      assert.equal((await label()).text, '', 'the field is there');
      assert.equal(
        await page.eval(`getComputedStyle(document.querySelector('${LABEL}')).pointerEvents`),
        'none',
      );

      await page.click(line.cx, line.cy);
      assert.deepEqual(await page.eval('app.selection.list()'), [id], 'the press reached the line');
    });

    test('the bar offers one for a selected arrow, and puts the caret in it', async () => {
      const id = await joinTwo();
      await page.eval(`app.selection.set(['${id}'])`);

      await page.waitFor(`document.querySelector('[data-action="label"]')?.textContent === 'Add label'`, {
        label: 'the label control',
        context: 'document.querySelector("[data-format-bar]")?.innerText ?? "no bar"',
      });
      await page.eval(`document.querySelector('[data-action="label"]').click()`);

      await page.waitFor(`document.activeElement?.classList.contains('connector-text')`, {
        label: 'the caret in the label',
      });

      await page.type('why');
      await page.waitFor(`app.store.get('${id}').text === 'why'`, { label: 'what was typed' });
      await page.waitFor(`document.querySelector('[data-action="label"]')?.textContent === 'Edit label'`, {
        label: 'the control to change its offer',
      });
    });

    test('and it follows the line it is written on', async () => {
      const id = await joinTwo();
      await page.eval(`app.store.apply([{ t: 'set', id: '${id}', patch: { text: 'blocks' } }])`);

      const before = await label();
      await page.eval(`(() => {
        const [a] = app.store.all();
        app.store.apply([{ t: 'set', id: a.id, patch: { y: a.y - 400 } }]);
      })()`);

      assert.ok(Math.abs((await label()).cy - before.cy) > 50, 'the words moved with the arrow');
    });

    test('a URL in one is a link, as it is anywhere else on a board', async () => {
      const id = await joinTwo();
      await page.eval(`app.store.apply([{ t: 'set', id: '${id}', patch: { text: 'see https://example.test/a' } }])`);

      assert.equal(
        await page.eval(`document.querySelector('${LABEL} a[data-link]')?.getAttribute('href')`),
        'https://example.test/a',
      );
    });

    test('and the words go when the arrow does', async () => {
      const id = await joinTwo();
      await page.eval(`app.store.apply([{ t: 'set', id: '${id}', patch: { text: 'blocks' } }])`);
      assert.ok(await label());

      await page.eval(`app.store.apply([{ t: 'del', id: '${id}' }])`);
      assert.equal(await label(), null);
    });
  });

  /**
   * Somebody else deleting a card takes its arrows with it, but the two facts
   * arrive as ops and there is a moment between them — with the arrow selected,
   * the format bar is asking a connector with one end for somewhere to sit.
   */
  test('an arrow whose end goes while it is selected takes nothing down with it', async () => {
    const [a] = await twoCards();
    await offered();
    await clickControl();
    const [made] = await connectors();

    await page.eval(`app.selection.set(['${made.id}'])`);
    await page.waitFor(`document.querySelector('[data-action="label"]') !== null`, { label: 'the bar' });

    // The `del` alone, without the cascade `deleteSelected` performs — which is
    // exactly the shape of the op another client sends.
    await page.eval(`app.store.apply([{ t: 'del', id: '${a}' }])`);

    // A real condition rather than a couple of frames: the bar has nowhere to
    // sit above an arrow with one end, so it goes.
    await page.waitFor(`document.querySelector('[data-format-bar]') === null`, {
      label: 'the bar to close',
      context: 'document.querySelector("[data-format-bar]")?.innerText ?? "no bar"',
    });

    assert.deepEqual(page.errors, [], 'the render survived a connector with one end');
    assert.equal(await page.eval(`Boolean(window.app?.store)`), true, 'and the board is still there');
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
