import { popoverPosition } from '../core/bar-position.js';
import { isImageSource } from '../core/image.js';
import { hostOf } from '../core/links.js';

/**
 * What a link on the board is, when you hover it.
 *
 * A second of hovering, then a panel with the page's title, its description, a
 * thumbnail if it has one, and the host it actually came from — or, if the page
 * did not answer with a 2xx, that it could not be reached.
 *
 * **Nothing here can be fetched by this browser.** A cross-origin `fetch` in
 * `cors` mode needs the page to grant this origin access with
 * `Access-Control-Allow-Origin`, which an arbitrary page does not — so the
 * promise rejects and the real status never arrives. In `no-cors` mode it
 * resolves, with an opaque response whose status is 0 and whose body cannot be
 * read: a 404 and a 200 are the same object. So "2xx or unreachable" is not a
 * thing a page can find out about another origin, and the fetch happens in an
 * edge function instead. `fetchPreview` is that, injected; absent, previews say
 * so rather than pretending.
 *
 * Drawn imperatively, in the overlay, rather than as a React component. That is
 * the line this app already draws: React renders chrome that *shows state* — the
 * toolbar, the format bar — and the transient, pointer-driven chrome lives here
 * with the cursors, the marquee and the alignment guides. A popover that follows
 * a pointer around a canvas is the second kind.
 *
 * Every string that came off the network is written with `textContent`. A page's
 * `<title>` is somebody else's text and this is our document: `innerHTML` here
 * would let a page anybody links to write into this one.
 */

/** How long a pointer has to stay on a link before it is a question. */
export const HOVER_MS = 1000;

/** How many answers to keep, so re-hovering a link costs nothing. */
export const CACHE_LIMIT = 40;

const LOADING = 'Loading preview…';
const UNREACHABLE = 'Unreachable';
const UNAVAILABLE = 'No preview';

