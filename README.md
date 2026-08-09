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
| **Cards** | Notes with editable text, resizable from eight handles — and formattable: any background and text colour (transparent included), font, size and alignment |
| **Envelopes** | Grouping containers — dragging one carries everything fully inside it, transitively |
| **Lists** | Checkable rows; `Enter` splits, `Backspace` on an empty row merges up |
| **Images** | Paste a picture from anywhere and it becomes an object on the sheet, carried by the document itself |
| **Corners** | Cards, envelopes, lists and images are rounded or square, per object |
| **Canvas** | Infinite pan/zoom, alignment snapping with guides, marquee select, single-step undo for every gesture |
| **Clipboard** | Copy and paste the selection — between sheets, between boards, between windows |
| **Links** | A URL in any text is clickable; hover it for a second and a panel says what is there, or that it could not be reached |
| **Saving** | The bar says whether your work is stored — a refused write retries itself, and closing the tab flushes what the debounce is still holding |
| **Export** | The board as a PNG — the selection if there is one, everything otherwise |
| **Together** | With a project configured: share a board by link, live edits, and other people's cursors |

### Gestures

| | |
|---|---|
| Pan | Space-drag, middle-drag, right-drag, or plain wheel |
| Zoom | `⌘/Ctrl` + wheel, or trackpad pinch |
| Select | Click, `Shift`-click, or drag a marquee on empty canvas |
| Edit | Double-click any text |
| Create | `C` / `E` / `L`, the toolbar, or double-click empty canvas |
| Format | Select something; a bar appears above it — for cards, colour pickers for background and text, a no-background toggle, font, size and alignment; for anything, rounded or square corners |
| Copy / paste | `⌘/Ctrl+C`, `⌘/Ctrl+V` — and `⌘/Ctrl+V` for an image on the clipboard, which lands as an object |
| Links | Click one to open it in a new tab; hover one second for a preview. While a card is being edited, a click is the caret's |
| Snapping | On by default; hold `Alt` to disable |
| Undo / redo | `⌘/Ctrl+Z`, `⌘/Ctrl+Shift+Z` |
| Fit / reset zoom | `Shift+1` / `Shift+0` |

---

## Architecture

Three layers, and dependencies only ever point inward.

