import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { AccountMenu } from '../components/AccountMenu.jsx';
import { useAsk } from '../components/AskDialog.jsx';
import { OrganizationDialog } from '../components/OrganizationDialog.jsx';
import { createIdGenerator } from '../core/ids.js';
import { DEFAULT_TITLE } from '../platform/storage.js';
import { auth } from '../shell/auth.js';
import { organizations } from '../shell/organizations.js';
import { seenBoardsFor } from '../shell/seen.js';
import { sharing } from '../shell/sharing.js';
import { repository } from '../shell/storage.js';

const newId = createIdGenerator();
const EMPTY_BOARD = { v: 1, order: [], objects: [] };

/**
 * A repository is allowed to reject — the contract says it answers rather than
 * throws, but the contract is a promise made by two implementations and not
 * something this page can enforce. Every call it makes now says so when it
 * fails, because the alternative is what this page used to do: sit on
 * "Loading…" for good, and throw an unhandled rejection on the way.
 */
const COULD_NOT_LIST = 'Could not load your boards. Check your connection and try again.';
const COULD_NOT_CREATE = 'Could not create a board — storage is full or unavailable.';
const COULD_NOT_DUPLICATE = 'Could not duplicate that board. Nothing was changed.';
const COULD_NOT_CHANGE = 'That change did not go through. Nothing was altered.';
const COULD_NOT_MAKE_ORG =
  'Could not create the organization. Registered accounts can make one — guests cannot.';

/** No organizations at all is what a build with no backend has, and it is not an error. */
const NO_ORGS = [];

