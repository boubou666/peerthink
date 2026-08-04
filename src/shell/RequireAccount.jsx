import { useEffect, useState } from 'react';

import { AccountForm } from '../components/AccountForm.jsx';
import { auth, useAccount } from './auth.js';

/**
 * Nothing renders until there is an account.
 *
 * Not because the routes would crash without one — because every read and
 * write below goes through row level security, and a board list rendered
 * before the session settles is an empty workspace on screen for a user who
 * has boards. "Loading" is the honest answer for that moment.
 *
 * The usual path never shows a form: a first visit is signed in anonymously
 * and the children mount. The form is for the two cases that survive that —
 * a start that failed, and a user who signed out on purpose.
 */
export function RequireAccount({ children }) {
  const account = useAccount();
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('sign-in');
  // Bumped to try again. Driving the retry through the effect rather than a
  // second call site is what keeps the liveness check on one path — and the
  // effect is where StrictMode's double mount already has to be survivable.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setStarting(true);
    setError(null);

    // start() memoises its promise, so the second mount joins the first
    // attempt rather than signing in as a second anonymous user.
    auth.start().then((result) => {
      if (!live) return;
      setStarting(false);
      if (!result.ok) setError(result.message);
    });

    return () => {
      live = false;
    };
  }, [attempt]);

  if (account) return children;

  if (starting) {
    return (
      <div className="shell">
        <p className="empty" data-loading>Loading…</p>
      </div>
    );
  }

  return (
    <div className="shell account-gate" data-account-gate>
      <h1>PeerThink</h1>
      {error && <p className="error" role="alert" data-error>{error}</p>}

      <AccountForm mode={mode} onSwitch={setMode} />

      <button
        type="button"
        className="link"
        data-action="continue-as-guest"
        onClick={() => setAttempt((n) => n + 1)}
      >
        Continue without an account
      </button>
    </div>
  );
}
