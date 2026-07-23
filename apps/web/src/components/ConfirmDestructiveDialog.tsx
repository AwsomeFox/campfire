/**
 * ConfirmDestructiveDialog — structured, accessible type-to-confirm dialog for
 * irreversible actions (issue #775).
 *
 * Built on the existing `useDialog` hook for focus-trap + restore + Escape handling,
 * and the shared `Announcer` live region for assertive error announcements.
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
import { useDialog } from './useDialog';
import { useAnnounce } from './Announcer';
import { Btn } from './ui';

export interface ConfirmDestructiveDialogProps {
  /** The heading shown at the top of the dialog. */
  title: string;
  /** Describes the consequence of the action — rendered as the dialog description. */
  consequence: React.ReactNode;
  /** The string the user must type to confirm. */
  confirmValue: string;
  /** Label for the destructive action button. */
  confirmLabel: string;
  /** Optional label for the cancel button. @default 'Cancel' */
  cancelLabel?: string;
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
 * This allows minor spacing differences without making the control overly strict.
 */
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function ConfirmDestructiveDialog({
  title,
  consequence,
  confirmValue,
  confirmLabel,
  cancelLabel = 'Cancel',
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

  const matches = normalize(inputValue) === normalize(confirmValue);

  // Focus the input on mount (overrides useDialog's default auto-focus).
  const dialogRef = useDialog<HTMLDivElement>({
    onClose: onCancel,
    disabled: busy,
    autoFocus: false,
  });

  useEffect(() => {
    // Small delay so the dialog DOM is stable before focusing.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Announce errors assertively for screen readers.
  useEffect(() => {
    if (error) announce(error, { assertive: true });
  }, [error, announce]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (matches && !busy) onConfirm();
  }

  // Build the aria-describedby list for the input. Always includes the hint;
  // adds the error id when an error is present.
  const inputDescribedBy = [hintId, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div
      className="dialog-backdrop"
      data-testid="confirm-destructive-backdrop"
      onClick={() => !busy && onCancel()}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
        data-testid="confirm-destructive-dialog"
      >
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>

        <div className="dialog-body" id={descId}>
          {consequence}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-2" style={{ marginTop: 8 }}>
          <label htmlFor={`${uid}-input`} style={{ fontSize: 12.5 }}>
            Type <strong>{confirmValue}</strong> to confirm
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

          {/* Non-color explanation for disabled state */}
          <p
            id={hintId}
            className="text-muted"
            style={{ margin: 0, fontSize: 11.5 }}
            data-testid="confirm-destructive-hint"
          >
            {matches
              ? 'Confirmed — you may proceed.'
              : `You must type the exact name "${confirmValue}" to enable the button.`}
          </p>

          {error && (
            <p
              id={errorId}
              role="alert"
              aria-live="assertive"
              style={{ margin: 0, fontSize: 12.5, color: '#f87171' }}
              data-testid="confirm-destructive-error"
            >
              {error}
            </p>
          )}

          <div className="dialog-actions" style={{ marginTop: 4 }}>
            <Btn ghost type="button" onClick={onCancel} disabled={busy} data-testid="confirm-destructive-cancel">
              {cancelLabel}
            </Btn>
            <Btn
              danger
              type="submit"
              disabled={!matches}
              busy={busy}
              data-testid="confirm-destructive-confirm"
            >
              {busy ? 'Working…' : confirmLabel}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}