```
src/main.jsx        bootstrap — the only file that knows it is in a browser
  └── App.jsx       routes: / and /o/:orgId (board lists) and /b/:boardId
        ├── routes/, components/   the React shell
        │     └── BoardCanvas.jsx  mounts the canvas once, via refs
        └── app.js  composition root — builds the object graph, wires commands
              ├── core/       the domain. No DOM, no window, no clock, no React.
              │   ├── store.js       document as an op log (add / del / set / order)
              │   ├── board.js       cards, envelopes, lists, images, z-order, snapping
              │   ├── selection.js   what is selected
              │   ├── viewport.js    the camera
              │   ├── autosave.js    persistence policy, and its retries
              │   ├── save-status.js whether the work is stored, subscribably
              │   ├── export.js      what a picture covers, and how big it is
              │   ├── scheduler.js   timing, behind an interface
              │   ├── geometry.js    rectangle maths
              │   ├── ids.js         id generation
              │   ├── card-style.js  how a card looks, as tokens
              │   ├── corners.js     rounded or square, for every type
              │   ├── clipboard.js   what copied objects look like as text
              │   ├── image.js       what a picture may be, and how big
              │   ├── links.js       finding a URL in prose, and which to follow
              │   ├── bar-position.js where the format bar and the popover sit
              │   └── seed.js        the starter board
              └── platform/   the browser. Adapters, nothing else.
                  ├── renderer.js    reconciles the store into the DOM
                  ├── input.js       pointer and keyboard gestures
                  ├── clipboard.js   copy and paste, on the system clipboard
                  ├── images.js      a pasted file, made into something storable
                  ├── links.js       the hover popover, drawn in the overlay
                  ├── link-preview.js  asking the server what is at a link
                  ├── views.js       per-type markup
                  ├── export-png.js  the same objects, drawn to a canvas
                  ├── storage.js     BoardRepository over Web Storage
                  ├── supabase-repository.js  the same contract over Postgres
                  ├── lifecycle.js   the last write before the tab goes
                  ├── sync.js        the op log, on a private channel
                  ├── cursors.js     other people's pointers
                  ├── sharing.js     invite links and who holds them
                  ├── organizations.js  teams, and the boards they hold
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

The line is drawn at frame rate, not at the edge of the canvas. The toolbar is
a React component (`components/Toolbar.jsx`) reading the store and the viewport
through `useSyncExternalStore`, because it *shows state* — a zoom percentage,
and whether there is history to walk — and changes only when that state does.
The stage underneath stays imperative because it redraws on every pointer move.

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

### The clipboard, and pictures on it

Copy and paste go through the `copy` and `paste` events rather than
`navigator.clipboard`. That is not a style preference: reading the clipboard
asynchronously needs a permission the browser prompts for, and a prompt in the
middle of ⌘V is not paste. The event hands the data over with no permission at
all, because the keystroke *is* the consent — and it is the only route by which
an image on the clipboard arrives as a file rather than as nothing.

The listeners are on `document`, for the reason the board's shortcuts are on
`window`: a canvas is a place where the thing you are acting on is selected
rather than focused, so there is no element to hang them on. That means they
hear the app's own chrome too, and `isTyping` is what keeps a copy inside the
board title from copying the board instead.

A copied selection travels as **`text/plain`**, holding a JSON envelope with a
marker in it. The cost is visible and accepted — paste three cards into a text
editor and you get JSON. The alternative is a custom clipboard type, which
pastes into a text editor as nothing at all and is not carried between browsers
or reliably between tabs; text is what makes a card copied on one board appear
on another. Anything that is not ours is left to the browser rather than
swallowed, so pasting a paragraph from a web page onto a board does nothing.

A paste lands **under the pointer** when the pointer is over the board, and in
the middle of the view when it is not. That is what makes pasting twice into two
places one gesture rather than two, and the pointer is the only thing the person
can be said to have pointed at. Everything else follows the rules the board
already has: new ids, because the same object cannot be in a document twice; an
envelope brings what it holds, exactly as dragging one does; pasted envelopes go
to the back, exactly as a new one does; and the whole paste is one entry in the
undo stack, because it is one thing that happened.

An image is an object like any other — `{ type: 'image', x, y, w, h, src }` —
and `src` is the picture itself as a data URL rather than a link to one. The
board is a document that is stored whole, broadcast to the other people on it and
drawn to a PNG: three places a link would have to still resolve, from whatever
network the reader happens to be on. Carrying the bytes means an image that is on
the board is on the board.

The bytes being in the document is also what makes the import a *policy* rather
than a formality, in `core/image.js` and `platform/images.js`:

- **A source is a base64 data URL of a raster type, or it is not drawn.** An
  object arrives over the board's channel from anyone authorised to edit it and
  goes into an `img`. A remote URL in there is a request this browser makes to a
  host of somebody else's choosing, which reports the reader's address to it;
  `svg+xml` is a document rather than a bitmap. The same rule the style tokens
  follow: fall back to nothing rather than pass it through. The attribute is
  *removed* rather than emptied, because `src=""` is a request for the page.
- **Bytes already small enough are kept exactly as they came.** A screenshot
  pasted straight from the clipboard is crisp, lossless and usually small, and
  re-encoding it would store a lossy copy of itself for no benefit.
- **Anything larger is redrawn through a canvas and encoded as WebP**, at most
  1200 pixels on its long side, retried smaller until it fits the budget and
  refused out loud if it never does. A canvas also normalises what it draws: a
  type this app does not render becomes one it does, and the camera position a
  photograph was taken at is left behind, because a canvas has no metadata to
  give it.

The budget — around 180KB of image — is set by the *channel*, not the disk. Ops
are broadcast, and an `add` carrying a whole picture is the only op that can
reach a payload limit. Under it, pasting an image is a live edit like every
other; over it, the send fails and the picture reaches the other people on the
board on their next load instead. The failure is soft, which is exactly why it is
worth spending some quality to stay under it.

### Links, and why the preview cannot happen here

A URL in any of a board's text is clickable, and hovering one for a second opens
a panel with the page's title, its description, a thumbnail and the host it
actually came from. A page that answered anything but a 2xx reads as unreachable
— and the panel says which status it answered, because a 404 and a silence are
different things to the person deciding what to do next.

The document stores plain text and the *view* does the recognising: the store
holds a string, which is what a paste is forced into and what `innerText` reads
back, so nothing marks a link up, a link is whatever *looks* like one, and
`core/links.js` is a recogniser rather than a parser. It runs on the way
out, in the view; the document keeps the characters the person typed. An explicit
scheme or a `www.` counts, and a bare domain deliberately does not — `readme.md`,
`e.g.something` and `3.14` would all turn blue, and a link nobody asked for is
worse than one they have to type six characters for.

**The preview is fetched by an edge function, because a browser is not allowed to
know the answer.** A cross-origin `fetch` in `cors` mode only succeeds when the
target sends an `Access-Control-Allow-Origin` naming the caller — which an
arbitrary page has no reason to do, so the promise rejects and the real status
never arrives. `no-cors` mode resolves instead, with an opaque response whose
status is `0` and whose body cannot be read, identically for a 200 and a 404.
"Did it answer 2xx, and what is on it" is not a thing one origin may learn about
another, so `supabase/functions/link-preview` does the fetch and the client asks
it. That
makes previews part of the same load-time decision as sharing, live edits and
cursors: with no project configured there is nobody to ask, and a hovered link
says so rather than sitting on "loading" or blaming the page.

The function is invoked through the Supabase client, so the request carries the
user's session and `verify_jwt` checks it — this is a preview for people signed
in to this app, not an open proxy for anybody who finds the URL. It is written in
plain JavaScript, like everything else here, which is what lets its two halves
that hold all the judgement — `guard.js` and `extract.js` — be imported directly
by `node --test`. The Deno entrypoint is the only part a test cannot reach.

#### Nothing that comes back is executed

Five separate rules, each with a test:

- **The panel is built from nodes, never markup.** A page's `<title>` is
  somebody else's text and the popover is our document, so `textContent` puts it
  in. A title of `<img src=x onerror=…>` is drawn as those characters.
- **The scheme is allow-listed to http and https**, when the anchor is built and
  again when it is opened. `javascript:` in a card would run in this origin with
  this session, so it never becomes a link — and an href tampered with in the DOM
  is still not opened, which is the only reason the second check exists.
- **The target page is never rendered.** No iframe and no headless browser: what
  crosses the wire is extracted text and one bitmap. A thumbnail is inlined by the
  function as a data URL and checked by `isImageSource`, the same guard a pasted
  image goes through — which is also what stops the browser making a request of
  its own to the site being previewed.
- **The function evaluates nothing it fetched.** No parser, no `eval`, no
  `new Function`, no dynamic import. The head is matched for meta tags with string
  work, and the worst case is a panel with no title in it.
- **Anchors carry `rel="noopener noreferrer"`**, so a page opened from a board
  cannot reach back through `window.opener`.

#### What the function is allowed to fetch

A function that fetches a URL from a card makes requests from inside the
provider's network on someone else's behalf, which is the whole of server-side
request forgery. "It is only our own users" is not a defence — it is the
description of the attack. So `guard.js` refuses:

- **every scheme but http and https**, and any URL carrying credentials
  (`https://docs.example.com@evil.test/` reads as the first host and is the
  second);
