-- The board list, as a query the database can answer a page at a time.
--
-- `list()` has never had a `where` clause. That was right when it was written —
-- row level security decides what you can see, and a filter in the client would
-- have been a second, weaker copy of the policies — and it stayed cheap because
-- "every board you can see" was your own plus a handful shared with you.
--
-- Organizations changed the arithmetic. One invite to a team with five hundred
-- boards makes every load of your *personal* list fetch five hundred rows to
-- render three of them, and `boards_select` runs `board_role()` on each of the
-- ones you do not own. The list has to be scoped in the database, and it has to
-- be scoped before it can be paginated: cutting the page here and filtering it
-- in the browser gives pages of unpredictable size, and no way to tell "that is
-- all of them" from "this page happened to be entirely somebody's team".
--
-- A view rather than a function, so `list()` keeps using the query builder and
-- keeps saying what it wants rather than calling a procedure that decides for
-- it. `security_invoker` is the whole reason this is safe: the view runs as the
-- caller, so every policy on `boards` applies exactly as it does today and this
-- adds no access of its own. Without it a view runs as its owner and would hand
-- every board to everybody.

create or replace view public.board_summaries
with (security_invoker = on) as
select
  b.id,
  b.owner_id,
  b.title,
  b.updated_at,
  b.org_id,

  /**
   * Whether this board belongs on the personal list.
   *
   * Not `org_id is null`, which is the obvious answer and the wrong one. A
   * board can be shared with you directly *and* live in an organization you
   * are not in — you can reach it, and the organization is not a place you can
   * open — so filtering on a null org_id would leave it with nowhere to appear
   * at all. "Not filed under an organization I can open" is the actual rule,
   * and `org_role()` is what already knows it.
   *
   * The cheap half is tested first: a personal board short-circuits on
   * `org_id is null` and never reaches the function.
   */
  (b.org_id is null or public.org_role(b.org_id) is null) as personal
from public.boards b;

-- `doc` is deliberately absent. It is the whole board document, it is the
-- largest column by a wide margin, and a list has never had any use for it —
-- `list()` selected around it before and now cannot select it by mistake.

grant select on public.board_summaries to authenticated;

-- Same reason as every other object here: a hosted project's default privileges
-- hand new objects to `anon`, and 20260805153000 explains why that is taken back
-- next to the thing that needs it rather than in one central place.
revoke all on public.board_summaries from anon;


/**
 * The seek an organization's list makes, with the tiebreak it pages on.
 *
 * Replaces `boards_org_updated_idx` from 20260808120000. Ordering by
 * `updated_at` alone is not a total order — two boards saved in the same
 * microsecond tie — and a page boundary landing inside a tie is how keyset
 * pagination silently skips a row or serves it twice. `id` breaks it, and it
 * has to be in the index for the seek to stay an index seek.
 */
drop index if exists public.boards_org_updated_idx;

create index if not exists boards_org_updated_id_idx
  on public.boards (org_id, updated_at desc, id desc)
  where org_id is not null;

-- The personal scope gets no index of its own. Its predicate is
-- `org_id is null or org_role(org_id) is null`, and the second half is a
-- function call that no index can answer — but the boards it matches are
-- overwhelmingly your own, which `boards_owner_updated_idx` already covers
-- through the policy's `owner_id = auth.uid()`. An index stating otherwise
-- would be a claim about a plan nobody has measured.
