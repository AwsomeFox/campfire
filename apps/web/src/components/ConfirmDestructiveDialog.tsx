/**
 * ConfirmDestructiveDialog — structured, accessible type-to-confirm dialog for
 * irreversible actions (issue #775). Composes the shared `Dialog` primitive
 * (issue #1783; previously hand-rolled its own portal/backdrop markup — see
 * git history for the prior implementation).
 *
 * Built on `Dialog` (which wraps `useDialog` for focus trap, restore, Escape)
 * and `Announcer` for assertive error announcements. Portals to
 * `document.body` with an inert background like ConfirmDialog (issue #791).
 *
 * Accessibility contract:
 *  - role="alertdialog" + aria-modal + aria-labelledby + aria-describedby
 *  - Focus moves to the confirmation input on open; restores on cancel
 *  - Validation/server errors associated via aria-describedby + aria-invalid
 *  - Errors announced via aria-live="assertive" (through the app Announcer)
 *  - Destructive button disabled until exact normalized match
 *  - Non-color explanation shown while button is disabled (visible helper text)
 *  - Escape closes (unless busy); backdrop click closes (unless busy)
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useAnnounce } from './Announcer';
import { resolveBusyConfirmLabel } from './confirmDialogLabel';
import { Btn, Dialog } from './ui';

export interface ConfirmDestructiveDialogProps {
  /** The heading shown at the top of the dialog. */
  title: string;
  /** Describes the consequence of the action — rendered as the dialog description. */
  consequence: React.ReactNode;
  /** Optional extra body content (e.g. invite-revoke checkbox) below consequence. */
  extraBody?: React.ReactNode;
  /** The string the user must type to confirm. */
  confirmValue: string;
  /** Label for the destructive action button. */
  confirmLabel: string;
  /** Label shown while `busy` is true. Derived from `confirmLabel` when omitted. */
  pendingLabel?: string;
  /** Optional label for the cancel button. @default 'Cancel' */
  cancelLabel?: string;
  /** Label for the type-to-confirm input. @default 'Type {confirmValue} to confirm' */
  inputLabel?: React.ReactNode;
  /** Hint shown while the typed value does not match. */
  hintMismatch?: string;
  /** Hint shown once the typed value matches. */
  hintConfirmed?: string;
  /** Whether the action is currently in flight. */
  busy?: boolean;
  /** Server or validation error to display and announce. */
  error?: string | null;
  /** Called when the user confirms (button click or Enter in the input). */
  onConfirm: () => void;
  /** Called when the user cancels (Cancel button, Escape, or backdrop click). */
  onCancel: () => void;
}

/**
 * Normalize strings for comparison: trim, collapse whitespace, lowercase.
 * Allows minor spacing differences without making the control overly strict.
 */
export function normalizeConfirmValue(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function confirmValuesMatch(typed: string, expected: string): boolean {
  return normalizeConfirmValue(typed) === normalizeConfirmValue(expected);
}

export function ConfirmDestructiveDialog({
  title,
  consequence,
  extraBody,
  confirmValue,
  confirmLabel,
  pendingLabel,
  cancelLabel = 'Cancel',
  inputLabel,
  hintMismatch,
  hintConfirmed = 'Confirmed — you may proceed.',
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDestructiveDialogProps) {
  const announce = useAnnounce();
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const uid = useId();
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  const errorId = `${uid}-error`;
  const hintId = `${uid}-hint`;

  const matches = confirmValuesMatch(inputValue, confirmValue);
  const confirmText = busy ? resolveBusyConfirmLabel(confirmLabel, pendingLabel) : confirmLabel;
  const resolvedInputLabel = inputLabel ?? (
    <>
      Type <strong>{confirmValue}</strong> to confirm
    </>
  );
  const resolvedHintMismatch =
    hintMismatch ?? `You must type "${confirmValue}" to enable the button.`;

  useEffect(() => {
    if (error) announce(error, { assertive: true });
  }, [error, announce]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (matches && !busy) onConfirm();
  }

  const inputDescribedBy = [hintId, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <Dialog
      title={title}
      titleId={titleId}
      titleAs="h2"
      role="alertdialog"
      descId={descId}
      bodyId={descId}
      ariaBusy={busy}
      // Escape-to-close and backdrop-click-to-close are both suppressed while
      // busy — Dialog disables its Escape handler whenever onBackdropClick is
      // undefined, the same pattern SchedulePanel uses for its save-in-flight gate.
      onBackdropClick={busy ? undefined : onCancel}
      initialFocusRef={inputRef}
      backdropTestId="confirm-destructive-backdrop"
      dialogTestId="confirm-destructive-dialog"
      afterBody={
        // A caller-owned <form> outside `.dialog-body` (which nocturne.css dims
        // to 0.85 opacity) — the type-to-confirm input must stay full-strength,
        // and the dialog-actions live inside the form for Enter-to-submit.
        <form onSubmit={handleSubmit} className="flex flex-col gap-2" style={{ marginTop: 8 }}>
          <label htmlFor={`${uid}-input`} style={{ fontSize: 12.5 }}>
            {resolvedInputLabel}
          </label>
          <input
            ref={inputRef}
            id={`${uid}-input`}
            className="cf-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={confirmValue}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={inputDescribedBy}
            aria-invalid={error ? true : undefined}
            aria-errormessage={error ? errorId : undefined}
            disabled={busy}
            data-testid="confirm-destructive-input"
          />

          <p
            id={hintId}
            className="text-muted"
            style={{ margin: 0, fontSize: 11.5 }}
            data-testid="confirm-destructive-hint"
          >
            {matches ? hintConfirmed : resolvedHintMismatch}
          </p>

          {error && (
            <p
              id={errorId}
              style={{ margin: 0, fontSize: 12.5, color: '#f87171' }}
              data-testid="confirm-destructive-error"
            >
              {error}
            </p>
          )}

          <div className="dialog-actions" style={{ marginTop: 4 }}>
            <Btn
              ghost
              type="button"
              onClick={onCancel}
              disabled={busy}
              data-testid="confirm-destructive-cancel"
            >
              {cancelLabel}
            </Btn>
            <Btn
              danger
              type="submit"
              disabled={!matches}
              busy={busy}
              data-testid="confirm-destructive-confirm"
            >
              {confirmText}
            </Btn>
          </div>
        </form>
      }
    >
      {consequence}
      {extraBody}
    </Dialog>
  );
}
