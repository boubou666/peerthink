import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The local Supabase stack, if one is running — otherwise null.
 *
 * The auth suite needs a real GoTrue, a real PostgREST and the real policies
 * from supabase/migrations, which is a Docker stack rather than something that
 * can be faked convincingly. So it is optional: `npx supabase start` and the
 * tests run, no stack and they skip. CI starts one, so the gate still applies
 * before anything merges.
 *
 * Explicit environment wins, which is what lets CI point the suite at a stack
 * it started itself — or at a throwaway hosted project — without the CLI being
 * involved at all.
 */
export function localSupabase() {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (url && anonKey) return { url, anonKey };

  try {
    // `status` answers from the running containers; with none up it exits
    // non-zero, which is the whole signal. stderr is dropped because "not
    // running" is an expected answer here, not a problem to report.
    const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    });
    const status = JSON.parse(out);
    return status.API_URL && status.ANON_KEY
      ? { url: status.API_URL, anonKey: status.ANON_KEY }
      : null;
  } catch {
    return null;
  }
}
