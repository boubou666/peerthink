-- A second owner, optionally.
--
-- One owner is one person who can be ill, or on a plane, or gone. Everything
-- that keeps an organization running — handing out the link, taking somebody
-- off it, making and removing boards — waits on them. This adds one more
-- account that can do all of it.
--
-- One more, and not a list of them. `co_owner_id` is a column rather than an
-- 'owner' role in `organization_members` because the shape *is* the rule: a
-- role would make "how many owners" an open question, and every answer above
-- two is a different feature with different questions about who can remove
-- whom.
--
-- The line between the two is that the organization's *row* belongs to the
-- primary and running the organization is shared. Renaming it, deleting it,
-- handing it over and appointing or removing the second owner stay with
-- `owner_id`; everything that goes through `org_role()` — the invite link, the
-- roster, removing members, and every board power inside — belongs to both.
-- So there is always exactly one account that cannot be locked out by the
-- other, which is what stops "second owner" being a way to lose an
-- organization.

alter table public.organizations
  add column if not exists co_owner_id uuid references auth.users (id) on delete set null;

-- `on delete set null`, not cascade: the second owner's account going away is
-- not a reason for the organization to. It reverts to having one owner, which
-- is the state every organization starts in.

-- The second owner is *also* a member — see the trigger below — so this is an
-- elevation of a row that already exists rather than a second way of being in
-- an organization. That is what keeps appointing and removing one to a single
-- statement each.
create index if not exists organizations_co_owner_idx
  on public.organizations (co_owner_id)
  where co_owner_id is not null;


/**
 * Replaces the definition in 20260808120000_organizations.sql.
 *
 * Both owners answer 'owner'. The second owner holds a membership row saying
 * 'editor' or 'viewer' as well, and this deliberately never reaches it: the
 * appointment is the stronger grant and the one that should be visible to
 * every policy that asks. Removing the appointment is what puts their member
 * role back in play, which is the whole reason that row is left alone.
 */
