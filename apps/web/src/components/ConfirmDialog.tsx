/**
 * Accessible confirmation dialog — the app's `.dialog` / `.dialog-backdrop`
 * pattern (see nocturne.css) wrapped as a reusable component. Replaces native
 * `confirm()` calls and QuestPage's hand-rolled inline dialog markup.
 *
 * - role="dialog" + aria-modal="true" + aria-labelledby
 * - initial focus on the Cancel button (safe default for destructive actions)
 * - focus trap: Tab/Shift+Tab cycle within the dialog while open
 * - Escape closes (calls onCancel), unless `busy` is true
 * - clicking the backdrop closes, unless `busy` is true
 */
import { useEffect, useRef } from 'react';
import { Btn } from './ui';
import { useDialog } from './useDialog';

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** Disables the confirm button without the busy spinner — e.g. an un-ticked acknowledgement. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useRef(`confirm-dialog-title-${Math.random().toString(36).slice(2)}`).current;

  // Escape-to-close (suppressed while busy), focus trap, and focus restore.
  const dialogRef = useDialog<HTMLDivElement>({ onClose: onCancel, disabled: busy, autoFocus: false });

  // Initial focus on Cancel — the safe default for a destructive confirmation.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onCancel()}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="dialog-title" id={titleId}>
          {title}
        </p>
        {body && <div className="dialog-body">{body}</div>}
        <div className="dialog-actions">
          <Btn ghost ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Btn>
          <Btn danger={danger} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? 'Working…' : confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}
