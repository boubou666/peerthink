-- Who may join a board's live channel.
--
-- Ops are broadcast on a private channel named `board:<id>`, and a private
-- channel is authorised by row level security on realtime.messages the same
-- way a table is. Without these policies the table has RLS enabled and no
-- policy, so every join is refused — which is the right default, and is why
-- this migration ships in the same change as the code that joins.
--
-- The topic is parsed rather than joined against: boards.id excludes ':' by
-- its own check constraint, so split_part gives back exactly the id. A topic
-- that is not a board's — anything else this project ever broadcasts on —
-- parses to a string board_role() knows nothing about and is refused, so the
-- default stays deny.
--
-- Reading and writing are separate policies because the roles differ: a viewer
-- watches a board change under them, and an editor is what it takes to change
-- it. That is the same split the boards table makes, resolved by the same
-- function, so there is one definition of what a role can do.

create policy board_broadcast_receive on realtime.messages
  for select to authenticated
  using (public.board_role(split_part(realtime.topic(), ':', 2)) is not null);

create policy board_broadcast_send on realtime.messages
  for insert to authenticated
  with check (
    public.board_role(split_part(realtime.topic(), ':', 2)) in ('owner', 'editor')
  );