export function createLinks({
  document,
  elements,
  viewport,
  scheduler,
  /**
   * `(href) => Promise<{ ok, status, title?, description?, host?, image? }>`, or
   * null where there is nothing to ask. Null is the ordinary state of the build
   * that runs without a project, exactly as it is for sharing and live edits.
   */
  fetchPreview = null,
  delay = HOVER_MS,
  cacheLimit = CACHE_LIMIT,
}) {
  const { stage, layer, overlay } = elements;

  const listeners = [];
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };

  /** Answers already had, by href. Keyed on the href, so two cards agree. */
  const answers = new Map();

  let anchor = null;   // the link under the pointer, if any
  let shown = null;    // the href the panel on screen is about
  let cancel = null;   // the pending hover timer
  let panel = null;
  let destroyed = false;

  const remember = (href, answer) => {
    answers.set(href, answer);
    // Oldest out first. A map iterates in insertion order, so the first key is
    // the least recently *added* — good enough for a cache whose job is one
    // session's hovering, and cheaper than tracking use.
    if (answers.size > cacheLimit) answers.delete(answers.keys().next().value);
  };

  const clearTimer = () => {
    cancel?.();
    cancel = null;
  };

  function hide() {
    clearTimer();
    shown = null;
    panel?.remove();
    panel = null;
  }

  /** A line of the panel, or nothing when there is nothing true to put in it. */
  const line = (className, text) => {
    if (!text) return null;
    const el = document.createElement('div');
    el.className = className;
    // Somebody else's text, in our document. Never markup.
    el.textContent = text;
    return el;
  };

  /**
   * Draw the panel for a state, and put it where the link is.
   *
   * Rebuilt rather than patched: it is four lines of text that change all at
   * once, and there is no caret or scroll position in it to preserve.
   */
  function render(state, href, answer = null) {
    if (!anchor) return;

    panel?.remove();
    panel = document.createElement('div');
    panel.className = 'link-popover';
    panel.dataset.linkPopover = state;

    const host = answer?.host ?? hostOf(href);

    if (state === 'ready') {
      // Guarded exactly as an image object's source is: this arrived over the
      // network, and only a base64 data URL of a raster type is drawn. The
      // function inlines it for that reason — so the browser makes no request of
      // its own to the site being previewed.
      if (isImageSource(answer.image)) {
        const image = document.createElement('img');
        image.className = 'link-popover-image';
        image.alt = '';
        image.src = answer.image;
        panel.appendChild(image);
      }
      panel.append(...[
        line('link-popover-title', answer.title || host),
        line('link-popover-text', answer.description),
        line('link-popover-host', host),
      ].filter(Boolean));
    } else if (state === 'unreachable') {
      panel.append(...[
        line('link-popover-title', UNREACHABLE),
        line('link-popover-text', answer?.status
          // The status is the most useful thing there is to say: a 404 is a
          // page that has moved and a 503 is one to try again later.
          ? `${host ?? 'The page'} answered ${answer.status}.`
          : `There was no answer from ${host ?? 'the page'}.`),
        line('link-popover-host', host),
      ].filter(Boolean));
    } else if (state === 'unavailable') {
      panel.append(...[
        line('link-popover-title', UNAVAILABLE),
        line('link-popover-text', 'This board is running without a project, so a link cannot be checked from here.'),
        line('link-popover-host', host),
      ].filter(Boolean));
    } else {
      panel.append(...[line('link-popover-title', LOADING), line('link-popover-host', host)].filter(Boolean));
    }

    overlay.appendChild(panel);
    place();
  }

  /**
   * Put the panel next to its link, measured rather than assumed.
   *
   * The anchor's own box, not the object's: a link is a few words inside a card
   * and the panel belongs against the words. Read after the panel is in the DOM,
   * because where it goes depends on how tall it turned out to be.
   */
  function place() {
    if (!panel || !anchor) return;

    const box = anchor.getBoundingClientRect();
    const host = stage.getBoundingClientRect();
    const at = popoverPosition(
      { x: box.left - host.left, y: box.top - host.top, w: box.width, h: box.height },
      { width: stage.clientWidth, height: stage.clientHeight },
      { width: panel.offsetWidth, height: panel.offsetHeight },
    );

    panel.style.left = `${at.x}px`;
    panel.style.top = `${at.y}px`;
    // Above means the panel's own height decides where its top ends up, which
    // is a transform's job rather than this arithmetic's — the same split the
    // format bar makes.
    if (at.below) delete panel.dataset.above;
    else panel.dataset.above = '';
  }

  /** The second is up: ask, or say why there is nothing to ask. */
  async function open(href) {
    shown = href;

    const known = answers.get(href);
    if (known) {
      render(known.ok ? 'ready' : 'unreachable', href, known);
      return;
    }

    if (!fetchPreview) {
      render('unavailable', href);
      return;
    }

    render('loading', href);

    let answer;
    try {
      answer = await fetchPreview(href);
    } catch {
      answer = null;
    }

    if (destroyed || shown !== href) return;

    /**
     * Our own side failed — the function is down, the network went, or the
     * fetcher answered something that is not an answer. That is not the link
     * being unreachable, and saying so would blame the page for our outage. Not
     * cached either: the next hover should try again.
     *
     * A malformed answer is the same case as a thrown one on purpose. This is
     * an injected function and the whole point of a boundary is not to trust
     * what comes through it: reading `.ok` off nothing would throw here, in a
     * promise nobody is waiting on, leaving the panel on "loading" for ever and
     * an unhandled rejection in the console.
     */
    // `ok` has to be a boolean, not merely present: `{}` is an object, and
    // taking it at its word would cache it and draw "unreachable" — blaming the
    // page for a fetcher that answered nonsense.
    if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
      render('unavailable', href);
      return;
    }

    remember(href, answer);
    render(answer.ok ? 'ready' : 'unreachable', href, answer);
  }

  function enter(next) {
    if (next === anchor) return;
    anchor = next;
    hide();

    const href = anchor.getAttribute('href');
    if (!href) return;
    cancel = scheduler.after(() => {
      cancel = null;
      // Nobody is waiting on this, so anything it throws would be an unhandled
      // rejection. `open` handles every failure it can name; this is the
      // backstop for the ones it cannot.
      open(href).catch(() => {});
    }, delay);
  }

  function leave() {
    anchor = null;
    hide();
  }

  listen(layer, 'pointerover', (event) => {
    const next = event.target.closest?.('[data-link]');
    if (next) enter(next);
    else if (anchor) leave();
  });

  // `pointerout` fires for every move between children too, so what matters is
  // whether the pointer has gone somewhere outside the link it was on.
  listen(layer, 'pointerout', (event) => {
    if (!anchor) return;
    if (event.relatedTarget && anchor.contains(event.relatedTarget)) return;
    leave();
  });

  /**
   * A press is the start of something — a drag, a selection, opening the link —
   * and none of them wants a panel left behind.
   */
  listen(stage, 'pointerdown', leave);

  /**
   * The panel is placed in screen space against a link in world space, so a
   * camera that moves leaves it pointing at nothing. Hiding is the honest answer
   * and costs nothing: the pointer is still on the link, and a second of not
   * moving asks again.
   */
  listeners.push(viewport.on(() => {
    if (shown || cancel) leave();
  }));

  return {
    /** What the panel is about right now, or null. For tests and the console. */
    get showing() {
      return shown;
    },
    hide: leave,
    destroy() {
      destroyed = true;
      hide();
      anchor = null;
      for (const off of listeners) off();
      listeners.length = 0;
      answers.clear();
    },
  };
}
