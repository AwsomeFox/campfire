/**
 * Group action rolls (issue #1922) — pure, web-orchestrated logic. No server/schema change:
 * the browser loops the EXISTING per-actor `POST /encounters/:id/actions/resolve` endpoint
 * (`commit: true`) sequentially, exactly the way an MCP caller already can. This module owns
 * three pieces of pure logic that are easy to get subtly wrong and are kept independent of
 * React so they can be unit-tested directly:
 *
 *  - {@link findGroupActionCandidates} — eligibility: which OTHER living monster/npc
 *    combatants share the action a DM just opened, by `ruleEntryId` or by an identical
 *    resolvable action (name + toHit + damage) on their own fetched actions list.
 *  - {@link runGroupActionSequence} — the sequential apply loop. An actor whose action-economy
 *    slot is already spent this turn (`action_economy_exhausted`, thrown by
 *    `ActionResolverService.apply` — see action-resolver.service.ts) is SKIPPED with a label,
 *    never surfaced as a failure. Any other error stops the loop; every candidate at or after
 *    that point is reported `not-run`/`failed` rather than silently attempted.
 *  - {@link undoGroupActionsInReverseOrder} — "Undo all" replays captured undo tokens in
 *    REVERSE apply order, mirroring how a stack of consequences unwinds (issue #1922
 *    acceptance: "Undo all restores all targets' HP, replaying in reverse order").
 */
import type { ActionResolveResult, ActionSpec, ActionUndoToken, Combatant, UsableAction } from '@campfire/schema';
import { ApiError } from '../../lib/api';
import { isDead } from './encounterEndedSummary';

/** The (name, toHit, damage) fingerprint of the action the DM opened the Use flow for. */
export interface GroupActionSourceAction {
  name: string;
  toHit: string;
  damage: string;
}

/** One other living combatant eligible to run the same action, and which of THEIR OWN action
 *  rows (own index/spec — never the actor's) actually matched. */
export interface GroupActionCandidate {
  combatantId: number;
  combatantName: string;
  actionIndex: number;
  actionName: string;
  spec: ActionSpec;
}

/**
 * Eligibility (issue #1922 acceptance): "Grouping matches by ruleEntryId or identical action
 * name+toHit+damage; dead combatants excluded."
 *
 * Only monster/npc combatants with no linked character sheet are candidates — the group flow
 * only ever opens from a monster/npc's inline statblock action list (`CombatantActionsList`),
 * never a character's sheet actions. A candidate whose own actions have not been fetched yet
 * (absent from `actionsByCombatantId`) is excluded rather than guessed at: without its own
 * action list there is no `actionIndex`/`spec` to actually resolve against.
 *
 * `ruleEntryId` equality alone does not skip the fingerprint lookup — it still needs the
 * candidate's OWN action index/spec to call `resolve` with (a shared compendium entry does not
 * imply identical array ordering), so it only ever WIDENS the match to a same-named action when
 * no exact (name+toHit+damage) match exists on that candidate (e.g. a per-instance override).
 */
export function findGroupActionCandidates(input: {
  combatants: readonly Combatant[];
  actorCombatantId: number;
  sourceAction: GroupActionSourceAction;
  actionsByCombatantId: ReadonlyMap<number, readonly UsableAction[]>;
}): GroupActionCandidate[] {
  const actor = input.combatants.find((c) => c.id === input.actorCombatantId);
  if (!actor) return [];
  const candidates: GroupActionCandidate[] = [];
  for (const c of input.combatants) {
    if (c.id === actor.id) continue;
    if (c.characterId != null) continue;
    if (c.kind !== 'monster' && c.kind !== 'npc') continue;
    if (isDead(c)) continue;
    const actions = input.actionsByCombatantId.get(c.id);
    if (!actions) continue;
    const fingerprintAction = actions.find(
      (a) =>
        a.resolvable &&
        a.spec != null &&
        a.name === input.sourceAction.name &&
        a.toHit === input.sourceAction.toHit &&
        a.damage === input.sourceAction.damage,
    );
    if (fingerprintAction && fingerprintAction.spec) {
      candidates.push({
        combatantId: c.id,
        combatantName: c.name,
        actionIndex: fingerprintAction.index,
        actionName: fingerprintAction.name,
        spec: fingerprintAction.spec,
      });
      continue;
    }
    const ruleEntryMatch = actor.ruleEntryId != null && c.ruleEntryId === actor.ruleEntryId;
    if (!ruleEntryMatch) continue;
    const nameMatch = actions.find((a) => a.resolvable && a.spec != null && a.name === input.sourceAction.name);
    if (nameMatch && nameMatch.spec) {
      candidates.push({
        combatantId: c.id,
        combatantName: c.name,
        actionIndex: nameMatch.index,
        actionName: nameMatch.name,
        spec: nameMatch.spec,
      });
    }
  }
  return candidates;
}

