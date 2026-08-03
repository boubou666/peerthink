// Static file server. node:http only — no dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Map a URL pathname onto a file inside `root`, or null if it escapes.
 * normalize() collapses "..", and the prefix check is the backstop.
 */
export function resolveFile(root, pathname) {
  const wanted = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const file = join(root, normalize(wanted));
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}

export function createStaticServer(root = PUBLIC_DIR) {
  return createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    const file = resolveFile(root, pathname);
    if (!file) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
}

/** Listen on `port` (0 picks a free one). Resolves with the live server. */
export function start(port = Number(process.env.PORT) || 3000) {
  const server = createStaticServer();
  return new Promise((resolvePort) => {
    server.listen(port, () => resolvePort(server));
  });
}

if (import.meta.main) {
  const server = await start();
  console.log(`PeerThink → http://localhost:${server.address().port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    });
  }
}
