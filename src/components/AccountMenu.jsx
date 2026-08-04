import { useState } from 'react';

import { auth, useAccount } from '../shell/auth.js';
import { AccountForm } from './AccountForm.jsx';

/**
 * Who you are, in the corner of the board list.
 *
 * A guest is the default state, not an error, so this stays quiet about it —
 * one offer to keep the boards beyond this browser, no banner. A build with no
 * project behind it renders nothing at all: there is no account to show and
 * nothing to sign out of.
 */
export function AccountMenu() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('register');

  if (!auth.configured || !account) return null;

  if (!account.guest) {
    return (
      <div className="account-menu" data-account="user">
        <span className="account-email">{account.email}</span>
        <button type="button" data-action="sign-out" onClick={() => auth.signOut()}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="account-menu" data-account="guest">
      <button type="button" data-action="save-account" onClick={() => setOpen((was) => !was)}>
        Save your boards
      </button>

      {open && (
        <div className="account-popover">
          {/* Registering is the offer, because attaching an email to this
              guest is what keeps the boards they are looking at. Signing in
              instead is reachable but second — it abandons them. */}
          <AccountForm mode={mode} onSwitch={setMode} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
