import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { hexToHsv, hsvToHex, normaliseHex } from '../core/colour.js';

/**
 * A colour picker drawn by the app, in the app's own chrome.
 *
 * `<input type="color">` was doing this, and it is the browser's chrome rather
 * than ours — the same objection as `window.prompt`, and worse here: the panel
 * it opens is a different size, shape and typeface on every platform, it sits
 * outside the page so nothing about the board's styling reaches it, and on
 * some it is a whole modal window that steals focus from the canvas. A tool
 * for choosing how a board looks should not be the one part of the board that
 * looks like somebody else's software.
 *
 * So the panel is a spectrum square under a hue slider, the palette as
 * swatches, and a hex field — built from the same tokens as everything else,
 * which is what makes it follow the theme for free.
 *
 * What it deliberately does not offer is alpha. A card is painted or it is
 * `none`, and `none` is a control of its own in the format bar; an alpha
 * slider would offer a second, sneakier way to say the same thing and a range
 * of half-there cards that nothing else in the app knows how to talk about.
 */

/** The gap between the swatch and its panel, matching the CSS. */
const PANEL_GAP = 6;

/** How far an arrow key moves in the square, and how far with shift held. */
const STEP = 0.02;
const BIG_STEP = 0.1;

const ARROWS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * The hex a value is shown as.
 *
 * A card carries either a name the stylesheet answers for or a hex it brought
 * itself, and a picker can only point at the second kind — so a name is looked
 * up in the presets, which carry what the stylesheet says each one is. What is
 * neither (`none`, or a token from a newer version of the app) falls back:
 * there is nothing true to point at, and pointing at the last colour anyway
 * would claim the card is that colour.
 *
 * Exported because the format bar's transparency toggle has the same question
 * to answer — putting a fill back means putting back the one on display.
 */
export function resolveColour(value, presets, fallback) {
  if (value === null || value === undefined) return fallback;
  return normaliseHex(value) ?? presets.find((preset) => preset.name === value)?.hex ?? fallback;
}

const draftFrom = (hex) => ({ hex, hsv: hexToHsv(hex), text: hex });

