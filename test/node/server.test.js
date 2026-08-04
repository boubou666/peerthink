import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createSocket } from 'node:net';
import { basename, join, sep } from 'node:path';
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

const listen = (server) => new Promise((resolve, reject) => {
  // a bind failure has to surface at the await, not as an unhandled event
  const onError = (err) => {
    server.off('error', onError);
    reject(err);
  };
  server.on('error', onError);
  server.listen(0, () => {
    server.off('error', onError);
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
});

/**
 * Resolve once the child has printed `expected` on stdout.
 *
 * A `data` event is not a line boundary, so the banner can arrive split across
 * chunks — buffering is what keeps this from failing on a server that started
 * perfectly well. An early exit or a spawn error rejects rather than waiting
 * out the timeout.
 */
function waitForOutput(child, expected, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    let buffered = '';

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onData = (chunk) => {
      buffered += chunk;
      if (!buffered.includes(expected)) return;
      cleanup();
      resolve(buffered);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`server exited before starting (code=${code} signal=${signal}): ${buffered}`));
    };
    // a spawn failure can emit 'error' with no 'exit' at all, so this has to
    // tear down the timer itself rather than lean on onExit doing it
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`server did not start within ${timeout}ms: ${buffered}`));
    }, timeout);

    child.stdout.on('data', onData);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

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

// `npm test` builds dist/ before spawning this file, so the skip is only for a
// bare `npm run test:node` on a tree that has never been built — this file
// stays on Node built-ins rather than reaching for a bundler of its own.
const built = existsSync(join(ROOT, 'dist', 'index.html'));

describe('running server.js directly', { skip: built ? false : 'no dist/ — run `npm test` or `npm run build` first' }, () => {
  test('serves the built application on PORT', async () => {
    // a free port, not a fixed one — a leftover process from an earlier run
    // would otherwise turn this into a phantom failure
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    // attached before the kill below, or an already-exited child never fires
    // it. 'error' counts as settled too: a child that failed to spawn has no
    // exit to wait for, and this promise is awaited in a finally.
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else {
        child.once('close', resolve);
        child.once('error', resolve);
      }
    });

    try {
      const banner = await waitForOutput(child, `PeerThink → http://localhost:${port}`);
      assert.ok(banner.includes(`http://localhost:${port}`));

      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /id="root"/, 'the built index, not a stray file');
    } finally {
      child.kill('SIGINT');
      await exited;
    }
  });
});
