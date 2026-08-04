import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createSocket } from 'node:net';
import { basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_DIR, createStaticServer, resolveFile } from '../../server.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** A tiny site checked into the repo, so these tests never need a build. */
const FIXTURE = fileURLToPath(new URL('../fixtures/site', import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const probe = createSocket();
  probe.on('error', reject);
  probe.listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const listen = (server) => new Promise((resolve) => {
  server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
});

describe('resolveFile', () => {
  test('maps a pathname to a file under the root', () => {
    assert.equal(resolveFile('/srv', '/assets/app.js'), `${sep}srv${sep}assets${sep}app.js`);
  });

  test('appends index.html to a directory path', () => {
    assert.ok(resolveFile('/srv', '/').endsWith(`${sep}index.html`));
    assert.ok(resolveFile('/srv', '/docs/').endsWith(`docs${sep}index.html`));
  });

  test('collapses traversal that stays inside the root', () => {
    assert.equal(resolveFile('/srv', '/a/../assets/app.js'), `${sep}srv${sep}assets${sep}app.js`);
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
    server = createStaticServer(FIXTURE);
    base = await listen(server);
  });

  after(() => server.close());

  test('serves index.html at the root', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await res.text(), /PeerThink fixture/);
  });

  test('serves modules with a JavaScript content type', async () => {
    const res = await fetch(`${base}/assets/app.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  test('serves the stylesheet', async () => {
    const res = await fetch(`${base}/style.css`);
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
  });

  test('404s for a missing file', async () => {
    const res = await fetch(`${base}/nope.js`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Not found');
  });

  test('traversal cannot reach files outside the root', async () => {
    const res = await fetch(`${base}/../../package.json`);
    assert.equal(res.status, 404);
  });

  test('400s on a malformed percent-escape', async () => {
    const res = await fetch(`${base}/%E0%A4%A`);
    assert.equal(res.status, 400);
    assert.equal(await res.text(), 'Bad request');
  });

  test('defaults to serving the build output', () => {
    assert.equal(basename(PUBLIC_DIR), 'dist');
  });
});

describe('running server.js directly', () => {
  test('listens on PORT and announces itself', async () => {
    // a free port, not a fixed one — a leftover process from an earlier run
    // would otherwise turn this into a phantom failure
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    try {
      const banner = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
        child.stdout.on('data', (chunk) => {
          clearTimeout(timer);
          resolve(String(chunk));
        });
      });

      assert.match(banner, new RegExp(`PeerThink → http://localhost:${port}`));
      // dist/ may not have been built yet, so only the response matters here
      assert.ok((await fetch(`http://127.0.0.1:${port}/`)).status > 0);
    } finally {
      child.kill('SIGINT');
      await new Promise((resolve) => child.on('exit', resolve));
    }
  });
});
