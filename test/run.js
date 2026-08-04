// Test orchestrator.
//
// Node's runner cannot start a browser, and a browser cannot import the pure
// modules, so this starts both worlds, runs every test file against them, and
// merges the two coverage streams into one number.
//
// The browser side runs against Vite's dev server: modules are served
// unbundled at their source paths, so V8 coverage maps back to real files
// rather than one minified chunk. The shipped artifact is covered separately
// by the build smoke test.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChrome, findChrome } from './helpers/chrome.js';
import { startDevServer } from './helpers/vite.js';
import { report } from './coverage.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COVERAGE = join(ROOT, '.coverage');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

rmSync(COVERAGE, { recursive: true, force: true });
mkdirSync(join(COVERAGE, 'node'), { recursive: true });

if (!findChrome()) {
  console.error('No Chromium available. Set CHROME_PATH to a Chrome/Chromium binary.');
  process.exit(1);
}

const { server: vite, base: appBase } = await startDevServer();
const { child: chrome, base: browserBase } = await launchChrome({
  port: await freePort(),
  userDataDir: join(COVERAGE, 'chrome-profile'),
});

writeFileSync(join(COVERAGE, 'endpoint.json'), JSON.stringify({ appBase, browserBase }));

const testFiles = ['test/node', 'test/browser'].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => `${dir}/${f}`),
);

const args = [
  '--test',
  // browser test files share one Chromium and one origin's localStorage
  '--test-concurrency=1',
  '--test-reporter=spec',
  ...testFiles,
];

// whatever happens to the run, the browser and the dev server get torn down —
// a leaked Chromium holds its profile lock and makes the *next* run fail with
// a message about the debugging port that says nothing about the real cause
let code;
try {
  code = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NODE_V8_COVERAGE: join(COVERAGE, 'node'), APP_BASE: appBase },
    });
    // a spawn failure emits 'error' and never 'exit'; without this the promise
    // never settles and the finally below — the whole point of the block — is
    // never reached
    proc.on('error', reject);
    proc.on('exit', resolve);
  });
} finally {
  chrome.kill();
  await vite.close().catch(() => {});
}

const threshold = Number(process.env.COVERAGE_THRESHOLD ?? 95);
const { pass } = report({ threshold });

process.exit(code === 0 && pass ? 0 : 1);
