// The edge function's fetching half, driven with a `fetch` of our own.
//
// `preview` takes its fetch as an argument for the reason everything in src/
// takes its environment as one: redirect following, the byte caps, the thumbnail
// and the not-a-page branch are the parts most worth pinning and the parts a
// unit test of the guard cannot reach. The guard still runs on every URL here —
// this seam decides who answers, never what is allowed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { preview } from '../../supabase/functions/link-preview/index.js';

const PAGE = `<!doctype html><html><head>
  <title>Tab title</title>
  <meta property="og:title" content="Example Domain">
  <meta name="description" content="What the page is about.">
  <meta property="og:image" content="/og.png">
</head><body>hi</body></html>`;

/** A one-pixel PNG, as the bytes a server would send. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A fetch that answers from a table of URLs, and records what it was asked.
 *
 * `null` for a URL means "throw", which is every way a request fails from this
 * side: refused, timed out, DNS, TLS.
 */
const fetcher = (routes) => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const route = routes[String(url)];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (route === null) throw new TypeError('failed to fetch');
    return route();
  };
  fetchImpl.asked = asked;
  return fetchImpl;
};

const html = (body = PAGE, headers = {}) => () =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

const redirect = (to, status = 301) => () =>
  new Response(null, { status, headers: { location: to } });

describe('a page that answers', () => {
  test('comes back as a title, a description, a host and a thumbnail', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': html(),
      'https://example.test/og.png': () =>
        new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    });

    const answer = await preview('https://example.test/a', { fetchImpl });

    assert.equal(answer.ok, true);
    assert.equal(answer.status, 200);
    assert.equal(answer.host, 'example.test');
    assert.equal(answer.title, 'Example Domain', 'og:title should win over <title>');
    assert.equal(answer.description, 'What the page is about.');
    assert.match(answer.image, /^data:image\/png;base64,/, 'the thumbnail was not inlined');
    assert.ok(answer.image.length > 60);
  });

  test('a page with no thumbnail is still a preview', async () => {
    const fetchImpl = fetcher({ 'https://example.test/a': html('<html><head><title>Bare</title></head></html>') });
    const answer = await preview('https://example.test/a', { fetchImpl });

    assert.deepEqual(
      { ok: answer.ok, title: answer.title, description: answer.description, image: answer.image },
      { ok: true, title: 'Bare', description: null, image: null },
    );
    assert.equal(fetchImpl.asked.length, 1, 'something was fetched for a page with no image');
  });

  /** The host is where it ended up, not where it was sent. */
  test('a redirect is followed, and the host is the one that answered', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': redirect('https://elsewhere.test/b'),
      'https://elsewhere.test/b': html('<html><head><title>Moved</title></head></html>'),
    });

    const answer = await preview('https://example.test/a', { fetchImpl });
    assert.equal(answer.ok, true);
    assert.equal(answer.host, 'elsewhere.test');
    assert.equal(answer.title, 'Moved');
  });

  test('a relative redirect resolves against where it came from', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': redirect('/b'),
      'https://example.test/b': html('<html><head><title>Same site</title></head></html>'),
    });
    assert.equal((await preview('https://example.test/a', { fetchImpl })).title, 'Same site');
  });

  test('the www is dropped from the host, as an address bar would', async () => {
    const fetchImpl = fetcher({ 'https://www.example.test/a': html() });
    assert.equal((await preview('https://www.example.test/a', { fetchImpl })).host, 'example.test');
  });
});

describe('a page that does not', () => {
  test('a 404 is unreachable, with its status', async () => {
    const fetchImpl = fetcher({});
    assert.deepEqual(await preview('https://example.test/gone', { fetchImpl }), { ok: false, status: 404 });
  });

  test('a 500 likewise', async () => {
    const fetchImpl = fetcher({ 'https://example.test/a': () => new Response('no', { status: 503 }) });
    assert.deepEqual(await preview('https://example.test/a', { fetchImpl }), { ok: false, status: 503 });
  });

  test('a request that fails outright has no status to report', async () => {
    const fetchImpl = fetcher({ 'https://example.test/a': null });
    assert.deepEqual(await preview('https://example.test/a', { fetchImpl }), { ok: false, status: 0 });
  });

  test('a redirect with nowhere to go is the answer itself', async () => {
    const fetchImpl = fetcher({ 'https://example.test/a': redirect('http://[not an address]/') });
    assert.deepEqual(await preview('https://example.test/a', { fetchImpl }), { ok: false, status: 301 });
  });

  test('a redirect loop gives up rather than going round', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': redirect('https://example.test/b'),
      'https://example.test/b': redirect('https://example.test/a'),
    });

    assert.deepEqual(await preview('https://example.test/a', { fetchImpl }), { ok: false, status: 0 });
    assert.ok(fetchImpl.asked.length <= 5, `followed ${fetchImpl.asked.length} hops`);
  });
});

