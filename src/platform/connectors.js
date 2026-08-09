/**
 * The arrows, drawn.
 *
 * One SVG element inside the world layer, holding a group per connector. SVG
 * because a line with an arrowhead is what it is for, and because a stroke can
 * be made a target without being visible — which is what lets a two-pixel line
 * be clicked by a person aiming a mouse at it.
 *
 * It sits at the *front of the layer's children*, so every object is painted
 * over it: an arrow is a relation between two cards and belongs behind them,
 * and the alternative — lines over the text they join — is what makes a diagram
 * unreadable.
 *
 * Everything is drawn in world coordinates, inside the transform the layer
 * already carries, so a pan and a zoom cost nothing here. That also settles how
 * thick a line is: in world units, scaling with the board, because a connector
 * is *content* and not an affordance — the README's line, and the same reason a
 * card's text scales while its selection ring does not.
 *
 * **The element is moved and sized to hold what it draws.** A board has no
 * bounds and its coordinates go negative, so the obvious shape — an element of
 * no size with `overflow: visible` — is what this started as, and Chrome lays
 * that out and hit-tests it and paints none of it. So the box is computed from
 * the lines themselves each time, with a `viewBox` that keeps the coordinates
 * inside it world coordinates, and the question does not arise.
 */

import { connectorGeometry, isConnector, labelPoint } from '../core/connectors.js';
import { bbox } from '../core/geometry.js';

const SVG = 'http://www.w3.org/2000/svg';

