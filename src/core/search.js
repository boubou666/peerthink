/**
 * Finding words on a board.
 *
 * A board grows past its screen almost immediately — that is the point of an
 * infinite canvas — and past that moment "where did I write that" is a question
 * panning cannot answer. The browser's own find cannot answer it either: it
 * reads the document, and the objects off screen have been culled out of it.
 *
 * Pure, and over plain data rather than over the sheets module, so the whole of
 * it is testable without a store: what arrives is `[{ id, name, objects }]` and
 * what comes back is where the words are.
 *
 * The *stored* text is searched rather than the displayed text, so a labelled
 * link matches both by what it says and by where it goes. Somebody looking for
 * `plan.test` is looking for the address, and somebody looking for "roadmap" is
 * looking for the words; the characters the document holds are the only string
 * that contains them both.
 */

import { isPlaced } from './connectors.js';

/** Every string a person can have typed into an object, as one. */
export function textOf(obj) {
  const parts = [obj?.text, obj?.title, ...(obj?.items ?? []).map((item) => item?.text)];
  return parts.filter((part) => typeof part === 'string').join('\n');
}

/**
 * Where an object is, for putting matches in reading order.
 *
 * A connector has no box, so it is placed where it is *drawn*: halfway between
 * the middles of the two objects it joins. That is not exactly where its label
 * sits — the line is cut at both borders — and it does not need to be, since
 * this decides an order rather than a position.
 */
function anchorOf(obj, byId) {
  if (isPlaced(obj)) return { x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 };

  const from = byId.get(obj.from);
  const to = byId.get(obj.to);
  if (!from || !to) return null;

  return {
    x: (from.x + from.w / 2 + to.x + to.w / 2) / 2,
    y: (from.y + from.h / 2 + to.y + to.h / 2) / 2,
  };
}

/**
 * The matches, in the order a person would read them: sheet by sheet in tab
 * order, and within a sheet down the page and then across.
 *
 * Reading order rather than the z-order the document keeps, because stepping
 * through matches is a walk over a *picture* — "the next one" means the next
 * one down the page, and which card happens to be on top of which says nothing
 * anybody can see.
 *
 * An empty or blank query matches nothing, rather than everything. Every
 * object at once is not an answer to "where is it", and a find bar that
 * selects the whole board the moment it opens is one nobody will open twice.
 */
export function search(sheets, query) {
  const wanted = String(query ?? '').trim().toLowerCase();
  if (!wanted) return [];

  const found = [];

  for (const sheet of sheets ?? []) {
    const objects = sheet?.objects ?? [];
    const byId = new Map(objects.filter(isPlaced).map((obj) => [obj.id, obj]));

    const hits = objects
      .filter((obj) => textOf(obj).toLowerCase().includes(wanted))
      .map((obj) => ({ sheetId: sheet.id, sheetName: sheet.name, id: obj.id, at: anchorOf(obj, byId) }))
      // An object with nowhere to be — a connector whose ends are not both here
      // — cannot be shown, and a match nobody can be taken to is not one.
      .filter((hit) => hit.at)
      .sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);

    found.push(...hits);
  }

  return found;
}

/**
 * The next match after `index`, wrapping — or the previous one going back.
 *
 * `index` is where the person *is*, and −1 means nowhere yet: a query has been
 * typed and nothing has been stepped to. Forwards from nowhere is the first
 * match rather than the second, which is what pressing Enter once has to mean;
 * backwards from nowhere is the last, which is what it has to mean when the
 * thing being looked for was written at the bottom of the board.
 *
 * Wrapping rather than stopping at the end, because the count is on screen: a
 * person pressing Enter for the fourth time out of three knows what happened,
 * and a button that stops working at the end is a button they have to think
 * about.
 */
export function step(index, count, by = 1) {
  if (!count) return -1;
  if (index < 0) return by > 0 ? 0 : count - 1;
  return (index + by + count) % count;
}
