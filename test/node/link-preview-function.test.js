// The edge function's two halves that hold all the judgement: what it may fetch,
// and what it reads out of a page. Both are plain JavaScript with no Deno in
// them, which is what lets this suite drive them without a runtime or a network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkUrl,
  expandV6,
  isBlockedAddress,
  isBlockedName,
} from '../../supabase/functions/link-preview/guard.js';
import {
  absoluteUrl,
  decodeEntities,
  extractMeta,
} from '../../supabase/functions/link-preview/extract.js';

describe('what the function may fetch', () => {
  const refused = (url) => checkUrl(url).refused ?? null;
  const allowed = (url) => Boolean(checkUrl(url).url);

  test('an ordinary page on the internet', () => {
    assert.ok(allowed('https://example.com/a/b?c=d#e'));
    assert.ok(allowed('http://example.com'));
  });

  test('nothing but http and https', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'gopher://example.com',
      'data:text/html,<b>x</b>',
      'javascript:alert(1)',
      // The one that matters most for a function with network access.
      'http+unix://%2Fvar%2Frun%2Fdocker.sock/containers/json',
    ]) {
      assert.equal(refused(url), 'scheme', url);
    }
  });

  test('nor anything unparseable', () => {
    for (const url of ['', null, undefined, 'not a url', '///', 42]) {
      assert.equal(refused(url), 'not-a-url', String(url));
    }
  });

  /** The credentials would go to whoever the host really is. */
  test('nor a URL carrying credentials', () => {
    assert.equal(refused('https://docs.example.com@evil.test/'), 'credentials');
    assert.equal(refused('https://user:pass@example.com/'), 'credentials');
  });

  describe('nor anywhere inside the network it runs in', () => {
    test('loopback, in either family and every spelling', () => {
      for (const host of ['127.0.0.1', '127.1.2.3', '[::1]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]']) {
        assert.equal(refused(`http://${host}/`), 'private-address', host);
      }
    });

    /**
     * The URL parser normalises these to dotted quads before the guard sees
     * them, which is load-bearing and completely invisible — so it is pinned
     * here rather than assumed.
     */
    test('including loopback written as a number', () => {
      assert.equal(new URL('http://2130706433/').hostname, '127.0.0.1', 'the parser stopped normalising');
      assert.equal(refused('http://2130706433/'), 'private-address');
      assert.equal(refused('http://0x7f.1/'), 'private-address');
    });

    test('private ranges', () => {
      for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '[fd00::1]', '[fc00::1]']) {
        assert.equal(refused(`http://${host}/`), 'private-address', host);
      }
    });

    /** Where a cloud instance keeps its credentials. */
    test('link-local, which is where the metadata service lives', () => {
      assert.equal(refused('http://169.254.169.254/latest/meta-data/'), 'private-address');
      assert.equal(refused('http://[fe80::1]/'), 'private-address');
    });

    test('and the rest of what is not the internet', () => {
      for (const host of ['0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '[::]', '[ff02::1]', '[64:ff9b::7f00:1]']) {
        assert.equal(refused(`http://${host}/`), 'private-address', host);
      }
    });

    test('names that only this network can resolve', () => {
      for (const host of ['localhost', 'db.localhost', 'printer.local', 'vault.internal', 'wiki.intranet', 'x.home.arpa', 'y.onion']) {
        assert.equal(refused(`http://${host}/`), 'private-name', host);
      }
    });

    /** A name with no dot resolves through the network's own search domain. */
    test('and single-label names', () => {
      assert.equal(refused('http://router/'), 'private-name');
      assert.equal(refused('http://metadata/computeMetadata/v1/'), 'private-name');
    });

    test('a public address that merely looks close is allowed', () => {
      for (const host of ['172.15.0.1', '172.32.0.1', '11.0.0.1', '169.253.0.1', '100.63.0.1', '128.0.0.1']) {
        assert.ok(allowed(`http://${host}/`), host);
      }
    });
  });

  test('a bracketed host that is not a readable address is refused', () => {
    assert.equal(isBlockedAddress('[not:an:address:at:all:zz]'), true);
  });

  test('a hostname is not an address, and is left to the name rules', () => {
    assert.equal(isBlockedAddress('example.com'), false);
    assert.equal(isBlockedName('example.com'), false);
  });
});

