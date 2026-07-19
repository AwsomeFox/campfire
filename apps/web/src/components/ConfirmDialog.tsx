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

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useRef(`confirm-dialog-title-${Math.random().toString(36).slice(2)}`).current;

  // Initial focus on Cancel — the safe default for a destructive confirmation.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (busy) return;
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const root = dialogRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

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
          <Btn danger={danger} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}
