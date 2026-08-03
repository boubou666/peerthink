/**
 * Per-type DOM.
 *
 * Objects are real elements inside the transformed world layer, so text
 * editing, IME, selection and styling come from the browser rather than from
 * us. `document` is injected so the view layer has no ambient dependency on a
 * global window.
 *
 * Rule for every `update`: never write to the field the user is focused on.
 */
export function createViews({ document }) {
  const element = (html) => {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  };

  const setText = (el, value) => {
    if (document.activeElement !== el && el.innerText !== value) el.innerText = value ?? '';
  };

  const itemRow = (item) => {
    const row = element(`<div class="list-item">
      <div class="li-check"></div>
      <div class="li-text" contenteditable="true" data-field="item"></div>
    </div>`);
    row.dataset.itemId = item.id;
    row.classList.toggle('done', !!item.done);
    row.querySelector('[data-field="item"]').innerText = item.text ?? '';
    return row;
  };

  return {
    card: {
      create: () => element(`<div class="obj card">
        <div class="card-text" contenteditable="true" data-field="text"></div>
      </div>`),
      update(el, obj) {
        el.dataset.color = obj.color ?? 'yellow';
        setText(el.querySelector('[data-field="text"]'), obj.text);
      },
    },

    envelope: {
      create: () => element(`<div class="obj envelope">
        <div class="envelope-title" contenteditable="true" data-field="title"></div>
      </div>`),
      update(el, obj) {
        setText(el.querySelector('[data-field="title"]'), obj.title);
      },
    },

    list: {
      create: () => element(`<div class="obj list">
        <div class="list-title" contenteditable="true" data-field="title"></div>
        <div class="list-items"></div>
        <button class="list-add" type="button">+ item</button>
      </div>`),
      update(el, obj) {
        setText(el.querySelector('[data-field="title"]'), obj.title);

        const box = el.querySelector('.list-items');
        const items = obj.items ?? [];
        const key = items.map((i) => i.id).join(',');

        // rebuild only when the set of rows changed; otherwise patch in place
        // so the caret and scroll position survive a keystroke
        if (box.dataset.key !== key) {
          box.textContent = '';
          for (const item of items) box.appendChild(itemRow(item));
          box.dataset.key = key;
          return;
        }
        for (const item of items) {
          const row = box.querySelector(`[data-item-id="${item.id}"]`);
          if (!row) continue;
          row.classList.toggle('done', !!item.done);
          setText(row.querySelector('[data-field="item"]'), item.text);
        }
      },
    },
  };
}
