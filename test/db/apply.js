// Apply the migrations to a database.
//
//   node test/db/apply.js [--stub]
//
// --stub first installs the Supabase surface the migrations expect: the auth
// schema, auth.uid(), the anon and authenticated roles, and the realtime
// schema the broadcast policies attach to. Pass it when the target is a bare
// Postgres; leave it off for a real Supabase database, which has all of that
// already and would not thank you for a second opinion.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

/** Migration files in the order their names put them in. */
export function migrations() {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }));
}

export async function apply(connectionString, { stub = false } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied = [];

  try {
    if (stub) {
      await client.query(readFileSync(join(ROOT, 'test', 'db', 'stub-auth.sql'), 'utf8'));
      applied.push('stub-auth.sql');
    }

    // One transaction per file, so a failure names the migration that failed
    // and leaves the ones before it in place.
    for (const { name, sql } of migrations()) {
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('commit');
        applied.push(name);
      } catch (error) {
        await client.query('rollback');
        error.message = `${name}: ${error.message}`;
        throw error;
      }
    }
  } finally {
    await client.end();
  }

  return applied;
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
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const applied = await apply(url, { stub: process.argv.includes('--stub') });
  for (const name of applied) console.log(`applied ${name}`);
}
