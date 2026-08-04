/**
 * The floating toolbar and the two view shortcuts that belong with it.
 * Buttons declare their intent in the markup; this only maps intent to command.
 */
export function createToolbar({ window, elements, store, viewport, commands }) {
  const { toolbar, zoomLabel } = elements;
  const listeners = [];
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  };

  const actions = {
    undo: () => store.undo(),
    redo: () => store.redo(),
    fit: () => commands.fit(),
    reset: () => commands.resetZoom(),
  };

  listen(toolbar, 'click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.add) commands.addAtCenter(button.dataset.add);
    else actions[button.dataset.act]?.();
  });

  listen(window, 'keydown', (e) => {
    if (e.target.isContentEditable) return;
    // "!" and ")" are shift+1 / shift+0 on a US layout; the code covers the rest
    if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) commands.fit();
    else if (e.key === ')' || (e.shiftKey && e.code === 'Digit0')) commands.resetZoom();
  });

  const showZoom = () => {
    zoomLabel.textContent = `${Math.round(viewport.scale * 100)}%`;
  };
  listeners.push(viewport.on(showZoom));
  showZoom();

  return {
    destroy() {
      for (const off of listeners) off();
      listeners.length = 0;
    },
  };
}
