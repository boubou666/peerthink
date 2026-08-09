/**
 * Making a link out of the words somebody has selected.
 *
 * The document holds a plain string, so a link with a label is
 * `[our roadmap](https://…)` in it — `core/links.js` decides what that means and
 * builds the new string. What is left here is the browser's half, and it is the
 * whole reason this is a module rather than three lines in a component: a
 * selection is a pair of DOM nodes and offsets, and the string is a string, so
 * something has to turn one into the other.
 *
 * **The offsets are measured with the browser's own answer, not by walking the
 * DOM.** A field's text is read back through `innerText` everywhere else in this
 * app, and `innerText` is not `textContent` — it is what the *layout* says,
 * which is where `<br>` becomes a newline and a trailing one stops counting.
 * Re-implementing that walk would be a second opinion about the same string, and
 * the two would disagree the first time somebody pressed Enter. So a marker is
 * put at each end of the selection, `innerText` is read once with them in, and
 * the marks are taken out again: the numbers that come back are offsets into
 * exactly the string the store holds.
 *
 * The mutation is invisible — no paint happens between putting the marks in and
 * taking them out — and it is undone twice over, because the field is blurred
 * straight afterwards and drawn again from the store.
 */

import { canLabel, linkedText } from '../core/links.js';

/**
 * The marker: one character from the private use area.
 *
 * It has to be something `innerText` reports as itself — a comment or an empty
 * element contributes nothing to it, and whitespace would be collapsed or
 * trimmed. It also has to be something nobody types, which no printable
 * character is.
 */
const MARK = '\uE000';

export function createTextLinks({ document, window, store }) {
  /**
   * The selection, when it is a run of text inside one editable field.
   *
   * Both ends have to be in the same field: a selection that starts in a card
   * and ends in the one behind it is not a label, and neither is a caret, which
   * is a collapsed range and has no text in it at all.
   */
  const selected = () => {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

    const field = document.activeElement;
    if (!field?.isContentEditable) return null;

    const range = selection.getRangeAt(0);
    if (!field.contains(range.startContainer) || !field.contains(range.endContainer)) return null;

    return { field, range, text: selection.toString() };
  };

  /**
   * Where the selection is in the field's own string.
   *
   * The end mark goes in first: inserting the start one splits the text node in
   * front of it, and a node already in the document does not care.
   *
   * Two answers are checked rather than trusted. The text in front of the first
   * mark has to be the text that was in front of it before — that is what says
   * the number means what it claims. And the end is clamped to the length of the
   * string, because a mark placed after the last line break makes that break
   * count where it did not before, which is `innerText`'s rule about trailing
   * ones and not a reason to refuse.
   */
  const measure = (field, range) => {
    const text = field.innerText;
    if (text.includes(MARK)) return null;

    const head = document.createTextNode(MARK);
    const tail = document.createTextNode(MARK);

    /**
     * Taken out whatever happens. These characters are in a live field, and a
     * field is read back through `innerText` by the next thing typed into it —
     * so a mark left behind by a throw would be written into the store and
     * broadcast to everyone else on the board. `remove()` on a node that was
     * never inserted does nothing, which is the case where the first
     * `insertNode` is what threw.
     */
    let marked;
    try {
      const to = range.cloneRange();
      to.collapse(false);
      to.insertNode(tail);

      const from = range.cloneRange();
      from.collapse(true);
      from.insertNode(head);

      marked = field.innerText;
    } finally {
      head.remove();
      tail.remove();
      // The marks left split text nodes either side of where they were.
      field.normalize();
    }

    const start = marked.indexOf(MARK);
    const second = marked.indexOf(MARK, start + 1);
    if (start < 0 || second < 0) return null;
    if (marked.slice(0, start) !== text.slice(0, start)) return null;

    const end = Math.min(second - MARK.length, text.length);
    return end > start ? { text, start, end } : null;
  };

  return {
    /**
     * The words that could become a link's label, or null.
     *
     * Asked on every caret move, so it costs one `getSelection` and no layout —
     * the measuring above is the expensive half and only runs on a click.
     */
    label() {
      const here = selected();
      if (!here) return null;
      return canLabel(here.text) ? here.text : null;
    },

    /**
     * Hold on to what is selected, before anything else can take the focus.
     *
     * Answering "which address" needs a field of its own, and focusing that
     * field is what ends the selection this is about — so everything the
     * insertion needs is taken now and the answer arrives later. What comes back
     * is the label, so the question can name what it is about, and `insert`.
     *
     * The field is blurred here rather than left to the dialog: it ends the
     * editing session at a moment we chose, which records the typing as its own
     * undo step and puts the links back in the field whether the question is
     * answered or waved away.
     */
    capture() {
      const here = selected();
      if (!here) return null;

      const objEl = here.field.closest('[data-id]');
      if (!objEl) return null;

      const id = objEl.dataset.id;
      const field = here.field.dataset.field;
      const itemId = here.field.closest('[data-item-id]')?.dataset.itemId ?? null;

      const span = measure(here.field, here.range);
      if (!span) return null;

      const label = span.text.slice(span.start, span.end);
      if (!canLabel(label)) return null;

      here.field.blur();

      return {
        label,

        /**
         * The link, as one recorded `set` — so it enters the undo stack and
         * crosses to everyone else on the board, exactly as typing does.
         *
         * Refuses when the field is no longer holding the string that was
         * measured: another editor's change can land while the question is
         * open, and offsets into a string that is gone would cut somebody
         * else's sentence in half.
         */
        insert(href) {
          const obj = store.get(id);
          if (!obj) return false;

          const item = itemId ? obj.items?.find((i) => i.id === itemId) : null;
          if (itemId && !item) return false;

          const was = itemId ? item.text : obj[field];
          if (was !== span.text) return false;

          const next = linkedText(span.text, span.start, span.end, href);
          const patch = itemId
            ? { items: obj.items.map((i) => (i.id === itemId ? { ...i, text: next } : i)) }
            : { [field]: next };

          store.apply([{ t: 'set', id, patch }]);
          return true;
        },
      };
    },
  };
}
