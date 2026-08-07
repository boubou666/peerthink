// Other people's pointers: what they are called, and who gets drawn at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createCursors } from '../../src/platform/cursors.js';

/** Just enough DOM to append cursors to and read their names back from. */
const fakeDom = () => {
  const make = () => {
    const node = {
      children: [],
      className: '',
      textContent: '',
      dataset: {},
      style: { setProperty() {}, transform: '' },
      append(...kids) { node.children.push(...kids); },
      appendChild(kid) { node.children.push(kid); return kid; },
      remove() { node.removed = true; },
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    return node;
  };

  const overlay = make();
  const stage = make();
  return { document: { createElement: make }, overlay, stage };
};

/** The name drawn above each cursor, by the id it belongs to. */
const drawnNames = (overlay) =>
  Object.fromEntries(
    overlay.children.map((el) => [el.dataset.cursor, el.children.find((c) => c.className === 'cursor-name')?.textContent]),
  );

const build = () => {
  const dom = fakeDom();
  const cursors = createCursors({
    document: dom.document,
    elements: { stage: dom.stage, overlay: dom.overlay },
    viewport: { toScreen: (x, y) => ({ x, y }), toWorld: (x, y) => ({ x, y }), on: () => () => {} },
    sync: { moveCursor() {} },
    // Frame coalescing is not what these are about, so it runs straight away.
    scheduler: { onFrame: (fn) => fn },
  });
  return { cursors, overlay: dom.overlay };
};

describe('cursors', () => {
  describe('what a pointer is called', () => {
    /**
     * The bug this is here for: a signed-out person is labelled `Guest` by
     * shell/sync.js, and the fallback for "presence never mentioned this id"
     * used to be the same word. A phantom cursor on a board with nobody else
     * on it was therefore indistinguishable, on screen, from a real guest.
     */
    test('an id presence never mentioned is not called Guest', () => {
      const { cursors, overlay } = build();

      cursors.setMembers([]);
      cursors.receive({ id: 'stranger', x: 10, y: 20 });

      const names = drawnNames(overlay);
      assert.equal(names.stranger, 'Someone');
      assert.notEqual(names.stranger, 'Guest', 'a nameless pointer still reads as an anonymous person');
    });

    test('someone actually signed out is still called Guest', () => {
      // The label comes from presence, where an anonymous member carries the
      // literal string — so the ordinary case must keep the ordinary word.
      const { cursors, overlay } = build();

      cursors.setMembers([{ id: 'anon', label: 'Guest' }]);
      cursors.receive({ id: 'anon', x: 1, y: 2 });

      assert.equal(drawnNames(overlay).anon, 'Guest');
    });

    test('a named member is called what presence says', () => {
      const { cursors, overlay } = build();

      cursors.setMembers([{ id: 'her', label: 'thomas@example.com' }]);
      cursors.receive({ id: 'her', x: 3, y: 4 });

      assert.equal(drawnNames(overlay).her, 'thomas@example.com');
    });
  });
});
