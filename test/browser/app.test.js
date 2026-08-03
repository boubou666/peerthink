import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

/**
 * Exercises the composition root itself: an app assembled from injected parts,
 * standing beside the page's own instance without either noticing.
 */
describe('createApp', () => {
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

  /**
   * Build a second app in its own offscreen DOM.
   * `body` is evaluated with `second`, `host` and `app` in scope.
   */
  const withSecondApp = (options, body) => page.eval(`(async () => {
    const { createApp } = await import('/js/app.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute; left:-9999px; top:0; width:800px; height:600px;';
    host.innerHTML = [
      '<div id="s-stage" style="position:relative;width:800px;height:600px"><div id="s-bg"></div>',
      '<div id="s-layer"></div><div id="s-overlay"></div></div>',
      '<div id="s-toolbar"><button data-add="card"></button></div><span id="s-zoom"></span>',
    ].join('');
    document.body.appendChild(host);

    const elements = {
      stage: host.querySelector('#s-stage'),
      bg: host.querySelector('#s-bg'),
      layer: host.querySelector('#s-layer'),
      overlay: host.querySelector('#s-overlay'),
      toolbar: host.querySelector('#s-toolbar'),
      zoomLabel: host.querySelector('#s-zoom'),
    };

    const second = createApp({ document, window, elements, ${options} });
    try {
      return await (${body})({ second, host, elements });
    } finally {
      second.destroy();
      host.remove();
    }
  })()`);

  test('two instances share a page without sharing any state', async () => {
    const result = await withSecondApp('storage: null', `({ second, host }) => {
      const before = app.store.order.length;
      second.board.add('card', { x: 0, y: 0, text: 'only in the second app' });
      return {
        firstUnchanged: app.store.order.length === before,
        secondGrew: second.store.order.length === before + 1,
        rendersInItsOwnLayer: host.querySelectorAll('.obj').length === second.store.order.length,
        firstLayerUntouched: document.getElementById('layer').querySelectorAll('.obj').length === before,
      };
    }`);

    assert.deepEqual(result, {
      firstUnchanged: true,
      secondGrew: true,
      rendersInItsOwnLayer: true,
      firstLayerUntouched: true,
    });
  });

  test('with no storage it seeds, and saves nowhere', async () => {
    const result = await withSecondApp('storage: null', `({ second }) => ({
      seeded: second.store.order.length,
      restored: second.restoredFromStorage,
      saved: second.repository.save('default', { v: 1, order: [], objects: [] }),
      listed: second.repository.list(),
    })`);

    assert.equal(result.seeded, 7);
    assert.equal(result.restored, false);
    assert.equal(result.saved, false, 'the null repository accepts and discards');
    assert.deepEqual(result.listed, [], 'and lists no boards');
  });

  test('an injected repository is loaded from instead of the seed', async () => {
    const board = { v: 1, order: ['x1'], objects: [{ id: 'x1', type: 'card', x: 0, y: 0, w: 100, h: 100, text: 'injected' }] };
    const record = { v: 1, id: 'remote', title: 'From a server', updatedAt: 7, board };
    const result = await withSecondApp(
      `boardId: 'remote', repository: {
        load: (id) => (id === 'remote' ? ${JSON.stringify(record)} : null),
        save: () => true,
        migrateLegacy: () => false,
      }`,
      `({ second }) => ({
        count: second.store.order.length,
        text: second.store.get('x1').text,
        title: second.title,
        restored: second.restoredFromStorage,
      })`,
    );

    assert.deepEqual(result, { count: 1, text: 'injected', title: 'From a server', restored: true });
  });

  test('an unknown board id seeds rather than showing an empty canvas', async () => {
    const result = await withSecondApp(
      `boardId: 'missing', repository: { load: () => null, save: () => true, migrateLegacy: () => false }`,
      `({ second }) => ({ count: second.store.order.length, restored: second.restoredFromStorage, title: second.title })`,
    );

    assert.deepEqual(result, { count: 7, restored: false, title: null });
  });

  test('a board id keeps two boards in the same storage apart', async () => {
    const result = await withSecondApp(
      `storage: window.localStorage, boardId: 'second-board', autosaveDelay: 1`,
      `async ({ second }) => {
        second.board.add('card', { x: 0, y: 0, text: 'scoped' });
        second.autosave.flush();
        return {
          boardId: second.boardId,
          written: JSON.parse(localStorage.getItem('peerthink:board:second-board')).board.objects.some(o => o.text === 'scoped'),
          leaked: (localStorage.getItem('peerthink:board:default') ?? '').includes('scoped'),
          listed: second.repository.list().map(b => b.id).includes('second-board'),
        };
      }`,
    );

    assert.equal(result.boardId, 'second-board');
    assert.equal(result.written, true);
    assert.equal(result.leaked, false, "the page's own board is untouched");
    assert.equal(result.listed, true, 'and it shows up in the board list');
    await page.eval(`localStorage.removeItem('peerthink:board:second-board')`);
  });

  test('a namespace isolates a whole workspace', async () => {
    const result = await withSecondApp(
      `storage: window.localStorage, namespace: 'scratch', autosaveDelay: 1`,
      `async ({ second }) => {
        second.board.add('card', { x: 0, y: 0, text: 'elsewhere' });
        second.autosave.flush();
        return {
          written: localStorage.getItem('scratch:board:default') !== null,
          leaked: (localStorage.getItem('peerthink:board:default') ?? '').includes('elsewhere'),
        };
      }`,
    );

    assert.equal(result.written, true);
    assert.equal(result.leaked, false);
    await page.eval(`localStorage.removeItem('scratch:board:default')`);
  });

  test('an injected seed replaces the starter board', async () => {
    const count = await withSecondApp(
      `storage: null, seed: (board) => board.add('list', { x: 0, y: 0 })`,
      `({ second }) => second.store.all().map(o => o.type)`,
    );
    assert.deepEqual(count, ['list']);
  });

  test('destroy detaches the DOM and stops listening', async () => {
    const result = await page.eval(`(async () => {
      const { createApp } = await import('/js/app.js');
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute; left:-9999px; top:0; width:800px; height:600px;';
      host.innerHTML = [
        '<div id="d-stage" style="position:relative;width:800px;height:600px"><div id="d-bg"></div>',
        '<div id="d-layer"></div><div id="d-overlay"></div></div>',
        '<div id="d-toolbar"><button data-add="card"></button></div><span id="d-zoom"></span>',
      ].join('');
      document.body.appendChild(host);

      const elements = {
        stage: host.querySelector('#d-stage'),
        bg: host.querySelector('#d-bg'),
        layer: host.querySelector('#d-layer'),
        overlay: host.querySelector('#d-overlay'),
        toolbar: host.querySelector('#d-toolbar'),
        zoomLabel: host.querySelector('#d-zoom'),
      };

      const second = createApp({ document, window, elements, storage: null });
      const rendered = elements.layer.querySelectorAll('.obj').length;
      const zoomBefore = elements.zoomLabel.textContent;

      second.destroy();
      const afterDestroy = elements.layer.querySelectorAll('.obj').length;

      // the torn-down app must not react to anything any more
      second.store.apply([{ t: 'add', obj: second.board.make('card', { x: 0, y: 0 }) }]);
      second.viewport.setScaleAt(0, 0, 3);
      elements.toolbar.querySelector('button').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '!', code: 'Digit1', shiftKey: true }));

      const result = {
        rendered,
        afterDestroy,
        stillDetached: elements.layer.querySelectorAll('.obj').length,
        zoomFrozen: elements.zoomLabel.textContent === zoomBefore,
        objectsAfterToolbarClick: second.store.order.length,
      };
      host.remove();
      return result;
    })()`);

    assert.equal(result.rendered, 7, 'the seeded board rendered into the injected layer');
    assert.equal(result.afterDestroy, 0, 'destroy removes its elements');
    assert.equal(result.stillDetached, 0, 'and stops following the store');
    assert.equal(result.zoomFrozen, true, 'and stops following the camera');
    assert.equal(result.objectsAfterToolbarClick, 8, 'the toolbar button no longer creates anything');
  });
});
