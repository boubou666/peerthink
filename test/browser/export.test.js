import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

/**
 * The board, drawn a second time.
 *
 * The export is a renderer that does not share a line with the one on screen,
 * so the thing worth asserting is that it agrees with the stylesheet both of
 * them answer to: a card comes out the colour `canvas.css` gives it, the page
 * background is the page background, and text that does not fit is wrapped
 * rather than run off the edge. Pixels are read back from the context, because
 * a drawing test that only checks the calls were made would pass against a
 * canvas that never painted anything.
 */
describe('export', () => {
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

  /**
   * Paint objects into an offscreen context at 1× and hand back a pixel
   * reader. Scale 1 and no padding keep world units and device pixels the same
   * number, so an assertion can name a coordinate on the board.
   */
  const painted = (objects, probes, { padding = 0, scale = 1 } = {}) => page.eval(`(async () => {
    const { createPngExporter } = await import('/src/platform/export-png.js');
    const { exportFrame } = await import('/src/core/export.js');

    const objects = ${JSON.stringify(objects)};
    const exporter = createPngExporter({ document, window });
    const palette = exporter.readPalette();
    const frame = exportFrame(objects, { padding: ${padding}, scale: ${scale} });

    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    exporter.paint(ctx, objects, frame, palette);

    const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);

    // Resolve a CSS colour to pixels the same way the drawing did, so the
    // comparison is against the stylesheet rather than a hex literal here.
    const swatch = (...css) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const g = c.getContext('2d');
      // Layered in order, so a translucent fill — the envelope's is a
      // color-mix with transparent — is compared against what it actually
      // composites to rather than against its own colour in isolation.
      for (const colour of css) {
        g.fillStyle = colour;
        g.fillRect(0, 0, 1, 1);
      }
      return Array.from(g.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };

    /** The lowest row holding anything that is not the object's own fill. */
    const lastInkedRow = ({ x, y, w, h }, fill) => {
      const base = swatch(fill);
      for (let row = y + h - 1; row >= y; row--) {
        const line = ctx.getImageData(x, row, w, 1).data;
        for (let i = 0; i < line.length; i += 4) {
          if (Math.abs(line[i] - base[0]) > 6
            || Math.abs(line[i + 1] - base[1]) > 6
            || Math.abs(line[i + 2] - base[2]) > 6) return row;
        }
      }
      return -1;
    };

    return await (${probes})({ at, swatch, palette, frame, lastInkedRow });
  })()`);

  test('the page background is the background', async () => {
    const result = await painted(
      [{ id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40, color: 'blue' }],
      `({ at, swatch, palette }) => ({
        corner: at(1, 1),
        expected: swatch(palette.bg),
      })`,
      { padding: 20 },
    );

    assert.deepEqual(result.corner, result.expected);
  });

  test('a card is the colour the stylesheet gives it', async () => {
    for (const color of ['yellow', 'blue', 'green', 'pink']) {
      const result = await painted(
        [{ id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40, color }],
        `({ at, swatch, palette }) => ({
          middle: at(30, 20),
          expected: swatch(palette.card['${color}']),
        })`,
      );

      assert.deepEqual(result.middle, result.expected, `a ${color} card came out another colour`);
    }
  });

  test('a card with no colour is drawn as yellow, like the DOM', async () => {
    const result = await painted(
      [{ id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40 }],
      `({ at, swatch, palette }) => ({ middle: at(30, 20), expected: swatch(palette.card.yellow) })`,
    );

    assert.deepEqual(result.middle, result.expected);
  });

  /**
   * The wrap is the part of this file that reimplements a browser, so it is
   * the part worth pinning: the same text in a narrower card has to use more
   * lines, and a card is `overflow: hidden` so it can never use more than it
   * has room for.
   */
  describe('text', () => {
    const words = 'the quick brown fox jumps over the lazy dog and keeps going';

    /**
     * Scanned inside the card's padding, not across the whole of it: a card
     * has rounded corners and a shadow, so the outer rows differ from the
     * fill everywhere and every measurement would come back as the last row.
     */
    const PAD = 12;
    const inner = (w, h) => `{ x: ${PAD}, y: ${PAD}, w: ${w - PAD * 2}, h: ${h - PAD * 2} }`;

    const inkedTo = (w, h, text) => painted(
      [{ id: 'a', type: 'card', x: 0, y: 0, w, h, color: 'white', text }],
      `({ lastInkedRow, palette }) => lastInkedRow(${inner(w, h)}, palette.card.white)`,
    );

    test('wraps, and a narrower card wraps harder', async () => {
      const wide = await inkedTo(300, 200, words);
      const narrow = await inkedTo(140, 200, words);

      assert.ok(wide > 0, 'the wide card drew no text at all');
      assert.ok(narrow > wide, `narrower card did not wrap further (wide ${wide}, narrow ${narrow})`);
    });

    test('a word longer than the card is broken rather than run off it', async () => {
      const broken = await inkedTo(90, 120, 'Kraftfahrzeughaftpflichtversicherung');
      const short = await inkedTo(90, 120, 'Kraft');

      // Unbroken, every glyph would sit on the first line and the two would
      // reach the same row. Broken, the long word runs down the card.
      assert.ok(broken > short, `the long word was not broken (${broken} vs ${short})`);
    });

    /**
     * Compared against the same card with nothing written on it rather than
     * against the page background: the card casts a shadow, so the pixels
     * below it are not the background and never were. The control differs in
     * one thing only, which is whether there is text to escape.
     */
    test('text is clipped to the card rather than drawn outside it', async () => {
      const card = (text) => [{
        id: 'a', type: 'card', x: 0, y: 0, w: 80, h: 40, color: 'white', text,
      }];
      // frame padding 20 puts world (0,0) at canvas (20,20), so this samples
      // world (40, 50) — ten world units below the bottom of the card
      const probe = `({ at }) => at(60, 70)`;

      const [overfull, empty] = await Promise.all([
        painted(card(words.repeat(4)), probe, { padding: 20 }),
        painted(card(''), probe, { padding: 20 }),
      ]);

      assert.deepEqual(overfull, empty, 'text escaped the card it belongs to');
    });
  });

  test('an object of an unknown type is skipped, not drawn wrong', async () => {
    const result = await painted(
      [
        { id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40, color: 'blue' },
        { id: 'b', type: 'sparkline-from-the-future', x: 70, y: 0, w: 60, h: 40 },
      ],
      `({ at, swatch, palette }) => ({ where: at(100, 20), background: swatch(palette.bg) })`,
    );

    assert.deepEqual(result.where, result.background);
  });

  test('an envelope is drawn behind its contents, with its dashed edge', async () => {
    const result = await painted(
      [
        { id: 'e', type: 'envelope', x: 0, y: 0, w: 200, h: 140, title: 'Grouped' },
        { id: 'c', type: 'card', x: 40, y: 40, w: 100, h: 60, color: 'green' },
      ],
      `({ at, swatch, palette }) => ({
        // inside the envelope but clear of the card it contains
        body: at(180, 120),
        // the envelope's fill is translucent, so what lands on the canvas is
        // it over the page background — which is what to compare against
        envelope: swatch(palette.bg, palette.envelopeBg),
        // the card sits on top of it, opaque
        card: at(90, 70),
        green: swatch(palette.card.green),
      })`,
    );

    assert.deepEqual(result.body, result.envelope, 'the envelope did not paint its background');
    assert.deepEqual(result.card, result.green, 'the envelope painted over the card inside it');
  });

  test('an envelope title is drawn', async () => {
    const [titled, blank] = await Promise.all([
      painted(
        [{ id: 'e', type: 'envelope', x: 0, y: 0, w: 200, h: 140, title: 'Grouped' }],
        `({ lastInkedRow, palette }) => lastInkedRow({ x: 10, y: 10, w: 180, h: 120 }, palette.envelopeBg)`,
      ),
      painted(
        [{ id: 'e', type: 'envelope', x: 0, y: 0, w: 200, h: 140, title: '' }],
        `({ lastInkedRow, palette }) => lastInkedRow({ x: 10, y: 10, w: 180, h: 120 }, palette.envelopeBg)`,
      ),
    ]);

    assert.ok(titled > blank, `the title left no ink (titled ${titled}, blank ${blank})`);
  });

  test('a list draws its title and its rows', async () => {
    const list = (items) => ({
      id: 'l', type: 'list', x: 0, y: 0, w: 200, h: 160, title: 'Today', items,
    });
    // Scanned above the floor: the add button is pinned down there, so a scan
    // to the bottom of the box would measure it and not the rows.
    const probe = `({ lastInkedRow, palette }) =>
      lastInkedRow({ x: 10, y: 10, w: 180, h: 90 }, palette.panel)`;

    const [none, two] = await Promise.all([
      painted([list([])], probe),
      painted([list([
        { id: 'i1', text: 'first', done: false },
        { id: 'i2', text: 'second', done: true },
      ])], probe),
    ]);

    assert.ok(none > 0, 'the list drew nothing at all');
    assert.ok(two > none, `rows did not reach below the title alone (${two} vs ${none})`);
  });

  /**
   * `.list-items` is `flex: 1`, so it takes the slack and the add button after
   * it lands on the floor of the box. Drawn where the rows happen to end, it
   * would sit halfway up a list with room to spare — which is the one place it
   * never is on screen.
   */
  test('the add button is at the bottom of a list, not under the last row', async () => {
    const tall = {
      id: 'l', type: 'list', x: 0, y: 0, w: 200, h: 300, title: 'Today',
      items: [{ id: 'i1', text: 'only one', done: false }],
    };

    const inked = await painted([tall], `({ lastInkedRow, palette }) =>
      lastInkedRow({ x: 10, y: 10, w: 180, h: 280 }, palette.panel)`);

    // the single row ends well inside the top half; only the pinned button
    // can put ink this far down
    assert.ok(inked > 250, `the add button did not reach the floor (last ink at ${inked})`);
  });

  test('a done row is struck through and its box filled', async () => {
    const result = await painted(
      [{
        id: 'l', type: 'list', x: 0, y: 0, w: 200, h: 160, title: 'T',
        items: [{ id: 'i1', text: 'done thing', done: true }],
      }],
      `({ at, swatch, palette }) => {
        // the checkbox of the first row: left padding, below the title
        const scan = [];
        for (let y = 20; y < 80; y++) scan.push([y, at(16, y)]);
        const accent = swatch(palette.accent);
        const hit = scan.find(([, px]) =>
          Math.abs(px[0] - accent[0]) < 12
          && Math.abs(px[1] - accent[1]) < 12
          && Math.abs(px[2] - accent[2]) < 12);
        return { filled: Boolean(hit) };
      }`,
    );

    assert.equal(result.filled, true, 'a done row left its checkbox empty');
  });

  describe('the file', () => {
    test('is a PNG', async () => {
      const head = await page.eval(`(async () => {
        const { createPngExporter } = await import('/src/platform/export-png.js');
        const { exportFrame } = await import('/src/core/export.js');
        const objects = [{ id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40, color: 'blue' }];
        const exporter = createPngExporter({ document, window });
        const blob = await exporter.render(objects, exportFrame(objects));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { type: blob.type, magic: Array.from(bytes.slice(0, 8)) };
      })()`);

      assert.equal(head.type, 'image/png');
      // the PNG signature, which is what makes this a file and not a buffer
      assert.deepEqual(head.magic, [137, 80, 78, 71, 13, 10, 26, 10]);
    });
  });

  /**
   * The button, the download and the two ways it can produce no file. A click
   * that quietly does nothing is indistinguishable from a broken button, so
   * every ending has to say which one it was.
   */
  describe('from the board bar', () => {
    const spyOnDownloads = () => page.eval(`(() => {
      window.__downloads = [];
      if (!window.__realClick) {
        window.__realClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download) window.__downloads.push({ name: this.download, href: this.href });
          else window.__realClick.call(this);
        };
      }
    })()`);

    const clickExport = () => page.eval(`(() => {
      document.querySelector('[data-action="export"]').click();
    })()`);

    beforeEach(async () => {
      await page.eval('localStorage.clear()');
      await page.goto();
      await spyOnDownloads();
    });

    after(async () => {
      await page.eval(`(() => {
        if (window.__realClick) HTMLAnchorElement.prototype.click = window.__realClick;
        window.__realClick = null;
      })()`);
    });

    test('downloads a file named after the board', async () => {
      // Stored rather than typed: rename() has nothing to touch on a board
      // that has only ever been seeded, so the name would not survive the
      // reload this test needs to pick it up.
      await page.eval(`(() => {
        const board = {
          v: 1,
          order: ['c1'],
          objects: [{ id: 'c1', type: 'card', x: 0, y: 0, w: 160, h: 90, text: 'exported' }],
        };
        localStorage.setItem('peerthink:board:default', JSON.stringify({
          v: 1, id: 'default', title: 'Sprint retro', updatedAt: 5, board,
        }));
      })()`);
      await page.goto();
      await page.waitFor(`document.querySelector('.board-bar-title').value === 'Sprint retro'`, {
        label: 'the stored title',
      });
      await spyOnDownloads();

      await clickExport();
      await page.waitFor('window.__downloads.length === 1', { label: 'the download' });

      const [download] = await page.eval('window.__downloads');
      assert.equal(download.name, 'Sprint retro.png');
      assert.match(download.href, /^blob:/);
    });

    test('a board with nothing on it says so rather than going quiet', async () => {
      await page.eval(`app.store.load({ v: 1, order: [], objects: [] })`);

      await clickExport();
      await page.waitFor(`document.querySelector('[data-export-error]') !== null`, {
        label: 'the empty board to be reported',
      });

      assert.match(await page.eval(`document.querySelector('[data-export-error]').textContent`), /empty/i);
      assert.deepEqual(await page.eval('window.__downloads'), [], 'downloaded a file anyway');
    });

    test('a canvas the browser will not encode is reported too', async () => {
      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'anything' })`);
      // the one failure that is genuinely the browser's to have: toBlob
      // answers null for a canvas it could not encode
      await page.eval(`app.exporter.render = async () => null`);

      await clickExport();
      await page.waitFor(`document.querySelector('[data-export-error]') !== null`, {
        label: 'the refused encode to be reported',
      });

      assert.match(
        await page.eval(`document.querySelector('[data-export-error]').textContent`),
        /could not export/i,
      );
    });
  });
});