export type GroupActionRowStatus = 'applied' | 'skipped' | 'failed' | 'not-run';

export interface GroupActionRowResult {
  combatantId: number;
  combatantName: string;
  status: GroupActionRowStatus;
  /** `resolution.playerSummary` from the server, for an 'applied' row. */
  summaryText?: string;
  undoToken?: ActionUndoToken;
  /** Human-readable reason for 'skipped' (spent action slot) or 'failed'. */
  reason?: string;
}

export interface GroupActionRunOutcome {
  results: GroupActionRowResult[];
  /** True when a non-skip error stopped the loop before every candidate ran. */
  stoppedEarly: boolean;
}

/** The server's code for "this actor's action-economy slot for this cost is already spent
 *  this turn" (`ActionResolverService`'s apply-time economy guard, action-resolver.service.ts).
 *  Distinguishing this from every other failure is what lets a spent slot be SKIPPED rather
 *  than treated as a loop-stopping error (issue #1922 acceptance). */
export function isActionEconomyExhausted(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'action_economy_exhausted';
}

function errorMessageFrom(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The sequential apply loop (issue #1922). Calls `resolveOne` for each candidate IN ORDER,
 * awaiting each before starting the next — each apply is already atomic/idempotent
 * server-side (`applyInternal` in action-resolver.service.ts), so this loop adds no new
 * transaction of its own, just sequencing.
 *
 * - A resolved slot-exhaustion error (see {@link isActionEconomyExhausted}) marks that row
 *   `skipped` and CONTINUES the loop — never treated as a failure.
 * - Any other error marks that row `failed`, stops the loop, and marks every remaining
 *   candidate `not-run` — "Mid-loop failure stops the loop and reports applied vs not-run
 *   actors" (issue #1922 acceptance).
 */
export async function runGroupActionSequence(
  candidates: readonly GroupActionCandidate[],
  resolveOne: (candidate: GroupActionCandidate) => Promise<ActionResolveResult>,
): Promise<GroupActionRunOutcome> {
  const results: GroupActionRowResult[] = [];
  let stoppedEarly = false;
  for (const candidate of candidates) {
    if (stoppedEarly) {
      results.push({ combatantId: candidate.combatantId, combatantName: candidate.combatantName, status: 'not-run' });
      continue;
    }
    try {
      const res = await resolveOne(candidate);
      results.push({
        combatantId: candidate.combatantId,
        combatantName: candidate.combatantName,
        status: 'applied',
        summaryText: res.resolution.playerSummary,
        undoToken: res.undoToken ?? undefined,
      });
    } catch (err) {
      if (isActionEconomyExhausted(err)) {
        results.push({
          combatantId: candidate.combatantId,
          combatantName: candidate.combatantName,
          status: 'skipped',
          reason: 'noAction',
        });
        continue;
      }
      results.push({
        combatantId: candidate.combatantId,
        combatantName: candidate.combatantName,
        status: 'failed',
        reason: errorMessageFrom(err),
      });
      stoppedEarly = true;
    }
  }
  return { results, stoppedEarly };
}

/**
 * "Undo all" (issue #1922 acceptance: "Undo all restores all targets' HP, replaying in reverse
 * order"). `tokens` is passed in APPLY order (oldest first); this replays them newest-first so
 * a later action's consequences (e.g. HP already changed again by an even later apply on the
 * same target) unwind before the earlier one, mirroring how a stack of changes must come back
 * off in reverse to stay consistent. Stops on the first failed undo and reports how many
 * succeeded, rather than pressing on and risking an inconsistent partial state.
 */
export async function undoGroupActionsInReverseOrder(
  tokens: readonly ActionUndoToken[],
  undoOne: (token: ActionUndoToken) => Promise<void>,
): Promise<{ undoneCount: number; failed: boolean }> {
  const reversed = [...tokens].reverse();
  let undoneCount = 0;
  for (const token of reversed) {
    try {
      await undoOne(token);
      undoneCount++;
    } catch {
      return { undoneCount, failed: true };
    }
  }
  return { undoneCount, failed: false };
}
