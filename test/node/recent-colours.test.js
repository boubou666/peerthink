// The colours this browser has mixed lately.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RECENT_LIMIT, createRecentColours } from '../../src/platform/recent-colours.js';

const KEY = 'peerthink:recent-colours';

const fakeStorage = (initial = {}) => {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
  };
};

const build = (initial) => {
  const storage = fakeStorage(initial);
  return { storage, recent: createRecentColours({ storage }) };
};

const stored = (storage) => JSON.parse(storage.items.get(KEY));

describe('recent colours', () => {
  test('a browser that has mixed nothing has nothing to offer', () => {
    const { recent } = build();
    assert.deepEqual(recent.list(), []);
  });

  test('remembers what was mixed, most recent first', () => {
    const { storage, recent } = build();
    recent.add('#b4d5ff');
    assert.deepEqual(recent.add('#ffc4d6'), ['#ffc4d6', '#b4d5ff']);
    assert.deepEqual(stored(storage), ['#ffc4d6', '#b4d5ff'], 'the list did not reach storage');
  });

  test('a colour used again moves to the front rather than in twice', () => {
    const { recent } = build();
    recent.add('#111111');
    recent.add('#222222');
    assert.deepEqual(recent.add('#111111'), ['#111111', '#222222']);
  });

  test('normalises on the way in, so one colour is one entry', () => {
    const { recent } = build();
    recent.add('#B4D5FF');
    assert.deepEqual(recent.add('b4d5ff'), ['#b4d5ff'], 'the same colour was kept twice');
  });

  test('keeps a row and no more', () => {
    const { recent } = build();
    for (let n = 0; n <= RECENT_LIMIT; n++) recent.add(`#${String(n).repeat(6)}`);

    const list = recent.list();
    assert.equal(list.length, RECENT_LIMIT);
    assert.equal(list[0], `#${String(RECENT_LIMIT).repeat(6)}`, 'the newest fell off instead of the oldest');
    assert.equal(list.includes('#000000'), false, 'the oldest was kept');
  });

  test('what is not a colour is not remembered', () => {
    const { storage, recent } = build();
    assert.deepEqual(recent.add('rebeccapurple'), []);
    assert.deepEqual(recent.add(undefined), []);
    assert.equal(storage.items.has(KEY), false, 'a non-colour was written');
  });

  /**
   * This is read back out of a store anything on the origin can write to, and
   * it ends up in a CSS custom property — the same reason `card-style.js`
   * refuses what is not plainly a colour.
   */
  test('a tampered record is filtered rather than trusted', () => {
    const { recent } = build({ [KEY]: JSON.stringify(['#b4d5ff', 'url(https://example.com/x.png)', 42]) });
    assert.deepEqual(recent.list(), ['#b4d5ff']);
  });

  test('a record that is not a list at all is no record', () => {
    assert.deepEqual(build({ [KEY]: '{"nope":true}' }).recent.list(), []);
    assert.deepEqual(build({ [KEY]: 'not json' }).recent.list(), []);
  });

  /**
   * A privacy mode with no Web Storage costs the row, not the picker — which
   * is why `add` still answers a list rather than throwing.
   */
  test('without storage it remembers nothing and says so', () => {
    const recent = createRecentColours({ storage: null });
    assert.deepEqual(recent.add('#b4d5ff'), []);
    assert.deepEqual(recent.list(), []);
  });

  /**
   * The answer is what the next visit will see, not what was attempted — a row
   * that fills up with colours that vanish on reload is worse than no row.
   */
  test('a store that refuses to write answers the list it kept', () => {
    const storage = fakeStorage({ [KEY]: JSON.stringify(['#111111']) });
    storage.setItem = () => { throw new Error('quota'); };
    assert.deepEqual(createRecentColours({ storage }).add('#b4d5ff'), ['#111111']);
  });
});
