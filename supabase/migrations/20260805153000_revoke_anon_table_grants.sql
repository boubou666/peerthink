-- Take back the table privileges a hosted project hands to `anon`.
--
-- `20260804101204_boards.sql` grants each table to `authenticated` and says in
-- as many words that `anon` is granted nothing. That is true on the local
-- stack and false on a hosted project, which ships
--
--   alter default privileges for role postgres in schema public
--     grant all on tables to anon, authenticated, service_role;
--
-- and creates these tables as `postgres` when `supabase db push` applies them.
-- So every table arrived carrying `grant all ... to anon`. Locally the
-- migrations are applied by another role, the default privilege never fires,
-- and the two environments disagreed silently until the RLS suite was pointed
-- at production and `no session sees nothing at all` stopped failing closed.
--
-- Nothing was exposed: every policy is `to authenticated`, so RLS finds no
-- policy for `anon` and default-denies. What was missing is the layer beneath
-- the policies — the one that refuses outright, and so would still hold if a
-- policy were later written too loosely. This states it in SQL instead of
-- inheriting it from whichever role happened to run the file.
--
-- A table added later will arrive with the same grant. Revoke it here too.

revoke all on public.boards from anon;
revoke all on public.board_members from anon;
revoke all on public.board_invites from anon;