export function createConnectorLayer({ document, elements, store, selection, found, views }) {
  const { layer } = elements;

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'connectors');

  /**
   * Appended, and put behind everything by the stylesheet rather than by where
   * it sits among the children.
   *
   * The renderer keeps the layer's child order equal to the z-order of the
   * objects *it* draws, and it does that by inserting each one before the
   * previous one's next sibling — so anything parked at the front is pushed to
   * the back of the list on the next sync, and a connector that was meant to be
   * under the cards ends up painted over them. Depth that another component
   * reorders is not depth; `z-index` on the element says it once.
   */
  layer.appendChild(svg);

  /**
   * And a box for the labels, which cannot be SVG.
   *
   * A label is edited, and editing means a `contenteditable` — the caret, IME
   * and selection the browser gives an HTML element and does not give an SVG
   * `<text>`. So the words are HTML positioned in world coordinates over the
   * line, in a container of their own: appended after the SVG, so a label is
   * painted over the arrow it belongs to rather than under it.
   */
  const labels = document.createElement('div');
  labels.className = 'connector-labels';
  layer.appendChild(labels);

  /** id → the group, the three shapes in it, and the label over it. */
  const nodes = new Map();

  const shape = (name, className) => {
    const el = document.createElementNS(SVG, name);
    el.setAttribute('class', className);
    return el;
  };

  const nodeFor = (id) => {
    const existing = nodes.get(id);
    if (existing) return existing;

    const group = document.createElementNS(SVG, 'g');
    group.dataset.id = id;
    group.dataset.type = 'connector';

    /**
     * The hit shape first, so it is under the two that are seen — and wide,
     * because the line it stands for is two units thick and nobody can point at
     * that. It is a stroke with no colour rather than a shape with none:
     * `pointer-events: stroke` in the stylesheet is what makes an invisible
     * stroke a target.
     */
    const hit = shape('line', 'connector-hit');
    const line = shape('line', 'connector-line');
    const head = shape('polygon', 'connector-head');

    group.append(hit, line, head);
    svg.appendChild(group);

    /**
     * The label, made whether or not there is one to show.
     *
     * An empty one is invisible and takes no press — see the stylesheet — but
     * it is in the document, because focusing it is how a label is *started*
     * and nothing can be focused that was never rendered. Until somebody types
     * in it, the connector carries no `text` and no op has been written.
     *
     * `data-id` and `data-field` are the same two attributes a card's text
     * carries, so the input layer edits this with the code it already has:
     * one op per keystroke, one undo entry per session, paste forced to plain
     * text, and the source of a link shown while it is being edited.
     */
    const label = document.createElement('div');
    label.className = 'connector-label';
    label.dataset.id = id;
    label.dataset.type = 'connector';
    label.dataset.label = '';

    const text = document.createElement('div');
    text.className = 'connector-text';
    text.contentEditable = 'true';
    text.dataset.field = 'text';
    label.appendChild(text);
    labels.appendChild(label);

    const node = { group, hit, line, head, label, text };
    nodes.set(id, node);
    return node;
  };

  const place = (node, drawn) => {
    for (const el of [node.hit, node.line]) {
      el.setAttribute('x1', drawn.line.x1);
      el.setAttribute('y1', drawn.line.y1);
      el.setAttribute('x2', drawn.line.x2);
      el.setAttribute('y2', drawn.line.y2);
    }
    node.head.setAttribute('points', drawn.head.map(([x, y]) => `${x},${y}`).join(' '));
  };

  /**
   * Draw every connector the sheet holds, from wherever its ends are now.
   *
   * All of them on every change rather than only the ones that moved. A
   * connector's geometry is a fact about two *other* objects, so "what changed"
   * is the wrong question — a card moving redraws arrows whose own record has
   * not been touched — and the work is a little arithmetic and six attributes
   * on a handful of elements.
   */
  function sync() {
    const drawn = new Set();
    const points = [];

    for (const id of store.order) {
      const obj = store.get(id);
      if (!isConnector(obj)) continue;

      const node = nodeFor(id);
      drawn.add(id);

      // An end that has gone answers null, like two that overlap do — see
      // `connectorGeometry`, which is where that judgement lives.
      const line = connectorGeometry(store.get(obj.from), store.get(obj.to));
      if (line) {
        points.push(
          { x: line.line.x1, y: line.line.y1, w: 0, h: 0 },
          { x: line.line.x2, y: line.line.y2, w: 0, h: 0 },
          ...line.head.map(([x, y]) => ({ x, y, w: 0, h: 0 })),
        );
      }

      /**
       * Hidden rather than removed when there is nothing to draw: an end that
       * has gone (deleted by somebody else a moment before the op that takes
       * this with it) and two objects overlapping each other are both states
       * that end, and the connector is still in the document throughout.
       */
      node.group.style.display = line ? '' : 'none';
      node.label.style.display = line ? '' : 'none';
      if (line) {
        place(node, line);

        const at = labelPoint(line);
        node.label.style.left = `${at.x}px`;
        node.label.style.top = `${at.y}px`;
        // Through the views' own `setText`, which refuses to touch a field
        // somebody is typing in and turns a URL into a link on the way out.
        views.setText(node.text, obj.text ?? '');
      }
    }

    for (const [id, node] of nodes) {
      if (drawn.has(id)) continue;
      node.group.remove();
      node.label.remove();
      nodes.delete(id);
    }

    frame(bbox(points));
    applySelection();
  }

  /**
   * Put the element where its lines are, at the size they need.
   *
   * The `viewBox` is the same rectangle, so what the shapes carry stays world
   * coordinates and nothing has to be translated as the box moves. The margin
   * is for the stroke: a line is drawn from the centre of its path outwards,
   * and the invisible one that can be pointed at is sixteen units wide — a
   * viewport that stopped at the geometry would clip half of it away, and clip
   * it out of the hit test with it.
   */
  function frame(box) {
    if (!box) {
      svg.setAttribute('width', 0);
      svg.setAttribute('height', 0);
      return;
    }

    const margin = 12;
    const x = box.x - margin;
    const y = box.y - margin;
    const w = box.w + margin * 2;
    const h = box.h + margin * 2;

    svg.style.left = `${x}px`;
    svg.style.top = `${y}px`;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }

  function applySelection() {
    for (const [id, node] of nodes) {
      const on = selection.has(id);
      const hit = Boolean(found?.has(id));
      node.group.classList.toggle('selected', on);
      node.label.classList.toggle('selected', on);
      // An arrow a search turned up: the words on it are what matched, so the
      // ring goes round the words.
      node.label.classList.toggle('found', hit);
    }
  }

  sync();

  return {
    sync,
    applySelection,
    elementFor: (id) => nodes.get(id)?.group,
    destroy() {
      svg.remove();
      labels.remove();
      nodes.clear();
    },
  };
}
