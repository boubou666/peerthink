import { CARD_FILLS, CARD_INKS } from '../core/card-style.js';
import { rgbToHex } from '../core/colour.js';

/**
 * What each named card colour actually looks like, read from the stylesheet
 * that decides.
 *
 * The picker has to paint a swatch for `blue` before anything blue is on
 * screen to measure, and the format bar used to answer that from a table of
 * hex values copied out of `canvas.css`. A copy is a second answer to a
 * question that already has one: retune a colour in the stylesheet and the
 * swatch goes on showing the old one, and the palette quietly stops being the
 * palette. The PNG export met this first and settled it the same way — see
 * `readPalette` in `export-png.js`, which probes rather than restates.
 *
 * A probe rather than a rule parser, because `--card-bg` is chosen by an
 * attribute selector and only the browser knows which rule wins. Ink is read
 * off `.card-text` inside the card, because that is where the stylesheet puts
 * colour, and the two vocabularies genuinely disagree: a blue card is pale
 * paper, blue text is dark type.
 *
 * A name the stylesheet has nothing to say about is left out rather than
 * drawn as nothing — and `none` is the standing example. It is a real fill
 * with no colour to show, so it computes to transparent, `rgbToHex` answers
 * null for it, and the format bar offers it as a toggle instead.
 *
 * Costs one layout on a handful of throwaway nodes, the first time a picker
 * needs it.
 */
export function readCardPalette({ document, window }) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;';
  document.body.appendChild(host);

  const probe = (field, name) => {
    const card = document.createElement('div');
    card.className = 'obj card';
    card.dataset[field] = name;

    const text = document.createElement('div');
    text.className = 'card-text';
    card.appendChild(text);
    host.appendChild(card);

    const style = window.getComputedStyle(field === 'fill' ? card : text);
    const read = field === 'fill' ? style.backgroundColor : style.color;

    card.remove();
    return rgbToHex(read);
  };

  const swatches = (field, names) =>
    names.map((name) => ({ name, hex: probe(field, name) })).filter((swatch) => swatch.hex);

  const palette = { fill: swatches('fill', CARD_FILLS), ink: swatches('ink', CARD_INKS) };

  host.remove();
  return palette;
}
