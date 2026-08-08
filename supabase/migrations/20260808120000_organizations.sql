-- Organizations: a place boards belong to, and the people who can reach them.
--
-- Sharing a board hands out one board. An organization hands out everything in
-- it, now and later — you are invited once and every board the team makes
-- afterwards is already yours to open. That is the whole difference, and it is
-- why this is a second grant of access rather than a loop over the first.
--
-- The vocabulary is deliberately the board's. An organization has an owner and
-- members who are 'editor' or 'viewer', those are the same two words
-- board_members already uses, and your role in the organization *is* your role
-- on its boards. Nothing above the database has to learn a second set of
-- rules, and `board_role()` stays the one question everything asks.
--
-- Creating an organization is the one thing here that a guest cannot do. Every
-- visitor is signed in anonymously — that is what makes a board covered by row
-- level security from the first card — but an anonymous session belongs to a
-- browser, and an organization that outlives nobody is not worth the invite
-- links pointing at it. Being invited *into* one needs no account, exactly as
-- following a board link does.


create table if not exists public.organizations (
  -- Minted on the client, in the shape boards use, so there is one id scheme
  -- in the app and one constraint saying what an id may look like. The reason
  -- boards need it — the route is handed to the user before the row exists —
  -- does not apply here, but two id schemes would be worse than one that is
  -- occasionally more than is needed.
  id text primary key
    constraint organizations_id_shape check (id ~ '^[A-Za-z0-9_-]{1,64}$'),

  owner_id uuid not null references auth.users (id) on delete cascade,

  -- Unlike a board, an organization is never created unnamed: you are invited
  -- into it by name, and 'Untitled' is not something to send someone a link to.
  name text not null
    constraint organizations_name_shape check (btrim(name) <> ''),

  created_at timestamptz not null default now()
);

create index if not exists organizations_owner_idx on public.organizations (owner_id);


create table if not exists public.organization_members (
  org_id text not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'editor' check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- "every organization I am in" — the reverse of the primary key, and the query
-- the board list makes on every load to decide which boards are whose.
create index if not exists organization_members_user_idx on public.organization_members (user_id);


/**
 * Where a board lives. Null is the personal space every board has had until
 * now, and is still what `New board` on the board list produces.
 *
 * `on delete set null` rather than cascade. Deleting an organization is a
 * decision about the organization; the boards inside it are several people's
 * work, and answering one click with "and destroy all of that" is not a trade
 * this schema makes. Each board falls back to whoever created it — which is
 * `owner_id`, a column it has carried since the first migration — and everyone
 * else loses sight of it, which is the part the deletion was actually about.
 */
alter table public.boards
  add column if not exists org_id text references public.organizations (id) on delete set null;

-- The organization page's list, the same shape as boards_owner_updated_idx.
-- Partial because most boards are personal: a null org_id is never the thing
-- being looked up, so there is no reason to index those rows.
create index if not exists boards_org_updated_idx
  on public.boards (org_id, updated_at desc)
  where org_id is not null;


-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

/**
 * Whether the caller is a real account rather than a browser session.
 *
 * `auth.users.is_anonymous` and not the `is_anonymous` JWT claim, because a
 * claim is only as current as the token carrying it: a guest who has just
 * registered holds a token minted before they did, and a gate read from that
 * token would refuse them until it refreshed. The table is the fact; the claim
 * is a copy of it from some point in the past.
 *
 * SECURITY DEFINER because `authenticated` cannot read auth.users at all —
 * which is also why this answers one boolean about the caller rather than
 * taking a user id and answering about anyone.
 */
create or replace function public.caller_is_registered()
returns boolean
language sql
stable
security definer
-- Fixed for the same reason every other definer function in this schema fixes
-- it: a search_path the caller can influence is a way to make this function
-- consult some other users table. `auth` is not on it — the reference below is
-- qualified, exactly as board_people's join to auth.users is.
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from auth.users u
    where u.id = (select auth.uid()) and not coalesce(u.is_anonymous, false)
  );
$$;

revoke execute on function public.caller_is_registered() from public, anon;
grant execute on function public.caller_is_registered() to authenticated;


