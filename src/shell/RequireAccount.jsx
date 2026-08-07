import { Fragment, useEffect, useState } from 'react';

import { AccountForm } from '../components/AccountForm.jsx';
import { adoptLocalBoards } from './adopt.js';
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
  // Adoption is not sign-in: it fails with an account already in hand, and
  // what it costs is boards missing from the list rather than a way in.
  const [unadopted, setUnadopted] = useState(false);
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
    setUnadopted(false);

    auth.start()
      .then(async (result) => {
        // Before anything reads the board list: the boards this browser had
        // are moved into the account, so the first list is the whole list
        // rather than one that has quietly dropped them. Once per browser,
        // and a no-op on every visit after that.
        //
        // Caught rather than awaited bare — a rejection here would leave the
        // gate on "Loading…" for good, since the caller below is a .then()
        // with nowhere to put one.
        if (!result.ok || !adoptLocalBoards) return result;
        const moved = await adoptLocalBoards().catch(() => null);
        return { ...result, unadopted: !moved?.done };
      })
      .then((result) => {
        if (!live) return;
        setStarting(false);
        if (!result.ok) setError(result.message);
        else if (result.unadopted) setUnadopted(true);
      });

    return () => {
      live = false;
    };
  }, [attempt]);

  /**
   * `starting` covers the adoption as well as the sign-in, so the list is not
   * read — and an empty workspace not rendered — while boards are still moving.
   *
   * Keyed on the account, because who this is can change while everything
   * below stays mounted. Signing in from the account menu never passes through
   * the gate: the guest was already let through, so the pages under here go on
   * showing the boards they read on mount — the previous person's — until
   * something reloads the document. The key is what makes the account a fact
   * the whole subtree is rebuilt from, rather than one every page has to
   * remember to watch for itself.
   *
   * On the id, not the account: a token refresh publishes a fresh object for
   * the same user, and remounting the board someone is editing every hour is
   * not what this is for. Registering keeps the id too — same row in
   * auth.users, same boards — which is exactly why it needs no remount.
   */
  if (account && !starting && !unadopted) return <Fragment key={account.id}>{children}</Fragment>;

  if (starting) {
    return (
      <div className="shell">
        <p className="empty" data-loading>Loading…</p>
      </div>
    );
  }

  /**
   * Signed in, but the boards this browser had did not all make it across.
   * Showing the workspace now would show a list with boards missing from it,
   * which is the exact thing adoption exists to prevent — so the choice is
   * offered instead. Nothing has been lost either way: the browser still has
   * its copies, and the next attempt picks up where this one stopped.
   */
  if (account && unadopted) {
    return (
      <div className="shell account-gate" data-unadopted>
        <h1>Your boards are still on this device</h1>
        <p className="empty">
          Some of them could not be moved into your account just now. They are
          still here, and nothing has been lost — trying again usually works.
        </p>
        <button
          type="button"
          className="primary"
          data-action="retry-adoption"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Try again
        </button>
        <button
          type="button"
          className="link"
          data-action="skip-adoption"
          onClick={() => setUnadopted(false)}
        >
          Continue without them for now
        </button>
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
