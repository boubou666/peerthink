import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * A question, asked in the page.
 *
 * `window.prompt` and `window.confirm` were doing this. They are the browser's
 * chrome rather than the app's — a different typeface, a different button
 * order per platform, no styling, and on some browsers a checkbox offering to
 * stop the page asking anything ever again. They also block the main thread,
 * which on a page with a live board means the canvas stops rendering and
 * other people's edits stop arriving until somebody clicks.
 *
 * The shape is deliberately theirs, though. A dialog that must be assembled as
 * state, wired to two callbacks and torn down again turns four honest lines at
 * the call site into twenty, and the call sites here read well: ask, and act on
 * the answer. So this is a promise — `await ask.prompt(...)` answers a string
 * or null exactly as `window.prompt` did, and `await ask.confirm(...)` answers
 * a boolean.
 */

/** What each kind of question answers when it is dismissed rather than agreed to. */
const REFUSED = { prompt: null, confirm: false };

function AskDialog({ request, onSettle }) {
  const [value, setValue] = useState(request.value ?? '');
  const form = useRef(null);
  const field = useRef(null);
  const confirmButton = useRef(null);

  // Focus lands where the answer is given: in the field if there is one, on
  // the confirming button if there is not. A dialog that opens with focus
  // still behind it is one a keyboard cannot reach without hunting.
  useEffect(() => {
    const el = field.current ?? confirmButton.current;
    el?.focus();
    field.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onSettle(REFUSED[request.kind]);
        return;
      }
      if (event.key !== 'Tab') return;

      /**
       * Keep Tab inside the dialog.
       *
       * `aria-modal` tells a screen reader this is modal; it does nothing to
       * the tab order, so without this the next Tab walks out into the page
       * behind. That is not merely untidy where this dialog is opened from
       * another one: tabbing out of a rename lands on the organization
       * dialog's close button, and the next space bar shuts the thing that
       * asked the question.
       *
       * Re-read on each press rather than captured once, because what is
       * focusable changes — the confirming button is disabled while a prompt
       * is empty, and must not be a stop on the way round.
       */
      const stops = [...form.current.querySelectorAll('button:not([disabled]), input:not([disabled])')];
      if (stops.length === 0) return;

      const first = stops[0];
      const last = stops[stops.length - 1];
      const here = document.activeElement;
      const outside = !form.current.contains(here);

      if (event.shiftKey ? (here === first || outside) : (here === last || outside)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    // Capturing, because this dialog can be opened from inside another one —
    // the organization dialog closes on Escape too, and the question in front
    // of it must be what the key reaches.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onSettle, request.kind]);

  const submit = (event) => {
    event.preventDefault();
    onSettle(request.kind === 'prompt' ? value : true);
  };

  return (
    <div
      className="ask-backdrop"
      data-ask={request.kind}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onSettle(REFUSED[request.kind]);
      }}
    >
      {/* A form, so Enter submits and the browser does the work — and so the
          confirming control is a real submit button rather than a click
          handler that has to remember what Enter means. */}
      <form
        ref={form}
        className="ask"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onSubmit={submit}
      >
        <h2 className="ask-title">{request.title}</h2>
        {request.message && <p className="ask-message">{request.message}</p>}

        {request.kind === 'prompt' && (
          <label className="ask-field">
            {request.label && <span>{request.label}</span>}
            <input
              ref={field}
              value={value}
              data-ask-field
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}

        <div className="ask-actions">
          <button type="button" data-action="ask-cancel" onClick={() => onSettle(REFUSED[request.kind])}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmButton}
            type="submit"
            className="primary"
            data-action="ask-confirm"
            // A prompt with nothing in it is the one answer no caller wants:
            // every one of them trims and rejects it anyway, so the button
            // says so instead of taking the click and discarding it.
            disabled={request.kind === 'prompt' && !value.trim()}
            {...(request.danger ? { 'data-danger': '' } : {})}
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * `[dialog, ask]` — render the first, call the second.
 *
 * The dialog is null until something asks, so a page that never asks renders
 * nothing and costs nothing.
 */
export function useAsk() {
  const [request, setRequest] = useState(null);

  /**
   * The unanswered question: how to settle it, and what kind it was.
   *
   * The kind travels with the resolver because refusing one is not one value.
   * A prompt refuses with null and a confirm with false, and the two places
   * that refuse *without* being told — a question superseded by another, and a
   * page unmounting mid-question — otherwise have to guess. Guessing wrong is
   * not a cosmetic difference: every caller of `prompt` tests for null and then
   * calls `.trim()`, so a prompt refused with `false` throws at the call site.
   */
  const pending = useRef(null);

  const refuse = useCallback(() => {
    const open = pending.current;
    // Spelled out rather than `open?.resolve(REFUSED[open.kind])`. That is
    // safe — an optional call does not evaluate its arguments when it
    // short-circuits — but it reads like a null dereference, and a rule you
    // have to know to see the safety of is one somebody will "fix".
    if (!open) return;
    pending.current = null;
    open.resolve(REFUSED[open.kind]);
  }, []);

  const answer = useCallback((value) => {
    setRequest(null);
    const open = pending.current;
    pending.current = null;
    open?.resolve(value);
  }, []);

  const ask = useMemo(() => {
    const open = (kind, options) => new Promise((resolve) => {
      // A second question while one is open would strand the first — its
      // promise would never settle and whatever awaited it would hang. There
      // is no way to ask two at once through this API (the first await has not
      // returned), but a stray click on a disabled-looking control can still
      // get here, so the earlier one is refused rather than dropped.
      refuse();
      pending.current = { kind, resolve };
      setRequest({ kind, ...options });
    });

    return {
      prompt: (options) => open('prompt', options),
      confirm: (options) => open('confirm', options),
    };
  }, [refuse]);

  // A page that unmounts mid-question — signing out, or a route change — must
  // not leave its caller awaiting forever.
  useEffect(() => () => refuse(), [refuse]);

  return [
    request ? <AskDialog key={request.title} request={request} onSettle={answer} /> : null,
    ask,
  ];
}
