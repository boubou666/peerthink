// Turning the selected words into a link.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { answerAsk, clickSelector, dismissAsk, openApp } from '../helpers/browser.js';

describe('a link in the selected text', () => {
  let page;

  before(async () => { page = await openApp(); });

  after(async () => {
    assert.deepEqual(page.errors, [], 'the page logged errors');
    await page.close();
  });

  beforeEach(async () => {
    await page.eval('localStorage.clear()');
    await page.goto();
    await page.waitFor('Boolean(window.app?.autosave)', { label: 'the board to load' });
    await page.eval('app.store.load({ v: 1, order: [], objects: [] })');
  });

  const CARD = { x: 200, y: 200, w: 320, h: 140 };

  const addCard = (text) =>
    page.eval(`app.board.add('card', ${JSON.stringify({ ...CARD, text })}).id`);

  const text = (id) => page.eval(`app.store.get('${id}').text`);

  /** Where a run of characters is on screen, so a real pointer can reach it. */
  const boxOf = (id, word, field = 'text') => page.eval(`(() => {
    const el = document.querySelector('[data-id="${id}"] [data-field="${field}"]');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(${JSON.stringify(word)});
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + ${word.length});
      const r = range.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return null;
  })()`);

  /**
   * Select a word the way a person does: double-click to start editing, then
   * double-click the word, which is the browser's own word selection.
   */
  const selectWord = async (id, word, field = 'text') => {
    const box = await boxOf(id, word, field);
    assert.ok(box, `“${word}” is on screen`);
    await page.dblclick(box.x, box.y);
    await page.dblclick(box.x, box.y);
    return box;
  };

  /** Everything in a field, which is what ⌘A does once a field has the caret. */
  const selectAll = (id, field = 'text') => page.eval(`(() => {
    const el = document.querySelector('[data-id="${id}"] [data-field="${field}"]');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);

  const LINK = '[data-format-bar] [data-action="add-link"]';

  const offered = () => page.waitFor(`document.querySelector('${LINK}') !== null`, {
    label: 'the link control',
    context: 'document.querySelector("[data-format-bar]")?.innerText ?? "no bar"',
  });

  /**
   * Whether the control is absent, after giving React a commit to have rendered
   * it in. There is no positive condition for absence — but the selection this
   * is about is read on every render, and two frames is more than the microtask
   * the listener defers by.
   */
  const notOffered = async () => {
    await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    return page.eval(`document.querySelector('${LINK}') === null`);
  };

  /** The anchor a card is drawing, once nobody is typing in it. */
  const drawn = (id) => page.eval(`(() => {
    const a = document.querySelector('[data-id="${id}"] a[data-link]');
    return a && { text: a.textContent, href: a.getAttribute('href'), source: a.dataset.source ?? null };
  })()`);

  test('selected words become a link to the address they are given', async () => {
    const id = await addCard('read the roadmap before Friday');
    await selectWord(id, 'roadmap');
    await offered();

    await clickSelector(page, LINK);
    await answerAsk(page, 'https://plan.test/q');

    await page.waitFor(`app.store.get('${id}').text.includes('plan.test')`, { label: 'the link' });
    assert.equal(await text(id), 'read the [roadmap](https://plan.test/q) before Friday');
  });

  test('and the card draws the words, with the address behind them', async () => {
    const id = await addCard('read the roadmap before Friday');
    await selectWord(id, 'roadmap');
    await offered();
    await clickSelector(page, LINK);
    await answerAsk(page, 'https://plan.test/q');

    await page.waitFor(`document.querySelector('[data-id="${id}"] a[data-link]') !== null`, {
      label: 'the link on the card',
    });
    assert.deepEqual(await drawn(id), {
      text: 'roadmap',
      href: 'https://plan.test/q',
      source: '[roadmap](https://plan.test/q)',
    });
  });

  test('an address with no scheme is one all the same', async () => {
    const id = await addCard('read the roadmap before Friday');
    await selectWord(id, 'roadmap');
    await offered();
    await clickSelector(page, LINK);
    await answerAsk(page, 'plan.test/q');

    await page.waitFor(`app.store.get('${id}').text.includes('plan.test')`, { label: 'the link' });
    assert.equal(await text(id), 'read the [roadmap](https://plan.test/q) before Friday');
  });

  /**
   * Answer without waiting for the question to go.
   *
   * `answerAsk` waits for `[data-ask]` to be absent, and a refused address is
   * asked again in the same breath — the dialog is replaced between one render
   * and the next, so a poll every 25ms never catches it gone and the helper
   * times out on a flow that is working.
   */
  const answerLeavingItOpen = async (value) => {
    await page.eval(`(() => {
      const el = document.querySelector('[data-ask-field]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await clickSelector(page, '[data-action="ask-confirm"]');
  };

  test('an address that cannot be opened is asked again, keeping what was typed', async () => {
    const id = await addCard('read the roadmap before Friday');
    await selectWord(id, 'roadmap');
    await offered();
    await clickSelector(page, LINK);

    await answerLeavingItOpen('javascript:alert(1)');

    await page.waitFor(`document.querySelector('[data-ask] .ask-message')?.textContent.includes('http')`, {
      label: 'the question to be asked again',
      context: 'document.querySelector("[data-ask]")?.innerText ?? "no question"',
    });
    assert.equal(
      await page.eval(`document.querySelector('[data-ask-field]').value`),
      'javascript:alert(1)',
      'the address is still in the field to be corrected',
    );

    await answerAsk(page, 'https://plan.test/q');
    await page.waitFor(`app.store.get('${id}').text.includes('plan.test')`, { label: 'the link' });
    assert.equal(await text(id), 'read the [roadmap](https://plan.test/q) before Friday');
  });

  test('a question waved away leaves the words as they were', async () => {
    const id = await addCard('read the roadmap before Friday');
    await selectWord(id, 'roadmap');
    await offered();
    await clickSelector(page, LINK);
    await dismissAsk(page);

    assert.equal(await text(id), 'read the roadmap before Friday');
    assert.equal(await drawn(id), null);
  });

  test('the link is one undo away from not being there', async () => {
    const id = await addCard('read the roadmap before Friday');
    await selectWord(id, 'roadmap');
    await offered();
    await clickSelector(page, LINK);
    await answerAsk(page, 'https://plan.test/q');
    await page.waitFor(`app.store.get('${id}').text.includes('plan.test')`, { label: 'the link' });

    await page.eval('app.store.undo()');
    assert.equal(await text(id), 'read the roadmap before Friday');
  });

  test('text that is already a link is not offered another', async () => {
    const id = await addCard('https://example.test/a');
    // Selected as an object too, so the bar this control would be on is
    // genuinely there — otherwise the absence below would be the absence of
    // the whole bar and would say nothing.
    await page.eval(`app.selection.set(['${id}'])`);
    await selectAll(id);

    await page.waitFor(`document.querySelector('[data-format-bar]') !== null`, { label: 'the bar' });
    assert.equal(await notOffered(), true);
  });

  test('and neither is a caret, which has selected nothing', async () => {
    const id = await addCard('read the roadmap before Friday');
    const box = await boxOf(id, 'roadmap');
    await page.dblclick(box.x, box.y);
    assert.equal(await notOffered(), true);
  });

  /**
   * The case the measuring exists for: `innerText` is what the *layout* says,
   * and a line break is a character in the string with no character in the DOM.
   * Words on the second line are therefore at an offset nothing in the document
   * counts to.
   */
  test('words on the second line are found at the offset the string has them at', async () => {
    const id = await addCard('friday\nread the roadmap\nand reply');
    await selectWord(id, 'roadmap');
    await offered();

    await clickSelector(page, LINK);
    await answerAsk(page, 'https://plan.test/q');

    await page.waitFor(`app.store.get('${id}').text.includes('plan.test')`, { label: 'the link' });
    assert.equal(await text(id), 'friday\nread the [roadmap](https://plan.test/q)\nand reply');
  });

  test('and so are words after a line somebody typed', async () => {
    const id = await addCard('friday');
    const box = await boxOf(id, 'friday');
    await page.dblclick(box.x, box.y);
    // Typed, so the second line is whatever the browser makes of Enter rather
    // than the text node a fresh render would have built.
    await page.key('End', { vk: 35 });
    // `\r`, which is what Chrome sends for Enter — with `\n` the key arrives
    // and inserts nothing, and the two lines run together.
    await page.key('Enter', { vk: 13, text: '\r' });
    await page.type('read the roadmap');
    await page.waitFor(`app.store.get('${id}').text.includes('roadmap')`, { label: 'the typing' });

    await selectWord(id, 'roadmap');
    await offered();
    await clickSelector(page, LINK);
    await answerAsk(page, 'https://plan.test/q');

    await page.waitFor(`app.store.get('${id}').text.includes('plan.test')`, { label: 'the link' });
    assert.equal(await text(id), 'friday\nread the [roadmap](https://plan.test/q)');
  });

  test('a list item holds one too', async () => {
    const id = await page.eval(`app.board.add('list', ${JSON.stringify({ x: 200, y: 400, w: 260, h: 160 })}).id`);
    const itemId = await page.eval(`(() => {
      const items = app.store.get('${id}').items.map((item, i) => (i === 0 ? { ...item, text: 'ask the design team' } : item));
      app.store.apply([{ t: 'set', id: '${id}', patch: { items } }]);
      return items[0].id;
    })()`);

    await selectWord(id, 'design', 'item');
    await offered();
    await clickSelector(page, LINK);
    await answerAsk(page, 'https://team.test/');

    await page.waitFor(`app.store.get('${id}').items[0].text.includes('team.test')`, { label: 'the link' });
    assert.equal(
      await page.eval(`app.store.get('${id}').items[0].text`),
      'ask the [design](https://team.test/) team',
    );
    assert.equal(await page.eval(`app.store.get('${id}').items[0].id`), itemId, 'the row is the same one');
  });

  /**
   * Start editing a card holding a link — by double-clicking a word that is not
   * the link. A press on a link is a press on a link: it opens a tab, which is
   * what it is for, and a tab really opening leaves every later input dispatch
   * seconds slow.
   */
  const editAwayFromTheLink = async (id) => {
    const box = await boxOf(id, 'before');
    assert.ok(box, 'a word to click that is not the link');
    await page.dblclick(box.x, box.y);
  };

  describe('editing a field that holds one', () => {
    test('shows the address, so what is read back is what is stored', async () => {
      const id = await addCard('read the [roadmap](https://plan.test/q) before Friday');
      await page.waitFor(`document.querySelector('[data-id="${id}"] a[data-link]') !== null`, {
        label: 'the link on the card',
      });

      await editAwayFromTheLink(id);

      assert.equal(
        await page.eval(`document.querySelector('[data-id="${id}"] [data-field="text"]').innerText`),
        'read the [roadmap](https://plan.test/q) before Friday',
      );
      assert.equal(await drawn(id), null, 'and no anchor is left to type inside');
    });

    test('so a keystroke does not throw the address away', async () => {
      const id = await addCard('read the [roadmap](https://plan.test/q) before Friday');
      await page.waitFor(`document.querySelector('[data-id="${id}"] a[data-link]') !== null`, {
        label: 'the link on the card',
      });

      await editAwayFromTheLink(id);
      await page.type('!');

      await page.waitFor(`app.store.get('${id}').text.includes('!')`, { label: 'the keystroke' });
      // Where the caret landed inside the word is the browser's business; that
      // the address came through the keystroke is this test's.
      assert.match(await text(id), /\]\(https:\/\/plan\.test\/q\)/);
    });

    test('and the caret lands where the pointer was, not where the source pushed it', async () => {
      const id = await addCard('read the [roadmap](https://plan.test/q) before Friday');
      await page.waitFor(`document.querySelector('[data-id="${id}"] a[data-link]') !== null`, {
        label: 'the link on the card',
      });

      // A word after the link, so revealing the source moves it — by the
      // twenty-odd characters that would otherwise be typed into the address.
      await editAwayFromTheLink(id);
      await page.type('!');

      await page.waitFor(`app.store.get('${id}').text.includes('!')`, { label: 'the keystroke' });
      const written = await text(id);
      assert.ok(
        written.indexOf('!') > written.indexOf(')'),
        `the keystroke landed after the link: ${written}`,
      );
    });

    test('and leaving it puts the link back', async () => {
      const id = await addCard('read the [roadmap](https://plan.test/q) before Friday');
      await editAwayFromTheLink(id);
      await page.eval('document.activeElement.blur()');

      await page.waitFor(`document.querySelector('[data-id="${id}"] a[data-link]') !== null`, {
        label: 'the link to come back',
      });
      assert.equal((await drawn(id)).text, 'roadmap');
    });
  });

  describe('what it refuses', () => {
    test('nothing selected is nothing to link', async () => {
      await addCard('read the roadmap before Friday');
      await page.eval('document.activeElement?.blur?.()');
      assert.equal(await page.eval('app.textLinks.label()'), null);
      assert.equal(await page.eval('app.textLinks.capture()'), null);
    });

    test('a selection spanning two objects is not one field of text', async () => {
      const first = await addCard('read the roadmap');
      const second = await page.eval(`app.board.add('card', ${JSON.stringify({ x: 600, y: 200, w: 200, h: 100, text: 'and the plan' })}).id`);

      assert.equal(await page.eval(`(() => {
        const from = document.querySelector('[data-id="${first}"] [data-field="text"]');
        const to = document.querySelector('[data-id="${second}"] [data-field="text"]');
        from.focus();
        const range = document.createRange();
        range.setStart(from.firstChild, 0);
        range.setEnd(to.firstChild, 3);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return app.textLinks.label();
      })()`), null);
    });

    test('an answer for a string the field no longer holds is dropped', async () => {
      const id = await addCard('read the roadmap before Friday');
      await selectWord(id, 'roadmap');
      await offered();

      // The capture is taken here rather than through the control, because what
      // is under test is an answer arriving late — somebody else's edit landing
      // between the question and its answer.
      assert.equal(await page.eval(`(() => {
        const chosen = app.textLinks.capture();
        app.store.apply([{ t: 'set', id: '${id}', patch: { text: 'somebody else wrote this' } }]);
        return chosen.insert('https://plan.test/q');
      })()`), false);

      assert.equal(await text(id), 'somebody else wrote this');
    });
  });
});
