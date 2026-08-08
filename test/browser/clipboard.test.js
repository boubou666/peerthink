// Copy and paste, on the system clipboard.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

const CTRL = 2; // CDP modifier bitmask

describe('clipboard', () => {
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

  /** Blank board, camera at 1:1 with the origin at the top-left, nothing focused. */
  beforeEach(async () => {
    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
    await page.eval(`
      app.store.load({ order: [], objects: [] });
      app.selection.clear();
      app.viewport.x = 0; app.viewport.y = 0; app.viewport.scale = 1; app.viewport.emit();
      document.activeElement?.blur?.();
    `);
    await page.sleep(60);
  });

  /**
   * Create an object and step out of the field the app focuses for you — every
   * shortcut, this one included, is deliberately inert while typing.
   */
  const add = async (type, props = {}) => {
    const id = await page.eval(`app.board.add(${JSON.stringify(type)}, ${JSON.stringify(props)}).id`);
    await page.eval('document.activeElement?.blur?.()');
    return id;
  };

  const objects = () =>
    page.eval('app.store.all().map(({ id, type, x, y, w, h }) => ({ id, type, x, y, w, h }))');

  const selected = () => page.eval('[...app.selection.ids]');

  /**
   * A real keystroke, with the editing command a browser attaches to it.
   *
   * `commands` is what makes this the actual clipboard: the keystroke goes
   * through the browser's own copy and paste, against the real system
   * clipboard, rather than a `ClipboardEvent` this test built. Nothing else can
   * tell us that the handlers are reached at all — which is the one thing a
   * synthetic event cannot check, and the way this feature could be wholly
   * broken with every other test in this file passing.
   */
  const command = async (key, code, vk, commands) => {
    await page.session.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers: CTRL, commands,
    });
    await page.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: CTRL,
    });
    await page.sleep(120);
  };

  const copyKey = () => command('c', 'KeyC', 67, ['copy']);
  const pasteKey = () => command('v', 'KeyV', 86, ['paste']);

  /** Paste something built here, since a test cannot put a file on the clipboard. */
  const pasteText = (text) => page.eval(`(() => {
    const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(text)});
    document.body.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
  })()`);

  /** What our own `copy` handler puts on a clipboard, without touching the real one. */
  const copyToTransfer = () => page.eval(`(() => {
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return { text: data.getData('text/plain'), prevented: event.defaultPrevented };
  })()`);

  describe('through the real clipboard', () => {
    test('copying and pasting a card puts a second one on the board', async () => {
      const id = await add('card', { x: 0, y: 0, w: 100, h: 60, text: 'ferry' });
      await page.eval(`app.selection.set(['${id}'])`);

      await copyKey();
      await pasteKey();

      await page.waitFor('app.store.order.length === 2', { label: 'the pasted card to land' });
      const all = await objects();
      const pasted = all.find((obj) => obj.id !== id);
      assert.equal(await page.eval(`app.store.get('${pasted.id}').text`), 'ferry');
      assert.deepEqual(await selected(), [pasted.id], 'and is what is now selected');
    });

    test('pasting again makes a third: the clipboard keeps what was copied', async () => {
      const id = await add('card', { x: 0, y: 0, w: 100, h: 60 });
      await page.eval(`app.selection.set(['${id}'])`);

      await copyKey();
      await pasteKey();
      await pasteKey();

      await page.waitFor('app.store.order.length === 3', { label: 'both pasted cards to land' });
    });
  });

  describe('copying', () => {
    test('writes the selection, and takes the event', async () => {
      const id = await add('card', { x: 0, y: 0, w: 100, h: 60, text: 'one' });
      await page.eval(`app.selection.set(['${id}'])`);

      const { text, prevented } = await copyToTransfer();
      assert.ok(prevented, 'the browser is told we have handled it');
      const payload = JSON.parse(text);
      assert.equal(payload.objects.length, 1);
      assert.equal(payload.objects[0].text, 'one');
    });

    test('an envelope carries what it holds', async () => {
      const inside = await add('card', { x: 150, y: 150, w: 100, h: 80 });
      const outside = await add('card', { x: 900, y: 900, w: 100, h: 80 });
      const envelope = await add('envelope', { x: 100, y: 100, w: 400, h: 300 });
      await page.eval(`app.selection.set(['${envelope}'])`);

      const { text } = await copyToTransfer();
      const ids = JSON.parse(text).objects.map((obj) => obj.id);
      assert.deepEqual(ids, [envelope, inside], 'the envelope, and the card in it');
      assert.ok(!ids.includes(outside));
    });

    /** An unprevented copy of nothing is the browser's to handle, and it copies nothing. */
    test('with nothing selected, the event is left alone', async () => {
      const { text, prevented } = await copyToTransfer();
      assert.equal(prevented, false);
      assert.equal(text, '');
    });

    test('a copy inside a text field is the field’s', async () => {
      const id = await add('card', { x: 0, y: 0, text: 'in the card' });
      await page.eval(`app.selection.set(['${id}'])`);
      await page.eval(`document.querySelector('[data-id="${id}"] [contenteditable]').focus()`);

      const from = await page.eval(`(() => {
        const data = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        document.activeElement.dispatchEvent(event);
        return { text: data.getData('text/plain'), prevented: event.defaultPrevented };
      })()`);

      assert.equal(from.prevented, false, 'the browser copies the text, we stay out of it');
      assert.equal(from.text, '');
    });
  });

  describe('pasting objects', () => {
    const payloadFor = async (props) => {
      const id = await add('card', { w: 100, h: 60, ...props });
      await page.eval(`app.selection.set(['${id}'])`);
      const { text } = await copyToTransfer();
      await page.eval(`app.store.apply([{ t: 'del', id: '${id}' }]); app.selection.clear()`);
      return text;
    };

    test('lands under the pointer', async () => {
      const payload = await payloadFor({ x: 0, y: 0 });
      await page.mouse('mouseMoved', 500, 400);
      await page.sleep(30);

      await pasteText(payload);
      await page.waitFor('app.store.order.length === 1', { label: 'the pasted card to land' });

      const [pasted] = await objects();
      // The camera is at the origin at 1:1, so stage and world coordinates are
      // the same number, and the card is centred on the pointer.
      assert.deepEqual({ x: pasted.x, y: pasted.y }, { x: 450, y: 370 });
    });

    test('lands in the middle of the view when the pointer is not on the board', async () => {
      const payload = await payloadFor({ x: 0, y: 0 });
      // Onto the header, which sits over the stage without being part of it —
      // so the board stops having a pointer.
      await page.mouse('mouseMoved', 500, 400);
      await page.sleep(20);
      await page.eval(`(() => {
        const box = document.querySelector('.board-bar-title').getBoundingClientRect();
        return { x: box.left + 4, y: box.top + 4 };
      })()`).then(({ x, y }) => page.mouse('mouseMoved', x, y));
      await page.sleep(30);

      await pasteText(payload);
      await page.waitFor('app.store.order.length === 1', { label: 'the pasted card to land' });

      const [pasted] = await objects();
      const centre = await page.eval(`(({ x, y }) => ({ x, y }))(app.viewport.center(
        document.getElementById('stage').clientWidth,
        document.getElementById('stage').clientHeight,
      ))`);
      assert.deepEqual(
        { x: pasted.x, y: pasted.y },
        { x: Math.round(centre.x - 50), y: Math.round(centre.y - 30) },
      );
    });

    /**
     * Followed by a paste that does land, rather than by a delay.
     *
     * Asserting that nothing happened has no condition of its own to wait for —
     * so this waits for something that *would* have happened by then: a second
     * paste, through the same handler, arriving after it. If the paragraph had
     * added anything there would be two objects here rather than one.
     */
    test('text that is not ours does nothing at all', async () => {
      const ours = await payloadFor({ x: 0, y: 0 });

      await pasteText('Just a paragraph somebody copied from a web page.');
      await pasteText(ours);
      await page.waitFor('app.store.order.length > 0', { label: 'the paste that should land' });

      assert.equal((await objects()).length, 1, 'the paragraph put something on the board');
    });

    test('a paste into a card being edited is text, not objects', async () => {
      const payload = await payloadFor({ x: 0, y: 0, text: '' });
      const id = await add('card', { x: 0, y: 0, text: '' });
      const field = `document.querySelector('[data-id="${id}"] [data-field="text"]')`;
      await page.eval(`${field}.focus()`);

      await page.eval(`(() => {
        const data = new DataTransfer();
        data.setData('text/plain', ${JSON.stringify('pasted words')});
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: data, bubbles: true, cancelable: true,
        }));
      })()`);
      await page.waitFor(`/pasted words/.test(${field}.innerText)`, {
        label: 'the words to arrive in the field',
      });

      assert.equal((await objects()).length, 1, 'nothing was added to the board');
      // Guard against pasting our own payload as text and calling it a pass.
      assert.ok(!payload.includes('pasted words'));
    });
  });

  describe('pasting an image', () => {
    /** A paste carrying a file, which is how a picture arrives from anywhere. */
    const pasteFile = (bytes, type, name = 'shot.png') => page.eval(`(async () => {
      const blob = ${bytes};
      const data = new DataTransfer();
      data.items.add(new File([blob], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
      document.body.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data, bubbles: true, cancelable: true,
      }));
    })()`);

    /** A real PNG, made in the page: `w` × `h` of one flat colour. */
    const png = (w, h) => `await new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = ${w}; canvas.height = ${h};
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f0378a';
      ctx.fillRect(0, 0, ${w}, ${h});
      canvas.toBlob(resolve, 'image/png');
    })`;

    test('becomes an image object, sized from the picture and selected', async () => {
      await page.mouse('mouseMoved', 400, 300);
      await page.sleep(30);
      await pasteFile(png(200, 100), 'image/png');
      await page.waitFor('app.store.order.length === 1', { label: 'the image to land' });

      const [image] = await objects();
      assert.equal(image.type, 'image');
      assert.deepEqual({ w: image.w, h: image.h }, { w: 200, h: 100 });
      assert.deepEqual({ x: image.x, y: image.y }, { x: 300, y: 250 }, 'centred on the pointer');
      assert.deepEqual(await selected(), [image.id]);

      const src = await page.eval(`app.store.get('${image.id}').src`);
      assert.match(src, /^data:image\/png;base64,/, 'a small PNG is kept as it came');
    });

    test('is drawn as an img the picture actually loaded into', async () => {
      await pasteFile(png(80, 60), 'image/png');
      await page.waitFor('app.store.order.length === 1', { label: 'the image to land' });
      const [image] = await objects();

      await page.waitFor(
        `(() => {
          const img = document.querySelector('[data-id="${image.id}"] img');
          return Boolean(img && img.complete && img.naturalWidth === 80);
        })()`,
        { label: 'the picture to decode in the DOM' },
      );
    });

    test('a picture larger than the ceiling is stored smaller', async () => {
      const stored = await page.eval(`(async () => {
        const { createImageImport } = await import('/src/platform/images.js');
        const images = createImageImport({ document, window, maxPixels: 40 });
        const blob = ${png(400, 200)};
        return images.read(blob);
      })()`);
      assert.deepEqual({ w: stored.w, h: stored.h }, { w: 40, h: 20 });
      assert.match(stored.src, /^data:image\/webp;base64,/, 're-encoded, not kept');
    });

    /**
     * The fall-through for a type the browser decodes and this app does not
     * render: the canvas turns it into one that is, metadata and all left
     * behind.
     */
    test('a picture of a type the board cannot hold is re-encoded, not refused', async () => {
      const stored = await page.eval(`(async () => {
        const { createImageImport } = await import('/src/platform/images.js');
        const images = createImageImport({ document, window });
        const png = ${png(30, 20)};
        // The same bytes, announced as a type isImageSource does not accept.
        const blob = new Blob([await png.arrayBuffer()], { type: 'image/bmp' });
        return images.read(blob);
      })()`);
      assert.match(stored.src, /^data:image\/webp;base64,/);
      assert.deepEqual({ w: stored.w, h: stored.h }, { w: 30, h: 20 });
    });

    test('a budget nothing fits in answers with nothing rather than half a picture', async () => {
      const stored = await page.eval(`(async () => {
        const { createImageImport } = await import('/src/platform/images.js');
        const images = createImageImport({ document, window, maxLength: 80 });
        return images.read(${png(300, 300)});
      })()`);
      assert.equal(stored, null);
    });

    test('and says so, once, however many files were refused', async () => {
      await pasteFile(`new Blob([new Uint8Array([1, 2, 3, 4])])`, 'image/png', 'not-really.png');
      await page.waitFor(`document.querySelector('[data-board-notice]') !== null`, {
        label: 'the board to say the paste produced nothing',
      });
      assert.match(
        await page.eval(`document.querySelector('[data-board-notice]').textContent`),
        /could not paste that image/i,
      );
      assert.deepEqual(await objects(), [], 'and nothing was added');

      await page.eval(`document.querySelector('[data-action="dismiss-notice"]').click()`);
      await page.waitFor(`document.querySelector('[data-board-notice]') === null`, {
        label: 'the notice to be dismissed',
      });
    });

    test('several at once cascade rather than stacking, and are all selected', async () => {
      await page.mouse('mouseMoved', 400, 300);
      await page.sleep(30);
      await page.eval(`(async () => {
        const one = ${png(40, 40)};
        const two = ${png(60, 60)};
        const data = new DataTransfer();
        data.items.add(new File([one], 'a.png', { type: 'image/png' }));
        data.items.add(new File([two], 'b.png', { type: 'image/png' }));
        document.body.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: data, bubbles: true, cancelable: true,
        }));
      })()`);
      await page.waitFor('app.store.order.length === 2', { label: 'both images to land' });

      const [first, second] = await objects();
      assert.equal(second.x - first.x, (first.w - second.w) / 2 + 24);
      assert.equal((await selected()).length, 2);
    });

    /** The picture is what was copied; the file name that came with it is not. */
    test('a clipboard holding both an image and text takes the image', async () => {
      await page.eval(`(async () => {
        const blob = ${png(50, 50)};
        const data = new DataTransfer();
        data.setData('text/plain', 'shot.png');
        data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
        document.body.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: data, bubbles: true, cancelable: true,
        }));
      })()`);
      await page.waitFor('app.store.order.length === 1', { label: 'the image to land' });
      assert.equal((await objects())[0].type, 'image');
    });

    test('a file that is not a picture at all is left to the browser', async () => {
      await page.eval(`(() => {
        const data = new DataTransfer();
        data.items.add(new File(['id,name\\n1,one'], 'rows.csv', { type: 'text/csv' }));
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        window.__prevented = event.defaultPrevented;
      })()`);
      await page.sleep(80);
      assert.deepEqual(await objects(), []);
      assert.equal(await page.eval('window.__prevented'), false);
    });
  });

  /**
   * An image object survives a save and a reload like anything else — the
   * picture is in the document, so there is nothing else for it to depend on.
   */
  test('a pasted image is still there after a reload', async () => {
    await page.eval(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 40; canvas.height = 30;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#2f6df6';
      ctx.fillRect(0, 0, 40, 30);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data, bubbles: true, cancelable: true,
      }));
    })()`);
    await page.waitFor('app.store.order.length === 1', { label: 'the image to land' });
    await page.eval('app.autosave.flush()');

    await page.goto();
    await page.waitFor('app.store.order.length === 1', { label: 'the board to come back' });
    const [image] = await objects();
    assert.equal(image.type, 'image');
    assert.match(await page.eval(`app.store.get('${image.id}').src`), /^data:image\/png;base64,/);
  });
});
