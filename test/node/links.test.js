// Links inside a board's text.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hasLink, hostOf, hrefFor, linkRuns, trimTrailing } from '../../src/core/links.js';

/** The href of every run that is a link, in order. */
const hrefs = (text) => linkRuns(text).filter((run) => run.href).map((run) => run.href);
/** What the runs say, which has to be the string back again. */
const rebuilt = (text) => linkRuns(text).map((run) => run.text).join('');

describe('finding links', () => {
  test('an explicit scheme is a link', () => {
    assert.deepEqual(hrefs('see https://example.com/a for more'), ['https://example.com/a']);
    assert.deepEqual(hrefs('http://example.com'), ['http://example.com/']);
  });

  /** Unambiguous, and the only thing spelled that way. */
  test('so is www., which is read as https', () => {
    assert.deepEqual(hrefs('www.example.com/x'), ['https://www.example.com/x']);
  });

  /**
   * A bare domain is not. Half the file names and abbreviations anybody writes
   * on a card would otherwise turn blue.
   */
  test('a bare domain is not', () => {
    for (const text of ['readme.md', 'see e.g.something', '3.14', 'example.com', 'index.html']) {
      assert.deepEqual(hrefs(text), [], text);
    }
  });

  test('several in one string, in order', () => {
    assert.deepEqual(
      hrefs('https://a.test and www.b.test then https://c.test'),
      ['https://a.test/', 'https://www.b.test/', 'https://c.test/'],
    );
  });

  test('a link is found at either end of the text', () => {
    assert.deepEqual(hrefs('https://a.test trailing'), ['https://a.test/']);
    assert.deepEqual(hrefs('leading https://a.test'), ['https://a.test/']);
    assert.deepEqual(hrefs('https://a.test'), ['https://a.test/']);
  });

  test('across lines, since a card holds newlines', () => {
    assert.deepEqual(hrefs('first\nhttps://a.test\nlast'), ['https://a.test/']);
  });

  test('the punctuation somebody wrapped it in is not part of it', () => {
    assert.deepEqual(hrefs('<https://a.test>'), ['https://a.test/']);
    assert.deepEqual(hrefs('"https://a.test"'), ['https://a.test/']);
  });
});

describe('where a link stops', () => {
  test('a sentence ending is prose, not path', () => {
    assert.equal(trimTrailing('https://a.test/page.'), 'https://a.test/page');
    assert.equal(trimTrailing('https://a.test/page...'), 'https://a.test/page');
    assert.equal(trimTrailing('https://a.test/page,'), 'https://a.test/page');
    assert.equal(trimTrailing('https://a.test/page?!'), 'https://a.test/page');
  });

  test('a trailing slash is path, and stays', () => {
    assert.equal(trimTrailing('https://a.test/page/'), 'https://a.test/page/');
  });

  /** The difference this rule exists for. */
  test('a bracket the link opened is kept; one it did not is dropped', () => {
    assert.equal(
      trimTrailing('https://en.wikipedia.org/wiki/Ruby_(gem)'),
      'https://en.wikipedia.org/wiki/Ruby_(gem)',
    );
    assert.equal(trimTrailing('https://a.test/x)'), 'https://a.test/x');
    assert.equal(trimTrailing('https://a.test/x]'), 'https://a.test/x');
  });

  test('a closing bracket and a full stop together', () => {
    assert.equal(trimTrailing('https://a.test/x).'), 'https://a.test/x');
  });

  test('and the prose after it is still prose', () => {
    const runs = linkRuns('(see https://en.wikipedia.org/wiki/Ruby_(gem)) — good');
    assert.equal(runs.filter((run) => run.href).length, 1);
    assert.equal(hrefs('(see https://en.wikipedia.org/wiki/Ruby_(gem)) — good')[0],
      'https://en.wikipedia.org/wiki/Ruby_(gem)');
    assert.match(runs.at(-1).text, /^\) — good$/);
  });
});

describe('what will not be followed', () => {
  /**
   * The security boundary. This text comes from anyone who can edit the board,
   * and the result goes into an href somebody clicks — `javascript:` there runs
   * in this origin with this session.
   */
  test('a scheme that is not http or https', () => {
    for (const raw of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox',
      'file:///etc/passwd',
      'mailto:someone@example.test',
    ]) {
      assert.equal(hrefFor(raw), null, raw);
    }
  });

  /** A trick played on the reader rather than on the browser. */
  test('an address carrying credentials', () => {
    assert.equal(hrefFor('https://docs.example.com@evil.test/'), null);
    assert.equal(hrefFor('https://user:pass@evil.test/'), null);
  });

  test('and none of them survives as a link in text', () => {
    const text = 'try javascript:alert(1) or data:text/html,x';
    assert.deepEqual(hrefs(text), []);
    assert.equal(rebuilt(text), text, 'but the characters are still there');
  });

  test('nonsense answers null rather than throwing', () => {
    for (const raw of ['https://', 'http://', '', null, undefined, 'www.']) {
      assert.equal(hrefFor(raw), null, String(raw));
    }
  });
});

describe('runs', () => {
  /**
   * The view rebuilds the field from these, and `innerText` has to read back as
   * the string the store holds — so the runs must cover every character.
   */
  test('cover the whole string, in order', () => {
    for (const text of [
      'see https://a.test/x for more',
      'https://a.test',
      'nothing here at all',
      '',
      'https://a.test, and www.b.test.',
      'trailing space https://a.test ',
      'line\nhttps://a.test\nline',
    ]) {
      assert.equal(rebuilt(text), text, JSON.stringify(text));
    }
  });

  test('prose either side of a link is one run each', () => {
    assert.deepEqual(linkRuns('a b https://x.test c d'), [
      { text: 'a b ' },
      { text: 'https://x.test', href: 'https://x.test/' },
      { text: ' c d' },
    ]);
  });

  test('the run keeps the text as typed, and the href is normalised', () => {
    const [run] = linkRuns('www.Example.test/Path').filter((r) => r.href);
    assert.equal(run.text, 'www.Example.test/Path', 'what the person wrote');
    assert.equal(run.href, 'https://www.example.test/Path', 'where it goes');
  });

  test('text with nothing in it is one run, or none', () => {
    assert.deepEqual(linkRuns(''), []);
    assert.deepEqual(linkRuns('plain'), [{ text: 'plain' }]);
    assert.deepEqual(linkRuns(null), []);
  });

  test('hasLink answers the cheap question', () => {
    assert.equal(hasLink('see https://a.test'), true);
    assert.equal(hasLink('see nothing'), false);
    assert.equal(hasLink('see javascript:alert(1)'), false);
  });
});

describe('hostOf', () => {
  test('is what the address bar would show, without the www', () => {
    assert.equal(hostOf('https://www.example.com/a/b?c=d'), 'example.com');
    assert.equal(hostOf('https://docs.example.co.uk/'), 'docs.example.co.uk');
  });

  test('and null for what is not an address', () => {
    assert.equal(hostOf('not a url'), null);
    assert.equal(hostOf(undefined), null);
  });
});
