/**
 * Roll-mode labels for the character sheet roll controls (issue #713).
 *
 * Saving throws, skills, and attack "to hit" rolls used to expose advantage /
 * disadvantage only via keyboard modifiers (shift/alt-click) described in hover
 * titles — invisible to touch users, who could submit only a flat d20. This
 * module is the pure, UI-agnostic source of truth for the three modes a visible
 * chooser offers, so the chooser component (and a unit test) can stay thin.
 *
 * The labels are written for a d20-and-modifier system (5e: advantage rolls two
 * d20s and keeps the higher; disadvantage keeps the lower). There is no
 * per-ruleset "advantage" hook on `RuleSystemAdapter` today, so the vocabulary
 * stays simple and generic; a future dice-pool system that does not use the
 * notion would simply not render the chooser (the action surface gates on
 * `RollMode.isApplicable`).
 */
import type { Adv } from '../../lib/characterStats';

/** The three roll modes a d20 check/attack can be taken with. */
export type RollMode = Adv;

export const ROLL_MODES: ReadonlyArray<RollMode> = ['flat', 'adv', 'dis'];

export interface RollModeOption {
  mode: RollMode;
  /** Short label shown on the segmented control button. */
  label: string;
  /** Accessible name / aria-label combining the label with its effect. */
  description: string;
}

/**
 * The chooser options. Kept as a function (not a constant) so a future ruleset
 * could substitute terminology; today every system resolves to the same 5e-style
 * vocabulary because there is no ruleset advantage hook to branch on.
 */
export function rollModeOptions(): ReadonlyArray<RollModeOption> {
  return [
    { mode: 'flat', label: 'Flat', description: 'Flat — roll one d20' },
    { mode: 'adv', label: 'Advantage', description: 'Advantage — roll two d20 and keep the higher' },
    { mode: 'dis', label: 'Disadvantage', description: 'Disadvantage — roll two d20 and keep the lower' },
  ];
}

/** A one-line summary of the currently selected mode, shown before submission. */
export function rollModeSummary(mode: RollMode): string {
  switch (mode) {
    case 'adv':
      return 'Rolling with advantage';
    case 'dis':
      return 'Rolling with disadvantage';
    default:
      return 'Flat roll';
  }
}

/**
 * Merge a persistent chooser selection with an ad-hoc keyboard-modifier click.
 * Desktop power users keep their shift/alt-click shortcut: when a modifier key
 * is held, that one-shot override wins for THIS roll only (the chooser state is
 * untouched, so the next plain tap reverts to the chosen default). A touch user
 * with no modifiers always rolls the chosen mode.
 */
export function resolveRollMode(chosen: RollMode, modifiers: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): RollMode {
  if (modifiers.shiftKey) return 'adv';
  if (modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) return 'dis';
  return chosen;
}

