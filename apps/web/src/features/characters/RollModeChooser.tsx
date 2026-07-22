/**
 * Roll-mode segmented control for the character sheet roll surfaces (issue #713).
 *
 * Saving throws, skills, and "to hit" attack rolls previously exposed advantage
 * and disadvantage ONLY through keyboard modifiers (shift/alt-click) described in
 * hover titles — touch users could submit only flat rolls. This chooser is the
 * touch- and keyboard-visible replacement, reused across all three roll cards.
 *
 * Design notes:
 *  - Visual: matches the app's established `.seg` / `.seg-opt` segmented control
 *    (PreferencesPage, NotesRail) so it reads as a native Campfire control.
 *  - Accessibility: rendered as a WAI-ARIA radiogroup (`role="radiogroup"`)
 *    with `role="radio"` options that support roving-tabindex arrow-key
 *    navigation, announce the selected mode via `aria-checked`, and each carry
 *    a descriptive accessible name. This meets the bar for keyboard-only and
 *    screen-reader use without depending on hover.
 *  - Keyboard shortcut coexistence: the chooser holds the PERSISTENT selection
 *    (the one-tap default). A modifier-key click still wins for that single
 *    roll (see `resolveRollMode`) so desktop power users keep their shortcut —
 *    the chooser is the always-visible path, not a replacement for it.
 *  - Compact by default: sized to sit inline next to a roll chip on mobile.
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';
import { ROLL_MODES, rollModeOptions, type RollMode } from './rollMode';

export interface RollModeChooserProps {
  /** The currently selected mode (controlled). */
  value: RollMode;
  /** Called with the new mode when the user picks one. */
  onChange: (mode: RollMode) => void;
  /** Disables every option (e.g. while a roll is in flight). */
  disabled?: boolean;
  /**
   * Accessible label for the group, naming WHAT the modes apply to — e.g.
   * "Saving throw roll mode". Required so a screen reader announces the
   * context rather than three ambiguous "Flat / Advantage / Disadvantage"
   * options with no grouping label.
   */
  'aria-label': string;
}

const OPTION_ORDER: ReadonlyArray<RollMode> = ROLL_MODES;

export function RollModeChooser({ value, onChange, disabled = false, ...rest }: RollModeChooserProps) {
  const options = rollModeOptions();
  const ariaLabel = rest['aria-label'];
  // Roving tabindex: only the focused/selected option is in the tab order; the
  // rest are reached via arrow keys (standard radiogroup interaction).
  const refs = useRef<Partial<Record<RollMode, HTMLButtonElement | null>>>({});

  const focusMode = useCallback((mode: RollMode) => {
    refs.current[mode]?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, mode: RollMode) {
    // Arrow keys move between options (and wrap). Home/End jump to the ends.
    // We do NOT preventDefault on every key — only the ones we handle, so
    // Tab/Shift+Tab still leave the group naturally.
    const idx = OPTION_ORDER.indexOf(mode);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % OPTION_ORDER.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (idx - 1 + OPTION_ORDER.length) % OPTION_ORDER.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = OPTION_ORDER.length - 1;
    if (nextIdx == null) return;
    e.preventDefault();
    const next = OPTION_ORDER[nextIdx]!;
    onChange(next);
    focusMode(next);
  }

  return (
    <div
      className="seg seg-wrap cf-roll-mode"
      role="radiogroup"
      aria-label={ariaLabel}
      // `aria-disabled` announces the group state; the buttons stay individually
      // disabled too so the roving-tabindex logic does not strand focus on a
      // tabbable-but-inert option while a roll is resolving.
      aria-disabled={disabled || undefined}
      style={{ minWidth: 0 }}
    >
      {options.map((opt) => {
        const checked = opt.mode === value;
        return (
          <button
            key={opt.mode}
            ref={(el) => {
              refs.current[opt.mode] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={opt.description}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(opt.mode)}
            onKeyDown={(e) => onKeyDown(e, opt.mode)}
            className="seg-opt cf-roll-mode-opt"
            style={
              checked
                ? { color: 'var(--color-accent)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' }
                : undefined
            }
            title={opt.description}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
