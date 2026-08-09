// The map in the corner: what it draws, where it sends you, and folding it away.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('the map', () => {
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
    /**
     * And a camera in a known place. Loading frames whatever was restored, and
     * a board flushed on the way out of the *previous* test can be restored
     * into this one — which left the view zoomed out far enough to cover the
     * whole sheet, and a map whose rectangle covers everything tints every mark
     * on it. Every test here is about where the camera is, so it starts
     * somewhere stated.
     */
    await page.eval('app.viewport.scale = 1; app.viewport.moveTo(0, 0)');
  });

  const CANVAS = '[data-minimap-canvas]';
  const TOGGLE = '[data-action="minimap-toggle"]';

  const box = () => page.eval(`(() => {
    const el = document.querySelector('${CANVAS}');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  })()`);

  /** Where the camera is looking, in world coordinates. */
  const looking = () => page.eval(`(() => {
    const stage = document.getElementById('stage');
    const view = app.viewport.visibleRect(stage.clientWidth, stage.clientHeight);
    return { x: view.x, y: view.y, w: view.w, h: view.h, cx: view.x + view.w / 2, cy: view.y + view.h / 2 };
  })()`);

  /**
   * What the map has to cover, worked out here rather than asked of the code
   * under test: everything on the sheet, and the part being looked at.
   */
  const region = async () => {
    const view = await looking();
    const bounds = await page.eval('app.board.bounds()');
    if (!bounds) return view;

    const x = Math.min(bounds.x, view.x);
    const y = Math.min(bounds.y, view.y);
    return {
      x,
      y,
      w: Math.max(bounds.x + bounds.w, view.x + view.w) - x,
      h: Math.max(bounds.y + bounds.h, view.y + view.h) - y,
    };
  };

  const addCard = (props) =>
    page.eval(`app.board.add('card', ${JSON.stringify(props)}).id`);

  /**
   * Everything the map is painted, as an encoded copy of it.
   *
   * The whole image rather than a checksum of it: two different maps that hash
   * alike is a test that passes for a reason nobody chose, and a PNG of a
   * hundred-odd square pixels is small enough to simply compare.
   */
  const SIGNATURE = `document.querySelector('${CANVAS}').toDataURL()`;

  const signature = () => page.eval(SIGNATURE);

  const colourOf = (id) =>
    page.eval(`getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor`);

  /**
   * How many pixels of the map are the colour a card is on the board.
   *
   * The colour is read off the card itself rather than named here, so this asks
   * the question the feature answers — the thing on the sheet and the mark on
   * the map are the same colour — without either side naming a hex.
   */
  const pixelsColoured = (colour) => page.eval(`(() => {
    const [r, g, b] = ${JSON.stringify(colour)}.match(/\\d+/g).slice(0, 3).map(Number);
    const el = document.querySelector('${CANVAS}');
    const data = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;

    let hits = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      if (Math.abs(data[i] - r) < 6 && Math.abs(data[i + 1] - g) < 6 && Math.abs(data[i + 2] - b) < 6) hits++;
    }
    return hits;
  })()`);

  test('is in the corner of the board, opposite the sheets', async () => {
    const map = await box();
    assert.ok(map, 'the map is on screen');
    assert.ok(map.x + map.w > page.width * 0.6, `to the right: ${JSON.stringify(map)}`);
    assert.ok(map.y + map.h > page.height * 0.6, `and at the bottom: ${JSON.stringify(map)}`);
  });

  /**
   * Off to one side, so the mark is outside the view rectangle: that rectangle
   * is drawn last and tints everything under it, which is right on the screen
   * and would make this assertion about the tint rather than the card.
   */
  test('draws what is on the sheet, in the colour it is on the sheet', async () => {
    const id = await addCard({ x: 4000, y: 0, w: 600, h: 400, fill: 'blue' });
    await page.waitFor(`document.querySelector('[data-id="${id}"]') !== null`, { label: 'the card' });

    assert.ok(await pixelsColoured(await colourOf(id)) > 0, 'the card is on the map, in its own colour');
  });

  test('and stops drawing what has gone', async () => {
    const id = await addCard({ x: 4000, y: 0, w: 600, h: 400, fill: 'blue' });
    await page.waitFor(`document.querySelector('[data-id="${id}"]') !== null`, { label: 'the card' });
    const colour = await colourOf(id);
    assert.ok(await pixelsColoured(colour) > 0, 'it was there to begin with');

    await page.eval(`app.store.apply([{ t: 'del', id: '${id}' }])`);
    assert.equal(await pixelsColoured(colour), 0, 'a deleted card leaves the map');
  });

  /**
   * The middle of the box is the middle of what it covers, whatever the scale —
   * so this is the one press whose answer can be predicted without repeating
   * the arithmetic under test.
   */
  test('a press in the middle looks at the middle of everything', async () => {
    await addCard({ x: 2000, y: 1400, w: 300, h: 200 });
    await addCard({ x: -600, y: -400, w: 300, h: 200 });

    const wanted = await region();
    const map = await box();
    await page.click(map.cx, map.cy);

    const now = await looking();
    assert.ok(Math.abs(now.cx - (wanted.x + wanted.w / 2)) < 2, `across: ${now.cx}`);
    assert.ok(Math.abs(now.cy - (wanted.y + wanted.h / 2)) < 2, `down: ${now.cy}`);
  });

  test('a press to one side goes that way', async () => {
    await addCard({ x: 3000, y: 0, w: 300, h: 200 });
    const map = await box();

    await page.click(map.x + map.w - 8, map.cy);
    const right = await looking();

    await page.click(map.x + 8, map.cy);
    const left = await looking();

    assert.ok(left.cx < right.cx, `left of the map is left of the sheet: ${left.cx} < ${right.cx}`);
  });

  test('and a drag across it pans', async () => {
    await addCard({ x: 0, y: 2400, w: 300, h: 200 });
    const map = await box();

    // Measured before the drag, because the press freezes the transform it was
    // made against — the map being dragged on is the map as it was pressed.
    const wanted = await region();
    await page.drag({ x: map.cx, y: map.y + 8 }, { x: map.cx, y: map.y + map.h - 8 });

    const after = await looking();
    assert.ok(after.cy > wanted.y + wanted.h / 2, `the camera followed the pointer down: ${after.cy}`);
  });

  /**
   * What the map covers includes where you are looking, so panning past the
   * edge of the work rescales it — and a scale that changes under a held
   * pointer means the same pixel is a different place each time it is read.
   * Pressed near an edge, that is a board that slides away for as long as the
   * button is down.
   */
  test('holding still on it holds still', async () => {
    await addCard({ x: 0, y: 0, w: 300, h: 200 });
    const map = await box();
    const at = { x: map.x + map.w - 10, y: map.cy };

    await page.mouse('mousePressed', at.x, at.y);
    const first = await looking();

    for (let i = 0; i < 3; i++) await page.mouse('mouseMoved', at.x, at.y);
    const still = await looking();
    await page.mouse('mouseReleased', at.x, at.y);

    assert.ok(Math.abs(still.cx - first.cx) < 1, `the camera stayed put: ${first.cx} → ${still.cx}`);
  });

  /**
   * A press that started on the board is the board's for its whole length.
   * Nothing captures that pointer, so its moves arrive here as soon as it
   * crosses the panel — and whoever is dragging a card past the corner did not
   * ask to be taken somewhere else.
   */
  test('a drag that started on the board is not hijacked by crossing it', async () => {
    const id = await addCard({ x: 0, y: 0, w: 300, h: 200 });
    // Something far away, so the middle of what the map covers is nowhere near
    // where the camera already is: a hijacked press at the middle of the map
    // would otherwise ask for the position the camera is in and prove nothing.
    await addCard({ x: 3000, y: 2000, w: 300, h: 200 });
    await page.waitFor(`document.querySelector('[data-id="${id}"]') !== null`, { label: 'the card' });

    const card = await page.rect(id);
    const map = await box();
    const before = await looking();

    await page.drag({ x: card.cx, y: card.cy }, { x: map.cx, y: map.cy });

    const after = await looking();
    assert.equal(after.x, before.x, 'the camera did not move across');
    assert.equal(after.y, before.y, 'nor down');
  });

  /**
   * The panel is over the stage, and the stage turns a press on empty space
   * into a marquee that clears the selection. A map that deselected whatever
   * you were working on every time you used it would be unusable with a
   * selection, which is most of the time.
   */
  test('using it does not disturb what is selected', async () => {
    const id = await addCard({ x: 0, y: 0, w: 300, h: 200 });
    await page.eval(`app.selection.set(['${id}'])`);

    const map = await box();
    await page.click(map.cx, map.cy);

    assert.deepEqual(await page.eval('app.selection.list()'), [id]);
  });

  /**
   * The theme is the operating system's — there is no switch in the app — so it
   * can change under a page that is already open. Everything else on screen is
   * CSS and follows for free; a canvas holds the colours it was painted with.
   */
  test('follows the theme when the machine changes it', async () => {
    await addCard({ x: 900, y: 600, w: 300, h: 200 });

    try {
      // Light first, and asserted: whichever theme the machine running this is
      // in, the change below has to be a change. Without it, a dark machine
      // emulates dark, nothing happens, and the test says so for the wrong
      // reason.
      await page.session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      });
      await page.waitFor(
        `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#2f6df6'`,
        { label: 'the light theme to start from' },
      );

      // Kept in the page so the comparison below is against the image itself
      // rather than a few kilobytes of data URL sent back and forth.
      await page.eval(`window.__mapWas = ${SIGNATURE}`);
      const before = await signature();

      await page.session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      });

      // The painting is what is under test, so that is what is waited for —
      // the tokens changing is the browser's part and lands a moment earlier.
      await page.waitFor(`${SIGNATURE} !== window.__mapWas`, {
        label: 'the map to be painted in the theme now in force',
        context: `getComputedStyle(document.documentElement).getPropertyValue('--accent')`,
      });
      assert.notEqual(await signature(), before);
    } finally {
      // Back to the machine's own answer whatever happened: the whole file
      // shares one page, and a dark board would follow this test into the
      // next one.
      await page.session.send('Emulation.setEmulatedMedia', { features: [] });
    }
  });

  describe('minimized', () => {
    const minimize = async () => {
      await page.eval(`document.querySelector('${TOGGLE}').click()`);
      await page.waitFor(`document.querySelector('${CANVAS}') === null`, { label: 'the map to fold away' });
    };

    test('folds the map away, leaving a way back', async () => {
      await minimize();

      assert.equal(await page.eval(`document.querySelector('[data-minimap]').dataset.minimap`), 'closed');
      assert.equal(await page.eval(`document.querySelector('${TOGGLE}').textContent`), 'Map');

      await page.eval(`document.querySelector('${TOGGLE}').click()`);
      await page.waitFor(`document.querySelector('${CANVAS}') !== null`, { label: 'the map to come back' });
    });

    test('and stays folded away on the next visit', async () => {
      await minimize();

      await page.goto();
      await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
      await page.waitFor(`document.querySelector('${TOGGLE}') !== null`, { label: 'the panel' });

      assert.equal(await page.eval(`document.querySelector('${CANVAS}') === null`), true);
    });

    test('while a browser with no memory of it shows it', async () => {
      await page.eval('localStorage.clear()');
      await page.goto();
      await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });

      await page.waitFor(`document.querySelector('${CANVAS}') !== null`, { label: 'the map' });
    });
  });
});
