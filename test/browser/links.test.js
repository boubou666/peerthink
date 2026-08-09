// The link popover: a second of hovering, then what is at the other end.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { openApp } from '../helpers/browser.js';

describe('link popover', () => {
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
   * A links layer of our own, over the real app's DOM, with the clock and the
   * fetcher in this test's hands.
   *
   * The app's own is built with the fetcher the shell decided on — null, on a
   * dev server with no project — so it can only ever say a link cannot be
   * checked from here. That state is worth a test and gets one at the bottom;
   * everything else needs an answer to draw, and a stub is the only way to have
   * one without a stack and a network.
   */
  const build = ({ answer = null, fails = false, delay = 1000, hangs = false } = {}) => page.eval(`(async () => {
    const { createLinks } = await import('/src/platform/links.js');
    const { createManualScheduler } = await import('/src/core/scheduler.js');

    window.clock = createManualScheduler();
    window.asked = [];
    window.settle = null;

    const answer = ${JSON.stringify(answer)};
    window.links = createLinks({
      document,
      elements: { stage: document.getElementById('stage'), layer: document.getElementById('layer'), overlay: document.getElementById('overlay') },
      viewport: app.viewport,
      scheduler: window.clock,
      delay: ${delay},
      fetchPreview: (href) => {
        window.asked.push(href);
        if (${hangs}) return new Promise((resolve) => { window.settle = resolve; });
        if (${fails}) return Promise.reject(new Error('the function did not answer'));
        return Promise.resolve(answer);
      },
    });
  })()`);

  /** Put a card with a link on the board, and hand back where the link is. */
  const linkAt = async (text = 'see https://example.test/a now') => {
    const id = await page.eval(`app.board.add('card', ${JSON.stringify({ x: 120, y: 160, w: 320, h: 120, text })}).id`);
    await page.eval('document.activeElement?.blur?.()');
    const box = await page.eval(`(() => {
      const a = document.querySelector('[data-id="${id}"] a[data-link]');
      const r = a.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    return { id, box };
  };

  /**
   * Hover a link. Off it first, always: the pointer stays where the last test
   * left it, and moving to a position it already occupies dispatches nothing —
   * so a hover that looked like one would raise no `pointerover` and the timer
   * would never be armed.
   */
  const hover = async (box) => {
    await page.mouse('mouseMoved', 8, 8);
    await page.sleep(20);
    await page.mouse('mouseMoved', box.x, box.y);
    await page.sleep(40);
  };
  const waitOut = () => page.eval('window.clock.flushTimers()');

  const popover = () => page.eval(`(() => {
    const el = document.querySelector('[data-link-popover]');
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return {
      state: el.dataset.linkPopover,
      above: 'above' in el.dataset,
      title: el.querySelector('.link-popover-title')?.textContent ?? null,
      text: el.querySelector('.link-popover-text')?.textContent ?? null,
      host: el.querySelector('.link-popover-host')?.textContent ?? null,
      image: el.querySelector('.link-popover-image')?.getAttribute('src') ?? null,
      x: Math.round(box.left),
      y: Math.round(box.top),
      inOverlay: el.parentElement.id === 'overlay',
    };
  })()`);

  beforeEach(async () => {
    /**
     * The app's own links layer is stood down for this file.
     *
     * Two layers on one document both answer a hover, both draw a panel, and a
     * `[data-link-popover]` query then finds whichever is first — which is how
     * two of these tests first passed against the app's panel while the one they
     * were about never appeared. What the app wires is its own test, below.
     */
    /**
     * Nothing here wants a browser tab. One of these tests presses on a link to
     * check the panel goes away, and a press on a link opens it — which really
     * opened one in Chromium, took the focus with it, and left every input
     * dispatch after it crawling. Every test in this file was five seconds
     * slower for it.
     */
    await page.eval(`
      window.open = () => null;
      window.links?.destroy?.();
      app.links.destroy();
      app.store.load({ order: [], objects: [] });
      app.selection.clear();
      app.viewport.x = 0; app.viewport.y = 0; app.viewport.scale = 1; app.viewport.emit();
      document.activeElement?.blur?.();
    `);
    await page.sleep(40);
  });

  const READY = {
    ok: true,
    status: 200,
    title: 'Example Domain',
    description: 'This domain is for use in illustrative examples.',
    host: 'example.test',
    image: null,
  };

  describe('the hover', () => {
    test('nothing appears while the pointer is only passing over', async () => {
      await build({ answer: READY });
      const { box } = await linkAt();

      await hover(box);
      assert.equal(await popover(), null, 'the panel came up without the second being up');
      assert.deepEqual(await page.eval('window.asked'), [], 'and nothing was even asked');
    });

    test('a second later it is there, in the overlay', async () => {
      await build({ answer: READY });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'ready'`, {
        label: 'the preview to arrive',
      });

      const shown = await popover();
      assert.equal(shown.title, 'Example Domain');
      assert.equal(shown.text, 'This domain is for use in illustrative examples.');
      assert.equal(shown.host, 'example.test');
      assert.ok(shown.inOverlay, 'drawn somewhere other than the overlay');
      assert.deepEqual(await page.eval('window.asked'), ['https://example.test/a']);
    });

    test('leaving before the second is up asks nothing and shows nothing', async () => {
      await build({ answer: READY });
      const { box } = await linkAt();

      await hover(box);
      await page.mouse('mouseMoved', box.x, box.y + 300);
      await page.sleep(40);
      await waitOut();
      await page.sleep(60);

      assert.equal(await popover(), null);
      assert.deepEqual(await page.eval('window.asked'), []);
    });

    test('while the answer is in flight it says it is loading', async () => {
      await build({ hangs: true });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]') !== null`, { label: 'the panel' });

      const shown = await popover();
      assert.equal(shown.state, 'loading');
      assert.match(shown.title, /loading/i);
      assert.equal(shown.host, 'example.test', 'the host is known before the answer is');
    });

    /** An answer for a link nobody is looking at any more is not drawn. */
    test('an answer that arrives after the pointer left is dropped', async () => {
      await build({ hangs: true });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]') !== null`, { label: 'the panel' });

      await page.mouse('mouseMoved', box.x, box.y + 300);
      await page.sleep(40);
      await page.eval(`window.settle(${JSON.stringify(READY)})`);
      await page.sleep(80);

      assert.equal(await popover(), null);
    });

    test('a link hovered twice is only asked about once', async () => {
      await build({ answer: READY });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'ready'`, {
        label: 'the preview',
      });

      await page.mouse('mouseMoved', box.x, box.y + 300);
      await page.sleep(40);
      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'ready'`, {
        label: 'the preview again',
      });

      assert.deepEqual(await page.eval('window.asked'), ['https://example.test/a'], 'asked twice');
    });
  });

  describe('what it says', () => {
    test('a page that answered outside 2xx is unreachable, with its status', async () => {
      await build({ answer: { ok: false, status: 404 } });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'unreachable'`, {
        label: 'the verdict',
      });

      const shown = await popover();
      assert.match(shown.title, /unreachable/i);
      assert.match(shown.text, /404/);
      assert.match(shown.text, /example\.test/);
    });

    test('a page that answered nothing at all says so without inventing a status', async () => {
      await build({ answer: { ok: false, status: 0 } });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'unreachable'`, {
        label: 'the verdict',
      });

      const shown = await popover();
      assert.match(shown.text, /no answer/i);
      assert.ok(!/\d/.test(shown.text), `a status was invented: ${shown.text}`);
    });

    /**
     * Our side failing is not the link failing. Saying "unreachable" for a
     * function that is down blames the page for something it did not do.
     */
    test('a fetcher that fails reports that we could not check, not that the page is gone', async () => {
      await build({ fails: true });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'unavailable'`, {
        label: 'the verdict',
      });
      assert.match((await popover()).title, /no preview/i);
    });

    /** And it is not remembered, so the next hover tries again. */
    test('a failure is not cached', async () => {
      await build({ fails: true });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'unavailable'`, {
        label: 'the verdict',
      });

      await page.mouse('mouseMoved', box.x, box.y + 300);
      await page.sleep(40);
      await hover(box);
      await waitOut();
      await page.sleep(80);

      assert.equal((await page.eval('window.asked')).length, 2);
    });

    test('a thumbnail is drawn when the answer carries one', async () => {
      const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
      await build({ answer: { ...READY, image } });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('.link-popover-image') !== null`, { label: 'the thumbnail' });
      assert.equal((await popover()).image, image);
    });

    /**
     * The panel is our document and the title came off somebody's page. Built
     * out of text nodes, so markup in a title is characters in a panel.
     */
    test('a hostile title is text, and runs nothing', async () => {
      await build({
        answer: { ...READY, title: '<img src=x onerror="window.__pwned = 1">', description: '</div><script>window.__pwned = 1</script>' },
      });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'ready'`, {
        label: 'the preview',
      });

      const shown = await popover();
      assert.equal(shown.title, '<img src=x onerror="window.__pwned = 1">');
      assert.equal(
        await page.eval(`document.querySelectorAll('[data-link-popover] img, [data-link-popover] script').length`),
        0,
      );
      assert.equal(await page.eval('window.__pwned ?? null'), null);
      await page.sleep(60);
      assert.equal(await page.eval('window.__pwned ?? null'), null, 'nothing ran a moment later either');
    });
  });

  describe('when it goes away', () => {
    test('a press on the board takes it with it', async () => {
      await build({ answer: READY });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]') !== null`, { label: 'the panel' });

      await page.mouse('mousePressed', box.x, box.y);
      await page.mouse('mouseReleased', box.x, box.y);
      await page.sleep(60);
      assert.equal(await popover(), null);
    });

    /** Placed in screen space against a link in world space. */
    test('so does moving the camera', async () => {
      await build({ answer: READY });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]') !== null`, { label: 'the panel' });

      await page.eval('app.viewport.panBy(80, 0)');
      await page.sleep(60);
      assert.equal(await popover(), null);
    });

    test('and destroying the layer leaves nothing behind', async () => {
      await build({ answer: READY });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]') !== null`, { label: 'the panel' });

      await page.eval('window.links.destroy()');
      assert.equal(await popover(), null);

      // And the listeners are gone with it: hovering again does nothing.
      await page.mouse('mouseMoved', box.x + 4, box.y);
      await page.sleep(40);
      await waitOut();
      await page.sleep(40);
      assert.equal(await popover(), null);
    });
  });

  describe('where it sits', () => {
    test('below the link it is about', async () => {
      await build({ answer: READY });
      const { box } = await linkAt();

      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]') !== null`, { label: 'the panel' });

      const shown = await popover();
      assert.ok(shown.y > box.y, 'not below the link');
      assert.equal(shown.above, false);
    });

    test('and above it when there is no room below', async () => {
      await build({ answer: READY });
      const { box } = await linkAt('near the floor https://example.test/a');
      // The card, and its link, down at the bottom of the window.
      await page.eval(`app.store.apply([{ t: 'set', id: app.store.order[0], patch: { y: 700 } }])`);
      await page.sleep(40);

      const low = await page.eval(`(() => {
        const r = document.querySelector('a[data-link]').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);

      await hover(low);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]') !== null`, { label: 'the panel' });

      assert.equal((await popover()).above, true);
      assert.ok(box.y < low.y);
    });
  });

  describe('without a project', () => {
    test('the app still wires a links layer', async () => {
      assert.equal(await page.eval('Boolean(app.links)'), true, 'nothing hovers at all');
    });

    /**
     * And the shell hands it nothing to ask with, which is the ordinary state of
     * a board running on Web Storage — the same load-time decision the
     * repository, the auth gate and live editing make. A hover then has to say
     * so, rather than sit on "loading" for ever or blame the page.
     *
     * Built here with exactly what the shell decided rather than driven through
     * `app.links`, so it runs on this test's clock instead of on a real second.
     */
    test('a hover says a link cannot be checked from here', async () => {
      assert.equal(
        await page.eval(`(async () => (await import('/src/shell/link-preview.js')).linkPreview)()`),
        null,
        'the shell found a project to ask, on a dev server that has none',
      );

      await page.eval(`(async () => {
        const { createLinks } = await import('/src/platform/links.js');
        const { createManualScheduler } = await import('/src/core/scheduler.js');
        const { linkPreview } = await import('/src/shell/link-preview.js');

        window.clock = createManualScheduler();
        window.links = createLinks({
          document,
          elements: { stage: document.getElementById('stage'), layer: document.getElementById('layer'), overlay: document.getElementById('overlay') },
          viewport: app.viewport,
          scheduler: window.clock,
          fetchPreview: linkPreview,
        });
      })()`);

      const { box } = await linkAt();
      await hover(box);
      await waitOut();
      await page.waitFor(`document.querySelector('[data-link-popover]')?.dataset.linkPopover === 'unavailable'`, {
        label: 'the panel to report that a link cannot be checked',
      });

      const shown = await popover();
      assert.match(shown.title, /no preview/i);
      assert.match(shown.text, /without a project/i);
      assert.equal(shown.host, 'example.test', 'the host is known without asking anybody');
    });
  });
});
