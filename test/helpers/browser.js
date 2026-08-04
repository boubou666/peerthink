import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newPage, closePage } from './cdp.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const COVERAGE_DIR = join(ROOT, '.coverage', 'browser');

/** Written by test/run.js before the test files are spawned. */
export function endpoints() {
  return JSON.parse(readFileSync(join(ROOT, '.coverage', 'endpoint.json'), 'utf8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUTTON_MASK = { none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 };

/**
 * Open a page against the app with V8 coverage recording from the very first
 * script, and return a small driving API.
 */
/** Routing is hash-based; the canvas lives under /#/b/:boardId. */
export const BOARD_PATH = '/#/b/default';
export const LIST_PATH = '/#/';

const CANVAS_READY = 'Boolean(window.app?.store)';
const SHELL_READY = "Boolean(document.querySelector('.shell'))";

export async function openApp({
  width = 1280,
  height = 800,
  path = BOARD_PATH,
  readyWhen = path === LIST_PATH ? SHELL_READY : CANVAS_READY,
} = {}) {
  const { browserBase, appBase } = endpoints();
  const { session, targetId } = await newPage(browserBase);

  const errors = [];
  session.on('Runtime.exceptionThrown', (p) => {
    errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
  });
  session.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') errors.push(`${p.entry.text} ${p.entry.url ?? ''}`.trim());
  });

  await session.send('Runtime.enable');
  await session.send('Log.enable');
  await session.send('Page.enable');
  await session.send('Profiler.enable');
  // must start before the app's scripts are compiled, hence before navigating
  await session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  // V8 discards coverage for scripts collected after a navigation, so snapshot
  // before every reload and merge the pieces at the end.
  const collected = [];
  const snapshot = async () => {
    const { result } = await session.send('Profiler.takePreciseCoverage');
    collected.push(...result.filter((s) => /\/src\//.test(s.url)));
  };

  const api = {
    session,
    errors,
    width,
    height,

    /**
     * Navigate and wait until the page is actually ready, not a fixed delay.
     *
     * Routing is hash-based, so a plain navigate between two routes would not
     * re-execute the document — hence the explicit reload. Tests depend on a
     * genuinely fresh app after seeding localStorage.
     */
    async goto(to = path, { timeout = 15_000, ready = readyWhen } = {}) {
      await snapshot();
      // Routing is hash-based, so navigating straight to another route would
      // not re-execute the document — and tests depend on a genuinely fresh
      // app after seeding localStorage. Bouncing through about:blank forces a
      // real load without racing an in-flight navigation the way reload does.
      await session.send('Page.navigate', { url: 'about:blank' });
      await session.send('Page.navigate', { url: appBase + to });

      const deadline = Date.now() + timeout;
      for (;;) {
        if (await api.eval(ready).catch(() => false)) return;
        if (Date.now() > deadline) throw new Error(`page never became ready at ${appBase + to} (${ready})`);
        await sleep(25);
      }
    },

    /**
     * Poll until an expression is truthy. Use this instead of sleeping past a
     * debounce — a fixed delay that is generous on a laptop is a coin flip on
     * a loaded CI runner.
     */
    async waitFor(expression, { timeout = 5_000, label = expression } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (await api.eval(expression).catch(() => false)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(25);
      }
    },

    async eval(expression) {
      const r = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
      return r.result.value;
    },

    /** Bounding box of an object, in screen coordinates. */
    rect(id) {
      return api.eval(`(() => {
        const el = document.querySelector('[data-id="${id}"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })()`);
    },

    mouse(type, x, y, extra = {}) {
      const button = extra.button ?? 'left';
      return session.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button,
        // Chrome ignores events whose buttons mask contradicts the button
        buttons: type === 'mouseReleased' ? 0 : extra.buttons ?? BUTTON_MASK[button],
        clickCount: extra.clickCount ?? 1,
        modifiers: extra.modifiers ?? 0,
      });
    },

    async click(x, y, extra = {}) {
      await api.mouse('mousePressed', x, y, extra);
      await api.mouse('mouseReleased', x, y, extra);
      await sleep(40);
    },

    async dblclick(x, y) {
      await api.click(x, y);
      await sleep(20);
      await api.mouse('mousePressed', x, y, { clickCount: 2 });
      await api.mouse('mouseReleased', x, y, { clickCount: 2 });
      await sleep(90);
    },

    async drag(from, to, { steps = 6, ...extra } = {}) {
      await api.mouse('mousePressed', from.x, from.y, extra);
      for (let i = 1; i <= steps; i++) {
        await api.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, extra);
        await sleep(12);
      }
      await api.mouse('mouseReleased', to.x, to.y, extra);
      await sleep(50);
    },

    async wheel(x, y, deltaX, deltaY, { modifiers = 0, deltaMode = 0 } = {}) {
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX, deltaY, modifiers,
        ...(deltaMode ? {} : {}),
      });
      await sleep(60);
    },

    /** Dispatch a wheel event with a non-pixel deltaMode, which CDP cannot send. */
    async rawWheel(x, y, deltaX, deltaY, { deltaMode = 0, ctrlKey = false } = {}) {
      await api.eval(`document.getElementById('stage').dispatchEvent(new WheelEvent('wheel', {
        clientX: ${x}, clientY: ${y}, deltaX: ${deltaX}, deltaY: ${deltaY},
        deltaMode: ${deltaMode}, ctrlKey: ${ctrlKey}, bubbles: true, cancelable: true
      }))`);
      await sleep(40);
    },

    async key(key, { code = key, vk = 0, modifiers = 0, text } = {}) {
      const base = { key, code, windowsVirtualKeyCode: vk, modifiers };
      await session.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(60);
    },

    async type(text) {
      for (const ch of text) await session.send('Input.insertText', { text: ch });
      await sleep(60);
    },

    async screenshot(file) {
      const shot = await session.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
    },

    sleep,

    async close() {
      await snapshot();
      mkdirSync(COVERAGE_DIR, { recursive: true });
      writeFileSync(join(COVERAGE_DIR, `${targetId}.json`), JSON.stringify({ result: collected }));
      await session.send('Profiler.stopPreciseCoverage').catch(() => {});
      session.close();
      await closePage(browserBase, targetId);
    },
  };

  await api.goto(path);
  return api;
}
