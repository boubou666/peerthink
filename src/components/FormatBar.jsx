import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import { barPosition } from '../core/bar-position.js';
import { linkFrom } from '../core/links.js';

import {
  CARD_ALIGNS,
  CARD_FONTS,
  CARD_SIZES,
  TRANSPARENT,
  cardStyle,
} from '../core/card-style.js';
import { CORNERS, cornersOf, hasCorners } from '../core/corners.js';

import { recentColours } from '../shell/colours.js';
import { cardPalette } from '../shell/palette.js';

import { useAsk } from './AskDialog.jsx';
import { ColourPicker, resolveColour } from './ColourPicker.jsx';

/**
 * Formatting for the selection, floating above it.
 *
 * It renders in screen space over the stage rather than inside the transformed
 * world layer, for the same reason the cursors and the resize handles do: it
 * is chrome, and chrome that scales with the zoom is unreadable at 30% and
 * absurd at 300%.
 *
 * Each control is offered to whatever it means something for, and to nothing
 * else. Colour, font, size and alignment are a card's, so a selection holding an
 * envelope and three cards formats the cards and leaves the envelope alone —
 * which is what anyone who drew a marquee round a group and reached for the
 * colour swatch meant. Corners belong to every object with an edge, so they are
 * offered for all of them, and an envelope selected on its own gets a bar with
 * that one control on it rather than no bar at all.
 *
 * Every change is one `set` op per object, which means it crosses to the other
 * people on the board and enters the undo stack for free — the point of
 * everything being an op.
 *
 * One control here is offered for a *selection of text* rather than of objects:
 * "Link", which appears while words are selected inside the object being edited
 * and turns them into a link to an address it then asks for. It is on this bar
 * because this bar is already the thing that appears above what you are working
 * on, and a second one hovering over the same card would be two answers to the
 * same question.
 */

const SIZE_LABELS = { sm: 'S', md: 'M', lg: 'L', xl: 'XL' };
const FONT_LABELS = { sans: 'Sans', serif: 'Serif', mono: 'Mono' };
const CORNER_LABELS = { round: 'Rounded corners', square: 'Square corners' };

