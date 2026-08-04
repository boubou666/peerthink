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
| **Together** | With a project configured: share a board by link, live edits, and other people's cursors |

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
                  ├── storage.js     BoardRepository over Web Storage
                  ├── supabase-repository.js  the same contract over Postgres
                  ├── sync.js        the op log, on a private channel
                  ├── cursors.js     other people's pointers
                  ├── sharing.js     invite links and who holds them
                  ├── auth.js        accounts, as { id, email, guest }
                  └── supabase.js    the client, and whether there is one
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
  and the Postgres one are the same code path to everything above them — which
  is what made adding the second a new file rather than an edit to the first;
- timing is a `Scheduler`, so debounce and frame behaviour are driven by hand
  in tests instead of by `setTimeout` and luck.

### Why an op log

Every mutation goes through `store.apply(ops)` and returns its own inverse:

```js
store.apply([{ t: 'set', id: 'a3f', patch: { x: 120, y: 40 } }])
```

One representation gives undo/redo, the autosave payload, and — the point of
the exercise — the wire format. `platform/sync.js` takes that literally: what a
client applies locally is exactly what it sends, and what it receives goes
through the same `apply()` the local UI uses. There is no second representation
of a change, so there is no second implementation to keep honest.

Ops carry an origin. A remote one is applied with `record: false`, which keeps
somebody else's edit out of your undo stack, and marked `REMOTE`, which is what
stops it being sent straight back out.

Ops keep the live documents identical; the *row* is written by whole-document
save, so several editors autosaving one is several editors overwriting each
other. Exactly one of them writes it — the earliest joiner, elected from
presence, which every client computes from the same state and agrees on without
anyone deciding — and the rest hold their peace. Election cannot see the case
that matters most, though: a client that has lost the channel elects itself and
carries on saving a document that has fallen behind. So a save also carries the
version it is replacing, and the update matches nothing if that version has
moved on. The counter belongs to `doc` alone, so a rename is not a competing
edit and does not refuse the next honest save.

Cursors go the other way. They are broadcast, not presence updates — presence
diffs a set and fans the whole thing out on every change, which is the right
shape for a list of people and the wrong shape for something that moves at
pointer rate. Presence still says who is *here*, and carries their name, so a
position does not have to repeat it hundreds of times a minute. Positions are
in world coordinates, so a cursor points at the thing its owner is pointing at
rather than at a place on their screen.

The one thing an absolute op could not survive was replication. `{ t: 'order' }`
names the whole z-order, and a sender cannot name an object they have not
received yet — taking their array literally would drop a concurrent addition out
of the document entirely. So an incoming order decides the relative depth of
everything it mentions, and anything it does not mention keeps the depth it has
here. There is no operational transform beyond that: two people dragging the
same object settle on whoever's message landed last.

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

### Accounts

The app decides once, at load, whether there is a backend behind it. Given
both of

