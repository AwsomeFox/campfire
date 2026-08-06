/**
 * Per-encounter monster-HP display dial for players (issue #1925).
 *
 * The server is the SOLE enforcement point (`redactMonsterHp` in
 * encounters.service.ts) — this control only tells the server which mode to
 * switch to; it never redacts or reveals anything client-side. 'band' (default)
 * keeps today's coarse Healthy/Bloodied/Critical/Down status; 'exact' ships real
 * numbers to players (a tactical table that wants the numbers on display);
 * 'hidden' ships neither (a monster at 0 HP still reports 'down' in every mode).
 *
 * Interaction model copied from `RollModeChooser` (issue #713) rather than
 * invented from scratch — a WAI-ARIA radiogroup with roving tabindex: only the
 * selected option is in the tab order, Left/Right/Up/Down/Home/End move between
 * options and immediately select + focus the new one, matching the app's other
 * `.seg` segmented controls (`RollModeChooser`, `RsvpChooser`).
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MonsterHpDisplay } from '@campfire/schema';

export const MONSTER_HP_DISPLAY_MODE_ORDER: readonly MonsterHpDisplay[] = ['band', 'exact', 'hidden'];

/**
 * Pure roving-tabindex navigation math, extracted so it can be unit-tested without
 * mounting the component (this repo's fast unit-test layer runs pure Node, no DOM/
 * browser — see playwright.unit.config.ts). Returns the next index for a navigation
 * key, or null if the key is not one this control handles (e.g. Tab).
 */
export function nextMonsterHpDisplayIndex(key: string, currentIndex: number, length: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % length;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + length) % length;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return null;
}

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

  // Roving tabindex: only the focused/selected option is in the tab order; the
  // rest are reached via arrow keys (standard radiogroup interaction).
  const refs = useRef<Partial<Record<MonsterHpDisplay, HTMLButtonElement | null>>>({});

  const focusMode = useCallback((mode: MonsterHpDisplay) => {
    refs.current[mode]?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, mode: MonsterHpDisplay) {
    const idx = MONSTER_HP_DISPLAY_MODE_ORDER.indexOf(mode);
    const nextIdx = nextMonsterHpDisplayIndex(e.key, idx, MONSTER_HP_DISPLAY_MODE_ORDER.length);
    if (nextIdx == null) return;
    e.preventDefault();
    const next = MONSTER_HP_DISPLAY_MODE_ORDER[nextIdx]!;
    onChange(next);
    focusMode(next);
  }

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
        {MONSTER_HP_DISPLAY_MODE_ORDER.map((mode) => {
          const checked = mode === value;
          return (
            <button
              key={mode}
              ref={(el) => {
                refs.current[mode] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              disabled={disabled}
              onClick={() => {
                if (!checked) onChange(mode);
              }}
              onKeyDown={(e) => onKeyDown(e, mode)}
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
