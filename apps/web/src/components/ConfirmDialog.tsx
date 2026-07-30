/**
 * Accessible confirmation dialog — composes the shared `Dialog` primitive
 * (issue #1783; previously hand-rolled `.dialog-backdrop`/`.dialog` markup —
 * see git history for the prior implementation). Replaces native `confirm()`
 * calls and QuestPage's hand-rolled inline dialog markup.
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
import { Btn, Dialog } from './ui';
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

  return (
    <Dialog
      title={title}
      titleId={titleId}
      // Escape-to-close and backdrop-click-to-close are both suppressed while
      // busy — Dialog disables its Escape handler whenever onBackdropClick is
      // undefined, the same pattern SchedulePanel uses for its save-in-flight gate.
      onBackdropClick={busy ? undefined : onCancel}
      ariaBusy={busy}
      // Initial focus on Cancel — the safe default for a destructive confirmation.
      initialFocusRef={cancelRef}
      afterBody={
        // Unmount when empty — clearing a mounted role=status to '' can make
        // some screen readers announce “blank”.
        liveStatus ? (
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {liveStatus}
          </span>
        ) : null
      }
      actions={
        <>
          <Btn ghost ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Btn>
          {/* Explicit busy||confirmDisabled — Btn also ORs busy into disabled; keep
              both so double-submit prevention stays obvious at the call site. */}
          <Btn danger={danger} onClick={onConfirm} busy={busy} disabled={busy || confirmDisabled}>
            {confirmText}
          </Btn>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
