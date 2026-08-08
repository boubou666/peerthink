import { useCallback, useEffect, useState } from 'react';

import { organizations } from '../shell/organizations.js';
import { orgJoinUrl } from '../shell/sharing.js';

const ROLES = [
  ['editor', 'edit'],
  ['viewer', 'view'],
];

/**
 * Hand an organization out, and see who is holding it.
 *
 * `ShareDialog` for a whole team rather than one board, and deliberately the
 * same shape — the link, what it grants, and who took it up. What it adds is
 * the two things an organization has that a board does not: a name that can be
 * changed, and a way to get rid of it that does not get rid of the work.
 *
 * Only the owner ever sees any of that. `organization_people()` answers nobody
 * for everyone else and the link cannot be read without the row the policies
 * gate, so a member who opens this is told what is true — they are in it, and
 * it is not theirs to hand out.
 */
export function OrganizationDialog({ org, onClose, onChanged, onGone }) {
  const [invite, setInvite] = useState(null);
  const [people, setPeople] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const [link, members] = await Promise.all([
      organizations.invite(org.id),
      organizations.people(org.id),
    ]);
    return { link, members };
  }, [org.id]);

  useEffect(() => {
    let live = true;
    refresh()
      .then(({ link, members }) => {
        if (!live) return;
        setInvite(link);
        setPeople(members);
      })
      .catch(() => {
        // `people === null` is the loading state, so a read that never
        // resolves leaves the dialog spinning forever. An empty list is the
        // honest fallback: it is what someone without the owner's sight sees.
        if (!live) return;
        setPeople([]);
        setError('Could not read who is in this organization.');
      });
    return () => {
      live = false;
    };
  }, [refresh]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const createOrChange = (role) =>
    run(async () => {
      const link = await organizations.share(org.id, role);
      if (!link) return setError('Could not create a link. Only the owner can hand this out.');
      setInvite(link);
      setCopied(false);
    });

  const revoke = () =>
    run(async () => {
      if (!(await organizations.revoke(org.id))) return setError('Could not revoke the link.');
      setInvite(null);
      setCopied(false);
    });

  const removeMember = (userId) =>
    run(async () => {
      if (!(await organizations.removeMember(org.id, userId))) {
        return setError('Could not remove them.');
      }
      setPeople(await organizations.people(org.id));
      // Their boards are gone from this organization's list for them, not for
      // anyone else — but the page behind is now showing a membership that has
      // changed, so it re-reads.
      onChanged?.();
    });

  /**
   * Hand the organization over.
   *
   * The confirm names what it costs, because the button does not: the person
   * pressing it stops being the owner, and every owner-only thing on this
   * screen — the link, this list, renaming, deleting — goes with it. That is
   * not recoverable from this side afterwards; only the new owner can hand it
   * back.
   *
   * `people` is re-read rather than patched, and the answer is what closes the
   * owner's view: `organization_people()` answers nobody to anyone but the
   * owner, so the empty list this now returns is the dialog correctly
   * discovering it is no longer theirs.
   */
  const transfer = (person) =>
    run(async () => {
      const warning = `Make ${person.email} the owner of “${org.name}”? `
        + 'You stay in the organization as an editor, and only they can hand it back.';
      if (!window.confirm(warning)) return;

      if (!(await organizations.transfer(org.id, person.id))) {
        return setError('Could not hand it over. They may have left the organization.');
      }
      setPeople(await organizations.people(org.id));
      setInvite(null);
      onChanged?.();
    });

  /**
   * Appoint a second owner, or take the appointment back.
   *
   * No confirm on the way in: it is reversible from this same screen by the
   * person doing it, which is the difference between this and handing the
   * organization over. Taking it back is not confirmed either, for the same
   * reason in the other direction.
   */
  const setCoOwner = (person) =>
    run(async () => {
      if (!(await organizations.setCoOwner(org.id, person ? person.id : null))) {
        return setError(person
          ? 'Could not make them a second owner. They may have left the organization.'
          : 'Could not take the appointment back.');
      }
      setPeople(await organizations.people(org.id));
      // Their role in the switcher and every board power they hold changed
      // with it, so the page behind re-reads.
      onChanged?.();
    });

  const rename = () =>
    run(async () => {
      const next = window.prompt('Organization name', org.name);
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === org.name) return;

      if (!(await organizations.rename(org.id, trimmed))) {
        return setError('Could not rename it.');
      }
      onChanged?.();
    });

  /**
   * Deleting ends the sharing, not the work: every board inside falls back to
   * whoever created it. The confirm says so, because "delete the organization"
   * on its own reads like it takes the boards too — which is exactly the fear
   * that would stop someone tidying up.
   */
  const remove = () =>
    run(async () => {
      const warning = `Delete “${org.name}”? Everyone else loses access to its boards. `
        + 'Each board goes back to whoever created it — nothing is deleted.';
      if (!window.confirm(warning)) return;

      if (!(await organizations.remove(org.id))) return setError('Could not delete it.');
      onGone?.();
    });

  const leave = () =>
    run(async () => {
      if (!window.confirm(`Leave “${org.name}”? You will lose access to its boards.`)) return;
      if (await organizations.leave(org.id)) onGone?.();
      else setError('Could not leave the organization.');
    });

  /**
   * The clipboard is refused in plenty of situations — no permission, no
   * secure context, a browser that simply will not. The link is on screen and
   * selectable either way, so this reports and moves on.
   */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(orgJoinUrl(invite.token));
      setCopied(true);
    } catch {
      setError('Could not copy. Select the link and copy it yourself.');
    }
  };

  // A dialog that closes on Escape and on the backdrop, like every other one.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // organization_people() answers nobody unless the caller owns it, so an
  // empty list is not an empty organization — it is somebody else's.
  const owned = people !== null && people.length > 0;

  /**
   * Whether this is the owner of the *row* rather than one of the two people
   * running the organization.
   *
   * A second owner reaches everything above — the link, the roster, taking
   * somebody off — because `org_role()` answers 'owner' for them. What they do
   * not get is the four acts on the organization itself, so those are gated
   * here rather than by `owned`. The database refuses them either way; this is
   * so they are not offered.
   */
  const isPrimary = org.primary === true;

  return (
    <div className="share-backdrop" data-org-dialog onPointerDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="share" role="dialog" aria-label={`People in ${org.name}`}>
        <header className="share-header">
          <h2>{org.name}</h2>
          <button type="button" data-action="close-org" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {error && <p className="error" role="alert" data-error>{error}</p>}

        {people === null ? (
          <p className="empty" data-loading>Loading…</p>
        ) : !owned ? (
          <>
            <p className="empty" data-not-owner>
              You are in this organization, but it is not yours to hand out.
            </p>
            {/* The one thing a member can do about their own access. */}
            <button
              type="button"
              className="link"
              data-action="leave-org"
              disabled={busy}
              onClick={leave}
            >
              Leave this organization
            </button>
          </>
        ) : (
          <>
            <div className="share-link">
              <label>
                <span>Anyone with the link can</span>
                <select
                  data-action="org-link-role"
                  disabled={busy}
                  value={invite?.role ?? 'editor'}
                  onChange={(e) => createOrChange(e.target.value)}
                >
                  {ROLES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <span> every board in here</span>
              </label>

              {invite ? (
                <div className="share-url">
                  <input
                    readOnly
                    value={orgJoinUrl(invite.token)}
                    data-org-url
                    onFocus={(e) => e.target.select()}
                  />
                  <button type="button" className="primary" data-action="copy-org-link" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    className="link"
                    data-action="revoke-org-link"
                    disabled={busy}
                    onClick={revoke}
                  >
                    Revoke
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="primary"
                  data-action="create-org-link"
                  disabled={busy}
                  onClick={() => createOrChange('editor')}
                >
                  Create a link
                </button>
              )}
            </div>

            <h3 className="share-people-title">People</h3>
            <ul className="share-people">
              {people.map((person) => (
                <li key={person.id} data-person={person.id}>
                  <span className="share-person-name">{person.email ?? 'Guest'}</span>
                  <span className="share-person-role">{person.role}</span>
                  {/*
                    Handing the organization on, and appointing somebody to
                    help run it, are both the primary owner's alone — and both
                    are offered only to members with an address, which is the
                    nearest thing this list has to "is a real account", since a
                    guest comes back with a null email. The database refuses a
                    guest either way; this is so the button is not there to be
                    pressed in the first place.
                  */}
                  {isPrimary && person.role === 'co-owner' && (
                    <button
                      type="button"
                      className="link"
                      data-action="unmake-co-owner"
                      disabled={busy}
                      onClick={() => setCoOwner(null)}
                    >
                      Step down
                    </button>
                  )}
                  {isPrimary && person.role !== 'owner' && person.role !== 'co-owner' && person.email && (
                    <button
                      type="button"
                      className="link"
                      data-action="make-co-owner"
                      disabled={busy}
                      onClick={() => setCoOwner(person)}
                    >
                      Make co-owner
                    </button>
                  )}
                  {isPrimary && person.role !== 'owner' && person.email && (
                    <button
                      type="button"
                      className="link"
                      data-action="make-owner"
                      disabled={busy}
                      onClick={() => transfer(person)}
                    >
                      Make owner
                    </button>
                  )}
                  {person.role !== 'owner' && (
                    <button
                      type="button"
                      className="link"
                      data-action="remove-person"
                      disabled={busy}
                      onClick={() => removeMember(person.id)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {isPrimary ? (
              <div className="org-actions">
                <button type="button" className="link" data-action="rename-org" disabled={busy} onClick={rename}>
                  Rename
                </button>
                <button type="button" className="link" data-action="delete-org" disabled={busy} onClick={remove}>
                  Delete organization
                </button>
              </div>
            ) : (
              /* Said rather than left blank: the controls that are missing were
                 there for the person who appointed them, and their absence is
                 otherwise indistinguishable from a half-loaded dialog. */
              <p className="empty org-actions" data-second-owner>
                You are a second owner here. Renaming, deleting and handing this
                organization on stay with {people.find((p) => p.role === 'owner')?.email ?? 'its owner'}.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
