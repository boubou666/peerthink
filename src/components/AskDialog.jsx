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
      <form className="ask" role="dialog" aria-modal="true" aria-label={request.title} onSubmit={submit}>
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
  const settle = useRef(null);

  const answer = useCallback((value) => {
    setRequest(null);
    const resolve = settle.current;
    settle.current = null;
    resolve?.(value);
  }, []);

  const ask = useMemo(() => {
    const open = (kind, options) => new Promise((resolve) => {
      // A second question while one is open would strand the first — its
      // promise would never settle and whatever awaited it would hang. There
      // is no way to ask two at once through this API (the first await has not
      // returned), but a stray click on a disabled-looking control can still
      // get here, so the earlier one is refused rather than dropped.
      settle.current?.(REFUSED[kind]);
      settle.current = resolve;
      setRequest({ kind, ...options });
    });

    return {
      prompt: (options) => open('prompt', options),
      confirm: (options) => open('confirm', options),
    };
  }, []);

  // A page that unmounts mid-question — signing out, or a route change — must
  // not leave its caller awaiting forever.
  useEffect(() => () => settle.current?.(false), []);

  return [
    request ? <AskDialog key={request.title} request={request} onSettle={answer} /> : null,
    ask,
  ];
}