```sh
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

it signs every visitor in — anonymously on a first visit, which is a real row
in `auth.users` and so a real subject for the row level security policies — and
keeps the boards in Postgres. With either variable missing it runs on Web
Storage with no accounts at all, which is what the published GitHub Pages site
is and what `npm test` runs against. Registering attaches an email to the guest
who is already signed in, rather than creating a second user beside them, so
the boards come along.

The two repositories satisfy one contract, so nothing above `shell/storage.js`
knows which is in front of it. `list()` is one indexed query rather than a parse
of every stored board, and access is not enforced in the client: a `select` with
no `where` clause is the correct way to ask for "my boards", because the
policies are what answer it.

The suites that need a real stack — accounts, the Postgres repository, and the
live channel — skip without one:

```sh
npx supabase start && npm test
```

`test/run.js` finds it through `supabase status`, serves a second Vite origin
that has been handed the project, and drives the browser suites there. The node
suites talk to it directly, signing in two anonymous users so that one can be
refused what the other is allowed. Skipping is reported rather than silent: the
files only those suites can reach are printed but left out of the coverage
total, with a line saying so — an unreachable file averaged into the number
would quietly lower the bar for every other file. CI starts a stack, so nothing
merges without them.

### Sharing

A board is handed out by **link**, not by naming a person. There is nothing to
name them with: `auth.users` is not readable by `authenticated`, and most people
here are anonymous and have no address. A link needs neither, and the person
following it needs no account beyond the guest session they already have —
which is the same reason anonymous sign-in exists.

One live link per board, and it says what it grants. Changing the role changes
what the outstanding link is worth rather than killing it, because a link
already pasted into a chat should not quietly stop working. Revoking deletes
it; the people who already joined stay, because they are rows in
`board_members` now and the link is not what holds them there.

The token is the whole secret, so it is never derived from the board id and the
invite row is readable only by the owner. Redeeming goes through a
`SECURITY DEFINER` function — the point is to act on a row the caller cannot
see. Every reason a token might not work gives the same answer, so the join
page is not somewhere to test guesses.

Access is handed back the same way it was given. A board someone shared with
you is not yours to delete, so its card offers **Leave** where an owned one
offers Delete — the policy would refuse a delete, and refusing quietly would
look like a board that came back. `list()` carries `owned` so the list knows
which of the two it is looking at; the local repository reports `true` for
everything, because nobody else can reach a browser's own storage. An owner
cannot leave: there is no membership row to hand back, and a board with no
owner is one nobody can share or delete.

### The database

`test/db/` is a third world, kept out of `npm test` because it needs a Postgres
rather than a browser. The row level security policies are the thing that keeps
one person's boards out of another's, and they are not code that can be
reviewed into correctness — they get exercised as the database sees them, every
statement running as `authenticated` with a JWT claim, exactly as PostgREST
issues it.

```sh
npx supabase start                                    # or any Postgres
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npm run db:apply && npm run test:db
```

Against a bare Postgres, pass `--stub` to `db:apply` first: `test/db/stub-auth.sql`
installs the surface the migrations expect — the `auth` schema, `auth.uid()`,
and the `anon` / `authenticated` roles — which a real Supabase database already
has. The suite skips itself when `DATABASE_URL` is unset. CI sets it from the
stack it starts, so these run on every pull request.

---

## Dependencies

`core/` and the canvas have none — they are plain ES modules that would run
unchanged without a framework. The additions are the shell and its tooling:

| | |
|---|---|
| `react`, `react-dom` | the shell |
| `react-router` | routing — v8 |
| `@supabase/supabase-js` | accounts, and the boards backend behind them |
| `vite`, `@vitejs/plugin-react` | dev server and build (dev only) |
| `pg` | connects the RLS tests to a database (dev only) |

Routing is `react-router` v8 rather than v7's `react-router-dom` mostly because
v8 is where the package is going. On the security side the only relevant item is
[GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2), a CSRF
issue in the **unstable RSC APIs** — `unstable_RSCPayload` and the RSC request
handlers. It affects `>=7.12.0 <7.18.2` and `>=8.0.0 <8.3.0`; both lines are
patched, at `7.18.2` and `8.3.0`. This app is a client-only SPA and never touches
those APIs, and the `^8.3.0` pin is on the patched side regardless.

CI fails on any high-severity production advisory.

## Not built yet

Share links and export.

Ops emitted between reading the snapshot and joining the channel are missed —
`hydrate()` subscribes after the load, so a change made in that window shows up
on the next reload rather than immediately.

A refused save is not yet recovered from. The writer keeps its document and
stops persisting until it reads the board again, which is the safe direction —
nothing is overwritten — but a client that has been disconnected long enough
will hold edits it can no longer land.

Boards already in a browser's Web Storage are not adopted when a project is
configured — the account and the browser are separate places, and moving boards
between them is a decision nobody has made yet.

There is no notification that a board has been shared with you; it simply
appears in the list.

The toolbar is still imperative rather than a React component; converting it
needs `useSyncExternalStore` over the store and viewport.

Routing is hash-based (`/#/b/:id`) because GitHub Pages has no SPA rewrite.
Moving to a host that can serve `index.html` for any path makes that a one-line
change to `BrowserRouter`.

## Licence

MIT
