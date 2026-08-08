-- Handing an organization to somebody else.
--
-- `organizations_update` tests `owner_id = auth.uid()` in both halves, so a
-- plain update cannot move the column — and that stays exactly as it is. It is
-- still the right answer for the naive path: an owner writing an arbitrary uuid
-- into `owner_id` hands the organization, every board in it and every
-- outstanding invite to a stranger, or to nobody, in one statement with nothing
-- checking who they named.
--
-- Transfer is not that statement. It is three changes that have to happen
-- together or not at all — the column moves, the new owner's membership row
-- goes because an owner does not need one, and the old owner gets one so they
-- do not lose access to the work they are handing over — and it has rules the
-- naive path could not express. So it goes through a function, which is also
-- where those rules can be read.
--
-- SECURITY DEFINER for two reasons rather than one: the update it makes is the
-- update the policy refuses, and it has to read `auth.users` to find out
-- whether the recipient is a real account. It takes no caller identity —
-- auth.uid() is read here — and it can only ever act on an organization the
-- caller already owns.

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

  -- The whole of the authorisation, and it is deliberately the first thing:
  -- everything below writes.
  if not exists (
    select 1 from public.organizations o where o.id = org and o.owner_id = caller
  ) then
    return false;
  end if;

  -- Handing it to yourself is what you already have. Answered true rather than
  -- false: nothing is wrong, and there is nothing to do — where false would
  -- have the dialog report a failure for a state the user asked for and has.
  if to_user = caller then
    return true;
  end if;

  /**
   * The recipient has to already be in the organization.
   *
   * Not a technical limit — the column would take any uuid — but the same
   * rule the rest of this schema keeps: there is no way to name a person you
   * have not already been handed. `organization_people` is the only list of
   * candidates there is, and it is the members. Anything else would make this
   * function a way to attach an organization to a stranger's account.
   */
  if not exists (
    select 1 from public.organization_members m
    where m.org_id = org and m.user_id = to_user
  ) then
    return false;
  end if;

  /**
   * And has to be a real account, for the reason `organizations_insert` wants
   * one to create an organization at all: an organization owned by an
   * anonymous session is one nobody can get back into once that session is
   * gone. Transferring to a guest would recreate exactly the state that check
   * exists to prevent, one step later.
   *
   * `caller_is_registered()` answers about the caller and this is a question
   * about somebody else, so the read is spelled out here rather than reused.
   */
  if not exists (
    select 1 from auth.users u
    where u.id = to_user and not coalesce(u.is_anonymous, false)
  ) then
    return false;
  end if;

  -- An owner holds no membership row — `org_role()` answers 'owner' from the
  -- organization itself — so the row the recipient had would be a second,
  -- weaker statement about the same person.
  delete from public.organization_members
  where org_id = org and user_id = to_user;

  /**
   * The outgoing owner stays, as an editor.
   *
   * Handing over an organization is not leaving it, and dropping out of every
   * board in it is not something anyone would expect from a button that says
   * "make owner". Editor rather than viewer because it is the closest thing to
   * what they had; the new owner can change or remove it like any other
   * member, which is the point of them being the owner now.
   *
   * `on conflict` because the owner is not supposed to have a row and this
   * should not be the statement that finds out otherwise.
   */
  insert into public.organization_members (org_id, user_id, role)
  values (org, caller, 'editor')
  on conflict (org_id, user_id) do update set role = 'editor';

  update public.organizations set owner_id = to_user where id = org;

  return true;
end;
$$;

revoke execute on function public.transfer_organization(text, uuid) from public, anon;
grant execute on function public.transfer_organization(text, uuid) to authenticated;
