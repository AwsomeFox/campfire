import type { EncounterEvent } from '@campfire/schema';

/**
 * Issue #1919 — turns a resolved death-save roll into a presentation state distinct
 * enough to read at the table: a nat 20 revive, a fresh death, a fresh stabilization,
 * or a plain success/failure. Pure and rule-free (no d20 logic lives here — the server
 * already applied it); this only classifies what the server already decided.
 */
export type DeathSaveOutcomeKind = 'revive' | 'dead' | 'stabilized' | 'success' | 'failure';

export interface DeathSaveOutcome {
  /** The resolved server d20 face (1-20). Never client-guessed. */
  natural: number;
  kind: DeathSaveOutcomeKind;
}

/**
 * Mirrors `deathSaveRollEventDetail` (apps/server/src/modules/encounters/encounters.service.ts)
 * ordering byte-for-byte, so the roller's tracker and the server's combat-log/audit text
 * never disagree about which outcome a roll represents:
 *   1. a natural 20 always reads as a revive, regardless of the resulting deathState —
 *      5e revives at 1 HP on a nat 20 even from a fresh dying combatant;
 *   2. a fresh transition to `dead` (third failure, including a nat 1 pushing to it);
 *   3. a fresh transition to `stable` (third success);
 *   4. otherwise a plain success (10-19) or failure (2-9).
 */
export function classifyDeathSaveOutcome(
  natural: number,
  beforeDeathState: string,
  afterDeathState: string,
): DeathSaveOutcomeKind {
  if (natural === 20) return 'revive';
  if (afterDeathState === 'dead' && beforeDeathState !== 'dead') return 'dead';
  if (afterDeathState === 'stable' && beforeDeathState !== 'stable') return 'stabilized';
  return natural >= 10 ? 'success' : 'failure';
}

/**
 * Stable prefix `deathSaveRollEventDetail` always writes to the shared combat-log
 * `roll` event. Used to recognize a death-save roll from the already role-projected
 * event feed alone — never a new SSE type or schema field (issue #1919 stays within
 * the existing dice-log/combat-log signals; see #1511 for future roll-identity work).
 */
const DEATH_SAVE_ROLL_DETAIL_PREFIX = 'death save d20 roll ';
const DEATH_SAVE_ROLL_DETAIL_RE = /^death save d20 roll (\d+):/;

/** True for a combat-log `roll` event produced by a death-save roll. */
export function isDeathSaveRollEvent(event: Pick<EncounterEvent, 'type' | 'detail'>): boolean {
  return event.type === 'roll' && event.detail.startsWith(DEATH_SAVE_ROLL_DETAIL_PREFIX);
}

/** The natural d20 face embedded in a death-save roll event's detail text, or null. */
export function deathSaveRollNatural(detail: string): number | null {
  const match = DEATH_SAVE_ROLL_DETAIL_RE.exec(detail);
  if (!match) return null;
  const natural = Number(match[1]);
  return Number.isFinite(natural) ? natural : null;
}

export interface DeathSaveSpectatorToastInfo {
  /** Verbatim `event.target` — never re-derived, never a raw/unredacted lookup. */
  name: string;
  natural: number;
  outcomeKind: 'success' | 'failure';
}

/**
 * Pure extraction for the "table side" spectator toast (issue #1919). Reads ONLY the
 * already role-projected event fields (`target`, `detail`) — the exact same fields
 * `CombatLog` renders for every viewer via `redactEncounterEventsForViewer`
 * (encounters.logic.ts, issue #869). This is the client half of the secrecy boundary:
 * the server redacts a hidden combatant's name to the literal `"Unknown combatant"`
 * placeholder (never `null`) before this ever reaches the client, so this function
 * cannot expose an identity the server did not already decide to reveal — it only ever
 * passes `event.target` through verbatim, matching whatever CombatLog already shows for
 * the same event. A missing/empty target (no resolvable name at all, e.g. a malformed
 * legacy row) yields no toast rather than a fabricated name.
 */
export function deathSaveSpectatorToastInfo(
  event: Pick<EncounterEvent, 'type' | 'detail' | 'target'>,
): DeathSaveSpectatorToastInfo | null {
  if (!isDeathSaveRollEvent(event)) return null;
  const natural = deathSaveRollNatural(event.detail);
  const name = event.target?.trim();
  if (natural == null || !name) return null;
  return { name, natural, outcomeKind: natural >= 10 ? 'success' : 'failure' };
}

