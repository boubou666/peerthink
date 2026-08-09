// Asking the server what is at a link, and what is allowed back.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FUNCTION, createLinkPreview, normalisePreview } from '../../src/platform/link-preview.js';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';
const href = 'https://example.test/a';

describe('normalisePreview', () => {
  test('a 2xx with a page behind it comes through', () => {
    assert.deepEqual(
      normalisePreview({
        ok: true, status: 200, title: 'Title', description: 'About it', host: 'example.test', image: PIXEL,
      }, href),
      { ok: true, status: 200, title: 'Title', description: 'About it', host: 'example.test', image: PIXEL },
    );
  });

  test('a description laid out over several lines becomes a sentence', () => {
    const { description } = normalisePreview(
      { ok: true, status: 200, description: '  one\n    two\t three  ' },
      href,
    );
    assert.equal(description, 'one two three');
  });

  test('long text is cut rather than carried', () => {
    const { title, description } = normalisePreview(
      { ok: true, status: 200, title: 'T'.repeat(5_000), description: 'D'.repeat(5_000) },
      href,
    );
    assert.ok(title.length < 400, `a ${title.length}-character title`);
    assert.ok(description.length < 800, `a ${description.length}-character description`);
  });

  test('fields that are not strings are simply absent', () => {
    const preview = normalisePreview(
      { ok: true, status: 200, title: 42, description: { text: 'no' }, host: ['example.test'] },
      href,
    );
    assert.equal(preview.title, null);
    assert.equal(preview.description, null);
    assert.equal(preview.host, 'example.test', 'and the host falls back to the link’s own');
  });

  test('an empty title is nothing rather than an empty line', () => {
    assert.equal(normalisePreview({ ok: true, status: 200, title: '   ' }, href).title, null);
  });

  /**
   * The same rule an image object on the board follows. This value goes into an
   * `img` and came over the network: only a base64 data URL of a raster type is
   * drawn, which is also what makes the browser send no request of its own to
   * the site being previewed.
   */
  describe('the thumbnail', () => {
    test('a data URL of a raster type is kept', () => {
      assert.equal(normalisePreview({ ok: true, status: 200, image: PIXEL }, href).image, PIXEL);
    });

    test('anything that would reach out to the site is not', () => {
      for (const image of [
        'https://example.test/og.png',
        '//example.test/og.png',
        'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        'javascript:alert(1)',
        42,
        null,
      ]) {
        assert.equal(normalisePreview({ ok: true, status: 200, image }, href).image, null, String(image));
      }
    });
  });

  describe('what counts as reachable', () => {
    test('2xx only, whatever the payload claims', () => {
      assert.equal(normalisePreview({ ok: true, status: 204 }, href).ok, true);
      assert.equal(normalisePreview({ ok: true, status: 299 }, href).ok, true);

      for (const status of [199, 300, 301, 404, 418, 500, 0]) {
        assert.equal(normalisePreview({ ok: true, status }, href).ok, false, `status ${status}`);
      }
    });

    test('a payload that says it failed is a failure, whatever the status', () => {
      assert.deepEqual(normalisePreview({ ok: false, status: 200 }, href), { ok: false, status: 200 });
    });

    test('an unreachable answer carries nothing but its status', () => {
      assert.deepEqual(
        normalisePreview({ ok: false, status: 404, title: 'Not Found', image: PIXEL }, href),
        { ok: false, status: 404 },
      );
    });

    test('nonsense from the wire is a status of nothing, not a crash', () => {
      for (const payload of [null, undefined, 'no', 42, {}, { status: 'two hundred' }]) {
        assert.deepEqual(normalisePreview(payload, href), { ok: false, status: 0 });
      }
    });
  });
});

describe('createLinkPreview', () => {
  const clientThatAnswers = (answer, error = null) => ({
    functions: {
      calls: [],
      invoke(name, options) {
        this.calls.push({ name, options });
        return Promise.resolve({ data: answer, error });
      },
    },
  });

  test('is nothing at all without a project to ask', () => {
    assert.equal(createLinkPreview({ client: null }), null);
    assert.equal(createLinkPreview({}), null);
    assert.equal(createLinkPreview(), null);
  });

  test('asks the function for the url, and normalises what comes back', async () => {
    const client = clientThatAnswers({ ok: true, status: 200, title: 'Title' });
    const preview = await createLinkPreview({ client })(href);

    assert.equal(client.functions.calls[0].name, FUNCTION);
    assert.deepEqual(client.functions.calls[0].options, { body: { url: href } });
    assert.equal(preview.title, 'Title');
    assert.equal(preview.ok, true);
  });

  /**
   * The asking failing is not the link failing, and the popover says the two
   * differently — "we could not check" against "the page did not answer". So
   * this rejects rather than answering `ok: false`.
   */
  test('a function that will not answer rejects rather than blaming the page', async () => {
    const client = clientThatAnswers(null, new Error('Failed to send a request'));
    await assert.rejects(() => createLinkPreview({ client })(href), /Failed to send a request/);
  });

  test('the function name can be pointed elsewhere', async () => {
    const client = clientThatAnswers({ ok: true, status: 200 });
    await createLinkPreview({ client, functionName: 'somewhere-else' })(href);
    assert.equal(client.functions.calls[0].name, 'somewhere-else');
  });
});
