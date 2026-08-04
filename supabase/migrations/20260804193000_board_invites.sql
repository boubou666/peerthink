-- Sharing a board, by link.
--
-- There is no way to name the person you are sharing with: auth.users is not
-- readable by `authenticated`, and most people here are anonymous and have no
-- address to be named by. A link needs neither. It also means an invitee needs
-- no account beyond the guest session they already have, which is the same
-- reason anonymous sign-in exists in the first place.
--
-- One live link per board, and it says what it grants. Changing the role
-- changes what the outstanding link is worth, which is what "anyone with the
-- link can edit" means; revoking deletes it and mints nothing. People who have
-- already joined keep the access they have — they are rows in board_members
-- now, and the link is not what holds them there.

create table if not exists public.board_invites (
  -- one per board, so the primary key is the board
  board_id text primary key references public.boards (id) on delete cascade,

  -- 32 hex characters from gen_random_uuid(), which is 122 bits of randomness
  -- and needs no extension. The token is the whole secret: anyone holding it
  -- gets the role below, so it is never derived from the board id.
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),

  role text not null default 'editor' check (role in ('viewer', 'editor')),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.board_invites enable row level security;
grant select, insert, update, delete on public.board_invites to authenticated;

-- Only the owner ever reads this table. An invitee never selects their own
-- invite — redeeming goes through the function below, which is what stops the
-- token being a thing you can go looking for.
create policy board_invites_select on public.board_invites
  for select to authenticated
  using (public.board_role(board_id) = 'owner');

create policy board_invites_insert on public.board_invites
  for insert to authenticated
  with check (public.board_role(board_id) = 'owner' and created_by = (select auth.uid()));

create policy board_invites_update on public.board_invites
  for update to authenticated
  using (public.board_role(board_id) = 'owner')
  with check (public.board_role(board_id) = 'owner');

create policy board_invites_delete on public.board_invites
  for delete to authenticated
  using (public.board_role(board_id) = 'owner');


/**
 * Join a board with a link. Returns the board id, or null if the token buys
 * nothing.
 *
 * SECURITY DEFINER because the whole point is to act on a row the caller
 * cannot see: they hold a token, not a permission. It takes no identity —
 * auth.uid() is read here — and it can only ever add the caller to the board
 * the token names, at the role the owner chose.
 *
 * Redeeming twice is not an error. A link that has been pasted into a channel
 * gets used by several people and by the same person twice, and the second
 * time is a no-op rather than a failure — including for the owner, who needs
 * no membership row to reach their own board. `do nothing` rather than an
 * upsert of the role, so following a viewer link cannot take an editor's
 * access away from them.
 */
create or replace function public.redeem_board_invite(invite_token text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invite public.board_invites;
  caller uuid := (select auth.uid());
begin
  if caller is null or invite_token is null then
    return null;
  end if;

  select * into invite from public.board_invites where token = invite_token;
  if not found then
    return null;
  end if;

  if exists (
    select 1 from public.boards b where b.id = invite.board_id and b.owner_id = caller
  ) then
    return invite.board_id;
  end if;

  insert into public.board_members (board_id, user_id, role)
  values (invite.board_id, caller, invite.role)
  on conflict (board_id, user_id) do nothing;

  return invite.board_id;
end;
$$;

revoke execute on function public.redeem_board_invite(text) from public, anon;
grant execute on function public.redeem_board_invite(text) to authenticated;


/**
 * Who is on a board, with something to call them.
 *
 * board_members holds user ids, and a list of uuids is not a list of people.
 * Resolving them needs auth.users, so this is SECURITY DEFINER — and it is
 * bounded to the owner of the board asking about their own board's members,
 * so it discloses the addresses of people who have already joined and nothing
 * else. It is not a lookup: there is no way to ask it about an address.
 *
 * The owner is included, because a list of who can see a board that leaves out
 * its owner is a list that is wrong.
 */
create or replace function public.board_people(board text)
returns table (user_id uuid, email text, role text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- The union is wrapped so the ordering has named columns to sort on: across
  -- a UNION, `order by` can only see the output list, and an expression over
  -- it is not resolvable there at all.
  select * from (
    select b.owner_id as user_id, u.email::text as email, 'owner'::text as role
    from public.boards b
    join auth.users u on u.id = b.owner_id
    where b.id = board and public.board_role(board) = 'owner'

    union all

    select m.user_id, u.email::text, m.role
    from public.board_members m
    join auth.users u on u.id = m.user_id
    where m.board_id = board and public.board_role(board) = 'owner'
  ) people
  -- Not `order by role desc`: that sort is lexical, and descending puts
  -- 'viewer' above 'owner'. The owner leads because they are the owner, so
  -- say that rather than rely on where the word happens to fall.
  order by (people.role <> 'owner'), people.role, people.email nulls last;
$$;

revoke execute on function public.board_people(text) from public, anon;
grant execute on function public.board_people(text) to authenticated;
