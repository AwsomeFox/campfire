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
import { hasInitiativeRollForAdapter, initiativeModelForAdapter, type RuleSystemAdapter } from '@campfire/schema';

/**
 * Whether the character sheet shows an initiative tile for this system.
 *
 * Two different questions, and `checkCatalogForAdapter` only answers the first. Whether the
 * roll may HAPPEN is enforced there, so a system with no initiative (Starforged) contributes
 * no catalog entry and REST/MCP cannot roll one. But an absent entry renders as
 * "Initiative —", which reads as a real stat nobody filled in — so whether the TILE appears
 * has to ask `hasInitiativeRoll` directly. A group-initiative system is the mirror case: its
 * entry is legitimate (the encounter rolls once per side) and only the per-character tile
 * would contradict it.
 *
 * Extracted so the rule is unit-testable against real adapters; it regressed once when the
 * capability moved into the catalog and this half was assumed to have moved with it.
 */
export function showsInitiativeTile(adapter: RuleSystemAdapter): boolean {
  return hasInitiativeRollForAdapter(adapter) && initiativeModelForAdapter(adapter).mode !== 'group';
}

/** The three roll modes a d20 check/attack can be taken with. */
export type RollMode = 'normal' | 'advantage' | 'disadvantage' | 'crit';

export const ROLL_MODES: ReadonlyArray<RollMode> = ['normal', 'advantage', 'disadvantage'];

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
    { mode: 'normal', label: 'Normal', description: 'Normal — roll one d20' },
    { mode: 'advantage', label: 'Advantage', description: 'Advantage — roll two d20 and keep the higher' },
    { mode: 'disadvantage', label: 'Disadvantage', description: 'Disadvantage — roll two d20 and keep the lower' },
  ];
}

/** A one-line summary of the currently selected mode, shown before submission. */
export function rollModeSummary(mode: RollMode): string {
  switch (mode) {
    case 'advantage':
      return 'Rolling with advantage';
    case 'disadvantage':
      return 'Rolling with disadvantage';
    case 'crit':
      return 'Critical hit';
    default:
      return 'Normal roll';
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
  if (modifiers.shiftKey) return 'advantage';
  if (modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) return 'disadvantage';
  return chosen;
}

/**
 * Resolve the mode for ONE interaction with a `RollContextMenu`-backed control that also
 * has a visible chooser beside it.
 *
 * `RollContextMenu` folds shift/alt-click and its long-press menu into the single `clicked`
 * mode it emits. A non-`normal` value is always an explicit override and wins. `'normal'`
 * is ambiguous — it is emitted both by a plain click (no preference expressed, so the
 * chooser's standing selection should apply) and by picking "Normal" from the menu (an
 * explicit request for a flat roll, which must NOT be overridden by the chooser).
 *
 * `event` disambiguates them: `RollContextMenu` passes the MouseEvent on the plain-click
 * path and nothing on the menu path. That contract is load-bearing here — see the note on
 * `onRoll` in RollContextMenu.tsx.
 *
 * Call sites previously passed `clicked` into {@link resolveRollMode} with modifiers
 * derived from `clicked` itself, making that call a no-op and the chooser decorative: a
 * touch user who selected Advantage and tapped an attack still submitted a flat d20 — the
 * exact gap issue #713 added the chooser to close.
 */
export function rollModeForClick(clicked: RollMode, chosen: RollMode, event?: unknown): RollMode {
  if (clicked !== 'normal') return clicked;
  return event === undefined ? 'normal' : chosen;
}

export function toCheckRollMode(mode: RollMode): 'normal' | 'advantage' | 'disadvantage' | 'crit' {
  return mode;
}


