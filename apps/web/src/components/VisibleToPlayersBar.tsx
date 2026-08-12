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
  onReveal,
}: {
  /** Whether the entity is currently player-visible. */
  visible: boolean;
  /** Make the entity DM-only again. */
  onHide: () => Promise<void>;
  /** Re-reveal after Hide (Undo). */
  onUndoHide: () => Promise<void>;
  /** Reveal when currently hidden (issue #1475). */
  onReveal?: () => Promise<void>;
}) {
  const [pendingAction, setPendingAction] = useState<'hide' | 'reveal' | null>(null);
  const [pendingUndo, setPendingUndo] = useState<'hide' | 'reveal' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function hide() {
    if (pendingAction) return;
    setPendingAction('hide');
    setError(null);
    try {
      await onHide();
      setPendingUndo('hide');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't hide from players.");
    } finally {
      setPendingAction(null);
    }
  }

  async function reveal() {
    if (pendingAction || !onReveal) return;
    setPendingAction('reveal');
    setError(null);
    try {
      await onReveal();
      setPendingUndo('reveal');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reveal to players.");
    } finally {
      setPendingAction(null);
    }
  }

  if (pendingUndo === 'hide') {
    return (
      <UndoSnackbar
        message="Hidden from players."
        successMessage="Visible to players again."
        onUndo={async () => {
          await onUndoHide();
          setPendingUndo(null);
        }}
        onExpire={() => setPendingUndo(null)}
      />
    );
  }

  if (pendingUndo === 'reveal') {
    return (
      <UndoSnackbar
        message="Visible to players again."
        successMessage="Hidden from players."
        onUndo={async () => {
          await onHide();
          setPendingUndo(null);
        }}
        onExpire={() => setPendingUndo(null)}
      />
    );
  }

  if (!visible) {
    if (!onReveal) return null;
    return (
      <div
        role="status"
        data-testid="hidden-from-players-bar"
        className="flex items-center gap-3 flex-wrap rounded border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-amber-100"
      >
        <span className="font-semibold">Hidden from players</span>
        <span className="text-xs text-amber-200/80 flex-1 min-w-[12rem]">
          This encounter is hidden; players won't see it. Reveal when you are ready.
        </span>
        {error && <span className="text-xs text-rose-300">{error}</span>}
        <Btn density="xs" ghost className="text-xs" disabled={pendingAction !== null} onClick={() => void reveal()}>
          {pendingAction === 'reveal' ? 'Revealing…' : pendingAction === 'hide' ? 'Hiding…' : 'Reveal now'}
        </Btn>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid="visible-to-players-bar"
      className="flex items-center gap-3 flex-wrap rounded border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-amber-100"
    >
      <span className="font-semibold">Visible to players</span>
      <span className="text-xs text-amber-200/80 flex-1 min-w-[12rem]">
        They can see this in lists, search, and links. Hide to make it DM-only again.
      </span>
      {error && <span className="text-xs text-rose-300">{error}</span>}
      <Btn density="xs" ghost className="text-xs" disabled={pendingAction !== null} onClick={() => void hide()}>
        {pendingAction === 'hide' ? 'Hiding…' : pendingAction === 'reveal' ? 'Revealing…' : 'Hide'}
      </Btn>
    </div>
  );
}
