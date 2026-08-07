-- The pieces of a Supabase database that the migrations depend on.
--
-- A hosted Supabase project has all of this already; a bare Postgres does not.
-- Applying it lets the RLS tests run against either, which is the point: the
-- policies are the security boundary, and waiting on Docker to be installed
-- before anyone can test them is how untested policies get shipped.
--
-- This is a stand-in for GoTrue's surface, not an implementation of it. It
-- models exactly what the policies read — a user id, and the roles a request
-- arrives as — and nothing else.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- The columns the sweep reads, rather than the ones the policies read.
--
-- `sweep_anonymous_users` is the first thing here to care about *which* user a
-- row is and when it was last seen, so the stand-in has to carry that much of
-- GoTrue too. Added rather than declared above so a database that already has
-- this table — including, by mistake, a real project — is left alone: `add
-- column if not exists` is a no-op against the genuine article, which has all
-- three already.
alter table auth.users add column if not exists is_anonymous boolean not null default false;
alter table auth.users add column if not exists created_at timestamptz not null default now();
alter table auth.users add column if not exists last_sign_in_at timestamptz;

/**
 * The current request's user, or null when there is no session.
 *
 * Both spellings are read because both are in the wild: PostgREST sets the
 * flattened `request.jwt.claim.sub`, newer versions set the whole claims
 * object. `true` on current_setting makes a missing GUC null rather than an
 * error, which is what an unauthenticated request looks like.
 */
-- Created only if it is not already there, and deliberately not `or replace`.
-- `--stub` is documented for a bare Postgres, but nothing stops it being
-- pointed at a real project by mistake — and replacing GoTrue's auth.uid()
-- there would swap the function every RLS policy in the database reads for a
-- stand-in of it. A stub that can break the thing it stands in for is worse
-- than no stub.
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    execute $fn$
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid;
      $body$;
    $fn$;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;

-- Realtime's surface, to the same depth as auth's above.
--
-- `20260804154000_board_broadcast.sql` puts policies on `realtime.messages`,
-- because a private channel is authorised by row level security on that table
-- the same way a table is. On a bare Postgres the schema does not exist, so
-- that migration failed with `schema "realtime" does not exist` and every
-- migration after it never ran — which meant the RLS suite could not run at
-- all without Docker, and the README's promise that it runs against any
-- Postgres was not true.
--
-- What the policies actually read is `realtime.topic()` and nothing else: no
-- column of `realtime.messages` appears in either of them. So the table is
-- here to be a thing policies can attach to, and the columns are the ones
-- Supabase's own table carries, so that a policy written against the real
-- schema does not fail here for referring to one.
create schema if not exists realtime;

create table if not exists realtime.messages (
  id bigint generated always as identity primary key,
  topic text not null,
  extension text,
  event text,
  payload jsonb,
  private boolean default false,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enabled, and deliberately with no policy of its own: default-deny is what
-- the migration's own comment says the starting point is, and the two policies
-- it adds are the whole of the access. A stub that left RLS off would let the
-- suite pass against a table that refuses nobody.
alter table realtime.messages enable row level security;

-- On a hosted project this reports the topic of the channel the statement is
-- being authorised for. Here it reads a setting, which is the same shape as
-- auth.uid() above reading the JWT claim: a test says who it is and where it
-- is, and the policy is what decides.
create or replace function realtime.topic()
returns text
language sql
stable
as $$ select nullif(current_setting('realtime.topic', true), '') $$;

grant usage on schema realtime to anon, authenticated;

-- Usage on the schema is not access to the table. A hosted project grants
-- `authenticated` these privileges on realtime.messages and lets the policies
-- decide the rest — so a stub that grants only schema usage refuses a join at
-- the privilege layer, before RLS is consulted at all. Any test written later
-- against the broadcast policies would then be refused for the wrong reason,
-- and a refusal is what such a test expects to see. That is the same way the
-- two environments disagreed in 20260805153000_revoke_anon_table_grants.sql,
-- read from the other end.
--
-- To `authenticated` only. Both policies are `to authenticated`, and the anon
-- role has no business on a private channel — granting it here would recreate
-- exactly what that migration exists to take away.
grant select, insert on realtime.messages to authenticated;
