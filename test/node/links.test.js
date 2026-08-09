// Links inside a board's text.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  canLabel,
  displayText,
  hasLink,
  hostOf,
  hrefFor,
  linkFrom,
  linkRuns,
  linkedText,
  trimTrailing,
} from '../../src/core/links.js';

/** The href of every run that is a link, in order. */
const hrefs = (text) => linkRuns(text).filter((run) => run.href).map((run) => run.href);
/**
 * What the runs hold, which has to be the string back again — `source` where
 * the characters in the document are not the ones on screen, and the text
 * itself everywhere else.
 */
const rebuilt = (text) => linkRuns(text).map((run) => run.source ?? run.text).join('');

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

describe('a link that reads as words', () => {
  test('the label is what it says and the address is where it goes', () => {
    assert.deepEqual(linkRuns('read the [roadmap](https://plan.test/q) before Friday'), [
      { text: 'read the ' },
      { text: 'roadmap', href: 'https://plan.test/q', source: '[roadmap](https://plan.test/q)' },
      { text: ' before Friday' },
    ]);
  });

  /** The address inside the brackets is not prose, so nothing is trimmed off it. */
  test('the address is taken as written', () => {
    assert.deepEqual(hrefs('[docs](https://a.test/b.)'), ['https://a.test/b.']);
    assert.deepEqual(hrefs('[wiki](https://en.wikipedia.org/wiki/Ruby_(gem))'), [
      'https://en.wikipedia.org/wiki/Ruby_(gem)',
    ]);
    assert.deepEqual(hrefs('[home](www.a.test)'), ['https://www.a.test/']);
  });

  /**
   * The scheme allow-list is the same one, and it is the reason this shape is
   * worth being careful about: the characters say one thing and the href does
   * another, which is exactly what an allow-list is for.
   */
  test('an address that will not be followed is not a link, and stays as it reads', () => {
    for (const text of [
      '[click](javascript:alert(1))',
      '[click](data:text/html,x)',
      '[click](https://docs.example.com@evil.test/)',
      '[a](  )',
    ]) {
      assert.deepEqual(hrefs(text), [], text);
      assert.equal(rebuilt(text), text, text);
    }
  });

  /**
   * And what is not a labelled link is not therefore not a link: the address in
   * it is still an address, spelled the way prose spells one. So the brackets
   * stay as characters and the URL goes blue, which is what somebody who typed
   * those characters by hand is looking at.
   */
  test('a label ends at the first bracket, and the address is still an address', () => {
    assert.deepEqual(linkRuns('[a]b](https://x.test)'), [
      { text: '[a]b](' },
      { text: 'https://x.test', href: 'https://x.test/' },
      { text: ')' },
    ]);
    assert.deepEqual(linkRuns('[](https://a.test)'), [
      { text: '[](' },
      { text: 'https://a.test', href: 'https://a.test/' },
      { text: ')' },
    ]);
  });

  /**
   * An opening bracket, though, is a character a label may hold — "see [my
   * note" is a thing somebody can select — so the label starts at the first one
   * and runs to the closing one. That is not quite what markdown would say, and
   * it is what makes the label read back as exactly the words that were chosen.
   */
  test('an opening bracket is part of the label, because a label may hold one', () => {
    assert.deepEqual(linkRuns('[[a](https://x.test)'), [
      { text: '[a', href: 'https://x.test/', source: '[[a](https://x.test)' },
    ]);
    assert.deepEqual(linkRuns('[note] see [link](https://x.test)'), [
      { text: '[note] see ' },
      { text: 'link', href: 'https://x.test/', source: '[link](https://x.test)' },
    ]);
  });

  test('the string comes back exactly, which is what the field is read back as', () => {
    for (const text of [
      '[a](https://a.test)',
      'before [a](https://a.test) after',
      '[a](https://a.test)[b](https://b.test)',
      'plain https://c.test and [d](https://d.test)',
      '[a](nowhere)',
    ]) {
      assert.equal(rebuilt(text), text, text);
    }
  });

  test('displayText is what is on the screen, not what is in the document', () => {
    assert.equal(displayText('read the [roadmap](https://plan.test/q) now'), 'read the roadmap now');
    assert.equal(displayText('nothing here'), 'nothing here');
    assert.equal(displayText(null), '');
  });

  test('and hasLink counts one', () => {
    assert.equal(hasLink('[a](https://a.test)'), true);
    assert.equal(hasLink('[a](nowhere)'), false);
  });
});

describe('the address somebody typed', () => {
  test('is taken as an address, bare domain and all', () => {
    assert.equal(linkFrom('example.com'), 'https://example.com/');
    assert.equal(linkFrom('  example.com/a?b=c  '), 'https://example.com/a?b=c');
    assert.equal(linkFrom('https://example.com/a'), 'https://example.com/a');
    assert.equal(linkFrom('www.example.com'), 'https://www.example.com/');
  });

  test('and refused on exactly the terms prose is', () => {
    for (const typed of [
      'javascript:alert(1)',
      'data:text/html,x',
      'https://user:pass@evil.test/',
      'localhost',
      'hello there',
      '',
      null,
    ]) {
      assert.equal(linkFrom(typed), null, String(typed));
    }
  });
});

describe('turning a run of text into a link', () => {
  test('writes the label and the address where the words were', () => {
    assert.equal(
      linkedText('read the roadmap now', 9, 16, 'https://plan.test/q'),
      'read the [roadmap](https://plan.test/q) now',
    );
  });

  test('offsets outside the string are clamped rather than refused', () => {
    assert.equal(linkedText('abc', -5, 99, 'https://a.test'), '[abc](https://a.test)');
    assert.equal(linkedText('abc', 2, 1, 'https://a.test'), 'abc', 'an end before the start is empty');
  });

  /**
   * The address is written into a string a recogniser has to read back, and the
   * recogniser follows one level of balanced brackets. So the round trip is the
   * thing under test here, not the characters: a link that comes back pointing
   * at a shorter address is a link to somewhere nobody chose.
   */
  test('an address whose brackets cannot be read back has them encoded', () => {
    const written = linkedText('x', 0, 1, 'https://a.test/p)');
    assert.equal(written, '[x](https://a.test/p%29)');
    assert.deepEqual(hrefs(written), ['https://a.test/p%29'], 'and the whole address survives');

    assert.equal(linkedText('x', 0, 1, 'https://a.test/p('), '[x](https://a.test/p%28)');
    assert.equal(linkedText('x', 0, 1, 'https://a.test/(a(b)c)'), '[x](https://a.test/%28a%28b%29c%29)');
  });

  test('and one whose brackets can is left readable', () => {
    const written = linkedText('x', 0, 1, 'https://en.wikipedia.org/wiki/Ruby_(gem)');
    assert.equal(written, '[x](https://en.wikipedia.org/wiki/Ruby_(gem))');
    assert.deepEqual(hrefs(written), ['https://en.wikipedia.org/wiki/Ruby_(gem)']);
  });

  test('an empty range is nothing to label', () => {
    assert.equal(linkedText('abc', 1, 1, 'https://a.test'), 'abc');
    assert.equal(linkedText(null, 0, 0, 'https://a.test'), '');
  });

  test('what may be a label', () => {
    assert.equal(canLabel('our roadmap'), true);
    assert.equal(canLabel('  '), false, 'nothing to click');
    assert.equal(canLabel(''), false);
    assert.equal(canLabel(undefined), false);
    assert.equal(canLabel('https://a.test'), false, 'already a link');
    assert.equal(canLabel('see www.a.test'), false, 'and one inside it is still one');
    assert.equal(canLabel('a] b'), false, 'a bracket the label cannot hold');
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
