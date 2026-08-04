import { FAILED, PENDING, SAVED, SAVING, UNLOADED } from '../core/save-status.js';

/**
 * Whether the board is stored, in four words in the board bar.
 *
 * The two transient states share a label. A write is in flight for a few
 * milliseconds and waiting for the debounce for a few hundred more, and the
 * difference between those is this file's business rather than the reader's —
 * what they want to know is that it is being dealt with.
 *
 * The two states that are not transient say what they are and, where there is
 * one, offer the thing to do about it. They are also the only ones announced:
 * a screen reader that reported every settled edit would be unusable, while a
 * board that has stopped saving is exactly what an assistive technology should
 * interrupt for.
 */
const COPY = {
  [SAVED]: { text: 'Saved', hint: 'Every change is stored' },
  [PENDING]: { text: 'Saving…', hint: 'Storing your changes' },
  [SAVING]: { text: 'Saving…', hint: 'Storing your changes' },
  [FAILED]: {
    text: 'Unsaved changes',
    hint: 'The last save did not land. Trying again — your work is still here.',
    alert: true,
  },
  [UNLOADED]: {
    text: 'Not saving',
    hint: 'This board could not be loaded, so changes are not being stored. Copy anything you need before closing the tab.',
    alert: true,
  },
};

export function SaveIndicator({ status, onRetry }) {
  const { text, hint, alert } = COPY[status] ?? COPY[SAVED];

  return (
    <span
      className="save-state"
      data-save-status={status}
      title={hint}
      {...(alert ? { role: 'alert' } : { 'aria-hidden': 'true' })}
    >
      {text}
      {status === FAILED && (
        <button type="button" data-action="retry-save" onClick={onRetry}>
          Retry
        </button>
      )}
    </span>
  );
}
