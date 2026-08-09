/**
 * Per-type DOM.
 *
 * Objects are real elements inside the transformed world layer, so text
 * editing, IME, selection and styling come from the browser rather than from
 * us. `document` is injected so the view layer has no ambient dependency on a
 * global window.
 *
 * Rule for every `update`: never write to the field the user is focused on.
 */

import { CARD_STYLE_FIELDS, cardStyle, namedColour } from '../core/card-style.js';
import { isImageSource } from '../core/image.js';
import { linkRuns } from '../core/links.js';

export function createViews({ document }) {
  const element = (html) => {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  };

  /** The property each colour field would have set, had it been a named one. */
  const CUSTOM_PROPERTY = { fill: '--card-bg', ink: '--card-ink' };

  /**
   * What each field was last given, so an unchanged one is not rebuilt.
   *
   * This used to compare `el.innerText`, which was free and honest while a
   * field held nothing but text. It cannot survive links: what goes in is a
   * string and what comes back out is a string read off elements, and the two
   * agree in every case but are not the same object to compare. A rebuild on
   * every `update` would mean rebuilding on every frame of a drag.
   *
   * A `WeakMap` rather than a data attribute, because the whole text would then
   * be in the document twice, and this entry should go when the element does.
   */
  const rendered = new WeakMap();

  /**
   * Put text in a field, with any links in it as links.
   *
   * Built out of nodes, never out of markup. The text is a person's — pasted
   * from anywhere, and arriving over the board's channel from anyone authorised
   * to edit it — so `innerHTML` here would be a card that can write the page.
   * `createTextNode` and `textContent` cannot: whatever the string holds is
   * shown as the characters it is.
   *
   * `href` comes from `hrefFor`, which is what refuses every scheme but http and
   * https. The anchor also carries `noopener noreferrer`, so a page opened from
   * a board cannot reach back through `window.opener`.
   *
   * The rule the whole view layer follows still holds: never write to the field
   * the user is focused on. That is also why a link typed just now becomes a
   * link on blur rather than mid-word — `input.js` asks for the re-render.
   */
  const setText = (el, value) => {
    const text = value ?? '';
    if (document.activeElement === el) return;
    if (rendered.get(el) === text) return;
    rendered.set(el, text);

    el.replaceChildren(...linkRuns(text).map((run) => {
      if (!run.href) return document.createTextNode(run.text);

      const link = document.createElement('a');
      link.className = 'link';
      link.href = run.href;
      // What the input layer and the hover popover look for. The `href` alone
      // would match an anchor from anywhere; this one is the board's.
      link.dataset.link = '';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = run.text;
      // Only a labelled link has one, and it is what `showSource` puts back —
      // the characters the document holds, which this anchor is showing as
      // words. A link that is its own address needs nothing here, and the text
      // is not written into the DOM twice for it.
      if (run.source) link.dataset.source = run.source;
      return link;
    }));
  };

  /**
   * A field's own characters, back in it, for the person about to edit them.
   *
   * A labelled link is the one place where what is on screen is not what the
   * store holds, and every edit reads a field back through `innerText` — so a
   * single keystroke anywhere in a card would otherwise write the labels down
   * and lose every address in it. Editing therefore shows the source, and blur
   * puts the links back through `relink`.
   *
   * Only the labelled ones. A link that is its own address reads back as itself,
   * so leaving it alone costs nothing and keeps a URL blue while it is being
   * edited, which is what it has always done.
   *
   * The rendered record has to go with it: it says what this element is showing,
   * and after this it is showing something else — without that, the redraw on
   * blur would decide there was nothing to do.
   */
  const showSource = (el) => {
    const labelled = el.querySelectorAll('[data-link][data-source]');
    if (!labelled.length) return;

    /**
     * Replaced, and the text either side deliberately left unmerged. A
     * `normalize()` here would tidy three adjacent text nodes into one — and
     * remove two of them, which are exactly the nodes the caret is about to be
     * placed into: the input layer works out where the pointer was *before*
     * focusing, because revealing a source moves everything after it along the
     * line. Nothing depends on the shape, and the next redraw builds the field
     * from scratch anyway.
     */
    for (const link of labelled) link.replaceWith(document.createTextNode(link.dataset.source));
    rendered.delete(el);
  };

  const itemRow = (item) => {
    const row = element(`<div class="list-item">
      <div class="li-check"></div>
      <div class="li-text" contenteditable="true" data-field="item"></div>
    </div>`);
    row.dataset.itemId = item.id;
    row.classList.toggle('done', !!item.done);
    // Through `setText`, so a row has its links from the first frame rather
    // than from the first update after it.
    setText(row.querySelector('[data-field="item"]'), item.text);
    return row;
  };

  return {
    showSource,
    /**
     * Text into a field, links and all — for the one piece of text that is not
     * an object's: a connector's label, which the layer that draws the arrows
     * owns. Shared rather than repeated, so a URL written on an arrow is a link
     * exactly as one written on a card is.
     */
    setText,

    card: {
      create: () => element(`<div class="obj card">
        <div class="card-text" contenteditable="true" data-field="text"></div>
      </div>`),
      update(el, obj) {
        /**
         * One attribute per style field, resolved through cardStyle so an
         * unknown token from a newer client falls back instead of matching no
         * rule at all — which would draw a card with no background.
         *
         * A colour the card carries itself cannot be an attribute, because no
         * stylesheet rule can be written for a value nobody knew in advance.
         * It goes in as the custom property the rules would have set, with the
         * attribute reading `custom` so the two cases stay distinguishable —
         * from CSS, and from a test.
         */
        const style = cardStyle(obj);
        for (const field of CARD_STYLE_FIELDS) {
          const value = style[field];
          const custom = CUSTOM_PROPERTY[field] && !namedColour(value);
          el.dataset[field] = custom ? 'custom' : value;
          if (!CUSTOM_PROPERTY[field]) continue;
          if (custom) el.style.setProperty(CUSTOM_PROPERTY[field], value);
          else el.style.removeProperty(CUSTOM_PROPERTY[field]);
        }
        setText(el.querySelector('[data-field="text"]'), obj.text);
      },
    },

    envelope: {
      create: () => element(`<div class="obj envelope">
        <div class="envelope-title" contenteditable="true" data-field="title"></div>
      </div>`),
      update(el, obj) {
        setText(el.querySelector('[data-field="title"]'), obj.title);
      },
    },

    list: {
      create: () => element(`<div class="obj list">
        <div class="list-title" contenteditable="true" data-field="title"></div>
        <div class="list-items"></div>
        <button class="list-add" type="button">+ item</button>
      </div>`),
      update(el, obj) {
        setText(el.querySelector('[data-field="title"]'), obj.title);

        const box = el.querySelector('.list-items');
        const items = obj.items ?? [];
        const key = items.map((i) => i.id).join(',');

        // rebuild only when the set of rows changed; otherwise patch in place
        // so the caret and scroll position survive a keystroke
        if (box.dataset.key !== key) {
          box.textContent = '';
          for (const item of items) box.appendChild(itemRow(item));
          box.dataset.key = key;
          return;
        }
        for (const item of items) {
          const row = box.querySelector(`[data-item-id="${item.id}"]`);
          if (!row) continue;
          row.classList.toggle('done', !!item.done);
          setText(row.querySelector('[data-field="item"]'), item.text);
        }
      },
    },

    /**
     * A picture, carried by the document rather than linked from it.
     *
     * `alt` is empty because there is nothing true to put in it: nobody typed a
     * description, and inventing "image" would read out a word that adds nothing
     * to what the board already says. `draggable` is off so that dragging the
     * object moves it, instead of the browser offering to drag the picture out
     * of the page.
     */
    image: {
      create: () => element(`<div class="obj image">
        <img class="image-bitmap" alt="" draggable="false">
      </div>`),
      update(el, obj) {
        const img = el.querySelector('img');
        const src = typeof obj.src === 'string' ? obj.src : '';

        /**
         * Compared with what is already there before anything else happens.
         * `update` runs for every op that touches the object — which is every
         * frame of a drag — and the guard below is a regular expression over the
         * whole picture, so an unchanged source is worth not looking at twice.
         */
        if (img.getAttribute('src') === src) return;

        // Removed rather than emptied: `src=""` is a request for the page
        // itself, so an object whose source is not a picture would fetch the
        // document and draw a broken image where nothing belongs.
        if (isImageSource(src)) img.setAttribute('src', src);
        else img.removeAttribute('src');
      },
    },
  };
}