export function FormatBar({ app, stage: stageEl, onProblem }) {
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

  /**
   * And on the text selection, which is the browser's rather than the board's.
   *
   * `selectionchange` is the only event for it, and it says nothing about what
   * changed — so the answer is re-read below on every render rather than kept
   * here, and this only says "look again". The focus events are in it because a
   * field can lose the caret without the selection moving, and a control offered
   * for a selection nobody is in is a control that does nothing.
   *
   * On a microtask, because during `focusout` the focus has left and has not
   * arrived: `document.activeElement` is the body, and asking then would answer
   * for a moment that is over by the time anything renders.
   */
  useEffect(() => {
    const later = () => queueMicrotask(bump);
    const events = ['selectionchange', 'focusin', 'focusout'];
    for (const type of events) document.addEventListener(type, later);
    return () => events.forEach((type) => document.removeEventListener(type, later));
  }, [bump]);

  /** The question this bar asks: which address the selected words point at. */
  const [dialog, ask] = useAsk();

  const objects = selection.list().map((id) => store.get(id)).filter(Boolean);
  const cards = objects.filter((obj) => obj.type === 'card');
  /**
   * What the corner control writes to. Every type this build draws is in it, so
   * in practice this is the selection — but it is asked rather than assumed,
   * because an object from a newer client is one whose corners no rule here
   * knows how to draw.
   */
  const cornered = objects.filter(hasCorners);

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

  /**
   * The words that could become a link, when there are any — read on every
   * render, because a caret move is not something the board hears about.
   */
  const linkable = app.textLinks.label();

  /**
   * Ask where the selected words should point, and make them point there.
   *
   * What is selected is taken *first*: the dialog's field takes the focus, and
   * the focus is what the selection belongs to. From then on this is arithmetic
   * on a string and an op, so an answer that arrives after the caret has gone
   * still lands in the right place.
   *
   * An address that cannot be followed is asked again rather than refused,
   * keeping what was typed — the usual reason is a typo in the scheme, and
   * throwing the rest of the address away to say so helps nobody. `linkFrom`
   * accepts a bare domain here, which prose deliberately does not.
   *
   * The insertion can still come to nothing, once: the words are a pair of
   * offsets into the string they were measured in, and somebody else on the
   * board can replace that string while the question is open. Asking again
   * would be no use — those offsets are gone whatever is typed next — so this
   * is reported the way every other thing the canvas could not do is, in a
   * sentence the shell writes.
   */
  const addLink = async () => {
    const chosen = app.textLinks.capture();
    if (!chosen) return;

    const words = chosen.label.replace(/\s+/g, ' ').trim();
    const named = words.length > 48 ? `${words.slice(0, 48)}…` : words;

    let typed = '';
    let refused = false;
    for (;;) {
      const answer = await ask.prompt({
        title: 'Add a link',
        message: refused
          ? 'That is not an address this can open — links go to http or https pages.'
          : `“${named}” will point at this address.`,
        label: 'Address',
        value: typed,
        confirmLabel: 'Add link',
      });
      if (answer === null) return;

      const href = linkFrom(answer);
      if (href) {
        if (!chosen.insert(href)) onProblem?.('link-lost');
        return;
      }
      typed = answer;
      refused = true;
    }
  };

  /**
   * Above everything the bar can act on, rather than above everything selected.
   * A type this build has no control for contributes nothing to where the bar
   * goes — and a selection of nothing but those gets no bar, which is the same
   * answer as a selection of nothing.
   */
  const at = barPosition(cornered, viewport, { width: measured.stage }, measured.bar);
  // The question goes with the bar: unmounting it while one is open refuses it,
  // which is the right answer for a selection that is no longer there.
  if (!at) return null;

  /**
   * What a control shows for several objects: the shared value, or nothing when
   * they disagree. Showing the first one's would claim the others match it, and
   * pre-selecting a swatch that is only true of one of them is how people change
   * something they meant to leave alone.
   */
  const sharedIn = (list, read) => {
    const values = new Set(list.map(read));
    return values.size === 1 ? [...values][0] : null;
  };

  const shared = (field) => sharedIn(cards, (card) => cardStyle(card)[field]);
  const sharedCorners = () => sharedIn(cornered, cornersOf);

  /** One `set` op per object, which is what puts a change on the wire and in the undo stack. */
  const applyTo = (list, patch) => store.apply(list.map((obj) => ({ t: 'set', id: obj.id, patch })));

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
    applyTo(cards, patch);
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
    <>
    {dialog}
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
      {/*
        A selection with no cards in it — an envelope, a list, a pasted image —
        gets none of this. Every control in here writes a field only a card
        renders, and one that does nothing visible is worse than one that is
        not there.
      */}
      {cards.length > 0 && (
        <>
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

          <span className="fmt-sep" />
        </>
      )}

      {/*
        Corners, for everything selected that has any.

        Two buttons rather than one toggle: a selection where some objects are
        rounded and some are not has no true answer for a pressed state, and a
        toggle would have to invent one. This way neither is current, which is
        what the alignment group already does and says the same thing.
      */}
      <div className="fmt-group" role="group" aria-label="Corners">
        {CORNERS.map((corners) => (
          <button
            key={corners}
            type="button"
            className="fmt-corner"
            data-value={corners}
            data-current={corners === sharedCorners() ? '' : undefined}
            aria-pressed={corners === sharedCorners()}
            aria-label={CORNER_LABELS[corners]}
            title={CORNER_LABELS[corners]}
            onClick={() => applyTo(cornered, { corners })}
          >
            {/* The control is the shape it makes — a box with the corners in
                question, which no glyph says as plainly. */}
            <span className="fmt-corner-box" />
          </button>
        ))}
      </div>

      {/*
        Words selected inside the object being edited, and nothing else — a
        control that acts on a selection of text has nothing to act on without
        one, and text that is already a link is not offered the chance to
        become another.
      */}
      {linkable && (
        <>
          <span className="fmt-sep" />
          <button
            type="button"
            className="fmt-link"
            data-action="add-link"
            aria-label="Add a link"
            title="Add a link"
            /*
              The press must not take the focus. The selection this acts on is
              the field's, and a button that focuses itself has thrown away
              what it was about by the time the click arrives — so the default
              is cancelled here, and the caret stays where the words are.
            */
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
            }}
            onClick={addLink}
          >
            Link
          </button>
        </>
      )}
    </div>
    </>
  );
}
