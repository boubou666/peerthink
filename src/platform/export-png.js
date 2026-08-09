/**
 * The board, drawn to a canvas.
 *
 * Objects on screen are real DOM inside a transformed layer, which is what
 * gives them text editing, IME and selection for free — and what makes them
 * impossible to hand to a file. Nothing in the browser turns a live subtree
 * into an image: `foreignObject` comes closest and renders inconsistently
 * outside a browser, and the libraries that do it are libraries, which the
 * canvas layer does not have and is not about to acquire for this.
 *
 * So the store is drawn a second time, here, in 2D context calls. That is a
 * second renderer and the cost is real: every change to how an object looks
 * has to land in two places or the export drifts from the board. It is kept as
 * small as possible — the palette is *read from the stylesheet* rather than
 * copied out of it, so colour and theme stay in `canvas.css` alone, and only
 * the geometry is restated here.
 *
 * What it does not reproduce, deliberately:
 *
 *   - selection rings, handles and guides. They are affordances for someone
 *     working, not part of the document.
 *   - the exact two-layer CSS shadow. A 2D context has one shadow, so the
 *     larger of the pair is drawn and the hairline one is dropped.
 *   - flexbox. Lists lay their rows out by hand here, which agrees with the
 *     DOM for the shapes a list can actually take.
 */

import {
  CARD_FILLS,
  CARD_FONTS,
  CARD_INKS,
  CARD_SIZES,
  cardStyle,
  namedColour,
} from '../core/card-style.js';
import { connectorGeometry, isConnector } from '../core/connectors.js';
import { cornersOf } from '../core/corners.js';
import { isImageSource } from '../core/image.js';
import { displayText } from '../core/links.js';

/**
 * How long the object URL is kept alive as a backstop, in ms. Long enough that
 * the download has certainly started, short enough that a blob is not sitting
 * in memory for any length of time.
 */
export const REVOKE_AFTER_MS = 2_000;

/** Geometry from `canvas.css`, in world units. Colour is never copied here. */
const RADIUS = 8;
/** The radius an object is drawn with, which is a property of the object now. */
const radiusOf = (obj) => (cornersOf(obj) === 'square' ? 0 : RADIUS);
const CARD = { pad: 12, size: 14, line: 1.4 };
// The dash is the browser's, not a choice: Chrome draws a dashed border in
// dashes roughly twice the border width with gaps to match, and a coarser
// pattern reads as a different kind of line next to the real thing.
const ENVELOPE = { pad: 10, size: 13, line: 1.35, weight: 700, dash: [3, 3], border: 1.5 };
const LIST = {
  pad: 10,
  gap: 6,
  title: { size: 14, weight: 600, line: 1.35 },
  rowGap: 2,
  row: { size: 13, line: 1.35, gap: 7 },
  check: { size: 13, top: 3, radius: 3, border: 1.5 },
  add: { size: 12 },
  border: 1,
};

