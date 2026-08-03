# PeerThink

An infinite-canvas visual workspace — cards, envelopes and lists on a pannable,
zoomable board — built with **zero runtime dependencies** and **no build step**.

The whole thing is ES modules served straight off disk by a `node:http` server.
No bundler, no framework, no transpiler, no `node_modules`.

```
npm start      # → http://localhost:3000
npm test       # 231 tests, line-coverage gate at 95%
```

---

## What it does

| | |
|---|---|
| **Cards** | Coloured notes with editable text, resizable from eight handles |
| **Envelopes** | Grouping containers — dragging one carries everything fully inside it, transitively |
| **Lists** | Checkable rows; `Enter` splits, `Backspace` on an empty row merges up |
| **Canvas** | Infinite pan/zoom, alignment snapping with guides, marquee select, single-step undo for every gesture |

### Gestures

| | |
|---|---|
| Pan | Space-drag, middle-drag, right-drag, or plain wheel |
| Zoom | `⌘/Ctrl` + wheel, or trackpad pinch |
| Select | Click, `Shift`-click, or drag a marquee on empty canvas |
| Edit | Double-click any text |
| Create | `C` / `E` / `L`, the toolbar, or double-click empty canvas |
| Snapping | On by default; hold `Alt` to disable |
| Undo / redo | `⌘/Ctrl+Z`, `⌘/Ctrl+Shift+Z` |
| Fit / reset zoom | `Shift+1` / `Shift+0` |

---

## Architecture

Three layers, and dependencies only ever point inward.

```
main.js          bootstrap — the only file that knows it is in a browser
  └── app.js     composition root — builds the object graph, wires the commands
        ├── core/       the domain. No DOM, no window, no clock.
        │   ├── store.js       document as an op log (add / del / set / order)
        │   ├── board.js       cards, envelopes, lists, z-order, snapping
        │   ├── selection.js   what is selected
        │   ├── viewport.js    the camera
        │   ├── autosave.js    persistence policy
        │   ├── scheduler.js   timing, behind an interface
        │   ├── geometry.js    rectangle maths
        │   ├── ids.js         id generation
        │   └── seed.js        the starter board
        └── platform/   the browser. Adapters, nothing else.
            ├── renderer.js    reconciles the store into the DOM
            ├── input.js       pointer and keyboard gestures
            ├── views.js       per-type markup
            ├── toolbar.js     buttons and view shortcuts
            └── storage.js     BoardRepository over Web Storage
```

**Everything is injected.** `createApp()` takes the `document`, the `window`,
the storage backend, the scheduler, the id generator and the `ResizeObserver`
as arguments. Nothing below the composition root reaches for a global. The
practical consequences:

- two independent boards can be composed on one page, each with its own DOM
  subtree and its own state — [`test/browser/app.test.js`](test/browser/app.test.js) does exactly that;
- the persistence backend is one argument (`repository`), so the localStorage
  implementation swaps for an HTTP or WebSocket one without touching the core;
- timing is a `Scheduler` object, so debounce and frame behaviour are driven by
  hand in tests instead of by `setTimeout` and luck;
- `destroy()` genuinely tears an instance down — listeners, observers, elements.

### Why an op log

Every mutation goes through `store.apply(ops)` and returns its own inverse:

```js
store.apply([{ t: 'set', id: 'a3f', patch: { x: 120, y: 40 } }])
```

That single representation gives undo/redo, the autosave payload, and — the
point of the exercise — the wire format a sync layer would broadcast. Adding
collaboration means reimplementing `apply`, and nothing above it changes.

### Rendering

Objects are real DOM elements inside a transformed layer, not canvas pixels, so
text editing, IME, selection and accessibility come from the browser. Pan and
zoom write one `transform`, so they never walk the object list; the per-object
work is viewport culling. Geometry inside an object (padding, radius, font) is
in world units and scales with the canvas, while affordances (selection ring,
handles, hairlines) are counter-scaled by a `--z` custom property so they stay
constant on screen at any zoom.

---

## Tests

Two worlds, one number.

- **`test/node/`** — the core, the repository and the server, run directly under
  `node:test`. No DOM, no browser, no fakes beyond the injected seams.
- **`test/browser/`** — the DOM layers, driven through the real Chrome DevTools
  Protocol over Node's built-in `WebSocket`. Real pointer events, real
  contenteditable, real layout. No Playwright, no Puppeteer, no jsdom.

`test/run.js` starts both, runs every file, then merges the V8 coverage from
Node and from Chromium into a single line-coverage report and fails the run
under the threshold.

```
public/js/app.js                    97/97   100.0%
public/js/core/board.js           171/171   100.0%
public/js/platform/input.js       404/404   100.0%
...
TOTAL                           1306/1309    99.8%
```

The three uncovered lines are a defence-in-depth path-traversal guard in the
server that URL parsing makes unreachable — the guard itself is unit-tested
directly.

Tests need a Chromium. CI uses the runner's preinstalled Chrome; locally it
finds a system or Playwright-cached build, or you can point at one:

```
CHROME_PATH=/path/to/chrome npm test
```

---

## Not built yet

Real-time collaboration, presence cursors, share links, export. The seams are
in place — `BoardRepository` for persistence and the op log for transport — but
none of it is written.

## Licence

MIT