- **every address that is not on the internet** — loopback, the private ranges,
  carrier-grade NAT, link-local (which is where a cloud instance keeps its
  credentials), multicast and everything reserved above it, in both families and
  through IPv4-mapped and NAT64 spellings. The URL parser normalises
  `http://2130706433/` to `127.0.0.1` before any of this, which is load-bearing
  and invisible, so a test pins it;
- **names only a private network resolves** — `localhost`, `.local`,
  `.internal`, `.home.arpa`, and any single-label name, since public hostnames
  have a dot;
- **anything a name resolves to that the above would have refused**, which is the
  form the attack actually takes: `internal.example.com` as an A record for
  `10.0.0.5`;
- **and each redirect separately.** Following them by hand is the point —
  `redirect: 'follow'` would let a public URL hop into the private network with
  nothing looking at it.

A refusal answers exactly what a silence answers: `{ ok: false, status: 0 }`. Any
difference between "not allowed" and "did not reply" would make this a scanner
for the network it runs inside, reporting which internal addresses exist a few
hundred times a second. The reason goes to the log and nowhere else.

Requests are capped at six seconds, 256KB of page and 120KB of thumbnail, and
three redirects.

#### The popover is drawn in the overlay

Imperatively, with the cursors and the guides, rather than as a React component.
That is the line this app already draws: React renders chrome that *shows state*
— the toolbar, the format bar — and transient pointer-driven chrome lives in the
overlay. A panel that follows a pointer around a canvas is the second kind, and
being outside React is also what lets the whole thing be driven in tests with a
scheduler run by hand and a stubbed fetcher.