const formatDate = (ms) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function BoardListPage() {
  const navigate = useNavigate();
  // Absent on `/`, an organization id on `/o/:orgId`. One page rather than two
  // because it is one list with a different question in front of it — and two
  // copies of the create/rename/delete plumbing would be two places for the
  // organization case to be forgotten.
  const { orgId } = useParams();

  /**
   * The organization whose boards are on screen, or null for the personal
   * list. This is what the repository is asked for — the filtering is the
   * database's, not this page's. `useParams` gives undefined off `/o/:orgId`
   * and the contract wants null, so it is normalised once, here.
   */
  const scope = orgId ?? null;

  // null is "not read yet", which is a different thing from "no boards" — the
  // empty state is a claim about the workspace and it should not be made until
  // the repository has actually answered. `boards` holds the pages loaded so
  // far for the scope on screen, and `cursor` is where the next one starts —
  // null meaning there is no next one.
  const [boards, setBoards] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [orgs, setOrgs] = useState(organizations ? null : NO_ORGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showOrg, setShowOrg] = useState(false);

  /**
   * Boards this browser has not shown for this account.
   *
   * Reconciled against every page that arrives, so a board that turns up while
   * the page is open is marked as readily as one that was there on load. The
   * record is per account and built per read rather than held, because the
   * account can change under a page that stays mounted.
   */
  const [unseen, setUnseen] = useState(() => new Set());

  // Renaming, deleting and leaving all ask something first. See AskDialog.
  const [askDialog, ask] = useAsk();

  /**
   * Whether this browser had no record for this account when the list loaded.
   *
   * A first look seeds rather than announcing — everything already in the
   * workspace is the workspace, not news — and pagination stretches that first
   * look across several requests. Without this, page one would seed silently
   * and every page after it would arrive covered in badges, which is the exact
   * noise seeding exists to avoid. A ref because it is read inside a callback
   * and must not itself cause a render.
   */
  const firstLook = useRef(false);

  /**
   * The scope the list on screen belongs to.
   *
   * `loadMore` closes over `scope` from the render that made it, so comparing
   * that against `scope` inside it compares a value with itself and can never
   * notice a navigation. A ref is read at the moment the answer lands, which
   * is the only time the question is worth asking — set in the effect below
   * rather than during render, because effects run before the browser paints
   * and so before any click that could start a page request.
   */
  const showing = useRef(scope);

  /**
   * `append` is the difference between a fresh scope and another page of the
   * one already on screen. `reconcile` answers only about the ids it was
   * given, so a second page's answer has to be added to what is showing rather
   * than replace it — otherwise loading more would clear every badge above.
   */
  const reconcile = useCallback((page, { append = false } = {}) => {
    const id = auth.current()?.id;
    // No account is no record to keep. Nothing below here renders without one
    // — RequireAccount sees to that — but a read in flight across a sign-out
    // can still land here, and inventing a key for nobody would file this
    // browser's history under a user that does not exist.
    if (!id) return;
    const fresh = seenBoardsFor(id)
      .reconcile(page.map((board) => board.id), { seed: firstLook.current });
    setUnseen((shown) => (append ? new Set([...shown, ...fresh]) : fresh));
  }, []);

  const readOrgs = useCallback(
    () => (organizations ? organizations.list() : Promise.resolve(NO_ORGS)),
    [],
  );

  /**
   * Just the switcher, re-read.
   *
   * What you leave or delete changes which organizations exist for you and
   * nothing about the scope you are being sent to — the effect below already
   * loads that. Re-reading the boards as well would read them *for the scope
   * being left*, because this closes over the scope it was made in, and that
   * answer can land after the navigation and leave the personal list showing
   * an organization that is gone.
   */
  const refreshOrgs = useCallback(
    () => readOrgs().then(setOrgs, () => setError(COULD_NOT_LIST)),
    [readOrgs],
  );

  /**
   * Page one of the current scope, and the organizations the switcher offers.
   *
   * Together, because a mutation can change either — removing someone from an
   * organization changes both what they are in and what they can see — and a
   * page holding a fresh half beside a stale half would file boards under the
   * wrong heading.
   */
  const refresh = useCallback(
    () => Promise.all([repository.list({ scope }), readOrgs()]).then(
      ([page, mine]) => {
        setBoards(page.boards);
        setCursor(page.cursor);
        setOrgs(mine);
        reconcile(page.boards);
        setError(null);
      },
      () => setError(COULD_NOT_LIST),
    ),
    [scope, readOrgs, reconcile],
  );

  /**
   * The switcher's contents, read once. Not folded into the effect below,
   * which re-runs on every scope change: which organizations you are in does
   * not depend on which of them you are looking at, and re-reading it on every
   * switch would spend a request to learn what it already knew.
   */
  useEffect(() => {
    let live = true;
    readOrgs().then(
      (mine) => {
        if (live) setOrgs(mine);
      },
      () => {
        if (live) setError(COULD_NOT_LIST);
      },
    );
    return () => {
      live = false;
    };
  }, [readOrgs]);

  /**
   * Page one, whenever the scope changes.
   *
   * Reset to `null` first rather than left showing the last scope's boards: the
   * heading changes immediately and the list would be somebody else's for as
   * long as the request took, which is a worse answer than "Loading…".
   */
  useEffect(() => {
    let live = true;
    showing.current = scope;
    setBoards(null);
    setCursor(null);

    // Asked before the first page rather than after it, because the first page
    // is what creates the record: afterwards there is always one, and every
    // visit would look like a return visit.
    const account = auth.current()?.id;
    firstLook.current = account ? !seenBoardsFor(account).hasRecord() : false;

    repository.list({ scope }).then(
      (page) => {
        if (!live) return;
        setBoards(page.boards);
        setCursor(page.cursor);
        reconcile(page.boards);
      },
      () => {
        if (live) setError(COULD_NOT_LIST);
      },
    );
    return () => {
      live = false;
    };
  }, [scope, reconcile]);

  /** The caller's role in an organization, or null if they are not in it. */
  const roleIn = useCallback(
    (id) => (id ? (orgs ?? NO_ORGS).find((org) => org.id === id)?.role ?? null : null),
    [orgs],
  );

  const current = orgId ? (orgs ?? NO_ORGS).find((org) => org.id === orgId) : null;

  /**
   * Whether a board can be put into the scope on screen.
   *
   * Your personal space always takes one. An organization takes one from
   * anybody but a viewer — and from nobody at all until it is known to be
   * yours, which is what `current` being absent means while the switcher is
   * still loading.
   *
   * One expression for both the buttons that make a board, because two would
   * be two chances to disagree: creating and duplicating land the same row
   * through the same policy, and a control that is offered where the write
   * will be refused is a control that lies.
   */
  const canAddBoards = orgId ? Boolean(current) && current.role !== 'viewer' : true;

  /**
   * The next page, appended.
   *
   * `busy` covers this like every other read, which also stops a second click
   * paging twice from the same cursor and showing the same boards under
   * themselves.
   */
  const loadMore = async () => {
    if (!cursor) return;
    setBusy(true);

    // Which list this page was asked for. Switching scope while it is in
    // flight would otherwise append a team's boards under the personal ones
    // and install that team's cursor — and the effect above cannot help,
    // because its `live` flag only guards its own request.
    const asked = scope;
    try {
      const page = await repository.list({ scope: asked, after: cursor });
      if (showing.current !== asked) return;

      setBoards((shown) => [...(shown ?? []), ...page.boards]);
      setCursor(page.cursor);
      reconcile(page.boards, { append: true });
      setError(null);
    } catch {
      // The boards already on screen are still good; only the page that did
      // not arrive is missing, and the button is still there to try again.
      // Silent if the scope has moved on: it is a failure to extend a list
      // nobody is looking at any more.
      if (showing.current === asked) setError(COULD_NOT_LIST);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Opening a board is what clears its badge — not listing it. A mark made on
   * the way past would be gone before it had been read.
   */
  const open = useCallback((id) => {
    const account = auth.current()?.id;
    if (account) seenBoardsFor(account).markSeen(id);
    navigate(`/b/${id}`);
  }, [navigate]);

  /**
   * Run a mutation, then re-read. `busy` is what stops a second click landing
   * on a list that the first click has already invalidated but not yet
   * refreshed — a window that does not exist against Web Storage and is wide
   * open against a server.
   */
  const mutate = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch {
      // Only the mutation can land here — `refresh` reports its own failure —
      // so this is the one message that can promise nothing changed.
      setError(COULD_NOT_CHANGE);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A re-read on its own, marked as one.
   *
   * Every read this page makes has to raise `busy`, and not only so the
   * buttons go dead: `data-busy` is the one honest signal that what is on
   * screen is settled, and a read nobody marked is a page that claims to be
   * finished while its answer is still in flight. A bare `refresh()` after
   * leaving an organization did exactly that — the switcher went on offering
   * the organization that had just been left, and only for as long as the
   * request took, which is the kind of window that is invisible on a laptop
   * and reproducible on a loaded machine.
   *
   * It is also what stops a retry click landing twice: without it the button
   * that started the read stays enabled over a list that is still `null`, and
   * the two answers land in whichever order they come back.
   */
  const reload = async () => {
    setBusy(true);
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /** The same, for the switcher alone. */
  const reloadOrgs = async () => {
    setBusy(true);
    try {
      await refreshOrgs();
    } finally {
      setBusy(false);
    }
  };

  /**
   * A board created here starts empty. Only a first-ever visit gets the
   * starter board, which is a tour rather than content you asked for.
   *
   * Navigating before confirming the write would open a route with no stored
   * record, which createApp treats as a first visit and seeds — so a failed
   * save would hand back a board full of starter content.
   */
  const create = async () => {
    setBusy(true);
    try {
      const id = newId();
      // Born where you are looking. Creating a board inside an organization is
      // the ordinary way one gets there — `move` is for the board that was
      // already somewhere else.
      const placed = { title: DEFAULT_TITLE, ...(orgId ? { orgId } : {}) };
      if (!(await repository.save(id, EMPTY_BOARD, placed))) {
        setError(COULD_NOT_CREATE);
        return;
      }
      setError(null);
      // Through `open`, so a board you just made is not waiting with a "New"
      // badge when you come back to the list. You have seen it — you are about
      // to be looking at it.
      open(id);
    } catch {
      // Refusing and rejecting are the same event to the person clicking the
      // button, and neither one navigated anywhere.
      setError(COULD_NOT_CREATE);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id, title) => {
    const agreed = await ask.confirm({
      title: `Delete “${title}”?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (agreed) await mutate(() => repository.remove(id));
  };

  /**
   * A board someone shared with you is not yours to delete — the policies
   * would refuse, and refusing quietly would look like a board that came back.
   * So the card offers what is actually available: hand the access back, and
   * it leaves your list without leaving anyone else's.
   */
  const leave = async (id, title) => {
    const agreed = await ask.confirm({
      title: `Leave “${title}”?`,
      message: 'You will need a new link to get back in.',
      confirmLabel: 'Leave',
    });
    if (agreed) await mutate(() => sharing.leave(id));
  };

  const rename = async (id, currentTitle) => {
    const next = await ask.prompt({
      title: 'Rename board',
      label: 'Board name',
      value: currentTitle,
      confirmLabel: 'Rename',
    });
    // null is the question being dismissed; an unchanged or blank name is it
    // being answered with nothing to do. Neither is a write.
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === currentTitle) return;
    await mutate(() => repository.rename(id, trimmed));
  };

  /** Where a board lives. `''` is the personal space, which has no id. */
  const move = (id, value) => mutate(() => repository.move(id, value || null));

  /**
   * A board again, under a new id, belonging to whoever made the copy.
   *
   * Read then write, which is the whole of it: the document is copied
   * verbatim, so a board with sheets arrives with all of them and nothing here
   * has to know what a sheet is.
   *
   * What is deliberately *not* copied is who could see the original. A copy is
   * a new board owned by the person making it, and its members are nobody —
   * carrying them across would hand people access to a board they have never
   * heard of, silently, because somebody pressed Duplicate. It is also why
   * this is offered on a board shared with you: making your own copy is the
   * one thing you can do with someone else's board without touching theirs.
   *
   * Born where you are looking, as `create` is: the copy appears in the list
   * that is on screen rather than in whichever scope the original happened to
   * live in.
   */
  const duplicate = async (id, title) => {
    setBusy(true);
    try {
      const record = await repository.load(id);
      if (!record) {
        setError(COULD_NOT_DUPLICATE);
        return;
      }

      const copy = newId();
      const placed = { title: `${title} (copy)`, ...(orgId ? { orgId } : {}) };
      if (!(await repository.save(copy, record.board, placed))) {
        setError(COULD_NOT_DUPLICATE);
        return;
      }

      // Seen, without being opened. `open` is what usually marks a board as
      // looked at, and a copy you just made arriving in your own list with a
      // "New" badge on it would be the badge telling you about your own click.
      const account = auth.current()?.id;
      if (account) seenBoardsFor(account).markSeen(copy);

      setError(null);
      await refresh();
    } catch {
      setError(COULD_NOT_DUPLICATE);
    } finally {
      setBusy(false);
    }
  };

  const createOrg = async () => {
    const name = await ask.prompt({
      title: 'New organization',
      label: 'Name',
      message: 'Boards you make in it are shared with everyone you invite.',
      confirmLabel: 'Create',
    });
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    setBusy(true);
    try {
      const made = await organizations.create(newId(), trimmed);
      if (!made) {
        // The likeliest refusal by far, and the one worth naming: creating an
        // organization wants a real account, and most people here are guests.
        setError(COULD_NOT_MAKE_ORG);
        return;
      }
      setError(null);
      // Re-read before navigating, not after. The effect above runs on mount
      // and this page stays mounted across a scope change, so `orgs` would
      // still be the list from before this organization existed — and the
      // scope we are about to open would render as one that is not yours.
      // Only the switcher: the boards for the scope we are about to open are
      // loaded by the effect that watches it, and re-reading them here would
      // be a read of the scope we are leaving.
      await refreshOrgs();
      navigate(`/o/${made.id}`);
    } catch {
      setError(COULD_NOT_MAKE_ORG);
    } finally {
      setBusy(false);
    }
  };

  /**
   * What the card offers for getting rid of a board, which is not the same
   * question as who may edit it.
   *
   * Owning it, or owning the organization holding it, is what Delete takes.
   * Everyone else on an organization's board gets neither: their access came
   * from the organization and it is the organization they would leave, so a
   * Leave button here would be a promise this card cannot keep.
   */
  const disposalOf = (board) => {
    if (board.owned || roleIn(board.orgId) === 'owner') return 'delete';
    return board.orgId && roleIn(board.orgId) ? 'none' : 'leave';
  };

  /** The organizations a board can be put into: the ones you may add boards to. */
  const destinations = (orgs ?? NO_ORGS).filter((org) => org.role !== 'viewer');
  const canMove = (board) => board.owned || roleIn(board.orgId) === 'owner';

  /**
   * Where this board could go, including where it already is.
   *
   * You own a board in a team you have since been made a viewer of: it can be
   * taken out, but the team is not somewhere you may put boards, so it is not
   * in `destinations`. A select whose value matches none of its options falls
   * back to the first — which here is "Personal", and would have the card
   * quietly claiming the board is somewhere it is not.
   */
  const placesFor = (board) => {
    if (!board.orgId || destinations.some((org) => org.id === board.orgId)) return destinations;
    const here = (orgs ?? NO_ORGS).find((org) => org.id === board.orgId);
    return [...destinations, { id: board.orgId, name: here?.name ?? 'Its organization' }];
  };

  const heading = orgId ? (current?.name ?? 'Organization') : 'Boards';

  return (
    // data-busy marks a read or write in flight. It drives nothing visually on
    // its own — the disabled buttons do that — but it is the one honest signal
    // that the list on screen is settled, which is what the browser tests wait
    // on instead of assuming a click has already landed.
    <div className="shell" {...(busy ? { 'data-busy': '' } : {})}>
      <header className="shell-header">
        <h1 data-scope-name>{heading}</h1>
        <div className="shell-header-actions">
          {organizations && orgs !== null && (
            <>
              <select
                className="scope-switcher"
                aria-label="Workspace"
                data-action="scope"
                value={orgId ?? ''}
                disabled={busy}
                onChange={(e) => navigate(e.target.value ? `/o/${e.target.value}` : '/')}
              >
                <option value="">Personal</option>
                {orgs.map((org) => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>

              <button type="button" data-action="new-org" disabled={busy} onClick={createOrg}>
                New organization
              </button>
            </>
          )}

          {current && (
            <button type="button" data-action="org-people" onClick={() => setShowOrg(true)}>
              People
            </button>
          )}

          <AccountMenu />
          <button
            type="button"
            className="primary"
            data-action="new-board"
            disabled={busy || !canAddBoards}
            onClick={create}
          >
            New board
          </button>
        </div>
      </header>

      {error && (
        <p className="error" role="alert" data-error>
          {error}
          {error === COULD_NOT_LIST && (
            <button type="button" data-action="retry-list" disabled={busy} onClick={reload}>
              Try again
            </button>
          )}
        </p>
      )}

      {boards === null || orgs === null ? (
        // A first read that failed has no list to show, and "no boards yet" is
        // a claim about someone's account that a request which never arrived
        // cannot support. The message above is the whole of what is known.
        //
        // The organizations are waited for too, and not only to fill the
        // switcher: whether this scope is one of yours is a question only that
        // list answers, and rendering before it lands would tell someone their
        // own organization is not theirs for as long as the request took.
        error ? null : <p className="empty" data-loading>Loading…</p>
      ) : orgId && !current ? (
        // The scope was asked for and is not one of yours. Every reason for
        // that — never invited, removed since, or a hand-edited URL — gets the
        // same answer, for the same reason the join page gives one.
        <p className="empty" data-no-org>
          That organization is not one of yours.{' '}
          <button type="button" className="link" data-action="back-personal" onClick={() => navigate('/')}>
            Back to your boards
          </button>
        </p>
      ) : boards.length === 0 ? (
        <p className="empty" data-empty>
          {orgId
            ? 'No boards here yet. Anything you create is shared with everyone in the organization.'
            : 'No boards yet. Create one to get started.'}
        </p>
      ) : (
        <ul className="board-grid">
          {boards.map((board) => (
            <li key={board.id} className="board-card" data-board-id={board.id}>
              <button
                type="button"
                className="board-card-open"
                onClick={() => open(board.id)}
              >
                <span className="board-card-title">
                  {board.title}
                  {/* "New here", not "newly shared" — this side knows what it
                      has shown, and cannot tell why a board turned up. */}
                  {unseen.has(board.id) && (
                    <span className="board-card-new" data-new> New</span>
                  )}
                </span>
                <span className="board-card-meta">Edited {formatDate(board.updatedAt)}</span>
              </button>

              <div className="board-card-actions">
                <button
                  type="button"
                  data-action="rename"
                  disabled={busy}
                  onClick={() => rename(board.id, board.title)}
                >
                  Rename
                </button>

                {/* Offered on every board, including one shared with you:
                    making your own copy is the one thing you can do with
                    somebody else's board without touching theirs.

                    Disabled where a board cannot be made, which is the rule
                    the New board button follows — a viewer of a team can read
                    its boards and add none, and a Duplicate that was refused
                    by the database would be this card promising otherwise. */}
                <button
                  type="button"
                  data-action="duplicate"
                  disabled={busy || !canAddBoards}
                  onClick={() => duplicate(board.id, board.title)}
                >
                  Duplicate
                </button>

                {/* Offered only where there is somewhere to move to and the
                    standing to do it. A select rather than a button because
                    the question is "where", and it is the one control on this
                    card that has more than one answer. */}
                {destinations.length > 0 && canMove(board) && (
                  <select
                    aria-label={`Move ${board.title}`}
                    data-action="move"
                    disabled={busy}
                    value={board.orgId ?? ''}
                    onChange={(e) => move(board.id, e.target.value)}
                  >
                    <option value="">Personal</option>
                    {placesFor(board).map((org) => (
                      <option key={org.id} value={org.id}>{org.name}</option>
                    ))}
                  </select>
                )}

                {disposalOf(board) === 'leave' && (
                  <button
                    type="button"
                    data-action="leave"
                    disabled={busy}
                    onClick={() => leave(board.id, board.title)}
                  >
                    Leave
                  </button>
                )}
                {disposalOf(board) === 'delete' && (
                  <button
                    type="button"
                    data-action="delete"
                    disabled={busy}
                    onClick={() => remove(board.id, board.title)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/*
        A button rather than a scroll listener. What is on screen is then a
        consequence of something the reader did, so nothing loads behind their
        back — and "that is all of them" is said once, by the button being
        absent, instead of being inferred from a scroll that stopped happening.

        Outside the branch above so it survives the empty case being empty for
        this page only: a scope whose first page is entirely boards you may not
        see is not a scope with nothing in it.
      */}
      {cursor && boards !== null && (
        <button
          type="button"
          className="link"
          data-action="load-more"
          disabled={busy}
          onClick={loadMore}
        >
          Load more
        </button>
      )}

      {askDialog}

      {showOrg && current && (
        <OrganizationDialog
          org={current}
          onClose={() => setShowOrg(false)}
          // Through `reload`, not `refresh`: every read this page makes has to
          // raise `busy`, or the list claims to be settled while the answer to
          // a rename, a removal or an appointment is still in flight.
          onChanged={reload}
          // Leaving or deleting the organization you are looking at means you
          // can no longer look at it; the personal list is the only place left
          // to be.
          //
          // Navigate first, then re-read. The other order re-renders this
          // scope against a list that no longer contains it, which is a flash
          // of "that organization is not one of yours" on the way out — true,
          // but a strange last thing to say to someone who just deleted it.
          onGone={() => {
            navigate('/', { replace: true });
            reloadOrgs();
          }}
        />
      )}
    </div>
  );
}