describe('what it will not fetch', () => {
  /**
   * The answer for a refused URL is the answer for a silent one, so this cannot
   * be used to find out which internal addresses exist.
   */
  test('a private address answers exactly as no answer does', async () => {
    const fetchImpl = fetcher({});
    for (const url of [
      'http://127.0.0.1:5432/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/admin',
      'http://[::1]/',
      'http://localhost:8000/',
      'file:///etc/passwd',
      'https://user:pass@evil.test/',
    ]) {
      assert.deepEqual(await preview(url, { fetchImpl }), { ok: false, status: 0 }, url);
    }
    assert.deepEqual(fetchImpl.asked, [], 'a request was made for a refused URL');
  });

  /** The hop nothing looks at, in the usual way round a guard. */
  test('nor a public URL that redirects into the private network', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': redirect('http://169.254.169.254/latest/meta-data/'),
    });

    assert.deepEqual(await preview('https://example.test/a', { fetchImpl }), { ok: false, status: 0 });
    assert.deepEqual(fetchImpl.asked, ['https://example.test/a'], 'the metadata service was fetched');
  });

  test('nor a thumbnail that points inside the network', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': html(`<html><head><title>T</title>
        <meta property="og:image" content="http://169.254.169.254/latest/meta-data/iam"></head></html>`),
    });

    const answer = await preview('https://example.test/a', { fetchImpl });
    assert.equal(answer.ok, true);
    assert.equal(answer.image, null);
    assert.deepEqual(fetchImpl.asked, ['https://example.test/a']);
  });
});

describe('a link to something that is not a page', () => {
  test('says what it is and how big', async () => {
    const fetchImpl = fetcher({
      'https://example.test/files/report.pdf': () => new Response('%PDF-1.7', {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': String(2.5 * 1024 * 1024) },
      }),
    });

    const answer = await preview('https://example.test/files/report.pdf', { fetchImpl });
    assert.equal(answer.ok, true);
    assert.equal(answer.title, 'report.pdf');
    assert.equal(answer.description, 'application/pdf, 2.5 MB');
    assert.equal(answer.image, null);
  });

  test('and falls back to the host when the path names nothing', async () => {
    const fetchImpl = fetcher({
      'https://example.test/': () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    assert.equal((await preview('https://example.test/', { fetchImpl })).title, 'example.test');
  });

  test('a size that was not given is left out rather than guessed', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a.zip': () => new Response('x', { status: 200, headers: { 'content-type': 'application/zip' } }),
    });
    assert.equal((await preview('https://example.test/a.zip', { fetchImpl })).description, 'application/zip');
  });

  test('plain text is read as a page, since it may still have a title', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a.txt': () => new Response('just words', {
        status: 200, headers: { 'content-type': 'text/plain' },
      }),
    });
    const answer = await preview('https://example.test/a.txt', { fetchImpl });
    assert.equal(answer.ok, true);
    assert.equal(answer.title, null, 'text with no title has none');
  });
});

describe('the caps', () => {
  test('a page far larger than the cap still gives up its title', async () => {
    const long = `<html><head><title>Early</title>${'<!-- padding -->'.repeat(200_000)}`;
    const fetchImpl = fetcher({ 'https://example.test/a': html(long) });

    const answer = await preview('https://example.test/a', { fetchImpl });
    assert.equal(answer.title, 'Early');
  });

  test('a thumbnail over the cap is left out rather than sent half', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': html(),
      'https://example.test/og.png': () => new Response(Buffer.alloc(200 * 1024, 7), {
        status: 200, headers: { 'content-type': 'image/png' },
      }),
    });

    assert.equal((await preview('https://example.test/a', { fetchImpl })).image, null);
  });

  test('a thumbnail that is not an image is not inlined', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': html(),
      'https://example.test/og.png': () => new Response('<html>gotcha</html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    });
    assert.equal((await preview('https://example.test/a', { fetchImpl })).image, null);
  });

  test('an SVG thumbnail is refused, being a document rather than a bitmap', async () => {
    const fetchImpl = fetcher({
      'https://example.test/a': html(),
      'https://example.test/og.png': () => new Response('<svg/>', {
        status: 200, headers: { 'content-type': 'image/svg+xml' },
      }),
    });
    assert.equal((await preview('https://example.test/a', { fetchImpl })).image, null);
  });

  test('a thumbnail that 404s leaves the rest of the preview standing', async () => {
    const fetchImpl = fetcher({ 'https://example.test/a': html() });
    const answer = await preview('https://example.test/a', { fetchImpl });
    assert.equal(answer.ok, true);
    assert.equal(answer.title, 'Example Domain');
    assert.equal(answer.image, null);
  });
});
