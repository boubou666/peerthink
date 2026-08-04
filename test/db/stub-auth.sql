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