Answers are cached per href, so re-hovering costs nothing and one link asked
about twice is one invocation. A failure of *ours* — the function down, the
network gone — is not cached and says "no preview" rather than "unreachable",
because blaming the page for our own outage is a lie the person cannot act on.

### Corners

`corners: 'round' | 'square'` is a token on the object, and the radius itself
stays in `canvas.css` — the same split colour already uses. A card carrying
`corners: 8` would be a card to find and rewrite the day the radius changes, and
one carrying `corners: 400` is a card nobody meant to make. The stylesheet needs
one rule for it, because round is what every object has always been and remains
the default: an object with no `corners` field renders exactly as it did before
any of this existed.

It lives in its own module rather than in `card-style.js`, which is about what a
*card* looks like and means nothing for an envelope. That is what lets the format
bar offer the control to a selection with no cards in it — an envelope selected
on its own gets a bar with that one control on it, where before it got no bar at
all. Each control is offered to whatever it means something for, and to nothing
else.

### Saying whether it saved

Autosave knew all of this already and told nobody. A write that was refused
left the document marked dirty behind a board bar that looked exactly like a
saved one; a board that failed to load left a canvas that took edits all
afternoon and had nowhere to put them. The states are the ones a person can act
on — `saved`, `pending`, `saving`, `failed`, `unloaded` — and the bar shows the
last two in the same red as an error banner, with the retry beside them.

Three things had to become true for the bar to be honest:

- **Nothing is marked saved by a write it was not in.** Every change bumps a
  counter, and a write remembers which version it carried; an edit made while
  that write is in flight leaves the board dirty when it lands, and schedules
  the follow-up itself.
- **A failure is retried on a timer, not on the next edit.** Riding the next
  settled edit is free while somebody is working, and useless in the case that
  loses data: the last edit failed to save and nobody touched the board again.
  The backoff runs 1s → 3s → 10s → 30s and then repeats, and `stop()` takes the
  timer with it so a closed board does not wake up to save itself.
- **The scheduled paths write only what is outstanding.** A direct `flush()`
  does not consume the debounce an edit armed, so the Retry button and the page
  on its way out each leave a timer behind that would fire on a board they have
  already stored. A duplicate write is waste; a duplicate write that *fails*
  reports a stored board as unsaved, which is the thing this is here to stop.
- **One write at a time.** Four callers reach `flush()` — the debounce, the
  retry timer, the page on its way out, and the button in the bar — and none of
  them knows about the others. Two overlapping writes are not a race the
  repository can settle: both capture the same version to replace, so the one
  that lands second is refused for claiming a version the first has just moved,
  and the board spends a retry converging on a document it already had. A
  second caller joins the queue behind the write already out. The write still
  *starts* synchronously when nothing is in flight, which is what the next
  point depends on.
- **A page on its way out writes what the debounce is still holding.**
  `platform/lifecycle.js` listens for `pagehide` and for `visibilitychange`,
  because neither covers the other — a phone backgrounding a tab may fire only
  the second. Against Web Storage this is decisive: `save()` reaches `setItem`
  before it awaits anything, so the write has landed by the time the handler
  returns, which is what `test/node/lifecycle.test.js` pins down. Against a
  network repository it is best effort, and best effort beats not trying.

A client that is not the elected writer is *not* told anything is wrong. It
holds the same document as the writer, arrived at by applying the same ops, and
saying "unsaved" at every non-writer in a session would be false four times over
for every once it was right.

### Rendering

Objects are real DOM elements inside a transformed layer, not canvas pixels, so
text editing, IME, selection and accessibility come from the browser. Pan and
zoom write one `transform`, so they never walk the object list; the per-object
work is viewport culling. Geometry inside an object (padding, radius, font) is
in world units and scales with the canvas, while affordances (selection ring,
handles, hairlines) are counter-scaled by a `--z` custom property so they stay
constant on screen at any zoom.

### Exporting a picture

