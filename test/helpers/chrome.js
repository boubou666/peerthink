import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

/**
 * Start a headless Chromium and wait until its debugging port answers.
 *
 * The port is chosen by Chromium, not by us. Picking one here means opening a
 * socket to see that it is free, closing it, and hoping nothing takes it in
 * between — and on CI the gap straddles a Supabase stack coming up, which is a
 * lot of processes binding a lot of ports. Chromium writes the port it
 * actually bound to `DevToolsActivePort` once it is listening, so asking it
 * afterwards replaces a guess that is usually right with an answer that is
 * always right.
 *
 * Failures are reported with what Chromium said. The old version discarded
 * stderr and polled a dead process until the deadline, so a binary that could
 * not start, a port that was taken, and a genuinely slow boot all arrived as
 * the same "did not expose a debugging port in time" — which is exactly the
 * message a CI run produced with no way to tell which had happened.
 */
export async function launchChrome({ userDataDir, timeout = 60_000 }) {
  const bin = findChrome();
  if (!bin) throw new Error('No Chromium found. Set CHROME_PATH to a Chrome/Chromium binary.');

  // A file from an earlier run would otherwise be read as this run's port.
  const portFile = join(userDataDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });

  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // Kept to a tail: a Chromium that will not start can be very talkative, and
  // the last few lines are the ones that say why.
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });

  let exited = null;
  let failedToSpawn = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (error) => { failedToSpawn = error; });

  const giveUp = (reason) => {
    child.kill();
    return new Error([
      reason,
      failedToSpawn && `spawning ${bin} failed: ${failedToSpawn.message}`,
      exited && `chromium exited early (code ${exited.code}, signal ${exited.signal})`,
      stderr.trim() && `chromium said:\n${stderr.trim()}`,
    ].filter(Boolean).join('\n'));
  };

  const deadline = Date.now() + timeout;
  for (;;) {
    // Checked before the port file: a process that is gone is never going to
    // write one, and waiting out the deadline to say so buries the reason.
    if (failedToSpawn) throw giveUp('Chromium could not be started.');
    if (exited) throw giveUp('Chromium exited before it was ready.');

    // Checked before the probe rather than after it. `fetch` has no timeout of
    // its own, so a port that is bound and silent — accepting the connection
    // and never answering — parks the loop on an await that nothing settles,
    // and the deadline below is never reached. Verified: against a stub that
    // binds, writes its port and then says nothing, this ran past twelve
    // seconds on a two-second deadline before the signal was added.
    const left = deadline - Date.now();
    if (left <= 0) throw giveUp(`Chromium did not answer within ${timeout}ms.`);

    // The first line is the port; the second is the browser's websocket path.
    // The file appears when the socket is bound, which is a moment before the
    // HTTP endpoint answers — hence still asking it.
    const port = existsSync(portFile) ? readFileSync(portFile, 'utf8').split('\n')[0].trim() : '';
    if (port) {
      const base = `http://127.0.0.1:${port}`;
      try {
        // Capped by what is left, so one probe can never outlive the deadline,
        // and floored so the last attempt is still a real attempt.
        const signal = AbortSignal.timeout(Math.max(250, Math.min(2_000, left)));
        await (await fetch(`${base}/json/version`, { signal })).json();
        return { child, base };
      } catch {
        // bound but not answering yet — or answering too slowly to be up
      }
    }

    await new Promise((r) => setTimeout(r, 50));
  }
}