/**
 * The caller's role in an organization: 'owner', 'editor', 'viewer', or null.
 *
 * The exact shape of board_role(), and SECURITY DEFINER for the same reason —
 * it is called from the policies on `organizations` and it reads
 * `organizations`, which under invoker rights is a policy consulting itself.
 * board_role()'s comment explains why that unwinds as `stack depth limit
 * exceeded` rather than a wrong answer, and why leaning on OR short-circuiting
 * to avoid it is a property of today's expressions rather than a rule.
 *
 * A null `org` answers null: the exists() matches nothing and the subquery
 * finds no row. That is the whole handling of a personal board, and it is why
 * callers can pass `boards.org_id` straight in without testing it first.
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
      where o.id = org and o.owner_id = (select auth.uid())
    ) then 'owner'
    else (
      select m.role from public.organization_members m
      where m.org_id = org and m.user_id = (select auth.uid())
    )
  end;
$$;

revoke execute on function public.org_role(text) from public, anon;
grant execute on function public.org_role(text) to authenticated;


/**
 * The caller's role on a board, now that a board can be reached two ways.
 *
 * Replaces the definition in 20260804101204_boards.sql. Ownership still wins
 * outright; below that, a board can be shared with you directly *and* sit in
 * an organization you are in, and the two grants can disagree. The stronger
 * one holds — being made an editor of one board should not be undone by being
 * a viewer of the team, and being in the team should not quietly downgrade a
 * board someone handed you.
 *
 * Owning the *organization* resolves to 'editor' here, not 'owner'. A board
 * has exactly one owner and it is the person in `boards.owner_id`; two
 * different rows answering 'owner' for the same board would make
 * `freeze_board_owner` and `board_people` disagree about who that is. What
 * owning the organization additionally buys — deleting a board somebody else
 * made in it, and moving one out — is said in the policies that grant it,
 * where it can be read.
 */
create or replace function public.board_role(board text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with granted as (
    select m.role
      from public.board_members m
     where m.board_id = board and m.user_id = (select auth.uid())

    union all

    select case when inherited.role = 'owner' then 'editor' else inherited.role end
      from public.boards b
      cross join lateral (select public.org_role(b.org_id) as role) inherited
     where b.id = board
  )
  select case
    when exists (
      select 1 from public.boards b
      where b.id = board and b.owner_id = (select auth.uid())
    ) then 'owner'
    -- Tested in order rather than taken with max(): that comparison would be
    -- lexical, and 'viewer' sorts above 'editor', so the strongest grant would
    -- be whichever word happened to fall last in the alphabet.
    when exists (select 1 from granted where role = 'editor') then 'editor'
    when exists (select 1 from granted where role = 'viewer') then 'viewer'
  end;
$$;


/**
 * Where a board lives is not something editing it can change.
 *
 * `boards_update` lets an editor write, and an organization is what makes
 * someone an editor of boards they do not own. Without this, an editor of
 * Acme could set `org_id` to an organization *they* own and take the whole
 * team's board with them — the policy would see an editor writing a row they
 * are allowed to write, because RLS cannot see the old row. Same shape as
 * `freeze_board_owner`, and for the same reason.
 *
 * Two separate questions, because they have different answers: may you take
 * this board out of where it is, and may you put it where it is going. The
 * first belongs to the board's owner and to the owner of the organization
 * holding it; the second is the same test `boards_insert` makes.
 *
 * Both live here rather than in `boards_update`'s `with check` because both
 * only matter when `org_id` actually changes. A `with check` runs on every
 * update — autosave writes one per settled edit, dozens in a session — and
 * would call `org_role()` each time to re-approve a placement nobody touched.
 */
create or replace function public.freeze_board_org()
returns trigger
language plpgsql
as $$
begin
  if new.org_id is not distinct from old.org_id then
    return new;
  end if;

  /**
   * The organization going away, rather than anybody moving anything.
   *
   * `boards.org_id` is `on delete set null`, so deleting an organization
   * fires this trigger once per board in it — and by then `org_role()` cannot
   * see the row it would need to authorise against, because the delete is
   * part of the same command. So the test below has nothing true to work
   * with: it would refuse every board except the ones the caller happens to
   * own, and the two ways an organization is deleted both reach boards that
   * somebody else made. The second way reaches them with no session at all —
   * `owner_id` on `organizations` is `on delete cascade`, so an account going
   * takes its organizations with it.
   *
   * Whoever deleted the organization was allowed to. The boards falling out
   * of it are that decision being carried out, not a second one to authorise.
   *
   * Stated rather than left to three-valued logic. Without this the cascade
   * survives only because `null or null` makes the `if` below not fire, which
   * is not a rule anybody wrote down — and the obvious hardening of that test,
   * a `coalesce` to false exactly like the one further down, would silently
   * turn deleting an account into an error.
   */
  if new.org_id is null and not exists (
    select 1 from public.organizations o where o.id = old.org_id
  ) then
    return new;
  end if;

  -- coalesce, so an identity that is not established is refused rather than
  -- waved through. The cascade above is the one case where that would be the
  -- wrong answer, and it has already returned.
  if not coalesce(
    old.owner_id = (select auth.uid()) or public.org_role(old.org_id) = 'owner',
    false
  ) then
    raise exception 'only the board''s owner or the organization''s owner can move a board';
  end if;

  -- coalesce, not a bare `not in`: org_role() answers null for an organization
  -- the caller is not in, `null not in (...)` is null rather than true, and the
  -- `if` would not fire — so the one case this test exists for is the one it
  -- would wave through.
  if new.org_id is not null
     and coalesce(public.org_role(new.org_id), '') not in ('owner', 'editor') then
    raise exception 'a board cannot be moved into an organization you are not in';
  end if;

  return new;
end;
$$;

create or replace trigger boards_freeze_org
  before update on public.boards
  for each row execute function public.freeze_board_org();


alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;

grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;

-- 20260805153000_revoke_anon_table_grants.sql explains why this is needed and
-- says a table added later must do it too. It cannot do it *for* these:
-- migrations run in name order, and these tables did not exist when it ran. So
-- the revoke travels with the table that needs it, which is the only
-- arrangement that keeps working however many more are added.
revoke all on public.organizations from anon;
revoke all on public.organization_members from anon;


create policy organizations_select on public.organizations
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.org_role(id) is not null);