Nothing in a browser turns a live DOM subtree into an image. `foreignObject`
comes closest and renders inconsistently outside a browser, and the libraries
that do it properly are libraries, which the canvas layer does not have. So the
export draws the store a **second time**, in 2D context calls.

That is a second renderer, and the cost is real: how an object looks now lives
in two places. It is kept as small as it can be by making the stylesheet the
only place colour is decided. `canvas.css` is *read* rather than copied — theme
tokens off `:root`, and probe elements for the two things a token cannot
answer, since `--card-bg` is chosen by an attribute selector and the envelope's
background is a `color-mix` only the browser can resolve. Retuning a colour or
adding a theme needs no change here; only geometry is restated.

Images are the one thing that cannot be drawn in the same pass they are read in:
a 2D context has no way to wait for a bitmap mid-drawing, so every picture on the
board is decoded first, keyed by source so the same one pasted twice is one
decode. A source that will not decode is left out and its object is drawn as the
empty box the DOM would show, because the rest of the board is still worth a file
and drawing nothing would look like the export lost it.

What it deliberately does not reproduce: selection rings, handles and guides,
which are affordances for someone working rather than part of the document; the
exact two-layer CSS shadow, because a 2D context has one shadow; and flexbox,
which lists lay out by hand.

`core/export.js` holds the half that needs no browser — which rectangle the
picture covers, and how many pixels that is. A board is infinite and a canvas
is not, so past 8192 pixels a side the scale is reduced rather than the frame
cropped: a soft picture of the whole board beats a sharp picture of part of one,
and a browser handed an over-large canvas returns a null blob, which the bar
reports rather than downloading an empty file.

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
Storage with no accounts at all, which is what `npm test` runs against. The
published GitHub Pages site is handed both, as repository *variables* rather
than secrets: the anon key ships inside the bundle whatever we do, so masking
it in a build log would hide it only from someone who already has it. What
protects the data is the row level security, which is tested rather than
assumed. Registering attaches an email to the guest
who is already signed in, rather than creating a second user beside them, so
the boards come along.

The two repositories satisfy one contract, so nothing above `shell/storage.js`
knows which is in front of it. `list()` is one indexed query rather than a parse
of every stored board, and access is not enforced in the client: a `select` with
no `where` clause is the correct way to ask for "my boards", because the
policies are what answer it.

Every call answers rather than throws — except the two reads, which reject when
the store will not answer at all. A write has something honest to fail with and
a read does not, and both of the values they used to fail with mean something
else that the caller acts on:

- `[]` from `list()` is also how the repository says *"you have no boards"*, and
  the board list can only render it as **"No boards yet"**. Answering a failed
  query with it therefore reported an empty account on the strength of a request
  that never arrived — which to the person reading it is indistinguishable from
  having lost everything.
- `load()` returning `null` is also how the repository says *"there is no such
  board"*, so `app.js` did what null means and seeded a starter board. Nothing
  guards the save that follows — a board that was never read has no version to
  claim — so the starter content landed on top of the document that was there.
  One edit after a failed read was enough to lose the board.

So `null` from `load()` means the board is genuinely not there, and nothing else.
A record that will not parse still reads as `null`: that board is unrecoverable
whatever we do, and reseeding is the right answer to it. In the Web Storage
repository that distinction is the whole design — junk at a key is a bad record
and is skipped, so one unparseable board does not sink the list around it, while
a `getItem` that throws is the store refusing and says nothing about what is in
it.

`createNullRepository` still answers `[]` and `null`, and that is not the same
lie: nothing can be read there because nothing was ever written, and no retry
would change it.

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

Boards made before there was an account are adopted into it — once, on the
first sign-in that finds them, silently. Two rules make that safe to run again
after a half-finished attempt: a board the account already has is left alone,
because the account's copy is the one other people may have edited; and the
browser keeps its copies, because copying is reversible and deleting is not.

The first of those rules is a question put to the account, so it matters what
happens when the account cannot be asked. A read that failed is not an answer,
and taking it for "no, you do not have this board" is how the browser's stale
copy lands on one other people have edited since. A board that cannot be settled
is counted unfinished rather than adopted over — the marker stays unset, so the
next sign-in tries it again, and one bad read does not stop the boards around it
from moving.

