import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import { barPosition } from '../core/bar-position.js';

import {
  CARD_ALIGNS,
  CARD_FONTS,
  CARD_SIZES,
  TRANSPARENT,
  cardStyle,
} from '../core/card-style.js';

import { recentColours } from '../shell/colours.js';
import { cardPalette } from '../shell/palette.js';

import { ColourPicker, resolveColour } from './ColourPicker.jsx';

/**
 * Formatting for the selected cards, floating above them.
 *
 * It renders in screen space over the stage rather than inside the transformed
 * world layer, for the same reason the cursors and the resize handles do: it
 * is chrome, and chrome that scales with the zoom is unreadable at 30% and
 * absurd at 300%.
 *
 * Only cards are offered. A selection that also holds an envelope or a list
 * still formats the cards in it and leaves the rest alone, which is what
 * anyone who drew a marquee round a group and reached for the colour swatch
 * meant.
 *
 * Every change is one `set` op per card, which means it crosses to the other
 * people on the board and enters the undo stack for free — the point of
 * everything being an op.
 */

const SIZE_LABELS = { sm: 'S', md: 'M', lg: 'L', xl: 'XL' };
const FONT_LABELS = { sans: 'Sans', serif: 'Serif', mono: 'Mono' };

export function FormatBar({ app, stage: stageEl }) {
  const { store, selection, viewport } = app;

  /**
   * What the palette shows, asked of the stylesheet that decides.
   *
   * A card carrying `fill: 'blue'` is asking canvas.css what blue is, and a
   * swatch has to be painted before anything blue is on screen to measure — so
   * this used to be a table of hex values copied out of that stylesheet, and a
   * copy is what goes stale when a colour is retuned. `cardPalette` probes
   * instead, once per page.
   *
   * Choosing one still writes the *name*, so the card goes on asking the
   * stylesheet; only a colour mixed by hand is written as hex.
   */
  const palettes = cardPalette();

  /**
   * The colours mixed on this browser lately, which the palette has no name
   * for. Held here rather than read on each render because reading is Web
   * Storage and this renders on every viewport event — and because the picker
   * has to see the new list the moment a colour joins it.
   */
  const colours = useRef(null);
  colours.current ??= recentColours();
  const [recent, setRecent] = useState(() => colours.current.list());

  /**
   * Re-read on every change to either. The selection decides which cards, the
   * store decides what they look like and where they are, and the viewport
   * decides where that is on screen — so all three move this.
   */
  const [, bump] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    const stops = [store.on(bump), selection.on(bump), viewport.on(bump)];
    return () => stops.forEach((stop) => stop());
  }, [store, selection, viewport, bump]);

  const cards = selection
    .list()
    .map((id) => store.get(id))
    .filter((obj) => obj?.type === 'card');

  /**
   * The bar's own width and the stage's, measured after paint rather than read
   * during render.
   *
   * Reading `clientWidth` while rendering forces a layout, and this renders on
   * every viewport event — so a pan would pay for one per frame. Measuring in a
   * layout effect keeps it off that path, and the value only changes when the
   * window resizes or the controls do.
   */
  const ref = useRef(null);
  const [measured, setMeasured] = useState({ bar: 0, stage: 0 });

  useLayoutEffect(() => {
    const bar = ref.current?.offsetWidth ?? 0;
    const stage = stageEl?.clientWidth ?? 0;
    setMeasured((was) => (was.bar === bar && was.stage === stage ? was : { bar, stage }));
  });

  const at = barPosition(cards, viewport, { width: measured.stage }, measured.bar);
  if (!at) return null;

  /**
   * What the controls show with several cards selected: the shared value, or
   * nothing when they disagree. Showing the first card's would claim the
   * others match it, and pre-selecting a swatch that is only true of one of
   * them is how people change something they meant to leave alone.
   */
  const shared = (field) => {
    const values = new Set(cards.map((card) => cardStyle(card)[field]));
    return values.size === 1 ? [...values][0] : null;
  };

  /**
   * `guard` is the value a control is about to write, when it has one that can
   * be empty. The selects show a `—` placeholder while the selection disagrees,
   * and choosing it would otherwise write `''` to every card — a token no
   * stylesheet matches, saved into the board and broadcast to everyone on it.
   * `cardStyle` would paper over it on the way out, which is exactly why it
   * would go unnoticed.
   */
  const applyToAll = (patch, guard) => {
    if (guard !== undefined && guard === '') return;
    store.apply(cards.map((card) => ({ t: 'set', id: card.id, patch })));
  };

  /**
   * A colour picker for a field, showing the shared value.
   *
   * A disagreeing selection has nothing true to show, so `fallback` is what
   * appears — the default rather than one card's colour dressed up as
   * everyone's.
   */
  const picker = (field, label, fallback) => (
    <ColourPicker
      field={field}
      label={label}
      value={shared(field)}
      presets={palettes[field]}
      // Not the colours the palette already names: a row repeating the
      // swatches above it spends the panel's width saying nothing. Filtered
      // per field, because the two palettes are different — a hex that is the
      // fill blue is still worth offering as ink.
      recent={recent.filter((colour) => !palettes[field].some((preset) => preset.hex === colour))}
      fallback={fallback}
      onPick={(value) => applyToAll({ [field]: value })}
      onRemember={(hex) => setRecent(colours.current.add(hex))}
    />
  );

  return (
    <div
      ref={ref}
      className="format-bar"
      data-format-bar
      data-below={at.below ? '' : undefined}
      style={{ left: `${at.x}px`, top: `${at.y}px` }}
      // The bar is chrome over the canvas: a pointerdown that reaches the
      // stage would start a marquee and clear the very selection being
      // formatted, and the click would then land on nothing.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="fmt-group" role="group" aria-label="Fill">
        {picker('fill', 'Background colour', '#ffe98a')}
        {/*
          Transparent is not a colour, so it is not in the panel: a spectrum
          has no corner for "no paint at all", and an alpha slider would be a
          second, vaguer way of saying it. A toggle rather than a swatch —
          pressing it again puts back the colour the picker is showing, which
          is what "no fill" being off has to mean.
        */}
        <button
          type="button"
          className="fmt-transparent"
          data-value={TRANSPARENT}
          data-current={shared('fill') === TRANSPARENT ? '' : undefined}
          aria-pressed={shared('fill') === TRANSPARENT}
          aria-label="No background"
          title="No background"
          onClick={() => applyToAll({
            fill: shared('fill') === TRANSPARENT
              ? resolveColour(shared('fill'), palettes.fill, '#ffe98a')
              : TRANSPARENT,
          })}
        />
      </div>

      <span className="fmt-sep" />

      <div className="fmt-group" role="group" aria-label="Text colour">
        {picker('ink', 'Text colour', '#1c1b19')}
      </div>

      <span className="fmt-sep" />

      <select
        className="fmt-select"
        data-field="font"
        aria-label="Font"
        value={shared('font') ?? ''}
        onChange={(event) => applyToAll({ font: event.target.value }, event.target.value)}
      >
        {shared('font') === null && <option value="">—</option>}
        {CARD_FONTS.map((font) => <option key={font} value={font}>{FONT_LABELS[font]}</option>)}
      </select>

      <select
        className="fmt-select"
        data-field="size"
        aria-label="Text size"
        value={shared('size') ?? ''}
        onChange={(event) => applyToAll({ size: event.target.value }, event.target.value)}
      >
        {shared('size') === null && <option value="">—</option>}
        {CARD_SIZES.map((size) => <option key={size} value={size}>{SIZE_LABELS[size]}</option>)}
      </select>

      <span className="fmt-sep" />

      <div className="fmt-group" role="group" aria-label="Alignment">
        {CARD_ALIGNS.map((align) => (
          <button
            key={align}
            type="button"
            className="fmt-align"
            data-value={align}
            data-current={align === shared('align') ? '' : undefined}
            aria-pressed={align === shared('align')}
            aria-label={`Align ${align}`}
            title={`Align ${align}`}
            onClick={() => applyToAll({ align })}
          >
            {/* Three bars rather than a glyph: no font ships distinct
                characters for the three alignments, and `≡` three times says
                nothing about which is which. */}
            <span className="fmt-bar" />
            <span className="fmt-bar" />
            <span className="fmt-bar" />
          </button>
        ))}
      </div>
    </div>
  );
}
