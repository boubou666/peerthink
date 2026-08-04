import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The browser suite runs against Vite's dev server rather than a bundle.
 *
 * Vite serves each module unbundled at its own source path, so V8 coverage
 * comes back attributed to `src/core/board.js` instead of one minified chunk —
 * which is what keeps the coverage report meaningful. The built artifact is
 * covered separately by the build smoke test.
 *
 * This module is the single place in `test/**` that imports Vite, so the rest
 * of the suite stays node:test plus raw CDP. It is orchestration rather than
 * subject: it starts the dev server and builds `dist/`, `test/run.js` drives
 * both, and no test file imports either. The code under test still imports
 * nothing — `src/core/**` stays plain ES modules.
 */
export async function startDevServer() {
  const server = await createServer({
    // fileURLToPath, not URL.pathname: pathname keeps percent-encoding and
    // yields `/C:/...` on Windows, neither of which Vite can resolve
    configFile: fileURLToPath(new URL('../../vite.config.js', import.meta.url)),
    root: fileURLToPath(new URL('../../', import.meta.url)),
    logLevel: 'error',
    server: { port: 0, strictPort: false },
  });

  await server.listen();

  const url = server.resolvedUrls?.local?.[0];
  if (!url) {
    // listening but unreportable: close it here, because the caller is about to
    // receive an exception instead of the handle it would have cleaned up with
    await server.close().catch(() => {});
    throw new Error('vite dev server did not report a local url');
  }

  return { server, base: url.replace(/\/$/, '') };
}

/**
 * Make sure `dist/` exists, so the production-server test has something real to
 * serve. `npm test` runs before `npm run build` in CI, and that test asserts a
 * genuine 200 containing the application root rather than tiptoeing around an
 * absent build.
 */
export async function ensureBuild() {
  if (existsSync(join(ROOT, 'dist', 'index.html'))) return false;
  await build({ configFile: join(ROOT, 'vite.config.js'), root: ROOT, logLevel: 'error' });
  return true;
}
