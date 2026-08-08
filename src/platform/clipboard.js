import { readClipboard, writeClipboard } from '../core/clipboard.js';
import { IMAGE_PLACED_MAX, fitWithin } from '../core/image.js';

import { isTyping } from './typing.js';

/** World units each extra image in one paste is stepped down and right. */
const CASCADE = 24;

/**
 * Copy and paste, on the system clipboard.
 *
 * Through the `copy` and `paste` events rather than `navigator.clipboard`,
 * which is not a style choice: reading the clipboard asynchronously needs a
 * permission the browser prompts for, and a prompt in the middle of ⌘V is not
 * paste. A `paste` event hands the data over with no permission at all, because
 * the keystroke *is* the consent — and it is the only route by which an image on
 * the clipboard arrives as a file rather than as nothing.
 *
 * On `document`, because a canvas is a place where the thing you are acting on
 * is selected rather than focused, so there is no element to hang this on. That
 * is the same reason the board's shortcuts are on `window`, and it carries the
 * same cost: the app's own chrome is on this page too, and `isTyping` is what
 * keeps a copy inside the title field from copying the board instead.
 *
 * Where a paste lands is the pointer, when the pointer is over the board. That
 * is what makes pasting twice into two places one gesture instead of two, and it
 * matches the only thing the person can be said to have pointed at. With the
 * pointer elsewhere — a paste driven from the keyboard alone — the middle of the
 * screen is the honest answer.
 */
export function createClipboard({
  document,
  elements,
  selection,
  viewport,
  board,
  images,
  /**
   * Something a person did that produced nothing, so the app can say so. Called
   * with a code rather than a sentence: the wording belongs to the shell, which
   * is where every other message the user reads is written.
   */
  onProblem,
}) {
  const { stage } = elements;

  /**
   * Where the pointer is over the stage, in stage coordinates, or null when it
   * is somewhere else entirely. Tracked rather than asked for, because a
   * clipboard event carries no position — it is a keystroke.
   */
  let pointer = null;
  let stopped = false;

  const listeners = [];
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };

  /** Where a paste goes: under the pointer, or the middle of the view. */
  const landing = () => (pointer
    ? viewport.toWorld(pointer.x, pointer.y)
    : viewport.center(stage.clientWidth, stage.clientHeight));

  function onCopy(event) {
    // Whatever is being typed into keeps its own clipboard — the board title,
    // the hex field, a card being edited. See `isTyping`.
    if (isTyping(event.target)) return;

    const objects = board.copyable();
    if (!objects.length) return;

    event.clipboardData.setData('text/plain', writeClipboard(objects));
    // Only now: an unprevented copy with nothing selected is the browser's to
    // handle, and it handles it by copying nothing, which is correct.
    event.preventDefault();
  }

  function onPaste(event) {
    if (isTyping(event.target)) return;

    const data = event.clipboardData;
    if (!data) return;

    /**
     * Files first. A screenshot on the clipboard usually arrives as an image
     * *and* as text — a file name, a URL, the empty string — and the picture is
     * unambiguously what was copied.
     *
     * Read synchronously, and the `File` objects taken out now: a
     * `DataTransfer` belonging to an event is emptied the moment the handler
     * returns, so anything reached for after the first `await` is gone. The
     * files themselves stay valid.
     */
    const files = [...data.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);

    if (files.length) {
      event.preventDefault();
      // Not awaited: a handler that returns a promise is a handler the browser
      // has already finished with. Failures are reported through `onProblem`.
      place(files, landing());
      return;
    }

    const objects = readClipboard(data.getData('text/plain'));
    // Not ours — a paragraph from a web page, an empty clipboard. Left to the
    // browser, which will do nothing with it, rather than swallowed here.
    if (!objects) return;

    event.preventDefault();
    board.paste(objects, landing());
  }

  /**
   * Add each image, one after another rather than all at once.
   *
   * Sequential because decoding and re-encoding a photograph is real work on
   * the main thread, and several at once would compete for it and land the whole
   * set later. Cascaded, because two images pasted together at the same point
   * would be one image as far as anyone can see.
   */
  async function place(files, point) {
    const ids = [];
    let refused = 0;
    let offset = 0;

    for (const file of files) {
      const image = await images.read(file);

      // The app can be torn down while a decode is in flight — a route change
      // is faster than a photograph. Adding to the store now would repopulate a
      // board that no longer exists and set an autosave nothing can stop, the
      // same case `hydrate` guards.
      if (stopped) return;

      if (!image) {
        refused++;
        continue;
      }

      const size = fitWithin(image, IMAGE_PLACED_MAX);
      const obj = board.addCenteredOn(
        'image',
        { x: point.x + offset, y: point.y + offset },
        { src: image.src, w: size.w, h: size.h },
      );
      ids.push(obj.id);
      offset += CASCADE;
    }

    // `add` selects each one as it goes, so the last would otherwise be the
    // only one selected — and a paste of four images is one thing that happened.
    if (ids.length) selection.set(ids);
    if (refused) onProblem?.('image-refused');
  }

  listen(stage, 'pointermove', (event) => {
    const rect = stage.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  });
  // A pointer that has left the board is not pointing at a place on it.
  listen(stage, 'pointerleave', () => { pointer = null; });

  listen(document, 'copy', onCopy);
  listen(document, 'paste', onPaste);

  return {
    /** Where a paste would land right now, in world coordinates. For tests. */
    landing,
    destroy() {
      stopped = true;
      for (const off of listeners) off();
      listeners.length = 0;
    },
  };
}
