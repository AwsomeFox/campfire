/**
 * Persistent “Visible to players” affordance (issue #754).
 * Shown while a prep entity is player-visible. Hide → DM-only; then an Undo
 * snackbar offers one-click re-reveal.
 *
 * Parents should keep this mounted for DMs (pass `visible`) so the Undo snackbar
 * can render after Hide flips the entity to hidden — otherwise the parent’s
 * `!entity.hidden` guard unmounts the bar before pendingUndo can show.
 */
import { useState } from 'react';
import { Btn } from './ui';
import { UndoSnackbar } from './UndoSnackbar';

export function VisibleToPlayersBar({
  visible,
  onHide,
  onUndoHide,
}: {
  /** Whether the entity is currently player-visible. */
  visible: boolean;
  /** Make the entity DM-only again. */
  onHide: () => Promise<void>;
  /** Re-reveal after Hide (Undo). */
  onUndoHide: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function hide() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onHide();
      setPendingUndo(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't hide from players.");
    } finally {
      setBusy(false);
    }
  }

  if (pendingUndo) {
    return (
      <UndoSnackbar
        message="Hidden from players."
        successMessage="Visible to players again."
        onUndo={async () => {
          await onUndoHide();
          setPendingUndo(false);
        }}
        onExpire={() => setPendingUndo(false)}
      />
    );
  }

  if (!visible) return null;

  return (
    <div
      role="status"
      data-testid="visible-to-players-bar"
      className="flex items-center gap-3 flex-wrap rounded border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
    >
      <span className="font-semibold">Visible to players</span>
      <span className="text-xs text-amber-200/80 flex-1 min-w-[12rem]">
        They can see this in lists, search, and links. Hide to make it DM-only again.
      </span>
      {error && <span className="text-xs text-rose-300">{error}</span>}
      <Btn ghost className="!min-h-0 !py-1 text-xs" disabled={busy} onClick={() => void hide()}>
        {busy ? 'Hiding…' : 'Hide'}
      </Btn>
    </div>
  );
}
