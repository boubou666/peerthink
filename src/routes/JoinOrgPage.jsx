import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { organizations } from '../shell/organizations.js';

/**
 * The other end of an organization link.
 *
 * `JoinPage` for a team. Redeeming needs a session, which the account gate has
 * already produced by the time this renders — including an anonymous one, so
 * following a link is the whole of joining. Creating an organization takes a
 * real account; being invited into one does not.
 *
 * A token that buys nothing gets one answer for every reason it might not work:
 * revoked, mistyped, or never real. Distinguishing them would turn this page
 * into somewhere to test guesses.
 */
export function JoinOrgPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);

    organizations.redeem(token).then((orgId) => {
      if (!live) return;
      // Onto the organization's board list, which is the thing the link was
      // an invitation to — not the personal one they were already able to see.
      if (orgId) navigate(`/o/${orgId}`, { replace: true });
      else setFailed(true);
    });

    return () => {
      live = false;
    };
  }, [token, navigate]);

  if (!failed) {
    return (
      <div className="shell">
        <p className="empty" data-loading>Joining…</p>
      </div>
    );
  }

  return (
    <div className="shell" data-join-failed>
      <h1>That link does not work</h1>
      <p className="empty">
        It may have been revoked, or it may never have been a link at all. Ask
        whoever invited you for a new one.
      </p>
      <Link to="/">Back to your boards</Link>
    </div>
  );
}
