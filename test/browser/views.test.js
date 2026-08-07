import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('views', () => {
  let page;

  before(async () => {
    page = await openApp();
    await page.eval('localStorage.clear()');
    await page.goto();
  });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  const add = (type, props = {}) => page.eval(`app.board.add(${JSON.stringify(type)}, ${JSON.stringify(props)}).id`);
  const html = (id, sel) => page.eval(`document.querySelector('[data-id="${id}"] ${sel}')?.textContent ?? null`);

  describe('card', () => {
    const styleOf = (id) => page.eval(`(() => {
      const el = document.querySelector('[data-id="${id}"]');
      return { ...el.dataset };
    })()`);

    test('renders its text and its style', async () => {
      const id = await add('card', {
        x: 0, y: 0, text: 'hello', fill: 'blue', ink: 'red', font: 'mono', size: 'xl', align: 'center',
      });
      assert.equal(await html(id, '[data-field="text"]'), 'hello');

      const style = await styleOf(id);
      assert.equal(style.fill, 'blue');
      assert.equal(style.ink, 'red');
      assert.equal(style.font, 'mono');
      assert.equal(style.size, 'xl');
      assert.equal(style.align, 'center');
    });

    test('falls back to the defaults when nothing is set', async () => {
      const id = await add('card', { x: 0, y: 0 });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{color: undefined, fill: undefined}}], false)`);

      const style = await styleOf(id);
      assert.equal(style.fill, 'yellow');
      assert.equal(style.ink, 'ink');
      assert.equal(style.font, 'sans');
      assert.equal(style.size, 'md');
      assert.equal(style.align, 'left');
    });

    /** Boards written before the field was renamed are still out there. */
    test('a card that only has the old `color` still gets its colour', async () => {
      const id = await add('card', { x: 0, y: 0 });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{fill: undefined, color: 'pink'}}], false)`);

      assert.equal((await styleOf(id)).fill, 'pink');
      const painted = await page.eval(
        `getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor`,
      );
      assert.equal(painted, 'rgb(255, 196, 214)', 'the old attribute selector no longer paints');
    });

    test('a colour the card carries itself is painted, without an attribute for it', async () => {
      const id = await add('card', { x: 0, y: 0, text: 'custom', fill: '#123456', ink: '#abcdef' });

      const style = await styleOf(id);
      assert.equal(style.fill, 'custom', 'a value nobody knew in advance became an attribute');
      assert.equal(style.ink, 'custom');

      const painted = await page.eval(`(() => {
        const el = document.querySelector('[data-id="${id}"]');
        return { bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el.querySelector('.card-text')).color };
      })()`);
      assert.equal(painted.bg, 'rgb(18, 52, 86)');
      assert.equal(painted.ink, 'rgb(171, 205, 239)');
    });

    test('going back to a named colour clears the custom one', async () => {
      const id = await add('card', { x: 0, y: 0, fill: '#123456' });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{fill: 'pink'}}], false)`);

      assert.equal((await styleOf(id)).fill, 'pink');
      assert.equal(
        await page.eval(`getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor`),
        'rgb(255, 196, 214)',
        'the inline custom property outlived the custom colour',
      );
    });

    test('a transparent card paints nothing, and still shows its text', async () => {
      const id = await add('card', { x: 0, y: 0, text: 'floating', fill: 'none' });

      const painted = await page.eval(
        `getComputedStyle(document.querySelector('[data-id="${id}"]')).backgroundColor`,
      );
      assert.equal(painted, 'rgba(0, 0, 0, 0)');
      assert.equal(await html(id, '[data-field="text"]'), 'floating');
    });

    test('a store change repaints the text', async () => {
      const id = await add('card', { x: 0, y: 0, text: 'before' });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{text:'after'}}], false)`);
      assert.equal(await html(id, '[data-field="text"]'), 'after');
    });

    test('an update never clobbers the field the user is typing in', async () => {
      const id = await add('card', { x: 0, y: 0, text: 'typing' });
      const kept = await page.eval(`(() => {
        const field = document.querySelector('[data-id="${id}"] [data-field="text"]');
        field.focus();
        app.store.apply([{ t: 'set', id: "${id}", patch: { text: 'from elsewhere' } }], false);
        const shown = field.innerText;
        field.blur();
        return shown;
      })()`);
      assert.equal(kept, 'typing');
    });
  });

  describe('envelope', () => {
    test('renders its title', async () => {
      const id = await add('envelope', { x: 0, y: 0, title: 'Ideas' });
      assert.equal(await html(id, '[data-field="title"]'), 'Ideas');
    });
  });

  describe('list', () => {
    test('renders one row per item with its done state', async () => {
      const id = await add('list', { x: 0, y: 0, title: 'Todo' });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{items:[
        {id:'i1', text:'one', done:false},
        {id:'i2', text:'two', done:true}
      ]}}], false)`);

      assert.equal(await page.eval(`document.querySelectorAll('[data-id="${id}"] .list-item').length`), 2);
      assert.equal(await html(id, '[data-item-id="i2"] [data-field="item"]'), 'two');
      assert.equal(await page.eval(`document.querySelector('[data-id="${id}"] [data-item-id="i2"]').classList.contains('done')`), true);
      assert.equal(await page.eval(`document.querySelector('[data-id="${id}"] [data-item-id="i1"]').classList.contains('done')`), false);
    });

    test('editing an item in place reuses the row rather than rebuilding', async () => {
      const id = await add('list', { x: 0, y: 0 });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{items:[{id:'k1', text:'a', done:false}]}}], false)`);
      const same = await page.eval(`(() => {
        const before = document.querySelector('[data-id="${id}"] [data-item-id="k1"]');
        app.store.apply([{ t:'set', id:"${id}", patch:{ items:[{id:'k1', text:'b', done:true}] } }], false);
        return document.querySelector('[data-id="${id}"] [data-item-id="k1"]') === before;
      })()`);
      assert.ok(same, 'the row element should survive a text change');
      assert.equal(await html(id, '[data-item-id="k1"] [data-field="item"]'), 'b');
    });

    test('changing the set of items rebuilds the rows', async () => {
      const id = await add('list', { x: 0, y: 0 });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{items:[{id:'m1', text:'a'}]}}], false)`);
      const rebuilt = await page.eval(`(() => {
        const before = document.querySelector('[data-id="${id}"] [data-item-id="m1"]');
        app.store.apply([{ t:'set', id:"${id}", patch:{ items:[{id:'m1', text:'a'}, {id:'m2', text:'b'}] } }], false);
        return document.querySelector('[data-id="${id}"] [data-item-id="m1"]') !== before;
      })()`);
      assert.ok(rebuilt);
      assert.equal(await page.eval(`document.querySelectorAll('[data-id="${id}"] .list-item').length`), 2);
    });

    test('a missing row is skipped instead of throwing', async () => {
      const id = await add('list', { x: 0, y: 0 });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{items:[{id:'g1', text:'a'},{id:'g2', text:'b'}]}}], false)`);
      const ok = await page.eval(`(() => {
        document.querySelector('[data-id="${id}"] [data-item-id="g1"]').remove();
        app.store.apply([{ t:'set', id:"${id}", patch:{ items:[{id:'g1', text:'a2'},{id:'g2', text:'b2'}] } }], false);
        return document.querySelector('[data-id="${id}"] [data-item-id="g2"] [data-field="item"]').innerText;
      })()`);
      assert.equal(ok, 'b2');
    });

    test('items with no text render empty', async () => {
      const id = await add('list', { x: 0, y: 0 });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{items:[{id:'e1'}]}}], false)`);
      assert.equal(await html(id, '[data-item-id="e1"] [data-field="item"]'), '');
    });
  });
});
