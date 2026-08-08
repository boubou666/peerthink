/**
 * Images on the board: what a source may be, and how large one lands.
 *
 * An image object is `{ type: 'image', x, y, w, h, src }`, and `src` is the
 * picture itself as a data URL rather than a link to one. The board is a
 * document that is stored whole, broadcast to the other people on it and
 * exported to a PNG — three places a link would have to still resolve, from
 * whatever network the reader happens to be on. Carrying the bytes means an
 * image that is on the board is on the board.
 *
 * The cost is that the bytes are in the document, which is why the import
 * policy below is a policy rather than a formality: everything here exists to
 * keep one pasted screenshot from turning a board into something too big to
 * broadcast. `platform/images.js` is what enforces it, because deciding needs
 * no browser and re-encoding does.
 */

/**
 * A source an image object may carry.
 *
 * A data URL, base64, and one of the raster types a browser decodes. Matched
 * strictly and for the same reason `isCustomColour` is: this value does not come
 * only from the person at the keyboard — an object arrives over the board's
 * channel from anyone authorised to edit it, and goes into an `img` element
 * here. A remote URL in there is a request this browser makes to a host of
 * somebody else's choosing, which reports the reader's address and presence to
 * it; `svg+xml` is a document rather than a bitmap, and an unbounded one.
 *
 * So what is not plainly a picture is not rendered. The same rule the style
 * tokens follow: fall back to nothing rather than pass it through.
 */
const SOURCE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

export const isImageSource = (value) => typeof value === 'string' && SOURCE.test(value);

/**
 * The largest side, in pixels, that an imported bitmap is stored at.
 *
 * A phone camera photograph is 4000 pixels across and a screenshot of a 4K
 * display is not far off. Neither is worth keeping at full size in a document
 * that is saved on every edit and sent to everyone on the board — an image on a
 * canvas is looked at somewhere between a thumbnail and a screenful, and 1200
 * is generous for that with room to zoom in.
 */
export const IMAGE_PIXELS_MAX = 1200;

/**
 * The most characters an imported source may run to.
 *
 * The binding constraint is the channel, not the disk: ops are broadcast, and a
 * broadcast has a payload limit an `add` carrying a whole picture is the only
 * op that can reach. Under it, pasting an image is a live edit like any other;
 * over it, the send fails and the image reaches the other people on the board
 * on their next load instead — the failure is soft, which is exactly why it is
 * worth spending some quality to stay under.
 *
 * base64 is four characters per three bytes, so this is around 180KB of image.
 *
 * A *render* guard it is not. An object that arrives over the channel carrying
 * more than this is drawn: it is a real image that some other client had a
 * reason to make, and refusing to show it would lose a picture rather than
 * save anything. This is what the import here will produce.
 */
export const IMAGE_SOURCE_LIMIT = 240_000;

/**
 * The largest side, in world units, that a pasted image is placed at.
 *
 * A card is 200 × 120, so this is a few cards across — big enough to see what
 * the picture is, small enough that dropping a screenshot on a board does not
 * bury what was already there. The eight resize handles are right there for
 * anyone who wants it bigger, and resizing changes the box rather than the
 * bytes.
 */
export const IMAGE_PLACED_MAX = 480;

/**
 * A size scaled down to fit inside a square of `max`, keeping its proportions.
 *
 * Only ever down: an image smaller than the box is left at its own size, both
 * on the board — where blowing a 40 × 30 favicon up to 480 wide would be a
 * decision nobody asked for — and in the re-encode, where there is no detail to
 * invent.
 *
 * Rounded, because these become pixel dimensions of a canvas and world
 * coordinates in a document, and both are integers everywhere else. Never below
 * one: a canvas of zero width throws, and an object of zero height cannot be
 * grabbed.
 */
export function fitWithin({ w, h } = {}, max) {
  // Both sides, not the longer one: a picture whose height is a number and
  // whose width is not is not a picture, and floor-at-one would turn it into a
  // one-pixel column rather than say so.
  if (![w, h].every((side) => Number.isFinite(side) && side > 0)) return null;

  const ratio = Math.min(1, max / Math.max(w, h));
  return {
    w: Math.max(1, Math.round(w * ratio)),
    h: Math.max(1, Math.round(h * ratio)),
  };
}
