-- A version on the document, so a stale writer cannot overwrite a fresh one.
--
-- Every editor autosaves the whole board on its own timer. While everyone is
-- in sync that is merely wasteful — the snapshots are identical — but a client
-- whose view has fallen behind writes its stale document over the top of work
-- it never saw. Broadcast makes that rarer and more expensive: rarer because
-- everyone converges, more expensive because there is now more to lose.
--
-- The fix has two halves and this is the second one. A single writer is
-- elected among the people on the board, which is what stops the overwrite in
-- the normal case; this is what stops it in the case election cannot see — a
-- client that has lost the channel, elects itself, and keeps saving. It writes
-- with the version it last read, and the update matches nothing.
--
-- The counter belongs to `doc` alone. A rename is not a competing edit to the
-- document, and bumping the version for one would refuse the next honest save
-- for no reason.

alter table public.boards
  add column if not exists version bigint not null default 1;

create or replace function public.bump_board_version()
returns trigger
language plpgsql
as $$
begin
  -- Set by the trigger rather than by the client: the client's job is to say
  -- which version it believes it is replacing, and a writer that could also
  -- choose the next number could choose one that keeps it winning.
  if new.doc is distinct from old.doc then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

create or replace trigger boards_bump_version
  before update on public.boards
  for each row execute function public.bump_board_version();
