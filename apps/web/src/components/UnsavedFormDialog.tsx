/**
 * Three-choice leave prompt for dirty long-form editors (issue #641).
 *
 * Replaces native `confirm()` for in-app navigation so the user can keep editing,
 * discard local work, or save before leaving.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Btn } from './ui';
import { useDialog } from './useDialog';
import { resolveBusyConfirmLabel } from './confirmDialogLabel';

export function UnsavedFormDialog({
  title = 'Save your changes?',
  body = 'You have unsaved work on this page. Keep editing, discard your changes, or save before leaving.',
  keepLabel = 'Keep editing',
  discardLabel = 'Discard changes',
  saveLabel = 'Save',
  pendingSaveLabel,
  busy = false,
  saveDisabled = false,
  onKeep,
  onDiscard,
  onSave,
}: {
  title?: string;
  body?: React.ReactNode;
  keepLabel?: string;
  discardLabel?: string;
  saveLabel?: string;
  pendingSaveLabel?: string;
  busy?: boolean;
  saveDisabled?: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const busySaveLabel = resolveBusyConfirmLabel(saveLabel, pendingSaveLabel);
  const saveText = busy ? busySaveLabel : saveLabel;

  const dialogRef = useDialog<HTMLDivElement>({
    onClose: onKeep,
    disabled: busy,
    autoFocus: false,
    inertBackground: true,
  });

  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  const [liveStatus, setLiveStatus] = useState('');
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) setLiveStatus(busySaveLabel);
    else if (wasBusy.current) setLiveStatus('');
    wasBusy.current = busy;
  }, [busy, busySaveLabel]);

  return createPortal(
    <div className="dialog-backdrop" data-overlay="dialog" onClick={() => !busy && onKeep()}>
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
        {liveStatus ? (
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {liveStatus}
          </span>
        ) : null}
        <div className="dialog-actions">
          <Btn ghost ref={keepRef} onClick={onKeep} disabled={busy}>
            {keepLabel}
          </Btn>
          <Btn ghost onClick={onDiscard} disabled={busy}>
            {discardLabel}
          </Btn>
          <Btn onClick={onSave} busy={busy} disabled={busy || saveDisabled}>
            {saveText}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}