export function ColourPicker({ field, label, value, presets, fallback, onPick }) {
  const hex = resolveColour(value, presets, fallback);

  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState('below');

  /**
   * The colour being worked on: the hex it resolves to, the point in the
   * cylinder it came from, and what the hex field is showing.
   *
   * All three together, because they can disagree in ways that matter. The
   * point keeps a hue that the hex cannot: black is black at every hue, so
   * dragging into the bottom corner and out again would otherwise come back
   * red instead of the colour that went in. And the text is what is being
   * typed, which is only sometimes a colour — `#b4d` on its way to `#b4d5ff`
   * must stay in the field rather than be corrected to something else.
   */
  const [draft, setDraft] = useState(() => draftFrom(hex));

  /**
   * A card changed underneath us — a different selection, an undo, or someone
   * else on the board — so the panel shows that instead. Adjusting state during
   * the render rather than in an effect is React's own advice for this: the
   * alternative paints the old colour for a frame first.
   */
  if (draft.hex !== hex) setDraft(draftFrom(hex));

  const root = useRef(null);
  const swatch = useRef(null);
  const panel = useRef(null);
  const area = useRef(null);

  /**
   * Which side the panel opens on.
   *
   * The bar follows the selection and the selection can be anywhere, so there
   * is no side that is always right — a card near the bottom of the window
   * would open a panel below the fold, onto controls nobody can reach. Measured
   * rather than guessed, and in a layout effect so the first paint is already
   * on the right side.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = swatch.current.getBoundingClientRect();
    const height = panel.current.offsetHeight;
    setPlacement(anchor.bottom + PANEL_GAP + height <= window.innerHeight ? 'below' : 'above');
  }, [open]);

  useEffect(() => {
    if (!open) return;

    /**
     * Capturing, because the format bar stops `pointerdown` from reaching the
     * page — it has to, or a click on the bar would start a marquee on the
     * stage behind it. A bubbling listener would therefore never hear about
     * the click on the *other* picker's swatch, and both panels would sit open
     * at once.
     */
    const dismiss = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };

    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      // Escape on the canvas clears the selection, which would take the bar
      // and this panel with it. The panel is what is in front, so the key is
      // spent closing it.
      event.stopPropagation();
      setOpen(false);
      swatch.current?.focus();
    };

    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  /**
   * Take a point in the cylinder as the new colour, and tell the board.
   *
   * The point is kept as given rather than read back out of the hex, so the
   * hue survives the corners where hex cannot express it. Every move writes:
   * that is what makes the cards follow the cursor through the spectrum, and
   * each one is an op, so a long drag lands a run of them in the undo stack —
   * the honest record of what happened, and cheaper than guessing when
   * somebody has settled on a colour.
   */
  const take = (hsv) => {
    const next = hsvToHex(hsv);
    setDraft({ hex: next, hsv, text: next });
    onPick(next);
  };

  const pointInSquare = (event) => {
    const rect = area.current.getBoundingClientRect();
    return {
      ...draft.hsv,
      s: clamp01((event.clientX - rect.left) / rect.width),
      v: 1 - clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const onSquareDown = (event) => {
    // Captured, so a drag that leaves the square keeps painting instead of
    // stopping at the edge — dragging to the corner is how you reach pure
    // white, and overshooting it is how everybody gets there.
    event.currentTarget.setPointerCapture(event.pointerId);
    take(pointInSquare(event));
  };

  const onSquareMove = (event) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    take(pointInSquare(event));
  };

  const onSquareKey = (event) => {
    const arrow = ARROWS[event.key];
    if (!arrow) return;
    event.preventDefault();
    const by = event.shiftKey ? BIG_STEP : STEP;
    take({
      ...draft.hsv,
      s: clamp01(draft.hsv.s + arrow[0] * by),
      v: clamp01(draft.hsv.v + arrow[1] * by),
    });
  };

  const onTyped = (event) => {
    const text = event.target.value;
    const typed = normaliseHex(text);
    // The text is kept as typed either way: correcting `#B4D` to `#bbdd44`
    // under the cursor makes the field impossible to type in.
    setDraft((was) => (typed ? { hex: typed, hsv: hexToHsv(typed), text } : { ...was, text }));
    if (typed) onPick(typed);
  };

  return (
    <div className="cp" ref={root}>
      <button
        ref={swatch}
        type="button"
        className="cp-swatch"
        data-field={field}
        data-value={hex}
        data-open={open ? '' : undefined}
        style={{ '--cp-value': hex }}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      />

      {open && (
        <div
          ref={panel}
          className="cp-panel"
          data-colour-panel={field}
          data-placement={placement}
          role="dialog"
          aria-label={label}
          /*
           * The canvas listens for keys on `window`, and it is not fussy about
           * where they came from: `c` adds a card, `e` an envelope, Backspace
           * deletes the selection and the arrows nudge it. Both letters are
           * hex digits — typing `#ccee00` would leave a litter of new objects
           * behind it — so the panel keeps its keys to itself.
           */
          onKeyDown={(event) => event.stopPropagation()}
        >
          {/*
            A focusable div rather than a slider: the square is two values at
            once and no ARIA role describes that, so claiming one would tell a
            screen reader something untrue about how it behaves. It takes arrow
            keys for the people who can see it and are not using a mouse; the
            hex field below is the exact, announceable way in, and the swatches
            are the quick one.
          */}
          <div
            ref={area}
            className="cp-area"
            data-colour-area
            tabIndex={0}
            aria-label={`${label}: saturation and brightness`}
            style={{ '--cp-hue': draft.hsv.h }}
            onPointerDown={onSquareDown}
            onPointerMove={onSquareMove}
            onKeyDown={onSquareKey}
          >
            <span
              className="cp-thumb"
              style={{ left: `${draft.hsv.s * 100}%`, top: `${(1 - draft.hsv.v) * 100}%` }}
            />
          </div>

          {/*
            A real range input. Hue is one number on a line, which is exactly
            what the element means, so it arrives with the keyboard and the
            screen-reader behaviour already right — the styling is ours.
          */}
          <input
            type="range"
            className="cp-hue"
            data-colour-hue
            min="0"
            max="359"
            step="1"
            value={Math.round(draft.hsv.h)}
            aria-label={`${label}: hue`}
            onChange={(event) => take({ ...draft.hsv, h: Number(event.target.value) })}
          />

          <div className="cp-presets" role="group" aria-label={`${label}: palette`}>
            {presets.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className="cp-preset"
                data-value={preset.name}
                data-current={value === preset.name || value === preset.hex ? '' : undefined}
                aria-pressed={value === preset.name || value === preset.hex}
                style={{ '--cp-value': preset.hex }}
                aria-label={preset.name}
                title={preset.name}
                /*
                 * The name, not the hex behind it. A card that says `blue` is
                 * asking the stylesheet what blue is, so it follows a retune
                 * and can differ between themes; a card that says `#b4d5ff` has
                 * decided. Both are colours a card may carry, and picking one
                 * off the palette is the case where the first is what was
                 * meant.
                 */
                onClick={() => onPick(preset.name)}
              />
            ))}
          </div>

          <label className="cp-field">
            <span>Hex</span>
            <input
              data-colour-hex
              value={draft.text}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${label}: hex`}
              onChange={onTyped}
              // Half a colour is worth keeping while it is being typed and not
              // once the field is left, where it would sit looking like the
              // colour of the card.
              onBlur={() => setDraft((was) => ({ ...was, text: was.hex }))}
            />
          </label>
        </div>
      )}
    </div>
  );
}
