/**
 * Character "Move to Trash" menu (issue #716) — the kebab affordance shared by the
 * character sheet header and the party-roster card. Owners and the DM see it; other
 * players don't (the parent gates it on `canEdit`, mirroring PATCH /characters/:id).
 *
 * Two-step, matching the NPC page: the kebab opens a small `role="menu"` popup, and
 * "Move to Trash…" opens the shared `ConfirmDialog` that names the character and
 * explains encounter/ownership/link effects before the soft-delete fires. The parent
 * owns the actual DELETE call plus the Undo snackbar + redirect-on-trash wiring.
 *
 * Accessible by design:
 *  - trigger: `aria-haspopup="menu"` + `aria-expanded`, keyboard activatable
 *  - popup: `role="menu"` with `role="menuitem"` children, Escape to close, focus
 *    restores to the trigger (via useDialog); outside click dismisses too
 *  - dialog: see ConfirmDialog — role=dialog, focus trap, Escape cancels, Enter confirms
 */
import { useEffect, useRef, useState } from 'react';
import { Btn } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDialog } from '../../components/useDialog';

export function CharacterTrashMenu({
  characterName,
  busy,
  onTrash,
  triggerClassName = '',
  triggerLabel,
}: {
  characterName: string;
  /** True while the DELETE request is in flight — disables both the menu item and the confirm button. */
  busy: boolean;
  /** Fired after the user confirms the dialog. The parent runs the soft-delete + undo wiring. */
  onTrash: () => void;
  /** Extra classes for the kebab trigger (e.g. card-corner positioning on the roster). */
  triggerClassName?: string;
  /** Optional accessible label suffix for the trigger, to disambiguate multiple cards. */
  triggerLabel?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Outside-click dismiss (same pattern as Layout's account menu). mousedown so the
  // click that opened the menu (on the trigger button) doesn't immediately close it.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Escape closes the popup (supplemented by useDialog inside CharacterTrashMenuItems).
  // We wire it at the container level so Escape works even before focus enters the menu.
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  function openConfirm() {
    setMenuOpen(false);
    setConfirming(true);
  }

  // After the parent's async trash() resolves, close the confirm dialog. On
  // failure the page surfaces the error via its own actionError state, so
  // closing here is correct either way — previously the dialog stayed open
  // (backdrop and all) even after a successful delete because confirming was
  // only ever reset by Cancel.
  async function confirmTrash() {
    try {
      await onTrash();
    } finally {
      setConfirming(false);
    }
  }

  const triggerAriaLabel = triggerLabel
    ? `Actions for ${characterName} (${triggerLabel})`
    : `Actions for ${characterName}`;

  return (
    <div className="relative" ref={containerRef}>
      <Btn
        ghost
        type="button"
        className={`!min-h-0 !py-1 !px-2 text-xs ${triggerClassName}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={triggerAriaLabel}
        onClick={() => setMenuOpen((v) => !v)}
      >
        ⋯
      </Btn>
      {menuOpen && (
        <CharacterTrashMenuItems onClose={() => setMenuOpen(false)} onTrash={openConfirm} busy={busy} />
      )}
      {confirming && (
        <ConfirmDialog
          title={`Move ${characterName} to the Trash?`}
          body={
            <p>
              Removes <strong>{characterName}</strong> from this campaign. Encounters referencing{' '}
              {characterName} keep their combatant records; ownership of any linked resource stays with
              the campaign. You can undo this right away, or restore {characterName} later from the
              campaign Trash.
            </p>
          }
          confirmLabel={busy ? 'Moving…' : 'Move to Trash'}
          busy={busy}
          onConfirm={confirmTrash}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function CharacterTrashMenuItems({
  onClose,
  onTrash,
  busy,
}: {
  onClose: () => void;
  onTrash: () => void;
  busy: boolean;
}) {
  // Not a modal — Tab may fall through — so no focus trap. Escape + outside-click are
  // handled by the parent; useDialog still restores focus to the trigger on close.
  const menuRef = useDialog<HTMLDivElement>({ onClose, trapFocus: false });
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Character actions"
      className="absolute right-0 top-9 w-52 card elev-md p-1.5 space-y-0.5 text-sm z-40"
    >
      <button
        type="button"
        role="menuitem"
        className="w-full text-left px-2 py-1.5 rounded-md text-rose-400 disabled:opacity-50 disabled:cursor-default"
        onClick={onTrash}
        disabled={busy}
      >
        Move to Trash…
      </button>
    </div>
  );
}
