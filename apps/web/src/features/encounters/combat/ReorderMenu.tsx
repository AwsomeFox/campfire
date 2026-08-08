/**
 * Accessible fallback for the drag-to-reorder initiative affordance (issue #1923).
 * Drag is pointer/mouse-only; every reorder must also be reachable without a pointer —
 * "Move up", "Move down", and "Move after…" cover the same three server-facing intents
 * (`afterCombatantIdForMoveUp`/`Down` and an explicit `afterCombatantId`) a drag resolves
 * to. Mirrors PageHeader's `OverflowMenuPanel` (`useDialog` for focus/Escape, `role="menu"`
 * / `role="menuitem"`) so this reads as the same kind of control, not a bespoke one.
 *
 * Issue #2074 review finding 6: `useDialog` deliberately does NOT close on an outside
 * click — its own doc comment says the caller owns "backdrop click, …". PageHeader's
 * `OverflowMenuPanel` (and StatusMenuButton) each add that themselves, one level up, via
 * a `pointerdown` listener on a `containerRef` wrapping both the trigger and the panel.
 * This component previously claimed to mirror that control without actually adding the
 * listener, so a click anywhere outside the menu — including on another row's controls —
 * left it open. Added here, same pattern.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialog } from '../../../components/useDialog';
import { Btn } from '../../../components/ui';

export function ReorderMenu({
  combatantName,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  menuTargets,
  onMoveAfter,
  disabled,
}: {
  combatantName: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  menuTargets: readonly { id: number; name: string }[];
  onMoveAfter: (afterCombatantId: number | 'top') => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [afterTarget, setAfterTarget] = useState<string>('top');
  const buttonId = useId();
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useDialog<HTMLDivElement>({ onClose: () => setOpen(false), trapFocus: false });

  const close = () => setOpen(false);

  // Outside-click dismissal (issue #2074 review finding 6) — matches PageHeader's
  // OverflowMenuPanel / StatusMenuButton: a pointerdown outside the trigger+panel
  // container closes the menu without forcing focus back to the trigger (a forced
  // refocus on pointerdown would fight whatever the user actually clicked next).
  useEffect(() => {
    if (!open) return;
    const root = containerRef.current;
    function onPointerDown(event: PointerEvent) {
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      close();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex" data-testid={`reorder-menu-${combatantName}`}>
      <Btn
        ghost
        ref={buttonRef}
        type="button"
        id={buttonId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('encounters.reorder.menuLabel', 'Reorder {{name}} in initiative', { name: combatantName })}
        data-testid={`reorder-menu-trigger-${combatantName}`}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        style={{ fontSize: 'var(--type-label)' }}
      >
        ⋮
      </Btn>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          className="cf-popover"
          data-testid={`reorder-menu-panel-${combatantName}`}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            zIndex: 40,
            background: 'var(--color-bg-elevated, #ffffff)',
            border: '1px solid var(--color-border, #e5e5e5)',
            borderRadius: 6,
            padding: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minWidth: 220,
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="btn btn-ghost"
            data-testid={`reorder-move-up-${combatantName}`}
            disabled={!canMoveUp}
            onClick={() => { onMoveUp(); close(); }}
            style={{ justifyContent: 'flex-start' }}
          >
            {t('encounters.reorder.moveUp', 'Move up')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="btn btn-ghost"
            data-testid={`reorder-move-down-${combatantName}`}
            disabled={!canMoveDown}
            onClick={() => { onMoveDown(); close(); }}
            style={{ justifyContent: 'flex-start' }}
          >
            {t('encounters.reorder.moveDown', 'Move down')}
          </button>
          {menuTargets.length > 0 && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid var(--color-border, #e5e5e5)' }}>
              <label htmlFor={`${menuId}-after`} style={{ fontSize: 12 }}>
                {t('encounters.reorder.moveAfterLabel', 'Move after…')}
              </label>
              <select
                id={`${menuId}-after`}
                value={afterTarget}
                onChange={(e) => setAfterTarget(e.target.value)}
                style={{ flex: 1, minWidth: 100 }}
              >
                <option value="top">{t('encounters.reorder.top', 'the top')}</option>
                {menuTargets.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost"
                data-testid={`reorder-move-after-go-${combatantName}`}
                onClick={() => {
                  onMoveAfter(afterTarget === 'top' ? 'top' : Number(afterTarget));
                  close();
                }}
              >
                {t('encounters.reorder.go', 'Move')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
