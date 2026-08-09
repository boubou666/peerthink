// Find on the board: opening it, what it turns up, and being taken there.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('find', () => {
  let page;

  before(async () => { page = await openApp(); });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  beforeEach(async () => {
    await page.eval('localStorage.clear()');
    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
    /**
     * The whole board, not only the sheet on screen. `store.load` empties the
     * canvas in front of you and leaves the other sheets holding whatever the
     * last test put on them — and a board flushed on the way out of that test
     * is restored into this one, since the flush happens after the clear
     * above. A search that reads every sheet notices immediately.
     */
    await page.eval('app.sheets.load({})');
    await page.eval('app.viewport.scale = 1; app.viewport.moveTo(0, 0)');
  });

  const BAR = '[data-find-bar]';
  const FIELD = '[data-find-field]';
  const COUNT = '[data-find-count]';

  /** ⌘F, which is `ctrl` in this browser's terms — CDP modifier 2. */
  const openFind = async () => {
    await page.key('f', { code: 'KeyF', vk: 70, modifiers: 2 });
    await page.waitFor(`document.querySelector('${FIELD}') !== null`, { label: 'the find bar' });
  };

  const type = (text) => page.eval(`(() => {
    const el = document.querySelector('${FIELD}');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  const count = () => page.eval(`document.querySelector('${COUNT}')?.textContent ?? null`);
  const rings = () => page.eval(`document.querySelectorAll('.obj.found').length`);

  const cards = (...texts) => page.eval(`(() => {
    const made = ${JSON.stringify(texts)}.map((text, i) => app.board.add('card', {
      x: 0, y: i * 300, w: 200, h: 120, text,
    }));
    app.selection.clear();
    return made.map((obj) => obj.id);
  })()`);

  /** Where the camera is looking, in world coordinates. */
  const looking = () => page.eval(`(() => {
    const stage = document.getElementById('stage');
    const view = app.viewport.visibleRect(stage.clientWidth, stage.clientHeight);
    return { cx: view.x + view.w / 2, cy: view.y + view.h / 2, scale: app.viewport.scale };
  })()`);

  test('opens on ⌘F, with the caret in it, and closes on Escape', async () => {
    await openFind();
    assert.equal(await page.eval(`document.activeElement?.dataset.findField !== undefined`), true);

    await page.key('Escape', { code: 'Escape', vk: 27 });
    await page.waitFor(`document.querySelector('${BAR}') === null`, { label: 'the bar to close' });
  });

  /**
   * The browser's own find would be looking at a document most of the board has
   * been culled out of — so this one is heard first, even while a card is being
   * typed into.
   */
  test('and opens even while a card is being edited', async () => {
    const [id] = await cards('something');
    await page.eval(`document.querySelector('[data-id="${id}"] [contenteditable]').focus()`);

    await openFind();
    assert.equal(await page.eval(`document.activeElement?.dataset.findField !== undefined`), true);
  });

  test('says how many there are, and rings them on the board', async () => {
    await cards('the roadmap', 'roadmap review', 'something else');
    await openFind();
    await type('roadmap');

    await page.waitFor(`document.querySelector('${COUNT}').textContent.includes('2 found')`, {
      label: 'the count',
      context: `document.querySelector('${COUNT}')?.textContent`,
    });
    assert.equal(await rings(), 2, 'and the two that hold the word are marked');
  });

  test('nothing found says so, rather than going quiet', async () => {
    await cards('the roadmap');
    await openFind();
    await type('nowhere');

    await page.waitFor(`document.querySelector('${COUNT}').textContent === 'Nothing'`, {
      label: 'the count to say so',
      context: `document.querySelector('${COUNT}')?.textContent`,
    });
    assert.equal(await rings(), 0);
  });

  test('Enter takes you to a match, selects it, and leaves the zoom alone', async () => {
    const ids = await cards('the roadmap', 'roadmap review');
    await page.eval('app.viewport.scale = 0.5; app.viewport.moveTo(-2000, -2000)');

    await openFind();
    await type('roadmap');
    await page.waitFor(`document.querySelector('${COUNT}').textContent.includes('2 found')`, { label: 'the count' });

    await page.key('Enter', { code: 'Enter', vk: 13 });
    await page.waitFor(`document.querySelector('${COUNT}').textContent.includes('1 of 2')`, {
      label: 'the count to say which one',
      context: `document.querySelector('${COUNT}')?.textContent`,
    });

    assert.deepEqual(await page.eval('app.selection.list()'), [ids[0]]);
    const now = await looking();
    assert.ok(Math.abs(now.cx - 100) < 2 && Math.abs(now.cy - 60) < 2, `centred on it: ${JSON.stringify(now)}`);
    assert.equal(now.scale, 0.5, 'how far in somebody is looking is theirs');
  });

  test('and stepping past the last one comes back to the first', async () => {
    const ids = await cards('roadmap one', 'roadmap two');
    await openFind();
    await type('roadmap');
    await page.waitFor(`document.querySelector('${COUNT}').textContent.includes('2 found')`, { label: 'the count' });

    await page.eval(`document.querySelector('[data-action="find-next"]').click()`);
    await page.eval(`document.querySelector('[data-action="find-next"]').click()`);
    assert.deepEqual(await page.eval('app.selection.list()'), [ids[1]], 'the second');

    await page.eval(`document.querySelector('[data-action="find-next"]').click()`);
    assert.deepEqual(await page.eval('app.selection.list()'), [ids[0]], 'and round to the first');

    await page.eval(`document.querySelector('[data-action="find-previous"]').click()`);
    assert.deepEqual(await page.eval('app.selection.list()'), [ids[1]], 'backwards wraps too');
  });

  /**
   * The whole reason this searches the board rather than the sheet on screen:
   * a match on another canvas is one nobody would otherwise learn about.
   */
  test('a match on another sheet is counted, and switches to it', async () => {
    await cards('roadmap here');
    const other = await page.eval(`(() => {
      const id = app.commands.addSheet({ name: 'Later' });
      app.board.add('card', { x: 0, y: 0, w: 200, h: 120, text: 'roadmap there' });
      app.commands.selectSheet(app.sheets.list()[0].id);
      app.selection.clear();
      return id;
    })()`);

    await openFind();
    await type('roadmap');
    await page.waitFor(`document.querySelector('${COUNT}').textContent.includes('1 on other sheets')`, {
      label: 'the count to mention the other sheet',
      context: `document.querySelector('${COUNT}')?.textContent`,
    });
    assert.equal(await rings(), 1, 'only the one on this sheet is ringed');

    await page.eval(`document.querySelector('[data-action="find-next"]').click()`);
    await page.eval(`document.querySelector('[data-action="find-next"]').click()`);

    assert.equal(await page.eval('app.sheets.activeId'), other, 'the sheet it is on is the one showing');
    assert.equal(await page.eval(`app.store.get(app.selection.list()[0]).text`), 'roadmap there');
  });

  test('the list follows the board while the bar is open', async () => {
    await cards('the roadmap');
    await openFind();
    await type('roadmap');
    await page.waitFor(`document.querySelector('${COUNT}').textContent.includes('1 found')`, { label: 'one match' });

    await page.eval(`app.board.add('card', { x: 0, y: 600, w: 200, h: 120, text: 'roadmap again' })`);
    await page.waitFor(`document.querySelector('${COUNT}').textContent.includes('2 found')`, {
      label: 'the new card to be counted',
      context: `document.querySelector('${COUNT}')?.textContent`,
    });
  });

  test('closing it takes the rings off the board', async () => {
    await cards('the roadmap');
    await openFind();
    await type('roadmap');
    await page.waitFor(`document.querySelectorAll('.obj.found').length === 1`, { label: 'the ring' });

    await page.eval(`document.querySelector('[data-action="find-close"]').click()`);
    await page.waitFor(`document.querySelector('${BAR}') === null`, { label: 'the bar to close' });
    assert.equal(await rings(), 0);
    assert.deepEqual(await page.eval('app.found.list()'), []);
  });

  test('an arrow is found by what is written on it', async () => {
    const ids = await cards('one', 'two');
    const arrow = await page.eval(`(() => {
      const made = app.board.connect('${ids[0]}', '${ids[1]}');
      app.store.apply([{ t: 'set', id: made.id, patch: { text: 'blocks' } }]);
      app.selection.clear();
      return made.id;
    })()`);

    await openFind();
    await type('blocks');
    await page.waitFor(`document.querySelector('${COUNT}').textContent.includes('1 found')`, {
      label: 'the arrow to be counted',
      context: `document.querySelector('${COUNT}')?.textContent`,
    });
    assert.equal(await page.eval(`document.querySelectorAll('.connector-label.found').length`), 1);

    await page.key('Enter', { code: 'Enter', vk: 13 });
    assert.deepEqual(await page.eval('app.selection.list()'), [arrow]);
  });
});
