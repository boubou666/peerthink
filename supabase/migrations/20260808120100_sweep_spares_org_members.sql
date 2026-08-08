-- The sweep learns about organizations.
--
-- `20260805190000_sweep_anonymous_users.sql` deletes a guest who owns no board,
-- is on nobody else's board, and has not been seen for a while — "left nothing
-- behind", stated as the two ways a guest could be attached to anything.
--
-- Organizations add a third. A guest who follows an organization link joins the
-- organization, not any particular board: there is no row in `board_members`
-- and there may be no board they own. Under the old test that person has left
-- nothing behind, so a week after being invited they are deleted — and the
-- owner's member list quietly loses a row it never removed. The invite was the
-- most deliberate thing anyone did here; it is the last thing that should
-- vanish on a timer.
--
-- Ownership is tested too. `organizations_insert` requires a real account, so a
-- guest owning one is not something the app can produce today — but this
-- function deletes rows out of auth.users on a schedule, and what it deletes
-- should not be safe only for as long as a policy in another file stays the way
-- it is. `on delete cascade` from auth.users means getting this wrong takes the
-- organization, its boards' placement and its outstanding invite with it.
--
-- Nothing else about the sweep changes: same signature, same schedule, same
-- clock. The job created by that migration goes on calling this function, so
-- there is no second `cron.schedule` here.

create or replace function public.sweep_anonymous_users(older_than interval default '7 days')
returns integer
language plpgsql
security definer
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
      and not exists (select 1 from public.organizations o where o.owner_id = u.id)
      and not exists (select 1 from public.organization_members m where m.user_id = u.id)
    returning 1
  )
  select count(*) into removed from swept;
  return removed;
end;
$$;

-- `create or replace` keeps the privileges of the function it replaces, but
-- says so nowhere a reader can see. Restated so the grant is a property of the
-- file rather than of what happened to be there before it ran: `authenticated`
-- covers every signed-in visitor including the anonymous ones, and leaving this
-- callable would hand each guest a button that deletes the other guests.
revoke execute on function public.sweep_anonymous_users(interval) from public, anon, authenticated;