describe('expandV6', () => {
  test('writes out every spelling of the same address', () => {
    assert.deepEqual(expandV6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandV6('0:0:0:0:0:0:0:1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandV6('[::1]'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandV6('2001:db8::1'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandV6('fe80::'), [0xfe80, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('and the ones with an address inside them', () => {
    assert.deepEqual(expandV6('::ffff:192.168.0.1'), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0001]);
  });

  test('answering nothing for what is not one', () => {
    for (const value of ['example.com', '1.2.3.4', '', null, ':::1', '1:2:3:4:5:6:7:8:9', 'gggg::1', '::99999']) {
      assert.equal(expandV6(value), null, String(value));
    }
  });
});

describe('what it reads out of a page', () => {
  const page = (head) => `<!doctype html><html><head>${head}</head><body><p>Body text</p></body></html>`;

  test('a title, a description and a thumbnail', () => {
    const meta = extractMeta(page(`
      <title>Tab title</title>
      <meta name="description" content="What the page is about.">
      <meta property="og:image" content="https://example.com/og.png">
    `));
    assert.deepEqual(meta, {
      title: 'Tab title',
      description: 'What the page is about.',
      image: 'https://example.com/og.png',
    });
  });

  /** A page with og:title has said what it wants shown. */
  test('OpenGraph wins over the tab title', () => {
    const meta = extractMeta(page('<title>Site — Page</title><meta property="og:title" content="Page">'));
    assert.equal(meta.title, 'Page');
  });

  test('twitter tags are read as a third choice', () => {
    const meta = extractMeta(page('<meta name="twitter:title" content="From Twitter"><meta name="twitter:image" content="/t.png">'));
    assert.equal(meta.title, 'From Twitter');
    assert.equal(meta.image, '/t.png');
  });

  test('attributes in any order, quoted any way', () => {
    const meta = extractMeta(page(`
      <meta content="Backwards" property="og:title">
      <meta content='Single quoted' name='description'>
      <meta property=og:image content=/bare.png>
    `));
    assert.equal(meta.title, 'Backwards');
    assert.equal(meta.description, 'Single quoted');
    assert.equal(meta.image, '/bare.png');
  });

  test('whitespace in a title becomes a single line', () => {
    assert.equal(extractMeta(page('<title>\n  Spread\n  over lines\n</title>')).title, 'Spread over lines');
  });

  test('entities are the characters they stand for', () => {
    assert.equal(extractMeta(page('<title>Tom &amp; Jerry &mdash; &#8220;hi&#x201d;</title>')).title, 'Tom & Jerry — “hi”');
  });

  test('a page with nothing to say answers nothing, not empty strings', () => {
    assert.deepEqual(extractMeta(page('')), { title: null, description: null, image: null });
    assert.deepEqual(extractMeta(''), { title: null, description: null, image: null });
    assert.deepEqual(extractMeta(null), { title: null, description: null, image: null });
  });

  test('an empty tag is as good as no tag', () => {
    const meta = extractMeta(page('<title>   </title><meta name="description" content="  ">'));
    assert.equal(meta.title, null);
    assert.equal(meta.description, null);
  });

  test('the first of a repeated tag is the one meant', () => {
    const meta = extractMeta(page('<meta property="og:title" content="First"><meta property="og:title" content="Second">'));
    assert.equal(meta.title, 'First');
  });

  /** Only the head, so a body full of meta tags cannot dress the panel up. */
  test('tags in the body are not read', () => {
    const html = '<html><head><title>Real</title></head><body><meta property="og:title" content="Injected"></body></html>';
    assert.equal(extractMeta(html).title, 'Real');
  });

  /**
   * Nothing here evaluates what it read, and nothing downstream renders it as
   * markup — the client puts it in with `textContent`. So a script in a title is
   * simply a title with an unusual string in it.
   */
  test('a script in the head is text, not something that happens', () => {
    const meta = extractMeta(page(`
      <script>window.pwned = 1</script>
      <title>Fine</title>
      <meta property="og:description" content="&lt;script&gt;alert(1)&lt;/script&gt;">
    `));
    assert.equal(meta.title, 'Fine');
    assert.equal(meta.description, '<script>alert(1)</script>', 'kept as the characters it is');
    assert.equal(globalThis.pwned, undefined);
  });

  test('a document with no closing head still ends somewhere', () => {
    const long = `<html><head><title>Early</title>${'<meta name="x" content="y">'.repeat(20_000)}`;
    assert.equal(extractMeta(long).title, 'Early');
  });
});

describe('decodeEntities', () => {
  test('leaves an entity it does not know alone', () => {
    assert.equal(decodeEntities('&nosuchthing; &amp;'), '&nosuchthing; &');
  });

  test('and anything numerically out of range', () => {
    assert.equal(decodeEntities('&#0; &#x110000; &#xd800;'), '&#0; &#x110000; &#xd800;');
  });

  test('handling text that is not text', () => {
    assert.equal(decodeEntities(null), '');
    assert.equal(decodeEntities(42), '42');
  });
});

describe('absoluteUrl', () => {
  test('makes a path into an address, against where the page ended up', () => {
    assert.equal(absoluteUrl('https://example.com/a/b', '/og.png'), 'https://example.com/og.png');
    assert.equal(absoluteUrl('https://example.com/a/b', 'c.png'), 'https://example.com/a/c.png');
    assert.equal(absoluteUrl('https://example.com/a', '//cdn.example.com/x.png'), 'https://cdn.example.com/x.png');
  });

  test('leaves an address alone', () => {
    assert.equal(absoluteUrl('https://example.com/', 'https://cdn.test/x.png'), 'https://cdn.test/x.png');
  });

  test('and answers nothing for nothing', () => {
    assert.equal(absoluteUrl('https://example.com/', null), null);
    assert.equal(absoluteUrl('https://example.com/', ''), null);
    assert.equal(absoluteUrl('not a base', '/x.png'), null);
  });
});
