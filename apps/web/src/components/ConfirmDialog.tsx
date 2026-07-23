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
 * - busy state keeps an action-specific pending label (issue #793) and announces
 *   it once via a polite live region
 */
import { useEffect, useRef, useState } from 'react';
import { Btn } from './ui';
import { useDialog } from './useDialog';
import { resolveBusyConfirmLabel } from './confirmDialogLabel';

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  pendingLabel,
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
  /**
   * Label shown while `busy` is true. When omitted, a progressive form is
   * derived from `confirmLabel` (e.g. "End encounter" → "Ending encounter…").
   */
  pendingLabel?: string;
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
  const busyLabel = resolveBusyConfirmLabel(confirmLabel, pendingLabel);
  const confirmText = busy ? busyLabel : confirmLabel;

  // Escape-to-close (suppressed while busy), focus trap, and focus restore.
  const dialogRef = useDialog<HTMLDivElement>({ onClose: onCancel, disabled: busy, autoFocus: false });

  // Initial focus on Cancel — the safe default for a destructive confirmation.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Announce the pending label once when busy becomes true (not on every render).
  const [liveStatus, setLiveStatus] = useState('');
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy && !wasBusy.current) {
      setLiveStatus(busyLabel);
    } else if (!busy && wasBusy.current) {
      setLiveStatus('');
    }
    wasBusy.current = busy;
  }, [busy, busyLabel]);

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onCancel()}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="dialog-title" id={titleId}>
          {title}
        </p>
        {body && <div className="dialog-body">{body}</div>}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveStatus}
        </span>
        <div className="dialog-actions">
          <Btn ghost ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Btn>
          <Btn danger={danger} onClick={onConfirm} busy={busy} disabled={confirmDisabled}>
            {confirmText}
          </Btn>
        </div>
      </div>
    </div>
  );
}
