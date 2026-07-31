/**
 * Three-choice leave prompt for dirty long-form editors (issue #641).
 *
 * Replaces native `confirm()` for in-app navigation so the user can keep editing,
 * discard local work, or save before leaving.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Btn, Dialog } from './ui';
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

  return (
    <Dialog
      title={title}
      titleId={titleId}
      onBackdropClick={() => !busy && onKeep()}
      initialFocusRef={keepRef}
      ariaBusy={busy}
      actions={
        <>
          <Btn ghost ref={keepRef} onClick={onKeep} disabled={busy}>
            {keepLabel}
          </Btn>
          <Btn ghost onClick={onDiscard} disabled={busy}>
            {discardLabel}
          </Btn>
          <Btn onClick={onSave} busy={busy} disabled={busy || saveDisabled}>
            {saveText}
          </Btn>
        </>
      }
    >
      {body}
      {liveStatus ? (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveStatus}
        </span>
      ) : null}
    </Dialog>
  );
}
