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
 * - portals to `document.body` above navigation chrome (issue #791)
 * - inert background so obscured UI is removed from focus / pointer targets
 * - busy state keeps an action-specific pending label (issue #793) and announces
 *   it once via a polite live region
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

  // Escape-to-close (suppressed while busy), focus trap, focus restore, and an
  // inert background so mobile chrome under the portal cannot be activated.
  const dialogRef = useDialog<HTMLDivElement>({
    onClose: onCancel,
    disabled: busy,
    autoFocus: false,
    inertBackground: true,
  });

  // Initial focus on Cancel — the safe default for a destructive confirmation.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Announce when busy becomes true, and again if busyLabel changes while busy
  // (locale switch / caller prop update). Clear when busy returns to false.
  const [liveStatus, setLiveStatus] = useState('');
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      setLiveStatus(busyLabel);
    } else if (wasBusy.current) {
      setLiveStatus('');
    }
    wasBusy.current = busy;
  }, [busy, busyLabel]);

  // Portal above #root so sticky header / tab-bar stacking contexts cannot paint
  // over the backdrop. Nested ConfirmDialogs keep open order via DOM order.
  return createPortal(
    <div className="dialog-backdrop" data-overlay="dialog" onClick={() => !busy && onCancel()}>
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
        {/* Unmount when empty — clearing a mounted role=status to '' can make
            some screen readers announce “blank”. */}
        {liveStatus ? (
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {liveStatus}
          </span>
        ) : null}
        <div className="dialog-actions">
          <Btn ghost ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Btn>
          {/* Explicit busy||confirmDisabled — Btn also ORs busy into disabled; keep
              both so double-submit prevention stays obvious at the call site. */}
          <Btn danger={danger} onClick={onConfirm} busy={busy} disabled={busy || confirmDisabled}>
            {confirmText}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}
