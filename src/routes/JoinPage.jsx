import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { sharing } from '../shell/sharing.js';

/**
 * The other end of a share link.
 *
 * Redeeming needs a session, which the account gate has already produced by
 * the time this renders — including an anonymous one, so following a link is
 * the whole of joining a board. Nobody is asked to make an account first.
 *
 * A token that buys nothing gets one answer for every reason it might not
 * work: revoked, mistyped, or never real. Distinguishing them would turn this
 * page into somewhere to test guesses.
 */
export function JoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);

    sharing.redeem(token).then((boardId) => {
      if (!live) return;
      if (boardId) navigate(`/b/${boardId}`, { replace: true });
      else setFailed(true);
    });

    return () => {
      live = false;
    };
  }, [token, navigate]);

  if (!failed) {
    return (
      <div className="shell">
        <p className="empty" data-loading>Opening the board…</p>
      </div>
    );
  }

  return (
    <div className="shell" data-join-failed>
      <h1>That link does not work</h1>
      <p className="empty">
        It may have been revoked, or it may never have been a link at all. Ask
        whoever shared the board for a new one.
      </p>
      <Link to="/">Back to your boards</Link>
    </div>
  );
}