Access is handed back the same way it was given. A board someone shared with
you is not yours to delete, so its card offers **Leave** where an owned one
offers Delete — the policy would refuse a delete, and refusing quietly would
look like a board that came back. `list()` carries `owned` so the list knows
which of the two it is looking at; the local repository reports `true` for
everything, because nobody else can reach a browser's own storage. An owner
cannot leave: there is no membership row to hand back, and a board with no
owner is one nobody can share or delete.

### Organizations

Sharing hands out one board. An **organization** hands out everything in it,
now and later: you are invited once, and every board the team makes afterwards
is already yours to open. That is the whole difference, and it is why this is a
second grant of access rather than a loop over the first.

The vocabulary is deliberately the board's. An organization has an owner and
members who are `editor` or `viewer` — the same two words `board_members`
already uses — and your role in the organization *is* your role on its boards.
So `board_role()` is still the one question everything asks; it just has two
places to look now, and the stronger grant wins. Being made an editor of one
board is not undone by being a viewer of the team, and joining the team does
not quietly downgrade a board someone handed you directly.

Owning the organization resolves to `editor` on its boards, not `owner`. A
board has exactly one owner and it is whoever made it — two rows answering
`owner` for the same board would put `freeze_board_owner` and `board_people`
in disagreement about who that is. What owning the organization additionally
buys is written into the policies that grant it: deleting a board somebody else
made in it, and moving one out.

An organization may have a **second owner**, optionally. One owner is one
person who can be ill, or on a plane, or gone, and everything that keeps an
organization running waits on them.

One more, and not a list of them: `co_owner_id` is a column rather than an
'owner' role in `organization_members`, because the shape is the rule. A role
would make "how many owners" an open question, and every answer above two is a
different feature with different questions about who can remove whom.

The line is that the organization's *row* belongs to the first owner and
running the organization is shared. `org_role()` answers `owner` for both, so
everything that resolves through it — the invite link, the roster, taking
somebody off, and every board power inside — belongs to both. What stays with
`owner_id` is the four acts on the organization itself: rename, delete, hand
over, and appoint or remove the second owner. So there is always exactly one
account that cannot be locked out by the other, which is what stops "second
owner" being a way to lose an organization.

The second owner keeps their membership row, and the appointment deliberately
never touches it. That is what makes appointing and removing one statement
each, and it is why taking the appointment back puts their old role straight
back in force. It also means the two have to end together — a `Remove` that
left somebody running the organization is the one outcome nobody would expect
from that button — so a trigger clears the appointment when they stop being a
member, whether they were removed or walked out. `organization_people()` reports
them as `co-owner`, which is a word for that list rather than a role anything
stores: the roles are still owner, editor and viewer.

Handing an organization over is its own operation rather than a loosened
policy. `organizations_update` still tests `owner_id = auth.uid()` in both
halves — the `using` limits the write to the owner, and the `with check` stops
that owner writing an arbitrary uuid into the column and giving the
organization, its boards and its outstanding invite to a stranger or to nobody
in one statement. That remains the right answer for the naive path.

Transfer is not that statement. It is three changes that have to land together
— the column moves, the new owner's membership row goes because an owner does
not hold one, and the outgoing owner gets one so they do not lose access to the
work they are handing over — and it has rules a `with check` could not express:
the recipient must already be a member, because there is no way here to name
somebody you have not been handed, and must be a real account, for the same
reason creating an organization needs one. So it is a `SECURITY DEFINER`
function, which is also where those rules can be read. Handing it to yourself
is answered true: nothing is wrong and there is nothing to do, and a false
would have the dialog report a failure for a state the user asked for and has.

Creating an organization is the one thing here a guest cannot do. Every visitor
is signed in anonymously, and an organization owned by a browser session is one
nobody can get back into once that session is gone. Being invited *into* one
needs no account, exactly as following a board link does — which is also why
`sweep_anonymous_users` had to learn about organization membership, or a guest
invited on Monday was deleted the following week.

Where a board lives is not something editing it can change. An organization is
what makes someone an editor of boards they do not own, so without a trigger the
same grant would let them write the column that says whose board it is — moving
the team's work into an organization they control, past a policy that only ever
sees the row being proposed. `freeze_board_org` asks the two questions RLS
cannot: may you take this board out of where it is (its owner, or the
organization's), and may you put it where it is going (the same test
`boards_insert` makes). Both live in the trigger rather than in a `with check`
because both only matter when `org_id` actually changes, and autosave writes an
update per settled edit.