create policy organizations_insert on public.organizations
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.caller_is_registered());

-- Renaming, and nothing else. `owner_id = auth.uid()` appears in both halves
-- on purpose: the `using` is what limits this to the owner, and the `with
-- check` is what stops the owner writing somebody else's id into the column
-- and handing the organization — with every board and every outstanding invite
-- in it — to a stranger, or to nobody, in one statement with nothing checking
-- who they named.
--
-- Handing it over deliberately is a different thing, with rules this policy
-- could not express and bookkeeping that has to happen in the same breath, and
-- it goes through `transfer_organization()` in a later migration. This policy
-- stays exactly as it is: it is still the right answer for the naive path.
create policy organizations_update on public.organizations
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy organizations_delete on public.organizations
  for delete to authenticated
  using (owner_id = (select auth.uid()));


create policy organization_members_select on public.organization_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.org_role(org_id) = 'owner');

create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check (public.org_role(org_id) = 'owner');

create policy organization_members_update on public.organization_members
  for update to authenticated
  using (public.org_role(org_id) = 'owner')
  with check (public.org_role(org_id) = 'owner');

-- An owner can remove anyone; a member can walk out.
create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using (public.org_role(org_id) = 'owner' or user_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- Boards, now that they can live somewhere
-- ---------------------------------------------------------------------------

-- Replaces the policy from 20260804101204_boards.sql. A board is still created
-- in the caller's own name; what is new is that it may be created *in* an
-- organization, and only by someone that organization has made an editor. A
-- viewer of a team can read its boards and cannot add to them, which is what
-- being a viewer means everywhere else here.
--
-- org_role() answering null makes the whole `in (...)` null rather than false,
-- and a `with check` that is not true refuses — so an organization the caller
-- is not in needs no test of its own.
drop policy if exists boards_insert on public.boards;
create policy boards_insert on public.boards
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (org_id is null or public.org_role(org_id) in ('owner', 'editor'))
  );

-- Replaces the policy from 20260804101204_boards.sql. Deleting is still not
-- something an editor can do — that has not changed and is the reason a shared
-- board offers Leave instead. What is new is the owner of the organization: a
-- board made in a team by someone who has since left it would otherwise be
-- undeletable by anybody still there.
drop policy if exists boards_delete on public.boards;
create policy boards_delete on public.boards
  for delete to authenticated
  using (owner_id = (select auth.uid()) or public.org_role(org_id) = 'owner');


