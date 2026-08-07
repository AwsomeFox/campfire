/**
 * Accessible fallback for the drag-to-reorder initiative affordance (issue #1923).
 * Drag is pointer/mouse-only; every reorder must also be reachable without a pointer —
 * "Move up", "Move down", and "Move after…" cover the same three server-facing intents
 * (`afterCombatantIdForMoveUp`/`Down` and an explicit `afterCombatantId`) a drag resolves
 * to. Mirrors PageHeader's `OverflowMenuPanel` (`useDialog` for focus/Escape, `role="menu"`
 * / `role="menuitem"`) so this reads as the same kind of control, not a bespoke one.
 */
import { useId, useRef, useState } from 'react';
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
  const menuRef = useDialog<HTMLDivElement>({ onClose: () => setOpen(false), trapFocus: false });

  const close = () => setOpen(false);

  return (
    <div className="relative inline-flex" data-testid={`reorder-menu-${combatantName}`}>
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
