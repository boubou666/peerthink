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
   * `body` is evaluated with `second`, `host`, `hydrated` and `app` in scope.
   *
   * `hydrate: false` hands the body the in-flight promise instead of waiting
   * on it, which is the only way to observe the app between construction and
   * the board arriving.
   */
  const withSecondApp = (options, body, { hydrate = true } = {}) => page.eval(`(async () => {
    const { createApp } = await import('/src/app.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute; left:-9999px; top:0; width:800px; height:600px;';
    host.innerHTML = [
      '<div id="s-stage" style="position:relative;width:800px;height:600px"><div id="s-bg"></div>',
      '<div id="s-layer"></div><div id="s-overlay"></div></div>',
    ].join('');
    document.body.appendChild(host);

    const elements = {
      stage: host.querySelector('#s-stage'),
      bg: host.querySelector('#s-bg'),
      layer: host.querySelector('#s-layer'),
      overlay: host.querySelector('#s-overlay'),
    };

    const second = createApp({ document, window, elements, ${options} });
    try {
      const hydrated = second.hydrate();
      ${hydrate ? 'await hydrated;' : ''}
      return await (${body})({ second, host, elements, hydrated });
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
    const result = await withSecondApp('storage: null', `async ({ second }) => ({
      seeded: second.store.order.length,
      restored: second.restoredFromStorage,
      saved: await second.repository.save('default', { v: 1, order: [], objects: [] }),
      listed: (await second.repository.list()).boards,
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
        load: async (id) => (id === 'remote' ? ${JSON.stringify(record)} : null),
        save: async () => true,
        migrateLegacy: async () => false,
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
      `boardId: 'missing', repository: { load: async () => null, save: async () => true, migrateLegacy: async () => false }`,
      `({ second }) => ({ count: second.store.order.length, restored: second.restoredFromStorage, title: second.title })`,
    );

    assert.deepEqual(result, { count: 7, restored: false, title: null });
  });

  /**
   * A repository is contracted to answer rather than throw, and both of the
   * ones in this app do. The contract is documented, not enforced, and the
   * failure it papers over is the worst one available: a canvas that takes
   * edits all afternoon and has nowhere to put them, behind a bar that looks
   * exactly like a working board.
   */
  test('a board that could not be loaded stops claiming to be saved', async () => {
    const result = await withSecondApp(
      `boardId: 'remote', repository: {
        load: async () => { throw new Error('offline'); },
        save: async () => true,
        migrateLegacy: async () => false,
      }`,
      `async ({ second, hydrated }) => {
        const rejected = await hydrated.then(() => false, () => true);
        second.board.add('card', { x: 0, y: 0, text: 'typed into a board that saves nowhere' });
        return {
          rejected,
          status: second.saveStatus.get(),
          autosave: Boolean(second.autosave),
          stillUsable: second.store.order.length,
        };
      }`,
      { hydrate: false },
    );

    assert.deepEqual(result, {
      rejected: true,
      status: 'unloaded',
      autosave: false,
      stillUsable: 1,
    }, 'the canvas is kept — it is the only copy of the work — and says it is not being stored');
  });

  const SLOW_REPOSITORY = `repository: {
    load: () => new Promise((done) => setTimeout(() => done(null), 40)),
    save: async () => true,
    migrateLegacy: async () => false,
  }`;

  test('the canvas is mounted and usable before the board arrives', async () => {
    const result = await withSecondApp(
      SLOW_REPOSITORY,
      `async ({ second, elements, hydrated }) => {
        const duringLoad = {
          objects: second.store.order.length,
          title: second.title,
          restored: second.restoredFromStorage,
          autosave: second.autosave,
          // the imperative layers are wired, so a gesture lands right now
          drawnBeforeLoad: elements.layer.querySelectorAll('.obj').length,
        };
        second.board.add('card', { x: 0, y: 0, text: 'typed while loading' });
        duringLoad.acceptsEdits = second.store.order.length === 1;

        await hydrated;
        return { duringLoad, afterLoad: second.store.order.length };
      }`,
      { hydrate: false },
    );

    assert.deepEqual(result.duringLoad, {
      objects: 0,
      title: null,
      restored: false,
      autosave: null,
      drawnBeforeLoad: 0,
      acceptsEdits: true,
    }, 'built and interactive, just empty');

    // the seed runs on an empty board; the card added mid-load is not lost to it
    assert.equal(result.afterLoad, 8, 'the seed landed alongside the mid-load edit');
  });

  /**
   * The canvas is interactive from the first frame, which is the whole reason
   * loading is a separate step — so what someone does in that window has to
   * survive the snapshot arriving on top of it. Against Web Storage the window
   * was a microtask and this was invisible; against a network it is a round
   * trip, and it is exactly when an impatient person starts a card.
   */
  test('an edit made while the board is still loading survives the load', async () => {
    const result = await page.eval(`(async () => {
      const { createApp } = await import('/src/app.js');
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute; left:-9999px; top:0; width:800px; height:600px;';
      host.innerHTML = [
        '<div id="e-stage" style="position:relative;width:800px;height:600px"><div id="e-bg"></div>',
        '<div id="e-layer"></div><div id="e-overlay"></div></div>',
      ].join('');
      document.body.appendChild(host);

      const elements = {
        stage: host.querySelector('#e-stage'),
        bg: host.querySelector('#e-bg'),
        layer: host.querySelector('#e-layer'),
        overlay: host.querySelector('#e-overlay'),
      };

      const stored = { v: 1, order: ['saved'], objects: [
        { id: 'saved', type: 'card', x: 0, y: 0, w: 200, h: 120, text: 'from the server' },
      ] };

      const app = createApp({
        document, window, elements, boardId: 'slow', autosaveDelay: 1,
        repository: {
          load: () => new Promise((done) => setTimeout(() => done({ board: stored }), 40)),
          save: async () => true,
          migrateLegacy: async () => false,
        },
      });

      const hydrated = app.hydrate();
      app.board.add('card', { x: 300, y: 40, text: 'typed while loading' });
      await hydrated;

      const result = {
        texts: app.store.toJSON().objects.map((o) => o.text).sort(),
        rendered: elements.layer.querySelectorAll('.obj').length,
        // the load is not a step the user should be able to undo past
        canUndo: app.store.canUndo,
      };
      app.destroy();
      host.remove();
      return result;
    })()`);

    assert.deepEqual(result, {
      texts: ['from the server', 'typed while loading'],
      rendered: 2,
      canUndo: false,
    });
  });

  test('destroying mid-load abandons the board instead of resurrecting the app', async () => {
    const result = await page.eval(`(async () => {
      const { createApp } = await import('/src/app.js');
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute; left:-9999px; top:0; width:800px; height:600px;';
      host.innerHTML = [
        '<div id="c-stage" style="position:relative;width:800px;height:600px"><div id="c-bg"></div>',
        '<div id="c-layer"></div><div id="c-overlay"></div></div>',
      ].join('');
      document.body.appendChild(host);

      const elements = {
        stage: host.querySelector('#c-stage'),
        bg: host.querySelector('#c-bg'),
        layer: host.querySelector('#c-layer'),
        overlay: host.querySelector('#c-overlay'),
      };

      const writes = [];
      const second = createApp({
        document, window, elements, boardId: 'slow', autosaveDelay: 1,
        repository: {
          load: () => new Promise((done) => setTimeout(() => done(null), 40)),
          save: async (id) => { writes.push(id); return true; },
          migrateLegacy: async () => false,
        },
      });

      const hydrated = second.hydrate();
      second.destroy();          // React unmounting the route mid-load
      await hydrated;
      await new Promise((done) => setTimeout(done, 30));

      const result = {
        objects: second.store.order.length,
        rendered: elements.layer.querySelectorAll('.obj').length,
        autosave: second.autosave,
        writes: writes.length,
      };
      host.remove();
      return result;
    })()`);

    assert.deepEqual(result, { objects: 0, rendered: 0, autosave: null, writes: 0 },
      'no seed, no render, and nothing left autosaving a board nobody is looking at');
  });

  test('a board id keeps two boards in the same storage apart', async () => {
    const result = await withSecondApp(
      `storage: window.localStorage, boardId: 'second-board', autosaveDelay: 1`,
      `async ({ second }) => {
        second.board.add('card', { x: 0, y: 0, text: 'scoped' });
        await second.autosave.flush();
        return {
          boardId: second.boardId,
          written: JSON.parse(localStorage.getItem('peerthink:board:second-board')).board.objects.some(o => o.text === 'scoped'),
          leaked: (localStorage.getItem('peerthink:board:default') ?? '').includes('scoped'),
          listed: (await second.repository.list()).boards.map(b => b.id).includes('second-board'),
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
        await second.autosave.flush();
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
      const { createApp } = await import('/src/app.js');
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute; left:-9999px; top:0; width:800px; height:600px;';
      host.innerHTML = [
        '<div id="d-stage" style="position:relative;width:800px;height:600px"><div id="d-bg"></div>',
        '<div id="d-layer"></div><div id="d-overlay"></div></div>',
      ].join('');
      document.body.appendChild(host);

      const elements = {
        stage: host.querySelector('#d-stage'),
        bg: host.querySelector('#d-bg'),
        layer: host.querySelector('#d-layer'),
        overlay: host.querySelector('#d-overlay'),
      };

      const second = createApp({ document, window, elements, storage: null });
      await second.hydrate();
      const rendered = elements.layer.querySelectorAll('.obj').length;

      second.destroy();
      const afterDestroy = elements.layer.querySelectorAll('.obj').length;

      // the torn-down app must not react to anything any more
      second.store.apply([{ t: 'add', obj: second.board.make('card', { x: 0, y: 0 }) }]);
      second.viewport.setScaleAt(0, 0, 3);

      const result = {
        rendered,
        afterDestroy,
        stillDetached: elements.layer.querySelectorAll('.obj').length,
      };
      host.remove();
      return result;
    })()`);

    assert.equal(result.rendered, 7, 'the seeded board rendered into the injected layer');
    assert.equal(result.afterDestroy, 0, 'destroy removes its elements');
    assert.equal(result.stillDetached, 0, 'and stops following the store');
  });
});
