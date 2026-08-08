import { IMAGE_PIXELS_MAX, IMAGE_SOURCE_LIMIT, fitWithin, isImageSource } from '../core/image.js';

/**
 * Turning a pasted file into something a board can hold.
 *
 * What arrives on a clipboard is whatever the program that put it there had —
 * a 12-megapixel photograph, a lossless screenshot of a whole 4K display, a
 * TIFF, an SVG. What a board can hold is a bounded data URL, because the
 * document is stored whole, broadcast to everyone on it and drawn to a canvas.
 * This is the join between the two, and the whole of what it does is decide
 * whether the bytes can be kept as they are and re-encode them when they
 * cannot.
 *
 * The limits are arguments rather than constants so a test can drive the
 * shrinking path without manufacturing a four-megabyte picture: the interesting
 * behaviour is "too big for the budget", and the budget is the cheap half of
 * that sentence to change.
 */
export function createImageImport({
  document,
  window,
  maxPixels = IMAGE_PIXELS_MAX,
  maxLength = IMAGE_SOURCE_LIMIT,
  /**
   * What a re-encode aims for. WebP because it is the smallest thing every
   * browser that runs this app decodes, and 0.85 because the subject is a
   * screenshot as often as a photograph — text is what shows compression first,
   * and it survives this.
   */
  type = 'image/webp',
  quality = 0.85,
  /**
   * How many times to try smaller before giving up. Each attempt is 70% of the
   * last side, so three of them cover a factor of three in each dimension —
   * roughly an order of magnitude of bytes — and anything still over budget
   * after that is not an image somebody is pasting onto a whiteboard.
   */
  attempts = 3,
  shrinkBy = 0.7,
} = {}) {
  /** The bytes as they are, or null when the browser will not read them. */
  const dataUrlOf = (blob) => new Promise((resolve) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });

  /**
   * The bitmap, redrawn at `size` and encoded.
   *
   * A canvas rather than any smaller operation, because this is also what
   * *normalises* the image: whatever came in — a TIFF, an SVG, a JPEG carrying
   * the camera position it was taken at — comes out as one of the types
   * `isImageSource` accepts, with no metadata attached, because a canvas has
   * none to give it.
   */
  const encode = (bitmap, size) => {
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size.w, size.h);

    const src = canvas.toDataURL(type, quality);
    // A context that could not encode answers with a placeholder rather than
    // throwing — `data:,` — which would otherwise be stored as a picture.
    return isImageSource(src) ? src : null;
  };

  return {
    /**
     * A blob as `{ src, w, h }` — the source to store, and the size the bitmap
     * actually is — or null when there is no image to be had.
     *
     * Null is not an exception, it is an answer: a file that claims to be a PNG
     * and is not, and a picture too large to bring under the budget, are both
     * things a person can paste and both things the caller has to say something
     * about. Throwing would make a failed paste look like a broken app.
     */
    async read(blob) {
      let bitmap;
      try {
        bitmap = await window.createImageBitmap(blob);
      } catch {
        return null;
      }

      try {
        // Named rather than passed whole: an `ImageBitmap` says `width` and
        // `height`, and an object on the board says `w` and `h`.
        const size = fitWithin({ w: bitmap.width, h: bitmap.height }, maxPixels);
        if (!size) return null;

        /**
         * Small enough already: keep the bytes exactly as they came.
         *
         * Re-encoding everything would be one code path instead of two, and it
         * would also mean a screenshot pasted straight from the clipboard —
         * crisp, lossless, and already small — being stored as a lossy copy of
         * itself for no benefit at all. `blob.size` is the test rather than the
         * encoded length because it is free, and base64 is a known four
         * characters per three bytes.
         */
        if (size.w === bitmap.width && size.h === bitmap.height && blob.size * 4 / 3 <= maxLength) {
          const original = await dataUrlOf(blob);
          // A type this app does not render — an SVG, a TIFF the browser
          // decoded — falls through to the canvas below, which turns it into
          // one that is. Only an unreadable blob ends here.
          if (isImageSource(original) && original.length <= maxLength) {
            return { src: original, w: size.w, h: size.h };
          }
        }

        let target = size;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const src = encode(bitmap, target);
          if (src && src.length <= maxLength) return { src, w: target.w, h: target.h };

          const smaller = fitWithin(target, Math.max(1, Math.floor(Math.max(target.w, target.h) * shrinkBy)));
          // A one-pixel image that is still over budget is not going to get
          // smaller, and neither is one the context refused to encode.
          if (!smaller || (smaller.w === target.w && smaller.h === target.h)) break;
          target = smaller;
        }

        return null;
      } finally {
        // An ImageBitmap holds decoded pixels — several megabytes for a
        // photograph — until it is collected. Released here rather than left to
        // the garbage collector, because a session of pasting is a session of
        // allocating these.
        bitmap.close?.();
      }
    },
  };
}
