import { normaliseHex } from '../core/colour.js';

/**
 * Picking a colour off the screen, where the browser offers it.
 *
 * The one thing the native `<input type="color">` could do that a panel drawn
 * in the page cannot: sample any pixel, including pixels outside the window.
 * That needs a privileged eyedropper, and `EyeDropper` is the browser's — it
 * is what makes "the same blue as that card" a click rather than a hunt.
 *
 * Chromium ships it and the others do not, which is why this is asked rather
 * than assumed. A control that is missing is honest; one that is present and
 * throws is not, so the button is not rendered at all where the capability is
 * absent.
 */

export const canPickFromScreen = (window) => typeof window?.EyeDropper === 'function';

/**
 * The colour picked, or null.
 *
 * Null covers every way this ends without a colour, and they are all ordinary:
 * Escape dismisses the eyedropper, a page that is not allowed to open one is
 * refused, and a browser can abort it for reasons of its own. None of that is
 * an error worth showing — the panel is still open, with the colour it had.
 */
export async function pickFromScreen(window) {
  try {
    const { sRGBHex } = await new window.EyeDropper().open();
    return normaliseHex(sRGBHex);
  } catch {
    return null;
  }
}