Deleting an organization is a decision about the organization. The boards in it
are several people's work, so `on delete set null` hands each one back to
whoever created it and everyone else loses sight of it — which is the part the
deletion was actually about. The confirm says so, because "delete the
organization" on its own reads like it takes the boards too, and that fear is
what stops people tidying up.

The personal list is not "boards with no organization". A board can be shared
with you directly *and* live in a team you are not in, and filtering on
`org_id is null` would leave it with nowhere to appear at all — so `/` shows
everything that is not filed under an organization you can actually open. That
rule is `board_summaries.personal`, and it lives in the database because the
list is scoped there.

### Listing a page at a time

`list()` had no `where` clause, on purpose: row level security decides what you
can see, and a filter in the client would be a second, weaker copy of the
policies. That stayed cheap while "every board you can see" meant your own plus
a handful shared with you.

Organizations change the arithmetic. One invite to a team with five hundred
boards makes every load of your *personal* list fetch five hundred rows to
render three, and `boards_select` runs `board_role()` on each one you do not
own. So the list is scoped in the database and read a page at a time — and the
order matters: scoping has to come **first**, because cutting the page in
Postgres and then filtering it in the browser gives pages of unpredictable size
and no way to tell "that is all of them" from "this page happened to be
entirely somebody's team".

The scoping is a view rather than a function, so `list()` goes on saying what it
wants instead of calling a procedure that decides for it. `security_invoker` is
the whole reason that is safe: the view runs as the caller, so every policy on
`boards` applies exactly as before and the view adds no access of its own — it
adds the `personal` column, and it drops `doc`, which a list never wanted and
now cannot ask for by mistake. One word in a migration, no behavioural tell when
it is right, so `test/db/` asserts it directly the same way it asserts
`prosecdef`.

Paging is keyset, not offset. `.range()` is shorter and wrong: boards are
ordered by when they were last saved, so somebody saving one while you read
shifts every later row across the page boundary and page two repeats a board or
skips one. Asking for "older than the last one I saw" names a position in the
data rather than a count of rows, and cannot drift. `updated_at` alone is not a
total order — boards written together tie — so `id` breaks the tie, in the sort,
in the cursor's comparison and in the index. The cursor carries the timestamp
exactly as Postgres gave it: `Date.parse` rounds microseconds away, and a cursor
rounded to milliseconds straddles its own boundary.

The cost is paid by scope switching, which used to be a client-side filter over
data already in hand and is now a request. That is the trade: a workspace of
five boards switches a little slower, and a workspace of five hundred loads ten
times cheaper.

The "New" badge had to change with it. The record used to be pruned to whatever
was listed, which bounded it for free — against a page that would forget every
board below the fold and announce the lot next time, so it is capped instead.
What it still does not do is *add* what it announces: being listed is not being
looked at, and a reconcile that recorded the boards it badged would clear them
on the next refresh, before anyone had read them. Only opening a board does
that. A first look seeds rather than announcing, and pagination stretches a
first look across several requests — so the pages after the first go on seeding,
or page one would be silent and page two would arrive covered in badges.

Adoption is the one caller that genuinely needs every board rather than a page,
and it walks the cursor to the end: a board left behind is a board with no way
to reach it, which is the situation that file exists to prevent.

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

A client that is not the elected writer still reports its board as saved on the
strength of a single broadcast having been *sent*. `channel.send` for a
broadcast without `ack` resolves `'ok'` the moment it is called — before the
socket has been written to, never mind the server reached — so one message that
went nowhere is indistinguishable from one that landed, and no amount of
inspecting the result will say which. Knowing would mean `broadcast: { ack:
true }` and an acknowledgement per message, which a drag emits by the dozen.

What is covered is the case that loses whole sessions rather than single ops:
standing down for an elected writer is a promise that somebody else is storing
these edits, and `isWriter()` now stops making that promise the moment the
channel is not up. A disconnected client writes its own snapshot, so "saved"
is a claim about a write it made rather than about a message it hopes arrived.

Signing in with an emailed confirmation link does not work. `detectSessionInUrl`
is off because HashRouter owns the fragment, so the tokens in a confirmation
link are never read — the fix is to handle the fragment in the bootstrap,
before the router mounts. Local dev has `enable_confirmations = false`, so this
path is not exercised by anything.

