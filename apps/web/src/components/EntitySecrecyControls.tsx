/**
 * Shared secrecy controls for prep entities (issue #710).
 * Keeps reveal/hide actions separate from Edit/Status header buttons and gates
 * hidden → visible transitions behind a confirmation dialog with preview + Undo.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Btn } from './ui';
import { GameIcon } from './GameIcon';
import { EntityRevealDialog, type RevealEntityKind } from './EntityRevealDialog';
import { UndoSnackbar } from './UndoSnackbar';
import type { RevealPreviewItem } from './entityRevealPreview';
import { useAnnounce } from './Announcer';

export function EntitySecrecyControls({
  entityKind,
  entityName,
  hidden,
  preview,
  onReveal,
  onUndoReveal,
  className,
}: {
  entityKind: RevealEntityKind;
  entityName: string;
  /** true when the entity is DM-only (hidden flag or unexplored location). */
  hidden: boolean;
  preview: RevealPreviewItem[];
  onReveal: () => Promise<void>;
  /** Re-hide after a mistaken reveal (Undo snackbar). */
  onUndoReveal: () => Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hidden && !pendingUndo) return null;

  async function confirmReveal() {
    setBusy(true);
    setError(null);
    try {
      await onReveal();
      setConfirming(false);
      setPendingUndo(true);
      announce(t('secrecy.revealSuccessUndo'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('secrecy.revealFailed');
      setError(msg);
      announce(msg, { assertive: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {pendingUndo ? (
        <UndoSnackbar
          message={t('secrecy.revealSuccessUndo')}
          successMessage={t('secrecy.revealUndoSuccess')}
          onUndo={async () => {
            await onUndoReveal();
            setPendingUndo(false);
          }}
          onExpire={() => setPendingUndo(false)}
        />
      ) : (
        <div
          role="group"
          aria-label={t('secrecy.secrecyGroupLabel')}
          data-testid="entity-secrecy-controls"
          className={className ?? 'flex items-center gap-2'}
        >
          {error && <span className="text-xs text-rose-300">{error}</span>}
          <Btn
            ghost
            className="!min-h-0 !py-1.5 text-xs"
            disabled={busy}
            onClick={() => setConfirming(true)}
            title={t('secrecy.revealButton')}
            data-testid="entity-reveal-trigger"
          >
            {busy ? (
              t('secrecy.revealButtonBusy')
            ) : (
              <>
                <GameIcon slug="eyeball" size={12} className="inline align-text-bottom" /> {t('secrecy.revealButton')}
              </>
            )}
          </Btn>
        </div>
      )}
      {confirming && (
        <EntityRevealDialog
          entityKind={entityKind}
          entityName={entityName}
          preview={preview}
          busy={busy}
          onConfirm={() => void confirmReveal()}
          onCancel={() => !busy && setConfirming(false)}
        />
      )}
    </>
  );
}
