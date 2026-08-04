-- Boards, membership, and the row level security that makes them private.
--
-- The table is shaped by the BoardRepository contract rather than the other
-- way round: list() is one indexed query, load() is a primary key lookup, and
-- save() is an upsert. The op log is not stored here yet — `doc` is the same
-- settled snapshot autosave has always written.

create table if not exists public.boards (
  id text primary key
    -- ids are generated on the client, before the row exists, because the
    -- route (/b/:id) is what the user is handed. Constrain the shape so a
    -- hand-edited URL cannot put arbitrary text in a primary key.
    constraint boards_id_shape check (id ~ '^[A-Za-z0-9_-]{1,64}$'),

  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled board',

  -- { v, order, objects } — the same payload store.toJSON() produces. The
  -- check mirrors isBoard() in platform/storage.js, so a malformed document
  -- is rejected at the same place whichever repository is in front of it.
  doc jsonb not null
    constraint boards_doc_shape check (
      jsonb_typeof(doc -> 'objects') = 'array' and jsonb_typeof(doc -> 'order') = 'array'
    ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- list() orders by recency within one owner, which is exactly this index.
create index if not exists boards_owner_updated_idx
  on public.boards (owner_id, updated_at desc);

create table if not exists public.board_members (
  board_id text not null references public.boards (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'editor' check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

-- "every board shared with me" — the reverse of the primary key.
create index if not exists board_members_user_idx on public.board_members (user_id);


-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

/**
 * The caller's role on a board: 'owner', 'editor', 'viewer', or null.
 *
 * SECURITY DEFINER is load-bearing. This function is called from the policies
 * on `boards` and it reads `boards` itself; under invoker rights that read is
 * subject to the very policy that called it, and Postgres unwinds the result
 * as `stack depth limit exceeded` rather than a wrong answer.
 *
 * The schema does happen to survive without it today, because every policy
 * tests `owner_id = auth.uid()` first and OR short-circuits before the call is
 * ever reached. That is a property of how these particular expressions are
 * written, not something the schema enforces — reorder one disjunct, or add a
 * policy that consults a role before an owner, and the recursion is back.
 * Running as the definer bypasses RLS on the inner reads, which makes
 * termination structural instead of incidental.
 *
 * That also makes this function the security boundary, so it takes no
 * caller-supplied identity — auth.uid() is read here, never passed in — and
 * execute is granted to `authenticated` only.
 */
create or replace function public.board_role(board text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (
      select 1 from public.boards b
      where b.id = board and b.owner_id = (select auth.uid())
    ) then 'owner'
    else (
      select m.role from public.board_members m
      where m.board_id = board and m.user_id = (select auth.uid())
    )
  end;
$$;

revoke execute on function public.board_role(text) from public, anon;
grant execute on function public.board_role(text) to authenticated;


/** Stamp updated_at server-side; a client clock is not evidence of recency. */
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger boards_touch_updated_at
  before update on public.boards
  for each row execute function public.touch_updated_at();


/**
 * Ownership is immutable.
 *
 * The update policy lets editors write, and an editor writing owner_id would
 * be handing the board to themselves — or to nobody. RLS cannot see the old
 * row, so this has to be a trigger.
 */
create or replace function public.freeze_board_owner()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'board owner cannot be changed';
  end if;
  return new;
end;
$$;

create or replace trigger boards_freeze_owner
  before update on public.boards
  for each row execute function public.freeze_board_owner();


alter table public.boards enable row level security;
alter table public.board_members enable row level security;

-- Anonymous sign-in still produces a real row in auth.users, so `authenticated`
-- covers a user who has not created an account yet. `anon` — no session at all
-- — is granted nothing.
grant select, insert, update, delete on public.boards to authenticated;
grant select, insert, update, delete on public.board_members to authenticated;


-- The owner_id test is stated first and separately in each policy so the
-- common case (your own boards) is an index lookup, and board_role() is only
-- reached for boards that someone else owns.

create policy boards_select on public.boards
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.board_role(id) is not null);

create policy boards_insert on public.boards
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy boards_update on public.boards
  for update to authenticated
  using (owner_id = (select auth.uid()) or public.board_role(id) = 'editor')
  with check (owner_id = (select auth.uid()) or public.board_role(id) = 'editor');

-- Deleting is the owner's alone: an editor can empty a board but not remove it
-- from everyone else's list.
create policy boards_delete on public.boards
  for delete to authenticated
  using (owner_id = (select auth.uid()));


create policy board_members_select on public.board_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.board_role(board_id) = 'owner');

create policy board_members_insert on public.board_members
  for insert to authenticated
  with check (public.board_role(board_id) = 'owner');

create policy board_members_update on public.board_members
  for update to authenticated
  using (public.board_role(board_id) = 'owner')
  with check (public.board_role(board_id) = 'owner');

-- An owner can revoke anyone; a member can hand back their own access.
create policy board_members_delete on public.board_members
  for delete to authenticated
  using (public.board_role(board_id) = 'owner' or user_id = (select auth.uid()));
