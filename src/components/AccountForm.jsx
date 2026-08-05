import { useState } from 'react';

import { auth } from '../shell/auth.js';

/**
 * Email and password, for both of the things that can be done with them.
 *
 * `register` is not "make an account" so much as "put a name on the one you
 * already have" — the guest signed in on the first visit owns the boards
 * already, and attaching an email is what lets them come back to a second
 * browser. The wording follows that: this is saving, not joining.
 */
export function AccountForm({ mode, onSwitch, onDone }) {
  const registering = mode === 'register';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Whether the failure was "that address already has an account". The error
  // text says what happened; this is what turns it into somewhere to go.
  const [taken, setTaken] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setTaken(false);

    // The port answers rather than throws — but a form whose only way out of
    // `busy` is the happy path is one keystroke of somebody else's bug away
    // from a permanently disabled button.
    let result;
    try {
      result = registering
        ? await auth.register({ email, password })
        : await auth.signIn({ email, password });
    } catch {
      result = { ok: false, message: 'Something went wrong. Try again.' };
    } finally {
      setBusy(false);
    }

    if (!result.ok) {
      setError(result.message);
      setTaken(result.taken === true);
      return;
    }
    // A registration awaiting a confirmation link has changed nothing the user
    // can see yet, so say so rather than closing the form on a silent no-op.
    if (result.pending) {
      setPending(true);
      return;
    }
    onDone?.();
  };

  if (pending) {
    return (
      <p className="account-pending" data-account-pending>
        Check {email} for a confirmation link. Your boards are already saved to this account.
      </p>
    );
  }

  return (
    <form className="account-form" onSubmit={submit} data-account-form={mode}>
      {error && <p className="error" role="alert" data-error>{error}</p>}

      {/*
        Offered next to the error rather than replacing it: the message carries
        the cost of switching — boards left with the guest — and a button that
        stood alone would be an invitation without the price on it. Only shown
        while registering, because a taken address is not a way sign-in fails.
      */}
      {taken && registering && onSwitch && (
        <button
          type="button"
          className="link"
          data-action="sign-in-instead"
          onClick={() => {
            setError(null);
            setTaken(false);
            onSwitch('sign-in');
          }}
        >
          Sign in as {email}
        </button>
      )}

      <label>
        <span>Email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label>
        <span>Password</span>
        <input
          type="password"
          name="password"
          required
          minLength={6}
          // A new password and an existing one are different fields to a
          // password manager; telling it which this is stops it offering to
          // save the one the user just typed to sign in with.
          autoComplete={registering ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      <button type="submit" className="primary" disabled={busy} data-action="submit-account">
        {registering ? 'Save account' : 'Sign in'}
      </button>

      {onSwitch && (
        <button
          type="button"
          className="link"
          data-action="switch-mode"
          onClick={() => {
            setError(null);
            onSwitch(registering ? 'sign-in' : 'register');
          }}
        >
          {registering ? 'I already have an account' : 'Create an account instead'}
        </button>
      )}
    </form>
  );
}
