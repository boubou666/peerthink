import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import {
  CARD_ALIGNS,
  CARD_FILLS,
  CARD_FONTS,
  CARD_INKS,
  CARD_SIZES,
  cardStyle,
} from '../core/card-style.js';

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

/** What a screen reader should say, rather than the token stored. */
const SWATCH_LABELS = {
  fill: {
    yellow: 'Yellow background', blue: 'Blue background', green: 'Green background',
    pink: 'Pink background', white: 'White background', none: 'No background',
  },
  ink: {
    ink: 'Black text', muted: 'Grey text', red: 'Red text',
    blue: 'Blue text', white: 'White text',
  },
};

const GAP = 14;
const MIN_MARGIN = 8;

/**
 * Where the bar sits, in viewport coordinates, given what is selected.
 *
 * `x` is the bar's *centre*, because that is what the transform positions by.
 * Clamping it therefore has to allow for half the bar's own width — clamping
 * the centre alone still leaves half the controls off-screen, which is exactly
 * the failure the clamp is here to prevent. `width` is measured rather than
 * assumed, and is 0 on the first paint, when the clamp simply does less.
 *
 * `below` derives from the selection's *bottom*, not its top. Flipping the
 * transform while keeping the top would draw the bar downwards from above the
 * cards and cover them.
 */
export function barPosition(cards, viewport, stage, width = 0) {
  if (!cards.length) return null;

  const left = Math.min(...cards.map((card) => card.x));
  const right = Math.max(...cards.map((card) => card.x + card.w));
  const top = Math.min(...cards.map((card) => card.y));
  const bottom = Math.max(...cards.map((card) => card.y + card.h));

  const topLeft = viewport.toScreen(left, top);
  const topRight = viewport.toScreen(right, top);
  const under = viewport.toScreen(left, bottom);

  const half = width / 2;
  const lowest = MIN_MARGIN + half;
  const highest = stage.width - MIN_MARGIN - half;

  // A bar wider than the stage cannot satisfy both margins; centring it is the
  // least bad answer, and is what `Math.max` picks when the bounds cross.
  const centre = (topLeft.x + topRight.x) / 2;
  const below = topLeft.y - GAP < MIN_MARGIN;

  return {
    x: Math.min(Math.max(centre, lowest), Math.max(highest, lowest)),
    y: below ? under.y + GAP : topLeft.y - GAP,
    below,
  };
}

export function FormatBar({ app, stage: stageEl }) {
  const { store, selection, viewport } = app;

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

  const swatches = (field, values, current) => values.map((value) => (
    <button
      key={value}
      type="button"
      className={`fmt-swatch fmt-${field}`}
      data-value={value}
      data-current={value === current ? '' : undefined}
      aria-pressed={value === current}
      aria-label={SWATCH_LABELS[field][value]}
      title={SWATCH_LABELS[field][value]}
      onClick={() => applyToAll({ [field]: value })}
    />
  ));

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
        {swatches('fill', CARD_FILLS, shared('fill'))}
      </div>

      <span className="fmt-sep" />

      <div className="fmt-group" role="group" aria-label="Text colour">
        {swatches('ink', CARD_INKS, shared('ink'))}
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
