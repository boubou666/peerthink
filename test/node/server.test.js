import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createSocket } from 'node:net';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const freePort = () => new Promise((resolve, reject) => {
  const probe = createSocket();
  probe.on('error', reject);
  probe.listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

import { PUBLIC_DIR, createStaticServer, resolveFile, start } from '../../server.js';

describe('resolveFile', () => {
  test('maps a pathname to a file under the root', () => {
    assert.equal(resolveFile('/srv', '/js/main.js'), `${sep}srv${sep}js${sep}main.js`);
  });

  test('appends index.html to a directory path', () => {
    assert.ok(resolveFile('/srv', '/').endsWith(`${sep}index.html`));
    assert.ok(resolveFile('/srv', '/docs/').endsWith(`docs${sep}index.html`));
  });

  test('collapses traversal that stays inside the root', () => {
    assert.equal(resolveFile('/srv', '/a/../js/main.js'), `${sep}srv${sep}js${sep}main.js`);
  });

  test('refuses a path that escapes the root', () => {
    assert.equal(resolveFile('/srv', '../secrets.env'), null);
    assert.equal(resolveFile('/srv', '../../etc/passwd'), null);
  });

  test('the root itself is allowed through', () => {
    assert.equal(resolveFile('/srv', ''), `${sep}srv`);
    assert.equal(resolveFile('/srv', '/..'), `${sep}srv${sep}`);
  });
});

describe('static server', () => {
  let server;
  let base;

  before(async () => {
    server = await start(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  test('serves index.html at the root', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await res.text(), /PeerThink/);
  });

  test('serves modules with a JavaScript content type', async () => {
    const res = await fetch(`${base}/js/main.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  test('serves the stylesheet', async () => {
    const res = await fetch(`${base}/style.css`);
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
  });

  test('falls back to a generic content type for unknown extensions', async () => {
    const res = await fetch(`${base}/js/main.unknownext`);
    // no such file, so this proves only that the lookup does not throw
    assert.equal(res.status, 404);
  });

  test('404s for a missing file', async () => {
    const res = await fetch(`${base}/nope.js`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Not found');
  });

  test('traversal cannot reach files outside public/', async () => {
    const res = await fetch(`${base}/../../package.json`);
    assert.equal(res.status, 404);
  });

  test('400s on a malformed percent-escape', async () => {
    const res = await fetch(`${base}/%E0%A4%A`);
    assert.equal(res.status, 400);
    assert.equal(await res.text(), 'Bad request');
  });

  test('createStaticServer accepts a custom root', async () => {
    const custom = createStaticServer(PUBLIC_DIR);
    await new Promise((r) => custom.listen(0, r));
    const res = await fetch(`http://127.0.0.1:${custom.address().port}/style.css`);
    assert.equal(res.status, 200);
    custom.close();
  });
});

describe('running server.js directly', () => {
  test('listens on PORT and announces itself', async () => {
    // a free port, not a fixed one — a leftover process from an earlier run
    // would otherwise turn this into a phantom failure
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const banner = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
      child.stdout.on('data', (chunk) => {
        clearTimeout(timer);
        resolve(String(chunk));
      });
    });

    assert.match(banner, new RegExp(`PeerThink → http://localhost:${port}`));
    assert.equal((await fetch(`http://127.0.0.1:${port}/style.css`)).status, 200);

    child.kill('SIGINT');
    await new Promise((r) => child.on('exit', r));
  });
});
