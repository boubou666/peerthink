import { createServer } from 'vite';

/**
 * The browser suite runs against Vite's dev server rather than a bundle.
 *
 * Vite serves each module unbundled at its own source path, so V8 coverage
 * comes back attributed to `src/core/board.js` instead of one minified chunk —
 * which is what keeps the coverage report meaningful. The built artifact is
 * covered separately by the build smoke test.
 */
export async function startDevServer() {
  const server = await createServer({
    configFile: new URL('../../vite.config.js', import.meta.url).pathname,
    root: new URL('../../', import.meta.url).pathname,
    logLevel: 'error',
    server: { port: 0, strictPort: false },
  });

  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('vite dev server did not report a local url');

  return { server, base: url.replace(/\/$/, '') };
}