export function createPngExporter({ document, window }) {
  /**
   * Colour, taken from the live stylesheet rather than restated.
   *
   * The custom properties answer for the theme, and probe elements answer for
   * everything a value alone cannot: `--card-bg` is chosen by an attribute
   * selector, and the envelope's background is a `color-mix` that only the
   * browser can resolve. Probing costs one layout on a handful of throwaway
   * nodes, once per export, and it means switching the theme or retuning a
   * colour never has to be remembered here.
   */
  const readPalette = () => {
    const root = window.getComputedStyle(document.documentElement);
    const token = (name) => root.getPropertyValue(name).trim();

    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;width:240px;height:240px;';
    document.body.appendChild(host);

    const probe = (className, prepare) => {
      const el = document.createElement('div');
      el.className = className;
      prepare?.(el);
      host.appendChild(el);
      const style = window.getComputedStyle(el);
      const read = {
        background: style.backgroundColor,
        color: style.color,
        border: style.borderTopColor,
      };
      el.remove();
      return read;
    };

    /**
     * Every card style token, read from the stylesheet that defines it.
     *
     * The same reason the fills were probed rather than listed: the values
     * live in canvas.css, two themes disagree about them, and a copy here is
     * one that drifts. Fonts and sizes are read the same way — a `14px` in
     * this file would be a second answer to a question the stylesheet has
     * already answered.
     *
     * The text is probed rather than the card, because font-size, family,
     * colour and alignment are all set on `.card-text` inside it.
     */
    const cardProbe = (field, value) => {
      const el = document.createElement('div');
      el.className = 'obj card';
      el.dataset[field] = value;
      const text = document.createElement('div');
      text.className = 'card-text';
      el.appendChild(text);
      host.appendChild(el);

      const outer = window.getComputedStyle(el);
      const inner = window.getComputedStyle(text);
      const read = {
        background: outer.backgroundColor,
        color: inner.color,
        family: inner.fontFamily,
        size: parseFloat(inner.fontSize),
        align: inner.textAlign,
      };
      el.remove();
      return read;
    };

    const styleOf = (field, values, pick) =>
      Object.fromEntries(values.map((value) => [value, pick(cardProbe(field, value))]));

    const card = styleOf('fill', CARD_FILLS, (read) => read.background);
    const cardInk = styleOf('ink', CARD_INKS, (read) => read.color);
    const cardFamily = styleOf('font', CARD_FONTS, (read) => read.family);
    const cardSize = styleOf('size', CARD_SIZES, (read) => read.size);
    /**
     * A connector's colour and thickness, probed like everything else — it is
     * an SVG stroke on screen, so the probe has to be an SVG one. Restating
     * either here would be the copy this whole function exists to avoid.
     */
    const connector = (() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'connector-line');
      svg.appendChild(line);
      host.appendChild(svg);
      const style = window.getComputedStyle(line);
      const read = { stroke: style.stroke, width: parseFloat(style.strokeWidth) };
      svg.remove();
      return read;
    })();

    const envelope = probe('obj envelope');
    // What shows through a picture with transparency in it, and what an image
    // whose source did not decode is drawn as. A `color-mix` again, so it is
    // asked for rather than restated.
    const image = probe('obj image');
    const family = window.getComputedStyle(document.body).fontFamily;

    host.remove();

    return {
      bg: token('--bg'),
      ink: token('--ink'),
      muted: token('--muted'),
      line: token('--line'),
      accent: token('--accent'),
      panel: token('--panel'),
      card,
      cardInk,
      cardFamily,
      cardSize,
      connectorStroke: connector.stroke,
      connectorWidth: Number.isFinite(connector.width) ? connector.width : 2,
      envelopeBg: envelope.background,
      envelopeBorder: envelope.border,
      imageBg: image.background,
      family,
    };
  };

  /**
   * `overflow-wrap: anywhere` — a word wider than the box is broken rather
   * than allowed to spill out of it.
   */
  const breakWord = (ctx, word, maxWidth) => {
    const pieces = [];
    let piece = '';
    for (const ch of word) {
      if (piece && ctx.measureText(piece + ch).width > maxWidth) {
        pieces.push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    if (piece) pieces.push(piece);
    return pieces;
  };

  /**
   * `white-space: pre-wrap` — newlines are kept, the rest is greedy wrap.
   *
   * Through `displayText`, so a link with a label draws as its label. A picture
   * of a board has no links in it either way — that is written down as a known
   * limit — but drawing `[our roadmap](https://…)` would put characters in the
   * picture that are not on the screen it is a picture of.
   */
  const wrap = (ctx, text, maxWidth) => {
    const out = [];
    for (const paragraph of displayText(text).split('\n')) {
      const words = paragraph
        .split(' ')
        .flatMap((w) => (ctx.measureText(w).width <= maxWidth ? [w] : breakWord(ctx, w, maxWidth)));

      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (!line || ctx.measureText(candidate).width <= maxWidth) line = candidate;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  };

  /**
   * Draw wrapped text inside a box, clipped to it — the DOM counterparts are
   * `overflow: hidden`, so an object that has been resized smaller than its
   * content cuts it off on screen and has to cut it off here.
   *
   * Returns the height the text actually took, which is what lets a list stack
   * its rows without laying them out twice.
   */
  const drawText = (ctx, text, box, { size, weight = 400, color, family, strike = false, align = 'left' }) => {
    const lineHeight = size * (box.line ?? 1.4);
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();

    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';

    /**
     * Alignment is done by moving each line rather than by `ctx.textAlign`,
     * because the strike-through below measures from where the line starts and
     * would otherwise be drawn through empty space. Per line, not per block:
     * that is what centring text means, and what the DOM does.
     */
    const startOf = (width) => {
      if (align === 'center') return box.x + (box.w - width) / 2;
      if (align === 'right') return box.x + box.w - width;
      return box.x;
    };

    const lines = wrap(ctx, text, box.w);
    let y = box.y;
    for (const line of lines) {
      // The baseline sits inside the line box the way a browser puts it.
      const baseline = y + lineHeight / 2 + size * 0.36;
      const left = startOf(ctx.measureText(line).width);
      ctx.fillText(line, left, baseline);
      if (strike && line) {
        const width = ctx.measureText(line).width;
        ctx.fillRect(left, y + lineHeight / 2 - size * 0.05, width, Math.max(1, size / 14));
      }
      y += lineHeight;
    }

    ctx.restore();
    return lines.length * lineHeight;
  };

  const rounded = (ctx, x, y, w, h, r) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  };

  /**
   * `--shadow` is two layers and a 2D context has one, so the wider of the two
   * is drawn. Applied to the fill alone: a shadow left on for the border would
   * cast a second one from the stroke.
   */
  const shadowed = (ctx, fill) => {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.10)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    fill();
    ctx.restore();
  };

  const drawCard = (ctx, obj, palette) => {
    const style = cardStyle(obj);

    /**
     * A transparent card is not drawn at all — no fill and no shadow, since a
     * shadow is cast by paper that is not there. The dashed outline the canvas
     * gives it is deliberately not drawn either: it is there to make an empty
     * one findable while editing, and a picture of a board should show what is
     * on the board rather than the scaffolding for putting it there.
     */
    if (style.fill !== 'none') {
      rounded(ctx, obj.x, obj.y, obj.w, obj.h, radiusOf(obj));
      // A named colour is whatever the stylesheet currently says it is, so it
      // is looked up; one the card carries is already the answer.
      ctx.fillStyle = namedColour(style.fill)
        ? palette.card[style.fill] ?? palette.card.yellow
        : style.fill;
      shadowed(ctx, () => ctx.fill());
    }

    drawText(
      ctx,
      obj.text,
      {
        x: obj.x + CARD.pad,
        y: obj.y + CARD.pad,
        w: obj.w - CARD.pad * 2,
        h: obj.h - CARD.pad * 2,
        line: CARD.line,
      },
      {
        size: palette.cardSize[style.size] ?? CARD.size,
        color: namedColour(style.ink) ? palette.cardInk[style.ink] ?? palette.cardInk.ink : style.ink,
        family: palette.cardFamily[style.font] ?? palette.family,
        align: style.align,
      },
    );
  };

  const drawEnvelope = (ctx, obj, palette) => {
    rounded(ctx, obj.x, obj.y, obj.w, obj.h, radiusOf(obj));
    ctx.fillStyle = palette.envelopeBg;
    ctx.fill();

    ctx.save();
    ctx.setLineDash(ENVELOPE.dash);
    ctx.lineWidth = ENVELOPE.border;
    ctx.strokeStyle = palette.envelopeBorder;
    ctx.stroke();
    ctx.restore();

    drawText(
      ctx,
      obj.title,
      {
        x: obj.x + ENVELOPE.pad,
        y: obj.y + ENVELOPE.pad,
        w: obj.w - ENVELOPE.pad * 2,
        h: obj.h - ENVELOPE.pad * 2,
        line: ENVELOPE.line,
      },
      {
        size: ENVELOPE.size,
        weight: ENVELOPE.weight,
        color: palette.muted,
        family: palette.family,
      },
    );
  };

  const drawList = (ctx, obj, palette) => {
    rounded(ctx, obj.x, obj.y, obj.w, obj.h, radiusOf(obj));
    ctx.fillStyle = palette.panel;
    shadowed(ctx, () => ctx.fill());
    ctx.lineWidth = LIST.border;
    ctx.strokeStyle = palette.line;
    ctx.stroke();

    // Everything below is clipped to the object: a list resized shorter than
    // its rows hides them on screen, and must hide them here.
    ctx.save();
    rounded(ctx, obj.x, obj.y, obj.w, obj.h, radiusOf(obj));
    ctx.clip();

    const left = obj.x + LIST.pad;
    const width = obj.w - LIST.pad * 2;
    const bottom = obj.y + obj.h - LIST.pad;
    let y = obj.y + LIST.pad;

    y += drawText(
      ctx,
      obj.title,
      { x: left, y, w: width, h: bottom - y, line: LIST.title.line },
      {
        size: LIST.title.size,
        weight: LIST.title.weight,
        color: palette.ink,
        family: palette.family,
      },
    );
    y += LIST.gap;

    const textLeft = left + LIST.check.size + LIST.row.gap;
    const textWidth = width - LIST.check.size - LIST.row.gap;

    for (const item of obj.items ?? []) {
      if (y >= bottom) break;

      const box = { x: left, y: y + LIST.check.top, w: LIST.check.size, h: LIST.check.size };
      rounded(ctx, box.x, box.y, box.w, box.h, LIST.check.radius);
      if (item.done) {
        ctx.fillStyle = palette.accent;
        ctx.fill();
      }
      ctx.lineWidth = LIST.check.border;
      ctx.strokeStyle = item.done ? palette.accent : palette.line;
      ctx.stroke();

      const used = drawText(
        ctx,
        item.text,
        { x: textLeft, y, w: textWidth, h: bottom - y, line: LIST.row.line },
        {
          size: LIST.row.size,
          color: item.done ? palette.muted : palette.ink,
          family: palette.family,
          strike: !!item.done,
        },
      );
      y += Math.max(used, LIST.check.size + LIST.check.top) + LIST.rowGap;
    }

    /**
     * Pinned to the bottom, not stacked under the last row.
     *
     * `.list-items` is `flex: 1`, so it takes the slack in the box and the
     * button after it is pushed to the floor. Drawing it where the rows happen
     * to end puts it halfway up a list with room to spare, which is the one
     * place it never appears on screen.
     */
    const addHeight = LIST.add.size * 1.35;
    if (bottom - addHeight > y - LIST.rowGap) {
      drawText(
        ctx,
        '+ item',
        { x: left, y: bottom - addHeight, w: width, h: addHeight, line: 1.35 },
        { size: LIST.add.size, color: palette.muted, family: palette.family },
      );
    }

    ctx.restore();
  };

  /**
   * A picture, at the size its box says.
   *
   * The background goes down first whether or not there is a bitmap, which is
   * both what the DOM does — `.image` has one, and a PNG with transparency in it
   * shows it through — and the only thing to draw for an image that did not
   * decode. A box where the picture should be says an object is there; nothing
   * at all says the export lost it.
   */
  const drawImage = (ctx, obj, palette, bitmaps) => {
    const radius = radiusOf(obj);
    rounded(ctx, obj.x, obj.y, obj.w, obj.h, radius);
    ctx.fillStyle = palette.imageBg;
    shadowed(ctx, () => ctx.fill());

    const bitmap = bitmaps?.get(obj.src);
    if (!bitmap) return;

    // Clipped, so a rounded image is rounded here too — the radius is on the
    // picture in the stylesheet, and a 2D context has no border-radius to give
    // a drawImage.
    ctx.save();
    rounded(ctx, obj.x, obj.y, obj.w, obj.h, radius);
    ctx.clip();
    ctx.drawImage(bitmap, obj.x, obj.y, obj.w, obj.h);
    ctx.restore();
  };

  /**
   * An arrow between two objects, drawn from the same geometry the screen uses.
   *
   * Both ends have to be in the picture. Exporting a selection takes the
   * connectors *between* what was selected — the rule copying follows — so an
   * arrow whose other end was left out is one nobody asked for and there is
   * nothing sensible to draw for it.
   */
  const drawConnector = (ctx, obj, palette, boxes) => {
    const from = boxes.get(obj.from);
    const to = boxes.get(obj.to);
    if (!from || !to) return;

    const drawn = connectorGeometry(from, to);
    if (!drawn) return;

    ctx.strokeStyle = palette.connectorStroke;
    ctx.fillStyle = palette.connectorStroke;
    ctx.lineWidth = palette.connectorWidth;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(drawn.line.x1, drawn.line.y1);
    ctx.lineTo(drawn.line.x2, drawn.line.y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(...drawn.head[0]);
    for (const [x, y] of drawn.head.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
  };

  const drawers = { card: drawCard, envelope: drawEnvelope, list: drawList, image: drawImage };

  /**
   * Every picture on the board, decoded and ready to draw.
   *
   * `paint` is synchronous — it has to be, because a context is a thing you draw
   * into in order — and `drawImage` will not wait for a bitmap. So the images
   * are decoded first, by source rather than by object, since the same picture
   * pasted twice is one decode.
   *
   * A source that will not decode is left out of the map rather than failing the
   * export: the rest of the board is still worth a file, and `drawImage` has
   * something to draw for it.
   */
  const loadBitmaps = async (objects) => {
    const sources = [...new Set(objects
      .filter((obj) => obj?.type === 'image')
      .map((obj) => obj.src))].filter(isImageSource);

    const bitmaps = new Map();
    await Promise.all(sources.map(async (src) => {
      const img = new window.Image();
      img.src = src;
      try {
        await img.decode();
        bitmaps.set(src, img);
      } catch {
        // Not a picture after all, or not one this browser reads.
      }
    }));
    return bitmaps;
  };

  /**
   * Paint `objects` into a context already sized to `frame`.
   *
   * Exported for the tests, which assert on pixels without going near a blob.
   * The array is drawn in the order it arrives — `store.all()` is already
   * back-to-front, and re-sorting here would be a second opinion about depth.
   */
  const paint = (ctx, objects, frame, palette, bitmaps) => {
    ctx.save();
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, frame.width, frame.height);

    ctx.scale(frame.scale, frame.scale);
    ctx.translate(-frame.rect.x, -frame.rect.y);

    /**
     * The arrows first, so every object is painted over them — which is the
     * order the screen draws them in, and the reason for it is the same: a line
     * across the text it joins is a diagram nobody can read.
     */
    const boxes = new Map(objects.filter(Boolean).map((obj) => [obj.id, obj]));
    for (const obj of objects) {
      if (isConnector(obj)) drawConnector(ctx, obj, palette, boxes);
    }

    for (const obj of objects) {
      // An object of a type this file has never heard of is skipped rather
      // than drawn wrong — a board saved by a newer version is still worth
      // exporting for the parts that are understood.
      drawers[obj?.type]?.(ctx, obj, palette, bitmaps);
    }
    ctx.restore();
  };

  return {
    paint,
    readPalette,
    loadBitmaps,

    /**
     * Render to a PNG blob, or null when the browser would not give one.
     *
     * `toBlob` answers null for a canvas it could not allocate or encode, and
     * that is a real outcome for a large board rather than a theoretical one.
     * It is passed on rather than turned into an empty file, so the caller can
     * say the export failed instead of downloading nothing.
     */
    async render(objects, frame) {
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Decoded before the palette is read, so that reading it and drawing with
      // it stay in one turn — `paint` cannot wait for a bitmap, so this is the
      // one thing here that has to happen first.
      const bitmaps = await loadBitmaps(objects);
      paint(ctx, objects, frame, readPalette(), bitmaps);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    },

    /**
     * Hand the blob to the browser as a download.
     *
     * The object URL is not revoked in the same turn as the click, which races
     * the navigation the click starts and lands an empty file often enough to
     * matter. The next frame is the usual moment for that — but a frame is not
     * a guarantee: `requestAnimationFrame` is suspended entirely while the
     * document is hidden, so someone who switches tab straight after clicking
     * would keep the blob for the life of the page, and for a large board that
     * is tens of megabytes of it.
     *
     * So both, and whichever comes first wins. The timer still fires in a
     * background tab — throttled, not suspended — and is only ever the floor.
     */
    save(blob, filename) {
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        window.URL.revokeObjectURL(url);
      };

      window.requestAnimationFrame(release);
      window.setTimeout(release, REVOKE_AFTER_MS);
    },
  };
}
