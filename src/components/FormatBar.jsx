import { useEffect, useReducer } from 'react';

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

/** Where the bar sits, in stage coordinates, given what is selected. */
export function barPosition(cards, viewport, stage) {
  if (!cards.length) return null;

  const left = Math.min(...cards.map((card) => card.x));
  const right = Math.max(...cards.map((card) => card.x + card.w));
  const top = Math.min(...cards.map((card) => card.y));

  const a = viewport.toScreen(left, top);
  const b = viewport.toScreen(right, top);

  return {
    // Centred over the selection, then held inside the stage: a card near the
    // left edge would otherwise put half the bar off-screen, where its
    // swatches cannot be clicked.
    x: Math.min(Math.max((a.x + b.x) / 2, MIN_MARGIN), Math.max(stage.width - MIN_MARGIN, MIN_MARGIN)),
    // Above the selection, or below it when there is no room — a card at the
    // top of the view is exactly the one whose bar would be off the top.
    y: a.y - GAP,
    below: a.y - GAP < MIN_MARGIN,
  };
}

const GAP = 14;
const MIN_MARGIN = 8;

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

  const stage = { width: stageEl.clientWidth, height: stageEl.clientHeight };
  const at = barPosition(cards, viewport, stage);
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

  const applyToAll = (patch) => {
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
      aria-label={`${field} ${value}`}
      title={value}
      onClick={() => applyToAll({ [field]: value })}
    />
  ));

  return (
    <div
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
        onChange={(event) => applyToAll({ font: event.target.value })}
      >
        {shared('font') === null && <option value="">—</option>}
        {CARD_FONTS.map((font) => <option key={font} value={font}>{FONT_LABELS[font]}</option>)}
      </select>

      <select
        className="fmt-select"
        data-field="size"
        aria-label="Text size"
        value={shared('size') ?? ''}
        onChange={(event) => applyToAll({ size: event.target.value })}
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
