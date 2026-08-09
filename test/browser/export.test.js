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

    // A string is an expression evaluated in the page, for the objects that
    // cannot be written down here — an image carries a whole picture, and the
    // only honest way to get one is to have the browser make it.
    const objects = ${typeof objects === 'string' ? objects : JSON.stringify(objects)};
    const exporter = createPngExporter({ document, window });
    const palette = exporter.readPalette();
    const frame = exportFrame(objects, { padding: ${padding}, scale: ${scale} });

    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    // Pictures are decoded before painting, exactly as render() does it: a 2D
    // context cannot wait for a bitmap mid-drawing.
    exporter.paint(ctx, objects, frame, palette, await exporter.loadBitmaps(objects));

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

    /** Every pixel as [r, g, b], row-major — for probes about where paint is. */
    const pixels = (() => {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const out = [];
      for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2]]);
      return out;
    })();

    return await (${probes})({ at, swatch, palette, frame, lastInkedRow, pixels });
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

  /**
   * A picture of the board has to agree with the board. These are the fields
   * the format bar writes; each one is read back out of the stylesheet by
   * `readPalette`, so what is checked is that the drawing uses the card's own
   * token rather than a default.
   */
  describe('a card that has been formatted', () => {
    test('is filled with its own colour', async () => {
      const result = await painted(
        [{ id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40, fill: 'pink' }],
        `({ at, swatch, palette }) => ({ middle: at(30, 20), expected: swatch(palette.card.pink) })`,
      );
      assert.deepEqual(result.middle, result.expected);
    });

    /**
     * Transparent means the paper is not drawn — and neither is its shadow,
     * which a middle pixel would never have caught. Every pixel of the frame
     * is checked, with padding so the shadow has somewhere to fall.
     */
    test('is not drawn at all when its fill is transparent', async () => {
      const result = await painted(
        [{ id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40, fill: 'none' }],
        `({ pixels, swatch, palette }) => {
          const bg = swatch(palette.bg);
          const stray = pixels.filter(([r, g, b]) =>
            Math.abs(r - bg[0]) > 2 || Math.abs(g - bg[1]) > 2 || Math.abs(b - bg[2]) > 2);
          return { strays: stray.length, total: pixels.length };
        }`,
        { padding: 20 },
      );
      assert.equal(result.strays, 0, `a transparent card left ${result.strays} painted pixels behind`);
      assert.ok(result.total > 0, 'nothing was drawn at all, so the check proved nothing');
    });

    test('is filled with a colour it carries itself', async () => {
      // Not a name the stylesheet knows, so nothing can be probed for it — the
      // value on the card is the answer.
      const result = await painted(
        [{ id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40, fill: '#123456' }],
        `({ at, swatch }) => ({ middle: at(30, 20), expected: swatch('#123456') })`,
      );
      assert.deepEqual(result.middle, result.expected);
    });

    test('draws its text in its own colour', async () => {
      // Enough text, large, to be sure of hitting ink rather than paper.
      const result = await painted(
        [{ id: 'a', type: 'card', x: 0, y: 0, w: 120, h: 60, text: '████', fill: 'white', ink: 'red', size: 'xl' }],
        `({ pixels, swatch, palette }) => ({
          hasRed: pixels.some(([r, g, b]) => Math.abs(r - swatch(palette.cardInk.red)[0]) < 12
            && Math.abs(g - swatch(palette.cardInk.red)[1]) < 12
            && Math.abs(b - swatch(palette.cardInk.red)[2]) < 12),
        })`,
      );
      assert.equal(result.hasRed, true, 'the card was drawn without its text colour');
    });

    test('centres its text when it is told to', async () => {
      const ink = (align) => painted(
        [{ id: 'a', type: 'card', x: 0, y: 0, w: 160, h: 40, text: 'xx', fill: 'white', align, size: 'xl' }],
        `({ pixels, frame }) => ({
          columns: pixels
            .map(([r, g, b], i) => (r + g + b < 300 ? i % frame.width : null))
            .filter((c) => c !== null),
        })`,
      );

      const left = (await ink('left')).columns;
      const centre = (await ink('center')).columns;
      const right = (await ink('right')).columns;

      assert.ok(left.length && centre.length && right.length, 'no text was drawn');
      assert.ok(Math.min(...centre) > Math.min(...left), 'centred text started no further right than left-aligned');
      assert.ok(Math.min(...right) > Math.min(...centre), 'right-aligned text started no further right than centred');
    });
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

  /**
   * The corner token, on the second renderer.
   *
   * The corner pixel is compared with the object's own fill rather than with the
   * background, because the background at that pixel also has a shadow falling
   * on it — what is being asked is whether the paper reaches the corner, and the
   * paper's colour is the only thing that answers it.
   */
  describe('corners', () => {
    const cornerPixel = (corners) => painted(
      [{ id: 'a', type: 'card', x: 0, y: 0, w: 60, h: 40, fill: 'white', ...corners }],
      `({ at, swatch, palette }) => ({ corner: at(0, 0), fill: swatch(palette.card.white) })`,
    );

    test('a square card is drawn into its corners', async () => {
      const { corner, fill } = await cornerPixel({ corners: 'square' });
      assert.deepEqual(corner, fill);
    });

    test('a round one is not', async () => {
      const { corner, fill } = await cornerPixel({ corners: 'round' });
      assert.notDeepEqual(corner, fill);
    });

    test('and a card that says nothing about corners is round', async () => {
      const { corner, fill } = await cornerPixel({});
      assert.notDeepEqual(corner, fill);
    });

    test('a squared list and envelope reach their corners too', async () => {
      for (const type of ['list', 'envelope']) {
        const result = await painted(
          `[{ id: 'a', type: '${type}', x: 0, y: 0, w: 120, h: 90, corners: 'square', title: '' }]`,
          `({ at, swatch, palette }) => ({
            corner: at(1, 1),
            background: swatch(palette.bg),
          })`,
        );
        assert.notDeepEqual(result.corner, result.background, `a square ${type} left its corner empty`);
      }
    });
  });

  /**
   * The picture is a second renderer, so an arrow drawn on screen and not in
   * the file is exactly the drift that file's comment warns about.
   */
  describe('connectors', () => {
    const PAIR = [
      { id: 'a', type: 'card', x: 0, y: 0, w: 100, h: 100, fill: 'yellow' },
      { id: 'b', type: 'card', x: 300, y: 0, w: 100, h: 100, fill: 'yellow' },
      { id: 'c', type: 'connector', from: 'a', to: 'b' },
    ];

    test('an arrow is drawn between the two objects it joins', async () => {
      const result = await painted(
        PAIR,
        `({ at, swatch, palette }) => ({
          // Halfway between the two cards, on the line between their middles.
          middle: at(200, 50),
          expected: swatch(palette.connectorStroke),
          // And a little above it, which is background.
          above: at(200, 20),
          background: swatch(palette.bg),
        })`,
      );

      assert.deepEqual(result.middle, result.expected, 'the line is the colour the stylesheet gives it');
      assert.deepEqual(result.above, result.background, 'and it is a line rather than a smear');
    });

    test('the head is filled, at the end it points to', async () => {
      const result = await painted(
        PAIR,
        `({ at, swatch, palette }) => ({
          // Inside the triangle: back from the second card's border, off the
          // centre line, where a stroke alone would leave background.
          head: at(285, 48),
          expected: swatch(palette.connectorStroke),
        })`,
      );

      assert.deepEqual(result.head, result.expected);
    });

    test('one whose other end was left out is not drawn', async () => {
      const result = await painted(
        [PAIR[0], PAIR[2]],
        `({ at, swatch, palette }) => ({
          // The padding round the one card that came, where an arrow drawn
          // from it to nowhere would have to cross.
          beyond: at(10, 10),
          background: swatch(palette.bg),
        })`,
        { padding: 40 },
      );

      assert.deepEqual(result.beyond, result.background);
    });
  });

  describe('an image', () => {
    /** A flat pink PNG, made by the browser, as an object on the board. */
    const picture = (props = {}) => `(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 40; canvas.height = 30;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f0378a';
      ctx.fillRect(0, 0, 40, 30);
      return [{
        id: 'i', type: 'image', x: 0, y: 0, w: 40, h: 30,
        src: canvas.toDataURL('image/png'),
        ...${JSON.stringify(props)},
      }];
    })()`;

    test('is drawn, at the size its box says', async () => {
      const result = await painted(
        picture({ corners: 'square' }),
        `({ at }) => ({ middle: at(20, 15), corner: at(0, 0), outside: at(39, 29) })`,
      );
      assert.deepEqual(result.middle, [240, 55, 138]);
      assert.deepEqual(result.corner, [240, 55, 138], 'a square image is drawn into its corner');
      assert.deepEqual(result.outside, [240, 55, 138]);
    });

    test('is clipped to its corners when they are round', async () => {
      const result = await painted(
        picture({ corners: 'round' }),
        `({ at }) => ({ middle: at(20, 15), corner: at(0, 0) })`,
      );
      assert.deepEqual(result.middle, [240, 55, 138]);
      assert.notDeepEqual(result.corner, [240, 55, 138], 'the picture ran past its rounded corner');
    });

    /**
     * A picture that did not decode is still an object on the board. Drawing the
     * box says so; drawing nothing would look like the export lost it.
     */
    test('whose source is not a picture is drawn as its own empty box', async () => {
      const result = await painted(
        [{ id: 'i', type: 'image', x: 0, y: 0, w: 40, h: 30, src: 'https://example.test/pixel.png' }],
        `({ at, swatch, palette }) => ({ middle: at(20, 15), expected: swatch(palette.bg, palette.imageBg) })`,
      );
      /**
       * Within a shade rather than exactly: the box's fill is 6% ink over
       * whatever is behind it, and behind it is also the object's own shadow —
       * so the pixel is a shade darker than the fill over the background alone.
       * A tolerance of one is the difference between "the box was drawn" and
       * "the box was drawn and so was its shadow", and both are wanted.
       */
      for (const [channel, value] of result.middle.entries()) {
        assert.ok(Math.abs(value - result.expected[channel]) <= 2, `${result.middle} is not ${result.expected}`);
      }
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
   * The blob is handed to the browser through an object URL, and an object URL
   * that is never revoked holds its blob for the life of the page — tens of
   * megabytes, for a large board. The next frame is the usual moment to revoke
   * it, but `requestAnimationFrame` is suspended entirely while the document is
   * hidden, which is exactly what happens when someone clicks Export and
   * immediately switches tab.
   */
  describe('the object URL', () => {
    /**
     * Both the document and the window are stand-ins here.
     *
     * The window so the frame and the timer can be held and fired by hand —
     * that ordering is the whole subject. The document because a real anchor
     * pointed at a blob URL that was never a blob is a real navigation: the
     * browser tries it, fails, and logs, which the suite counts as the page
     * having errored. Nothing about this test needs a live anchor.
     */
    const saveWith = (behaviour) => page.eval(`(async () => {
      const { createPngExporter } = await import('/src/platform/export-png.js');

      const calls = { revoked: [], timeoutMs: null, clicked: 0, download: null };
      let frame = null;

      const fakeWindow = {
        URL: {
          createObjectURL: () => 'blob:pretend',
          revokeObjectURL: (url) => calls.revoked.push(url),
        },
        requestAnimationFrame: (fn) => { frame = fn; },
        setTimeout: (fn, ms) => { calls.timeoutMs = ms; calls.timer = fn; },
      };

      const fakeDocument = {
        createElement: () => ({
          click: () => { calls.clicked += 1; },
          remove: () => {},
          set download(name) { calls.download = name; },
        }),
        body: { appendChild: () => {} },
      };

      const exporter = createPngExporter({ document: fakeDocument, window: fakeWindow });
      exporter.save(new Blob(['x']), 'board.png');
      return await (${behaviour})({ calls, runFrame: () => frame?.(), runTimer: () => calls.timer?.() });
    })()`);

    test('is handed to an anchor that carries the file name', async () => {
      const calls = await saveWith(`({ calls }) => calls`);

      assert.equal(calls.clicked, 1);
      assert.equal(calls.download, 'board.png');
    });

    test('is revoked by the timer when no frame ever comes', async () => {
      const calls = await saveWith(`({ calls, runTimer }) => {
        const beforeTimer = calls.revoked.length;
        runTimer();
        return { beforeTimer, revoked: calls.revoked, timeoutMs: calls.timeoutMs };
      }`);

      assert.equal(calls.beforeTimer, 0, 'revoked before anything had a chance to run');
      assert.deepEqual(calls.revoked, ['blob:pretend'], 'a hidden tab kept the blob for good');
      assert.ok(calls.timeoutMs > 0, 'no backstop was armed at all');
    });

    test('is revoked once, whichever of the two arrives first', async () => {
      const calls = await saveWith(`({ calls, runFrame, runTimer }) => {
        runFrame();
        runTimer();
        return { revoked: calls.revoked };
      }`);

      assert.deepEqual(calls.revoked, ['blob:pretend'], 'revoked twice for one download');
    });
  });

  /**
   * The button, the download and the ways it can produce no file. A click
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
      await page.waitFor(`document.querySelector('[data-board-notice]') !== null`, {
        label: 'the empty board to be reported',
      });

      assert.match(await page.eval(`document.querySelector('[data-board-notice]').textContent`), /empty/i);
      assert.deepEqual(await page.eval('window.__downloads'), [], 'downloaded a file anyway');
    });

    /**
     * This banner floats over the canvas rather than sitting above a list, so
     * unlike the board list's errors it has to be possible to put away — one
     * parked over someone's board until they happen to try exporting again is
     * furniture, not a report.
     */
    test('the report can be dismissed', async () => {
      await page.eval(`app.store.load({ v: 1, order: [], objects: [] })`);

      await clickExport();
      await page.waitFor(`document.querySelector('[data-board-notice]') !== null`, {
        label: 'the error',
      });

      await page.eval(`document.querySelector('[data-action="dismiss-notice"]').click()`);
      await page.waitFor(`document.querySelector('[data-board-notice]') === null`, {
        label: 'the error to go away',
      });
    });

    /**
     * The router reuses this component when only :boardId changes, so a banner
     * left standing would report a failure belonging to a board that is no
     * longer on screen — against a button that would now export a different
     * one.
     */
    test('a report does not follow you to the next board', async () => {
      await page.eval(`(() => {
        const empty = { v: 1, order: [], objects: [] };
        localStorage.setItem('peerthink:board:one', JSON.stringify({
          v: 1, id: 'one', title: 'One', updatedAt: 2, board: empty,
        }));
        const card = {
          v: 1,
          order: ['c1'],
          objects: [{ id: 'c1', type: 'card', x: 0, y: 0, w: 100, h: 60, text: 'here' }],
        };
        localStorage.setItem('peerthink:board:two', JSON.stringify({
          v: 1, id: 'two', title: 'Two', updatedAt: 1, board: card,
        }));
      })()`);

      await page.goto('/#/b/one');
      await clickExport();
      await page.waitFor(`document.querySelector('[data-board-notice]') !== null`, {
        label: 'the empty board to be reported',
      });

      // in-place param change: the router reuses the component
      await page.eval(`location.hash = '#/b/two'`);
      await page.waitFor(`window.app?.boardId === 'two'`, { label: 'board two to mount' });

      assert.equal(
        await page.eval(`document.querySelector('[data-board-notice]') === null`),
        true,
        "board one's failure was still on screen over board two",
      );
    });

    test('a canvas the browser will not encode is reported too', async () => {
      await page.eval(`app.board.add('card', { x: 0, y: 0, text: 'anything' })`);
      // the one failure that is genuinely the browser's to have: toBlob
      // answers null for a canvas it could not encode
      await page.eval(`app.exporter.render = async () => null`);

      await clickExport();
      await page.waitFor(`document.querySelector('[data-board-notice]') !== null`, {
        label: 'the refused encode to be reported',
      });

      assert.match(
        await page.eval(`document.querySelector('[data-board-notice]').textContent`),
        /could not export/i,
      );
    });
  });
});