There is no notification when a board is shared with you, and there cannot
usefully be one from this side: sharing is self-initiated. An owner creates a
link, the recipient opens it, and `JoinPage` redeems the token and navigates
them straight onto the board — so on that device nothing appeared unannounced.
A board *can* still turn up unasked in two ways: the same account on a second
device finds one it joined elsewhere, and `board_members_insert` checks only
`board_role(board_id) = 'owner'` with no constraint on `user_id`, so an owner
may add anyone directly — which the policies permit and no screen does.

Both are covered by marking boards this browser has not shown for this account,
rather than by claiming to know that somebody shared one. The record is per
account in Web Storage; the first look at a workspace seeds it rather than
announcing everything, and opening a board is what clears its badge. What is
not built is anything that reaches a person who is not looking at the app —
that needs a channel out, and the only one available needs SMTP.

An organization still cannot outlive its first owner on its own. Deleting that
account cascades the organization away and its boards fall back to whoever made
them, exactly as deleting the organization would — a second owner does not
inherit it, because `co_owner_id` is `on delete set null` and `owner_id` is
`on delete cascade`, and promoting somebody automatically is a decision this
schema has no business making unasked. Nothing is lost; somebody has to hand it
on, or be handed it, first.

The gate on creating one reads `auth.users.is_anonymous`, not the `is_anonymous`
JWT claim — a claim is a copy of that column from whenever the token was minted,
so a guest who has just registered would be refused until it refreshed. What is
exercised is the local path: `enable_confirmations = false`, the account menu
attaches an email to the guest through `updateUser`, GoTrue clears the flag, and
the browser suite goes on to create an organization with that session. Whether
the flag clears *before* the address is confirmed, in a deployment that confirms,
is not something anything here tests — and the confirmation link does not work
yet regardless, three paragraphs up.

The personal scope has no index behind it. Its predicate is `org_id is null or
org_role(org_id) is null`, and the second half is a function call no index can
answer — the boards it matches are overwhelmingly your own, which
`boards_owner_updated_idx` already covers through the policy's `owner_id =
auth.uid()`, but that is an argument rather than a measurement. The
organization scope is indexed properly, tiebreak included.

Nothing re-reads a list while you are looking at it. A board someone else adds
to a team appears on your next load, not under your cursor — and with paging,
"your next load" means page one, so a board that arrives while you are three
pages down is not inserted where it belongs. Live lists would mean a
subscription per scope on top of the per-board channel that already exists.

A link is drawn as plain text in an exported PNG — no colour, no underline. The
export is a second renderer with its own text layout, and per-run styling means
splitting the wrapping across styled runs inside the one function in this codebase
that is genuinely fiddly. A link in a picture is not clickable anyway, so what is
lost is that it looks like one.

The preview's residual risk is **DNS rebinding**. The function resolves a name,
checks every address it gets, and then hands the name to `fetch`, which resolves
it again — a server that answers with a public address once and a private one a
moment later gets through. Closing it means connecting to an address that has
been checked while carrying the original `Host`, which `fetch` gives no way to
express. Also, `Deno.resolveDns` is used when it exists: where it does not, the
literal and name checks still apply but the resolution check silently does not.

Nothing rate-limits previews beyond the one-second hover and the client's cache.
A person who wants to spend the project's function invocations can hover a card
of links for a while.

There is no cut. Copy and paste are here because they were asked for; ⌘X is a
third gesture with its own question — whether the objects go when the copy is
made or when the paste lands — and inventing an answer to that was not part of
the request.

A pasted image is bounded to fit one broadcast, and nothing checks that it did.
`channel.send` for a broadcast resolves before the socket has been written to
(three sections up), so an `add` too large to deliver is indistinguishable from
one that arrived — the picture is in the snapshot either way, so the other people
on the board see it on their next load rather than under their cursor. What would
close this is the same `broadcast: { ack: true }` that the writer election cannot
afford.

Images are also the first thing on a board big enough to reach the Web Storage
quota. A refused write is already reported honestly — the bar says the board is
not stored and the retry is right there — but nothing distinguishes "this browser
is full" from "this write failed", and the difference is one a person can act on.

Routing is hash-based (`/#/b/:id`) because GitHub Pages has no SPA rewrite.
Moving to a host that can serve `index.html` for any path makes that a one-line
change to `BrowserRouter`.

## Licence

MIT
