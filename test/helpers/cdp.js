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
    for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
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

export async function closePage(httpBase, targetId) {
  await fetch(`${httpBase}/json/close/${targetId}`).catch(() => {});
}
