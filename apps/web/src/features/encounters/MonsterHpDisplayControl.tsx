/**
 * Per-encounter monster-HP display dial for players (issue #1925).
 *
 * The server is the SOLE enforcement point (`redactMonsterHp` in
 * encounters.service.ts) — this control only tells the server which mode to
 * switch to; it never redacts or reveals anything client-side. 'band' (default)
 * keeps today's coarse Healthy/Bloodied/Critical/Down status; 'exact' ships real
 * numbers to players (a tactical table that wants the numbers on display);
 * 'hidden' ships neither (a monster at 0 HP still reports 'down' in every mode).
 */
import { useTranslation } from 'react-i18next';
import type { MonsterHpDisplay } from '@campfire/schema';

const MODE_ORDER: readonly MonsterHpDisplay[] = ['band', 'exact', 'hidden'];

export interface MonsterHpDisplayControlProps {
  /** The encounter's current mode (controlled). */
  value: MonsterHpDisplay;
  /** Called with the new mode when the DM picks one. */
  onChange: (mode: MonsterHpDisplay) => void;
  /** Disables every option (e.g. while the sync gate blocks writes, or a write is in flight). */
  disabled?: boolean;
}

export function MonsterHpDisplayControl({ value, onChange, disabled = false }: MonsterHpDisplayControlProps) {
  const { t } = useTranslation();
  const label = (mode: MonsterHpDisplay) => t(`encounters.monsterHpDisplay.${mode}`);
  const description = (mode: MonsterHpDisplay) => t(`encounters.monsterHpDisplay.${mode}Description`);

  return (
    <div className="flex items-center gap-1.5" data-testid="monster-hp-display-control">
      <span className="text-muted" style={{ fontSize: 12 }}>
        {t('encounters.monsterHpDisplay.label')}
      </span>
      <div
        className="seg"
        role="radiogroup"
        aria-label={t('encounters.monsterHpDisplay.label')}
        aria-disabled={disabled || undefined}
      >
        {MODE_ORDER.map((mode) => {
          const checked = mode === value;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => {
                if (!checked) onChange(mode);
              }}
              className="seg-opt"
              style={
                checked
                  ? { color: 'var(--color-accent)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' }
                  : undefined
              }
              title={description(mode)}
              data-testid={`monster-hp-display-option-${mode}`}
            >
              {label(mode)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
