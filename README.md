# PeerThink

An infinite-canvas visual workspace — cards, envelopes and lists on a pannable,
zoomable board — with a React shell around a deliberately framework-free canvas.

```sh
npm ci
npm run dev      # → http://localhost:5173
npm test         # node:test + a real browser, line-coverage gate at 95%
npm run build    # → dist/
npm start        # serve the built site
```

---

## What it does

| | |
|---|---|
| **Boards** | Many per workspace — listed, renamed, deleted; the board id lives in the URL |
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
src/main.jsx        bootstrap — the only file that knows it is in a browser
  └── App.jsx       routes: / (board list) and /b/:boardId
        ├── routes/, components/   the React shell
        │     └── BoardCanvas.jsx  mounts the canvas once, via refs
        └── app.js  composition root — builds the object graph, wires commands
              ├── core/       the domain. No DOM, no window, no clock, no React.
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

### React renders the shell, not the canvas

Pan, zoom and drag fire at frame rate. Putting board objects into React state
would mean reconciling hundreds of components per pointer move, so the canvas
stays imperative and React renders it exactly once:

```jsx
useEffect(() => {
  const app = createApp({ document, window, boardId, repository, elements: { …refs } });
  return () => app.destroy();
}, [boardId]);
```

That works because `createApp` takes its elements as an argument. Handing it
refs is the entire integration between the framework and the canvas, and
`destroy()` — which unwinds listeners, observers and elements — is the cleanup.

### Everything is injected

Nothing below the composition root reaches for a global. The `document`, the
`window`, the storage backend, the scheduler, the clock, the id generator and
the `ResizeObserver` all arrive as arguments. The practical consequences:

- two independent boards can be composed on one page, each with its own DOM
  subtree and state — [`test/browser/app.test.js`](test/browser/app.test.js) does exactly that;
- the persistence backend is one argument, so the Web Storage implementation
  swaps for an HTTP or WebSocket one without touching the core;
- timing is a `Scheduler`, so debounce and frame behaviour are driven by hand
  in tests instead of by `setTimeout` and luck.

### Why an op log

Every mutation goes through `store.apply(ops)` and returns its own inverse:

```js
store.apply([{ t: 'set', id: 'a3f', patch: { x: 120, y: 40 } }])
```

One representation gives undo/redo, the autosave payload, and — the point of
the exercise — the wire format a sync layer would broadcast. Adding
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

- **`test/node/`** — the core, the repository and the server, run directly
  under `node:test`. No DOM, no browser, no fakes beyond the injected seams.
- **`test/browser/`** — the React shell and the DOM layers, driven through the
  raw Chrome DevTools Protocol over Node's built-in `WebSocket`. Real pointer
  events, real `contenteditable`, real layout. No Playwright, no Puppeteer, no
  jsdom.

`test/run.js` starts Vite and Chromium, runs every file, then merges the V8
coverage from Node and from the browser into a single line-coverage report and
fails the run under the threshold.

The browser suite runs against Vite's **dev server**, not a bundle: unbundled
modules are served at their source paths, so coverage attributes to
`src/core/board.js` rather than one minified chunk. CI builds the production
artifact separately, so the shipped output is still verified.

Tests need a Chromium. CI uses the runner's preinstalled Chrome; locally it
finds a system or Playwright-cached build, or point at one:

```sh
CHROME_PATH=/path/to/chrome npm test
```

---

## Dependencies

`core/` and the canvas have none — they are plain ES modules that would run
unchanged without a framework. The additions are the shell and its tooling:

| | |
|---|---|
| `react`, `react-dom` | the shell |
| `react-router` | routing — v8 |
| `vite`, `@vitejs/plugin-react` | dev server and build (dev only) |

Routing is `react-router` v8 rather than v7's `react-router-dom` mostly because
v8 is where the package is going. On the security side the only relevant item is
[GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2), a CSRF
issue in the **unstable RSC APIs** — `unstable_RSCPayload` and the RSC request
handlers. It affects `>=7.12.0 <7.18.2` and `>=8.0.0 <8.3.0`; both lines are
patched, at `7.18.2` and `8.3.0`. This app is a client-only SPA and never touches
those APIs, and the `^8.3.0` pin is on the patched side regardless.

CI fails on any high-severity production advisory.

## Not built yet

Real-time collaboration, presence cursors, share links, auth, export. The seams
are in place — `BoardRepository` for persistence, the op log for transport —
but none of it is written.

The toolbar is still imperative rather than a React component; converting it
needs `useSyncExternalStore` over the store and viewport.

Routing is hash-based (`/#/b/:id`) because GitHub Pages has no SPA rewrite.
Moving to a host that can serve `index.html` for any path makes that a one-line
change to `BrowserRouter`.

## Licence

MIT
