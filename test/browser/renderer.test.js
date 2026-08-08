import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('renderer', () => {
  let page;

  before(async () => {
    page = await openApp();
    await page.eval('localStorage.clear()');
    await page.goto();
  });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  const add = (type, props = {}) => page.eval(`app.board.add(${JSON.stringify(type)}, ${JSON.stringify(props)}).id`);

  test('renders one element per object, tagged with its id and type', async () => {
    const counts = await page.eval(`({
      objects: app.store.order.length,
      elements: document.querySelectorAll('#layer .obj').length,
      typed: [...document.querySelectorAll('#layer .obj')].every(el => el.dataset.id && el.dataset.type)
    })`);
    assert.equal(counts.elements, counts.objects);
    assert.ok(counts.typed);
  });

  test('every object carries eight resize handles', async () => {
    const id = await add('card', { x: 0, y: 0 });
    assert.equal(await page.eval(`document.querySelectorAll('[data-id="${id}"] .handle').length`), 8);
  });

  test('positions and sizes elements from the model', async () => {
    const id = await add('card', { x: 120, y: 40, w: 210, h: 90 });
    const style = await page.eval(`(({left,top,width,height}) => ({left,top,width,height}))(document.querySelector('[data-id="${id}"]').style)`);
    assert.deepEqual(style, { left: '120px', top: '40px', width: '210px', height: '90px' });
  });

  /**
   * The corner token is set here rather than in each view, so this is the one
   * place it is checked for every type at once.
   */
  test('every type carries its corner style as an attribute', async () => {
    for (const type of ['card', 'envelope', 'list']) {
      const round = await add(type, { x: 0, y: 0 });
      const square = await add(type, { x: 0, y: 400, corners: 'square' });
      assert.equal(await page.eval(`document.querySelector('[data-id="${round}"]').dataset.corners`), 'round');
      assert.equal(await page.eval(`document.querySelector('[data-id="${square}"]').dataset.corners`), 'square');
    }
  });

  describe('an image', () => {
    // A one-pixel PNG, small enough to write down.
    const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

    const srcOf = (id) =>
      page.eval(`document.querySelector('[data-id="${id}"] img').getAttribute('src')`);

    test('draws the picture it carries', async () => {
      const id = await add('image', { x: 0, y: 0, w: 40, h: 30, src: PIXEL });
      assert.equal(await srcOf(id), PIXEL);
      assert.equal(await page.eval(`document.querySelector('[data-id="${id}"] img').draggable`), false);
    });

    /**
     * An object arrives over the board's channel from anyone authorised to edit
     * it. A remote URL in an `img` is a request this browser would make to a
     * host of somebody else's choosing, so it is not made at all — and the
     * attribute is *absent* rather than empty, because an empty `src` is a
     * request for the page itself.
     */
    test('is not drawn from anywhere but the document', async () => {
      for (const src of ['https://example.test/pixel.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 42]) {
        const id = await page.eval(
          `app.board.add('image', { x: 0, y: 0, w: 40, h: 30, src: ${JSON.stringify(src)} }).id`,
        );
        assert.equal(await srcOf(id), null, String(src));
      }
    });

    test('and a source that changes is followed', async () => {
      const id = await add('image', { x: 0, y: 0, w: 40, h: 30, src: 'https://example.test/pixel.png' });
      assert.equal(await srcOf(id), null);

      await page.eval(`app.store.apply([{ t: 'set', id: '${id}', patch: { src: ${JSON.stringify(PIXEL)} } }])`);
      await page.waitFor(
        `document.querySelector('[data-id="${id}"] img').getAttribute('src') !== null`,
        { label: 'the picture to arrive' },
      );
      assert.equal(await srcOf(id), PIXEL);
    });
  });

  test('deleting an object removes its element', async () => {
    const id = await add('card', { x: 0, y: 0 });
    await page.eval(`app.store.apply([{ t: 'del', id: "${id}" }])`);
    assert.equal(await page.eval(`document.querySelector('[data-id="${id}"]')`), null);
  });

  test('DOM order tracks z-order', async () => {
    const a = await add('card', { x: 0, y: 0 });
    const b = await add('card', { x: 0, y: 0 });
    const domOrder = () => page.eval(`[...document.querySelectorAll('#layer .obj')].map(el => el.dataset.id)`);

    let order = await domOrder();
    assert.ok(order.indexOf(a) < order.indexOf(b));

    await page.eval(`app.board.raise(["${a}"])`);
    order = await domOrder();
    assert.ok(order.indexOf(a) > order.indexOf(b), 'raising a moves its element after b');
  });

  test('a full reload of the model rebuilds every element', async () => {
    const snapshot = await page.eval('JSON.stringify(app.store.toJSON())');
    await page.eval(`app.store.load({ order: [], objects: [] })`);
    assert.equal(await page.eval(`document.querySelectorAll('#layer .obj').length`), 0);
    await page.eval(`app.store.load(JSON.parse(${JSON.stringify(snapshot)}))`);
    assert.ok(await page.eval(`document.querySelectorAll('#layer .obj').length > 0`));
  });

  describe('camera', () => {
    test('writes a single transform and exposes the scale as --z', async () => {
      await page.eval('app.viewport.setScaleAt(0, 0, 2)');
      const state = await page.eval(`({
        transform: document.getElementById("layer").style.transform,
        z: document.getElementById("layer").style.getPropertyValue('--z')
      })`);
      assert.match(state.transform, /scale\(2\)/);
      assert.equal(state.z, '2');
    });

    test('the dot grid follows the camera and fades out when far away', async () => {
      await page.eval('app.viewport.setScaleAt(0, 0, 1)');
      assert.equal(await page.eval(`document.getElementById('bg').style.backgroundSize`), '20px 20px');
      assert.equal(await page.eval(`document.getElementById('bg').style.opacity`), '1');

      await page.eval('app.viewport.setScaleAt(0, 0, 0.2)');
      assert.equal(await page.eval(`document.getElementById('bg').style.opacity`), '0');
      await page.eval('app.viewport.setScaleAt(0, 0, 1)');
    });

    test('resizing the stage re-runs the transform', async () => {
      await page.session.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
      await page.sleep(150);
      assert.ok(await page.eval(`document.getElementById("layer").style.transform.length > 0`));
      await page.session.send('Emulation.setDeviceMetricsOverride', { width: page.width, height: page.height, deviceScaleFactor: 1, mobile: false });
      await page.sleep(150);
    });
  });

  describe('culling', () => {
    test('hides objects far outside the viewport and restores them', async () => {
      const far = await add('card', { x: 400_000, y: 400_000 });
      const hidden = () => page.eval(`document.querySelector('[data-id="${far}"]').hidden`);

      await page.eval(`app.viewport.x = 0; app.viewport.y = 0; app.viewport.scale = 1; app.viewport.emit();`);
      await page.sleep(120);
      assert.equal(await hidden(), true, 'far away, so not rendered');

      await page.eval(`app.viewport.x = 400000; app.viewport.y = 400000; app.viewport.emit();`);
      await page.sleep(120);
      assert.equal(await hidden(), false, 'panning to it brings it back');

      await page.eval(`app.store.apply([{ t: 'del', id: "${far}" }]); app.viewport.x = 0; app.viewport.y = 0; app.viewport.emit();`);
      await page.eval('app.commands.fit()');
      await page.sleep(120);
    });
  });

  describe('selection', () => {
    test('marks selected objects and shows handles only for a single one', async () => {
      const a = await add('card', { x: 0, y: 0 });
      const b = await add('card', { x: 300, y: 0 });
      const classesOf = (id) => page.eval(`[...document.querySelector('[data-id="${id}"]').classList]`);

      await page.eval(`app.selection.set(["${a}"])`);
      assert.ok((await classesOf(a)).includes('selected'));
      assert.ok((await classesOf(a)).includes('handles-on'));

      await page.eval(`app.selection.set(["${a}", "${b}"])`);
      assert.ok((await classesOf(a)).includes('selected'));
      assert.ok(!(await classesOf(a)).includes('handles-on'), 'no handles for a multi-selection');

      await page.eval('app.selection.clear()');
      assert.ok(!(await classesOf(a)).includes('selected'));
    });
  });
});
