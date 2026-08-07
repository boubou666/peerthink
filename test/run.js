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
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChrome, findChrome } from './helpers/chrome.js';
import { localSupabase } from './helpers/supabase.js';
import { ensureBuild, startDevServer } from './helpers/vite.js';
import { SUPABASE_ONLY, report } from './coverage.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COVERAGE = join(ROOT, '.coverage');

rmSync(COVERAGE, { recursive: true, force: true });
mkdirSync(join(COVERAGE, 'node'), { recursive: true });

if (!findChrome()) {
  console.error('No Chromium available. Set CHROME_PATH to a Chrome/Chromium binary.');
  process.exit(1);
}

// the production-server test serves dist/; building it here rather than inside
// that test is what keeps test/node/** on Node built-ins
if (await ensureBuild()) console.log('built dist/ for the production-server test');

/**
 * The plain origin, and it has to be made plain rather than left plain.
 *
 * Vite reads `.env.local`, which a developer who has run the app against a
 * local stack certainly has — and it would quietly turn this server into a
 * Supabase build, so every suite that assumes Web Storage would be talking to
 * Postgres instead. Blanking the two variables here means the offline suites
 * are offline because this file says so, not because of what is on disk.
 */
const { server: vite, base: appBase } = await startDevServer({
  env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
});

/**
 * A second origin, serving the same sources to a build that has been told
 * about a Supabase project. Whether there is a backend is something the app
 * decides once, at load, from its environment — so it is not a thing one page
 * can toggle, and the two worlds have to be two servers.
 */
const supabase = localSupabase();
if (!supabase) console.log('no local supabase — the account suite will skip (npx supabase start)');
const auth = supabase
  ? await startDevServer({
      env: { VITE_SUPABASE_URL: supabase.url, VITE_SUPABASE_ANON_KEY: supabase.anonKey },
    })
  : null;

// No port is passed: Chromium picks one and reports it back, so nothing can
// take the number between the check and the bind.
const { child: chrome, base: browserBase } = await launchChrome({
  userDataDir: join(COVERAGE, 'chrome-profile'),
});

writeFileSync(
  join(COVERAGE, 'endpoint.json'),
  JSON.stringify({ appBase, browserBase, authBase: auth?.base ?? null }),
);

/**
 * Named files run instead of the whole suite — `node test/run.js
 * test/browser/shell.test.js`. The browser files cannot be handed to
 * `node --test` directly; they need the dev server and the browser this script
 * starts, so narrowing has to happen here rather than at the runner.
 *
 * The coverage gate still runs, and will fail: one file does not cover the
 * app. That is the honest outcome of asking for one file.
 */
const requested = process.argv.slice(2);
const testFiles = requested.length
  ? requested
  : ['test/node', 'test/browser'].flatMap((dir) =>
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
  await auth?.server.close().catch(() => {});
}

const threshold = Number(process.env.COVERAGE_THRESHOLD ?? 95);
const { pass } = report({
  threshold,
  // Without a stack the account UI never mounts. Reported, not gated — and
  // said out loud, so a green run is never mistaken for a complete one.
  unmeasured: supabase ? [] : SUPABASE_ONLY,
  note: supabase ? '' : 'the account UI was not measured: no local supabase (npx supabase start)',
});

process.exit(code === 0 && pass ? 0 : 1);
