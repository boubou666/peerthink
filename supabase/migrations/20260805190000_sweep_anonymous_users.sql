-- Sweep the guests who left nothing behind.
--
-- Every first visit is a real row in auth.users — that is the point, it is what
-- makes the boards subject to row level security from the first card — and
-- Supabase has no automatic cleanup for them. Ordinary traffic grows the table
-- forever, and anyone who wants to can grow it faster by asking the signup
-- endpoint for guests in a loop.
--
-- A guest is swept when they own no board, are on nobody else's board, and have
-- not been seen for a while. Those three together are what "left nothing
-- behind" means: a guest with a board is someone's work, and a guest on
-- somebody's board is a person that board's owner shared with, whether or not
-- they ever came back.
--
-- Not `on delete cascade` from anywhere, and not called by the app. The app has
-- no business deleting users; this is housekeeping, and it runs on a schedule.

create or replace function public.sweep_anonymous_users(older_than interval default '7 days')
returns integer
language plpgsql
security definer
-- auth is on the path because the rows being deleted are GoTrue's. Fixed here
-- for the same reason every other definer function in this schema fixes it:
-- the caller is a scheduler, and a search_path it could influence would be a
-- way to make this function delete out of some other users table.
set search_path = public, auth, pg_temp
as $$
declare
  removed integer;
begin
  with swept as (
    delete from auth.users u
    where coalesce(u.is_anonymous, false)
      -- last_sign_in_at is the honest clock: a guest who keeps coming back on
      -- the same session is still here, however old their row is. It is null
      -- for a user who somehow never signed in, so created_at stands in.
      and coalesce(u.last_sign_in_at, u.created_at) < now() - older_than
      and not exists (select 1 from public.boards b where b.owner_id = u.id)
      and not exists (select 1 from public.board_members m where m.user_id = u.id)
    returning 1
  )
  select count(*) into removed from swept;
  return removed;
end;
$$;

-- Nobody who arrives over the API may call this. `authenticated` covers every
-- signed-in visitor including the anonymous ones, so leaving it callable would
-- hand each guest a button that deletes the other guests.
revoke execute on function public.sweep_anonymous_users(interval) from public, anon, authenticated;


-- Scheduling is conditional because the schema is not.
--
-- These migrations are applied to three kinds of database: a hosted project, a
-- local stack, and a bare Postgres that `test/db/apply.js --stub` fits out with
-- just enough of GoTrue to run the policy tests. pg_cron exists on the first
-- two and not the third, and `create extension` on a missing extension is an
-- error rather than a no-op — so an unguarded one here would stop the RLS
-- suite running anywhere Docker is not installed, which is exactly the
-- situation that file exists to avoid.
--
-- The function above is created either way. Only its schedule is conditional,
-- so what a bare Postgres loses is the timer, not the behaviour under test.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- Unschedule first so re-running this migration does not stack up jobs.
    -- cron.unschedule throws on a name it does not know, hence the lookup.
    if exists (select 1 from cron.job where jobname = 'sweep-anonymous-users') then
      perform cron.unschedule('sweep-anonymous-users');
    end if;

    -- 03:17 daily. An odd minute rather than the hour, so it is not queued
    -- behind everything else in the world that runs at midnight.
    perform cron.schedule(
      'sweep-anonymous-users',
      '17 3 * * *',
      $job$select public.sweep_anonymous_users()$job$
    );
  end if;
end
$$;
