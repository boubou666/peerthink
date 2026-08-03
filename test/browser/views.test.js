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
    test('renders its text and colour', async () => {
      const id = await add('card', { x: 0, y: 0, text: 'hello', color: 'blue' });
      assert.equal(await html(id, '[data-field="text"]'), 'hello');
      assert.equal(await page.eval(`document.querySelector('[data-id="${id}"]').dataset.color`), 'blue');
    });

    test('falls back to yellow when no colour is set', async () => {
      const id = await add('card', { x: 0, y: 0 });
      await page.eval(`app.store.apply([{t:'set', id:"${id}", patch:{color: undefined}}], false)`);
      assert.equal(await page.eval(`document.querySelector('[data-id="${id}"]').dataset.color`), 'yellow');
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