create or replace function public.org_role(org text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (
      select 1 from public.organizations o
      where o.id = org
        and (o.owner_id = (select auth.uid()) or o.co_owner_id = (select auth.uid()))
    ) then 'owner'
    else (
      select m.role from public.organization_members m
      where m.org_id = org and m.user_id = (select auth.uid())
    )
  end;
$$;


/**
 * What may be written into `co_owner_id`, and by whom.
 *
 * `organizations_update` is unchanged and still limits this table to the
 * primary owner, so this is not what stops a member appointing themselves —
 * the policy is. What this stops is the primary owner writing an arbitrary
 * uuid into the column, which the `with check` cannot see and which would
 * hand the running of the organization to somebody who is not in it.
 *
 * The rules are `transfer_organization`'s, for the same reasons: a second
 * owner has to already be a member, because there is no way here to name
 * somebody you have not been handed; and has to be a real account, because an
 * organization run from an anonymous session is one that stops being run the
 * moment that session is gone.
 *
 * SECURITY DEFINER, unlike the two freeze triggers on `boards` — those reach
 * for `public.org_role()` and let it do the privileged reading, and this one
 * has to read `auth.users` itself, which `authenticated` cannot.
 */
create or replace function public.check_organization_co_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := (select auth.uid());
begin
  if new.co_owner_id is not distinct from old.co_owner_id then
    return new;
  end if;

  /**
   * Two ways this may legitimately change.
   *
   * The primary appoints or removes — which is the whole of the feature. And
   * the second owner's own appointment is cleared when they stop being a
   * member, which `clear_co_owner_on_leaving` does on their behalf and under
   * their identity: a second owner who leaves the organization takes the
   * appointment with them, and it would be a strange thing to refuse.
   */
  if not (
    old.owner_id = caller
    or (new.co_owner_id is null and old.co_owner_id = caller)
  ) then
    raise exception 'only the organization''s owner can appoint a second owner';
  end if;

  if new.co_owner_id is null then
    return new;
  end if;

  if new.co_owner_id = new.owner_id then
    raise exception 'the owner is already an owner';
  end if;

  if not exists (
    select 1 from public.organization_members m
    where m.org_id = new.id and m.user_id = new.co_owner_id
  ) then
    raise exception 'a second owner must already be a member of the organization';
  end if;

  if not exists (
    select 1 from auth.users u
    where u.id = new.co_owner_id and not coalesce(u.is_anonymous, false)
  ) then
    raise exception 'a second owner must be a registered account';
  end if;

  return new;
end;
$$;

create or replace trigger organizations_check_co_owner
  before update on public.organizations
  for each row execute function public.check_organization_co_owner();


/**
 * Leaving the organization takes the appointment with it.
 *
 * The second owner is a member with an elevation, so the two have to end
 * together — otherwise removing somebody from an organization leaves them
 * running it, which is the one outcome nobody would expect from a button
 * marked Remove. It covers both ways that row goes: the primary removing them,
 * and them walking out.
 *
 * SECURITY DEFINER because it writes `organizations`, which the person leaving
 * has no privilege to write. `check_organization_co_owner` still runs on that
 * write and still has to agree — the clause about a second owner clearing
 * their own appointment is exactly this path.
 */
create or replace function public.clear_co_owner_on_leaving()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.organizations
     set co_owner_id = null
   where id = old.org_id and co_owner_id = old.user_id;
  return old;
end;
$$;

create or replace trigger organization_members_clear_co_owner
  after delete on public.organization_members
  for each row execute function public.clear_co_owner_on_leaving();


/**
 * Replaces the definition in 20260808160000_transfer_organization.sql.
 *
 * One thing is new: handing the organization to the person who is already its
 * second owner. They cannot be both, so the appointment is cleared in the same
 * statement that moves `owner_id` — otherwise the column would go on naming
 * the primary owner, and `check_organization_co_owner` would then refuse to
 * clear it for anyone but them.
 *
 * Handing it to somebody else leaves the second owner where they are. They
 * were appointed to help run the organization, not to help run it for one
 * particular person.
 */
create or replace function public.transfer_organization(org text, to_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or org is null or to_user is null then
    return false;
  end if;

  if not exists (
    select 1 from public.organizations o where o.id = org and o.owner_id = caller
  ) then
    return false;
  end if;

  if to_user = caller then
    return true;
  end if;

  if not exists (
    select 1 from public.organization_members m
    where m.org_id = org and m.user_id = to_user
  ) then
    return false;
  end if;

  if not exists (
    select 1 from auth.users u
    where u.id = to_user and not coalesce(u.is_anonymous, false)
  ) then
    return false;
  end if;

  delete from public.organization_members
  where org_id = org and user_id = to_user;

  insert into public.organization_members (org_id, user_id, role)
  values (org, caller, 'editor')
  on conflict (org_id, user_id) do update set role = 'editor';

  -- The delete above has already cleared the appointment if the recipient held
  -- it — `clear_co_owner_on_leaving` fires on their membership row going. This
  -- says so rather than relying on it, because the two are only related by a
  -- trigger and a reader of this function cannot see that from here.
  update public.organizations
     set owner_id = to_user,
         co_owner_id = case when co_owner_id = to_user then null else co_owner_id end
   where id = org;

  return true;
end;
$$;

revoke execute on function public.transfer_organization(text, uuid) from public, anon;
grant execute on function public.transfer_organization(text, uuid) to authenticated;


/**
 * Replaces the definition in 20260808120000_organizations.sql.
 *
 * A second owner is listed as one. They have a membership row saying 'editor'
 * or 'viewer' — the appointment does not touch it — and reporting that would
 * describe them as something every policy in this schema disagrees with.
 *
 * 'co-owner' is a word for this list rather than a role anything stores: the
 * roles are still owner, editor and viewer, and `org_role()` still answers
 * 'owner' for both of them. What this distinguishes is who may hand the
 * organization on, which is the one thing the two owners do not share and the
 * one thing a screen showing them has to get right.
 */
create or replace function public.organization_people(org text)
returns table (user_id uuid, email text, role text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from (
    select o.owner_id as user_id, u.email::text as email, 'owner'::text as role
    from public.organizations o
    join auth.users u on u.id = o.owner_id
    where o.id = org and public.org_role(org) = 'owner'

    union all

    select m.user_id,
           u.email::text,
           case when m.user_id = o.co_owner_id then 'co-owner' else m.role end
    from public.organization_members m
    join public.organizations o on o.id = m.org_id
    join auth.users u on u.id = m.user_id
    where m.org_id = org and public.org_role(org) = 'owner'
  ) people
  -- Explicit ranks rather than a comparison against 'owner': there are two
  -- kinds of owner now, they sort 'co-owner' before 'owner' alphabetically,
  -- and the one who can hand the organization on goes first.
  order by
    case people.role when 'owner' then 0 when 'co-owner' then 1 else 2 end,
    people.role,
    people.email nulls last;
$$;

revoke execute on function public.organization_people(text) from public, anon;
grant execute on function public.organization_people(text) to authenticated;
