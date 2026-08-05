// Turnstile: the token, and the decision of whether there is one at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnstileCaptcha, loadTurnstile, readTurnstileConfig } from '../../src/platform/turnstile.js';

/** Just enough document to render into and append a script to. */
const fakeDoc = ({ turnstile } = {}) => {
  const appended = [];
  const doc = {
    appended,
    head: { appendChild: (node) => appended.push(node) },
    body: { appendChild: (node) => appended.push(node) },
    defaultView: { turnstile },
    createElement: () => {
      const node = {
        onload: undefined,
        setAttribute() {},
        remove() {
          node.removed = true;
          doc.removed = true;
        },
      };
      return node;
    },
  };
  return doc;
};

describe('turnstile', () => {
  describe('configuration', () => {
    test('a site key is the whole of it', () => {
      assert.deepEqual(readTurnstileConfig({ VITE_TURNSTILE_SITE_KEY: '0xAAA' }), {
        siteKey: '0xAAA',
      });
    });

    test('absent, blank or whitespace is no captcha at all', () => {
      assert.equal(readTurnstileConfig({}), null);
      assert.equal(readTurnstileConfig({ VITE_TURNSTILE_SITE_KEY: '' }), null);
      assert.equal(readTurnstileConfig({ VITE_TURNSTILE_SITE_KEY: '   ' }), null);
      assert.equal(readTurnstileConfig(), null);
    });

    test('no config is no captcha function, rather than one that answers null', () => {
      // The port checks `captcha` for truth before calling it, so the absent
      // case has to be absent — a function answering null would be sent as a
      // captchaToken of null and refused by a project that is checking.
      assert.equal(createTurnstileCaptcha(null), null);
    });
  });

  describe('taking a token', () => {
    test('renders with the site key and answers what the callback is given', async () => {
      let opts;
      const doc = fakeDoc({
        turnstile: {
          render: (_el, options) => {
            opts = options;
            options.callback('token-abc');
          },
        },
      });

      const captcha = createTurnstileCaptcha({ siteKey: '0xAAA' }, { doc });
      assert.equal(await captcha(), 'token-abc');
      assert.equal(opts.sitekey, '0xAAA');
      assert.equal(doc.removed, true, 'the container outlived the token');
    });

    test('a refusal is an error, not a token of undefined', async () => {
      const doc = fakeDoc({
        turnstile: { render: (_el, options) => options['error-callback']() },
      });
      const captcha = createTurnstileCaptcha({ siteKey: '0xAAA' }, { doc });

      await assert.rejects(captcha, /refused to issue/i);
      assert.equal(doc.removed, true, 'the container survived a refusal');
    });

    test('a timeout says so', async () => {
      const doc = fakeDoc({
        turnstile: { render: (_el, options) => options['timeout-callback']() },
      });
      await assert.rejects(createTurnstileCaptcha({ siteKey: '0xAAA' }, { doc }), /timed out/i);
    });

    test('a script that will not load is reported rather than hung on', async () => {
      const captcha = createTurnstileCaptcha(
        { siteKey: '0xAAA' },
        { doc: fakeDoc(), load: () => Promise.reject(new Error('Could not load Turnstile.')) },
      );
      await assert.rejects(captcha, /could not load/i);
    });
  });

  describe('loading the script', () => {
    test('an api already on the window is not fetched again', async () => {
      const api = { render() {} };
      const doc = fakeDoc({ turnstile: api });
      assert.equal(await loadTurnstile(doc), api);
      assert.equal(doc.appended.length, 0, 'appended a script for an API it already had');
    });

    test('onload without the global is a load that did not deliver', async () => {
      const doc = fakeDoc();
      const loading = loadTurnstile(doc);
      doc.appended[0].onload();
      await assert.rejects(loading, /without an API/i);
    });

    test('destroy drops a script still in flight, handlers and all', async () => {
      const doc = fakeDoc();
      const captcha = createTurnstileCaptcha({ siteKey: '0xAAA' }, { doc });

      const taking = captcha();
      // let loadTurnstile append its script before pulling the rug
      await Promise.resolve();
      const script = doc.appended.find((n) => 'onload' in n);
      assert.ok(script, 'no script was appended to cancel');

      captcha.destroy();
      assert.equal(script.onload, null, 'onload outlived destroy');
      assert.equal(script.onerror, null, 'onerror outlived destroy');
      assert.equal(script.removed, true, 'the tag outlived destroy');

      // the abandoned promise must not be left to reject unhandled
      taking.catch(() => {});
    });

    test('destroy is safe twice, and after the load has landed', () => {
      const doc = fakeDoc({ turnstile: { render() {} } });
      const captcha = createTurnstileCaptcha({ siteKey: '0xAAA' }, { doc });
      assert.doesNotThrow(() => {
        captcha.destroy();
        captcha.destroy();
      });
    });

    test('a failed load is not remembered as the answer', async () => {
      const doc = fakeDoc();
      const first = loadTurnstile(doc);
      doc.appended[0].onerror();
      await assert.rejects(first, /could not load/i);

      // the retry gets a fresh script rather than the cached rejection
      loadTurnstile(doc);
      assert.equal(doc.appended.length, 2);
    });
  });
});