-- ---------------------------------------------------------------------------
-- Inviting people
-- ---------------------------------------------------------------------------

-- The board_invites table, for organizations, and every line of its reasoning
-- carries over: one live link, the token is the whole secret and so is never
-- derived from the id, changing the role changes what the outstanding link is
-- worth rather than killing it, and revoking removes the link and not the
-- people who already followed it.
create table if not exists public.organization_invites (
  org_id text primary key references public.organizations (id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  role text not null default 'editor' check (role in ('viewer', 'editor')),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.organization_invites enable row level security;
grant select, insert, update, delete on public.organization_invites to authenticated;
revoke all on public.organization_invites from anon;

create policy organization_invites_select on public.organization_invites
  for select to authenticated
  using (public.org_role(org_id) = 'owner');

create policy organization_invites_insert on public.organization_invites
  for insert to authenticated
  with check (public.org_role(org_id) = 'owner' and created_by = (select auth.uid()));

create policy organization_invites_update on public.organization_invites
  for update to authenticated
  using (public.org_role(org_id) = 'owner')
  with check (public.org_role(org_id) = 'owner');

create policy organization_invites_delete on public.organization_invites
  for delete to authenticated
  using (public.org_role(org_id) = 'owner');


/**
 * Join an organization with a link. Returns the organization id, or null if
 * the token buys nothing.
 *
 * `redeem_board_invite` with a different table, including the parts that look
 * like edge cases and are not: redeeming twice is a no-op rather than a
 * failure, because a link pasted into a channel gets followed by the same
 * person more than once; `do nothing` rather than an upsert of the role, so a
 * viewer link cannot cost an editor the access they already have; and the
 * owner following their own link is answered with the organization rather than
 * given a membership row they do not need.
 *
 * A guest may redeem. Creating an organization takes an account and joining
 * one does not — the person following the link has whatever session the app
 * gave them, which is the same reason board links work at all.
 */
create or replace function public.redeem_organization_invite(invite_token text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invite public.organization_invites;
  caller uuid := (select auth.uid());
begin
  if caller is null or invite_token is null then
    return null;
  end if;

  select * into invite from public.organization_invites where token = invite_token;
  if not found then
    return null;
  end if;

  if exists (
    select 1 from public.organizations o where o.id = invite.org_id and o.owner_id = caller
  ) then
    return invite.org_id;
  end if;

  insert into public.organization_members (org_id, user_id, role)
  values (invite.org_id, caller, invite.role)
  on conflict (org_id, user_id) do nothing;

  return invite.org_id;
end;
$$;

revoke execute on function public.redeem_organization_invite(text) from public, anon;
grant execute on function public.redeem_organization_invite(text) to authenticated;


/**
 * Who is in an organization, with something to call them.
 *
 * `board_people` for organizations, and bounded the same way: only the owner
 * gets an answer, so it discloses the addresses of people who have already
 * joined and nothing else, and there is no way to ask it about an address.
 *
 * A guest who followed a link has no address, and comes back with a null email
 * rather than being left out — a member list that silently omits some of its
 * members is worse than one that says "Guest".
 */
create or replace function public.organization_people(org text)
returns table (user_id uuid, email text, role text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Wrapped for the same reason board_people is: across a UNION, `order by`
  -- can only see the output list, and an expression over it is not resolvable
  -- there at all.
  select * from (
    select o.owner_id as user_id, u.email::text as email, 'owner'::text as role
    from public.organizations o
    join auth.users u on u.id = o.owner_id
    where o.id = org and public.org_role(org) = 'owner'

    union all

    select m.user_id, u.email::text, m.role
    from public.organization_members m
    join auth.users u on u.id = m.user_id
    where m.org_id = org and public.org_role(org) = 'owner'
  ) people
  -- Not `order by role desc` — that sort is lexical and would put 'viewer'
  -- above 'owner'. The owner leads because they are the owner.
  order by (people.role <> 'owner'), people.role, people.email nulls last;
$$;

revoke execute on function public.organization_people(text) from public, anon;
grant execute on function public.organization_people(text) to authenticated;
