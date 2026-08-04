// Minimal Chrome DevTools Protocol client over Node's global WebSocket.
// Enough to open a page, drive input, and read V8 coverage. No dependencies.

export class CDPSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => this.#dispatch(JSON.parse(ev.data));
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`cannot connect to ${wsUrl}`));
    });
    return new CDPSession(ws);
  }

  #dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? {})})`)) : resolve(msg.result);
      return;
    }
    // a copy: a one-shot handler unsubscribes itself while we are iterating
    for (const fn of [...(this.handlers.get(msg.method) ?? [])]) fn(msg.params);
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  off(method, fn) {
    const fns = this.handlers.get(method);
    if (!fns) return;
    const i = fns.indexOf(fn);
    if (i !== -1) fns.splice(i, 1);
  }

  /** Resolve on the next event whose params satisfy `match`. */
  once(method, match = () => true) {
    return new Promise((resolve) => {
      const fn = (params) => {
        if (!match(params)) return;
        this.off(method, fn);
        resolve(params);
      };
      this.on(method, fn);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

/** Create a fresh tab in a running browser and attach to it. */
export async function newPage(httpBase) {
  const target = await (await fetch(`${httpBase}/json/new?about:blank`, { method: 'PUT' })).json();
  const session = await CDPSession.connect(target.webSocketDebuggerUrl);
  return { session, targetId: target.id };
}

/**
 * A tab in a browser context of its own — its own cookies, its own Web
 * Storage, its own everything.
 *
 * Two tabs on one origin share localStorage, which is correct and is exactly
 * what makes them useless for testing two *people*: signing the second one in
 * overwrites the session the first is holding. A separate context is the only
 * honest way to have two accounts in one browser.
 *
 * Attaching goes through the page's own WebSocket rather than a flat session
 * on the browser connection, so nothing here has to route messages by session
 * id — the target is addressable directly once it exists.
 */
export async function newIsolatedPage(httpBase) {
  const { webSocketDebuggerUrl } = await (await fetch(`${httpBase}/json/version`)).json();
  const browser = await CDPSession.connect(webSocketDebuggerUrl);

  // Anything from here on can fail, and the browser-level socket is already
  // open — leaking it keeps the runner's event loop alive and turns a setup
  // error into a hang with a different symptom than its cause.
  let browserContextId;
  let targetId;
  let session;
  try {
    ({ browserContextId } = await browser.send('Target.createBrowserContext', {}));
    ({ targetId } = await browser.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    }));
    session = await CDPSession.connect(
      `${httpBase.replace(/^http/, 'ws')}/devtools/page/${targetId}`,
    );
  } catch (error) {
    if (browserContextId) {
      await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    }
    browser.close();
    throw error;
  }

  return {
    session,
    targetId,
    /** Disposing the context closes its tabs; the browser itself stays up. */
    async dispose() {
      await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      browser.close();
    },
  };
}

export async function closePage(httpBase, targetId) {
  await fetch(`${httpBase}/json/close/${targetId}`).catch(() => {});
}
