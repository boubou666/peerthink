import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

/**
 * The browser suite runs against Vite's dev server rather than a bundle.
 *
 * Vite serves each module unbundled at its own source path, so V8 coverage
 * comes back attributed to `src/core/board.js` instead of one minified chunk —
 * which is what keeps the coverage report meaningful. The built artifact is
 * covered separately by the build smoke test.
 *
 * Vite is the one framework dependency `test/**` is allowed to import, and it
 * is orchestration rather than subject: this module starts the dev server,
 * `test/run.js` owns its lifetime, and `test/node/server.test.js` builds `dist/`
 * when the production-server test needs something real to serve. The code under
 * test still imports nothing — `src/core/**` stays plain ES modules.
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
