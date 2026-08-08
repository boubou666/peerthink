// Merges V8 coverage from both worlds — Node (pure modules, server) and
// Chromium (DOM modules) — into one line-coverage report, then gates on it.
//
// Both sources emit the same ScriptCoverage shape, and both describe the same
// bytes on disk, so byte offsets are directly comparable.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COVERAGE = join(ROOT, '.coverage');

/** Files we hold to the threshold. Test and helper code is not measured. */
const isMeasured = (rel) =>
  rel === 'server.js' || (rel.startsWith('src/') && (rel.endsWith('.js') || rel.endsWith('.jsx')));

/**
 * The account UI and the server-backed repository, which only run in a build
 * that has a Supabase project behind it — so the suite can only reach them
 * when one is running.
 *
 * When it is, these are gated like everything else. When it is not, they are
 * still reported but left out of the total, and `report()` says so in as many
 * words. Averaging an unreachable file into the number would quietly lower the
 * bar for every other file to make up the difference, which is the one thing a
 * coverage gate must not do.
 */
export const SUPABASE_ONLY = [
  'src/components/AccountForm.jsx',
  'src/components/AccountMenu.jsx',
  'src/components/OrganizationDialog.jsx',
  'src/components/ShareDialog.jsx',
  'src/platform/cursors.js',
  'src/platform/organizations.js',
  'src/routes/JoinOrgPage.jsx',
  'src/platform/supabase-repository.js',
  'src/platform/sharing.js',
  'src/shell/adopt.js',
  'src/platform/sync.js',
  'src/routes/JoinPage.jsx',
  'src/shell/RequireAccount.jsx',
  'src/shell/sharing.js',
  'src/shell/sync.js',
];

function readAll(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8')).result ?? [];
      } catch {
        return [];
      }
    });
}

/**
 * Node reports file:// URLs, Chromium reports http:// ones. Normalise both to
 * a repo-relative path with forward slashes — `relative()` hands back
 * backslashes on Windows, which `isMeasured` would reject as unmeasured and
 * quietly drop every `src/` file from the report.
 */
function toRelative(url) {
  if (url.startsWith('file://')) {
    try {
      return relative(ROOT, fileURLToPath(url)).split(sep).join('/');
    } catch {
      return null;
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    // Vite serves sources at their repo path and appends cache-busting queries
    return new URL(url).pathname.replace(/^\/+/, '');
  }
  return null;
}

/**
 * Resolve V8's nested ranges into a per-byte hit count.
 * -1 means "not instrumented" — dead space between functions, which is not
 * counted for or against coverage.
 */
function byteCounts(length, scripts) {
  const merged = new Int32Array(length).fill(-1);

  for (const script of scripts) {
    const local = new Int32Array(length).fill(-1);
    const ranges = script.functions
      .flatMap((fn) => fn.ranges)
      // outermost first, so inner blocks overwrite their parent's count
      .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);

    for (const r of ranges) {
      const end = Math.min(r.endOffset, length);
      for (let i = Math.max(0, r.startOffset); i < end; i++) local[i] = r.count;
    }
    for (let i = 0; i < length; i++) if (local[i] > merged[i]) merged[i] = local[i];
  }
  return merged;
}

const COMMENT = /^(\/\/|\/\*|\*)/;

function lineCoverage(source, counts) {
  const lines = source.split('\n');
  const uncovered = [];
  let total = 0;
  let covered = 0;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const skip = !trimmed || COMMENT.test(trimmed);

    if (!skip) {
      let tracked = false;
      let hit = false;
      for (let c = 0; c < line.length; c++) {
        if (/\s/.test(line[c])) continue;
        const n = counts[offset + c];
        if (n < 0) continue;
        tracked = true;
        if (n > 0) {
          hit = true;
          break;
        }
      }
      if (tracked) {
        total++;
        if (hit) covered++;
        else uncovered.push(i + 1);
      }
    }
    offset += line.length + 1;
  }
  return { total, covered, uncovered };
}

/** Collapse [3,4,5,9] into "3-5, 9" so the report stays readable. */
function ranges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    const start = nums[i];
    while (nums[i + 1] === nums[i] + 1) i++;
    out.push(start === nums[i] ? `${start}` : `${start}-${nums[i]}`);
  }
  return out.join(', ');
}

/**
 * `unmeasured` names files to report but not gate — see SUPABASE_ONLY. `note`
 * is the one-line reason, printed under the table so a green run that skipped
 * something says which something.
 */
export function report({ threshold = 95, quiet = false, unmeasured = [], note = '' } = {}) {
  const scripts = [...readAll(join(COVERAGE, 'node')), ...readAll(join(COVERAGE, 'browser'))];
  const skipped = new Set(unmeasured);

  const byFile = new Map();
  for (const script of scripts) {
    const rel = toRelative(script.url);
    if (!rel || !isMeasured(rel)) continue;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push(script);
  }

  const rows = [...byFile.keys()].sort().map((rel) => {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    const { total, covered, uncovered } = lineCoverage(source, byteCounts(source.length, byFile.get(rel)));
    return { file: rel, total, covered, pct: total ? (covered / total) * 100 : 100, uncovered };
  });

  const gated = rows.filter((r) => !skipped.has(r.file));
  const total = gated.reduce((n, r) => n + r.total, 0);
  const covered = gated.reduce((n, r) => n + r.covered, 0);
  const pct = total ? (covered / total) * 100 : 0;

  if (!quiet) {
    const width = Math.max(28, ...rows.map((r) => r.file.length));
    const bar = '─'.repeat(width + 34);
    console.log(`\n${'file'.padEnd(width)}  ${'lines'.padStart(9)}  ${'%'.padStart(7)}  uncovered`);
    console.log(bar);
    for (const r of rows) {
      const out = skipped.has(r.file)
        ? '(not measured)'
        : `${ranges(r.uncovered.slice(0, 12))}${r.uncovered.length > 12 ? ' …' : ''}`;
      const flag = skipped.has(r.file) || r.pct >= threshold ? ' ' : '!';
      console.log(
        `${r.file.padEnd(width)}  ${`${r.covered}/${r.total}`.padStart(9)}  ${r.pct.toFixed(1).padStart(6)}%${flag} ${out}`,
      );
    }
    console.log(bar);
    const label = rows.length > gated.length ? `TOTAL (of ${gated.length} measured files)` : 'TOTAL';
    console.log(`${label.padEnd(width)}  ${`${covered}/${total}`.padStart(9)}  ${pct.toFixed(1).padStart(6)}%`);
    if (note) console.log(`! ${note}`);
    console.log(pct >= threshold ? `\n✔ line coverage ${pct.toFixed(1)}% ≥ ${threshold}%` : `\n✘ line coverage ${pct.toFixed(1)}% < ${threshold}%`);
  }

  return { rows, pct, total, covered, pass: pct >= threshold };
}

/**
 * Whether this module is what node was asked to run.
 *
 * `import.meta.main` says this in one word, and is not available until Node
 * 22.19 — package.json allows 22.0, where it is silently undefined and the
 * block below simply never runs. Comparing the URLs works everywhere.
 */
const isEntryPoint = (url) => Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint(import.meta.url)) {
  const threshold = Number(process.env.COVERAGE_THRESHOLD ?? 95);
  process.exit(report({ threshold }).pass ? 0 : 1);
}
