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
 * Interaction model: a WAI-ARIA radiogroup with roving tabindex, same base
 * pattern as `RollModeChooser` (issue #713) — but MANUAL activation, not
 * automatic. `RollModeChooser` commits on every arrow press because a roll mode
 * has no consequence until the roll button is pressed. This control is
 * different: each commit is an immediate server PATCH with a secrecy effect
 * (issue #1925 review, finding: keyboard nav from 'band' to 'hidden' passed
 * through 'exact' and committed it for a moment, briefly shipping real HP to
 * every player mid-navigation). WAI-ARIA explicitly allows both patterns; a
 * control whose selection has a consequence belongs in the manual-activation
 * one. So here: Arrow/Home/End move focus and the local highlight ONLY —
 * `onChange` (the server write) fires ONLY on Enter/Space (or a mouse click,
 * which commits immediately as usual). `aria-checked` and the accent-color
 * highlight both track the COMMITTED `value` prop, never the mid-navigation
 * focus position, so assistive tech never announces a state the server
 * doesn't hold.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MonsterHpDisplay } from '@campfire/schema';

export const MONSTER_HP_DISPLAY_MODE_ORDER: readonly MonsterHpDisplay[] = ['band', 'exact', 'hidden'];

/**
 * Pure roving-tabindex navigation math, extracted so it can be unit-tested without
 * mounting the component (this repo's fast unit-test layer runs pure Node, no DOM/
 * browser — see playwright.unit.config.ts). Returns the next index for a navigation
 * key, or null if the key does not move focus (e.g. Tab, or a commit key).
 */
export function nextMonsterHpDisplayIndex(key: string, currentIndex: number, length: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % length;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + length) % length;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return null;
}

/**
 * A key that COMMITS the currently-focused option (manual-activation radiogroup —
 * see the module doc comment for why this control cannot use RollModeChooser's
 * automatic-activation pattern). Space is reported by browsers as `' '`; the
 * legacy `'Spacebar'` string is accepted too for older engines.
 */
export function isMonsterHpDisplayCommitKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

export interface MonsterHpDisplayKeyResult {
  /** Where focus/highlight should land after this key (unchanged if the key didn't move it). */
  focusedIndex: number;
  /** Non-null exactly when this key COMMITS — the index to write via onChange. Every other
   *  key (navigation, or one this control doesn't handle) leaves this null. */
  commitIndex: number | null;
}

/**
 * The complete key-handling decision, extracted as one pure function so the exact logic
 * the component's onKeyDown runs is unit-testable without mounting anything (this repo's
 * fast unit-test layer is pure Node — see playwright.unit.config.ts). This is the single
 * chokepoint that keeps navigation and commit decoupled: a caller cannot get a non-null
 * `commitIndex` out of an Arrow/Home/End key no matter what `focusedIndex` starts as.
 */
export function monsterHpDisplayHandleKey(key: string, focusedIndex: number, length: number): MonsterHpDisplayKeyResult {
  const moved = nextMonsterHpDisplayIndex(key, focusedIndex, length);
  if (moved != null) return { focusedIndex: moved, commitIndex: null };
  if (isMonsterHpDisplayCommitKey(key)) return { focusedIndex, commitIndex: focusedIndex };
  return { focusedIndex, commitIndex: null };
}

export interface MonsterHpDisplayControlProps {
  /** The encounter's current, COMMITTED mode (controlled). */
  value: MonsterHpDisplay;
  /** Called with the new mode when the DM commits one (Enter/Space, or a click). */
  onChange: (mode: MonsterHpDisplay) => void;
  /** Disables every option (e.g. while the sync gate blocks writes, or a write is in flight). */
  disabled?: boolean;
}

export function MonsterHpDisplayControl({ value, onChange, disabled = false }: MonsterHpDisplayControlProps) {
  const { t } = useTranslation();
  const label = (mode: MonsterHpDisplay) => t(`encounters.monsterHpDisplay.${mode}`);
  const description = (mode: MonsterHpDisplay) => t(`encounters.monsterHpDisplay.${mode}Description`);

  // Roving tabindex: only the focused option is in the tab order; the rest are
  // reached via arrow keys (standard radiogroup interaction). `focusedMode` is
  // PURELY a highlight/focus position — it never itself triggers `onChange`.
  // It re-syncs to the committed value whenever that value changes from outside
  // (another DM device, or the server refetch after this control's own commit).
  const [focusedMode, setFocusedMode] = useState<MonsterHpDisplay>(value);
  useEffect(() => {
    setFocusedMode(value);
  }, [value]);

  const refs = useRef<Partial<Record<MonsterHpDisplay, HTMLButtonElement | null>>>({});

  const focusMode = useCallback((mode: MonsterHpDisplay) => {
    refs.current[mode]?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, mode: MonsterHpDisplay) {
    const idx = MONSTER_HP_DISPLAY_MODE_ORDER.indexOf(mode);
    const result = monsterHpDisplayHandleKey(e.key, idx, MONSTER_HP_DISPLAY_MODE_ORDER.length);
    if (result.commitIndex == null && result.focusedIndex === idx) return; // unhandled key (e.g. Tab)
    e.preventDefault();
    if (result.commitIndex != null) {
      // COMMIT: Enter/Space on the currently-focused option. This is the only path that
      // calls onChange from the keyboard — the fix for the pre-fix version, which called
      // onChange on every Arrow/Home/End too, briefly shipping an intermediate mode (e.g.
      // 'exact' on the way from 'band' to 'hidden') to every player mid-navigation.
      const committedMode = MONSTER_HP_DISPLAY_MODE_ORDER[result.commitIndex]!;
      if (committedMode !== value) onChange(committedMode);
      return;
    }
    // MOVE: highlight/focus only, never a commit.
    const next = MONSTER_HP_DISPLAY_MODE_ORDER[result.focusedIndex]!;
    setFocusedMode(next);
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
          // `checked` (aria-checked + the accent highlight) tracks the COMMITTED
          // value — never `focusedMode` — so nothing on screen (or announced to
          // assistive tech) implies the server holds a mode it doesn't yet.
          const checked = mode === value;
          const isFocusTarget = mode === focusedMode;
          return (
            <button
              key={mode}
              ref={(el) => {
                refs.current[mode] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={isFocusTarget ? 0 : -1}
              disabled={disabled}
              onClick={() => {
                setFocusedMode(mode);
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
