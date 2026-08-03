import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Look for a Chromium build without adding a dependency to install one. */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const fixed = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const p of fixed) if (existsSync(p)) return p;

  // Playwright keeps browsers here; reuse one if the machine already has it.
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(cache, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

export async function launchChrome({ port, userDataDir }) {
  const bin = findChrome();
  if (!bin) throw new Error('No Chromium found. Set CHROME_PATH to a Chrome/Chromium binary.');

  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await (await fetch(`${base}/json/version`)).json();
      return { child, base };
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error('Chromium did not expose a debugging port in time');
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
