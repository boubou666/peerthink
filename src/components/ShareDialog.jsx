import { useCallback, useEffect, useState } from 'react';

import { joinUrl, sharing } from '../shell/sharing.js';

const ROLES = [
  ['editor', 'edit'],
  ['viewer', 'view'],
];

/**
 * Hand a board out, and see who is holding it.
 *
 * Only the owner ever sees anything here: `people()` answers nobody for
 * everyone else, and the link cannot be read without the row the policies
 * gate. So an editor who opens this is told what is true — they are on the
 * board, and it is not theirs to share.
 */
export function ShareDialog({ boardId, title, onClose, onLeave }) {
  const [invite, setInvite] = useState(null);
  const [people, setPeople] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const [link, members] = await Promise.all([
      sharing.invite(boardId),
      sharing.people(boardId),
    ]);
    return { link, members };
  }, [boardId]);

  useEffect(() => {
    let live = true;
    refresh().then(({ link, members }) => {
      if (!live) return;
      setInvite(link);
      setPeople(members);
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
    } finally {
      setBusy(false);
    }
  };

  const createOrChange = (role) =>
    run(async () => {
      const link = await sharing.share(boardId, role);
      if (!link) return setError('Could not create a link. Only the board’s owner can share it.');
      setInvite(link);
      setCopied(false);
    });

  const revoke = () =>
    run(async () => {
      if (!(await sharing.revoke(boardId))) return setError('Could not revoke the link.');
      setInvite(null);
      setCopied(false);
    });

  const remove = (userId) =>
    run(async () => {
      if (!(await sharing.remove(boardId, userId))) return setError('Could not remove them.');
      setPeople(await sharing.people(boardId));
    });

  /**
   * The clipboard is refused in plenty of situations — no permission, no
   * secure context, a browser that simply will not. The link is on screen and
   * selectable either way, so this reports and moves on.
   */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl(invite.token));
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

  // board_people() answers nobody unless the caller owns the board, so an
  // empty list is not an empty board — it is somebody else's.
  const owned = people !== null && people.length > 0;

  return (
    <div className="share-backdrop" data-share-dialog onPointerDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="share" role="dialog" aria-label={`Share ${title}`}>
        <header className="share-header">
          <h2>Share “{title}”</h2>
          <button type="button" data-action="close-share" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {error && <p className="error" role="alert" data-error>{error}</p>}

        {people === null ? (
          <p className="empty" data-loading>Loading…</p>
        ) : !owned ? (
          <>
            <p className="empty" data-not-owner>
              You are on this board, but it is not yours to share.
            </p>
            {/* The one thing a member can do about their own access. */}
            <button
              type="button"
              className="link"
              data-action="leave-board"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (await sharing.leave(boardId)) onLeave?.();
                  else setError('Could not leave the board.');
                })
              }
            >
              Leave this board
            </button>
          </>
        ) : (
          <>
            <div className="share-link">
              <label>
                <span>Anyone with the link can</span>
                <select
                  data-action="link-role"
                  disabled={busy}
                  value={invite?.role ?? 'editor'}
                  onChange={(e) => createOrChange(e.target.value)}
                >
                  {ROLES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>

              {invite ? (
                <div className="share-url">
                  <input readOnly value={joinUrl(invite.token)} data-share-url onFocus={(e) => e.target.select()} />
                  <button type="button" className="primary" data-action="copy-link" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button type="button" className="link" data-action="revoke-link" disabled={busy} onClick={revoke}>
                    Revoke
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="primary"
                  data-action="create-link"
                  disabled={busy}
                  onClick={() => createOrChange('editor')}
                >
                  Create a link
                </button>
              )}
            </div>

            <h3 className="share-people-title">People with access</h3>
            <ul className="share-people">
              {people.map((person) => (
                <li key={person.id} data-person={person.id}>
                  <span className="share-person-name">{person.email ?? 'Guest'}</span>
                  <span className="share-person-role">{person.role}</span>
                  {person.role !== 'owner' && (
                    <button
                      type="button"
                      className="link"
                      data-action="remove-person"
                      disabled={busy}
                      onClick={() => remove(person.id)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
