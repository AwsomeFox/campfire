import { BadRequestException, ConflictException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, isNull, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { ActionSpec, ActiveEffect, AoeTemplate, AoeTemplateDeclare, AoeTemplateUpdate, ARCHMAGE_ADAPTER_ID, CombatantCreate, CombatantInitiativeBreakdown, CombatantStatblock, CombatantTurnState, CombatantUpdate, ConditionInstance, DND5E_ADAPTER_ID, EncounterCommit, EncounterCreate, EncounterEscalationUpdate, EncounterPreviewRequest, EncounterReopen, EncounterUpdate, EscalationDieHistoryEntry, FogState, ManualRollRequest, PHYSICAL_ROLL_EXPR, RollRequest, ActionRollRequest, QuickRollRequest, STARFINDER_ADAPTER_ID, applyDamageModifiers, applyStarfinderDamage, actionEconomyForAdapter, buildDifficultyExplanation, combatantActionsFromStatblock, damageDefensesFromStatblock, defaultCombatantStatblock, deriveConditionNames, deriveTurnSpells, encounterDifficultySupported, estimateEncounterDifficultyForRuleSystem, expandStatblockActions, filterAoeTemplatesForViewer, hasDeathSavesForAdapter, hpModelForAdapter, initiativeModelForAdapter, isKnownCondition, isResolvableSpec, leveledConditionTrackFor, normalizeStats, parseCr, pointInRevealedRegion, ruleSystemAdapter, LEGENDARY_ACTIONS_PER_ROUND, LEGENDARY_ACTION_SLOT, statblockSectionHasEntries, EncounterAftermathLoot, EncounterAftermathLootItem, EncounterAftermathApplyXpInput, EncounterAftermathLootTransferInput, EncounterAftermathQuestUpdateInput, EncounterAftermathBeatUpdateInput, EncounterAftermathTimelineEventInput, EncounterAftermathOutcome, EncounterAftermathCombatant,
  // Issue #1921 — limited-use/recharge action pools: the recharge-condition parser used by
  // the turn tick, the same pure math the resolver uses so this service can never decide a
  // pool recharges differently than an apply/reject message described it.
  parseRechargeRange,
  effectiveActionUsesMax } from '@campfire/schema';
import { z as zod } from 'zod';
import type { ActiveEffect as ActiveEffectType, AoeTemplate as AoeTemplateType, Combatant, CombatantRemoveResult, CombatantReorderRequest, CombatantTurnStatePatch as CombatantTurnStatePatchInput, DiceRoll, Encounter, EncounterAftermath, EncounterBacklink, EncounterCreatureInspection, EncounterDifficulty, EncounterDigest, EncounterEndTurn as EncounterEndTurnInput, EncounterNextTurn as EncounterNextTurnInput, EncounterEvent, EncounterEventMetadata, EncounterEventPerformedBy, EncounterEventPhase, EncounterEventType, EncounterGenerate, EncounterLinkMeta, EncounterPreview, EncounterRollInitiativeResult, EncounterRosterSlot, EncounterStatus, EncounterSuggestion, EncounterTurnPhase, EncounterWithCombatants, FogRect, GridType, HexOrientation, HomebrewMechanicsProfile, HpSyncConflict, MapPing, MonsterHpDisplay, Role, RollResult, RuleSystemAdapter, SpellSlotLevel, StarfinderStatblockData, TargetDefenses, TokenSize, TurnActor, TurnSpellEntry, TurnSuggestedAction, TurnWorkspace } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaigns, characters, combatants, combatantRemovalUndos, encounterEvents, encounters, inventoryItems, locations, npcs, quests, questObjectives, ruleEntries, rulePacks, sessions, encounterTokenBatches, campaignTokenFormations } from '../../db/schema';
import { nowIso } from '../../common/time';
import { nextUpdatedAt } from '../../common/stale-write';
import { notDeleted } from '../../common/soft-delete';
import { filterHidden, isVisibleTo, resolveCreateHidden } from '../../common/redact';
import { deepJsonEqual, fromJsonText, toJsonText } from '../../common/json';
import { CharactersService } from '../characters/characters.service';
import { InventoryService } from '../inventory/inventory.service';
import { QuestsService } from '../quests/quests.service';
import { StorylinesService } from '../storylines/storylines.service';
import { TimelineService } from '../timeline/timeline.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { conditionWriteSetFromInstances, legacyConditionInstance as sharedLegacyConditionInstance, parseConditionInstancesText, readConditionInstances, sheetConditionWriteSetFromInstances } from '../../common/conditions';
import { fogConcealsPixels, parseFogState, persistedFogConcealsPixels } from '../../common/fog';
import { rollDice, rollInitiative, rollOpenLegendActionDice } from '../../common/dice';
import { foldForSearch, foldedIncludes, matchesSearchQuery } from '../../common/text-search';
import { RollsService } from '../rolls/rolls.service';
import { AuditService } from '../audit/audit.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { RevisionsService } from '../revisions/revisions.service';
import { auditActor, roleAtLeast } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { NotificationsService } from '../notifications/notifications.service';
import { ActionResolverService } from './action-resolver.service';
import {
  actionEconomySlotMax,
  advanceEncounterTurn,
  advanceTurn,
  applyCombatantHp,
  buildEncounterRoster,
  cascadeConcentrationLoss,
  crToXp,
  deriveEncounterRosterWarnings,
  deriveEndTurnPrompts,
  deriveStartTurnPrompts,
  enqueueConcentrationCheck,
  generateEncounterGroup,
  hpBandFor,
  initialEncounterTurnState,
  movementSlotMax,
  redactEncounterEventsForViewer,
  resetLegendaryUsage,
  resetTurnStateForStart,
  retreatEncounterTurn,
  rollRechargeAtTurnStart,
  sortCombatants,
  sortEncountersForList,
  concentrationCheckForDamage,
  tickConditionInstancesAtTurnEnd,
  tickConditionInstancesAtTurnStart,
  tickEffectsAtTurnEnd,
  turnIndexFor,
  undoActionUsesRecharge,
  UNKNOWN_COMBATANT_LABEL,
} from './encounters.logic';
import {
  aftermathOutcome,
  buildEncounterAftermathRecapDraft,
  suggestedXpFromDifficulty,
} from './encounter-aftermath.logic';
import type { ActionUsesMap, ActionUsesRechargeDelta, CombatantHpState, GeneratorCandidate, RosterSlotPlan, RosterTuneOp } from './encounters.logic';
import { ATTACHMENT_STATE_COMMITTED } from '../attachments/attachment.constants';
import { AttachmentsService } from '../attachments/attachments.service';
import { CampaignLibraryService } from '../campaign-library/campaign-library.service';
import { TableSafetyService } from '../safety/table-safety.service';
import { canWriteBackHp, hpSyncSliceOf, hpSyncSlicesEqual } from './hp-sync';
import {
  backfillEncounterOpResponse,
  encounterOpFingerprint,
  EncounterOpRaceMarker,
  findExactPriorEncounterOp,
  findPriorEncounterOp,
  readEncounterOpAfterRace,
  recordEncounterOp,
  type EncounterOpClaim,
  type EncounterOpPrior,
} from './encounter-idempotency';

type EncounterCreateInput = z.infer<typeof EncounterCreate>;
type EncounterGenerateInput = z.infer<typeof EncounterGenerate>;
type EncounterPreviewInput = z.infer<typeof EncounterPreviewRequest>;
type EncounterCommitInput = z.infer<typeof EncounterCommit>;
type EncounterUpdateInput = z.infer<typeof EncounterUpdate>;
type AoeTemplateUpdateInput = z.infer<typeof AoeTemplateUpdate>;
const MAX_PLAYER_DECLARED_AOE_TEMPLATES = 10;
type EncounterEscalationUpdateInput = z.infer<typeof EncounterEscalationUpdate>;
type EncounterReopenInput = z.infer<typeof EncounterReopen>;
type CombatantCreateInput = z.infer<typeof CombatantCreate>;
type CombatantUpdateInput = z.infer<typeof CombatantUpdate>;
/** Server-only field: public REST/MCP schemas deliberately cannot supply a death-save face. */
type CombatantInternalUpdateInput = CombatantUpdateInput & {
  deathSaveRoll?: number;
  expectedUpdatedAt?: string;
  /** Issue #1992: content-based CAS for the `statblock` field only. The `statblock` write
   * is rejected with 409 when the row's CURRENTLY STORED statblock no longer deep-equals
   * this value. An hp/condition/position write to this same combatant does not change the
   * stored statblock, so it cannot trip this guard — only a genuine concurrent `statblock`
   * write can. Ignored unless `statblock` is also present in the same patch. */
  expectedStatblock?: CombatantStatblock;
};
type CombatantTransactionHook = (
  tx: SyncDb,
  fresh: typeof combatants.$inferSelect,
  freshEncounter: typeof encounters.$inferSelect,
) => void;
type TurnTickedCondition = {
  id: string;
  roundsRemainingBefore: number;
  roundsRemainingAfter: number;
};
type TurnTickedEffect = {
  id: string;
  roundsRemainingBefore: number;
  roundsRemainingAfter: number;
};
type TurnTickCombatantDelta = {
  combatantId: number;
  conditionTicks: TurnTickedCondition[];
  conditionExpired: ConditionInstance[];
  effectTicks: TurnTickedEffect[];
  effectExpired: ActiveEffect[];
  /** Issue #1921: recharge rolls that cleared a spent action on this combatant's turn
   *  start — empty for the 'ending' side, which never rolls recharge. Lets undoTurn put
   *  a recharged action back to "spent" without re-deriving it from the current spec. */
  actionUsesRecharged?: ActionUsesRechargeDelta[];
};
type TurnTickDelta = {
  ending?: TurnTickCombatantDelta;
  starting?: TurnTickCombatantDelta;
  /** Encounter state *after* the advance this snapshot belongs to. Used by undo to
   *  verify it is consuming the right snapshot when the turn pointer may have moved
   *  without an advance (e.g. removing the current combatant). */
  toRound: number;
  toCurrentCombatantId: number | null;
  toPhase: EncounterTurnPhase;
  toLairResumeCombatantId: number | null;
};
type EncounterEventFields = {
  actor?: string | null;
  target?: string | null;
  actorId?: number | null;
  targetId?: number | null;
  detail?: string;
  chainId?: string | null;
  parentEventId?: number | null;
  phase?: EncounterEventPhase | null;
  performedBy?: EncounterEventPerformedBy | null;
  metadata?: EncounterEventMetadata & { turnTickSnapshot?: TurnTickDelta };
};
/** Narrow extension point for an action whose idempotent response is not just a combatant. */
type CombatantUpdateTransactionOptions = {
  beforeWriteInTransaction?: CombatantTransactionHook;
  afterWriteInTransaction?: (
    tx: SyncDb,
    committed: Combatant,
    fresh: typeof combatants.$inferSelect,
    freshEncounter: typeof encounters.$inferSelect,
  ) => void;
  /** The caller inserted every death-save event with its keyed write, so do not append duplicates after commit. */
  deathSaveEventsInTransaction?: boolean;
  operation?: EncounterOpClaim['operation'];
  operationFingerprint?: unknown;
  operationResponse?: (combatant: Combatant) => unknown;
  replayCombatant?: (response: unknown) => Combatant | null;
};
type RollRequestInput = z.infer<typeof RollRequest>;
type ActionRollRequestInput = z.infer<typeof ActionRollRequest>;
type ManualRollRequestInput = z.infer<typeof ManualRollRequest>;
type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * better-sqlite3 throws a synchronous Error with `.code` set to one of the
 * SQLITE_CONSTRAINT_* codes on a constraint violation (issue #749). The combatant
 * partial unique indexes (idx_combatants_encounter_character /
 * idx_combatants_encounter_npc) surface a lost concurrent-add race as a UNIQUE
 * violation; this helper detects that so the service can convert it into a
 * deterministic 409 (with the winning combatant id) instead of a raw 500. Mirrors
 * the isUniqueConstraintError helper in rules.service.ts.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed/i.test(message);
}

/**
 * Apply only the sheet-condition delta made during a combatant-removal window.
 * Conditions already present only on the combatant are encounter-local, so a sheet
 * addition/removal elsewhere must not erase their timer/save/source metadata on undo.
 */
function mergeRemovalUndoSheetConditionDelta(
  snapshotConditions: string,
  snapshotInstancesText: string | null,
  sheetConditionsAtRemoval: string,
  sheetInstancesAtRemoval: string | null,
  currentSheetConditions: string,
  currentSheetInstances: string | null,
): { conditions: string; conditionInstances: string } {
  const keyFor = (instance: ConditionInstance) => instance.name.trim().toLowerCase();
  const capturedSheet = readConditionInstances(sheetInstancesAtRemoval, sheetConditionsAtRemoval);
  const currentSheet = readConditionInstances(currentSheetInstances, currentSheetConditions);
  const capturedByKey = new Map(capturedSheet.map((instance) => [keyFor(instance), instance] as const));
  const currentByKey = new Map(currentSheet.map((instance) => [keyFor(instance), instance] as const));
  const snapshot = readConditionInstances(snapshotInstancesText, snapshotConditions);
  // Do not key the combat snapshot by condition name: encounter-local timed effects may
  // legitimately share a name while differing in id, source, duration, or save metadata.
  let merged = [...snapshot];

  for (const [key, priorSheetInstance] of capturedByKey) {
    const currentSheetInstance = currentByKey.get(key);
    if (!currentSheetInstance) {
      // A sheet condition and an encounter-local condition may intentionally share a
      // display name. The sheet's stable instance id identifies the one that its
      // removal owns; filtering by name would erase unrelated timers/sources.
      merged = merged.filter((instance) => instance.id !== priorSheetInstance.id);
    } else if (currentSheetInstance.stacks !== priorSheetInstance.stacks) {
      const hadCombatantInstance = merged.some((instance) => instance.id === priorSheetInstance.id);
      merged = merged.map((instance) => instance.id === priorSheetInstance.id
        ? { ...instance, stacks: currentSheetInstance.stacks }
        : instance);
      if (!hadCombatantInstance) merged.push(currentSheetInstance);
    }
  }
  for (const [key, currentSheetInstance] of currentByKey) {
    if (capturedByKey.has(key)) continue;
    const hadCombatantInstance = merged.some((instance) => instance.id === currentSheetInstance.id);
    if (!hadCombatantInstance) merged.push(currentSheetInstance);
  }
  return conditionWriteSetFromInstances(merged);
}

/** Clamp a 0–100 percent overlay coordinate, mirroring the campaign map's location-pin drag. */
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Parse the stored fog JSON back into a FogState (issue #40). Corrupt/legacy text or a
 * shape that no longer validates degrades to null (fully visible) rather than throwing —
 * fog is a display aid, never a reason to fail a whole encounter read.
 */
function parseFog(text: string | null): FogState | null {
  return parseFogState(text);
}

/**
 * Parse the stored AoE-templates JSON back into an AoeTemplate[] (issue #238). Same defensive
 * degrade-to-empty as parseFog: corrupt/legacy text or any invalid entry makes the stored
 * list unreadable rather than failing the whole encounter read — templates are a display aid.
 */
function parseAoe(text: string | null): AoeTemplateType[] {
  if (text == null) return [];
  const parsed = zod.array(AoeTemplate).safeParse(fromJsonText<unknown>(text, null));
  return parsed.success ? parsed.data : [];
}

/**
 * Scoped AoE writes must never persist parseAoe's read-time degraded value: doing so
 * could turn one malformed saved entry into a destructive rewrite of the whole list.
 */
function parseAoeForScopedWrite(text: string | null): AoeTemplateType[] {
  if (text == null) return [];
  const parsed = zod.array(AoeTemplate).safeParse(fromJsonText<unknown>(text, null));
  if (!parsed.success) {
    throw new ConflictException('Encounter AoE templates contain invalid saved data and must be repaired before they can be changed');
  }
  return parsed.data;
}

function parseCombatantStatblock(text: string | null): CombatantStatblock | null {
  if (text == null) return null;
  const parsed = CombatantStatblock.safeParse(fromJsonText(text, null));
  return parsed.success ? parsed.data : null;
}

function parseInitiativeBreakdown(text: string | null): CombatantInitiativeBreakdown | null {
  if (text == null) return null;
  const parsed = CombatantInitiativeBreakdown.safeParse(fromJsonText<unknown>(text, null));
  return parsed.success ? parsed.data : null;
}

function parseEscalationHistory(text: string | null): EscalationDieHistoryEntry[] {
  if (text == null) return [];
  const parsed = zod.array(EscalationDieHistoryEntry).safeParse(fromJsonText<unknown>(text, []));
  return parsed.success ? parsed.data : [];
}

function isArchmageAdapter(adapter: RuleSystemAdapter): boolean {
  return adapter.id === ARCHMAGE_ADAPTER_ID;
}

function archmageEscalationDieForRound(adapter: RuleSystemAdapter, round: number): number {
  const fn = (adapter as RuleSystemAdapter & { escalationDieForRound?: (round: number) => number }).escalationDieForRound;
  return typeof fn === 'function' ? fn.call(adapter, round) : 0;
}

function adapterLevelInitiativeBonus(adapter: RuleSystemAdapter, level: number): number {
  const fn = (adapter as RuleSystemAdapter & { levelInitiativeBonus?: (level: number) => number }).levelInitiativeBonus;
  return typeof fn === 'function' ? fn.call(adapter, level) : 0;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/^\+/, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function initiativeFormula(
  die: number,
  terms: Array<{ label: string; value: number }>,
  roll: number | null = null,
  total: number | null = null,
): string {
  const dieText = roll === null ? `d${die}` : `d${die} ${roll}`;
  const termText = terms.map((t) => `${t.label} ${t.value >= 0 ? '+' : ''}${t.value}`).join(' ');
  const totalText = total === null ? '' : ` = ${total}`;
  return `${dieText}${termText ? ` ${termText}` : ''}${totalText}`.trim();
}

function characterInitiativeBreakdown(
  adapter: RuleSystemAdapter,
  stats: Record<string, number>,
  level: number,
): CombatantInitiativeBreakdown {
  const base = adapter.initiativeModifier(stats, 'score', level);
  const terms = isArchmageAdapter(adapter)
    ? [
        { label: 'DEX', value: base },
        { label: 'level', value: adapterLevelInitiativeBonus(adapter, level) },
      ]
    : [{ label: 'initiative', value: base }];
  const modifier = terms.reduce((sum, t) => sum + t.value, 0);
  return CombatantInitiativeBreakdown.parse({
    die: adapter.initiativeDie > 0 ? adapter.initiativeDie : 20,
    roll: null,
    modifier,
    total: null,
    terms,
    formula: initiativeFormula(adapter.initiativeDie > 0 ? adapter.initiativeDie : 20, terms),
  });
}

function monsterInitiativeBreakdown(
  adapter: RuleSystemAdapter,
  data: Record<string, unknown>,
  fallbackModifier: number,
): CombatantInitiativeBreakdown {
  const flatArchmage = isArchmageAdapter(adapter) ? num(data.initiative ?? data.init) : null;
  const modifier = flatArchmage ?? fallbackModifier;
  const terms = [{ label: flatArchmage !== null ? 'monster initiative' : 'initiative', value: modifier }];
  return CombatantInitiativeBreakdown.parse({
    die: adapter.initiativeDie > 0 ? adapter.initiativeDie : 20,
    roll: null,
    modifier,
    total: null,
    terms,
    formula: initiativeFormula(adapter.initiativeDie > 0 ? adapter.initiativeDie : 20, terms),
  });
}

function manualInitiativeBreakdown(adapter: RuleSystemAdapter, modifier: number): CombatantInitiativeBreakdown {
  const terms = [{ label: 'manual', value: modifier }];
  return CombatantInitiativeBreakdown.parse({
    die: adapter.initiativeDie > 0 ? adapter.initiativeDie : 20,
    roll: null,
    modifier,
    total: null,
    terms,
    formula: initiativeFormula(adapter.initiativeDie > 0 ? adapter.initiativeDie : 20, terms),
  });
}

/**
 * Terms to display for a roll against the CURRENT modifier (issue #1904 review finding).
 * A DM's PATCH to `initMod` (creation-time fix, or a mid-campaign stat change) updates only the
 * `initMod` column — the previously-stored `initiativeBreakdown.terms` (e.g. "DEX +2") is left
 * untouched. Rolling afterward while reusing those stale terms verbatim produces a formula that
 * visibly contradicts its own total (terms sum to the OLD modifier; `total` is computed from the
 * NEW one). If the stored terms still sum to the current modifier, nothing drifted — keep them,
 * since they may carry a richer label than a flat number. If they don't, collapse to one flat
 * term so the displayed formula can never disagree with the total beside it.
 */
function initiativeTermsForModifier(
  existing: CombatantInitiativeBreakdown,
  modifier: number,
): Array<{ label: string; value: number }> {
  const staleSum = existing.terms.reduce((sum, t) => sum + t.value, 0);
  return staleSum === modifier ? existing.terms : [{ label: 'initiative', value: modifier }];
}

/** Bare dice expression for a shared dice-log row (issue #1904) — e.g. "1d20+3", "1d20-1", "1d20". */
function initiativeRollExpr(die: number, modifier: number): string {
  if (modifier === 0) return `1d${die}`;
  return `1d${die}${modifier >= 0 ? '+' : ''}${modifier}`;
}

/** Dice-log label for a group-initiative side roll (issue #765 / #1904) — "party" -> "Party". */
function groupInitiativeLabel(group: string): string {
  return group.length > 0 ? group[0].toUpperCase() + group.slice(1) : group;
}

function encounterToDomain(row: typeof encounters.$inferSelect): Encounter {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    status: row.status as EncounterStatus,
    round: row.round,
    escalationDie: row.escalationDie ?? 0,
    escalationDieHeld: row.escalationDieHeld ?? false,
    escalationDieOverride: row.escalationDieOverride ?? null,
    escalationDieHistory: parseEscalationHistory(row.escalationDieHistory),
    turnIndex: row.turnIndex,
    currentCombatantId: row.currentCombatantId,
    // Issue #1923: the reorder CAS token. Not a secret — every role reads the same value.
    turnVersion: row.turnVersion,
    turnPhase: (row.turnPhase as EncounterTurnPhase) ?? 'combatant',
    lairResumeCombatantId: row.lairResumeCombatantId ?? null,
    locationId: row.locationId,
    questId: row.questId,
    sessionId: row.sessionId,
    mapAttachmentId: row.mapAttachmentId,
    gridSize: row.gridSize,
    gridScale: row.gridScale,
    gridUnit: row.gridUnit,
    gridSnap: row.gridSnap,
    gridType: (row.gridType as GridType) ?? 'square',
    hexOrientation: (row.hexOrientation as HexOrientation) ?? 'pointy',
    // Grid calibration (issue #417). Null-coalesce so rows written before the columns
    // existed (or a legacy NULL) read as the pre-#417 defaults — top-left square grid.
    gridOffsetX: row.gridOffsetX ?? 0,
    gridOffsetY: row.gridOffsetY ?? 0,
    gridCellHeight: row.gridCellHeight ?? null,
    gridRotation: row.gridRotation ?? 0,
    gridOpacity: row.gridOpacity ?? 0.35,
    fog: parseFog(row.fog),
    aoe: parseAoe(row.aoe),
    hidden: row.hidden,
    // Monster-HP display dial (issue #1925). Readable by every viewer — DM and player
    // alike — so a player's client knows whether to expect a number, a band, or
    // neither; the mode itself leaks nothing about any combatant's HP.
    monsterHpDisplay: (row.monsterHpDisplay as MonsterHpDisplay) ?? 'band',
    endedAt: row.endedAt,
    // Turn timer (issue #1935) — server-stamped only; exposed for every role (never a secret)
    // so the DM header, PlayerVitalsHeader, and PlayerDisplayPage compute the same elapsed time.
    turnStartedAt: row.turnStartedAt ?? null,
    turnTimerSeconds: row.turnTimerSeconds ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function combatantToDomain(row: typeof combatants.$inferSelect): Combatant {
  return {
    id: row.id,
    encounterId: row.encounterId,
    kind: row.kind as Combatant['kind'],
    characterId: row.characterId,
    npcId: row.npcId,
    npcDispositionSnapshot: row.npcDispositionSnapshot,
    name: row.name,
    initiative: row.initiative,
    initMod: row.initMod,
    initiativeBreakdown: parseInitiativeBreakdown(row.initiativeBreakdown),
    initiativeGroup: row.initiativeGroup ?? null,
    hpCurrent: row.hpCurrent,
    hpMax: row.hpMax,
    spCurrent: row.spCurrent ?? 0,
    spMax: row.spMax ?? 0,
    rpCurrent: row.rpCurrent ?? 0,
    rpMax: row.rpMax ?? 0,
    eac: row.eac ?? null,
    kac: row.kac ?? null,
    speed: row.speed ?? null,
    hpTemp: row.hpTemp,
    hpBand: null,
    deathState: row.deathState as Combatant['deathState'],
    deathSaveSuccesses: row.deathSaveSuccesses,
    deathSaveFailures: row.deathSaveFailures,
    conditions: fromJsonText<string[]>(row.conditions, []),
    ruleEntryId: row.ruleEntryId,
    sortOrder: row.sortOrder,
    manualOrder: row.manualOrder ?? null,
    tokenX: row.tokenX,
    tokenY: row.tokenY,
    tokenSize: row.tokenSize as TokenSize,
    tokenHiddenByFog: false,
    // Issue #413, #423: current-turn workspace state, active effects, and condition instances.
    turnState: parseTurnState(row.turnState),
    activeEffects: parseActiveEffects(row.activeEffects),
    conditionInstances: parseConditionInstances(row.conditionInstances, fromJsonText<string[]>(row.conditions, [])),
    legendaryActions: null,
    statblock: parseCombatantStatblock(row.statblockJson),
    statblockRevealed: row.statblockRevealed,
  };
}

/** Stable structured wrapper for one legacy string condition (issue #423 migration bridge). */
function legacyConditionInstance(rawName: string): ConditionInstance | null {
  // Single definition lives in common/conditions.ts alongside the write helpers, so the
  // shape a legacy string materialises into cannot drift between reader and writer.
  return sharedLegacyConditionInstance(rawName);
}

/** Parse stored condition instances JSON or synthesize default instances from legacy conditions array (issue #423). */
function parseConditionInstances(text: string | null, stringConditions: string[] = []): ConditionInstance[] {
  // Union, not reconcile: this is the READ path, where a pre-#423 row legitimately has
  // legacy names and no instances. The WRITE path must reconcile instead — see
  // conditionWriteSetFromNames in common/conditions.ts.
  const instances: ConditionInstance[] = parseConditionInstancesText(text);
  if (stringConditions.length > 0) {
    const existingNames = new Set(instances.map((i) => i.name.trim().toLowerCase()));
    for (const rawName of stringConditions) {
      const name = rawName.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!existingNames.has(key)) {
        existingNames.add(key);
        const legacy = legacyConditionInstance(name);
        if (legacy) instances.push(legacy);
      }
    }
  }
  return instances;
}

/**
 * Parse the stored turn-state JSON back into a CombatantTurnState (issue #413). Null / corrupt
 * / legacy text degrades to EMPTY_TURN_STATE (no usage, no concentration) — turn state is a
 * live-combat aid, never a reason to fail an encounter read.
 */
function parseTurnState(text: string | null): CombatantTurnState {
  // Route null/corrupt text through the schema so the returned object always has its OWN
  // fresh `used` map (the schema uses factory defaults) — never a spread of the shared
  // EMPTY_TURN_STATE, whose nested `used` object would otherwise be aliased and mutated.
  if (text == null) return CombatantTurnState.parse({});
  const parsed = CombatantTurnState.safeParse(fromJsonText<unknown>(text, null));
  return parsed.success ? parsed.data : CombatantTurnState.parse({});
}

/** Parse the stored active-effects JSON back into an ActiveEffect[] (issue #413); degrade to []. */
function parseActiveEffects(text: string | null): ActiveEffectType[] {
  if (text == null) return [];
  const parsed = zod.array(ActiveEffect).safeParse(fromJsonText<unknown>(text, null));
  return parsed.success ? parsed.data : [];
}

/** Attach legendary-action pools from linked statblocks (issue #618). */
function enrichCombatantsWithLegendaryPools(
  combatants: Combatant[],
  statblocks: Map<number, ReturnType<RuleSystemAdapter['mapStatblock']>>,
): Combatant[] {
  return combatants.map((c) => {
    if (c.ruleEntryId === null) return c;
    const mapped = statblocks.get(c.ruleEntryId);
    if (!mapped || !statblockSectionHasEntries(mapped.legendaryActions)) return c;
    const used = c.turnState.used[LEGENDARY_ACTION_SLOT] ?? 0;
    return {
      ...c,
      legendaryActions: { max: LEGENDARY_ACTIONS_PER_ROUND, used },
    };
  });
}

function encounterHasLairSlotFromStatblocks(statblocks: Map<number, ReturnType<RuleSystemAdapter['mapStatblock']>>): boolean {
  for (const mapped of statblocks.values()) {
    if (statblockSectionHasEntries(mapped.lairActions)) return true;
  }
  return false;
}

function eventToDomain(row: typeof encounterEvents.$inferSelect): EncounterEvent {
  // The turn-advance snapshot is server-internal: it is read directly from
  // metadataJson for undo, but never returned in public combat-log responses.
  const metadata = row.metadataJson ? (JSON.parse(row.metadataJson) as Record<string, unknown>) : {};
  delete metadata.turnTickSnapshot;
  return {
    id: row.id,
    encounterId: row.encounterId,
    round: row.round,
    type: row.type as EncounterEventType,
    actor: row.actor,
    target: row.target,
    actorId: row.actorId ?? null,
    targetId: row.targetId ?? null,
    detail: row.detail,
    chainId: row.chainId ?? null,
    parentEventId: row.parentEventId ?? null,
    phase: (row.phase as EncounterEventPhase | null) ?? null,
    performedBy: row.performedByJson ? (JSON.parse(row.performedByJson) as EncounterEventPerformedBy) : null,
    metadata: metadata as EncounterEventMetadata,
    createdAt: row.createdAt,
  };
}

/** Build the condition/effect delta for a combatant whose turn ticked.
 *  Records only the IDs and roundsRemaining values that changed, plus the full pre-tick
 *  objects of expired entries so undo can re-add them. */
function buildConditionTickDelta(
  pre: ConditionInstance[],
  post: ConditionInstance[],
): { ticks: TurnTickedCondition[]; expired: ConditionInstance[] } {
  const ticks: TurnTickedCondition[] = [];
  const expired: ConditionInstance[] = [];
  const postById = new Map(post.map((c) => [c.id, c]));
  for (const before of pre) {
    const after = postById.get(before.id);
    if (!after) {
      expired.push(before);
    } else if (
      before.roundsRemaining !== null &&
      after.roundsRemaining !== null &&
      before.roundsRemaining !== after.roundsRemaining
    ) {
      ticks.push({
        id: before.id,
        roundsRemainingBefore: before.roundsRemaining,
        roundsRemainingAfter: after.roundsRemaining,
      });
    }
  }
  return { ticks, expired };
}

function buildEffectTickDelta(
  pre: ActiveEffect[],
  post: ActiveEffect[],
): { ticks: TurnTickedEffect[]; expired: ActiveEffect[] } {
  const ticks: TurnTickedEffect[] = [];
  const expired: ActiveEffect[] = [];
  const postById = new Map(post.map((e) => [e.id, e]));
  for (const before of pre) {
    const after = postById.get(before.id);
    if (!after) {
      expired.push(before);
    } else if (
      before.roundsRemaining !== null &&
      after.roundsRemaining !== null &&
      before.roundsRemaining !== after.roundsRemaining
    ) {
      ticks.push({
        id: before.id,
        roundsRemainingBefore: before.roundsRemaining,
        roundsRemainingAfter: after.roundsRemaining,
      });
    }
  }
  return { ticks, expired };
}

/** Apply a stored turn-tick delta to current condition/effect state. Only touches the
 *  roundsRemaining of entries that are still in the post-tick state; re-adds expired
 *  entries that are not currently present. Returns the merged list and the names that
 *  were actually restored. */
function applyConditionTickDelta(
  delta: TurnTickCombatantDelta,
  current: ConditionInstance[],
): { merged: ConditionInstance[]; restoredNames: string[] } {
  const merged = current.slice();
  const restoredNames: string[] = [];
  const byId = new Map(merged.map((c, i) => [c.id, i] as const));
  for (const tick of delta.conditionTicks) {
    const idx = byId.get(tick.id);
    if (idx === undefined) continue; // removed after advance: do not resurrect
    const currentInst = merged[idx];
    if (currentInst.roundsRemaining !== tick.roundsRemainingAfter) continue; // user edited the timer
    merged[idx] = { ...currentInst, roundsRemaining: tick.roundsRemainingBefore };
    restoredNames.push(currentInst.name);
  }
  const currentIds = new Set(current.map((c) => c.id));
  for (const expired of delta.conditionExpired) {
    if (currentIds.has(expired.id)) continue; // edited/re-added with the same id: do not overwrite
    merged.push(expired);
    restoredNames.push(expired.name);
  }
  return { merged, restoredNames };
}

function applyEffectTickDelta(
  delta: TurnTickCombatantDelta,
  current: ActiveEffect[],
): { merged: ActiveEffect[]; restoredNames: string[] } {
  const merged = current.slice();
  const restoredNames: string[] = [];
  const byId = new Map(merged.map((e, i) => [e.id, i] as const));
  for (const tick of delta.effectTicks) {
    const idx = byId.get(tick.id);
    if (idx === undefined) continue;
    const currentEff = merged[idx];
    if (currentEff.roundsRemaining !== tick.roundsRemainingAfter) continue;
    merged[idx] = { ...currentEff, roundsRemaining: tick.roundsRemainingBefore };
    restoredNames.push(currentEff.name);
  }
  const currentIds = new Set(current.map((e) => e.id));
  for (const expired of delta.effectExpired) {
    if (currentIds.has(expired.id)) continue;
    merged.push(expired);
    restoredNames.push(expired.name);
  }
  return { merged, restoredNames };
}

function deathSaveRollEventDetail(
  die: number,
  successes: number,
  failures: number,
  beforeDeath: string,
  afterDeath: string,
): string {
  let rollResult = '';
  if (die === 20) {
    rollResult = 'Natural 20! Revived with 1 HP!';
  } else if (die === 1) {
    rollResult = `Natural 1! (2 failures) — totals: ${successes} succ / ${failures} fail`;
  } else if (die >= 10) {
    rollResult = `Success (rolled ${die}) — totals: ${successes} succ / ${failures} fail`;
  } else {
    rollResult = `Failure (rolled ${die}) — totals: ${successes} succ / ${failures} fail`;
  }
  if (afterDeath === 'dead' && beforeDeath !== 'dead') {
    rollResult += ' (Dead)';
  } else if (afterDeath === 'stable' && beforeDeath !== 'stable') {
    rollResult += ' (Stabilized)';
  }
  return `death save d20 roll ${die}: ${rollResult}`;
}

/**
 * Issue #43: non-DM viewers must not see a monster's (or DM-controlled NPC's) exact
 * HP — a player polling the run-session view would otherwise read the boss at an
 * exact `3/150`, a live secrets leak (and the same view a shared screen shows). For
 * monster AND npc combatants we replace hpCurrent/hpMax with a coarse status band and
 * null the exact numbers. Character combatants keep exact HP for everyone: party HP
 * is shared table knowledge and a player already sees their own character sheet.
 *
 * Issue #1925: the encounter's `monsterHpDisplay` dial controls how much of that is
 * withheld. `band` (default) is the behaviour above, unchanged. `exact` ships the real
 * hpCurrent/hpMax/hpTemp/sp/rp to non-DMs too (statblock + pendingConcentrationChecks
 * stay stripped regardless — separate secrecy concerns, issue #425/#606). `hidden` ships
 * neither the numbers NOR the band — except a combatant at 0 HP still reports
 * `hpBand: 'down'` in every mode, so the table always knows who dropped. This is the
 * SOLE server-side choke point for the mode; there is no client-side hiding anywhere
 * downstream of this function.
 */
function redactMonsterHp(c: Combatant, mode: MonsterHpDisplay): Combatant {
  if (c.kind !== 'monster' && c.kind !== 'npc') return c;
  // Inline homebrew statblocks (issue #425) carry AC, abilities, attacks, and DM notes —
  // withhold from non-DM encounter reads the same way exact HP is banded (issue #43),
  // UNLESS the DM has explicitly revealed this combatant's statblock (issue #1926) —
  // a server-persisted flag, not a client-side toggle, so a non-DM `GET` genuinely
  // never carries the field until the DM turns it on. HP banding itself is entirely
  // unaffected by the reveal: exact HP/temp-HP/SP/RP stay redacted below regardless.
  // pendingConcentrationChecks also embeds exact post-mitigation damage + DC (#606) —
  // strip them so non-DM viewers cannot reverse-engineer secret monster HP.
  const redacted: Combatant = {
    ...c,
    statblock: c.statblockRevealed ? c.statblock : null,
    turnState: {
      ...c.turnState,
      pendingConcentrationChecks: [],
    },
  };
  if (redacted.hpCurrent === null || redacted.hpMax === null) return redacted;
  const band = hpBandFor(redacted.hpCurrent, redacted.hpMax);
  if (mode === 'exact') {
    // Real numbers ship as-is; the band rides along too (harmless — it's derivable from
    // the numbers already present) so a 0-HP monster still reports 'down' consistently
    // with the other two modes.
    return { ...redacted, hpBand: band };
  }
  // hpTemp is exact-HP information too — null it alongside hpCurrent/hpMax so a
  // temp-HP buffed monster doesn't leak numbers through the redaction.
  return {
    ...redacted,
    // 'hidden' withholds the band too, EXCEPT 'down' — the table must always know who
    // dropped, in every mode.
    hpBand: mode === 'hidden' && band !== 'down' ? null : band,
    hpCurrent: null,
    hpMax: null,
    spCurrent: null,
    spMax: null,
    rpCurrent: null,
    rpMax: null,
    hpTemp: null,
  };
}

/** True if a combatant's token centre lies inside any revealed fog rectangle (issue #40). */
function tokenInRevealedRegion(c: Combatant, fog: FogState): boolean {
  if (c.tokenX == null || c.tokenY == null) return true; // unplaced — nothing on the map to hide
  return pointInRevealedRegion(c.tokenX, c.tokenY, fog);
}

/**
 * Issue #40 fog-of-war redaction: when fog is enabled, a non-DM viewer must not learn the
 * position of any token sitting in an unrevealed region — a player polling the run view would
 * otherwise read exactly where the ambush monster is waiting in the dark. We null tokenX/tokenY
 * on those combatants server-side (the client never receives the coordinates), the same
 * server-side-gate approach as the issue #43 monster-HP band. Tokens inside a revealed
 * rectangle, and unplaced combatants, are returned unchanged.
 *
 * Issue #418: also set `tokenHiddenByFog: true` so the client can show an owner-safe
 * "placed outside the revealed area" state instead of falsely listing the token as
 * Unplaced (and offering a no-op place-at-center action). Coordinates stay null.
 */
function redactTokenInFog(c: Combatant, fog: FogState): Combatant {
  if (tokenInRevealedRegion(c, fog)) return c;
  return { ...c, tokenX: null, tokenY: null, tokenHiddenByFog: true };
}

export type EncounterSearchEntry = {
  id: number;
  campaignId: number;
  name: string;
  locationLabel: string;
  questLabel: string;
  sessionLabel: string;
};

@Injectable()
export class EncountersService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly events: CampaignEventsService,
    private readonly rolls: RollsService,
    private readonly revisions: RevisionsService,
    private readonly attachmentsService: AttachmentsService,
    private readonly campaignLibrary: CampaignLibraryService,
    private readonly notifications: NotificationsService,
    /**
     * #599 — the table safety hold. Optional and LAST in the list because several integration
     * specs hand-construct this service positionally (test/integration/encounter-*.spec.ts);
     * appending leaves those constructions valid and un-gated, which is the right degraded
     * shape for a unit test of turn logic. Every use is `?.`-guarded.
     */
    @Optional() private readonly safety?: TableSafetyService,
    @Optional() @Inject(forwardRef(() => CharactersService)) private readonly charactersService?: CharactersService,
    @Optional() @Inject(forwardRef(() => InventoryService)) private readonly inventoryService?: InventoryService,
    @Optional() @Inject(forwardRef(() => QuestsService)) private readonly questsService?: QuestsService,
    @Optional() @Inject(forwardRef(() => StorylinesService)) private readonly storylinesService?: StorylinesService,
    @Optional() @Inject(forwardRef(() => TimelineService)) private readonly timelineService?: TimelineService,
    @Optional() @Inject(forwardRef(() => CampaignsService)) private readonly campaignsService?: CampaignsService,
    /**
     * Issue #1901 — shares ActionResolverService's character-action merge (sheet actions +
     * equipped-item actions, ONE index space) so `/turn` `suggestedActions.actionIndex` means
     * the same action `listUsableActions`/`resolveSpec` do. No circular dependency (this
     * service is not one of ActionResolverService's own dependencies), so this is a plain
     * optional dependency, not a `forwardRef`. Optional + last so the many hand-constructed
     * test doubles for this service (`test/**`) that predate #1901 keep compiling; absent, the
     * character branch below falls back to its pre-#1901 sheet-only behavior.
     */
    @Optional() private readonly actionResolver?: ActionResolverService,
  ) {}

  /**
   * Refuse to advance play while a participant's safety hold stands (issue #599).
   *
   * Placed in the SERVICE, not the controller, deliberately. Turn advancement is reachable from
   * three places — the REST controller, the MCP tool surface a connected AI client drives, and
   * the AI driver's own tool dispatch — and a gate that only covers the first is a gate an X-Card
   * can be walked around by anything holding an MCP token.
   *
   * Gated: start, next-turn, end-turn, undo-turn, and applying a resolved action. NOT gated:
   * `end`, because ending the encounter is one of the facilitator's listed recovery moves and a
   * safety hold that traps the table inside a running fight would be worse than no hold at all;
   * and not the editing paths (HP, conditions, notes), because a facilitator cleaning up the
   * board while the table talks is exactly what a stop is for.
   */
  private assertNoSafetyHold(campaignId: number): void {
    this.safety?.assertNotHeld(campaignId);
  }

  /**
   * In-memory idempotency map for the generated-encounter commit (issue #412):
   * `${campaignId}:${idempotencyKey}` -> committed encounter id. A retried commit with the
   * same key returns the SAME encounter instead of creating a duplicate. Single-instance,
   * mirroring the AI map job store; a still-in-flight retry serializes on `commitInFlight`.
   */
  private readonly commitIdempotency = new Map<string, number>();
  private readonly commitInFlight = new Map<string, Promise<EncounterWithCombatants>>();

  /**
   * Push a thin SSE change signal to everyone watching this campaign (issue #4).
   * #754: never broadcast ids of DM-only prep encounters on the shared stream —
   * players must not learn a hidden encounter exists by id. Multi-DM prep syncs
   * on navigation/focus refetch instead.
   */
  private emitEncounterEvent(
    type: 'encounter.updated' | 'encounter.deleted' | 'encounter.turn_changed',
    campaignId: number,
    encounterId: number,
    /** Fallback when the row is already gone (hard delete) or unavailable. */
    hiddenFallback = false,
    extraFields?: Record<string, unknown>,
  ): void {
    // A caller that already knows the encounter is hidden (hiddenFallback) must
    // never emit — skip the visibility query entirely on that hot path.
    if (hiddenFallback) return;
    // Otherwise re-read visibility at emit time so a concurrent hide cannot leak
    // the id on the shared stream after a lifecycle handler loaded a stale
    // `hidden: false`. Single-row lookup via .get() (not .all()).
    const current = this.db
      .select({ hidden: encounters.hidden })
      .from(encounters)
      .where(eq(encounters.id, encounterId))
      .get();
    const hidden = current ? Boolean(current.hidden) : hiddenFallback;
    if (hidden) return;
    this.events.emit({ type, campaignId, encounterId, ...extraFields } as any);
  }

  /**
   * Reject a write against an ended or trashed encounter (issues #163, #470). Combatant mutations
   * were the first gap: per-combatant writes never checked status, so after a fight any
   * owning player or DM could keep editing the historical record and every combatant HP
   * patch rewrote the linked character's live sheet HP through write-through in
   * updateCombatant. Encounter-level fields (map/grid/fog/AoE/links/name/hidden) were
   * still mutable via updateEncounter, so the board could drift after the session. An
   * ended encounter is a frozen historical snapshot; mutating it is a state conflict
   * (409). Viewing stays allowed (getWithCombatantsOrThrow is untouched), and /reopen is
   * the supported path back to a mutable 'running' encounter.
   */
  private assertMutable(encounterRow: typeof encounters.$inferSelect): void {
    if (encounterRow.deletedAt != null) {
      throw new NotFoundException(`Encounter ${encounterRow.id} not found`);
    }
    if (encounterRow.status === 'ended') {
      throw new ConflictException(`Encounter ${encounterRow.id} has ended — reopen it before making changes`);
    }
  }

  /**
   * Recheck campaign lifecycle inside encounter-write transactions. The controller's
   * access gate runs before an awaited rule-system lookup, so an archive or trash
   * can otherwise land between that gate and the transactional mutation.
   */
  private assertCampaignWritableInTx(db: SyncDb, campaignId: number): void {
    const campaign = db.select({ status: campaigns.status, deletedAt: campaigns.deletedAt })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .get();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.deletedAt != null) throw new NotFoundException('Campaign not found');
    if (campaign.status !== 'active') {
      throw new ForbiddenException(
        `Campaign is ${campaign.status} (read-only) — set its status back to 'active' to make changes`,
      );
    }
  }

  /** Public seam for sibling modules (e.g. map attach) to reject ended-encounter writes (#470). */
  async ensureMutable(encounterId: number): Promise<void> {
    this.assertMutable(await this.getRowOrThrow(encounterId));
  }

  /**
   * Resolve the single authoritative live encounter for a campaign (issue #744). Returns
   * the active encounter row when there is exactly one 'running' fight — preferring the
   * campaign's `activeEncounterId` pointer (the transactional source of truth) and
   * falling back to a status scan for back-compat with rows written before the pointer
   * column existed / on DBs that haven't run the migration. Returns undefined when no
   * encounter is running. The async variant reads outside any transaction (e.g. from
   * listForCampaign); start/reopen/reopen use the synchronous in-transaction variant
   * below so the assertion + status flip are atomic against concurrent starts.
   */
  private async findLiveEncounter(
    campaignId: number,
  ): Promise<typeof encounters.$inferSelect | undefined> {
    // Prefer the explicit pointer — it is the source of truth once a start/reopen lands.
    const [campaign] = await this.db.select({ activeEncounterId: campaigns.activeEncounterId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (campaign?.activeEncounterId !== null && campaign?.activeEncounterId !== undefined) {
      const [row] = await this.db
        .select()
        .from(encounters)
        .where(and(eq(encounters.id, campaign.activeEncounterId), eq(encounters.campaignId, campaignId), notDeleted(encounters.deletedAt)))
        .limit(1);
      if (row && (row.status as EncounterStatus) === 'running') return row;
    }
    // Back-compat scan: a 'running' encounter from before the pointer existed, or a
    // pointer that drifted out of sync (e.g. an older server with no #744 enforcement).
    const rows = await this.db
      .select()
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), eq(encounters.status, 'running'), notDeleted(encounters.deletedAt)));
    return rows[0];
  }

  /**
   * Synchronous in-transaction variant of findLiveEncounter (issue #744). better-sqlite3
   * transactions are synchronous, so the queries here use `.all()` directly. Reading the
   * campaign pointer + the status scan inside the SAME serialized transaction that the
   * caller will flip status in means two concurrent /start calls serialize: the loser's
   * read observes the winner's committed 'running' row and surfaces a 409.
   */
  private findLiveEncounterSync(
    campaignId: number,
    tx: DrizzleDb,
  ): typeof encounters.$inferSelect | undefined {
    const [campaign] = tx
      .select({ activeEncounterId: campaigns.activeEncounterId })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
      .all();
    if (campaign?.activeEncounterId !== null && campaign?.activeEncounterId !== undefined) {
      const [row] = tx
        .select()
        .from(encounters)
        .where(and(eq(encounters.id, campaign.activeEncounterId), eq(encounters.campaignId, campaignId), notDeleted(encounters.deletedAt)))
        .limit(1)
        .all();
      if (row && (row.status as EncounterStatus) === 'running') return row;
    }
    const rows = tx
      .select()
      .from(encounters)
      .where(and(eq(encounters.campaignId, campaignId), eq(encounters.status, 'running'), notDeleted(encounters.deletedAt)))
      .all();
    return rows[0];
  }

  /**
   * Enforce the one-authoritative-live-fight invariant (issue #744) inside the caller's
   * transaction. Throws 409 Conflict — carrying the winning encounter's id + name + a deep
   * link — when a DIFFERENT encounter is already running in this campaign. The winner is
   * whichever live encounter findLiveEncounterSync resolves (the pinned pointer if set,
   * else the first 'running' row). Must run inside the same transaction as the status flip
   * so two concurrent starts serialize and the loser deterministically sees the winner's row.
   */
  private assertNoOtherLiveEncounter(
    campaignId: number,
    encounterId: number,
    tx: DrizzleDb,
  ): void {
    const live = this.findLiveEncounterSync(campaignId, tx);
    if (live && live.id !== encounterId) {
      throw new ConflictException({
        code: 'ENCOUNTER_ALREADY_RUNNING',
        message: `Encounter "${live.name}" is already the live fight for this campaign — end it before starting another.`,
        encounterId: live.id,
        encounterName: live.name,
        deepLink: `/c/${campaignId}/encounters/${live.id}`,
      });
    }
  }

  async getRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(encounters).where(eq(encounters.id, id)).limit(1);
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`Encounter ${id} not found`);
    return row;
  }

  /**
   * Lightweight encounter domain mapping for GET /encounters/:id/map.
   * Applies the same hidden-entity gate as getWithCombatantsOrThrow without joining combatants.
   */
  encounterForMapOrThrow(row: typeof encounters.$inferSelect, viewerRole: Role): Encounter {
    if (!isVisibleTo({ hidden: row.hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${row.id} not found`);
    }
    return encounterToDomain(row);
  }

  /**
   * Resolve the RuleSystemAdapter for a campaign (issue #70) — the seam the combat math
   * (ability modifiers, DEX-derived initiative, the initiative die, monster statblock
   * fields) routes through instead of inlining 5e constants. Reads `campaigns.ruleSystem`
   * and falls back to the default (5e) adapter, so every existing campaign behaves exactly
   * as before. Adding a second rule system is a new adapter in the registry, not edits here.
   */
  private async adapterForCampaign(campaignId: number): Promise<RuleSystemAdapter> {
    const [row] = await this.db
      .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    return ruleSystemAdapter(row?.ruleSystem, fromJsonText<HomebrewMechanicsProfile | null>(row?.customMechanicsProfile, null));
  }

  /** Statblock-derived damage defences for direct tracker damage (issue #605). */
  private targetDamageDefenses(
    row: typeof combatants.$inferSelect,
    damageTypes: readonly string[] | undefined,
    db: SyncDb = this.db,
  ): TargetDefenses {
    if (row.ruleEntryId === null) return { resistances: [], vulnerabilities: [], immunities: [] };
    const encounter = db
      .select({ campaignId: encounters.campaignId })
      .from(encounters)
      .where(eq(encounters.id, row.encounterId))
      .get();
    const campaignScope = encounter
      ? or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, encounter.campaignId))
      : isNull(ruleEntries.campaignId);
    const entry = db
      .select({ dataJson: ruleEntries.dataJson })
      .from(ruleEntries)
      .where(and(eq(ruleEntries.id, row.ruleEntryId), campaignScope))
      .get();
    const data = entry ? fromJsonText<Record<string, unknown>>(entry.dataJson, {}) : {};
    return damageDefensesFromStatblock(data, damageTypes);
  }

  /** Batch-load compendium statblocks for boss-action detection (issue #618). */
  private async statblockMapForCombatants(
    campaignId: number,
    list: Combatant[],
  ): Promise<Map<number, ReturnType<RuleSystemAdapter['mapStatblock']>>> {
    const ruleEntryIds = [...new Set(list.map((c) => c.ruleEntryId).filter((id): id is number => id !== null))];
    const out = new Map<number, ReturnType<RuleSystemAdapter['mapStatblock']>>();
    if (ruleEntryIds.length === 0) return out;
    const adapter = await this.adapterForCampaign(campaignId);
    const rows = await this.db
      .select({ id: ruleEntries.id, dataJson: ruleEntries.dataJson })
      .from(ruleEntries)
      .where(and(inArray(ruleEntries.id, ruleEntryIds), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, campaignId))));
    for (const row of rows) {
      const data = fromJsonText<Record<string, unknown>>(row.dataJson ?? null, {});
      out.set(row.id, adapter.mapStatblock(data));
    }
    return out;
  }

  /**
   * Sort combatants with the campaign ruleset's initiative tiebreak when running
   * (issue #611: 5e DEX-desc, PF2e preserved roll order, …). Non-running statuses
   * ignore the adapter (sortOrder only) — callers should still avoid fetching the
   * adapter when status is not `running`.
   */
  private sortCombatantsWithAdapter(
    rows: Combatant[],
    status: EncounterStatus,
    adapter: RuleSystemAdapter,
  ): Combatant[] {
    if (status !== 'running') return sortCombatants(rows, status);
    return sortCombatants(rows, status, (a, b) => adapter.initiativeTiebreak(a, b));
  }

  private escalationEntry(
    round: number,
    value: number,
    source: EscalationDieHistoryEntry['source'],
    held: boolean,
    override: number | null,
    note: string,
  ): EscalationDieHistoryEntry {
    return EscalationDieHistoryEntry.parse({
      round,
      value,
      source,
      held,
      override,
      note,
      at: nowIso(),
    });
  }

  private appendEscalationHistory(
    currentText: string | null,
    entry: EscalationDieHistoryEntry,
  ): string {
    return toJsonText([...parseEscalationHistory(currentText), entry].slice(-200));
  }

  private nextEscalationState(
    adapter: RuleSystemAdapter,
    current: {
      round: number;
      escalationDie: number | null;
      escalationDieHeld: boolean | null;
      escalationDieOverride: number | null;
      escalationDieHistory: string | null;
    },
    nextRound: number,
    source: EscalationDieHistoryEntry['source'],
  ): {
    escalationDie: number;
    escalationDieHistory?: string;
    logDetail?: string;
  } {
    if (!isArchmageAdapter(adapter)) return { escalationDie: 0 };
    const held = current.escalationDieHeld ?? false;
    const override = current.escalationDieOverride ?? null;
    const previous = current.escalationDie ?? 0;
    const value = override ?? (held ? previous : archmageEscalationDieForRound(adapter, nextRound));
    const note =
      override !== null
        ? `override to +${value}`
        : held
          ? `held at +${value}`
          : `round ${nextRound} default +${value}`;
    const entry = this.escalationEntry(nextRound, value, source, held, override, note);
    const changed = value !== previous || nextRound !== current.round || source === 'start' || source === 'override' || source === 'undo';
    return {
      escalationDie: value,
      escalationDieHistory: changed ? this.appendEscalationHistory(current.escalationDieHistory, entry) : undefined,
      logDetail: changed ? `escalation die ${note}` : undefined,
    };
  }

  async listCombatantRows(encounterId: number) {
    return this.db.select().from(combatants).where(eq(combatants.encounterId, encounterId));
  }

  /**
   * Re-read the single combatant that holds a given character/NPC identity in an
   * encounter (issue #749). Used ONLY by the race-loser branch of addCombatant:
   * when a concurrent add beats our SELECT-then-INSERT probe and the partial
   * unique index rejects our INSERT, we re-read the winner so the 409 body can
   * carry its id deterministically. Exactly one row can match (the partial unique
   * index guarantees it), so `.limit(1)` is belt-and-suspenders. `characterId`
   * and `npcId` are never both set on the same combatant, so selecting one
   * predicate based on which id is non-null is safe (no OR is needed).
   */
  private async findExistingIdentityCombatant(
    encounterId: number,
    characterId: number | null,
    npcId: number | null,
  ): Promise<typeof combatants.$inferSelect | undefined> {
    const where =
      characterId !== null
        ? and(eq(combatants.encounterId, encounterId), eq(combatants.characterId, characterId))
        : npcId !== null
          ? and(eq(combatants.encounterId, encounterId), eq(combatants.npcId, npcId))
          : undefined;
    if (!where) return undefined;
    const [row] = await this.db.select().from(combatants).where(where).limit(1);
    return row;
  }

  /**
   * Resolve the actor name to attribute a combat-log HP/death event to (issue #620).
   * Resolution order:
   *   1. an explicit numeric `actorId` from the patch (the apply-damage caller naming
   *      the attacker directly);
   *   2. the running encounter's current-turn combatant (the default attacker) — only
   *      when `actorId` was omitted (`undefined`);
   *   3. null — fall back to the original target-only phrasing.
   * Tri-state `actorId` contract:
   *   - omitted / `undefined` → try current-turn fallback;
   *   - `null` → opt out of attribution entirely (no current-turn fallback);
   *   - number → use that combatant (self-damage collapses; unknown id falls back).
   * Returns null (no attribution) when:
   *   - the caller sent `actorId: null` to suppress attribution;
   *   - the resolved combatant IS the target (self-damage, or the monster on its own
   *     turn), because the existing log phrasing ("Ember took 8 damage") reads better
   *     than the attributed form ("Ember: took 8 damage") when the actor and target
   *     collapse to the same name;
   *   - the explicit actorId references a combatant that no longer exists in this
   *     encounter (a stale client) — dropped (and the current-turn fallback retried)
   *     rather than 400ing, so a stale client can still apply damage without a second
   *     round-trip and the log still attributes to the most-likely attacker.
   */
  private async resolveCombatLogActor(
    encounterId: number,
    actorId: number | null | undefined,
    currentCombatantId: number | null,
    targetCombatantId: number,
  ): Promise<{ id: number; name: string } | null> {
    // Explicit null = "do not attribute" (used by a11y e2e and callers that want the
    // legacy target-only phrasing). Distinct from omitted/undefined, which falls back
    // to the current-turn combatant.
    if (actorId === null) return null;

    // An explicitly-provided numeric actorId is authoritative: respect it (including
    // the actor==target self-damage case, which collapses to no attribution). Only when
    // it is absent OR fails to resolve (a stale client referencing a removed combatant)
    // do we fall back to the current-turn combatant, so a bogus id still lands the
    // damage and attributes to the most plausible attacker.
    if (actorId !== undefined) {
      if (actorId === targetCombatantId) return null; // explicit self-attribution
      const [explicit] = await this.db
        .select({ id: combatants.id, name: combatants.name })
        .from(combatants)
        .where(and(eq(combatants.id, actorId), eq(combatants.encounterId, encounterId)))
        .limit(1);
      if (explicit?.name) return { id: explicit.id, name: explicit.name };
      // explicit id didn't resolve — fall through to the current-turn fallback.
    }
    if (currentCombatantId === null || currentCombatantId === targetCombatantId) return null;
    const [current] = await this.db
      .select({ id: combatants.id, name: combatants.name })
      .from(combatants)
      .where(and(eq(combatants.id, currentCombatantId), eq(combatants.encounterId, encounterId)))
      .limit(1);
    return current?.name ? { id: current.id, name: current.name } : null;
  }

  /**
   * Persist one combat-log event (issue #61). Called from the combat mutations (HP
   * damage/heal, condition add/remove, death, turn/round) so the run view can show a
   * scrollable history that survives reload. `detail` must never carry a monster's
   * exact HP total — only deltas — and must not interpolate combatant names (issue
   * #869) so listing can redact actor/target without prose bypassing the mask.
   */
  private async appendEvent(
    encounterId: number,
    round: number,
    type: EncounterEventType,
    fields: EncounterEventFields,
  ): Promise<void> {
    await this.db.insert(encounterEvents).values({
      encounterId,
      round,
      type,
      actor: fields.actor ?? null,
      target: fields.target ?? null,
      actorId: fields.actorId ?? null,
      targetId: fields.targetId ?? null,
      detail: fields.detail ?? '',
      chainId: fields.chainId ?? null,
      parentEventId: fields.parentEventId ?? null,
      phase: fields.phase ?? null,
      performedByJson: fields.performedBy ? JSON.stringify(fields.performedBy) : null,
      metadataJson: fields.metadata && Object.keys(fields.metadata).length > 0 ? JSON.stringify(fields.metadata) : null,
      createdAt: nowIso(),
    });
  }

  /** Insert an event into the caller's existing write transaction. */
  private appendEventInTransaction(
    tx: SyncDb,
    encounterId: number,
    round: number,
    type: EncounterEventType,
    fields: EncounterEventFields,
  ): void {
    tx.insert(encounterEvents).values({
      encounterId,
      round,
      type,
      actor: fields.actor ?? null,
      target: fields.target ?? null,
      actorId: fields.actorId ?? null,
      targetId: fields.targetId ?? null,
      detail: fields.detail ?? '',
      chainId: fields.chainId ?? null,
      parentEventId: fields.parentEventId ?? null,
      phase: fields.phase ?? null,
      performedByJson: fields.performedBy ? JSON.stringify(fields.performedBy) : null,
      metadataJson: fields.metadata && Object.keys(fields.metadata).length > 0 ? JSON.stringify(fields.metadata) : null,
      createdAt: nowIso(),
    }).run();
  }

  /**
   * Append a note to the campaign's live (running) encounter combat log (#1021).
   * Used by the AI Driver after successful loot/treasury grants so awards survive
   * reload and appear under the persistent Combat log (not only a transient toast).
   * No-op when no encounter is running. Emits `encounter.updated` for open clients.
   */
  async appendActiveEncounterNote(campaignId: number, detail: string, actor = 'AI DM'): Promise<number | null> {
    const live = await this.findLiveEncounter(campaignId);
    if (!live) return null;
    await this.appendEvent(live.id, live.round, 'note', { actor, detail });
    this.emitEncounterEvent('encounter.updated', campaignId, live.id);
    return live.id;
  }

  /**
   * Lists an encounter's persisted combat log in chronological (insertion) order —
   * issue #61 / #869. Hidden encounters 404 for non-DMs (parity with roster/
   * difficulty). For non-DMs, actor/target names (and any name-bearing detail) are
   * projected from CURRENT hidden-NPC visibility so a later reveal unmasks
   * historical lines; stable actorId/targetId are always returned.
   */
  /**
   * DM-view batch fetch of events for many encounters in ONE query, keyed by encounterId
   * (empty array when an encounter has no events). Avoids the N+1 of calling listEvents()
   * per encounter on the campaign-export path (issue #863). No viewer redaction — callers
   * are DM-scoped (full campaign export).
   */
  async listEventsForEncounters(encounterIds: number[]): Promise<Map<number, EncounterEvent[]>> {
    const result = new Map<number, EncounterEvent[]>();
    for (const id of encounterIds) result.set(id, []);
    if (encounterIds.length === 0) return result;
    const rows = await this.db
      .select()
      .from(encounterEvents)
      .where(inArray(encounterEvents.encounterId, encounterIds))
      .orderBy(encounterEvents.id);
    for (const row of rows) {
      const list = result.get(row.encounterId);
      if (list) list.push(eventToDomain(row));
      else result.set(row.encounterId, [eventToDomain(row)]);
    }
    return result;
  }

  async getEventsHeadId(id: number): Promise<number | null> {
    const row = await this.db.select({ id: encounterEvents.id }).from(encounterEvents).where(eq(encounterEvents.encounterId, id)).orderBy(desc(encounterEvents.id)).limit(1).get();
    return row?.id ?? null;
  }

  async listEvents(encounterId: number, viewerRole?: Role, afterId?: number): Promise<EncounterEvent[]> {
    const row = await this.getRowOrThrow(encounterId);
    if (viewerRole !== undefined && !isVisibleTo({ hidden: row.hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    const whereClause =
      afterId != null
        ? and(eq(encounterEvents.encounterId, encounterId), gt(encounterEvents.id, afterId))
        : eq(encounterEvents.encounterId, encounterId);
    const rows = await this.db
      .select()
      .from(encounterEvents)
      .where(whereClause)
      .orderBy(encounterEvents.id);
    const events = rows.map(eventToDomain);
    if (viewerRole === undefined || viewerRole === 'dm' || events.length === 0) {
      return events;
    }

    const combatantRows = await this.listCombatantRows(encounterId);
    const linkedNpcIds = [...new Set(combatantRows.flatMap((c) => [c.npcId, c.npcIdentitySourceId].filter((n): n is number => n !== null)))];
    const hiddenNpcIds = new Set<number>();
    if (linkedNpcIds.length > 0) {
      const hiddenRows = await this.db
        .select({ id: npcs.id })
        .from(npcs)
        .where(and(inArray(npcs.id, linkedNpcIds), eq(npcs.hidden, true)));
      for (const r of hiddenRows) hiddenNpcIds.add(r.id);
    }
    return redactEncounterEventsForViewer(
      events,
      combatantRows.map((c) => ({ id: c.id, name: c.name, npcId: c.npcId, npcIdentitySourceId: c.npcIdentitySourceId })),
      hiddenNpcIds,
    );
  }

  /**
   * Redact `questId`, `locationId`, and `sessionId` to `null` on encounter domain objects
   * (or digests) when viewed by a non-DM and the linked entity is hidden, unexplored, or deleted.
   */
  private async redactHiddenLinkedEntities<T extends { questId: number | null; locationId: number | null; sessionId: number | null }>(
    items: T[],
    campaignId: number,
    viewerRole?: Role,
  ): Promise<T[]> {
    if (viewerRole === undefined || viewerRole === 'dm' || items.length === 0) {
      return items;
    }

    const questIds = Array.from(new Set(items.map((i) => i.questId).filter((id): id is number => id !== null)));
    const locationIds = Array.from(new Set(items.map((i) => i.locationId).filter((id): id is number => id !== null)));
    const sessionIds = Array.from(new Set(items.map((i) => i.sessionId).filter((id): id is number => id !== null)));

    const hiddenQuestIds = new Set<number>();
    if (questIds.length > 0) {
      const questRows = await this.db
        .select({ id: quests.id, hidden: quests.hidden, deletedAt: quests.deletedAt })
        .from(quests)
        .where(and(inArray(quests.id, questIds), eq(quests.campaignId, campaignId)));
      const foundIds = new Set(questRows.map((q) => q.id));
      for (const id of questIds) {
        if (!foundIds.has(id)) hiddenQuestIds.add(id);
      }
      for (const q of questRows) {
        if (q.hidden || q.deletedAt !== null) {
          hiddenQuestIds.add(q.id);
        }
      }
    }

    const hiddenLocationIds = new Set<number>();
    if (locationIds.length > 0) {
      const locRows = await this.db
        .select({ id: locations.id, status: locations.status, deletedAt: locations.deletedAt })
        .from(locations)
        .where(and(inArray(locations.id, locationIds), eq(locations.campaignId, campaignId)));
      const foundIds = new Set(locRows.map((l) => l.id));
      for (const id of locationIds) {
        if (!foundIds.has(id)) hiddenLocationIds.add(id);
      }
      for (const l of locRows) {
        if (l.status === 'unexplored' || l.deletedAt !== null) {
          hiddenLocationIds.add(l.id);
        }
      }
    }

    const hiddenSessionIds = new Set<number>();
    if (sessionIds.length > 0) {
      const sessRows = await this.db
        .select({ id: sessions.id, deletedAt: sessions.deletedAt })
        .from(sessions)
        .where(and(inArray(sessions.id, sessionIds), eq(sessions.campaignId, campaignId)));
      const foundIds = new Set(sessRows.map((s) => s.id));
      for (const id of sessionIds) {
        if (!foundIds.has(id)) hiddenSessionIds.add(id);
      }
      for (const s of sessRows) {
        if (s.deletedAt !== null) {
          hiddenSessionIds.add(s.id);
        }
      }
    }

    if (hiddenQuestIds.size === 0 && hiddenLocationIds.size === 0 && hiddenSessionIds.size === 0) {
      return items;
    }

    return items.map((item) => {
      const qId = item.questId !== null && hiddenQuestIds.has(item.questId) ? null : item.questId;
      const lId = item.locationId !== null && hiddenLocationIds.has(item.locationId) ? null : item.locationId;
      const sId = item.sessionId !== null && hiddenSessionIds.has(item.sessionId) ? null : item.sessionId;
      if (qId === item.questId && lId === item.locationId && sId === item.sessionId) {
        return item;
      }
      return {
        ...item,
        questId: qId,
        locationId: lId,
        sessionId: sId,
      };
    });
  }

  private sessionDisplayLabel(row: { title: string | null; number: number; id: number }): string {
    const title = row.title?.trim();
    return title && title.length > 0 ? title : `Session ${row.number}`;
  }

  /**
   * Attach role-safe display metadata for location/quest/session links (issue #480).
   * Call after {@link redactHiddenLinkedEntities} so hidden targets are already nulled
   * for non-DM viewers.
   */
  private async attachEncounterLinkMeta<T extends { locationId: number | null; questId: number | null; sessionId: number | null }>(
    items: T[],
    campaignId: number,
  ): Promise<Array<T & { locationLink?: EncounterLinkMeta | null; questLink?: EncounterLinkMeta | null; sessionLink?: EncounterLinkMeta | null }>> {
    if (items.length === 0) return items;

    const locationIds = Array.from(new Set(items.map((i) => i.locationId).filter((id): id is number => id !== null)));
    const questIds = Array.from(new Set(items.map((i) => i.questId).filter((id): id is number => id !== null)));
    const sessionIds = Array.from(new Set(items.map((i) => i.sessionId).filter((id): id is number => id !== null)));

    const locationById = new Map<number, EncounterLinkMeta>();
    if (locationIds.length > 0) {
      const rows = await this.db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(and(inArray(locations.id, locationIds), eq(locations.campaignId, campaignId), notDeleted(locations.deletedAt)));
      for (const row of rows) {
        locationById.set(row.id, { id: row.id, label: row.name });
      }
    }

    const questById = new Map<number, EncounterLinkMeta>();
    if (questIds.length > 0) {
      const rows = await this.db
        .select({ id: quests.id, title: quests.title })
        .from(quests)
        .where(and(inArray(quests.id, questIds), eq(quests.campaignId, campaignId), notDeleted(quests.deletedAt)));
      for (const row of rows) {
        questById.set(row.id, { id: row.id, label: row.title });
      }
    }

    const sessionById = new Map<number, EncounterLinkMeta>();
    if (sessionIds.length > 0) {
      const rows = await this.db
        .select({ id: sessions.id, title: sessions.title, number: sessions.number })
        .from(sessions)
        .where(and(inArray(sessions.id, sessionIds), eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)));
      for (const row of rows) {
        sessionById.set(row.id, { id: row.id, label: this.sessionDisplayLabel(row) });
      }
    }

    return items.map((item) => ({
      ...item,
      ...(item.locationId !== null ? { locationLink: locationById.get(item.locationId) ?? null } : {}),
      ...(item.questId !== null ? { questLink: questById.get(item.questId) ?? null } : {}),
      ...(item.sessionId !== null ? { sessionLink: sessionById.get(item.sessionId) ?? null } : {}),
    }));
  }

  /**
   * Encounters linked to a location, quest, or session (issue #480 backlinks).
   * Hidden encounters are dropped for non-DM callers, mirroring listForCampaign.
   */
  async listBacklinks(
    campaignId: number,
    filter: { locationId?: number; questId?: number; sessionId?: number },
    viewerRole?: Role,
  ): Promise<EncounterBacklink[]> {
    const conditions = [eq(encounters.campaignId, campaignId), notDeleted(encounters.deletedAt)];
    if (filter.locationId !== undefined) conditions.push(eq(encounters.locationId, filter.locationId));
    if (filter.questId !== undefined) conditions.push(eq(encounters.questId, filter.questId));
    if (filter.sessionId !== undefined) conditions.push(eq(encounters.sessionId, filter.sessionId));

    const rows = await this.db
      .select({ id: encounters.id, name: encounters.name, status: encounters.status, hidden: encounters.hidden })
      .from(encounters)
      .where(and(...conditions))
      .orderBy(encounters.id);

    const visible = viewerRole === undefined || viewerRole === 'dm' ? rows : rows.filter((r) => !r.hidden);
    return visible.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status as EncounterStatus,
    }));
  }

  /**
   * `viewerRole` drives entity-level secrecy (issue #262): a hidden encounter is a DM's
   * prepared, not-yet-sprung fight and is dropped WHOLESALE for a non-DM viewer — mirroring
   * how QuestsService/NpcsService filter hidden rows. Omit `viewerRole` (or pass `dm`) only
   * for DM-facing callers (e.g. the full-backup export), which must see hidden encounters.
   */
  async listForCampaign(
    campaignId: number,
    status?: EncounterStatus,
    viewerRole?: Role,
    q?: string,
  ): Promise<Encounter[]> {
    const conditions = [
      eq(encounters.campaignId, campaignId),
      notDeleted(encounters.deletedAt),
      status ? eq(encounters.status, status) : undefined,
    ].filter(
      (c): c is NonNullable<typeof c> => c !== undefined,
    );
    const rows = await this.db
      .select()
      .from(encounters)
      .where(conditions.length > 1 ? and(...conditions) : conditions[0]);
    let list = rows.map(encounterToDomain);
    // Drop hidden encounters wholesale for a non-DM viewer (issue #262). undefined role
    // (DM-facing callers) is never filtered.
    list = viewerRole === undefined ? list : filterHidden(list, viewerRole);
    const folded = q !== undefined ? foldForSearch(q.trim()) : '';
    if (folded) {
      list = list.filter((enc) => foldedIncludes(enc.name, folded));
    }
    const runningCount = list.filter((enc) => enc.status === 'running').length;
    let pinActiveId: number | null = null;
    if (runningCount > 1) {
      const active = await this.findLiveEncounter(campaignId);
      pinActiveId = active?.id ?? null;
    }
    list = sortEncountersForList(list, { pinActiveId });
    const redacted = await this.redactHiddenLinkedEntities(list, campaignId, viewerRole);
    return this.attachEncounterLinkMeta(redacted, campaignId);
  }

  async searchForCampaign(campaignId: number, role: Role, needle: string, limit: number): Promise<EncounterSearchEntry[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    // SearchService passes an already-folded needle; fold again for idempotent callers (#624).
    const folded = foldForSearch(needle.trim());
    if (!folded) return [];
    const questLabel = role === 'dm'
      ? sql<string>`coalesce(${quests.title}, '')`
      : sql<string>`case when ${quests.hidden} = 0 then coalesce(${quests.title}, '') else '' end`;
    const locationLabel = role === 'dm'
      ? sql<string>`coalesce(${locations.name}, '')`
      : sql<string>`case when ${locations.status} <> 'unexplored' then coalesce(${locations.name}, '') else '' end`;
    const sessionLabel = sql<string>`case
      when ${sessions.id} is null then ''
      when length(trim(coalesce(${sessions.title}, ''))) > 0 then ${sessions.title}
      else 'Session ' || ${sessions.number}
    end`;

    // Load role-visible rows, then fold-match in JS. SQLite lower()/instr is ASCII-only
    // and would miss ß→ss / accent / İ haystacks even for ASCII needles (#624).
    const rows = await this.db
      .select({
        id: encounters.id,
        campaignId: encounters.campaignId,
        name: encounters.name,
        locationLabel,
        questLabel,
        sessionLabel,
      })
      .from(encounters)
      .leftJoin(
        locations,
        and(
          eq(locations.id, encounters.locationId),
          eq(locations.campaignId, campaignId),
          notDeleted(locations.deletedAt),
        ),
      )
      .leftJoin(
        quests,
        and(eq(quests.id, encounters.questId), eq(quests.campaignId, campaignId), notDeleted(quests.deletedAt)),
      )
      .leftJoin(
        sessions,
        and(eq(sessions.id, encounters.sessionId), eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)),
      )
      .where(and(
        eq(encounters.campaignId, campaignId),
        notDeleted(encounters.deletedAt),
        role === 'dm' ? undefined : eq(encounters.hidden, false),
      ))
      .orderBy(encounters.id);

    return rows
      .filter(
        (r) =>
          // Prefix-token match keeps this bounded read on the same semantics as the
          // FTS5 index (issue #1481), so the encounter set agrees across modes.
          matchesSearchQuery(r.name, folded)
          || matchesSearchQuery(r.locationLabel ?? '', folded)
          || matchesSearchQuery(r.questLabel ?? '', folded)
          || matchesSearchQuery(r.sessionLabel ?? '', folded),
      )
      // One extra row is a cap sentinel: the search fallback detects it and
      // raises the response truncation flag without a second count (issue #1481).
      .slice(0, boundedLimit + 1);
  }


  /**
   * `viewerRole` drives issue #43 redaction: anyone below `dm` (player/viewer)
   * gets monster HP replaced with a coarse band. Omit it (or pass `dm`) only for
   * DM-facing returns — the DM always sees exact HP.
   */
  // Issue #1909 review (Devin, tenth finding): `includeDeleted` defaults to `false` —
  // identical default to `getRowOrThrow`'s own — so every EXISTING caller (roughly two
  // dozen across this service plus the controller/cast/export/scribe/MCP-tools call
  // sites) is completely unaffected; only a caller that explicitly opts in (currently
  // just `adjustCombatantResource`'s role-mismatch keyed-replay fallback, below) can ever
  // see a soft-deleted (trashed) encounter's projection through this method.
  async getWithCombatantsOrThrow(id: number, viewerRole?: Role, viewerUserId?: string, includeDeleted = false): Promise<EncounterWithCombatants> {
    const row = await this.getRowOrThrow(id, includeDeleted);
    // Entity-level secrecy (issue #262): a hidden encounter (DM prep) must be
    // indistinguishable from a nonexistent one for a non-DM — 404 (not 403), so its
    // very existence + roster aren't leaked. Mirrors QuestsService.getOrThrow. undefined
    // role (DM-facing callers like the export) always sees it.
    if (viewerRole !== undefined && !isVisibleTo({ hidden: row.hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${id} not found`);
    }
    const combatantRows = await this.listCombatantRows(id);
    const status = row.status as EncounterStatus;
    // Initiative tiebreak only affects running order — skip the campaign/adapter
    // lookup for preparing/ended reads (hot path; issue #611 review).
    let list: Combatant[];
    if (status === 'running') {
      const adapter = await this.adapterForCampaign(row.campaignId);
      list = this.sortCombatantsWithAdapter(combatantRows.map(combatantToDomain), status, adapter);
    } else {
      list = sortCombatants(combatantRows.map(combatantToDomain), status);
    }
    if (viewerRole !== undefined && viewerRole !== 'dm') {
      // The disposition snapshot preserves encounter-time enemy allegiance for
      // server-side difficulty/XP calculation. It is DM-only: campaign-authored
      // values may reveal a hidden NPC's allegiance to players.
      const monsterHpDisplay = (row.monsterHpDisplay ?? 'band') as MonsterHpDisplay;
      list = list.map((c) => ({ ...redactMonsterHp(c, monsterHpDisplay), npcDispositionSnapshot: null }));
      // Hidden-NPC identity (issue #374): HP is banded by redactMonsterHp, but a combatant
      // linked to a HIDDEN NPC still leaked that NPC's identity to non-DMs via `npcId` + the
      // borrowed name. Hidden NPCs are dropped wholesale from every other non-DM surface, so
      // here we sever the identity link (null npcId) and mask the name — the token still shows
      // in initiative (its position matters to play) but not who it is.
      const linkedNpcIds = [...new Set(combatantRows.flatMap((c) => [c.npcId, c.npcIdentitySourceId].filter((n): n is number => n !== null)))];
      if (linkedNpcIds.length > 0) {
        const hiddenRows = await this.db
          .select({ id: npcs.id })
          .from(npcs)
          .where(and(inArray(npcs.id, linkedNpcIds), eq(npcs.hidden, true)));
        const hiddenIds = new Set(hiddenRows.map((r) => r.id));
        if (hiddenIds.size > 0) {
          list = list.map((c) => {
            const source = combatantRows.find((row) => row.id === c.id);
            return source && [source.npcId, source.npcIdentitySourceId].some((id) => id !== null && hiddenIds.has(id))
              ? { ...c, npcId: null, name: UNKNOWN_COMBATANT_LABEL }
              : c;
          });
        }
      }
      // Fog of war (issue #40 / #463): withhold the position of any token in an
      // unrevealed region. Encounter JSON still degrades invalid fog to `null` for
      // the fog field itself, but token coordinates must fail closed the same way
      // the map-byte path does — otherwise a corrupt fog row would leak monster
      // positions while the image stayed fully masked. Sibling fog protection is
      // mirrored here too: when another encounter still conceals the shared map,
      // this fight's tokens must not float on a fully masked board.
      const fog = parseFog(row.fog);
      const invalidFog = row.fog !== null && fog === null;
      // Sibling protection applies whenever THIS encounter does not itself conceal
      // pixels — including fog enabled but fully revealed (no rectangles masked).
      const ownFogConceals = !invalidFog && fogConcealsPixels(fog);
      const siblingProtects =
        !invalidFog &&
        !ownFogConceals &&
        row.mapAttachmentId != null &&
        (await this.attachmentsService.isFogProtectedEncounterMap(row.mapAttachmentId, row.campaignId));
      if (invalidFog || siblingProtects) {
        const concealAll: FogState = { enabled: true, revealed: [] };
        list = list.map((c) => redactTokenInFog(c, concealAll));
      } else if (fog?.enabled) {
        list = list.map((c) => redactTokenInFog(c, fog));
      }
    }
    // Issue #466: when an ended fight's sheet HP diverged from the combatant snapshot,
    // surface conflicts so the DM can choose a resync direction before /reopen. DM-only
    // (and undefined-role internal callers); players never see the CAS preview.
    const hpSyncConflicts =
      status === 'ended' && (viewerRole === undefined || viewerRole === 'dm')
        ? await this.collectHpSyncConflicts(combatantRows)
        : undefined;
    const statblocks = await this.statblockMapForCombatants(row.campaignId, list);
    list = enrichCombatantsWithLegendaryPools(list, statblocks);
    const domain = encounterToDomain(row);
    const [redactedDomain] = await this.redactHiddenLinkedEntities([domain], row.campaignId, viewerRole);
    const [withLinks] = await this.attachEncounterLinkMeta([redactedDomain], row.campaignId);
    // Issue #465: AoE templates in unrevealed fog leak origin/shape/dimensions to players
    // (and render above the fog overlay client-side). Filter server-side for non-DMs using
    // the same concealment rules as token redaction; player-declared templates stay visible
    // to their owner via declaredByUserId.
    const aoe = viewerRole !== undefined && viewerRole !== 'dm'
      ? this.filterAoeTemplatesForViewer(this.db, row, withLinks.aoe ?? [], viewerUserId)
      : withLinks.aoe ?? [];
    return {
      ...withLinks,
      aoe,
      combatants: list,
      ...(hpSyncConflicts && hpSyncConflicts.length > 0 ? { hpSyncConflicts } : {}),
    };
  }

  /**
   * Issue #466: compare each character combatant's snapshot against the live sheet.
   * A conflict is any divergent HP/death slice — the DM must pick keep_combatant or
   * pull_sheet before reopen can proceed.
   */
  private async collectHpSyncConflicts(
    combatantRows: Array<typeof combatants.$inferSelect>,
  ): Promise<HpSyncConflict[]> {
    const characterCombatants = combatantRows.filter((r) => r.kind === 'character' && r.characterId != null);
    if (characterCombatants.length === 0) return [];
    const characterIds = characterCombatants.map((r) => r.characterId!);
    const sheetRows = await this.db.select().from(characters).where(inArray(characters.id, characterIds));
    const sheetById = new Map(sheetRows.map((c) => [c.id, c]));
    const conflicts: HpSyncConflict[] = [];
    for (const row of characterCombatants) {
      const sheet = sheetById.get(row.characterId!);
      if (!sheet) continue;
      const combatantSlice = hpSyncSliceOf(row);
      const sheetSlice = hpSyncSliceOf(sheet);
      if (hpSyncSlicesEqual(combatantSlice, sheetSlice)) continue;
      conflicts.push({
        combatantId: row.id,
        characterId: sheet.id,
        name: row.name,
        combatant: combatantSlice,
        sheet: { ...sheetSlice, updatedAt: sheet.updatedAt },
      });
    }
    return conflicts;
  }

  async getCombatantRowOrThrow(encounterId: number, combatantId: number) {
    const [row] = await this.db
      .select()
      .from(combatants)
      .where(and(eq(combatants.id, combatantId), eq(combatants.encounterId, encounterId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
    return row;
  }

  /**
   * mapAttachmentId is an FK-shaped field (issue #39) — mirror CampaignsService's
   * validateAttachmentRef: the attachment must exist AND belong to THIS encounter's
   * campaign, so another campaign's attachment id can't be smuggled in. null clears it.
   */
  private async validateAttachmentRef(attachmentId: number | null | undefined, campaignId: number): Promise<void> {
    if (attachmentId == null) return;
    const [row] = await this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.campaignId, campaignId),
          eq(attachments.state, ATTACHMENT_STATE_COMMITTED),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException(`mapAttachmentId ${attachmentId} does not exist in this campaign`);
  }

  /**
   * DM-only: edit an encounter's name, its location/quest/session links (issue #126), and/or
   * its battle map (issue #39). Only fields present in `input` are written; `null` clears a
   * link/map. A linked location/quest/session must belong to THIS campaign (404).
   *
   * Attaching a battle map does NOT reveal the attachment (issue #259): a fogged encounter
   * map must stay hidden (DM-only) as a *handout* so it never surfaces raw on the player
   * Handouts card, defeating fog-of-war. The fogged encounter canvas still renders it for
   * players — the file route (GET /attachments/:id/file) serves an encounter's map to non-DM
   * even while hidden (see AttachmentsService.isEncounterMap).
   *
   * Optimistic concurrency (issue #532): live combat is the highest-contention entity (the
   * same encounter open across multiple DM devices — a laptop + a tablet at the table), so it
   * enforces the same `expectedUpdatedAt` CAS invariant as quests/npcs/locations/sessions. A
   * stale tab's save (its `expectedUpdatedAt` no longer matches the row's current `updatedAt`)
   * 409s before any write rather than silently clobbering the fresher edit — the classic
   * "lost fog/grid edit looks like the map reverted" failure. Omitted => unconditional write
   * (unchanged back-compat for any client that hasn't opted in).
   */
  async updateEncounter(
    encounterId: number,
    input: EncounterUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    // Optimistic concurrency (#532): 409 on a stale expectedUpdatedAt before any write.
    this.revisions.assertNotStale(encounterRow, opts?.expectedUpdatedAt);

    const set: Partial<typeof encounters.$inferInsert> = {};
    const changedPredicates: SQL[] = [];
    if (input.name !== undefined && input.name !== encounterRow.name) {
      set.name = input.name;
      changedPredicates.push(sql`${encounters.name} IS NOT ${input.name}`);
    }
    if (input.locationId !== undefined) {
      if (input.locationId !== null) await this.assertEntityInCampaign('location', input.locationId, encounterRow.campaignId);
      if (input.locationId !== encounterRow.locationId) {
        set.locationId = input.locationId;
        changedPredicates.push(sql`${encounters.locationId} IS NOT ${input.locationId}`);
      }
    }
    if (input.questId !== undefined) {
      if (input.questId !== null) await this.assertEntityInCampaign('quest', input.questId, encounterRow.campaignId);
      if (input.questId !== encounterRow.questId) {
        set.questId = input.questId;
        changedPredicates.push(sql`${encounters.questId} IS NOT ${input.questId}`);
      }
    }
    if (input.sessionId !== undefined) {
      if (input.sessionId !== null) await this.assertEntityInCampaign('session', input.sessionId, encounterRow.campaignId);
      if (input.sessionId !== encounterRow.sessionId) {
        set.sessionId = input.sessionId;
        changedPredicates.push(sql`${encounters.sessionId} IS NOT ${input.sessionId}`);
      }
    }
    const mapAttachmentIdChanging =
      input.mapAttachmentId !== undefined && input.mapAttachmentId !== encounterRow.mapAttachmentId;
    const previousFog = parseFog(encounterRow.fog);
    const resetFog = previousFog?.enabled ? { enabled: true, revealed: [] } : null;
    const resetApplied =
      input.mapAlignment === 'reset' && (encounterRow.mapAttachmentId != null || input.mapAttachmentId != null);

    if (input.mapAttachmentId !== undefined) {
      // Do NOT flip the attachment to hidden=false here (issue #259). A battle map must stay
      // hidden as a handout so it isn't exposed raw on the player Handouts card; the fogged
      // canvas still gets it via the file route's encounter-map exception.
      await this.validateAttachmentRef(input.mapAttachmentId, encounterRow.campaignId);
      if (mapAttachmentIdChanging) {
        set.mapAttachmentId = input.mapAttachmentId;
        changedPredicates.push(sql`${encounters.mapAttachmentId} IS NOT ${input.mapAttachmentId}`);
      }
    }

    // Issue #870: when the map is being reset (with or without changing attachment id),
    // clear every piece of dependent spatial state in the same transaction so old
    // tokens/grid/fog/AoE don't reappear on the new (or re-selected) image.
    if (resetApplied) {
      set.gridSize = null;
      set.gridScale = null;
      set.gridUnit = null;
      set.gridSnap = false;
      set.gridType = 'square';
      set.hexOrientation = 'pointy';
      set.gridOffsetX = 0;
      set.gridOffsetY = 0;
      set.gridCellHeight = null;
      set.gridRotation = 0;
      set.gridOpacity = 0.35;
      // Fog is intentionally *not* disabled; `null` means "never configured" (fully visible).
      // Reset clears the revealed mask while keeping fog enabled, so the new map stays hidden.
      set.fog = resetFog ? toJsonText(resetFog) : null;
      set.aoe = toJsonText([]);

      if (set.gridSize !== encounterRow.gridSize) changedPredicates.push(sql`${encounters.gridSize} IS NOT ${set.gridSize}`);
      if (set.gridScale !== encounterRow.gridScale) changedPredicates.push(sql`${encounters.gridScale} IS NOT ${set.gridScale}`);
      if (set.gridUnit !== encounterRow.gridUnit) changedPredicates.push(sql`${encounters.gridUnit} IS NOT ${set.gridUnit}`);
      if (set.gridSnap !== encounterRow.gridSnap) changedPredicates.push(sql`${encounters.gridSnap} IS NOT ${set.gridSnap ? 1 : 0}`);
      if (set.gridType !== (encounterRow.gridType ?? 'square')) changedPredicates.push(sql`${encounters.gridType} IS NOT ${set.gridType}`);
      if (set.hexOrientation !== (encounterRow.hexOrientation ?? 'pointy')) changedPredicates.push(sql`${encounters.hexOrientation} IS NOT ${set.hexOrientation}`);
      if (set.gridOffsetX !== (encounterRow.gridOffsetX ?? 0)) changedPredicates.push(sql`${encounters.gridOffsetX} IS NOT ${set.gridOffsetX}`);
      if (set.gridOffsetY !== (encounterRow.gridOffsetY ?? 0)) changedPredicates.push(sql`${encounters.gridOffsetY} IS NOT ${set.gridOffsetY}`);
      if (set.gridCellHeight !== (encounterRow.gridCellHeight ?? null)) changedPredicates.push(sql`${encounters.gridCellHeight} IS NOT ${set.gridCellHeight}`);
      if (set.gridRotation !== (encounterRow.gridRotation ?? 0)) changedPredicates.push(sql`${encounters.gridRotation} IS NOT ${set.gridRotation}`);
      if (set.gridOpacity !== (encounterRow.gridOpacity ?? 0.35)) changedPredicates.push(sql`${encounters.gridOpacity} IS NOT ${set.gridOpacity}`);
      if (!isDeepStrictEqual(set.fog, encounterRow.fog)) changedPredicates.push(sql`${encounters.fog} IS NOT ${set.fog}`);
      if (!isDeepStrictEqual(set.aoe, encounterRow.aoe)) changedPredicates.push(sql`${encounters.aoe} IS NOT ${set.aoe}`);
    }

    // When the map is being reset, the per-field grid/fog/AoE guards below must compare
    // against the reset defaults (not the old row), otherwise explicit inputs equal to the
    // old values are skipped and the reset null/default survives into the UPDATE.
    const baseline = resetApplied
      ? {
          ...encounterRow,
          gridSize: null as number | null,
          gridScale: null as number | null,
          gridUnit: null as string | null,
          gridSnap: false,
          gridType: 'square' as const,
          hexOrientation: 'pointy' as const,
          gridOffsetX: 0,
          gridOffsetY: 0,
          gridCellHeight: null as number | null,
          gridRotation: 0,
          gridOpacity: 0.35,
        }
      : encounterRow;
    const fogBaseline = resetApplied ? resetFog : previousFog;
    const aoeBaseline = resetApplied ? [] : parseAoe(encounterRow.aoe);

    // VTT grid config (issue #40, phase 2). Each field is independently settable/clearable.
    if (input.gridSize !== undefined && input.gridSize !== baseline.gridSize) {
      set.gridSize = input.gridSize;
      changedPredicates.push(sql`${encounters.gridSize} IS NOT ${input.gridSize}`);
    }
    if (input.gridScale !== undefined && input.gridScale !== baseline.gridScale) {
      set.gridScale = input.gridScale;
      changedPredicates.push(sql`${encounters.gridScale} IS NOT ${input.gridScale}`);
    }
    if (input.gridUnit !== undefined && input.gridUnit !== baseline.gridUnit) {
      set.gridUnit = input.gridUnit;
      changedPredicates.push(sql`${encounters.gridUnit} IS NOT ${input.gridUnit}`);
    }
    if (input.gridSnap !== undefined && input.gridSnap !== baseline.gridSnap) {
      set.gridSnap = input.gridSnap;
      changedPredicates.push(sql`${encounters.gridSnap} IS NOT ${input.gridSnap ? 1 : 0}`);
    }
    if (input.gridType !== undefined && input.gridType !== (baseline.gridType ?? 'square')) {
      set.gridType = input.gridType;
      changedPredicates.push(sql`${encounters.gridType} IS NOT ${input.gridType}`);
    }
    if (input.hexOrientation !== undefined && input.hexOrientation !== (baseline.hexOrientation ?? 'pointy')) {
      set.hexOrientation = input.hexOrientation;
      changedPredicates.push(sql`${encounters.hexOrientation} IS NOT ${input.hexOrientation}`);
    }
    // Grid calibration (issue #417) — each field independently settable. gridCellHeight is
    // nullable (null restores square cells); the others carry non-null defaults. Same
    // null-safe no-op guard as the fields above so an unchanged write produces no audit/SSE.
    if (input.gridOffsetX !== undefined && input.gridOffsetX !== (baseline.gridOffsetX ?? 0)) {
      set.gridOffsetX = input.gridOffsetX;
      changedPredicates.push(sql`${encounters.gridOffsetX} IS NOT ${input.gridOffsetX}`);
    }
    if (input.gridOffsetY !== undefined && input.gridOffsetY !== (baseline.gridOffsetY ?? 0)) {
      set.gridOffsetY = input.gridOffsetY;
      changedPredicates.push(sql`${encounters.gridOffsetY} IS NOT ${input.gridOffsetY}`);
    }
    if (input.gridCellHeight !== undefined && input.gridCellHeight !== (baseline.gridCellHeight ?? null)) {
      set.gridCellHeight = input.gridCellHeight;
      changedPredicates.push(sql`${encounters.gridCellHeight} IS NOT ${input.gridCellHeight}`);
    }
    if (input.gridRotation !== undefined && input.gridRotation !== (baseline.gridRotation ?? 0)) {
      set.gridRotation = input.gridRotation;
      changedPredicates.push(sql`${encounters.gridRotation} IS NOT ${input.gridRotation}`);
    }
    if (input.gridOpacity !== undefined && input.gridOpacity !== (baseline.gridOpacity ?? 0.35)) {
      set.gridOpacity = input.gridOpacity;
      changedPredicates.push(sql`${encounters.gridOpacity} IS NOT ${input.gridOpacity}`);
    }
    // Fog of war (issue #40, phase 3). Stored as JSON text; null clears it entirely.
    if (input.fog !== undefined && !isDeepStrictEqual(input.fog, fogBaseline)) {
      const fog = input.fog === null ? null : toJsonText(input.fog);
      set.fog = fog;
      changedPredicates.push(sql`${encounters.fog} IS NOT ${fog}`);
    }
    // Shared AoE templates (issue #238). Stored as JSON text; an empty array clears them.
    if (input.aoe !== undefined) {
      let aoeBaselineForAttribution = aoeBaseline;
      if (encounterRow.aoe && aoeBaseline.length === 0 && !resetApplied) {
        try {
          const raw = JSON.parse(encounterRow.aoe);
          if (Array.isArray(raw)) {
            aoeBaselineForAttribution = raw.filter(
              (item): item is AoeTemplate => item != null && typeof item === 'object' && typeof item.id === 'string',
            );
          }
        } catch {
          // ignore parsing error fallback
        }
      }
      const previousById = new Map(aoeBaselineForAttribution.map((template) => [template.id, template]));
      const aoeInput = input.aoe.map((template) => ({
        ...template,
        declaredByUserId: previousById.get(template.id)?.declaredByUserId ?? null,
      }));
      if (!isDeepStrictEqual(aoeInput, aoeBaseline)) {
        const aoe = toJsonText(aoeInput);
        set.aoe = aoe;
        changedPredicates.push(sql`${encounters.aoe} IS NOT ${aoe}`);
      }
    }
    // Entity-level secrecy (issue #262) — DM-only (this whole endpoint requires dm). true
    // hides the encounter's roster + difficulty from non-DM reads; the DM reveals by
    // patching hidden back to false.
    if (input.hidden !== undefined && input.hidden !== encounterRow.hidden) {
      set.hidden = input.hidden;
      changedPredicates.push(sql`${encounters.hidden} IS NOT ${input.hidden ? 1 : 0}`);
    }
    // Monster-HP display dial (issue #1925) — DM-only (this whole endpoint requires dm).
    // Mid-fight switches propagate to non-DM viewers on their next read/SSE refetch.
    if (input.monsterHpDisplay !== undefined && input.monsterHpDisplay !== (encounterRow.monsterHpDisplay ?? 'band')) {
      set.monsterHpDisplay = input.monsterHpDisplay;
      changedPredicates.push(sql`${encounters.monsterHpDisplay} IS NOT ${input.monsterHpDisplay}`);
    }
    // Turn timer pacing limit (issue #1935) — dm only, like the rest of this endpoint.
    // `turnStartedAt` is deliberately absent from EncounterUpdate/EncounterUpdateDto (strict
    // schema), so it can never reach here at all — it is stamped only by the turn-transition
    // methods themselves (start/advanceCurrentTurn/undoTurn/reopen), never via PATCH.
    if (input.turnTimerSeconds !== undefined && input.turnTimerSeconds !== (encounterRow.turnTimerSeconds ?? 0)) {
      set.turnTimerSeconds = input.turnTimerSeconds;
      changedPredicates.push(sql`${encounters.turnTimerSeconds} IS NOT ${input.turnTimerSeconds}`);
    }

    if (changedPredicates.length === 0) {
      return this.getWithCombatantsOrThrow(encounterId, role);
    }

    set.updatedAt = nowIso();
    // The null-safe predicates make the semantic no-op check atomic. Two clients may both
    // observe missing defaults, but after the first write the second UPDATE changes zero rows
    // and therefore produces no duplicate audit entry or SSE invalidation (#865).
    const shouldResetTokens = resetApplied;

    // Issue #870: run the encounter update and (when resetting) token clearing inside
    // one SQLite transaction so a map swap cannot commit without its dependent state.
    const result = this.db.transaction((tx) => {
      const result = tx
        .update(encounters)
        .set(set)
        .where(and(eq(encounters.id, encounterId), or(...changedPredicates)))
        .run();
      const rowsChanged = (result as unknown as { changes?: number }).changes ?? 0;
      if (rowsChanged > 0 && shouldResetTokens) {
        tx.update(combatants)
          .set({ tokenX: null, tokenY: null })
          .where(eq(combatants.encounterId, encounterId))
          .run();
      }
      return result;
    });
    const rowsChanged = (result as unknown as { changes?: number }).changes ?? 0;
    if (rowsChanged === 0) {
      return this.getWithCombatantsOrThrow(encounterId, role);
    }

    // If this update activates fog over a map that had previously been revealed as
    // a handout, restage the raw attachment immediately. The raw-file route also
    // checks fog dynamically (defense in depth), so even a failure here cannot leak
    // source pixels; this keeps the attachment metadata/UI consistent as well.
    let effectiveMapId = set.mapAttachmentId !== undefined ? set.mapAttachmentId : encounterRow.mapAttachmentId;
    const effectiveFog =
      set.fog !== undefined
        ? parseFog(set.fog)
        : input.fog !== undefined
          ? input.fog
          : parseFog(encounterRow.fog);
    if (effectiveMapId != null && fogConcealsPixels(effectiveFog)) {
      // Reusing the campaign region-map attachment as a fogged battle map would
      // block players from GET /attachments/:id/file (RegionMap has no fog-safe
      // alternate). Clone the bytes onto a dedicated battle-map row and retarget
      // this encounter so the shared campaign background stays player-visible.
      const [campaign] = await this.db
        .select({ mapAttachmentId: campaigns.mapAttachmentId })
        .from(campaigns)
        .where(eq(campaigns.id, encounterRow.campaignId))
        .limit(1);
      if (campaign?.mapAttachmentId === effectiveMapId) {
        const clone = await this.attachmentsService.duplicate(effectiveMapId, user, role, {
          filenamePrefix: 'battle-',
        });
        await this.db
          .update(encounters)
          .set({ mapAttachmentId: clone.id, updatedAt: nowIso() })
          .where(eq(encounters.id, encounterId));
        effectiveMapId = clone.id;
      }

      const attachment = await this.attachmentsService.getRowOrThrow(effectiveMapId);
      // Only hide attachments that belong to this encounter's campaign — never
      // side-effect another campaign's row if a stale/cross-campaign id slipped through.
      if (attachment.campaignId === encounterRow.campaignId && !attachment.hidden) {
        await this.attachmentsService.setHidden(effectiveMapId, true, user, role);
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.update',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
      detail: JSON.stringify(input),
    });

    // Use post-update visibility so a reveal (hidden → false) still notifies players.
    const nextHidden = input.hidden !== undefined ? input.hidden : encounterRow.hidden;
    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, nextHidden);

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  /**
   * DM-only: reveal one rectangular region of the fog-of-war mask (issue #40, phase 3). Reads
   * the current fog state, enables fog if it wasn't already, appends the rectangle (capped so
   * the JSON blob stays bounded), and persists via updateEncounter — so the same audit trail,
   * SSE `encounter.updated` signal (other clients refetch live), and player-side token
   * redaction all apply. Exposed over MCP as `reveal_map_region` so an AI DM can light the
   * board a region at a time without round-tripping the whole mask.
   */
  async revealFogRegion(encounterId: number, rect: FogRect, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const row = await this.getRowOrThrow(encounterId);
    const current = parseFog(row.fog) ?? { enabled: true, revealed: [] };
    const next: FogState = { enabled: true, revealed: [...current.revealed, rect].slice(-500) };
    return this.updateEncounter(encounterId, { fog: next }, user, role);
  }

  /**
   * Broadcast a transient battle-map ping (issue #238). Unlike fog/AoE this persists nothing —
   * it rides the campaign event stream as a one-shot `encounter.ping` signal every open client
   * renders briefly and lets fade. Any DM or player (not viewer, issue #1636) may drop one (a
   * live table gesture); the caller-side controller only asserts membership, not caller role
   * (`requireMember`, not `requireRole`) — see the role-floor check below for why. Hidden
   * encounters are non-enumerating 404s for non-DMs (issue #869 — parity with
   * roster/events/difficulty). The ping location is a coordinate the sender chose, so there is
   * no secret to leak (contrast the id-only updated/deleted signals). Returns nothing
   * meaningful — the effect is the emitted event.
   */
  pingMap(
    encounterId: number,
    campaignId: number,
    ping: MapPing,
    viewerRole?: Role,
    /** Encounter.hidden from the caller's already-fetched row (issue #869). */
    hidden = false,
  ): void {
    if (viewerRole !== undefined && !isVisibleTo({ hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    // Issue #1636: the role floor lives HERE, after the hidden-visibility check above,
    // not in the controller. If the controller rejected a viewer with requireRole('player')
    // up front, a viewer probing a HIDDEN encounter would get a 403 instead of the 404
    // issue #869 requires — leaking that the encounter exists. Placing the floor after the
    // visibility check keeps hidden encounters a uniform 404 for every non-DM, while a
    // merely-visible encounter now correctly rejects a viewer instead of letting them
    // broadcast a ping (the route's own docs already promised "any DM or player").
    if (viewerRole !== undefined && !roleAtLeast(viewerRole, 'player')) {
      throw new ForbiddenException('Viewers may not ping the map.');
    }
    // #754: never fan a hidden encounter's ping — which carries map coordinates —
    // onto the shared campaign stream, or both its existence and the ping payload
    // leak to players. The DM's request still succeeds (they can see it); once the
    // encounter is revealed the ping can be re-issued.
    if (hidden) return;
    this.events.emit({ type: 'encounter.ping', campaignId, encounterId, ping });
  }

  /**
   * Enforce the role and secrecy rules shared by the player-addressable AoE write
   * routes. This deliberately runs inside the transaction before the campaign
   * lifecycle recheck, so a hidden encounter stays non-enumerating even after
   * archive; the lifecycle check still runs transactionally before any write.
   */
  private assertAoeTemplateWriteAccess(encounter: typeof encounters.$inferSelect, role: Role): void {
    if (!isVisibleTo({ hidden: encounter.hidden }, role)) {
      throw new NotFoundException(`Encounter ${encounter.id} not found`);
    }
    if (!roleAtLeast(role, 'player')) {
      throw new ForbiddenException('Viewers may not declare or modify AoE templates.');
    }
  }

  /**
   * The server's one fail-closed AoE visibility computation. Reads and scoped
   * writes must agree: invalid fog and a sibling encounter that still protects
   * a reused map both conceal every non-owned template.
   */
  private filterAoeTemplatesForViewer(
    db: SyncDb,
    encounter: typeof encounters.$inferSelect,
    aoe: readonly AoeTemplateType[],
    viewerUserId: string | undefined,
  ): AoeTemplateType[] {
    const fog = parseFog(encounter.fog);
    const invalidFog = encounter.fog !== null && fog === null;
    const ownFogConceals = !invalidFog && fogConcealsPixels(fog);
    const siblingProtects =
      !invalidFog &&
      !ownFogConceals &&
      encounter.mapAttachmentId != null &&
      db
        .select({ fog: encounters.fog })
        .from(encounters)
        .where(and(
          eq(encounters.mapAttachmentId, encounter.mapAttachmentId),
          eq(encounters.campaignId, encounter.campaignId),
          isNotNull(encounters.fog),
        ))
        .all()
        .some((row) => persistedFogConcealsPixels(row.fog));
    if (invalidFog || siblingProtects) {
      return filterAoeTemplatesForViewer(aoe, { enabled: true, revealed: [] }, { viewerUserId });
    }
    return filterAoeTemplatesForViewer(aoe, fog, { viewerUserId });
  }

  /**
   * Create one player- or DM-declared AoE template (issue #1913). Attribution is
   * stamped from the authenticated caller rather than accepted from the request.
   */
  async declareAoeTemplate(
    encounterId: number,
    input: unknown,
    user: RequestUser,
    role: Role,
    /** REST stays create-only; MCP exposes explicit create/update operations. */
    operation: 'create' | 'update' = 'create',
  ): Promise<AoeTemplateType> {
    // REST and MCP creations are complete; MCP updates deliberately permit a
    // partial payload. Keep raw key presence so
    // schema defaults cannot overwrite fields the caller did not intend to change.
    const rawInput = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const createTemplate = operation === 'update' ? undefined : AoeTemplateDeclare.parse(input);
    const templateId = createTemplate?.id ?? AoeTemplate.shape.id.parse(rawInput.id);
    let emittedEncounter: typeof encounters.$inferSelect | undefined;
    let declared: AoeTemplateType | undefined;
    let action: 'encounter.aoe.declare' | 'encounter.aoe.update' = 'encounter.aoe.declare';
    let changed = false;

    this.db.transaction((tx) => {
      const fresh = tx.select().from(encounters).where(eq(encounters.id, encounterId)).get();
      if (!fresh) throw new NotFoundException(`Encounter ${encounterId} not found`);
      this.assertAoeTemplateWriteAccess(fresh, role);
      this.assertCampaignWritableInTx(tx, fresh.campaignId);
      this.assertMutable(fresh);

      const current = parseAoeForScopedWrite(fresh.aoe);
      const existingIndex = current.findIndex((candidate) => candidate.id === templateId);
      if (existingIndex >= 0) {
        const existing = current[existingIndex];
        if (role !== 'dm' && !this.filterAoeTemplatesForViewer(tx, fresh, [existing], user.id).some((candidate) => candidate.id === templateId)) {
          throw new NotFoundException(`AoE template ${templateId} not found`);
        }
        if (operation === 'create') throw new ConflictException(`AoE template ${templateId} already exists`);
        if (role !== 'dm' && existing.declaredByUserId !== user.id) {
          throw new ForbiddenException('Players may modify only their own AoE templates.');
        }
        // MCP upserts may omit defaulted fields such as angle/color; merge only raw
        // caller-supplied keys so a move cannot reset the existing template's intent.
        const supplied = Object.fromEntries(
          Object.entries(rawInput).filter(([key, value]) => key !== 'id' && key !== 'declaredByUserId' && value !== undefined),
        );
        declared = AoeTemplate.parse({ ...existing, ...supplied, declaredByUserId: existing.declaredByUserId });
        if (isDeepStrictEqual(declared, existing)) {
          emittedEncounter = fresh;
          return;
        }
        current[existingIndex] = declared;
        action = 'encounter.aoe.update';
      } else {
        if (operation === 'update') throw new NotFoundException(`AoE template ${templateId} not found`);
        if (current.length >= 50) {
          throw new ConflictException('An encounter may have at most 50 AoE templates');
        }
        if (role !== 'dm' && current.filter((template) => template.declaredByUserId === user.id).length >= MAX_PLAYER_DECLARED_AOE_TEMPLATES) {
          throw new ConflictException(`A player may declare at most ${MAX_PLAYER_DECLARED_AOE_TEMPLATES} AoE templates per encounter`);
        }
        declared = { ...(createTemplate ?? AoeTemplateDeclare.parse(input)), declaredByUserId: role === 'dm' ? null : user.id };
        current.push(declared);
      }
      tx.update(encounters)
        .set({ aoe: toJsonText(current), updatedAt: nextUpdatedAt(fresh.updatedAt) })
        .where(eq(encounters.id, encounterId))
        .run();
      emittedEncounter = fresh;
      changed = true;
    });

    if (changed) {
      const encounter = emittedEncounter!;
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action,
        entityType: 'encounter',
        entityId: encounterId,
        campaignId: encounter.campaignId,
        detail: declared!.id,
      });
      this.emitEncounterEvent('encounter.updated', encounter.campaignId, encounterId, encounter.hidden);
    }
    return declared!;
  }

  /** Update an AoE template while preserving the server-owned declarer identity. */
  async updateAoeTemplate(
    encounterId: number,
    templateId: string,
    input: AoeTemplateUpdateInput,
    user: RequestUser,
    role: Role,
  ): Promise<AoeTemplateType> {
    AoeTemplate.shape.id.parse(templateId);
    const patch = AoeTemplateUpdate.parse(input);
    let emittedEncounter: typeof encounters.$inferSelect | undefined;
    let updated: AoeTemplateType | undefined;
    let changed = false;

    this.db.transaction((tx) => {
      const fresh = tx.select().from(encounters).where(eq(encounters.id, encounterId)).get();
      if (!fresh) throw new NotFoundException(`Encounter ${encounterId} not found`);
      this.assertAoeTemplateWriteAccess(fresh, role);
      this.assertCampaignWritableInTx(tx, fresh.campaignId);
      this.assertMutable(fresh);

      const current = parseAoeForScopedWrite(fresh.aoe);
      const index = current.findIndex((candidate) => candidate.id === templateId);
      if (index < 0) throw new NotFoundException(`AoE template ${templateId} not found`);
      const existing = current[index];
      if (role !== 'dm' && existing.declaredByUserId !== user.id) {
        if (this.filterAoeTemplatesForViewer(tx, fresh, [existing], user.id).length === 0) {
          throw new NotFoundException(`AoE template ${templateId} not found`);
        }
        throw new ForbiddenException('Players may modify only their own AoE templates.');
      }

      // `AoeTemplateUpdate` cannot include id or declarer. Re-parse the joined
      // value so the persisted array always retains the full AoeTemplate invariant.
      updated = AoeTemplate.parse({ ...existing, ...patch, declaredByUserId: existing.declaredByUserId });
      if (isDeepStrictEqual(updated, existing)) {
        emittedEncounter = fresh;
        return;
      }
      current[index] = updated;
      tx.update(encounters)
        .set({ aoe: toJsonText(current), updatedAt: nextUpdatedAt(fresh.updatedAt) })
        .where(eq(encounters.id, encounterId))
        .run();
      emittedEncounter = fresh;
      changed = true;
    });

    if (changed) {
      const encounter = emittedEncounter!;
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.aoe.update',
        entityType: 'encounter',
        entityId: encounterId,
        campaignId: encounter.campaignId,
        detail: templateId,
      });
      this.emitEncounterEvent('encounter.updated', encounter.campaignId, encounterId, encounter.hidden);
    }
    return updated!;
  }

  /** Remove an AoE template under the same secrecy, lifecycle, and ownership gates. */
  async removeAoeTemplate(
    encounterId: number,
    templateId: string,
    user: RequestUser,
    role: Role,
  ): Promise<{ ok: true }> {
    AoeTemplate.shape.id.parse(templateId);
    let emittedEncounter: typeof encounters.$inferSelect | undefined;

    this.db.transaction((tx) => {
      const fresh = tx.select().from(encounters).where(eq(encounters.id, encounterId)).get();
      if (!fresh) throw new NotFoundException(`Encounter ${encounterId} not found`);
      this.assertAoeTemplateWriteAccess(fresh, role);
      this.assertCampaignWritableInTx(tx, fresh.campaignId);
      this.assertMutable(fresh);

      const current = parseAoeForScopedWrite(fresh.aoe);
      const existing = current.find((candidate) => candidate.id === templateId);
      if (!existing) throw new NotFoundException(`AoE template ${templateId} not found`);
      if (role !== 'dm' && existing.declaredByUserId !== user.id) {
        if (this.filterAoeTemplatesForViewer(tx, fresh, [existing], user.id).length === 0) {
          throw new NotFoundException(`AoE template ${templateId} not found`);
        }
        throw new ForbiddenException('Players may remove only their own AoE templates.');
      }
      tx.update(encounters)
        .set({ aoe: toJsonText(current.filter((candidate) => candidate.id !== templateId)), updatedAt: nextUpdatedAt(fresh.updatedAt) })
        .where(eq(encounters.id, encounterId))
        .run();
      emittedEncounter = fresh;
    });

    const encounter = emittedEncounter!;
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.aoe.remove',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounter.campaignId,
      detail: templateId,
    });
    this.emitEncounterEvent('encounter.updated', encounter.campaignId, encounterId, encounter.hidden);
    return { ok: true };
  }

  /**
   * Creates the encounter (preparing) and auto-adds every ACTIVE campaign character as a
   * combatant (issue #115 — non-active PCs are skipped).
   *
   * Issue #864: every non-null location/quest/session link is validated against THIS
   * campaign before any insert, audit, or SSE. Missing and foreign targets share one
   * non-enumerating 404. The encounter row + auto-added combatants commit in a single
   * transaction so a mid-create failure never leaves partial rows. REST, MCP,
   * generate?commit, and AI/proposal creates all funnel through this method.
   */
  async create(campaignId: number, input: EncounterCreateInput, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    // Validate links BEFORE any write so a bad target never produces an encounter row,
    // combatants, audit entry, or SSE event (issue #864).
    if (input.locationId != null) await this.assertEntityInCampaign('location', input.locationId, campaignId);
    if (input.questId != null) await this.assertEntityInCampaign('quest', input.questId, campaignId);
    if (input.sessionId != null) await this.assertEntityInCampaign('session', input.sessionId, campaignId);

    const ts = nowIso();

    // Auto-add only ACTIVE characters (issue #115, #719). Draft/dead/retired/inactive PCs
    // stay on the roster but are skipped here, so incomplete sheets and a long
    // campaign's fallen and replaced characters stop being force-conscripted into
    // add any of them manually via addCombatant. Legacy pre-migration rows all default
    // to 'active', preserving prior behavior.
    const partyRows = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), eq(characters.status, 'active'), notDeleted(characters.deletedAt)));
    // Resolve the adapter outside the write transaction — it is a pure campaign lookup
    // and must not sit between the encounter INSERT and the combatant INSERT.
    const adapter = partyRows.length > 0 ? await this.adapterForCampaign(campaignId) : null;

    // Encounter + party combatants land in ONE synchronous transaction (issue #864 /
    // better-sqlite3) so a mid-create failure never leaves a fight without its party
    // (or combatants without a parent). Audit/SSE fire only after commit.
    const encounterRow = this.db.transaction((tx) => {
      const [row] = tx
        .insert(encounters)
        .values({
          campaignId,
          name: input.name,
          status: 'preparing',
          round: 0,
          turnIndex: 0,
          // Optional where/why/when links (issue #126). undefined -> null.
          locationId: input.locationId ?? null,
          questId: input.questId ?? null,
          sessionId: input.sessionId ?? null,
          // Private-by-default prep (#754 / #262): omit → DM-only; pass false to reveal at create.
          hidden: resolveCreateHidden(input.hidden),
          endedAt: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();

      // Auto-add the whole party in ONE multi-row INSERT (#72) rather than one INSERT
      // per character — the row values (including the sequential sortOrder) are computed
      // in JS and handed to a single `.values([...])`. Behavior is identical to the old
      // per-row loop; only the round-trip count changes (N -> 1).
      if (partyRows.length > 0 && adapter) {
        const combatantValues = partyRows.map((character, index) => {
          const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
          const init = characterInitiativeBreakdown(adapter, stats, character.level);
          // Issue #711: seed the combatant's death/temp-HP slice from the persistent
          // sheet so a stable-but-unconscious PC (carried over from a prior fight via
          // /end reconciliation) re-enters the next encounter still down, not silently
          // revived. Defaults hold for pre-#711 sheets (alive + temp-less).
          return {
            encounterId: row.id,
            kind: 'character' as const,
            characterId: character.id,
            name: character.name,
            initiative: null,
            initMod: init.modifier,
            initiativeBreakdown: toJsonText(init),
            hpCurrent: character.hpCurrent,
            hpMax: character.hpMax,
            hpTemp: character.hpTemp,
            deathState: character.deathState,
            deathSaveSuccesses: character.deathSaveSuccesses,
            deathSaveFailures: character.deathSaveFailures,
            // Issue #1910: same add-time speed snapshot as the single-combatant
            // addCombatant() path — without it, an auto-added party member's movement
            // max would resolve through the character's LIVE speed on every read
            // instead of freezing at the value the sheet had when the fight started.
            speed: character.speed,
            // Issue #466: stamp the sheet CAS token at open so a later re-end can detect
            // intervening sheet edits made while the encounter was ended.
            sheetSyncedUpdatedAt: character.updatedAt,
            // Issue #486: seed tracker conditions from the sheet so Poisoned (etc.)
            // applied before combat is already visible in the run-session roster.
            // Merge semantics for the overlap window: see sync comment on updateCombatant.
            // #1047: carry the sheet's structured copy in too. No translation needed —
            // a sheet instance already has the round-scoped fields null, so it enters as an
            // indefinite condition, which is correct.
            ...conditionWriteSetFromInstances(
              readConditionInstances(character.conditionInstances, character.conditions),
            ),
            ruleEntryId: null,
            sortOrder: index,
          };
        });
        tx.insert(combatants).values(combatantValues).run();
      }
      return row;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.create',
      entityType: 'encounter',
      entityId: encounterRow.id,
      campaignId,
      detail: `${partyRows.length} party member(s) auto-added`,
    });

    this.emitEncounterEvent('encounter.updated', campaignId, encounterRow.id, encounterRow.hidden);

    return this.getWithCombatantsOrThrow(encounterRow.id, role);
  }

  /**
   * Guard that a link target exists in the same campaign as the encounter (issues #126 /
   * #864). Missing and foreign (other-campaign) targets share one non-enumerating 404 —
   * the response never reveals whether the id exists elsewhere.
   */
  private async assertEntityInCampaign(kind: 'location' | 'quest' | 'session', id: number, campaignId: number): Promise<void> {
    const table = kind === 'location' ? locations : kind === 'quest' ? quests : sessions;
    const [row] = await this.db
      .select({ campaignId: table.campaignId })
      .from(table)
      .where(and(eq(table.id, id), eq(table.campaignId, campaignId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException(`${kind} not found`);
    }
  }

  /**
   * Compute a read-only difficulty estimate for an encounter (issues #58 + #429). Pulls the
   * PC levels from character-combatants and monster CRs from linked rule entries, then
   * asks the campaign's RuleSystemAdapter to own the math/labels/support status. Homebrew
   * and non-5e systems return an explicit unsupported result; manual enemies with no CR/XP
   * return unknown ("Unknown—add XP/CR") instead of a misleading Trivial band.
   */
  async getDifficulty(encounterId: number, viewerRole?: Role): Promise<EncounterDifficulty> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    // Entity-level secrecy (issue #262): a hidden encounter's difficulty (monsterCount +
    // adjustedXp) is DM-only prep — deny a non-DM the same way the roster read does (404, so
    // existence isn't leaked). undefined role is DM-facing and always allowed.
    if (viewerRole !== undefined && !isVisibleTo({ hidden: encounterRow.hidden }, viewerRole)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    const [campaignRow] = await this.db
      .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
      .from(campaigns)
      .where(eq(campaigns.id, encounterRow.campaignId))
      .limit(1);
    const ruleSystem = campaignRow?.ruleSystem ?? null;
    const adapter = ruleSystemAdapter(
      ruleSystem,
      fromJsonText<HomebrewMechanicsProfile | null>(campaignRow?.customMechanicsProfile, null),
    );
    const combatantRows = await this.listCombatantRows(encounterId);

    // Party levels: from each character-combatant's linked character sheet.
    const characterIds = combatantRows
      .filter((c) => c.kind === 'character' && c.characterId !== null)
      .map((c) => c.characterId as number);
    const levelById = new Map<number, number>();
    if (characterIds.length > 0) {
      const charRows = await this.db
        .select({ id: characters.id, level: characters.level })
        .from(characters)
        .where(inArray(characters.id, characterIds));
      for (const r of charRows) levelById.set(r.id, r.level);
    }
    const partyLevels = characterIds.map((id) => levelById.get(id) ?? 1);

    // Enemy CRs: monsters plus NPCs whose captured/current campaign disposition is
    // hostile. A non-DM must not learn a hidden NPC's allegiance or statblock through
    // this aggregate, so hidden (and unlinked) NPC combatants fail closed for that view.
    const npcCombatants = combatantRows.filter((c) => c.kind === 'npc' && (c.npcId !== null || c.npcIdentitySourceId !== null));
    const npcIds = [...new Set(npcCombatants.flatMap((c) => [c.npcId, c.npcIdentitySourceId].filter((id): id is number => id !== null)))];
    const hostileNpcIds = new Set<number>();
    const hiddenNpcIds = new Set<number>();
    if (npcIds.length > 0) {
      const npcRows = await this.db
        .select({ id: npcs.id, disposition: npcs.disposition, hidden: npcs.hidden })
        .from(npcs)
        .where(and(inArray(npcs.id, npcIds), eq(npcs.campaignId, encounterRow.campaignId)));
      for (const npc of npcRows) {
        if (npc.disposition.trim().toLowerCase() === 'hostile') hostileNpcIds.add(npc.id);
        if (npc.hidden) hiddenNpcIds.add(npc.id);
      }
    }
    const dmView = viewerRole === undefined || viewerRole === 'dm';
    const enemyCombatants = combatantRows.filter((c) => {
      if (c.kind === 'monster') return true;
      const npcIdentityId = c.npcIdentitySourceId ?? c.npcId;
      const hasHiddenNpcIdentity = [c.npcId, c.npcIdentitySourceId].some((id) => id !== null && hiddenNpcIds.has(id));
      if (c.kind !== 'npc' || (!dmView && (npcIdentityId === null || hasHiddenNpcIdentity))) return false;
      // Preparation is still authored world state: show the NPC's live
      // disposition until start() captures historical allegiance for play.
      const disposition = encounterRow.status === 'preparing'
        ? (npcIdentityId !== null && hostileNpcIds.has(npcIdentityId) ? 'hostile' : '')
        : c.npcDispositionSnapshot ?? (npcIdentityId !== null && hostileNpcIds.has(npcIdentityId) ? 'hostile' : '');
      return disposition.trim().toLowerCase() === 'hostile';
    });
    // An enemy combatant with no ruleEntryId (or an entry lacking a CR) contributes a null CR
    // rather than being dropped, so missing data can surface as unknown (issue #429).
    const ruleEntryIds = enemyCombatants.map((c) => c.ruleEntryId).filter((id): id is number => id !== null);
    const crById = new Map<number, number | null>();
    if (ruleEntryIds.length > 0) {
      const entryRows = await this.db
        .select({ id: ruleEntries.id, dataJson: ruleEntries.dataJson })
        .from(ruleEntries)
        .where(and(inArray(ruleEntries.id, ruleEntryIds), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, encounterRow.campaignId))));
      for (const r of entryRows) {
        const data = fromJsonText<Record<string, unknown>>(r.dataJson, {});
        // Statblock CR field mapping comes from the adapter (issue #70), not inline field names.
        crById.set(r.id, parseCr(adapter.mapStatblock(data).challengeRating));
      }
    }
    const monsterCrs = enemyCombatants.map((c) => (c.ruleEntryId !== null ? (crById.get(c.ruleEntryId) ?? null) : null));

    return estimateEncounterDifficultyForRuleSystem(ruleSystem, {
      partyLevels,
      monsterChallengeRatings: monsterCrs,
    });
  }

  private generateDefaultAftermathLoot(
    outcome: EncounterAftermathOutcome,
    suggestedPartyXp: number | null,
  ): EncounterAftermathLoot {
    const deadMonsters = outcome.dead.filter((c: EncounterAftermathCombatant) => c.kind === 'monster' || c.kind === 'npc');
    const items: EncounterAftermathLootItem[] = [];

    if (deadMonsters.length > 0) {
      deadMonsters.forEach((monster: EncounterAftermathCombatant, index: number) => {
        items.push({
          id: `item-${index + 1}`,
          name: `${monster.name}'s Gear`,
          qty: 1,
          notes: `Looted from defeated ${monster.name}`,
          claimed: false,
          claimedByCharacterId: null,
          claimedToParty: false,
        });
      });
    } else {
      items.push({
        id: 'item-1',
        name: 'Spoils of War',
        qty: 1,
        notes: 'Combat trophies and supplies',
        claimed: false,
        claimedByCharacterId: null,
        claimedToParty: false,
      });
    }

    const gpAmount = suggestedPartyXp && suggestedPartyXp > 0 ? Math.max(10, Math.round(suggestedPartyXp / 10)) : 25;

    return {
      items,
      coins: {
        cp: 0,
        sp: 0,
        ep: 0,
        gp: gpAmount,
        pp: 0,
      },
      coinsClaimed: false,
    };
  }

  /**
   * Post-encounter aftermath read model (issue #473, #1448): outcome review, recap draft seeded
   * from combat events, adapter-aware XP guidance, loot list package, mutation controls, and deep-link hand-offs. DM-only;
   * only meaningful for ended encounters.
   */
  async getAftermath(encounterId: number, role: Role): Promise<EncounterAftermath> {
    const encounter = await this.getWithCombatantsOrThrow(encounterId, role);
    if (encounter.status !== 'ended') {
      throw new BadRequestException('Aftermath is only available for ended encounters');
    }
    const row = await this.getRowOrThrow(encounterId);
    const events = await this.listEvents(encounterId, role);
    const difficulty = await this.getDifficulty(encounterId, role);
    const outcome = aftermathOutcome(encounter.combatants, encounter.round);
    const { recapDraft, combatLogHighlights } = buildEncounterAftermathRecapDraft(encounter, events);
    const characterCount = encounter.combatants.filter((c) => c.kind === 'character').length;
    const xp = suggestedXpFromDifficulty(difficulty, characterCount);
    const campaignId = encounter.campaignId;

    const campaignRow = this.db
      .select({ dmControlsProgression: campaigns.dmControlsProgression })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .get();
    const milestoneMode = !!campaignRow?.dmControlsProgression || !xp.supported;

    const outcomeRead: EncounterAftermathOutcome = {
      rounds: outcome.rounds,
      dead: outcome.dead.map((c) => ({ name: c.name, kind: c.kind })),
      downed: outcome.downed.map((c) => ({ name: c.name, kind: c.kind })),
      survivors: outcome.survivors.map((c) => ({ name: c.name, kind: c.kind })),
    };

    let loot: EncounterAftermathLoot;
    if (row.aftermathLoot) {
      const parsed = EncounterAftermathLoot.safeParse(fromJsonText(row.aftermathLoot, null));
      if (parsed.success) {
        loot = parsed.data;
      } else {
        loot = this.generateDefaultAftermathLoot(outcomeRead, xp.suggestedPartyTotal);
      }
    } else {
      loot = this.generateDefaultAftermathLoot(outcomeRead, xp.suggestedPartyTotal);
      this.db
        .update(encounters)
        .set({ aftermathLoot: toJsonText(loot) })
        .where(eq(encounters.id, encounterId))
        .run();
    }

    const base = `/c/${campaignId}`;
    const recapPath =
      encounter.sessionId == null
        ? `${base}/sessions?action=new-recap&fromEncounter=${encounterId}`
        : `${base}/sessions?session=${encounter.sessionId}&action=edit-recap&fromEncounter=${encounterId}`;
    const xpQuery = xp.suggestedPerCharacter != null ? `&amount=${xp.suggestedPerCharacter}` : '';
    const handoffs = {
      recapPath,
      awardXpPath: `${base}/party?action=award-xp${xpQuery}`,
      inventoryPath: `${base}/inventory?action=add-item&fromEncounter=${encounterId}`,
      questPath: encounter.questId != null ? `${base}/quests/${encounter.questId}` : null,
      sessionPath: encounter.sessionId != null ? `${base}/sessions?session=${encounter.sessionId}` : null,
      encounterLogPath: `${base}/encounters/${encounterId}#combat-log`,
    };
    return {
      encounterId,
      campaignId,
      outcome: outcomeRead,
      recapDraft,
      combatLogHighlights,
      xp: {
        supported: xp.supported,
        suggestedPartyTotal: xp.suggestedPartyTotal,
        suggestedPerCharacter: xp.suggestedPerCharacter,
        undistributedXp: xp.undistributedXp,
        difficultyLabel: xp.difficultyLabel,
        warnings: xp.warnings,
      },
      xpAwardedAt: row.aftermathXpAwardedAt ?? null,
      xpAwarded: row.aftermathXpAwardedAt != null,
      milestoneMode,
      loot,
      difficulty,
      handoffs,
      questId: encounter.questId,
      sessionId: encounter.sessionId,
      locationId: encounter.locationId,
      dismissedAt: row.aftermathDismissedAt ?? null,
    };
  }

  async applyAftermathXp(
    encounterId: number,
    input: EncounterAftermathApplyXpInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterAftermath> {
    const row = await this.getRowOrThrow(encounterId);
    if (row.status !== 'ended') {
      throw new BadRequestException('Aftermath XP can only be applied for ended encounters');
    }

    if (row.aftermathXpAwardedAt && input.amount === undefined && !input.isMilestone) {
      return this.getAftermath(encounterId, role);
    }

    const encounter = await this.getWithCombatantsOrThrow(encounterId, role);
    const difficulty = await this.getDifficulty(encounterId, role);
    const characterCombatants = encounter.combatants.filter((c) => c.kind === 'character');
    const characterCount = characterCombatants.length;
    const xp = suggestedXpFromDifficulty(difficulty, characterCount);

    const amount = input.amount ?? xp.suggestedPerCharacter ?? xp.suggestedPartyTotal ?? 0;
    const recipientIds =
      input.characterIds ?? characterCombatants.map((c) => c.characterId).filter((id): id is number => id != null);

    const ts = nowIso();

    if (amount > 0 && recipientIds.length > 0) {
      if (this.charactersService) {
        await this.charactersService.awardXp(
          row.campaignId,
          { amount, includeNonActive: false, characterIds: recipientIds },
          user,
          role,
        );
      } else {
        this.db.transaction((tx) => {
          for (const charId of recipientIds) {
            // Issue #1902 rework (round 13, codex P2 sweep): PER CHARACTER, not the shared
            // `ts` above — same class of bug as `restParty`/`awardXp`'s own per-character
            // fix. This fallback path only runs when `charactersService` isn't injected
            // (the preferred branch above already calls the fixed `awardXp`), but it writes
            // the same CAS-guarded `updatedAt` column, so it needs the same guarantee.
            const current = tx.select({ updatedAt: characters.updatedAt }).from(characters).where(eq(characters.id, charId)).get();
            tx.update(characters)
              .set({ xp: sql`${characters.xp} + ${amount}`, updatedAt: nextUpdatedAt(current?.updatedAt ?? ts) })
              .where(eq(characters.id, charId))
              .run();
          }
        });
      }
    }

    this.db
      .update(encounters)
      .set({ aftermathXpAwardedAt: ts, updatedAt: ts })
      .where(eq(encounters.id, encounterId))
      .run();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.aftermath_apply_xp',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: row.campaignId,
      detail: JSON.stringify({ amount, characterIds: recipientIds, isMilestone: !!input.isMilestone, note: input.milestoneNote }),
    });

    return this.getAftermath(encounterId, role);
  }

  async transferAftermathLoot(
    encounterId: number,
    input: EncounterAftermathLootTransferInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterAftermath> {
    const row = await this.getRowOrThrow(encounterId);
    if (row.status !== 'ended') {
      throw new BadRequestException('Aftermath loot can only be transferred for ended encounters');
    }

    const aftermath = await this.getAftermath(encounterId, role);
    const loot = aftermath.loot;
    const ts = nowIso();

    if (input.itemId) {
      const item = loot.items.find((i) => i.id === input.itemId);
      if (!item) {
        throw new BadRequestException(`Loot item ${input.itemId} not found in aftermath`);
      }
      if (item.claimed) {
        throw new BadRequestException(`Loot item ${input.itemId} has already been claimed`);
      }

      const ownerType = input.ownerType ?? 'party';
      const characterId = ownerType === 'character' ? (input.characterId ?? null) : null;
      const qty = input.qty ?? item.qty;

      if (this.inventoryService) {
        await this.inventoryService.create(
          row.campaignId,
          {
            name: item.name,
            qty,
            notes: item.notes || `Looted from encounter #${encounterId}`,
            ownerType,
            characterId: characterId ?? undefined,
          },
          user,
          role,
        );
      } else {
        this.db
          .insert(inventoryItems)
          .values({
            campaignId: row.campaignId,
            ownerType,
            characterId,
            name: item.name,
            qty,
            notes: item.notes || `Looted from encounter #${encounterId}`,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      item.claimed = true;
      item.claimedByCharacterId = characterId;
      item.claimedToParty = ownerType === 'party';
    }

    if (input.transferCoins) {
      const coinsToTransfer = {
        cp: input.transferCoins.cp ?? loot.coins.cp,
        sp: input.transferCoins.sp ?? loot.coins.sp,
        ep: input.transferCoins.ep ?? loot.coins.ep,
        gp: input.transferCoins.gp ?? loot.coins.gp,
        pp: input.transferCoins.pp ?? loot.coins.pp,
      };

      if (this.inventoryService) {
        await this.inventoryService.patchTreasury(
          row.campaignId,
          { delta: coinsToTransfer },
          user,
          role,
        );
      }

      loot.coinsClaimed = true;
    }

    this.db
      .update(encounters)
      .set({ aftermathLoot: toJsonText(loot), updatedAt: ts })
      .where(eq(encounters.id, encounterId))
      .run();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.aftermath_transfer_loot',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: row.campaignId,
      detail: JSON.stringify(input),
    });

    return this.getAftermath(encounterId, role);
  }

  async updateAftermathQuest(
    encounterId: number,
    input: EncounterAftermathQuestUpdateInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterAftermath> {
    const row = await this.getRowOrThrow(encounterId);
    if (row.status !== 'ended') {
      throw new BadRequestException('Aftermath quest updates can only be applied to ended encounters');
    }
    const questId = input.questId ?? row.questId;
    if (!questId) {
      throw new BadRequestException('No quest specified or linked to encounter aftermath');
    }

    if (this.questsService) {
      if (input.objectiveIndex != null) {
        const objectives = await this.db
          .select()
          .from(questObjectives)
          .where(eq(questObjectives.questId, questId))
          .orderBy(questObjectives.sortOrder, questObjectives.id);
        const obj = objectives[input.objectiveIndex];
        if (obj) {
          await this.questsService.patchObjective(
            questId,
            obj.id,
            { done: input.objectiveCompleted ?? !obj.done },
            user,
            role,
          );
        }
      }
      if (input.questStatus) {
        await this.questsService.setStatus(questId, { status: input.questStatus }, user, role);
      }
    } else {
      const objectives = await this.db
        .select()
        .from(questObjectives)
        .where(eq(questObjectives.questId, questId))
        .orderBy(questObjectives.sortOrder, questObjectives.id);
      if (input.objectiveIndex != null && objectives[input.objectiveIndex]) {
        const targetObj = objectives[input.objectiveIndex];
        this.db
          .update(questObjectives)
          .set({ done: input.objectiveCompleted ?? !targetObj.done })
          .where(eq(questObjectives.id, targetObj.id))
          .run();
      }
      if (input.questStatus) {
        this.db
          .update(quests)
          .set({ status: input.questStatus, updatedAt: nowIso() })
          .where(eq(quests.id, questId))
          .run();
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.aftermath_update_quest',
      entityType: 'quest',
      entityId: questId,
      campaignId: row.campaignId,
      detail: JSON.stringify(input),
    });

    return this.getAftermath(encounterId, role);
  }

  async updateAftermathBeat(
    encounterId: number,
    input: EncounterAftermathBeatUpdateInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterAftermath> {
    const row = await this.getRowOrThrow(encounterId);
    if (row.status !== 'ended') {
      throw new BadRequestException('Aftermath beats can only be updated for ended encounters');
    }

    if (input.beatId && this.storylinesService) {
      await this.storylinesService.updateBeat(
        input.beatId,
        {
          ...(input.title ? { title: input.title } : {}),
          ...(input.body ? { body: input.body } : {}),
        },
        user,
        role,
      );
      if (input.status) {
        await this.storylinesService.setBeatStatus(input.beatId, { status: input.status }, user, role);
      }
    } else if (this.storylinesService && input.title) {
      let arcId = input.arcId;
      if (!arcId) {
        const arcs = await this.storylinesService.listArcs(row.campaignId);
        arcId = arcs[0]?.id;
      }
      if (arcId) {
        await this.storylinesService.addBeat(
          arcId,
          {
            title: input.title,
            body: input.body ?? `Resolved in encounter #${encounterId}`,
            status: input.status ?? 'done',
          },
          user,
          role,
        );
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.aftermath_update_beat',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: row.campaignId,
      detail: JSON.stringify(input),
    });

    return this.getAftermath(encounterId, role);
  }

  async addAftermathTimelineEvent(
    encounterId: number,
    input: EncounterAftermathTimelineEventInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterAftermath> {
    const row = await this.getRowOrThrow(encounterId);
    if (row.status !== 'ended') {
      throw new BadRequestException('Aftermath timeline events can only be added for ended encounters');
    }

    if (this.timelineService) {
      await this.timelineService.createEvent(
        row.campaignId,
        {
          title: input.title,
          body: input.description ?? `Encounter #${encounterId} concluded.`,
          inWorldDate: input.inGameDate ?? '',
          era: input.era ?? '',
          sortIndex: input.sortIndex ?? 0,
        },
        user,
        role,
      );
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.aftermath_add_timeline_event',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: row.campaignId,
      detail: JSON.stringify(input),
    });

    return this.getAftermath(encounterId, role);
  }

  /**
   * Defer the aftermath panel (issue #473). Idempotent — a second call is a no-op.
   * Cleared automatically when the encounter is reopened.
   */
  async dismissAftermath(encounterId: number, user: RequestUser, role: Role): Promise<{ dismissedAt: string }> {
    const row = await this.getRowOrThrow(encounterId);
    if (row.status !== 'ended') {
      throw new BadRequestException('Aftermath can only be dismissed for ended encounters');
    }
    if (row.aftermathDismissedAt) {
      return { dismissedAt: row.aftermathDismissedAt };
    }
    const ts = nowIso();
    await this.db.update(encounters).set({ aftermathDismissedAt: ts, updatedAt: ts }).where(eq(encounters.id, encounterId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.aftermath_dismiss',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: row.campaignId,
      detail: 'deferred post-encounter aftermath',
    });
    return { dismissedAt: ts };
  }

  /**
   * Resolve the party's PC levels for a generation (issue #304): the explicit `party`
   * override when given, otherwise the campaign's ACTIVE characters' sheet levels (issue
   * #115 — dead/retired PCs don't set the budget). Empty when a fresh campaign has no PCs,
   * which the generator handles (it can only produce `trivial` against an empty party).
   */
  private async resolvePartyLevels(campaignId: number, explicit?: number[]): Promise<number[]> {
    if (explicit && explicit.length > 0) return explicit;
    const rows = await this.db
      .select({ level: characters.level })
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), eq(characters.status, 'active'), notDeleted(characters.deletedAt)));
    return rows.map((r) => r.level);
  }

  /**
   * Load the compendium monsters a generation may pick from (issue #304), scored for the
   * 5e budget math. Reads rule_entries of type 'monster' (installed packs only — that's all
   * rule_entries ever contains), and also type 'hazard' when `filters.includeHazards` is set,
   * maps each statblock via the campaign's RuleSystemAdapter (#70) to a CR/HP, computes
   * per-monster XP from the #58 CR→XP table, and applies the optional creature-type /
   * environment / CR-range / pack filters. Never persists.
   */
  private async loadMonsterCandidates(
    adapter: RuleSystemAdapter,
    filters: EncounterGenerateInput['filters'],
    campaignId: number,
  ): Promise<GeneratorCandidate[]> {
    // Optional single-pack scoping: resolve the slug to a pack id, or short-circuit to no
    // candidates if the slug isn't installed (mirrors RulesService.search's pack filter).
    let packId: number | undefined;
    if (filters?.packSlug) {
      const [pack] = await this.db.select({ id: rulePacks.id }).from(rulePacks).where(eq(rulePacks.slug, filters.packSlug)).limit(1);
      if (!pack) return [];
      packId = pack.id;
    }

    const allowedTypes = filters?.includeHazards ? ['monster', 'hazard'] as const : ['monster'] as const;
    const typeWhere = inArray(ruleEntries.type, [...allowedTypes]);
    // Issue #1927: campaign homebrew (a rule_entries row with a non-null campaignId) is now a
    // candidate alongside globally installed pack entries, using the same
    // or(isNull(campaignId), eq(campaignId, ...)) idiom already used at commit/defenses/
    // difficulty/add-combatant/aftermath — plus isNull(archivedAt) so soft-archived homebrew
    // never generates. `packSlug` (below) narrows ONLY the global half: homebrew rows always
    // live under a dedicated internal pack id (RulesService.homebrewPackId()), never under a
    // real installed pack's id, so an explicit pack filter naturally excludes homebrew without
    // extra logic — packSlug stays pack-only, unchanged from before this issue.
    const where =
      packId !== undefined
        ? and(typeWhere, isNull(ruleEntries.campaignId), eq(ruleEntries.packId, packId))
        : and(typeWhere, or(isNull(ruleEntries.campaignId), and(eq(ruleEntries.campaignId, campaignId), isNull(ruleEntries.archivedAt))));
    const rows = await this.db
      .select({ id: ruleEntries.id, name: ruleEntries.name, type: ruleEntries.type, dataJson: ruleEntries.dataJson, campaignId: ruleEntries.campaignId })
      .from(ruleEntries)
      .where(where);

    const typeNeedle = filters?.creatureType?.trim().toLowerCase();
    const envNeedle = filters?.environment?.trim().toLowerCase();

    const candidates: GeneratorCandidate[] = [];
    for (const row of rows) {
      const data = fromJsonText<Record<string, unknown>>(row.dataJson, {});
      const mapped = adapter.mapStatblock(data);
      const cr = parseCr(mapped.challengeRating);

      // CR-range filter: a monster with an unparseable CR is excluded when either bound is set.
      if (filters?.minCr !== undefined || filters?.maxCr !== undefined) {
        if (cr === null) continue;
        if (filters.minCr !== undefined && cr < filters.minCr) continue;
        if (filters.maxCr !== undefined && cr > filters.maxCr) continue;
      }
      // Creature-type substring filter (e.g. "undead", "dragon").
      if (typeNeedle) {
        const t = typeof mapped.creatureType === 'string' ? mapped.creatureType.toLowerCase() : '';
        if (!t.includes(typeNeedle)) continue;
      }
      // Environment substring filter — best-effort over the raw statblock's environments,
      // which the canonical MonsterStatblockData doesn't carry (Open5e ships `environments`).
      if (envNeedle) {
        const raw = (data.environments ?? data.environment) as unknown;
        const envs = Array.isArray(raw) ? raw.map((e) => String(e).toLowerCase()) : typeof raw === 'string' ? [raw.toLowerCase()] : [];
        if (!envs.some((e) => e.includes(envNeedle))) continue;
      }

      candidates.push({
        ruleEntryId: row.id,
        name: row.name,
        entryType: row.type === 'hazard' ? 'hazard' : 'monster',
        cr,
        xp: typeof data.xp === 'number' && data.xp > 0 ? data.xp : typeof data.experience === 'number' && data.experience > 0 ? data.experience : crToXp(cr),
        hpMax: adapter.monsterHitPoints(data),
        source: row.campaignId != null ? 'homebrew' : 'pack',
      });
    }
    return candidates;
  }

  /**
   * Generate (but do NOT persist) a balanced monster group for a party + target difficulty
   * (issue #304). Read-only "suggestion": assembles a group from the installed compendium
   * to hit the requested #58 band, deterministic by `seed`. Any campaign member (or AI) may
   * preview — committing is the separate create write path (create + addCombatant), so
   * write-mode (#158)/proposals (#124)/secrecy (#262) all apply there, not here.
   *
   * `viewerRole` is accepted for parity with the other reads but a suggestion is derived
   * data over the shared compendium — there's no hidden per-encounter row to redact yet
   * (the encounter doesn't exist until commit).
   */
  async generateEncounter(campaignId: number, input: EncounterGenerateInput, _viewerRole?: Role): Promise<EncounterSuggestion> {
    // Issue #1928 review (Copilot #1981): fetch the campaign's ruleSystem slug ONCE and derive
    // the adapter from it locally — `ruleSystemAdapter` is pure — rather than calling both
    // `adapterForCampaign` (which re-reads `campaigns.ruleSystem` itself) and
    // `ruleSystemForCampaign`, which would run the same SELECT twice on this hot path.
    const { ruleSystem, customMechanicsProfile } = await this.ruleSystemForCampaign(campaignId);
    const adapter = ruleSystemAdapter(ruleSystem, customMechanicsProfile);
    const partyLevels = await this.resolvePartyLevels(campaignId, input.party);
    const candidates = await this.loadMonsterCandidates(adapter, input.filters, campaignId);

    // Mint a seed when the caller didn't supply one, so the result is reproducible: the
    // returned seed round-trips back through `seed` to rebuild the identical group.
    const seed = input.seed ?? Math.floor(Math.random() * 0xffffffff);
    const maxCount = input.count ?? 12;

    // The 5e-shaped budget math still SELECTS the roster (issue #1928 is about honesty of
    // the REPORTED band, not a new selection heuristic — a non-5e system has no other budget
    // math to size a roster with, so `difficulty` target param stays accepted as a heuristic).
    const result = generateEncounterGroup({
      partyLevels,
      targetBand: input.difficulty,
      candidates,
      shape: input.shape,
      maxCount,
      seed,
    });

    // Issue #1928: report difficulty exactly like preview does — the adapter-owned estimate,
    // not the raw 5e math the selection heuristic used internally. A non-5e campaign gets an
    // explicit `unsupported` status here instead of a confident 5e band presented as fact.
    const reported = estimateEncounterDifficultyForRuleSystem(ruleSystem, {
      partyLevels,
      monsterChallengeRatings: result.picks.flatMap((p) => Array.from({ length: p.count }, () => p.cr)),
    });

    return {
      combatants: result.picks.map((p) => ({
        ruleEntryId: p.ruleEntryId,
        name: p.name,
        entryType: p.entryType ?? 'monster',
        cr: p.cr,
        xp: p.xp,
        hpMax: p.hpMax,
        count: p.count,
        source: p.source ?? 'pack',
      })),
      targetBand: input.difficulty,
      difficulty: reported,
      // Codex review (#1981): `reported.adjustedXp` is 0 for an `unsupported` status
      // (unsupportedEncounterDifficulty always zeroes it) — reporting that as `totalXp` would
      // be a FALSE zero sitting next to positive per-combatant `xp` values in the same payload,
      // not an honest absence. `result.difficulty` is the selection heuristic's OWN adjusted-XP
      // total (real and positive for a non-empty roster on every system, since it is what
      // actually sized this roster) — byte-identical to `reported.adjustedXp` for 5e/empty-slug
      // (same formula, same inputs), and the pre-#1928 value for every system. `difficulty` /
      // `difficultySupport` still honestly flag a non-5e total as heuristic; `totalXp` itself
      // must never contradict the positive `combatants[].xp` beside it.
      totalXp: result.difficulty.adjustedXp,
      shape: result.shape,
      seed: result.seed,
      matchedBand: result.matchedBand,
      difficultySupport: encounterDifficultySupported(ruleSystem) ? 'supported' : 'heuristic',
    };
  }

  /**
   * Convenience commit path for POST .../generate?commit=true (issue #304): run the
   * read-only generator, then persist the suggestion as a real encounter through the normal
   * write path — create() (auto-adds the party) followed by addCombatant() per monster line
   * (each with its `count`). The caller (controller) has already passed the dm + write-mode
   * guard, so this stays behind the same authz as any other encounter write. Created hidden
   * (DM-only prep, #262) and `preparing` by default, so nothing leaks to players pre-spring.
   * Returns the created encounter with its combatants plus the suggestion that seeded it.
   */
  async generateAndCreateEncounter(
    campaignId: number,
    input: EncounterGenerateInput,
    user: RequestUser,
    role: Role,
  ): Promise<{ encounter: EncounterWithCombatants; suggestion: EncounterSuggestion }> {
    const suggestion = await this.generateEncounter(campaignId, input, role);

    const name = input.name ?? `Generated ${input.difficulty} encounter`;
    const encounter = await this.create(
      campaignId,
      {
        name,
        locationId: input.locationId ?? undefined,
        questId: input.questId ?? undefined,
        // Default hidden (DM prep, #262/#754) unless the caller explicitly opts out.
        hidden: resolveCreateHidden(input.hidden),
      },
      user,
      role,
    );

    for (const line of suggestion.combatants) {
      await this.addCombatant(encounter.id, { kind: 'monster', ruleEntryId: line.ruleEntryId, count: line.count }, user, role);
    }

    const withCombatants = await this.getWithCombatantsOrThrow(encounter.id, role);
    return { encounter: withCombatants, suggestion };
  }

  // ---------------------------------------------------------------------------
  // Preview-and-tune wizard (issue #412).
  //
  // A NON-MUTATING, interactive layer over the #304 generator: a multi-slot roster with
  // per-creature inspection + a difficulty EXPLANATION + actionable warnings, deterministic
  // tune ops (reroll all / reroll one slot / swap / adjust count / pin), and an idempotent
  // atomic commit. The pure roster/tune/warning math lives in encounters.logic.ts; the service
  // supplies candidates from the compendium, resolves statblocks, and owns persistence.
  // ---------------------------------------------------------------------------

  /**
   * Look up a campaign's rule system slug (for adapter-owned difficulty + support status)
   * alongside its persisted homebrew mechanics profile (issue #1502), in the one SELECT.
   */
  private async ruleSystemForCampaign(
    campaignId: number,
  ): Promise<{ ruleSystem: string | null; customMechanicsProfile: HomebrewMechanicsProfile | null }> {
    const [row] = await this.db
      .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    return {
      ruleSystem: row?.ruleSystem ?? null,
      customMechanicsProfile: fromJsonText<HomebrewMechanicsProfile | null>(row?.customMechanicsProfile, null),
    };
  }

  /**
   * Build the per-creature inspection card (issue #412): AC/HP/actions/saves/traits lifted from
   * a compendium statblock via the campaign adapter's mapping (#70). Every field is best-effort
   * and null-safe — a partial/manual statblock simply omits what it lacks (surfaced as a
   * missing-statblock warning), never fabricated.
   */
  private buildCreatureInspection(
    adapter: RuleSystemAdapter,
    data: Record<string, unknown>,
    cr: number | null,
    xp: number,
    resolvedHpMax: number | null,
  ): EncounterCreatureInspection {
    const mapped = adapter.mapStatblock(data);
    const toStr = (v: unknown, maxLen = 200): string | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string') return v.slice(0, maxLen);
      if (typeof v === 'number') return String(v).slice(0, maxLen);
      if (typeof v === 'object') {
        const val = (v as Record<string, unknown>).value ?? (v as Record<string, unknown>).ft ?? null;
        return val !== null ? String(val).slice(0, maxLen) : null;
      }
      return null;
    };
    const toInt = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
      if (typeof v === 'object' && v !== null) {
        const val = (v as Record<string, unknown>).value;
        if (typeof val === 'number' && Number.isFinite(val)) return Math.round(val);
      }
      if (typeof v === 'string') {
        const m = /-?\d+/.exec(v);
        if (m) return Number(m[0]);
      }
      return null;
    };
    // Actions/traits/reactions: open5e ships arrays of { name, desc }. Normalize + bound.
    const normEntries = (raw: unknown): Array<{ name: string; text: string }> => {
      if (!Array.isArray(raw)) return [];
      const out: Array<{ name: string; text: string }> = [];
      for (const item of raw) {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const name = typeof o.name === 'string' ? o.name : '';
          const text = typeof o.desc === 'string' ? o.desc : typeof o.text === 'string' ? o.text : typeof o.description === 'string' ? o.description : '';
          if (name || text) out.push({ name: name.slice(0, 120), text: String(text).slice(0, 1200) });
        }
        if (out.length >= 50) break;
      }
      return out;
    };
    // Ability scores as the statblock lists them.
    const abilities: Array<{ name: string; value: string }> = [];
    if (mapped.abilityScores && typeof mapped.abilityScores === 'object') {
      for (const [k, v] of Object.entries(mapped.abilityScores)) {
        const s = toStr(v);
        if (s !== null) abilities.push({ name: k.slice(0, 40), value: s.slice(0, 20) });
        if (abilities.length >= 24) break;
      }
    }
    // Saving throws: an explicit map, or open5e's per-ability `*_save` fields.
    const savingThrows: Array<{ name: string; value: string }> = [];
    const rawSaves = (data.savingThrows ?? data.saving_throws) as unknown;
    if (rawSaves && typeof rawSaves === 'object' && !Array.isArray(rawSaves)) {
      for (const [k, v] of Object.entries(rawSaves as Record<string, unknown>)) {
        const s = toStr(v);
        if (s !== null) savingThrows.push({ name: k.slice(0, 40), value: s.slice(0, 20) });
      }
    } else {
      for (const [k, v] of Object.entries(data)) {
        if (/_save$/i.test(k) && (typeof v === 'number' || typeof v === 'string')) {
          savingThrows.push({ name: k.replace(/_save$/i, '').slice(0, 40), value: String(v).slice(0, 20) });
        }
        if (savingThrows.length >= 24) break;
      }
    }
    const actions = [...normEntries(mapped.actions), ...normEntries(mapped.legendaryActions), ...normEntries(mapped.reactions)].slice(0, 50);
    const hp = resolvedHpMax ?? adapter.monsterHitPoints(data);
    return {
      hasStatblock: hp !== null || cr !== null || actions.length > 0 || abilities.length > 0,
      size: toStr(mapped.size, 60),
      creatureType: toStr(mapped.creatureType, 120),
      armorClass: toInt(mapped.armorClass),
      hitPointsMax: hp,
      hitPointsText: toStr((data.hit_dice ?? data.hitDice ?? null) as unknown, 80),
      speed: toStr(mapped.speed),
      challengeRating: cr,
      xp,
      abilities,
      savingThrows,
      traits: normEntries(mapped.specialAbilities),
      actions,
    };
  }

  /**
   * NON-MUTATING preview-and-tune of a generated encounter (issue #412). With just a target
   * `difficulty` it generates a fresh roster; passing back `roster` (the plan) + a `tune` op
   * applies a deterministic tuning step (reroll all / reroll one slot / swap / adjust count /
   * pin / add / remove). Returns the resolved multi-slot roster with per-creature inspection,
   * the adapter-owned difficulty + a human-readable explanation, actionable warnings, and
   * actionable fallbacks when the compendium is empty or the system lacks budget math. Persists
   * NOTHING — any member (or AI) may preview; committing is the separate write path.
   */
  async previewEncounter(campaignId: number, input: EncounterPreviewInput, _viewerRole?: Role): Promise<EncounterPreview> {
    // #1502: resolve through the campaign's persisted homebrew profile, not the slug alone.
    // main added this call site while this branch was converting every adapter lookup to the
    // profile-aware path; a slug-only `ruleSystemAdapter` here would silently give a homebrew
    // campaign 5e's monster/difficulty maths for generated encounters.
    const adapter = await this.adapterForCampaign(campaignId);
    const { ruleSystem } = await this.ruleSystemForCampaign(campaignId);
    const partyLevels = await this.resolvePartyLevels(campaignId, input.party);
    const candidates = await this.loadMonsterCandidates(adapter, input.filters, campaignId);
    const seed = input.seed ?? Math.floor(Math.random() * 0xffffffff);
    const maxCount = input.count ?? 12;

    const plan: RosterSlotPlan[] | undefined = input.roster?.map((s) => ({
      slotId: s.slotId,
      ruleEntryId: s.ruleEntryId,
      count: s.count,
      pinned: s.pinned ?? false,
      seed: s.seed,
    }));

    const result = buildEncounterRoster({
      partyLevels,
      targetBand: input.difficulty,
      candidates,
      maxCount,
      shape: input.shape,
      seed,
      plan,
      tune: input.tune as RosterTuneOp | undefined,
    });

    // Adapter-owned reported difficulty (issue #429): an unsupported system yields an explicit
    // unsupported explanation instead of the 5e band the generator internally targeted.
    const reported = estimateEncounterDifficultyForRuleSystem(ruleSystem, {
      partyLevels,
      monsterChallengeRatings: result.picks.flatMap((p) => Array.from({ length: p.count }, () => p.cr)),
    });
    const explanation = buildDifficultyExplanation(reported);
    const warnings = deriveEncounterRosterWarnings(result.picks, partyLevels, reported, result.matchedBand, input.difficulty);

    // Resolve statblocks for the picked creatures (one query) to build inspection cards.
    const pickedIds = [...new Set(result.picks.map((p) => p.ruleEntryId))];
    const dataById = new Map<number, Record<string, unknown>>();
    if (pickedIds.length > 0) {
      // Issue #1927: picks may now include the campaign's own homebrew, so this must resolve
      // statblocks for BOTH scopes (same widen as loadMonsterCandidates above), not just global
      // pack entries — otherwise a homebrew pick's inspection card would silently come back empty.
      const rows = await this.db
        .select({ id: ruleEntries.id, dataJson: ruleEntries.dataJson })
        .from(ruleEntries)
        .where(and(inArray(ruleEntries.id, pickedIds), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, campaignId))));
      for (const r of rows) dataById.set(r.id, fromJsonText<Record<string, unknown>>(r.dataJson, {}));
    }

    const roster: EncounterRosterSlot[] = result.plan.map((slotPlan) => {
      const pick = result.picks.find((p) => p.ruleEntryId === slotPlan.ruleEntryId && p.count === slotPlan.count) ??
        result.picks.find((p) => p.ruleEntryId === slotPlan.ruleEntryId);
      const cr = pick?.cr ?? null;
      const xp = pick?.xp ?? 0;
      const hpMax = pick?.hpMax ?? null;
      const data = dataById.get(slotPlan.ruleEntryId) ?? {};
      return {
        slotId: slotPlan.slotId,
        ruleEntryId: slotPlan.ruleEntryId,
        name: pick?.name || `Rule entry ${slotPlan.ruleEntryId}`,
        entryType: pick?.entryType ?? 'monster',
        cr,
        xp,
        hpMax,
        count: slotPlan.count,
        pinned: slotPlan.pinned,
        seed: slotPlan.seed,
        inspection: this.buildCreatureInspection(adapter, data, cr, xp, hpMax),
        source: pick?.source ?? 'pack',
      };
    });

    const fallbacks = this.buildPreviewFallbacks(candidates.length, reported.status, ruleSystem, partyLevels);

    return {
      roster,
      plan: result.plan.map((s) => ({ slotId: s.slotId, ruleEntryId: s.ruleEntryId, count: s.count, pinned: s.pinned, seed: s.seed })),
      targetBand: input.difficulty,
      difficulty: reported,
      explanation,
      // Codex review (#1981, generateEncounter): same fix applies here — `reported.adjustedXp`
      // is always 0 when `status:'unsupported'`, which would contradict the positive
      // per-slot `xp` values in `roster` for a non-5e system. `result.difficulty` is the
      // roster-selection heuristic's own adjusted-XP total (byte-identical to
      // `reported.adjustedXp` for 5e/empty-slug, real and positive for a non-empty roster on
      // every system). This also corrects the SAME pre-existing zeroing in `previewEncounter`
      // (predates #1928 — `reported.adjustedXp` was already used here), not just the copy
      // #1928 introduced in `generateEncounter`.
      totalXp: result.difficulty.adjustedXp,
      shape: result.shape,
      seed: result.seed,
      matchedBand: result.matchedBand,
      party: partyLevels,
      warnings,
      fallbacks,
      difficultySupport: encounterDifficultySupported(ruleSystem) ? 'supported' : 'heuristic',
    };
  }

  /** Actionable guidance when the compendium is empty or the system can't score difficulty (issue #412). */
  private buildPreviewFallbacks(candidateCount: number, status: EncounterDifficulty['status'], ruleSystem: string | null, partyLevels: number[]): string[] {
    const out: string[] = [];
    if (candidateCount === 0) {
      out.push(
        'No monsters are installed for this campaign. Install a rule pack (Rules → Browse packs, e.g. the SRD monster pack) or import monsters, then regenerate. You can still create an empty encounter and add combatants manually.',
      );
    }
    if (status === 'unsupported') {
      out.push(
        `${ruleSystem ?? 'This rule system'} has no built-in XP/CR encounter budget, so difficulty can't be estimated. The roster is still valid — commit it and judge the balance yourself, or switch the campaign to a supported system for automatic difficulty.`,
      );
    }
    if (partyLevels.length === 0) {
      out.push('No active party members were found, so difficulty is measured against an empty party. Add characters to the campaign, or pass explicit party levels, for an accurate estimate.');
    }
    return out;
  }

  /**
   * IDEMPOTENT, atomic commit of a tuned roster to a real encounter (issue #412). The whole
   * write — encounter row + auto-added party + generated monster combatants + optional
   * location/quest/session links + optional battle map/grid + optional token placement — lands
   * in ONE transaction, so a mid-commit failure never leaves a partial encounter or orphaned
   * combatants. `idempotencyKey` makes a retry a no-op that returns the SAME encounter (never a
   * duplicate). Created hidden + `preparing` by default (DM prep, #262). Audits source, inputs,
   * roster, and any manual edits.
   */
  async commitGeneratedEncounter(
    campaignId: number,
    input: EncounterCommitInput,
    user: RequestUser,
    role: Role,
  ): Promise<{ encounter: EncounterWithCombatants; idempotent: boolean }> {
    const idemKey = `${campaignId}:${input.idempotencyKey}`;

    // Fast path: a completed commit with this key returns the same encounter (if it still exists).
    const existingId = this.commitIdempotency.get(idemKey);
    if (existingId !== undefined) {
      const row = await this.db.select({ id: encounters.id }).from(encounters).where(and(eq(encounters.id, existingId), eq(encounters.campaignId, campaignId))).limit(1);
      if (row.length > 0) {
        return { encounter: await this.getWithCombatantsOrThrow(existingId, role), idempotent: true };
      }
      // The keyed encounter was deleted — drop the stale mapping and re-commit fresh.
      this.commitIdempotency.delete(idemKey);
    }
    // Coalesce a concurrent in-flight retry onto the same promise.
    const inFlight = this.commitInFlight.get(idemKey);
    if (inFlight) {
      return { encounter: await inFlight, idempotent: true };
    }

    const run = this.doCommitGeneratedEncounter(campaignId, idemKey, input, user, role);
    this.commitInFlight.set(idemKey, run);
    try {
      const encounter = await run;
      return { encounter, idempotent: false };
    } finally {
      this.commitInFlight.delete(idemKey);
    }
  }

  private async doCommitGeneratedEncounter(
    campaignId: number,
    idemKey: string,
    input: EncounterCommitInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterWithCombatants> {
    // ---- validate everything BEFORE the transaction (no partial writes) ----
    if (input.locationId != null) await this.assertEntityInCampaign('location', input.locationId, campaignId);
    if (input.questId != null) await this.assertEntityInCampaign('quest', input.questId, campaignId);
    if (input.sessionId != null) await this.assertEntityInCampaign('session', input.sessionId, campaignId);

    const adapter = await this.adapterForCampaign(campaignId);

    // Resolve each roster slot's statblock -> name/hp/initMod (outside the tx).
    const slotIds = [...new Set(input.roster.map((s) => s.ruleEntryId))];
    const entryRows = await this.db.select().from(ruleEntries).where(and(inArray(ruleEntries.id, slotIds), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, campaignId))));
    const entryById = new Map(entryRows.map((r) => [r.id, r]));
    for (const s of input.roster) {
      if (!entryById.has(s.ruleEntryId)) {
        throw new BadRequestException(`Rule entry ${s.ruleEntryId} not found — refresh the preview before committing.`);
      }
    }

    interface ResolvedMonster {
      slotId: string;
      name: string;
      hpMax: number;
      initMod: number;
      initiativeBreakdown: CombatantInitiativeBreakdown;
      ruleEntryId: number;
      count: number;
    }
    const resolvedMonsters: ResolvedMonster[] = input.roster.map((s) => {
      const entry = entryById.get(s.ruleEntryId)!;
      const data = fromJsonText<Record<string, unknown>>(entry.dataJson, {});
      const mapped = adapter.mapStatblock(data);
      const hp = adapter.monsterHitPoints(data) ?? 0;
      let initMod = 0;
      if (adapter.initiativeModifierOrNull) {
        const resolved = adapter.initiativeModifierOrNull(mapped.abilityScores, mapped.abilityRepresentation);
        initMod = resolved ?? 0;
      } else {
        initMod = adapter.initiativeModifier(mapped.abilityScores, mapped.abilityRepresentation);
      }
      const initiativeBreakdown = monsterInitiativeBreakdown(adapter, data, initMod);
      initMod = initiativeBreakdown.modifier;
      return { slotId: s.slotId, name: entry.name, hpMax: hp, initMod, initiativeBreakdown, ruleEntryId: s.ruleEntryId, count: s.count };
    });

    // Optional battle map: validate the attachment belongs to this campaign and is an image/map.
    let mapAttachmentId: number | null = null;
    if (input.map) {
      const [att] = await this.db
        .select({ id: attachments.id, campaignId: attachments.campaignId, kind: attachments.kind })
        .from(attachments)
        .where(and(eq(attachments.id, input.map.mapAttachmentId), eq(attachments.campaignId, campaignId)))
        .limit(1);
      if (!att) throw new BadRequestException(`Map attachment ${input.map.mapAttachmentId} not found in this campaign.`);
      if (att.kind !== 'map' && att.kind !== 'image') {
        throw new BadRequestException(`Attachment ${input.map.mapAttachmentId} is not a map/image.`);
      }
      mapAttachmentId = att.id;
    }

    // Party auto-add (same policy as create(): active PCs only).
    const partyRows = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), eq(characters.status, 'active'), notDeleted(characters.deletedAt)));

    const tokenBySlot = new Map((input.tokens ?? []).map((t) => [t.slotId, t]));
    const ts = nowIso();
    const hidden = resolveCreateHidden(input.hidden);

    // ---- ONE atomic transaction: encounter + party + monsters + map/grid + tokens ----
    const encounterRow = this.db.transaction((tx) => {
      const [row] = tx
        .insert(encounters)
        .values({
          campaignId,
          name: input.name ?? `Generated ${input.targetBand ?? ''} encounter`.trim(),
          status: 'preparing',
          round: 0,
          turnIndex: 0,
          locationId: input.locationId ?? null,
          questId: input.questId ?? null,
          sessionId: input.sessionId ?? null,
          mapAttachmentId,
          gridSize: input.map?.gridSize ?? null,
          gridScale: input.map?.gridScale ?? null,
          gridUnit: input.map?.gridUnit ?? null,
          gridType: input.map?.gridType ?? 'square',
          hidden,
          endedAt: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();

      let sortOrder = 0;
      // Party combatants first (mirrors create()).
      if (partyRows.length > 0) {
        const partyValues = partyRows.map((character) => {
          const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
          const init = characterInitiativeBreakdown(adapter, stats, character.level);
          return {
            encounterId: row.id,
            kind: 'character' as const,
            characterId: character.id,
            name: character.name,
            initiative: null,
            initMod: init.modifier,
            initiativeBreakdown: toJsonText(init),
            hpCurrent: character.hpCurrent,
            hpMax: character.hpMax,
            hpTemp: character.hpTemp,
            deathState: character.deathState,
            deathSaveSuccesses: character.deathSaveSuccesses,
            deathSaveFailures: character.deathSaveFailures,
            // Issue #1910: same add-time speed snapshot as addCombatant()/create() —
            // otherwise a party member auto-added by the generator resolves through
            // the character's LIVE speed instead of freezing at fight-start.
            speed: character.speed,
            sheetSyncedUpdatedAt: character.updatedAt,
            // #1047: carry the sheet's structured copy in too. No translation needed —
            // a sheet instance already has the round-scoped fields null, so it enters as an
            // indefinite condition, which is correct.
            ...conditionWriteSetFromInstances(
              readConditionInstances(character.conditionInstances, character.conditions),
            ),
            ruleEntryId: null,
            sortOrder: sortOrder++,
          };
        });
        tx.insert(combatants).values(partyValues).run();
      }

      // Monster combatants: one row per copy, names suffixed "Goblin 1".."Goblin N" for count>1
      // (mirrors addCombatant). Token placement fans copies out horizontally from the base point.
      for (const m of resolvedMonsters) {
        const token = tokenBySlot.get(m.slotId);
        const names = m.count > 1 ? Array.from({ length: m.count }, (_, i) => `${m.name} ${i + 1}`) : [m.name];
        const monsterValues = names.map((n, i) => {
          let tokenX: number | null = null;
          let tokenY: number | null = null;
          if (token) {
            tokenX = clampPercent(token.tokenX + (m.count > 1 ? (i - (m.count - 1) / 2) * 4 : 0));
            tokenY = clampPercent(token.tokenY);
          }
          return {
            encounterId: row.id,
            kind: 'monster' as const,
            characterId: null,
            npcId: null,
            name: n,
            initiative: null,
            initMod: m.initMod,
            initiativeBreakdown: toJsonText(m.initiativeBreakdown),
            hpCurrent: m.hpMax,
            hpMax: m.hpMax,
            conditions: '[]',
            ruleEntryId: m.ruleEntryId,
            tokenX,
            tokenY,
            sortOrder: sortOrder++,
          };
        });
        tx.insert(combatants).values(monsterValues).run();
      }
      return row;
    });

    // Record idempotency AFTER the tx commits.
    this.commitIdempotency.set(idemKey, encounterRow.id);

    const monsterTotal = resolvedMonsters.reduce((n, m) => n + m.count, 0);
    const rosterSummary = resolvedMonsters.map((m) => `${m.name}×${m.count}`).join(', ');
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.generate.commit',
      entityType: 'encounter',
      entityId: encounterRow.id,
      campaignId,
      detail: [
        `source=${input.source ?? 'wizard'}`,
        `target=${input.targetBand ?? 'n/a'}`,
        `party=[${input.party?.length ? input.party.join(',') : 'active'}]`,
        `roster=${rosterSummary || 'none'} (${monsterTotal} monster(s), ${partyRows.length} PC(s))`,
        mapAttachmentId ? `map=${mapAttachmentId}` : null,
        input.manualEdits && input.manualEdits.length > 0 ? `manualEdits=${input.manualEdits.join('; ')}` : null,
      ]
        .filter(Boolean)
        .join(' | '),
    });

    this.emitEncounterEvent('encounter.updated', campaignId, encounterRow.id, encounterRow.hidden);
    return this.getWithCombatantsOrThrow(encounterRow.id, role);
  }

  /**
   * Compact per-encounter digest for the campaign summary (issue #126) — enough for an
   * AI recap to see combat happened, where/why/when it was pinned, and a down tally,
   * without loading full combatant rows. One encounters query plus one grouped-count
   * query over combatants, both scoped to the campaign.
   *
   * Issue #625: the tally is split by kind — `downCount` counts only PCs/NPCs who fell
   * (0 HP / dead) and `monstersDefeated` counts dead monsters, so a glance at the summary
   * reflects fallen party members rather than every corpse on the field.
   */
  async digestForCampaign(campaignId: number, viewerRole?: Role): Promise<EncounterDigest[]> {
    const allRows = await this.db.select().from(encounters).where(eq(encounters.campaignId, campaignId));
    // Entity-level secrecy (issue #262): drop hidden encounters from a non-DM's campaign
    // summary, mirroring how quests/npcs are role-filtered in CampaignsService.summary.
    const rows = viewerRole === undefined || viewerRole === 'dm' ? allRows : allRows.filter((r) => !r.hidden);
    if (rows.length === 0) return [];

    const encounterIds = rows.map((r) => r.id);
    // Issue #625: split the down tally by kind. `downCount` reports only PCs/NPCs who
    // fell (the meaningful "who's down" glance); `monstersDefeated` reports dead monsters
    // separately so a pile of goblin corpses no longer inflates the party's casualties.
    const tally = await this.db
      .select({
        encounterId: combatants.encounterId,
        total: sql<number>`COUNT(*)`,
        down: sql<number>`SUM(CASE WHEN ${combatants.kind} != 'monster' AND (${combatants.hpCurrent} <= 0 OR ${combatants.deathState} = 'dead') THEN 1 ELSE 0 END)`,
        monstersDefeated: sql<number>`SUM(CASE WHEN ${combatants.kind} = 'monster' AND (${combatants.hpCurrent} <= 0 OR ${combatants.deathState} = 'dead') THEN 1 ELSE 0 END)`,
      })
      .from(combatants)
      .where(inArray(combatants.encounterId, encounterIds))
      .groupBy(combatants.encounterId);
    const tallyById = new Map(
      tally.map((t) => [t.encounterId, { total: Number(t.total), down: Number(t.down), monstersDefeated: Number(t.monstersDefeated) }]),
    );

    const digests: EncounterDigest[] = rows.map((r) => {
      const t = tallyById.get(r.id) ?? { total: 0, down: 0, monstersDefeated: 0 };
      return {
        id: r.id,
        name: r.name,
        status: r.status as EncounterStatus,
        round: r.round,
        endedAt: r.endedAt,
        locationId: r.locationId,
        questId: r.questId,
        sessionId: r.sessionId,
        combatantCount: t.total,
        downCount: t.down,
        monstersDefeated: t.monstersDefeated,
      };
    });
    const redacted = await this.redactHiddenLinkedEntities(digests, campaignId, viewerRole);
    return this.attachEncounterLinkMeta(redacted, campaignId);
  }

  /**
   * Adds a combatant. Resolution order for name/hp/initMod when not explicitly given:
   *  - kind='character' + characterId -> pull from the character row
   *  - kind='monster' + ruleEntryId -> try name + hit points from rule_entries.dataJson,
   *    falling back to whatever the caller explicitly provided
   *  - otherwise the caller must provide name + hpMax directly
   * Throws 400 if, after resolution, we still don't have a name or an hpMax.
   */
  async addCombatant(encounterId: number, input: CombatantCreateInput, user: RequestUser, role: Role): Promise<Combatant> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);

    let name = input.name;
    let hpMax = input.hpMax;
    let initMod = input.initMod ?? 0;
    let initBreakdown = manualInitiativeBreakdown(adapter, initMod);
    const initModel = initiativeModelForAdapter(adapter);
    let initiativeGroup =
      input.initiativeGroup !== undefined
        ? input.initiativeGroup
        : initModel.mode === 'group'
          ? input.kind === 'character' || input.kind === 'npc'
            ? 'party'
            : 'monsters'
          : null;
    let hpCurrent: number | undefined;
    // Issue #711: the persistent death/temp-HP slice a character carries into
    // combat. Only populated on the kind='character' branch (monsters/NPCs start
    // alive + temp-less); threaded into the INSERT below so a stable/dying PC
    // late-joining a fight doesn't get silently revived.
    let characterHpTemp = 0;
    let characterDeathState = 'none';
    let characterDeathSaveSuccesses = 0;
    let characterDeathSaveFailures = 0;
    let characterSheetUpdatedAt: string | null = null;
    // Issue #486: sheet conditions carried into a late-join character combatant.
    let characterConditions = '[]';
    let characterConditionInstances: string | null = null;
    // NOT pre-seeded from input.ruleEntryId — only set once the row is confirmed to exist
    // below, so a dangling id can never make it into the INSERT (was previously assigned
    // unconditionally here, so a bogus/deleted ruleEntryId silently got stored).
    let ruleEntryId: number | null = null;
    let characterId: number | null = null;
    let npcId: number | null = null;
    let npcIdentitySourceId: number | null = null;
    let npcDispositionSnapshot: string | null = null;
    let spCurrent = 0;
    let spMax = 0;
    let rpCurrent = 0;
    let rpMax = 0;
    let eac: number | null = null;
    let kac: number | null = null;
    // Issue #1910: add-time snapshot of the linked character's speed, same convention
    // as eac/kac/the HP-model fields below — stays null for monster/npc combatants.
    let speed: number | null = null;
    let statblockJson: string | null = null;
    let tokenSize = input.tokenSize ?? 'medium';
    let duplicateRuleEntryId: number | undefined;
    let duplicateStatblockJson: string | null = null;
    let replacesSourceRuleEntry = false;

    if (input.duplicateOfCombatantId !== undefined) {
      const [source] = await this.db
        .select()
        .from(combatants)
        .where(and(eq(combatants.id, input.duplicateOfCombatantId), eq(combatants.encounterId, encounterId)))
        .limit(1);
      if (!source || (source.kind !== 'monster' && source.kind !== 'npc')) {
        throw new BadRequestException('Duplicate source must be a monster or NPC in this encounter');
      }
      if (input.kind !== source.kind) {
        throw new BadRequestException('Duplicate kind must match its source combatant');
      }
      if (input.npcId !== undefined || input.characterId !== undefined) {
        throw new BadRequestException('Duplicate inputs cannot set a combatant identity');
      }
      name ??= source.name;
      replacesSourceRuleEntry = input.ruleEntryId !== undefined && input.ruleEntryId !== source.ruleEntryId;
      if (!replacesSourceRuleEntry) hpMax ??= source.hpMax ?? undefined;
      if (input.initMod === undefined) {
        initMod = source.initMod;
      }
      const sourceInitBreakdown = parseInitiativeBreakdown(source.initiativeBreakdown);
      if (sourceInitBreakdown) {
        const terms = initiativeTermsForModifier(sourceInitBreakdown, initMod);
        initBreakdown = CombatantInitiativeBreakdown.parse({
          die: adapter.initiativeDie > 0 ? adapter.initiativeDie : 20,
          roll: null,
          modifier: initMod,
          total: null,
          terms,
          formula: initiativeFormula(adapter.initiativeDie > 0 ? adapter.initiativeDie : 20, terms),
        });
      }
      if (input.initiativeGroup === undefined) initiativeGroup = source.initiativeGroup;
      if (input.tokenSize === undefined) tokenSize = source.tokenSize as TokenSize;
      duplicateRuleEntryId = source.ruleEntryId ?? undefined;
      duplicateStatblockJson = source.statblockJson;
      npcIdentitySourceId = source.npcIdentitySourceId ?? source.npcId;
      npcDispositionSnapshot = source.npcDispositionSnapshot;
      // A duplicate starts fresh, but it must retain the source's configured defenses
      // and pool capacities. In particular, manual Starfinder combatants do not have a
      // rule entry from which EAC/KAC, stamina, or resolve can be re-derived.
      eac = source.eac;
      kac = source.kac;
      spMax = source.spMax;
      spCurrent = source.spMax;
      rpMax = source.rpMax;
      rpCurrent = source.rpMax;
    }

    // NPC identity link (kind='npc'): validate the NPC belongs to this campaign and use
    // it as the default name. HP/initiative still come from a linked statblock
    // (ruleEntryId, resolved below) or an explicit hpMax — so an NPC can borrow a monster
    // statblock or be tracked with manual HP. Runs alongside (not instead of) the
    // ruleEntryId branch, so an NPC WITH a statblock resolves both.
    if (input.kind === 'npc' && input.npcId !== undefined) {
      // notDeleted (issue #374): a trashed/soft-deleted NPC must not be addable as a combatant.
      const [npc] = await this.db
        .select()
        .from(npcs)
        .where(and(eq(npcs.id, input.npcId), notDeleted(npcs.deletedAt)))
        .limit(1);
      if (!npc) throw new BadRequestException(`NPC ${input.npcId} not found`);
      if (npc.campaignId !== encounterRow.campaignId) {
        throw new NotFoundException(`NPC ${input.npcId} not found in campaign ${encounterRow.campaignId}`);
      }
      // Uniqueness guard — the issue #51 pattern, extended to NPC combatants per #374: an NPC
      // may appear at most once in an encounter. Without this, re-adding the same NPC forks it
      // into two rows that then track HP independently. 409 rather than a silent duplicate.
      // Carries the existing combatant id (issue #749) so a caller can treat the duplicate as
      // an idempotent re-add; the DB partial unique index (idx_combatants_encounter_npc) is the
      // backstop that catches the TOCTOU race where two adds pass this probe simultaneously.
      const [dup] = await this.db
        .select()
        .from(combatants)
        .where(and(eq(combatants.encounterId, encounterId), eq(combatants.npcId, npc.id)))
        .limit(1);
      if (dup) {
        throw new ConflictException({
          code: 'COMBATANT_IDENTITY_CONFLICT',
          message: `NPC ${npc.id} is already a combatant in encounter ${encounterId}`,
          combatantId: dup.id,
        });
      }
      npcId = npc.id;
      npcDispositionSnapshot = npc.disposition;
      name = name ?? npc.name;
    }

    if (input.kind === 'character' && input.characterId !== undefined) {
      const [character] = await this.db.select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
      if (!character) throw new BadRequestException(`Character ${input.characterId} not found`);
      // A characterId from a DIFFERENT campaign than this encounter's is not just an
      // invalid input (400) — it's a resource that doesn't exist from this encounter's
      // point of view, so 404, matching how a cross-campaign id 404s elsewhere (e.g.
      // CampaignAccessService's member checks).
      if (character.campaignId !== encounterRow.campaignId) {
        throw new NotFoundException(`Character ${input.characterId} not found in campaign ${encounterRow.campaignId}`);
      }
      // Uniqueness guard (issue #51): a character may appear at most once in an
      // encounter's initiative. Without this the API happily adds the same PC twice
      // (a manual re-add, or racing the create() auto-add) — duplicate rows that
      // then track HP independently and clutter the order. 409 Conflict rather than
      // silently upserting, so the caller learns their add was a no-op. Carries the
      // existing combatant id (issue #749); the DB partial unique index
      // (idx_combatants_encounter_character) backstops the TOCTOU race where two
      // adds pass this probe at once.
      const [dup] = await this.db
        .select()
        .from(combatants)
        .where(and(eq(combatants.encounterId, encounterId), eq(combatants.characterId, character.id)))
        .limit(1);
      if (dup) {
        throw new ConflictException({
          code: 'COMBATANT_IDENTITY_CONFLICT',
          message: `Character ${character.id} is already a combatant in encounter ${encounterId}`,
          combatantId: dup.id,
        });
      }
      characterId = character.id;
      name = name ?? character.name;
      hpMax = hpMax ?? character.hpMax;
      hpCurrent = character.hpCurrent;
      // Issue #711: seed the death/temp-HP slice from the persistent sheet so a
      // late-joining stable/dying PC re-enters combat in that state (mirrors the
      // create() auto-add path). Monsters/NPCs below default to alive/temp-less.
      characterHpTemp = character.hpTemp;
      characterDeathState = character.deathState;
      characterDeathSaveSuccesses = character.deathSaveSuccesses;
      characterDeathSaveFailures = character.deathSaveFailures;
      characterSheetUpdatedAt = character.updatedAt;
      // Issue #486: seed from the sheet (same contract as create() auto-add).
      // #1047: the structured copy comes with it, untranslated (see the create() path).
      characterConditions = character.conditions;
      characterConditionInstances = toJsonText(
        readConditionInstances(character.conditionInstances, character.conditions),
      );
      spCurrent = character.spCurrent;
      spMax = character.spMax;
      rpCurrent = character.rpCurrent;
      rpMax = character.rpMax;
      eac = character.eac;
      kac = character.kac;
      speed = character.speed;
      if (input.initMod === undefined) {
        const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
        initBreakdown = characterInitiativeBreakdown(adapter, stats, character.level);
        initMod = initBreakdown.modifier;
      }
    } else if (input.ruleEntryId !== undefined || duplicateRuleEntryId !== undefined) {
      // Any explicitly-supplied ruleEntryId (not just kind='monster') must resolve to a
      // real rule_entries row — 400 rather than silently dropping it and inserting a
      // combatant with a dangling reference.
      const requestedRuleEntryId = input.ruleEntryId ?? duplicateRuleEntryId!;
      const [entry] = await this.db.select().from(ruleEntries).where(and(eq(ruleEntries.id, requestedRuleEntryId), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, encounterRow.campaignId)))).limit(1);
      if (!entry) {
        throw new BadRequestException(`Rule entry ${requestedRuleEntryId} not found`);
      }
      ruleEntryId = entry.id;
      name = name ?? entry.name;
      const data = fromJsonText<Record<string, unknown>>(entry.dataJson, {});
      // HP + initiative come from the RuleSystemAdapter's statblock mapping (issue #70) —
      // 5e reads dataJson.hitPoints and derives init from abilityScores.dexterity — rather
      // than inlining those field names here, so a non-5e monster statblock maps its own way.
      if (hpMax === undefined) {
        const hp = adapter.monsterHitPoints(data);
        hpMax = hp ?? 0;
      }
      const mapped = adapter.mapStatblock(data) as StarfinderStatblockData;
      if ((input.duplicateOfCombatantId === undefined || replacesSourceRuleEntry) && mapped.stamina != null && typeof mapped.stamina === 'number') {
        spMax = mapped.stamina;
        spCurrent = mapped.stamina;
      }
      if ((input.duplicateOfCombatantId === undefined || replacesSourceRuleEntry) && mapped.resolve != null && typeof mapped.resolve === 'number') {
        rpMax = mapped.resolve;
        rpCurrent = mapped.resolve;
      }
      if ((input.duplicateOfCombatantId === undefined || replacesSourceRuleEntry) && mapped.eac != null && typeof mapped.eac === 'number') {
        eac = mapped.eac;
      }
      if ((input.duplicateOfCombatantId === undefined || replacesSourceRuleEntry) && mapped.kac != null && typeof mapped.kac === 'number') {
        kac = mapped.kac;
      }
      if (input.initMod === undefined && (input.duplicateOfCombatantId === undefined || replacesSourceRuleEntry)) {
        // Pass abilityRepresentation so PF2e creature modifiers (and Open Legend native
        // attributes) are not score-converted a second time (issue #767).
        const mapped = adapter.mapStatblock(data);
        // Issue #764: when the adapter can distinguish "unavailable" from a genuine +0
        // (PF1e), refuse to invent a silent zero — the DM must supply initMod explicitly.
        if (adapter.initiativeModifierOrNull) {
          const resolved = adapter.initiativeModifierOrNull(
            mapped.abilityScores,
            mapped.abilityRepresentation,
          );
          if (resolved === null) {
            throw new BadRequestException(
              'Unable to resolve initiative for this combatant — provide "initMod" explicitly (statblock has no native Init or DEX)',
            );
          }
          initMod = resolved;
        } else {
          initMod = adapter.initiativeModifier(mapped.abilityScores, mapped.abilityRepresentation);
        }
        initBreakdown = monsterInitiativeBreakdown(adapter, data, initMod);
        initMod = initBreakdown.modifier;
      }
    }

    if (!name) {
      throw new BadRequestException('Unable to resolve a name for this combatant — provide "name" explicitly');
    }
    if (hpMax === undefined && input.kind === 'npc') {
      hpMax = 0;
    }
    if (hpMax === undefined) {
      throw new BadRequestException('Unable to resolve hpMax for this combatant — provide "hpMax" explicitly');
    }
    if (hpCurrent === undefined) hpCurrent = hpMax;

    // Issue #425: inline homebrew statblock or campaign-library snapshot.
    if (input.libraryMonsterId !== undefined) {
      const lib = await this.campaignLibrary.getOrThrow(input.libraryMonsterId, encounterRow.campaignId);
      statblockJson = toJsonText(lib.statblock);
    } else if (input.statblock !== undefined) {
      statblockJson = toJsonText(CombatantStatblock.parse(input.statblock));
    } else if (duplicateStatblockJson !== null && input.ruleEntryId === undefined) {
      statblockJson = duplicateStatblockJson;
    } else if (
      input.kind === 'monster' &&
      characterId === null &&
      npcId === null &&
      ruleEntryId === null
    ) {
      // Manual monster with no compendium link — seed playable defaults.
      statblockJson = toJsonText(defaultCombatantStatblock());
    }

    // Issue #114: `count` adds N identical combatants in one call. Auto-suffix the
    // names "Goblin 1".."Goblin N" so duplicate monsters are distinguishable in the
    // order (the docs' "three goblins" example). count is meaningless for a
    // character add (a PC is unique and uniqueness-guarded above), so it's ignored
    // there — the characterId branch never sets count>1 in practice.
    const count = input.characterId !== undefined || input.npcId !== undefined ? 1 : Math.max(1, input.count ?? 1);
    const names = count > 1 ? Array.from({ length: count }, (_, i) => `${name} ${i + 1}`) : [name];

    // Issue #86: derive sortOrder in SQL (MAX(sort_order)+1) instead of from a
    // stale `existing.length` read — two concurrent adds used to read the same
    // count and insert colliding sortOrders. Sequential awaits (not Promise.all) so
    // each row's MAX(sort_order)+1 subquery observes the prior insert and the batch
    // gets distinct, contiguous orders.
    //
    // Issue #749: the SELECT-then-INSERT duplicate probes above are a TOCTOU race
    // — two concurrent adds of the same character/NPC both observe no existing row
    // and both reach this INSERT. The partial unique indexes
    // (idx_combatants_encounter_character / idx_combatants_encounter_npc) now make
    // the loser's INSERT throw SQLITE_CONSTRAINT_UNIQUE. We catch it and re-read the
    // WINNING combatant so the caller gets a deterministic 409 carrying the existing
    // combatant id, not a generic 500. This fires only for identity adds (character/
    // npc) — a `count>1` monster batch never touches the partial indexes, so the
    // loop never throws there. Throwing here (before audit/event) keeps everything
    // consistent: the WINNING caller owns the single audit entry + SSE signal.
    let insertedRows: (typeof combatants.$inferSelect)[] = [];
    let emittedEncounter = encounterRow;
    try {
      this.db.transaction((tx) => {
        const freshEncounter = tx.select().from(encounters).where(eq(encounters.id, encounterId)).get();
        if (!freshEncounter) throw new NotFoundException(`Encounter ${encounterId} not found`);
        this.assertMutable(freshEncounter);
        this.assertCampaignWritableInTx(tx, freshEncounter.campaignId);
        insertedRows = names.map((n) => tx.insert(combatants)
          .values({
            encounterId,
            kind: input.kind,
            characterId,
            npcId,
            npcDispositionSnapshot,
            name: n,
            initiative: null,
            initMod,
            initiativeBreakdown: toJsonText(initBreakdown),
            initiativeGroup,
            hpCurrent,
            hpMax,
            spCurrent,
            spMax,
            rpCurrent,
            rpMax,
            eac,
            kac,
            speed,
            // Issue #711: only a character combatant carries the persistent
            // death/temp-HP slice in; monsters/NPCs default to alive/temp-less
            // (the Combatant schema defaults handle the unset monster case).
            ...(characterId !== null
              ? {
                  hpTemp: characterHpTemp,
                  deathState: characterDeathState,
                  deathSaveSuccesses: characterDeathSaveSuccesses,
                  deathSaveFailures: characterDeathSaveFailures,
                  // Issue #466: CAS token for sheet↔combatant HP sync at add time.
                  sheetSyncedUpdatedAt: characterSheetUpdatedAt,
                }
              : {}),
            // Issue #486: character combatants inherit sheet conditions; monsters/NPCs start empty.
            conditions: characterId !== null ? characterConditions : '[]',
            conditionInstances: characterId !== null ? characterConditionInstances : null,
            ruleEntryId,
            npcIdentitySourceId,
            tokenSize,
            statblockJson,
            sortOrder: sql`(SELECT COALESCE(MAX(${combatants.sortOrder}), -1) + 1 FROM ${combatants} WHERE ${combatants.encounterId} = ${encounterId})`,
          })
          .returning()
          .all()[0]);

        // Keep a running encounter's roster mutation and its exact-undo guard atomic.
        // Otherwise Undo can observe the inserted row before the revision bump and rewind
        // a pointer across that newer roster state.
        if (freshEncounter.status === 'running') {
          const rows = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all();
          const sorted = this.sortCombatantsWithAdapter(rows.map(combatantToDomain), 'running', adapter);
          const turnIndex = turnIndexFor(sorted, freshEncounter.currentCombatantId);
          const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
          tx.update(encounters).set({
            turnIndex,
            combatantStateVersion: sql`${encounters.combatantStateVersion} + 1`,
            updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? freshEncounter.updatedAt),
          }).where(and(eq(encounters.id, encounterId), eq(encounters.status, 'running'))).run();
        }
        emittedEncounter = freshEncounter;
      });
    } catch (err) {
      if (isUniqueConstraintError(err) && (characterId !== null || npcId !== null)) {
        // The race loser: another caller inserted this same identity between our
        // probe and our INSERT. Re-read the winning row so the 409 carries its id
        // (deterministic — exactly one row can match the partial unique index now).
        // If the re-read somehow finds nothing (the winner was rolled back, or the
        // constraint fired for an unrelated reason), rethrow the original
        // SQLITE_CONSTRAINT error so the caller sees the real failure rather than
        // a generic 409 that masks it.
        const winner = await this.findExistingIdentityCombatant(encounterId, characterId, npcId);
        if (winner) {
          throw new ConflictException({
            code: 'COMBATANT_IDENTITY_CONFLICT',
            message: `${characterId !== null ? `Character ${characterId}` : `NPC ${npcId}`} is already a combatant in encounter ${encounterId}`,
            combatantId: winner.id,
          });
        }
      }
      throw err;
    }
    const row = insertedRows[0];

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.combatant.add',
      entityType: 'combatant',
      entityId: row.id,
      campaignId: emittedEncounter.campaignId,
      detail: insertedRows.length > 1 ? `${name} ×${insertedRows.length}` : name,
    });

    this.emitEncounterEvent('encounter.updated', emittedEncounter.campaignId, encounterId, emittedEncounter.hidden);

    return combatantToDomain(row);
  }

  /**
   * Roll one server-authoritative d20 for a dying 5e character, atomically applying
   * its outcome and matching dice/audit/combat-log evidence. A same-key retry replays
   * its committed response without rolling again, including after lifecycle changes.
   */
  async rollDeathSave(
    encounterId: number,
    combatantId: number,
    idempotencyKey: string,
    user: RequestUser,
    role: Role,
  ): Promise<{ combatant: Combatant; roll: DiceRoll }> {
    // A retained trashed row is sufficient to authorize an existing keyed replay;
    // fresh writes still fail in updateCombatant's transaction-local mutable check.
    const encounter = await this.getRowOrThrow(encounterId, true);
    if (!isVisibleTo({ hidden: encounter.hidden }, role)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    const operationFingerprint = { combatantId };
    const deathSaveClaim: EncounterOpClaim = {
      actorId: user.id,
      operation: 'combatant.death_save_roll',
      key: idempotencyKey,
      encounterId,
      campaignId: encounter.campaignId,
      fingerprint: encounterOpFingerprint(operationFingerprint),
    };
    // Set by `replayCombatant` below when updateCombatant finds a prior claim for this
    // key — i.e. this invocation did not perform the write and must not re-broadcast.
    let replayedPriorClaim = false;
    const replayResponse = (response: unknown): { combatant: Combatant; roll: DiceRoll } | null => {
      if (!response || typeof response !== 'object') return null;
      const candidate = response as Partial<{ combatant: Combatant; roll: DiceRoll }>;
      return candidate.combatant && candidate.roll ? { combatant: candidate.combatant, roll: candidate.roll } : null;
    };

    // A committed response is safe to replay even if the combatant has since been
    // removed or the campaign became read-only. The controller/MCP tool has already
    // checked current campaign membership and role; this lookup performs no domain
    // write and is keyed to that authorized actor, encounter, and target.
    const replayCommittedDeathSave = async (): Promise<{ combatant: Combatant; roll: DiceRoll } | null> => {
      const prior = this.db.transaction((tx) => findPriorEncounterOp(tx, deathSaveClaim, Date.now()));
      if (!prior) return null;
      const parsed = replayResponse(prior.response);
      if (!parsed) return null;
      if (prior.responseRole === role) return parsed;
      // Best-effort re-derivation for a changed role: a failure here (e.g. the encounter
      // became hidden to the caller between the preflight and the replay) must not mask the
      // real rejection reason in `rollDeathSave`'s catch handler.
      try {
        const snapshot = await this.getWithCombatantsOrThrow(encounterId, role, undefined, true);
        const found = snapshot.combatants.find((c) => c.id === combatantId);
        if (!found) return null;
        const roll = (await this.rolls.redactRollForRole(parsed.roll, role))!;
        return { combatant: found, roll };
      } catch {
        return null;
      }
    };
    const earlyReplay = await replayCommittedDeathSave();
    if (earlyReplay) return earlyReplay;

    try {
      // Reject an already archived/trashed campaign before any further work, so an
      // ended encounter does not mask the 403 (issue #1759). `updateCombatant` repeats
      // the canonical in-transaction check, so a race that trashes the campaign after
      // this preflight still cannot admit a new result.
      this.assertCampaignWritableInTx(this.db, encounter.campaignId);
      const adapter = await this.adapterForCampaign(encounter.campaignId);
      if (!hasDeathSavesForAdapter(adapter)) {
        throw new BadRequestException(`Death saves are not supported for the ${adapter.id} ruleset`);
      }
      const combatant = await this.getCombatantRowOrThrow(encounterId, combatantId);

      // This pre-read authorizes the actor. The mutable-encounter guard itself lives below
      // the keyed replay lookup, so a lost-response retry can recover its committed result
      // even if another DM ended the encounter before it arrived.
      if (role !== 'dm') {
        if (combatant.characterId === null) throw new ForbiddenException('Only dm may modify this combatant');
        const [character] = await this.db.select().from(characters).where(eq(characters.id, combatant.characterId)).limit(1);
        if (!character || character.ownerUserId !== user.id) {
          throw new ForbiddenException('Only dm or the owning player may roll this death save');
        }
      }

      let roll: DiceRoll | null = null;
      const deathSavePatch: CombatantInternalUpdateInput = { deathSaveRoll: 0, idempotencyKey };
      await this.updateCombatant(
        encounterId,
        combatantId,
        deathSavePatch,
        user,
        role,
        {
          operation: 'combatant.death_save_roll',
          // The d20 is server generated inside the transaction. Bind the key to the action
          // target, not that random face, so the same intent replays before any new RNG work.
          operationFingerprint,
          beforeWriteInTransaction: (tx, fresh, freshEncounter) => {
            this.assertDeathSavesSupportedForCampaign(encounter.campaignId, tx);
            if (!isVisibleTo({ hidden: freshEncounter.hidden }, role)) {
              throw new NotFoundException(`Encounter ${encounterId} not found`);
            }
            if (freshEncounter.hidden) {
              throw new ForbiddenException('Death saves cannot be rolled while an encounter is hidden');
            }
            if (role !== 'dm') {
              const [freshCharacter] = tx.select().from(characters).where(eq(characters.id, fresh.characterId!)).limit(1).all();
              if (!freshCharacter || freshCharacter.ownerUserId !== user.id) {
                throw new ForbiddenException('Only dm or the owning player may roll this death save');
              }
            }
            // A concurrent first roll cannot leave a second request applying a face to a
            // no-longer-dying combatant. This code is deliberately after the prior-claim
            // lookup, so a lost-response retry returns its stored outcome instead.
            if (
              fresh.encounterId !== encounterId ||
              fresh.kind !== 'character' ||
              fresh.hpCurrent !== 0 ||
              fresh.deathState !== 'dying'
            ) {
              throw new BadRequestException('Only a dying character at 0 HP can roll a death save');
            }
            const result = this.rollDeathSaveD20();
            result.label = `${fresh.name} · death save`;
            roll = this.rolls.recordInTransaction(tx, encounter.campaignId, result, user);
            // `updateCombatant` applies this server-only face after the hook returns.
            deathSavePatch.deathSaveRoll = result.total;
          },
          afterWriteInTransaction: (tx, committed, fresh, freshEncounter) => {
            // This evidence is part of the authoritative action: commit it with the
            // combatant outcome, dice row, audit entry, and idempotency replay response,
            // or roll all five back. A retry then cannot replay an outcome whose combat
            // log is permanently missing (or duplicated).
            this.audit.logInTx(tx, {
              actor: auditActor(user),
              actorRole: role,
              action: 'encounter.combatant.death_save_roll',
              entityType: 'combatant',
              entityId: combatantId,
              campaignId: encounter.campaignId,
              detail: `${committed.name}: d20 ${roll!.total}`,
            });
            if (committed.deathState === 'dead' && fresh.deathState !== 'dead') {
              const actor =
                freshEncounter.currentCombatantId === null || freshEncounter.currentCombatantId === combatantId
                  ? null
                  : tx
                      .select({ id: combatants.id, name: combatants.name })
                      .from(combatants)
                      .where(and(eq(combatants.id, freshEncounter.currentCombatantId), eq(combatants.encounterId, encounterId)))
                      .limit(1)
                      .all()[0] ?? null;
              this.appendEventInTransaction(tx, encounterId, freshEncounter.round, 'death', {
                actor: actor?.name ?? null,
                target: committed.name,
                actorId: actor?.id ?? null,
                targetId: combatantId,
                detail: 'died',
              });
            }
            this.appendEventInTransaction(tx, encounterId, freshEncounter.round, 'roll', {
              target: committed.name,
              targetId: combatantId,
              detail: deathSaveRollEventDetail(
                roll!.total,
                committed.deathSaveSuccesses,
                committed.deathSaveFailures,
                fresh.deathState,
                committed.deathState,
              ),
            });
          },
          deathSaveEventsInTransaction: true,
          operationResponse: (committed) => ({ combatant: committed, roll: roll! }),
          replayCombatant: (response) => {
            // `replayCombatant` is invoked ONLY when a prior claim for this key already
            // exists — both on the in-transaction prior-claim path and after the
            // EncounterOpRaceMarker. Either way another invocation owns the committed roll
            // and has already broadcast it, so this one must not emit again. Recording the
            // fact here rather than inferring it from `roll` being set: `roll` is assigned
            // in beforeWriteInTransaction and SURVIVES the rolled-back race-loser
            // transaction, which is exactly why it is not a usable signal (see the null-body
            // replay finding earlier on this PR).
            replayedPriorClaim = true;
            return replayResponse(response)?.combatant ?? null;
          },
        },
      );
      // `roll` may be the loser's discarded die if `updateCombatant` lost a same-key
      // race, so the authoritative response is always the stored replay.
      const replay = await replayCommittedDeathSave();
      if (replay) {
        // Emit only when THIS invocation actually committed the roll. A retry that was
        // satisfied by a prior claim still returns the stored response as its body, but
        // the winner already broadcast that die — emitting again put the same d20 in the
        // shared dice tray twice, making one death save look like two.
        if (!replayedPriorClaim) this.rolls.emitDiceRolled?.(replay.roll);
        return replay;
      }
      // A null replay here does NOT always mean nothing was persisted. `replayCommittedDeathSave`
      // also returns null when a claim exists whose stored body was never backfilled — the exact
      // window that produced the null-body dereference fixed earlier on this PR. That fix covered
      // the case where a PRIOR invocation owned the claim; this is its twin, where THIS invocation
      // committed the roll and its own body is the one missing. Left as a bare throw, a successful
      // write answered 500, and every retry re-found the same bodiless claim and 500'd again — a
      // committed death save the caller could never see.
      //
      // The re-derivation is gated on `!replayedPriorClaim`, which is precisely the condition under
      // which `roll` is trustworthy: `replayCombatant` fires whenever a prior claim exists, so if it
      // did not fire, this invocation is the writer and `roll` is its own committed die rather than
      // a race-loser's discarded one. That is the same distinction the emit guard above depends on.
      if (!replayedPriorClaim && roll != null) {
        const snapshot = await this.getWithCombatantsOrThrow(encounterId, role, undefined, true);
        const committed = snapshot.combatants.find((c) => c.id === combatantId);
        if (committed) {
          // `roll` is returned as-is, NOT redacted. This reconstructs the body that
          // `operationResponse` would have stored for THIS role, and the stored-body path
          // returns it unredacted whenever `prior.responseRole === role` — redaction there
          // is reserved for the changed-role re-derivation. Redacting here would make the
          // recovery answer differ from the answer the same caller gets on the normal path.
          this.rolls.emitDiceRolled?.(roll);
          return { combatant: committed, roll };
        }
      }
      // The remaining case is a PRIOR invocation's claim whose stored body is missing — the
      // other half of the twin above, and it cannot be answered the same way. The recovery
      // above works only because `roll` is this invocation's own committed die; on the
      // prior-claim path the winner's die was never handed to us, and this repo has no
      // per-encounter/per-combatant roll lookup to recover it from (`RollsService` exposes
      // only `listForCampaign`). Inventing a face to fill the response would be strictly
      // worse than failing: it would put a d20 in the dice record that nobody ever rolled,
      // in a subsystem whose entire purpose is being the evidence of what was rolled.
      //
      // So the failure stands — but as a deterministic, client-actionable one rather than a
      // bare `Error` surfacing as a 500 the client can only retry into forever. The write
      // DID land, so the combatant state is authoritative and a re-read recovers everything
      // except the die face. A 409 with a code says exactly that; the previous 500 said
      // "server broken, try again", which was both wrong and unactionable.
      throw new ConflictException({
        code: 'DEATH_SAVE_RESULT_UNAVAILABLE',
        message:
          'The death save was applied, but its dice record is unavailable — reload the encounter for the authoritative combatant state. Retrying this request will not recover the roll.',
      });
    } catch (err) {
      // The original same-key request can commit after our early replay lookup but
      // before a mutable-row preflight (for example, before another DM removes the
      // combatant). Recheck the stored outcome before surfacing that later 404/409 so
      // an ambiguous retry still recovers the committed authoritative result.
      const lateReplay = await replayCommittedDeathSave();
      if (lateReplay) return lateReplay;
      throw err;
    }
  }

  /** Kept as a seam for deterministic death-save endpoint regressions. */
  private rollDeathSaveD20(): RollResult {
    return rollDice('1d20');
  }

  private assertDeathSavesSupportedForCampaign(campaignId: number, tx: SyncDb): void {
    const [campaign] = tx
      .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
      .all();
    const adapter = ruleSystemAdapter(
      campaign?.ruleSystem,
      fromJsonText<HomebrewMechanicsProfile | null>(campaign?.customMechanicsProfile, null),
    );
    if (!hasDeathSavesForAdapter(adapter)) {
      throw new BadRequestException(`Death saves are not supported for the ${adapter.id} ruleset`);
    }
  }

  /**
   * dm may change anything (including initiative, and the combatant identity fields
   * name/hpMax/initMod — issue #114). A player may only touch HP-ish fields
   * (hpDelta, hpSet, hpTemp, deathSave counters, add/removeConditions), and only on a
   * combatant whose characterId links to a character THEY own — everything else 403s.
   */
  async updateCombatant(
    encounterId: number,
    combatantId: number,
    patch: CombatantInternalUpdateInput,
    user: RequestUser,
    role: Role,
    options?: CombatantUpdateTransactionOptions,
  ): Promise<Combatant> {
    const encounterRow = await this.getRowOrThrow(encounterId, true);
    // A hidden/prep encounter must be nonexistent for non-DMs (issue #262); otherwise a
    // keyed replay's role-filtered fallback can 404 after the write already landed.
    // Same-role, visible-encounter replays still replay the stored body; role-mismatched
    // ones re-derive through `getWithCombatantsOrThrow` below.
    if (!isVisibleTo({ hidden: encounterRow.hidden }, role)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    // An operation key may name a result that already committed before the encounter
    // ended. Let the transaction check that claim first; fresh keyed writes still hit
    // the same guard inside the transaction below.
    if (!patch.idempotencyKey) this.assertMutable(encounterRow);
    if (patch.expectedUpdatedAt) this.revisions.assertNotStale(encounterRow, patch.expectedUpdatedAt);
    const existing = await this.getCombatantRowOrThrow(encounterId, combatantId);

    const isDm = role === 'dm';
    if (!isDm) {
      // Identity edits and combat-log actor are DM-only.
      // Combat-log actor attribution is DM-authored (apply-damage UI). A player
      // patching their own combatant must not spoof who dealt the damage/heal.
      //
      // This stays an ABSOLUTE rule (issue #1478): the field is rejected outright,
      // never ignored-when-redundant. A player never needs to send it — omitting
      // `actorId` makes resolveCombatLogActor() attribute the event to the
      // current-turn combatant, which is exactly what an honest client would have
      // named. A "tolerate it when it equals the current turn" carve-out would also
      // be racy, since the client's notion of the current turn is a cached read that
      // goes stale the moment the turn advances.
      //
      // Carries an explicit error code so the player-facing UI can explain the
      // refusal instead of rendering a bare 403.
      if (patch.actorId !== undefined) {
        throw new ForbiddenException({
          code: 'COMBAT_LOG_ACTOR_DM_ONLY',
          message:
            'Only a DM may set the combat-log actor. Omit actorId — damage is attributed to the current-turn combatant automatically.',
        });
      }
      // Issue #1904 (review finding): a player could formerly set initiative to ANY
      // value on their own combatant (#1457) via this manual PATCH, entirely
      // bypassing the server RNG, idempotency, and dice-log evidence the new
      // POST .../roll-initiative endpoint provides. That made "server-authoritative
      // initiative" a UI-only convention — a disabled button, not a server rule — since
      // any direct request (or an old client) could still choose its own value. A
      // player rolls their own initiative exclusively through the dedicated endpoint
      // now; manual initiative PATCHes (set or clear) are DM-only, same as name/hpMax/
      // initMod/tokenSize. Absolute rule, same reasoning as actorId above: a player
      // never needs to send this field, so it is rejected outright rather than ignored.
      // `statblock`, `statblockRevealed`, `eac`, and `kac` join the list for the same reason,
      // and because omitting them was actively harmful rather than merely permissive: each
      // is written only under `isDm`, so a non-DM patch carrying one of them alone reached
      // the write transaction with an empty `writeSet` and drizzle threw "No values to set"
      // — a 500 where the caller deserved a 403. Rejecting outright beats silently no-opping:
      // a player who edits a statblock should be told they may not, not told it worked.
      if (
        patch.name !== undefined ||
        patch.hpMax !== undefined ||
        patch.initMod !== undefined ||
        patch.tokenSize !== undefined ||
        patch.initiative !== undefined ||
        patch.statblock !== undefined ||
        patch.statblockRevealed !== undefined ||
        patch.eac !== undefined ||
        patch.kac !== undefined ||
        // Issue #1921: DM force-toggle of a limited-use/recharge action's spend state joins
        // the same absolute-rule list — a player never needs to override their own or a
        // monster's spend, and (per the acceptance criteria) must get a 403, not a silent no-op.
        patch.actionUses !== undefined
      ) {
        throw new ForbiddenException({
          code: 'COMBATANT_FIELD_DM_ONLY',
          message:
            'Only dm may edit a combatant’s name, hpMax, initMod, tokenSize, initiative, statblock, statblockRevealed, eac, kac, or actionUses — roll your own initiative via the dedicated roll-initiative action.',
        });
      }
      if (!existing.characterId) {
        throw new ForbiddenException('Only dm may modify this combatant');
      }
      const [character] = await this.db.select().from(characters).where(eq(characters.id, existing.characterId)).limit(1);
      if (!character || character.ownerUserId !== user.id) {
        throw new ForbiddenException('Only dm or the owning player may modify this combatant');
      }
    }
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    // Issue #1670: the SAME lookup the character sheet's adjustConditionLevel uses
    // (characters.service.ts), not a second constant or a duplicated cap — that
    // duplication is exactly what let this drift in the first place. `undefined` for
    // a system with no leveled track (e.g. PF2e) is the negative case, matching the
    // sheet's own handling: nothing here to cap, so nothing is rejected.
    const leveledTrack = leveledConditionTrackFor(adapter.id);
    // #1503 — a system without 5e death saves has no death-save counters to edit, so a genuine
    // attempt to write NEW 5e death-save state is rejected up front (matching the death-save roll
    // path's assertDeathSavesSupportedForCampaign): applyCombatantHp would otherwise silently drop
    // the fields while the override combat-log event still claimed a counter edit. The rejection
    // fires only for an INCREASE — matching CharactersService.update's level-cap-style rule — so an
    // idempotent snapshot (re-sending the current counters) and a decrease/reset to 0 (clearing
    // leftover 5e state) are allowed, while no new 5e state can be introduced (Devin #1812).
    const combatantSuccIncrease = patch.deathSaveSuccesses !== undefined && patch.deathSaveSuccesses > existing.deathSaveSuccesses;
    const combatantFailIncrease = patch.deathSaveFailures !== undefined && patch.deathSaveFailures > existing.deathSaveFailures;
    if (!hasDeathSavesForAdapter(adapter) && (combatantSuccIncrease || combatantFailIncrease)) {
      throw new BadRequestException(`Death saves are not supported for the ${adapter.id} ruleset`);
    }
    const damageMetadataTouched =
      patch.damageType !== undefined || patch.saveOutcome !== undefined || patch.isCrit !== undefined || patch.damageDice !== undefined;
    if (damageMetadataTouched && !adapter.supportsDirectDamageRules) {
      throw new BadRequestException('The active rule system does not support typed direct-damage rules');
    }
    const damageType = patch.damageType === undefined
      ? undefined
      : adapter.damageTypes?.find((type) => type.toLowerCase() === patch.damageType!.trim().toLowerCase());
    if (patch.damageType !== undefined && damageType === undefined) {
      throw new BadRequestException(`Unknown damage type for this rule system: ${JSON.stringify(patch.damageType)}`);
    }
    if (damageMetadataTouched && patch.hpSet !== undefined) {
      throw new BadRequestException('Direct-damage metadata cannot be combined with hpSet');
    }
    if (damageMetadataTouched && (patch.hpDelta === undefined || patch.hpDelta >= 0)) {
      throw new BadRequestException('Damage type, save outcome, and critical metadata require a negative hpDelta');
    }
    if (patch.damageDice !== undefined && patch.isCrit !== true) {
      throw new BadRequestException('The dice-only damage subtotal requires a critical hit');
    }
    if (patch.isCrit && patch.damageDice === undefined) {
      throw new BadRequestException('Critical damage requires the dice-only damage subtotal');
    }
    if (!isDm && patch.addConditions !== undefined && patch.addConditions.length > 0) {
      const unknown = patch.addConditions.filter((c) => !isKnownCondition(adapter.conditions, c));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Unknown condition(s) for this rule system: ${unknown.map((c) => JSON.stringify(c)).join(', ')}. ` +
            'Players may only add conditions from the active rule vocabulary; the DM may mint custom entries.',
        );
      }
    }

    // Non-HP field writes computed up front (initiative/identity). The HP +
    // death-save fields AND the condition add/remove deltas are computed INSIDE
    // the transaction below off a fresh read, so concurrent damage and concurrent
    // condition changes both compose atomically (issues #86, #747).
    const staticUpdate: Partial<typeof combatants.$inferInsert> = {};

    // Initiative: DM-only manual set/clear (issue #1904 — see the ForbiddenException
    // above, which already rejects a non-DM's `initiative` outright). A player rolls
    // their own initiative exclusively through POST .../roll-initiative now, not this
    // manual PATCH (formerly allowed for the owning player under #1457). `&& isDm` here
    // is defense-in-depth matching the sibling identity fields below, not the only gate.
    if (patch.initiative !== undefined && isDm) staticUpdate.initiative = patch.initiative;
    if (patch.name !== undefined && isDm) staticUpdate.name = patch.name;
    if (patch.initMod !== undefined && isDm) staticUpdate.initMod = patch.initMod;
    // Battle-map token position (issue #39). Not DM-gated: the player-write branch above
    // already restricts a non-DM to a combatant linked to a character they own, which is
    // exactly the "a player moves only their own token" rule. Clamp to 0–100 (mirrors the
    // campaign map's pin drag). Each axis is applied independently — a partial update
    // leaves the other coordinate unchanged. An explicit `null` clears the position
    // (unplace, issue #271) — write it straight through rather than clamping, since
    // clampPercent(null) would collapse to 0 and pin the token to a corner.
    if (patch.tokenX !== undefined) staticUpdate.tokenX = patch.tokenX === null ? null : clampPercent(patch.tokenX);
    if (patch.tokenY !== undefined) staticUpdate.tokenY = patch.tokenY === null ? null : clampPercent(patch.tokenY);
    // Token footprint size (issue #40) — DM-only (identity-like), same gate as name/hpMax above.
    if (patch.tokenSize !== undefined && isDm) staticUpdate.tokenSize = patch.tokenSize;
    if (patch.statblock !== undefined && isDm) {
      staticUpdate.statblockJson = toJsonText(CombatantStatblock.parse(patch.statblock));
    }
    // Statblock reveal toggle (issue #1926) — DM-only (see the ForbiddenException above).
    if (patch.statblockRevealed !== undefined && isDm) staticUpdate.statblockRevealed = patch.statblockRevealed;
    // DM force-toggle of a limited-use/recharge action's spend state (issue #1921) — DM-only
    // (see the ForbiddenException above). The target action is resolved from the CURRENT
    // sheet/statblock action list by index/name, through the SAME resolveActionUsesTarget a
    // resolve/apply spend uses, so this can never touch a different action's spend key than
    // the one the DM actually named. `spent` is clamped into [0, max] server-side — the field
    // is a direct set (not a delta), so both "force recharge" (spent: 0) and "force exhaust"
    // (spent: max) are one call.
    let actionUsesLabel: string | null = null;
    // Resolved here but MERGED INSIDE the transaction against the fresh row — see the
    // `actionUsesPatch` block beside the condition rebase below. `action_uses` is one JSON
    // blob covering every tracked action, so building it from the pre-transaction `existing`
    // snapshot and writing it wholesale would silently revert any OTHER action's spend that
    // landed in between (a concurrent apply, or a turn-start recharge) — the same lost-update
    // hazard conditions already avoid by rebasing (issue #747). Resolving the target here is
    // safe: it reads the action LIST, not the spend map.
    let actionUsesPatch: { key: string; spent: number } | null = null;
    if (patch.actionUses !== undefined && isDm) {
      if (!this.actionResolver) {
        throw new BadRequestException('Action-uses override is unavailable.');
      }
      const target = this.actionResolver.resolveActionUsesTarget(
        existing,
        { actionIndex: patch.actionUses.actionIndex, actionName: patch.actionUses.actionName },
        encounterRow.campaignId,
      );
      actionUsesPatch = { key: target.key, spent: Math.max(0, Math.min(patch.actionUses.spent, target.max)) };
      actionUsesLabel = target.name;
    }

    const hpMaxChanged = patch.hpMax !== undefined && isDm;
    // Any field that flows through the 5e HP/death-save engine (applyCombatantHp).
    const hpFieldsTouched =
      patch.hpDelta !== undefined ||
      patch.hpSet !== undefined ||
      patch.hpTemp !== undefined ||
      patch.deathSaveSuccesses !== undefined ||
      patch.deathSaveFailures !== undefined ||
      patch.deathSaveRoll !== undefined;
    // A recompute is needed if any HP field changed OR hpMax moved (hpCurrent may
    // need re-clamping to a lowered max, and the death state re-derived).
    const recomputeHp = hpFieldsTouched || hpMaxChanged;
    // Condition add/remove deltas — applied INSIDE the transaction below off the
    // fresh row, so two concurrent condition changes (one adds while another
    // removes a different condition) compose instead of the loser's whole-array
    // write silently clobbering the winner's (issue #747, same class as #86/#657).
    const conditionsTouched = patch.addConditions !== undefined || patch.removeConditions !== undefined;
    const conditionInstancesTouched =
      patch.addConditionInstance !== undefined ||
      patch.removeConditionInstanceId !== undefined ||
      patch.updateConditionInstance !== undefined ||
      patch.conditionInstances !== undefined;
    let conditionFieldsTouched = conditionsTouched || conditionInstancesTouched;

    const spFieldsTouched =
      patch.spSet !== undefined ||
      patch.spDelta !== undefined ||
      patch.rpSet !== undefined ||
      patch.rpDelta !== undefined;
    const deathStateTouched = patch.deathState !== undefined;
    // `eac`/`kac` are the one pair of writable fields that never enter `staticUpdate` —
    // they are applied straight onto `writeSet` inside the transaction below, DM-only.
    // Without them here, a patch carrying ONLY armour class matched the no-op condition
    // and returned 200 with the unchanged combatant, having persisted nothing (issue
    // #1990 review). Gated on `isDm` to mirror the write exactly: a non-DM's eac/kac is
    // dropped there, so admitting it here would buy a pointless transaction, not a fix.
    const defenseFieldsTouched = isDm && (patch.eac !== undefined || patch.kac !== undefined);

    if (
      Object.keys(staticUpdate).length === 0 &&
      !recomputeHp &&
      // `actionUses` no longer lands in `staticUpdate` (it is merged against the fresh row
      // inside the transaction), so it needs its own term here or an actionUses-only patch
      // would early-return as a no-op and silently persist nothing.
      actionUsesPatch === null &&
      !conditionFieldsTouched &&
      !spFieldsTouched &&
      !deathStateTouched &&
      !defenseFieldsTouched &&
      patch.statblock === undefined
    ) {
      this.assertMutable(encounterRow);
      return combatantToDomain(existing);
    }

    // Combatant write + linked-character HP/conditions mirror run in ONE synchronous
    // better-sqlite3 transaction (issue #86): the HP math reads the row's CURRENT
    // committed values inside the transaction (never a stale pre-await read), so two
    // authorized deltas landing near-simultaneously compose instead of clobbering —
    // better-sqlite3 serializes the whole synchronous callback. The mirror then reads
    // the transaction's own result.
    //
    // The character mirror is additionally gated on a still-live (non-'ended')
    // encounter (issue #163). assertMutable() above already rejects an ended encounter
    // outright, so this is defense-in-depth: post-combat combatant rows must never leak
    // back onto the live character sheet even if that guard is ever relaxed.
    //
    // Issue #486 — sheet↔combatant condition merge semantics (overlap window):
    //   • create/addCombatant seeds the combatant from the sheet.
    //   • A tracker write (addConditions/removeConditions) applies set deltas on the
    //     combatant (#747) then overwrites the linked sheet's conditions array.
    //   • A sheet write (CharactersService.patchConditions / PATCH conditions) overwrites
    //     the linked live combatant's conditions array (and stamps the CAS token).
    //   • Last cross-surface write wins as a whole array — there is no 3-way merge.
    //     Concurrent tracker deltas still compose via the in-tx set rebase (#747).
    //   • /end writes combatant conditions back onto the sheet alongside HP.
    //   • MCP `update_combatant` and `set_character_conditions` share these paths.
    const shouldMirrorSheet =
      existing.kind === 'character' &&
      existing.characterId !== null &&
      (recomputeHp || conditionFieldsTouched || spFieldsTouched || deathStateTouched);
    let row!: typeof combatants.$inferSelect;
    // Captured inside the transaction (off the fresh committed read + the write result)
    // so the combat-log events appended after commit reflect the real before/after HP
    // and death state, even when concurrent deltas composed (issue #61).
    let beforeHp = 0;
    let beforeTemp = 0;
    let beforeDeath = 'none';
    let _beforeSucc = 0;
    let _beforeFail = 0;
    let afterHp = 0;
    let afterTemp = 0;
    let afterDeath = 'none';
    let afterSucc = 0;
    let afterFail = 0;
    // Kept for the combat log so a DM can see the final rule-adjusted result (including
    // immunity, which has a zero HP delta and would otherwise leave no visible feedback).
    let directDamageSummary: string | null = null;
    // Condition snapshots captured inside the tx (off the fresh row + the write
    // result) so combat-log events derive from the actual committed before/after
    // state, not a stale pre-await read (issue #747, mirroring the HP snapshots).
    let beforeConditions: Set<string> = new Set();
    let afterConditions: Set<string> = new Set();
    // Issue #1452: when a concentrating combatant drops to 0 HP, we cascade the break
    // and log one condition event per removed concentration-sourced instance.
    let concentrationCascades: { combatantId: number; combatantName: string; condition: ConditionInstance }[] = [];

    // Issue #580 — per-intent idempotency. `hpDelta`/`spDelta`/`rpDelta`/`deathSaveRoll`
    // are RELATIVE writes: a retry after a lost response applies the damage a second
    // time. When the caller minted a key at the click, the claim below is written inside
    // this same transaction as the HP write, so claim and effect are inseparable, and a
    // retry replays the exact combatant the first attempt committed.
    const opClaim: EncounterOpClaim | null = patch.idempotencyKey
      ? {
          actorId: user.id,
          operation: options?.operation ?? 'combatant.update',
          key: patch.idempotencyKey,
          encounterId,
          campaignId: encounterRow.campaignId,
          // Fingerprint the payload minus the key itself, plus the target combatant: the
          // same key resent for a DIFFERENT patch is a client bug, and replaying the
          // first response for it would hide the bug rather than surface it.
          fingerprint: encounterOpFingerprint(
            options?.operationFingerprint ?? { combatantId, ...patch, idempotencyKey: undefined },
          ),
        }
      : null;
    // Issue #1990: keyed replay must be resolved outside the synchronous transaction
    // callback because role-filtered re-derivation (getWithCombatantsOrThrow) is async.
    // The prior is captured here and resolved below after the transaction commits.
    let priorFromReplay: EncounterOpPrior | null = null;
    // Issue #1902 rework (round 21, codex P2 sweep continuation): read after the
    // transaction commits, at this method's own `emitEncounterEvent` call below — see
    // `ActionResolverService.apply()`'s `sheetMirrored` doc comment for the general
    // rationale. `mirrorSheet` itself is computed from the transaction-local encounter
    // row (line ~4426), so it can't be read at that emission point directly; mirrored
    // here into an outer-scope flag the same way.
    let combatantSheetMirrored = false;

    const resolveReplay = async (prior: EncounterOpPrior): Promise<Combatant | null> => {
      let parsed: Combatant | null = null;
      try {
        parsed = options?.replayCombatant
          ? options.replayCombatant(prior.response)
          : ((prior.response as Combatant | null) ?? null);
      } catch {
        parsed = null;
      }
      if (parsed && prior.responseRole === role) return parsed;
      // A stored body may be missing or unparseable while the combatant still exists
      // (race/winner wrote a null response). Fall back to a current, role-filtered
      // projection — and tolerate a trashed encounter so an already-committed result
      // can still be replayed (issue #1990). A lookup failure must not mask the real
      // rejection reason in the `EncounterOpRaceMarker` catch path.
      try {
        const snapshot = await this.getWithCombatantsOrThrow(encounterId, role, undefined, true);
        return snapshot.combatants.find((c) => c.id === combatantId) ?? null;
      } catch {
        return null;
      }
    };

    try {
      this.db.transaction((tx) => {
        if (opClaim) {
          const prior = findPriorEncounterOp(tx, opClaim, Date.now());
          if (prior) {
            // Already applied. Capture the prior outside this synchronous transaction
            // so role-filtered replay can perform async work (issue #1990).
            priorFromReplay = prior;
            return;
          }
        }
        // No matching committed response: this is a fresh write. Re-read the encounter
        // inside this transaction after the replay lookup so an End that committed while
        // the request was awaiting preflight cannot be bypassed with the stale outer row.
        const [freshEncounter] = tx.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
        if (!freshEncounter) throw new NotFoundException(`Encounter ${encounterId} not found`);
        // The outer `isVisibleTo` gate ran against the STALE pre-transaction row. A DM who
        // hides the encounter in the window between that check and this transaction would
        // otherwise leave a non-DM's write landing — mirroring onto the character sheet and
        // emitting a combat-log event — on an encounter that must now be wholesale
        // nonexistent to them (issue #262). `adjustCombatantResource` (issue #1909 review)
        // and `rollDeathSave` already re-check here; this path was the outlier.
        if (!isVisibleTo({ hidden: freshEncounter.hidden }, role)) {
          throw new NotFoundException(`Encounter ${encounterId} not found`);
        }
        this.assertMutable(freshEncounter);
        this.assertCampaignWritableInTx(tx, freshEncounter.campaignId);
        // Issue #1902 rework (round 14, codex P1): re-validate `expectedUpdatedAt` against
        // THIS transaction-local row, not just the pre-transaction `encounterRow` checked
        // above — the same reason `freshEncounter` itself is re-read here rather than reused
        // (a caller between the outer check and this transaction, e.g. an unrelated combatant
        // PATCH, can advance the encounter's `updatedAt`; the outer check already passed
        // against the now-stale value, so without this the write proceeds anyway).
        if (patch.expectedUpdatedAt) this.revisions.assertNotStale(freshEncounter, patch.expectedUpdatedAt);
        // The sheet mirror has the same lifecycle boundary: derive it from the
        // transaction-local encounter row, never the stale preflight snapshot.
        const mirrorSheet = shouldMirrorSheet && freshEncounter.status !== 'ended';
        combatantSheetMirrored = mirrorSheet;
        const [fresh] = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
        if (!fresh || fresh.encounterId !== encounterId) {
          throw new NotFoundException(`Combatant ${combatantId} not found`);
        }
        // Issue #1992: guard a `statblock` write against the STATBLOCK'S OWN prior
        // content, not a row/encounter revision token. Two earlier approaches were tried
        // and rejected: pinning the ENCOUNTER's `updatedAt` (any OTHER combatant's write
        // anywhere in the fight invalidated an in-progress edit) and pinning a
        // per-COMBATANT revision bumped on every write to that row (an ordinary hp tick
        // on the very monster being edited still invalidated it, since that column
        // advanced on hp/condition/position writes too — neither one ever touches the
        // statblock). Comparing the actual stored content sidesteps both: an
        // hp/condition/position write never touches `statblockJson`, so it structurally
        // cannot trip this check — only a genuine concurrent `statblock` write (this
        // row's stored statblock no longer matches what the caller started from) can.
        // Deliberately a content compare, not a hash: `CombatantStatblock` is bounded
        // (actions ≤50, traits ≤30, notes ≤2000 chars) and already sent in full on every
        // whole-statblock PATCH, so comparing the actual value costs nothing extra worth
        // optimizing away, and needs no extra column. Only relevant to a `statblock`
        // write itself — ignored (not even parsed) when `patch.statblock` is absent from
        // this same call.
        if (patch.statblock !== undefined && patch.expectedStatblock !== undefined) {
          const storedStatblock = parseCombatantStatblock(fresh.statblockJson);
          if (!deepJsonEqual(storedStatblock, patch.expectedStatblock)) {
            throw new ConflictException({
              code: 'STALE_WRITE',
              message:
                'This statblock was changed by someone else since you loaded it — saving now would erase their edit. ' +
                'Reload to get the latest version, reapply your changes, then save again.',
            });
          }
        }
        // A caller may attach a tightly-scoped transactional side effect after the
        // fresh lifecycle read but before this mutation. A failure rolls both it and
        // the ensuing combatant write back. Used only for #1462's mandatory dice-log
        // evidence, which must never diverge from its death-save outcome.
        options?.beforeWriteInTransaction?.(tx, fresh, freshEncounter);
        beforeHp = fresh.hpCurrent;
        beforeTemp = fresh.hpTemp;
        beforeDeath = fresh.deathState;
        _beforeSucc = fresh.deathSaveSuccesses;
        _beforeFail = fresh.deathSaveFailures;
        const writeSet: Partial<typeof combatants.$inferInsert> = { ...staticUpdate };
        // Issue #2084 finding 1 (the "clear the stamp" half): a DM's manual `initiative`
        // PATCH (set or clear) moves this combatant out of whatever tie group its
        // `manualOrder` stamp referred to — that tie no longer exists, so the stamp must
        // not go on deciding a DIFFERENT tie the combatant lands in later (or continue
        // being consulted for a tie it no longer belongs to at all). Compared against
        // `fresh`, the transaction-local row, not the pre-transaction `existing` snapshot,
        // for the same staleness reason `expectedUpdatedAt` is re-checked against `fresh`
        // above. A same-value PATCH (idempotent resend) leaves the stamp alone.
        if (staticUpdate.initiative !== undefined && staticUpdate.initiative !== fresh.initiative) {
          writeSet.manualOrder = null;
        }
        if (actionUsesPatch) {
          // Rebase the DM's uses override against the FRESH row, for the same reason the
          // condition block below does (issue #747): `action_uses` is a single JSON map of
          // EVERY tracked action's spend, so merging into a pre-transaction snapshot would
          // clobber a concurrent spend or turn-start recharge of a DIFFERENT action rather
          // than merging with it — letting an already-spent ability quietly become available
          // again. Only the named key is written; every other key carries over from `fresh`.
          const currentUses = fromJsonText<Record<string, { spent?: number }>>(fresh.actionUses, {});
          writeSet.actionUses = toJsonText({ ...currentUses, [actionUsesPatch.key]: { spent: actionUsesPatch.spent } });
        }
        if (conditionFieldsTouched) {
          // Rebase every condition mutation against the FRESH row (issue #747 / #423).
          // Legacy string deltas and structured instance deltas share this path so a
          // removeConditions patch cannot leave stale conditionInstances behind, and an
          // addConditionInstance patch actually persists without needing a legacy field.
          const legacyConditions = fromJsonText<string[]>(fresh.conditions, []);
          let instances = parseConditionInstances(fresh.conditionInstances, legacyConditions);
          beforeConditions = new Set(deriveConditionNames(instances));

          if (patch.conditionInstances !== undefined) {
            instances = [...patch.conditionInstances];
          } else {
            if (patch.addConditionInstance !== undefined) {
              // Add a single instance (idempotent: replace if id already present).
              const addIdx = instances.findIndex((i) => i.id === patch.addConditionInstance!.id);
              if (addIdx >= 0) instances[addIdx] = patch.addConditionInstance;
              else instances.push(patch.addConditionInstance);
            }
            if (patch.updateConditionInstance !== undefined) {
              // Update a single instance by id; ignore if not present (no-op).
              const upd = patch.updateConditionInstance;
              const updIdx = instances.findIndex((i) => i.id === upd.id);
              if (updIdx >= 0) instances[updIdx] = upd;
            }
            if (patch.removeConditionInstanceId !== undefined) {
              // Remove only the targeted instance — not all instances with the same name.
              instances = instances.filter((i) => i.id !== patch.removeConditionInstanceId);
            }
            if (patch.removeConditions !== undefined) {
              const removedNames = new Set(patch.removeConditions.map((c) => c.trim()).filter(Boolean));
              instances = instances.filter((i) => !removedNames.has(i.name));
            }
            if (patch.addConditions !== undefined) {
              const existingNames = new Set(instances.map((i) => i.name));
              for (const rawName of patch.addConditions) {
                const legacy = legacyConditionInstance(rawName);
                if (!legacy) continue;
                if (existingNames.has(legacy.name)) continue;
                existingNames.add(legacy.name);
                instances.push(legacy);
              }
            }
          }

          instances = instances.slice(0, 50);

          // Issue #1670: enforce the adapter's leveled-condition cap here too, or a
          // combatant edit can push exhaustion past what the character sheet's own
          // adjustConditionLevel would ever allow — and, because the sheet's controls
          // are bounded to [0, track.max], the party has no way back down from the
          // combatant surface once that happens. An ERROR, never a clamp, mirroring
          // adjustConditionLevel's own "never silently under/over-report" rule
          // (issue #1039): a clamp here would let a DM (or an AI DM over MCP) believe
          // a 9th exhaustion level landed when only a 6th actually did.
          if (leveledTrack) {
            const trackKey = leveledTrack.name.toLowerCase();
            const overCap = instances.find((i) => i.name.trim().toLowerCase() === trackKey && i.stacks > leveledTrack.max);
            if (overCap) {
              throw new BadRequestException(
                `${leveledTrack.name} level (${overCap.stacks}) must be in [0, ${leveledTrack.max}]`,
              );
            }
          }

          const derived = deriveConditionNames(instances);
          afterConditions = new Set(derived);
          Object.assign(writeSet, conditionWriteSetFromInstances(instances));
        }
        if (patch.eac !== undefined && isDm) writeSet.eac = patch.eac;
        if (patch.kac !== undefined && isDm) writeSet.kac = patch.kac;
        if (patch.spSet !== undefined) writeSet.spCurrent = patch.spSet;
        else if (patch.spDelta !== undefined) writeSet.spCurrent = Math.max(0, Math.min(fresh.spMax, fresh.spCurrent + patch.spDelta));
        if (patch.rpSet !== undefined) writeSet.rpCurrent = patch.rpSet;
        else if (patch.rpDelta !== undefined) writeSet.rpCurrent = Math.max(0, Math.min(fresh.rpMax, fresh.rpCurrent + patch.rpDelta));
        if (patch.deathState !== undefined) writeSet.deathState = patch.deathState;

        if (recomputeHp) {
          const effectiveHpMax = hpMaxChanged ? Math.max(1, patch.hpMax!) : fresh.hpMax;
          const isDnd5e = adapter.id === DND5E_ADAPTER_ID;
          const shouldCheckConcentration =
            isDnd5e && patch.hpSet === undefined && patch.hpDelta !== undefined && patch.hpDelta < 0;
          const turnState = parseTurnState(fresh.turnState);
          // Issue #1452: concentration check/break knowledge is computed after the HP result
          // so that absolute hpSet and explicit deathState transitions can break too.
          const state: CombatantHpState = {
            kind: fresh.kind as CombatantHpState['kind'],
            hpCurrent: fresh.hpCurrent,
            hpMax: effectiveHpMax,
            hpTemp: fresh.hpTemp,
            deathState: patch.deathState !== undefined ? (patch.deathState as CombatantHpState['deathState']) : (fresh.deathState as CombatantHpState['deathState']),
            deathSaveSuccesses: fresh.deathSaveSuccesses,
            deathSaveFailures: fresh.deathSaveFailures,
            isConcentrating: false,
          };
          const effectiveHpDelta = (() => {
            if (patch.hpDelta === undefined || patch.hpDelta >= 0) return patch.hpDelta;
            // A crit adds the rolled dice once more; flat modifiers remain single-counted.
            const criticalTotal = -patch.hpDelta + (patch.isCrit ? patch.damageDice ?? 0 : 0);
            const { final, applied } = applyDamageModifiers(
              criticalTotal,
              damageType ?? '',
              // Untyped damage cannot use a defence, so avoid an unnecessary statblock
              // lookup for the tracker’s frequent raw HP adjustments.
              damageType
                ? this.targetDamageDefenses(
                    fresh,
                    adapter.damageTypes?.length ? adapter.damageTypes : undefined,
                    tx,
                  )
                : { resistances: [], vulnerabilities: [], immunities: [] },
              { half: patch.saveOutcome === 'half' },
            );
            if (damageMetadataTouched) {
              const type = damageType ?? 'untyped';
              const parts = [`${criticalTotal} ${type}`];
              if (patch.isCrit) parts.push('critical');
              if (patch.saveOutcome === 'half') parts.push('saved for half');
              if (applied !== 'normal' && !(patch.saveOutcome === 'half' && applied === 'halved')) {
                parts.push(applied === 'halved' ? 'halved' : applied);
              }
              directDamageSummary = parts.join(', ');
            }
            return -final;
          })();
          const result = applyCombatantHp(
            state,
            {
              hpDelta: effectiveHpDelta,
              hpSet: patch.hpSet,
              hpTemp: patch.hpTemp,
              deathSaveSuccesses: patch.deathSaveSuccesses,
              deathSaveFailures: patch.deathSaveFailures,
              deathSaveRoll: patch.deathSaveRoll,
            },
            // #1503 — route the HP/death model through the adapter so a system without 5e
            // death saves never has them written to its combatants.
            hpModelForAdapter(adapter),
          );
          if (patch.deathState !== undefined) {
            result.deathState = patch.deathState as any;
          }

          // If Starfinder adapter or SP present, damage flows through temp HP -> SP -> HP
          if (adapter.id === STARFINDER_ADAPTER_ID && effectiveHpDelta !== undefined && effectiveHpDelta < 0) {
            const sfResult = applyStarfinderDamage(
              {
                hpCurrent: fresh.hpCurrent,
                hpMax: effectiveHpMax,
                spCurrent: fresh.spCurrent,
                spMax: fresh.spMax,
                rpCurrent: fresh.rpCurrent,
                rpMax: fresh.rpMax,
                hpTemp: fresh.hpTemp,
                deathState: patch.deathState !== undefined ? (patch.deathState as any) : (fresh.deathState as any),
              },
              -effectiveHpDelta,
            );
            writeSet.spCurrent = sfResult.spCurrent;
            writeSet.rpCurrent = sfResult.rpCurrent;
            result.hpCurrent = sfResult.hpCurrent;
            result.hpTemp = sfResult.hpTemp;
            result.deathState = patch.deathState !== undefined ? patch.deathState : sfResult.deathState;
          }

          // Issue #1452: concentration auto-break is 5e-only and must be evaluated against
          // the final HP/death state after Starfinder SP absorption has routed the damage.
          // It also triggers on an explicit hpSet to 0 or a deathState transition to dying/dead.
          const freshIsDown = fresh.hpCurrent === 0 || fresh.deathState === 'dying' || fresh.deathState === 'dead';
          const resultIsDown = result.hpCurrent === 0 || result.deathState === 'dying' || result.deathState === 'dead';
          const willBreakConcentration = isDnd5e && resultIsDown && !freshIsDown;
          const needsConcentrationCheck = shouldCheckConcentration || willBreakConcentration;
          const isConcentrating =
            needsConcentrationCheck &&
            (turnState.concentration != null ||
              tx
                .select({
                  conditionInstances: combatants.conditionInstances,
                  conditions: combatants.conditions,
                })
                .from(combatants)
                .where(eq(combatants.encounterId, encounterId))
                .all()
                .some((candidate) =>
                  parseConditionInstances(candidate.conditionInstances, fromJsonText<string[]>(candidate.conditions, [])).some(
                    (condition) => condition.isConcentration && condition.sourceCombatantId === combatantId,
                  ),
                ));
          if (shouldCheckConcentration) {
            const damage = effectiveHpDelta !== undefined && effectiveHpDelta < 0 ? -effectiveHpDelta : 0;
            result.concentrationCheck = concentrationCheckForDamage(isConcentrating, damage);
          }
          const concentrationBroken = willBreakConcentration && isConcentrating;
          if (concentrationBroken) {
            // Issue #1902 rework (round 22, codex P2): a concentration cascade off this
            // combatant's own HP change can mirror a DIFFERENT character's sheet — fold
            // that into the flag this method's own `encounter.updated` emission reports.
            const { removed, casterInstances, sheetMirrored: cascadeSheetMirrored } = this.breakConcentration(tx, encounterId, combatantId, turnState, true);
            if (cascadeSheetMirrored) combatantSheetMirrored = true;
            concentrationCascades = removed;
            writeSet.turnState = toJsonText(turnState);
            if (conditionFieldsTouched) {
              const existingInstances = parseConditionInstances(
                writeSet.conditionInstances ?? null,
                fromJsonText<string[]>(writeSet.conditions, []),
              );
              const filteredInstances = existingInstances.filter(
                (i) => !(i.isConcentration && i.sourceCombatantId === combatantId),
              );
              const { conditions, conditionInstances } = conditionWriteSetFromInstances(filteredInstances);
              writeSet.conditions = conditions;
              writeSet.conditionInstances = conditionInstances;
            } else {
              const { conditions, conditionInstances } = conditionWriteSetFromInstances(casterInstances ?? []);
              writeSet.conditions = conditions;
              writeSet.conditionInstances = conditionInstances;
              conditionFieldsTouched = true;
              beforeConditions = new Set(
                deriveConditionNames(parseConditionInstances(fresh.conditionInstances, fromJsonText<string[]>(fresh.conditions, []))),
              );
              afterConditions = new Set(deriveConditionNames(casterInstances ?? []));
            }
          } else if (shouldCheckConcentration && result.concentrationCheck) {
            const queued = enqueueConcentrationCheck(turnState, {
              id: `damage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
              ...result.concentrationCheck,
            });
            writeSet.turnState = toJsonText(queued);
          }

          if (hpMaxChanged) writeSet.hpMax = effectiveHpMax;
          writeSet.hpCurrent = result.hpCurrent;
          writeSet.hpTemp = result.hpTemp;
          writeSet.deathState = patch.deathState !== undefined ? patch.deathState : result.deathState;
          writeSet.deathSaveSuccesses = result.deathSaveSuccesses;
          writeSet.deathSaveFailures = result.deathSaveFailures;
        }
        const [updated] = tx.update(combatants).set(writeSet).where(eq(combatants.id, combatantId)).returning().all();
        row = updated;
        // A removal undo may only rewind an untouched turn snapshot. Keep this
        // ABA guard separate from turnVersion: ordinary HP/token/condition writes
        // must not invalidate a player's already-previewed action.
        if (freshEncounter.status === 'running') {
          tx.update(encounters)
            .set({
              combatantStateVersion: sql`${encounters.combatantStateVersion} + 1`,
              updatedAt: nextUpdatedAt(freshEncounter.updatedAt),
            })
            .where(eq(encounters.id, encounterId))
            .run();
        } else {
          tx.update(encounters)
            .set({ updatedAt: nextUpdatedAt(freshEncounter.updatedAt) })
            .where(eq(encounters.id, encounterId))
            .run();
        }
        afterHp = updated.hpCurrent;
        afterTemp = updated.hpTemp;
        afterDeath = updated.deathState;
        afterSucc = updated.deathSaveSuccesses;
        afterFail = updated.deathSaveFailures;
        if (conditionFieldsTouched) {
          afterConditions = new Set(fromJsonText<string[]>(updated.conditions, []));
        }
        if (mirrorSheet) {
          // Issue #1902 rework (round 13, codex P2 sweep): read the character's CURRENT
          // `updatedAt` here, inside the transaction, rather than reusing `character` (read
          // pre-transaction, via an earlier `await` — the same stale-snapshot gap fixed
          // elsewhere in this rework). `nextUpdatedAt`, not `nowIso()`, for the same reason
          // every other `characters` table writer in this rework needs it: this column is
          // the CAS token `patchSpellSlots`'s `expectedUpdatedAt` guard depends on.
          const priorCharUpdatedAt = tx.select({ updatedAt: characters.updatedAt }).from(characters).where(eq(characters.id, existing.characterId!)).get()?.updatedAt;
          const mirroredAt = nextUpdatedAt(priorCharUpdatedAt ?? nowIso());
          const sheetSet: Partial<typeof characters.$inferInsert> = { updatedAt: mirroredAt };
          if (recomputeHp || spFieldsTouched || deathStateTouched) {
            sheetSet.hpCurrent = updated.hpCurrent;
            sheetSet.hpTemp = updated.hpTemp;
            sheetSet.spCurrent = updated.spCurrent;
            sheetSet.spMax = updated.spMax;
            sheetSet.rpCurrent = updated.rpCurrent;
            sheetSet.rpMax = updated.rpMax;
            sheetSet.deathState = updated.deathState;
            sheetSet.deathSaveSuccesses = updated.deathSaveSuccesses;
            sheetSet.deathSaveFailures = updated.deathSaveFailures;
          }
          if (conditionFieldsTouched) {
            // #1047: the sheet gets the structured copy too, with round-scoped fields
            // stripped. Writing only the names here would recreate the #423 desync one
            // table over — see common/conditions.ts.
            Object.assign(
              sheetSet,
              sheetConditionWriteSetFromInstances(
                readConditionInstances(updated.conditionInstances, updated.conditions),
              ),
            );
          }
          tx.update(characters)
            .set(sheetSet)
            .where(eq(characters.id, existing.characterId!))
            .run();
          tx.update(combatants)
            .set({ sheetSyncedUpdatedAt: mirroredAt })
            .where(eq(combatants.id, combatantId))
            .run();
        }

        options?.afterWriteInTransaction?.(tx, combatantToDomain(row), fresh, freshEncounter);

        // The claim lands LAST but in the SAME transaction as everything above, carrying the
        // exact response body this call will return. Both commit or neither does — there is
        // no instant at which the effect exists without its key (double-apply on retry) or
        // the key exists without its effect (a retry blocked from ever applying).
        if (opClaim) {
          const committed = combatantToDomain(row);
          recordEncounterOp(tx, opClaim, nowIso(), {
            body: options?.operationResponse ? options.operationResponse(committed) : committed,
            role,
          });
        }
      });
    } catch (err) {
      if (err instanceof EncounterOpRaceMarker) {
        // Two concurrent attempts of the SAME intent: ours rolled back, theirs committed.
        // Replay their response so exactly one apply survives (issue #580), re-deriving
        // for the caller's current role (issue #1990).
        const prior = await readEncounterOpAfterRace(this.db, err.claim);
        const replayed = await resolveReplay(prior);
        if (replayed) return replayed;
        throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
      }
      throw err;
    }

    // An idempotent replay stops here: no second audit row, no duplicate combat-log
    // events, no second SSE nudge — the first attempt already produced all of those.
    if (priorFromReplay) {
      const replayedCombatant = await resolveReplay(priorFromReplay);
      if (replayedCombatant) return replayedCombatant;
      throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
    }

    // #74: don't audit-log pure HP ticks. A single combat generates hundreds of
    // ±1 HP updates (every hit, heal, temp-hp adjust); auditing each one was the
    // dominant source of unbounded audit_log growth for zero forensic value. We
    // still log the meaningful state changes — conditions, initiative, and the
    // identity edits (rename / hpMax / initMod, issue #114) — which are rare and
    // worth a trail. An update that ONLY touched HP/death-save fields is skipped.
    // `statblock`, `eac`, and `kac` are listed off `patch`, not `staticUpdate`: they are the
    // writable fields that never enter `staticUpdate` at all (they go straight onto `writeSet`
    // inside the transaction), which is the same asymmetry that let an armour-class-only PATCH
    // silently persist nothing before this PR. Fixing that made such a patch a real domain
    // write, and a real domain write must be audited — AGENTS.md is unconditional about that,
    // and #74's exemption is scoped to high-frequency HP/death-save ticks, which identity-like
    // defence and statblock edits are not. Gated on `isDm` to match the write exactly, so a
    // rejected non-DM patch cannot mint an audit row for a change that never happened.
    const defenseOrStatblockChanged =
      isDm && (patch.statblock !== undefined || patch.eac !== undefined || patch.kac !== undefined);
    const changedNonHp =
      conditionFieldsTouched ||
      staticUpdate.initiative !== undefined ||
      staticUpdate.name !== undefined ||
      staticUpdate.initMod !== undefined ||
      staticUpdate.statblockRevealed !== undefined ||
      actionUsesPatch !== null ||
      defenseOrStatblockChanged ||
      hpMaxChanged;
    if (changedNonHp) {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.combatant.update',
        entityType: 'combatant',
        entityId: combatantId,
        campaignId: encounterRow.campaignId,
        detail: JSON.stringify(patch),
      });
    }

    // Persistent combat-log events (issue #61). Appended AFTER the write commits — a
    // log-append failure must never roll back a legitimate HP/condition mutation. All
    // phrasing records only deltas (never a monster's exact HP total), so the list
    // endpoint stays member-visible without leaking issue #43's redaction.
    const round = encounterRow.round;
    const targetName = row.name;

    // Issue #1926: log the statblock reveal toggle. `detail` deliberately omits the
    // combatant's name (issue #869 convention — never interpolate names into `detail`,
    // only `target`/`targetId`) so a non-DM's redacted listing composes the same
    // "<name> ...detail" phrasing as every other combat-log line.
    if (staticUpdate.statblockRevealed !== undefined && staticUpdate.statblockRevealed !== existing.statblockRevealed) {
      await this.appendEvent(encounterId, round, 'note', {
        target: targetName,
        targetId: combatantId,
        detail: staticUpdate.statblockRevealed ? "'s statblock is revealed to players" : "'s statblock is hidden again",
      });
    }

    // Issue #1921: log the DM's manual override of an action's limited-use/recharge spend.
    // The ability's NAME is deliberately omitted for the same reason as the turn-start
    // recharge log (see `rechargeRolls` in nextTurn): the combat log is readable by every
    // campaign member, `redactEncounterEventsForViewer` masks only hidden-combatant
    // identity rather than action names, and this fires for a monster whose statblock may
    // be deliberately unrevealed (#1926). `actionUsesLabel` is still resolved — it gates
    // whether the event is written at all — but only the COMBATANT lands on the event.
    if (actionUsesPatch && actionUsesLabel) {
      await this.appendEvent(encounterId, round, 'resource_changed', {
        target: targetName,
        targetId: combatantId,
        detail: 'limited-use ability uses set by DM',
      });
    }

    // Issue #620: attribute HP/death events to the attacker so the log reads "Ember hit
    // Goblin 3 for 8" rather than just "Goblin 3 took 8 damage". Resolution order:
    //   1. explicit numeric `actorId` on the patch (the apply-damage caller knows who swung);
    //   2. the running encounter's current-turn combatant (the default attacker) — only
    //      when `actorId` was omitted;
    //   3. nothing — fall back to the original target-only phrasing.
    // Tri-state: omit → current-turn fallback; `actorId: null` → suppress attribution;
    // number → that combatant. The actor is only attached when it differs from the
    // target: self-damage (Ember smiting Ember) or the monster being on its own turn
    // otherwise collapses to "Ember: took 8 damage" — worse than the unattributed
    // "Ember took 8 damage" the existing log produced. An explicit actorId referencing
    // a combatant NOT in this encounter is dropped (the lookup returns null) so a stale
    // client can't pollute the log with a phantom name; it doesn't 400, mirroring how
    // other optional metadata is best-effort rather than fail-loud.
    const actor = await this.resolveCombatLogActor(encounterId, patch.actorId, encounterRow.currentCombatantId, combatantId);
    const actorName = actor?.name ?? null;
    const actorCombatantId = actor?.id ?? null;
    const targetCombatantId = combatantId;
    // Issue #580: stamp the operation id onto the events this write produces. "Was that
    // 8 damage one hit or a retry that landed twice?" is exactly the question the log
    // could not previously answer — two identical lines a second apart looked the same
    // whether they were two swings or one swing double-applied. With the id present,
    // duplicate lines sharing an operationId would be a bug signature, and its absence
    // across two lines proves two distinct intents.
    const opMeta: EncounterEventMetadata | undefined = patch.idempotencyKey
      ? { operationId: patch.idempotencyKey }
      : undefined;

    // HP damage/heal — only when an HP change was actually requested (not a pure temp-HP
    // grant or a death-save toggle). Compare the TOTAL pool (hp + temp) so temp-HP
    // absorption shows as the real change; record only the magnitude.
    if (patch.hpDelta !== undefined || patch.hpSet !== undefined) {
      const poolDelta = afterHp + afterTemp - (beforeHp + beforeTemp);
      if (poolDelta < 0 || directDamageSummary !== null) {
        await this.appendEvent(encounterId, round, 'damage', {
          actor: actorName,
          target: targetName,
          actorId: actorCombatantId,
          targetId: targetCombatantId,
          detail: `took ${Math.max(0, -poolDelta)} damage${directDamageSummary ? ` (${directDamageSummary})` : ''}`,
          metadata: opMeta,
        });
      } else if (poolDelta > 0) {
        await this.appendEvent(encounterId, round, 'heal', {
          actor: actorName,
          target: targetName,
          actorId: actorCombatantId,
          targetId: targetCombatantId,
          detail: `healed ${poolDelta} HP`,
          metadata: opMeta,
        });
      }
    }

    // Death — a character reaching `dead` (3 failed saves / massive damage), or a monster
    // dropping to 0 HP (monsters don't roll saves; 0 HP is simply "down"). Attribute the
    // kill when the attacker is known and distinct (issue #620), so a recap can say who
    // felled the boss rather than only that it dropped.
    if (!options?.deathSaveEventsInTransaction && afterDeath === 'dead' && beforeDeath !== 'dead') {
      await this.appendEvent(encounterId, round, 'death', {
        actor: actorName,
        target: targetName,
        actorId: actorCombatantId,
        targetId: targetCombatantId,
        detail: 'died',
      });
    } else if ((existing.kind === 'monster' || existing.kind === 'npc') && afterHp <= 0 && beforeHp > 0) {
      await this.appendEvent(encounterId, round, 'death', {
        actor: actorName,
        target: targetName,
        actorId: actorCombatantId,
        targetId: targetCombatantId,
        detail: 'dropped to 0 HP',
      });
    }

    // A rolled death save (issue #619) — record the roll + its 5e outcome so the combat
    // log shows the provenance of a sudden two-failure nat 1 or a nat-20 revival. The
    // death event above already fires if the roll killed or the revival shows as HP gain;
    // this line adds the roll itself.
    // death save event logging (issue #424).
    if (patch.deathSaveRoll !== undefined && !options?.deathSaveEventsInTransaction) {
      const die = patch.deathSaveRoll;
      await this.appendEvent(encounterId, round, 'roll', {
        target: targetName,
        targetId: targetCombatantId,
        detail: deathSaveRollEventDetail(die, afterSucc, afterFail, beforeDeath, afterDeath),
      });
    } else if (
      (patch.deathSaveSuccesses !== undefined && afterSucc !== _beforeSucc) ||
      (patch.deathSaveFailures !== undefined && afterFail !== _beforeFail)
    ) {
      // Only log a counter override when the counters actually changed — otherwise a non-5e
      // table's idempotent snapshot save (or a clear that the no-death-saves branch left untouched)
      // would log a misleading "counters edited" event (#1503, Devin review #1812).
      await this.appendEvent(encounterId, round, 'override', {
        target: targetName,
        targetId: targetCombatantId,
        detail: `death save counters edited: ${afterSucc} succ / ${afterFail} fail`,
      });
    }

    if (patch.deathState !== undefined && beforeDeath !== afterDeath) {
      let stateMsg = `death state changed to ${afterDeath}`;
      if (afterDeath === 'stable') stateMsg = 'marked stable at 0 HP';
      if (afterDeath === 'dying') stateMsg = 'became dying (un-stabilized)';
      if (afterDeath === 'dead') stateMsg = 'marked dead';
      await this.appendEvent(encounterId, round, 'condition', {
        target: targetName,
        targetId: targetCombatantId,
        detail: stateMsg,
      });
    }

    // Conditions actually changed (adding an already-present, or removing an absent one,
    // is a no-op and not logged). Derived from the committed before/after snapshots
    // captured inside the transaction (issue #747) — NOT the pre-await `existing`
    // read — so a condition that a concurrent writer added/removed between the stale
    // read and the tx is attributed correctly (or recognized as a no-op by this
    // caller). Logging the symmetric difference of the two committed sets means a
    // retry that landed nothing new logs nothing, while a real concurrent change
    // still logs exactly the conditions this caller's delta flipped.
    if (conditionFieldsTouched) {
      for (const c of afterConditions) {
        if (!beforeConditions.has(c)) {
          await this.appendEvent(encounterId, round, 'condition', {
            target: targetName,
            targetId: targetCombatantId,
            detail: `gained ${c}`,
          });
        }
      }
      for (const c of beforeConditions) {
        if (!afterConditions.has(c)) {
          await this.appendEvent(encounterId, round, 'condition', {
            target: targetName,
            targetId: targetCombatantId,
            detail: `cleared ${c}`,
          });
        }
      }
    }

    // Issue #1452: concentration-sourced conditions that were removed from OTHER combatants
    // when this combatant's concentration broke. The caster's own condition deltas are already
    // covered by the before/after set above, but every affected target gets its own log line.
    for (const cascade of concentrationCascades) {
      if (cascade.combatantId === combatantId) continue;
      await this.appendEvent(encounterId, round, 'condition', {
        actor: targetName,
        actorId: targetCombatantId,
        target: cascade.combatantName,
        targetId: cascade.combatantId,
        detail: `condition expired: ${cascade.condition.name} (concentration broken)`,
      });
    }

    // Reconcile the turn pointer after an initiative write while combat is running
    // (issue #715). Clearing a combatant's initiative (or rewriting it) re-sorts the
    // running order: a cleared combatant sinks below everyone with a roll (see
    // sortCombatants), and a rewritten value may move it up or down. The current-turn
    // pointer is IDENTITY-based (issue #49) so it stays pointing at the right actor,
    // but the denormalized `turnIndex` is positional and would otherwise drift out of
    // lockstep with the new sort. Re-derive it against the post-write order so clients
    // that key off turnIndex (the highlight ring, the "next turn" target) stay aligned.
    // Clearing the CURRENT actor's own initiative is intentional and does NOT advance
    // the turn — its identity pointer survives, it just slides down the order.
    if (encounterRow.status === 'running' && staticUpdate.initiative !== undefined) {
      const adapter = await this.adapterForCampaign(encounterRow.campaignId);
      const sortedAfter = this.sortCombatantsWithAdapter(
        (await this.listCombatantRows(encounterId)).map(combatantToDomain),
        'running',
        adapter,
      );
      const turnIndex = turnIndexFor(sortedAfter, encounterRow.currentCombatantId);
      // Issue #1902 rework (round 23, codex P2): this write lands AFTER the transaction
      // above already committed (and after the awaited adapter/roster lookups just above),
      // so `encounterRow.updatedAt` captured at the top of this method is stale — the
      // transaction's own write already advanced it via `nextUpdatedAt`, which can land
      // STRICTLY AHEAD of wall-clock `now` on a same-millisecond collision (see
      // `nextUpdatedAt`'s own doc comment). A bare `nowIso()` here would not just fail to
      // advance the token — it can tie or roll it BACKWARD relative to that already-committed
      // value. That regression is exactly the defect `CharactersService.update()` fixed for
      // the `characters.updatedAt` CAS token (issue #1902 rework, round 12/15: re-read the
      // row fresh and derive the next token from THAT, never from the wall clock alone) —
      // applied here to the identical `encounters.updatedAt` token so the two mirror the same
      // rule. Without this, a client holding an older `expectedUpdatedAt` (from before the
      // transaction's own change) could pass `assertNotStale` against this rolled-back value
      // and silently overwrite that change with a stale whole-statblock PATCH.
      const [freshEncounterRow] = await this.db.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).limit(1);
      await this.db
        .update(encounters)
        .set({ turnIndex, updatedAt: nextUpdatedAt(freshEncounterRow?.updatedAt ?? encounterRow.updatedAt) })
        .where(eq(encounters.id, encounterId));
    }

    // Issue #1902 rework (round 21, codex P2 sweep continuation): tag this frame the same
    // way `apply()`/`undo()`/`adjustCombatantResource` do (see `sheetMirrored`'s schema doc
    // comment) — a combatant HP/condition/death-state PATCH mirrors onto a linked character
    // sheet whenever `combatantSheetMirrored` is true, so the client's `campaignCharacters`
    // invalidation needs to fire for THIS write too, not just the other three.
    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, encounterRow.hidden, { sheetMirrored: combatantSheetMirrored });

    if (row.kind === 'character' && row.characterId) {
      if (beforeDeath !== 'dead' && afterDeath === 'dead') {
        this.notifications.notifyCampaign(encounterRow.campaignId, user, {
          type: 'character_downed',
          title: 'Character died!',
          body: `${row.name} has died in combat.`,
          entityType: 'encounter',
          entityId: encounterId,
        }).catch(() => {});
      } else if (beforeHp > 0 && afterHp === 0 && afterDeath !== 'dead') {
        this.notifications.notifyCampaign(encounterRow.campaignId, user, {
          type: 'character_downed',
          title: 'Character downed!',
          body: `${row.name} was downed in combat.`,
          entityType: 'encounter',
          entityId: encounterId,
        }).catch(() => {});
      }
    }

    return combatantToDomain(row);
  }

  async removeCombatant(encounterId: number, combatantId: number, user: RequestUser, role: Role, idempotencyKey?: string): Promise<CombatantRemoveResult> {
    // Retry keys identify a request; the server still mints the separate, opaque
    // capability used to undo it.
    const actorId = user.id;
    const undoToken = randomUUID();
    let receiptUndoToken = undoToken;
    const now = nowIso();
    // UI offers Undo for seven seconds; retain the opaque server token longer so a
    // click at the end of that window survives ordinary network latency.
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    let emittedEncounter!: typeof encounters.$inferSelect;
    let emittedTurnChange: {
      round: number;
      turnIndex: number;
      currentCombatantId: number | null;
      combatantKind: Combatant['kind'] | null;
    } | null = null;
    let replayed = false;
    let removedConcentrationCascades: { combatantId: number; combatantName: string; condition: ConditionInstance }[] = [];

    this.db.transaction((tx) => {
      // Both the transition and its undo snapshots must use one current encounter and
      // roster view; an earlier device must never overwrite a newer turn transition.
      const freshEncounter = tx.select().from(encounters).where(eq(encounters.id, encounterId)).get();
      if (!freshEncounter) throw new NotFoundException(`Encounter ${encounterId} not found`);
      // Short-lived undo capabilities expire after 30 seconds, but idempotency receipts
      // (requestKey) must be retained for 24h so retried DELETE requests replay their original
      // response instead of re-executing against a restored combatant.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      tx.delete(combatantRemovalUndos)
        .where(or(
          and(lte(combatantRemovalUndos.expiresAt, now), isNull(combatantRemovalUndos.requestKey)),
          lte(combatantRemovalUndos.createdAt, twentyFourHoursAgo),
        ))
        .run();
      const prior = idempotencyKey
        ? tx.select().from(combatantRemovalUndos).where(and(
          eq(combatantRemovalUndos.requestKey, idempotencyKey),
          eq(combatantRemovalUndos.actorId, actorId),
          eq(combatantRemovalUndos.encounterId, encounterId),
        )).get()
        : undefined;
      if (prior) {
        if (prior.combatantId !== combatantId) throw new ConflictException('Idempotency key was reused for a different combatant removal');
        // A key identifies the original DELETE request, not an open removal window.
        // Undo can consume its capability while a delayed client retry is in flight; that
        // retry must replay its original response rather than delete the restored row.
        receiptUndoToken = prior.token as typeof undoToken;
        replayed = true;
        emittedEncounter = freshEncounter;
        return;
      }
      this.assertMutable(freshEncounter);
      this.assertCampaignWritableInTx(tx, freshEncounter.campaignId);
      const campaign = tx
        .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
        .from(campaigns)
        .where(eq(campaigns.id, freshEncounter.campaignId))
        .get();
      const adapter = ruleSystemAdapter(
        campaign?.ruleSystem,
        fromJsonText<HomebrewMechanicsProfile | null>(campaign?.customMechanicsProfile, null),
      );
      const roster = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all();
      const snapshot = roster.find((row) => row.id === combatantId);
      if (!snapshot) throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
      const sheetAtRemoval = snapshot.characterId == null
        ? null
        : tx.select().from(characters).where(eq(characters.id, snapshot.characterId)).get() ?? null;
      const sheetUpdatedAtAtRemoval = sheetAtRemoval?.updatedAt ?? null;
      // A sheet's revision includes unrelated fields (such as its name or notes).
      // Keep the sheet-owned values at removal time so undo can merge only values
      // that actually changed during its short recovery window.
      const sheetStateAtRemoval = sheetAtRemoval == null ? null : {
        hpCurrent: sheetAtRemoval.hpCurrent,
        hpMax: sheetAtRemoval.hpMax,
        hpTemp: sheetAtRemoval.hpTemp,
        spCurrent: sheetAtRemoval.spCurrent,
        spMax: sheetAtRemoval.spMax,
        rpCurrent: sheetAtRemoval.rpCurrent,
        rpMax: sheetAtRemoval.rpMax,
        deathState: sheetAtRemoval.deathState,
        deathSaveSuccesses: sheetAtRemoval.deathSaveSuccesses,
        deathSaveFailures: sheetAtRemoval.deathSaveFailures,
        conditions: sheetAtRemoval.conditions,
        conditionInstances: sheetAtRemoval.conditionInstances,
      };

      const runningAdapter = freshEncounter.status === 'running' ? adapter : null;
      let newCurrentId = freshEncounter.currentCombatantId;
      let wrappedToNextRound = false;
      let turnPhase = (freshEncounter.turnPhase as EncounterTurnPhase) ?? 'combatant';
      let lairResumeCombatantId = freshEncounter.lairResumeCombatantId === combatantId
        ? null
        : freshEncounter.lairResumeCombatantId;
      let startingAfterRemoval: Combatant | null = null;
      let startedCombatantSnapshot: Pick<typeof combatants.$inferSelect, 'id' | 'turnState' | 'conditions' | 'conditionInstances'> | null = null;
      const roundLegendarySnapshots: Array<Pick<typeof combatants.$inferSelect, 'id' | 'turnState'>> = [];
      const statblocks = new Map<number, ReturnType<RuleSystemAdapter['mapStatblock']>>();
      const replacingLairResume = runningAdapter
        && freshEncounter.turnPhase === 'lair'
        && freshEncounter.lairResumeCombatantId === combatantId;
      if (runningAdapter && (freshEncounter.currentCombatantId === combatantId || replacingLairResume)) {
        const sorted = this.sortCombatantsWithAdapter(roster.map(combatantToDomain), 'running', runningAdapter);
        const ruleEntryIds = [...new Set(sorted.map((c) => c.ruleEntryId).filter((id): id is number => id !== null))];
        if (ruleEntryIds.length > 0) {
          const entries = tx.select({ id: ruleEntries.id, dataJson: ruleEntries.dataJson }).from(ruleEntries)
            .where(and(inArray(ruleEntries.id, ruleEntryIds), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, freshEncounter.campaignId)))).all();
          for (const entry of entries) statblocks.set(entry.id, runningAdapter.mapStatblock(fromJsonText<Record<string, unknown>>(entry.dataJson ?? null, {})));
        }
        // Keep the removed actor in the ordered list so the pure helper can locate the
        // successor, but make it ineligible for selection just as the post-delete roster
        // would be. This preserves skip/lair semantics without ever persisting its id.
        const advanceRoster = sorted.map((combatant) => combatant.id === combatantId
          ? { ...combatant, hpCurrent: 0, deathState: combatant.kind === 'character' ? 'dead' : combatant.deathState }
          : combatant);
        if (freshEncounter.currentCombatantId === combatantId) {
          const advanced = advanceEncounterTurn(advanceRoster, combatantId, freshEncounter.round, turnPhase, encounterHasLairSlotFromStatblocks(statblocks), lairResumeCombatantId);
          newCurrentId = advanced.currentCombatantId;
          // Lair entry retains the round returned by the basic transition but
          // deliberately reports no wrap: the lair action itself is still part
          // of that next round. Derive the removal's round boundary from the
          // resulting round so escalation and legendary refresh stay aligned.
          wrappedToNextRound = advanced.round > freshEncounter.round;
          turnPhase = advanced.phase;
          lairResumeCombatantId = advanced.lairResumeCombatantId;
          startingAfterRemoval = advanced.phase === 'combatant' && advanced.currentCombatantId !== null
            ? advanceRoster.find((combatant) => combatant.id === advanced.currentCombatantId) ?? null
            : null;
        } else {
          // A lair slot resumes after the actor it points to. If that actor is
          // removed, select its successor through advanceTurn so dead/downed rows
          // are skipped rather than using the lair helper's legacy raw fallback.
          const resumed = advanceTurn(advanceRoster, combatantId, freshEncounter.round);
          lairResumeCombatantId = resumed.currentCombatantId;
          // No eligible actor means there is no lair slot to resume. Exit it now
          // rather than letting the next advance use the lair helper's raw fallback.
          if (resumed.currentCombatantId === null) turnPhase = 'combatant';
        }
      }
      let afterEncounter = {
        currentCombatantId: newCurrentId,
        turnIndex: freshEncounter.turnIndex,
        round: freshEncounter.round,
        escalationDie: freshEncounter.escalationDie,
        escalationDieHistory: freshEncounter.escalationDieHistory,
        lairResumeCombatantId,
        turnPhase,
      };
      // Persist a scalar expected version with the undo snapshot. The database
      // update below still uses an expression for the actual increment.
      const afterTurnVersion = freshEncounter.turnVersion + (runningAdapter && freshEncounter.currentCombatantId === combatantId ? 1 : 0);
      const afterCombatantStateVersion = freshEncounter.combatantStateVersion + (runningAdapter ? 1 : 0);
      let turnVersionUpdate: { turnVersion?: SQL } = {};
      // Turn timer (issue #1935 review — Devin): removing the CURRENT combatant is a genuine
      // turn transition (advanceEncounterTurn runs, turnVersion bumps, encounter.turn_changed
      // fires) even though this method isn't named like a turn-advance one. Restamp alongside
      // turnVersionUpdate below — same gate, same reasoning — so the new turn's chip doesn't
      // keep accumulating the removed combatant's elapsed time.
      let turnRestampUpdate: { turnStartedAt?: string } = {};
      let escalation: ReturnType<EncountersService['nextEscalationState']> | null = null;
      if (runningAdapter) {
        const sortedAfter = this.sortCombatantsWithAdapter(
          roster.filter((row) => row.id !== combatantId).map(combatantToDomain),
          'running',
          runningAdapter,
        );
        const round = wrappedToNextRound ? freshEncounter.round + 1 : freshEncounter.round;
        escalation = this.nextEscalationState(runningAdapter, freshEncounter, round, 'round');
        afterEncounter = {
          currentCombatantId: newCurrentId,
          turnIndex: turnIndexFor(sortedAfter, newCurrentId),
          round,
          escalationDie: escalation.escalationDie,
          escalationDieHistory: escalation.escalationDieHistory ?? freshEncounter.escalationDieHistory,
          lairResumeCombatantId,
          turnPhase,
        };
        // Only removal of the active combatant changes the logical turn. Removing
        // someone else and initiative re-sorts keep active player previews valid.
        // Keep this SQL expression out of the persisted undo snapshot.
        if (freshEncounter.currentCombatantId === combatantId) {
          turnVersionUpdate = { turnVersion: sql`${encounters.turnVersion} + 1` };
          turnRestampUpdate = { turnStartedAt: now };
          // A removal can advance the active actor just like endTurn. Preserve that
          // turn edge for connected clients, including a lair transition with no
          // current combatant, while ordinary roster edits remain updated-only.
          emittedTurnChange = {
            round: afterEncounter.round,
            turnIndex: afterEncounter.turnIndex,
            currentCombatantId: afterEncounter.currentCombatantId,
            combatantKind: startingAfterRemoval?.kind ?? null,
          };
        }
      }

      // Issue #1452: before deleting a concentrating combatant, break its concentration so
      // condition instances it was sustaining on other combatants are not left orphaned.
      const isConcentrating =
        parseTurnState(snapshot.turnState).concentration != null ||
        roster.some((row) =>
          parseConditionInstances(row.conditionInstances, fromJsonText<string[]>(row.conditions, [])).some(
            (condition) => condition.isConcentration && condition.sourceCombatantId === combatantId,
          ),
        );
      if (isConcentrating) {
        const { removed } = this.breakConcentration(tx, encounterId, combatantId, null, true);
        removedConcentrationCascades = removed.filter((r) => r.combatantId !== combatantId);
      }

      tx.delete(combatants).where(eq(combatants.id, combatantId)).run();
      if (wrappedToNextRound) {
        for (const row of roster) {
          if (row.id === combatantId || row.ruleEntryId === null) continue;
          const mapped = statblocks.get(row.ruleEntryId);
          if (!mapped || !statblockSectionHasEntries(mapped.legendaryActions)) continue;
          const domain = combatantToDomain(row);
          const reset = resetLegendaryUsage(domain.turnState);
          if (reset !== domain.turnState) {
            roundLegendarySnapshots.push({ id: row.id, turnState: row.turnState });
            tx.update(combatants).set({ turnState: toJsonText(reset) }).where(eq(combatants.id, row.id)).run();
          }
        }
      }
      // Removing the active actor can immediately start a later eligible actor's
      // turn. Apply the same per-turn reset and start-of-turn condition tick as a
      // regular advance, without manufacturing a second turn/audit event.
      if (startingAfterRemoval) {
        const starting = startingAfterRemoval;
        // Issue #1452: the snapshot used to undo this removal must be captured AFTER
        // the removed caster's concentration cascade, so undoing the removal leaves the
        // starting combatant consistent with the other affected targets.
        const liveSnapshotRow = tx
          .select({ id: combatants.id, turnState: combatants.turnState, conditions: combatants.conditions, conditionInstances: combatants.conditionInstances })
          .from(combatants)
          .where(eq(combatants.id, starting.id))
          .get();
        if (liveSnapshotRow) {
          startedCombatantSnapshot = {
            id: liveSnapshotRow.id,
            turnState: liveSnapshotRow.turnState,
            conditions: liveSnapshotRow.conditions,
            conditionInstances: liveSnapshotRow.conditionInstances,
          };
        }
        const reset = resetTurnStateForStart(wrappedToNextRound ? resetLegendaryUsage(starting.turnState) : starting.turnState);
        // Issue #1452: the starting combatant's condition instances may have changed
        // during the concentration break above. Re-read from the transaction so the
        // start-of-turn tick operates on the post-cascade state.
        const liveStartingRow = tx
          .select({ conditionInstances: combatants.conditionInstances, conditions: combatants.conditions })
          .from(combatants)
          .where(eq(combatants.id, starting.id))
          .get();
        const liveStartingInstances = parseConditionInstances(
          liveStartingRow?.conditionInstances ?? null,
          fromJsonText<string[]>(liveStartingRow?.conditions, []),
        );
        const condTick = tickConditionInstancesAtTurnStart(liveStartingInstances);
        const startSet: Partial<typeof combatants.$inferInsert> = { turnState: toJsonText(reset) };
        if (
          condTick.expired.length > 0 ||
          condTick.kept.some((condition, index) => condition.roundsRemaining !== liveStartingInstances[index]?.roundsRemaining)
        ) {
          Object.assign(startSet, conditionWriteSetFromInstances(condTick.kept));
        }
        tx.update(combatants).set(startSet).where(eq(combatants.id, starting.id)).run();
      }
      const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
      tx.update(encounters).set({
        ...afterEncounter,
        ...turnVersionUpdate,
        ...turnRestampUpdate,
        turnPhase,
        ...(runningAdapter ? { combatantStateVersion: sql`${encounters.combatantStateVersion} + 1` } : {}),
        updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? freshEncounter.updatedAt),
      }).where(eq(encounters.id, encounterId)).run();
      const escalationEventId = wrappedToNextRound && escalation?.logDetail
        ? Number(tx.insert(encounterEvents).values({ encounterId, round: afterEncounter.round, type: 'override', actor: null, target: null, actorId: null, targetId: null, detail: escalation.logDetail, chainId: null, parentEventId: null, phase: null, performedByJson: null, metadataJson: JSON.stringify({ escalationDie: escalation.escalationDie }), createdAt: now }).run().lastInsertRowid)
        : null;
      tx.insert(combatantRemovalUndos).values({
        token: undoToken,
        requestKey: idempotencyKey ?? null,
        actorId,
        encounterId,
        combatantId,
        snapshotJson: toJsonText({ ...snapshot, sheetUpdatedAtAtRemoval, sheetStateAtRemoval, startedCombatantSnapshot, roundLegendarySnapshots }),
        beforeEncounterJson: toJsonText({
          currentCombatantId: freshEncounter.currentCombatantId,
          turnIndex: freshEncounter.turnIndex,
          round: freshEncounter.round,
          escalationDie: freshEncounter.escalationDie,
          escalationDieHistory: freshEncounter.escalationDieHistory,
          lairResumeCombatantId: freshEncounter.lairResumeCombatantId,
          turnPhase: (freshEncounter.turnPhase as EncounterTurnPhase) ?? 'combatant',
          // Turn timer (issue #1935 review): captured so undo can restore the ORIGINAL
          // stamp, not a fresh one — see the restore side in undoRemoveCombatant for why
          // this differs from undoTurn's deliberate "always fresh" restart.
          turnStartedAt: freshEncounter.turnStartedAt,
        }),
        afterEncounterJson: toJsonText({ ...afterEncounter, turnVersion: afterTurnVersion, combatantStateVersion: afterCombatantStateVersion, escalationEventId }),
        expiresAt,
        createdAt: now,
      }).run();
      this.audit.logInTx(tx, { actor: auditActor(user), actorRole: role, action: 'encounter.combatant.remove', entityType: 'combatant', entityId: combatantId, campaignId: freshEncounter.campaignId, detail: snapshot.name });
      emittedEncounter = freshEncounter;
    });

    if (!replayed) {
      this.emitEncounterEvent('encounter.updated', emittedEncounter.campaignId, encounterId, emittedEncounter.hidden);
      if (emittedTurnChange) {
        this.emitEncounterEvent('encounter.turn_changed', emittedEncounter.campaignId, encounterId, emittedEncounter.hidden, emittedTurnChange);
      }
    }
    for (const cascade of removedConcentrationCascades) {
      await this.appendEvent(encounterId, emittedEncounter.round, 'condition', {
        actor: null,
        target: cascade.combatantName,
        targetId: cascade.combatantId,
        detail: `condition expired: ${cascade.condition.name} (concentration broken)`,
      });
    }
    return { undoToken: receiptUndoToken, encounterId, combatantId };
  }

  async undoRemoveCombatant(encounterId: number, undoToken: string, user: RequestUser, role: Role): Promise<Combatant> {
    let restored!: typeof combatants.$inferSelect;
    let restoredCharacterId: number | null = null;
    let restoredNpcId: number | null = null;
    let emittedEncounter!: typeof encounters.$inferSelect;
    let emittedTurnChange: {
      round: number;
      turnIndex: number;
      currentCombatantId: number | null;
      combatantKind: Combatant['kind'] | null;
      turnReverted: true;
    } | null = null;
    let replayed = false;
    try {
      this.db.transaction((tx) => {
        const current = tx.select().from(encounters).where(eq(encounters.id, encounterId)).get();
        if (!current) throw new NotFoundException(`Encounter ${encounterId} not found`);
        const undo = tx.select().from(combatantRemovalUndos).where(and(eq(combatantRemovalUndos.token, undoToken), eq(combatantRemovalUndos.encounterId, encounterId))).get();
        if (!undo || undo.expiresAt <= nowIso()) throw new NotFoundException('Combatant removal undo is unavailable or expired.');
        const storedSnapshot = fromJsonText<(typeof combatants.$inferSelect & {
          sheetUpdatedAtAtRemoval?: string | null;
          sheetStateAtRemoval?: {
            hpCurrent: number; hpMax: number; hpTemp: number; spCurrent: number; spMax: number;
            rpCurrent: number; rpMax: number; deathState: string;
            deathSaveSuccesses: number; deathSaveFailures: number;
            conditions: string; conditionInstances: string | null;
          } | null;
          startedCombatantSnapshot?: Pick<typeof combatants.$inferSelect, 'id' | 'turnState' | 'conditions' | 'conditionInstances'> | null;
          roundLegendarySnapshots?: Array<Pick<typeof combatants.$inferSelect, 'id' | 'turnState'>>;
        }) | null>(undo.snapshotJson, null);
        if (!storedSnapshot) throw new NotFoundException('Combatant removal undo is unavailable.');
        const { sheetUpdatedAtAtRemoval, sheetStateAtRemoval, startedCombatantSnapshot, roundLegendarySnapshots = [], ...snapshot } = storedSnapshot;
        // A committed undo may have lost its response. Replaying the restored row is safe;
        // never turn the client-visible Retry into a permanent 404 after success.
        if (undo.consumedAt != null) {
          // Replay the first undo's persisted response, rather than a row another
          // request may have changed after that response was committed.
          restored = snapshot;
          emittedEncounter = current;
          replayed = true;
          return;
        }
        this.assertMutable(current);
        this.assertCampaignWritableInTx(tx, current.campaignId);
        const campaign = tx
          .select({ ruleSystem: campaigns.ruleSystem, customMechanicsProfile: campaigns.customMechanicsProfile })
          .from(campaigns)
          .where(eq(campaigns.id, current.campaignId))
          .get();
        const adapter = ruleSystemAdapter(
          campaign?.ruleSystem,
          fromJsonText<HomebrewMechanicsProfile | null>(campaign?.customMechanicsProfile, null),
        );
        // A rule-pack uninstall nulls live combatants before deleting its entries, but
        // a removed combatant only exists in this snapshot during the undo window.
        // Restore the same ON DELETE SET NULL state rather than inserting a dangling FK.
        if (snapshot.ruleEntryId != null && !tx.select({ id: ruleEntries.id }).from(ruleEntries).where(eq(ruleEntries.id, snapshot.ruleEntryId)).get()) {
          snapshot.ruleEntryId = null;
        }
        if (snapshot.characterId != null && !tx.select({ id: characters.id }).from(characters).where(eq(characters.id, snapshot.characterId)).get()) {
          snapshot.characterId = null;
        }
        if (snapshot.npcId != null && !tx.select({ id: npcs.id }).from(npcs).where(eq(npcs.id, snapshot.npcId)).get()) {
          snapshot.npcId = null;
        }
        if (snapshot.characterId != null) {
          const sheet = tx.select().from(characters).where(eq(characters.id, snapshot.characterId)).get();
          // Combatants intentionally permit encounter-local overrides (notably hpMax
          // and timed condition metadata). A sheet revision can also change for an
          // unrelated field, so merge each sheet-owned slice only when it differs
          // from the value captured at removal; otherwise restore the exact snapshot.
          if (sheet && sheetStateAtRemoval && sheet.updatedAt !== sheetUpdatedAtAtRemoval) {
            let pulledSheetState = false;
            if (sheet.hpMax !== sheetStateAtRemoval.hpMax) {
              snapshot.hpMax = sheet.hpMax;
              snapshot.hpCurrent = Math.max(0, Math.min(snapshot.hpCurrent, snapshot.hpMax));
              pulledSheetState = true;
            }
            if (sheet.hpCurrent !== sheetStateAtRemoval.hpCurrent) {
              snapshot.hpCurrent = Math.max(0, Math.min(sheet.hpCurrent, snapshot.hpMax));
              pulledSheetState = true;
            }
            if (sheet.hpTemp !== sheetStateAtRemoval.hpTemp) { snapshot.hpTemp = sheet.hpTemp; pulledSheetState = true; }
            if (sheet.spCurrent !== sheetStateAtRemoval.spCurrent) { snapshot.spCurrent = sheet.spCurrent; pulledSheetState = true; }
            if (sheet.spMax !== sheetStateAtRemoval.spMax) { snapshot.spMax = sheet.spMax; pulledSheetState = true; }
            if (sheet.rpCurrent !== sheetStateAtRemoval.rpCurrent) { snapshot.rpCurrent = sheet.rpCurrent; pulledSheetState = true; }
            if (sheet.rpMax !== sheetStateAtRemoval.rpMax) { snapshot.rpMax = sheet.rpMax; pulledSheetState = true; }
            if (sheet.deathState !== sheetStateAtRemoval.deathState) { snapshot.deathState = sheet.deathState; pulledSheetState = true; }
            if (sheet.deathSaveSuccesses !== sheetStateAtRemoval.deathSaveSuccesses) { snapshot.deathSaveSuccesses = sheet.deathSaveSuccesses; pulledSheetState = true; }
            if (sheet.deathSaveFailures !== sheetStateAtRemoval.deathSaveFailures) { snapshot.deathSaveFailures = sheet.deathSaveFailures; pulledSheetState = true; }
            if (sheet.conditions !== sheetStateAtRemoval.conditions || sheet.conditionInstances !== sheetStateAtRemoval.conditionInstances) {
              const mergedConditions = mergeRemovalUndoSheetConditionDelta(
                snapshot.conditions,
                snapshot.conditionInstances,
                sheetStateAtRemoval.conditions,
                sheetStateAtRemoval.conditionInstances,
                sheet.conditions,
                sheet.conditionInstances,
              );
              snapshot.conditions = mergedConditions.conditions;
              snapshot.conditionInstances = mergedConditions.conditionInstances;
              pulledSheetState = true;
            }
            if (pulledSheetState) snapshot.sheetSyncedUpdatedAt = sheet.updatedAt;
          }
        }
        restoredCharacterId = snapshot.characterId;
        restoredNpcId = snapshot.npcId;
        // Issue #1452: a removed concentrating combatant had its concentration broken on
        // the way out, and the undo snapshot does not capture the cascaded targets' prior
        // condition instances. Restore the combatant, but clear its concentration marker so
        // the state is self-consistent: a caster is not left "concentrating" on effects that
        // no longer exist.
        const restoredTurnState = parseTurnState(snapshot.turnState);
        if (restoredTurnState.concentration != null) {
          restoredTurnState.concentration = null;
          restoredTurnState.pendingConcentrationChecks = [];
          snapshot.turnState = toJsonText(restoredTurnState);
        }
        tx.insert(combatants).values(snapshot).run();
        const before = fromJsonText<{ currentCombatantId: number | null; turnIndex: number; round: number; escalationDie: number; escalationDieHistory: string | null; lairResumeCombatantId: number | null; turnPhase: EncounterTurnPhase; turnStartedAt?: string | null }>(undo.beforeEncounterJson, { currentCombatantId: null, turnIndex: 0, round: 1, escalationDie: 0, escalationDieHistory: null, lairResumeCombatantId: null, turnPhase: 'combatant' });
        const after = fromJsonText<{ currentCombatantId: number | null; turnIndex: number; round: number; escalationDie: number; escalationDieHistory: string | null; lairResumeCombatantId: number | null; turnPhase: EncounterTurnPhase; turnVersion?: number; combatantStateVersion?: number; escalationEventId?: number | null }>(undo.afterEncounterJson, { currentCombatantId: null, turnIndex: 0, round: 1, escalationDie: 0, escalationDieHistory: null, lairResumeCombatantId: null, turnPhase: 'combatant' });
        const runningAdapter = current.status === 'running' ? adapter : null;
        if (current.currentCombatantId === after.currentCombatantId && current.turnIndex === after.turnIndex && current.round === after.round && current.escalationDie === after.escalationDie && current.escalationDieHistory === after.escalationDieHistory && current.lairResumeCombatantId === after.lairResumeCombatantId && current.turnPhase === after.turnPhase && after.turnVersion === current.turnVersion && after.combatantStateVersion === current.combatantStateVersion) {
          const restoredRoster = runningAdapter
            ? tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all().map(combatantToDomain)
            : null;
          const restoredTurnIndex = restoredRoster
            ? turnIndexFor(this.sortCombatantsWithAdapter(restoredRoster, 'running', runningAdapter!), before.currentCombatantId)
            : before.turnIndex;
          if (startedCombatantSnapshot) {
            tx.update(combatants).set({
              turnState: startedCombatantSnapshot.turnState,
              conditions: startedCombatantSnapshot.conditions,
              conditionInstances: startedCombatantSnapshot.conditionInstances,
            }).where(eq(combatants.id, startedCombatantSnapshot.id)).run();
          }
          for (const legendarySnapshot of roundLegendarySnapshots) {
            tx.update(combatants).set({ turnState: legendarySnapshot.turnState }).where(eq(combatants.id, legendarySnapshot.id)).run();
          }
          const currentEnc1 = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
          tx.update(encounters).set({
            currentCombatantId: before.currentCombatantId,
            turnIndex: restoredTurnIndex,
            round: before.round,
            escalationDie: before.escalationDie,
            escalationDieHistory: before.escalationDieHistory,
            lairResumeCombatantId: before.lairResumeCombatantId,
            turnPhase: before.turnPhase,
            ...(before.currentCombatantId !== current.currentCombatantId
              ? {
                  turnVersion: sql`${encounters.turnVersion} + 1`,
                  // Turn timer (issue #1935 review): restore the ORIGINAL pre-removal stamp,
                  // not a fresh one. This undo is a short-lived (~30s) "erase my mistake"
                  // capability — every other piece of state here (HP, conditions, escalation
                  // die, turn pointer, lair resume, legendary usage) is restored to exactly
                  // what it was, so a removal-then-undo is a true no-op. Giving the reverted
                  // turn a fresh 0:00 instead would be a visible side effect of an action the
                  // DM is actively erasing. That is why this differs from `undoTurn`, which
                  // is a deliberate DM gameplay-rewind tool with its own documented "always
                  // restamp fresh" semantics — there is no accidental click to fully undo.
                  //
                  // Issue #1935 review round 4 (Devin) — upgrade-window bug: `before` is
                  // parsed from a JSON blob a PRE-upgrade binary may have written, before
                  // `turnStartedAt` existed in that snapshot shape at all. `?? null` cannot
                  // tell "the snapshot recorded null" (a real prior state — restoring null is
                  // correct) apart from "the snapshot has no such key" (nothing to restore —
                  // the live column must be left alone), collapsing both to null and
                  // clobbering a perfectly valid running stamp for up to 24h after upgrade
                  // (undo rows persist that long for idempotency replay, though the undo
                  // CAPABILITY itself only lives ~30s). Only include the key when the
                  // snapshot genuinely recorded one; omitting it from this partial `.set`
                  // leaves the live column exactly as it was.
                  ...(before.turnStartedAt !== undefined ? { turnStartedAt: before.turnStartedAt } : {}),
                }
              : {}),
            ...(runningAdapter ? { combatantStateVersion: sql`${encounters.combatantStateVersion} + 1` } : {}),
            updatedAt: nextUpdatedAt(currentEnc1?.updatedAt ?? current.updatedAt),
          }).where(eq(encounters.id, encounterId)).run();
          if (before.currentCombatantId !== current.currentCombatantId) {
            emittedTurnChange = {
              round: before.round,
              turnIndex: restoredTurnIndex,
              currentCombatantId: before.currentCombatantId,
              combatantKind: snapshot.kind as Combatant['kind'],
              turnReverted: true,
            };
          }
          if (after.escalationEventId != null) tx.delete(encounterEvents).where(and(eq(encounterEvents.id, after.escalationEventId), eq(encounterEvents.encounterId, encounterId))).run();
        } else if (runningAdapter) {
          const restoredRoster = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all().map(combatantToDomain);
          const turnIndex = turnIndexFor(this.sortCombatantsWithAdapter(restoredRoster, 'running', runningAdapter), current.currentCombatantId);
          // Removal clears this pointer only when the removed combatant owned it.
          // In a reconcile, restore it only if no later write has chosen a different
          // lair resume target; an unrelated combatant mutation must not lose it.
          const restoreLairResume = before.lairResumeCombatantId === snapshot.id
            && current.lairResumeCombatantId === after.lairResumeCombatantId;
          const currentEnc2 = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
          tx.update(encounters).set({
            turnIndex,
            ...(restoreLairResume ? { lairResumeCombatantId: before.lairResumeCombatantId } : {}),
            combatantStateVersion: sql`${encounters.combatantStateVersion} + 1`,
            updatedAt: nextUpdatedAt(currentEnc2?.updatedAt ?? current.updatedAt),
          }).where(eq(encounters.id, encounterId)).run();
        }
        // Snapshot is the receipt's response body after its first successful undo.
        // Retaining it lets later retries replay even if another removal intervenes.
        tx.update(combatantRemovalUndos).set({
          snapshotJson: toJsonText({ ...snapshot, sheetUpdatedAtAtRemoval, sheetStateAtRemoval, startedCombatantSnapshot, roundLegendarySnapshots }),
          consumedAt: nowIso(),
        }).where(eq(combatantRemovalUndos.token, undoToken)).run();
        this.audit.logInTx(tx, { actor: auditActor(user), actorRole: role, action: 'encounter.combatant.restore', entityType: 'combatant', entityId: snapshot.id, campaignId: current.campaignId, detail: snapshot.name });
        restored = snapshot;
        emittedEncounter = current;
      });
    } catch (err) {
      if (isUniqueConstraintError(err) && (restoredCharacterId !== null || restoredNpcId !== null)) {
        const winner = await this.findExistingIdentityCombatant(encounterId, restoredCharacterId, restoredNpcId);
        if (winner) {
          throw new ConflictException({
            code: 'COMBATANT_IDENTITY_CONFLICT',
            message: `${restoredCharacterId !== null ? `Character ${restoredCharacterId}` : `NPC ${restoredNpcId}`} is already a combatant in encounter ${encounterId}`,
            combatantId: winner.id,
          });
        }
      }
      throw err;
    }
    if (!replayed) {
      this.emitEncounterEvent('encounter.updated', emittedEncounter.campaignId, encounterId, emittedEncounter.hidden);
      if (emittedTurnChange) {
        this.emitEncounterEvent('encounter.turn_changed', emittedEncounter.campaignId, encounterId, emittedEncounter.hidden, emittedTurnChange);
      }
    }
    return combatantToDomain(restored);
  }

  /** Rolls initiative for every combatant that doesn't already have one (issue #765: group mode rolls one d6 per side). */
  async rollInitiative(encounterId: number, user: RequestUser, role: Role): Promise<EncounterRollInitiativeResult> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    const initModel = initiativeModelForAdapter(adapter);
    let rolled: Array<{ id: number; initiative: number; breakdown: CombatantInitiativeBreakdown; name: string }> = [];
    let freshEncounter = encounterRow;
    const recordedRolls: DiceRoll[] = [];

    // The roster read, initiative assignment, log rows, and any turn-index repair must be
    // one SQLite transaction. Otherwise two devices can both see the same unrolled roster,
    // overwrite one another, and each append a conflicting set of roll events. Keep the
    // IS NULL guard too: it preserves a manual initiative that landed between any older
    // client's read and this write, even if this code is later called from a wider tx.
    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
      if (!fresh) throw new NotFoundException(`Encounter ${encounterId} not found`);
      this.assertMutable(fresh);
      freshEncounter = fresh;
      const unrolled = tx
        .select()
        .from(combatants)
        .where(and(eq(combatants.encounterId, encounterId), isNull(combatants.initiative)))
        .all();

      // Issue #1904 review finding: the dice log is campaign-wide and performs no
      // read-time redaction (unlike the roster/combat-log reads, which mask a
      // hidden-NPC combatant's identity — see getWithCombatantsOrThrow above and
      // listEncounterEvents' redactEncounterEventsForViewer). Individual-mode labels
      // below borrow the combatant's raw name, so a hidden NPC's identity must be
      // masked before it reaches that label — same rule the quick-roll dice log
      // already applies (issue #1850).
      const npcIdsInRoll = [...new Set(unrolled.flatMap((row) => row.kind === 'npc' ? [row.npcId, row.npcIdentitySourceId].filter((id): id is number => id !== null) : []))];
      const hiddenNpcIds = new Set<number>();
      if (npcIdsInRoll.length > 0) {
        const hiddenRows = tx.select({ id: npcs.id }).from(npcs).where(and(inArray(npcs.id, npcIdsInRoll), eq(npcs.hidden, true))).all();
        for (const r of hiddenRows) hiddenNpcIds.add(r.id);
      }
      const diceLogName = (row: { kind: string; npcId: number | null; npcIdentitySourceId: number | null; name: string }): string =>
        row.kind === 'npc' && [row.npcId, row.npcIdentitySourceId].some((id) => id !== null && hiddenNpcIds.has(id)) ? UNKNOWN_COMBATANT_LABEL : row.name;

      // One shared dice-log row per rolled combatant (one per SIDE in group mode) — issue
      // #1904. The bulk roll used to fill the tracker with no visible evidence; this makes
      // it leave the same campaign-wide trail a manual roll would. Built alongside `rolled`
      // so a fully-rolled roster (rolled.length === 0 below) still inserts nothing.
      //
      // `npcId` (individual mode only — a group-mode label names a SIDE, never an
      // individual) lets RollsService.listForCampaign redact the label at READ time if the
      // linked NPC becomes hidden AFTER this roll was written (review finding on #1904): a
      // write-time-only check cannot react to a later hide. `encounterId` on every entry
      // (both modes) lets the same read path drop the whole row if the ENCOUNTER itself is
      // later hidden — mirroring the write-time rule right below that a hidden encounter's
      // roll must never reach the campaign-wide log in the first place.
      const diceLogEntries: Array<{ label: string; expr: string; rolls: number[]; total: number; npcId?: number }> = [];

      if (initModel.mode === 'group') {
        // Group initiative (issue #765): one d6 per side; all combatants on a side share the roll.
        const groupRolls = new Map<string, number>();
        rolled = unrolled.map((row) => {
          const group = row.initiativeGroup ?? (row.kind === 'character' || row.kind === 'npc' ? 'party' : 'monsters');
          const isNewGroupRoll = !groupRolls.has(group);
          if (isNewGroupRoll) groupRolls.set(group, rollInitiative(0, adapter.initiativeDie));
          const base = groupRolls.get(group)!;
          if (isNewGroupRoll) {
            diceLogEntries.push({
              label: `${groupInitiativeLabel(group)} · Initiative`,
              expr: `1d${adapter.initiativeDie}`,
              rolls: [base],
              total: base,
            });
          }
          const existing = parseInitiativeBreakdown(row.initiativeBreakdown) ?? manualInitiativeBreakdown(adapter, 0);
          const breakdown = CombatantInitiativeBreakdown.parse({
            ...existing,
            die: adapter.initiativeDie,
            roll: base,
            modifier: 0,
            total: base,
            terms: [{ label: group, value: 0 }],
            formula: initiativeFormula(adapter.initiativeDie, [{ label: group, value: 0 }], base, base),
          });
          return { id: row.id, initiative: base, breakdown, name: row.name };
        });
      } else {
        rolled = unrolled.map((row) => {
          const initiative = rollInitiative(row.initMod, adapter.initiativeDie);
          const natural = initiative - row.initMod;
          const diceLogNpcId = row.npcIdentitySourceId ?? row.npcId;
          const existing = parseInitiativeBreakdown(row.initiativeBreakdown) ?? manualInitiativeBreakdown(adapter, row.initMod);
          // Issue #1904 review finding: rebuild against the CURRENT initMod, not whatever
          // the stored breakdown's terms summed to when it was last written — a DM's PATCH
          // to initMod after creation touches only that column, so stale terms here would
          // format a formula that visibly contradicts the total/modifier computed below.
          const terms = initiativeTermsForModifier(existing, row.initMod);
          const breakdown = CombatantInitiativeBreakdown.parse({
            ...existing,
            die: adapter.initiativeDie,
            roll: natural,
            modifier: row.initMod,
            total: initiative,
            terms,
            formula: initiativeFormula(adapter.initiativeDie, terms, natural, initiative),
          });
          diceLogEntries.push({
            label: `${diceLogName(row)} · Initiative`,
            expr: initiativeRollExpr(adapter.initiativeDie, row.initMod),
            rolls: [natural],
            total: initiative,
            ...(row.kind === 'npc' && diceLogNpcId !== null ? { npcId: diceLogNpcId } : {}),
          });
          return { id: row.id, initiative, breakdown, name: row.name };
        });
      }

      if (rolled.length === 0) return;

      // Issue #1904 secrecy: the dice log is campaign-wide, so a hidden encounter's bulk
      // roll must never leak into it (matches the per-combatant roll's same rule below).
      if (!fresh.hidden) {
        for (const entry of diceLogEntries) {
          const rec = this.rolls.recordInTransaction(
            tx,
            fresh.campaignId,
            {
              expr: entry.expr,
              rolls: entry.rolls,
              total: entry.total,
              label: entry.label,
              source: 'rolled',
              encounterId,
              ...(entry.npcId !== undefined ? { npcId: entry.npcId } : {}),
            },
            user,
          );
          recordedRolls.push(rec);
        }
      }
      const cases = sql.join(rolled.map((r) => sql`WHEN ${r.id} THEN ${r.initiative}`), sql` `);
      const breakdownCases = sql.join(rolled.map((r) => sql`WHEN ${r.id} THEN ${toJsonText(r.breakdown)}`), sql` `);
      tx.update(combatants)
        .set({
          initiative: sql`CASE ${combatants.id} ${cases} END`,
          initiativeBreakdown: sql`CASE ${combatants.id} ${breakdownCases} END`,
          // Issue #2084 finding 1: this row's initiative is moving off null, so any
          // `manualOrder` it carries can only be leftover from data written under the
          // pre-#2084 roster-wide stamp (which stamped unrolled `preparing` rows too) —
          // never a value this narrower scheme would itself have written, since a
          // null-initiative row is never stamped now. Clear it so a first roll can't hand
          // a brand-new tie an insertion-order decision instead of the adapter's.
          manualOrder: null,
        })
        .where(and(inArray(combatants.id, rolled.map((r) => r.id)), isNull(combatants.initiative)))
        .run();

      // Filling a late joiner's initiative mid-fight re-sorts the order, so keep the
      // positional index aligned with the unchanged identity pointer.
      if (fresh.status === 'running') {
        const sorted = this.sortCombatantsWithAdapter(
          tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all().map(combatantToDomain),
          'running',
          adapter,
        );
        const turnIndex = turnIndexFor(sorted, fresh.currentCombatantId);
        const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
        tx.update(encounters).set({
          turnIndex,
          combatantStateVersion: sql`${encounters.combatantStateVersion} + 1`,
          updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? fresh.updatedAt),
        }).where(eq(encounters.id, encounterId)).run();
      }

      for (const r of rolled) {
        tx.insert(encounterEvents)
          .values({
            encounterId,
            round: fresh.round,
            type: 'roll',
            actor: null,
            target: r.name,
            actorId: null,
            targetId: r.id,
            detail: `initiative ${r.breakdown.formula}`,
            chainId: null,
            parentEventId: null,
            phase: null,
            performedByJson: null,
            metadataJson: null,
            createdAt: nowIso(),
          })
          .run();
      }
    });

    // Fully-rolled roster: no write, audit, log, or SSE disturbance. The fresh snapshot
    // still gives the caller a consistent result.
    if (rolled.length === 0) {
      const snapshot = await this.getWithCombatantsOrThrow(encounterId, role);
      return { ...snapshot, rolledCount: 0 };
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.roll_initiative',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: freshEncounter.campaignId,
      detail: `${rolled.length}`,
    });

    this.emitEncounterEvent('encounter.updated', freshEncounter.campaignId, encounterId, freshEncounter.hidden);
    if (!freshEncounter.hidden) {
      for (const rec of recordedRolls) {
        this.rolls.emitDiceRolled?.(rec);
      }
    }

    const snapshot = await this.getWithCombatantsOrThrow(encounterId, role);
    return { ...snapshot, rolledCount: rolled.length };
  }

  /**
   * Server-authoritative initiative roll for ONE combatant (issue #1904) — the player-facing
   * counterpart to the DM's bulk {@link rollInitiative}. The DM may roll any combatant; a
   * player may roll only a combatant linked to a character they own (everyone else 403s).
   * Allowed while `preparing`, or while `running` with a still-null initiative (the same
   * late-joiner case the bulk roll fills); a combatant that already has initiative set 409s
   * unless the DM passes `overwrite: true`. The rolled face, its breakdown, a combat-log
   * 'roll' event, and one labeled shared dice-log row all commit in ONE transaction
   * (death-save precedent, issue #1462) — except the dice-log row, which is skipped for a
   * hidden encounter since the dice log is campaign-wide (only the DM can even reach a
   * hidden encounter here; non-DM callers already 404 above).
   *
   * 400s for a group-initiative rule system (issue #765): a side shares ONE roll, so a
   * single-combatant write here would desync it from the rest of its side. That side-wide
   * roll stays exclusively the bulk `rollInitiative` path.
   */
  async rollCombatantInitiative(
    encounterId: number,
    combatantId: number,
    idempotencyKey: string,
    overwrite: boolean | undefined,
    user: RequestUser,
    role: Role,
  ): Promise<{ combatant: Combatant; roll: DiceRoll | null }> {
    // A retained trashed row is sufficient to authorize an existing keyed replay; fresh
    // writes still fail in the transaction-local mutable check below.
    const encounter = await this.getRowOrThrow(encounterId, true);
    if (!isVisibleTo({ hidden: encounter.hidden }, role)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    const opClaim: EncounterOpClaim = {
      actorId: user.id,
      operation: 'combatant.roll_initiative',
      key: idempotencyKey,
      encounterId,
      campaignId: encounter.campaignId,
      fingerprint: encounterOpFingerprint({ combatantId, overwrite: overwrite === true }),
    };
    const replayResponse = (response: unknown): { combatant: Combatant; roll: DiceRoll | null } | null => {
      // `response` is `null` outright when the claim committed but its body was never
      // backfilled (see the analogous turn-advance comment on this exact window) — optional
      // chaining here, not a bare property access, so that state resolves to "cannot replay"
      // rather than throwing before resolveReplay ever gets to decide what to do about it.
      const candidate = response as Partial<{ combatant: Combatant; roll: DiceRoll | null }> | null | undefined;
      return candidate?.combatant ? { combatant: candidate.combatant, roll: candidate.roll ?? null } : null;
    };
    // Issue #1904 review finding: the stored response was rendered for the ROLE that
    // committed it. If the caller's role has since changed within the replay window (e.g. a
    // DM demoted to player/viewer), replaying that stored projection verbatim would leak
    // whatever the DM saw — exact monster HP, an unmasked hidden-NPC name or npcId, an
    // un-redacted dice-log label — to a lower-privileged caller. BOTH halves need
    // re-deriving on a mismatch: `combatant` via a fresh role-filtered read (below), and
    // `roll` via RollsService.redactRollForRole — the dice log itself is no longer
    // universally identical across roles (it gets the SAME read-time redaction
    // listForCampaign applies), so reusing the stored `roll` verbatim would bypass exactly
    // the read-time check that redaction exists for. The roll already committed either way
    // — this re-renders CURRENT state for the caller's role rather than re-running the
    // effect, mirroring the turn-advance precedent (issue #580) of falling through to fresh
    // server truth on a role mismatch.
    const resolveReplay = async (prior: EncounterOpPrior): Promise<{ combatant: Combatant; roll: DiceRoll | null } | null> => {
      const parsed = replayResponse(prior.response);
      if (!parsed) return null;
      if (prior.responseRole === role) return parsed;
      // Re-derive for a changed role; tolerate a trashed encounter and treat any
      // visibility failure as best-effort so the original rejection reason is preserved.
      try {
        const snapshot = await this.getWithCombatantsOrThrow(encounterId, role, undefined, true);
        const found = snapshot.combatants.find((c) => c.id === combatantId);
        if (!found) return null;
        const roll = parsed.roll ? await this.rolls.redactRollForRole(parsed.roll, role) : null;
        return { combatant: found, roll };
      } catch {
        return null;
      }
    };
    const findPrior = (): EncounterOpPrior | null => {
      let prior: EncounterOpPrior | null = null;
      this.db.transaction((tx) => {
        prior = findPriorEncounterOp(tx, opClaim, Date.now());
      });
      return prior;
    };
    const earlyPrior = findPrior();
    if (earlyPrior) {
      const earlyReplay = await resolveReplay(earlyPrior);
      if (earlyReplay) return earlyReplay;
    }

    try {
      const adapter = await this.adapterForCampaign(encounter.campaignId);
      const initModel = initiativeModelForAdapter(adapter);

      // This pre-read authorizes the actor before any transactional work. The mutable /
      // already-set checks live inside the transaction below, off a fresh row, so a
      // concurrent change between this read and the write cannot be raced past.
      const combatant = await this.getCombatantRowOrThrow(encounterId, combatantId);
      if (role !== 'dm') {
        if (combatant.characterId === null) throw new ForbiddenException('Only dm may roll initiative for this combatant');
        const [character] = await this.db.select().from(characters).where(eq(characters.id, combatant.characterId)).limit(1);
        if (!character || character.ownerUserId !== user.id) {
          throw new ForbiddenException('Only dm or the owning player may roll initiative for this combatant');
        }
      }
      // Group-initiative systems (issue #765) share ONE die per side — a per-combatant
      // roll that only wrote this one row would leave it out of sync with the rest of its
      // side (and with whatever the DM's bulk roll later assigns everyone else on it).
      // That side-wide roll stays exclusively the bulk `rollInitiative` path; this
      // single-combatant action is for individual-initiative systems only.
      if (initModel.mode === 'group') {
        throw new BadRequestException(
          'This rule system uses group initiative — ask the DM to roll for the whole side (Roll remaining).',
        );
      }

      let roll: DiceRoll | null = null;
      let committed!: Combatant;
      let freshEncounterRow!: typeof encounters.$inferSelect;
      // Holds the raw prior (not yet role-resolved) when this transaction lands on a race —
      // the same key committed between the early check above and this transaction starting.
      // Resolved via resolveReplay AFTER the transaction, since that may need an async
      // role-filtered re-read and this callback is a synchronous better-sqlite3 transaction.
      let priorFromRace: EncounterOpPrior | null = null;

      this.db.transaction((tx) => {
        const prior = findPriorEncounterOp(tx, opClaim, Date.now());
        if (prior) {
          priorFromRace = prior;
          return;
        }
        const [fresh] = tx.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
        if (!fresh) throw new NotFoundException(`Encounter ${encounterId} not found`);
        this.assertMutable(fresh);
        this.assertCampaignWritableInTx(tx, fresh.campaignId);
        if (!isVisibleTo({ hidden: fresh.hidden }, role)) {
          throw new NotFoundException(`Encounter ${encounterId} not found`);
        }
        const [freshCombatant] = tx
          .select()
          .from(combatants)
          .where(and(eq(combatants.id, combatantId), eq(combatants.encounterId, encounterId)))
          .limit(1)
          .all();
        if (!freshCombatant) throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
        if (role !== 'dm') {
          if (freshCombatant.characterId === null) throw new ForbiddenException('Only dm may roll initiative for this combatant');
          const [freshCharacter] = tx.select().from(characters).where(eq(characters.id, freshCombatant.characterId)).limit(1).all();
          if (!freshCharacter || freshCharacter.ownerUserId !== user.id) {
            throw new ForbiddenException('Only dm or the owning player may roll initiative for this combatant');
          }
        }
        if (freshCombatant.initiative !== null && !(role === 'dm' && overwrite === true)) {
          throw new ConflictException({
            code: 'INITIATIVE_ALREADY_SET',
            message: 'This combatant already has an initiative — the DM can pass overwrite to re-roll.',
          });
        }
        // Running combat only ever fills a still-null initiative here (the late-joiner
        // case `rollInitiative` also handles) — the check above already guarantees that
        // unless a DM explicitly opted into overwriting mid-fight.

        const rollModifier = freshCombatant.initMod;
        const initiative = rollInitiative(rollModifier, adapter.initiativeDie);
        const natural = initiative - rollModifier;
        const existing = parseInitiativeBreakdown(freshCombatant.initiativeBreakdown) ?? manualInitiativeBreakdown(adapter, rollModifier);
        // Issue #1904 review finding: rebuild against the CURRENT initMod, not whatever the
        // stored breakdown's terms summed to when it was last written. A DM's PATCH to
        // initMod (creation-time fix, or a mid-campaign stat change) touches only that
        // column, so reusing stale terms here would format a formula (e.g. "+2") beside a
        // total/modifier that were actually computed from a different value (e.g. "+5").
        const terms = initiativeTermsForModifier(existing, rollModifier);
        const breakdown = CombatantInitiativeBreakdown.parse({
          ...existing,
          die: adapter.initiativeDie,
          roll: natural,
          modifier: rollModifier,
          total: initiative,
          terms,
          formula: initiativeFormula(adapter.initiativeDie, terms, natural, initiative),
        });

        tx.update(combatants)
          .set({
            initiative,
            initiativeBreakdown: toJsonText(breakdown),
            // Issue #2084 finding 1: an overwrite re-roll (or a first roll off a legacy
            // null-but-stamped row) assigns a fresh initiative value, so whatever tie
            // group any prior `manualOrder` referred to no longer applies — the DM's next
            // drag, if any, will re-establish one for wherever this combatant actually
            // lands now.
            manualOrder: null,
          })
          .where(eq(combatants.id, combatantId))
          .run();

        // Filling a late joiner's initiative mid-fight re-sorts the order, so keep the
        // positional index aligned with the unchanged identity pointer (mirrors the bulk roll).
        if (fresh.status === 'running') {
          const sorted = this.sortCombatantsWithAdapter(
            tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all().map(combatantToDomain),
            'running',
            adapter,
          );
          const turnIndex = turnIndexFor(sorted, fresh.currentCombatantId);
          tx.update(encounters).set({
            turnIndex,
            combatantStateVersion: sql`${encounters.combatantStateVersion} + 1`,
            ...(turnIndex !== fresh.turnIndex ? { updatedAt: nowIso() } : {}),
          }).where(eq(encounters.id, encounterId)).run();
        }

        this.appendEventInTransaction(tx, encounterId, fresh.round, 'roll', {
          target: freshCombatant.name,
          targetId: combatantId,
          detail: `initiative ${breakdown.formula}`,
        });

        // Issue #1904 secrecy: the dice log is campaign-wide. Only the DM can reach a
        // hidden encounter this far (non-DM callers already 404 above), and a hidden
        // encounter's roll must never leak into the shared log. Same rule for a
        // combatant borrowing a hidden NPC's identity (review finding, same masking
        // the quick-roll dice log already applies for issue #1850): mask here at write
        // time for the state at THIS moment, AND persist encounterId/npcId so
        // RollsService.listForCampaign can redact this row again at READ time if the
        // encounter or NPC becomes hidden LATER — a write-time check alone cannot react
        // to a hide that happens after the roll was already recorded.
        if (!fresh.hidden) {
          let hiddenNpcName = false;
          const npcIdentityId = freshCombatant.npcIdentitySourceId ?? freshCombatant.npcId;
          if (freshCombatant.kind === 'npc' && npcIdentityId !== null) {
            const [npc] = tx.select({ hidden: npcs.hidden }).from(npcs).where(eq(npcs.id, npcIdentityId)).limit(1).all();
            hiddenNpcName = npc?.hidden === true;
          }
          const label = `${hiddenNpcName ? UNKNOWN_COMBATANT_LABEL : freshCombatant.name} · Initiative`;
          const expr = initiativeRollExpr(adapter.initiativeDie, rollModifier);
          roll = this.rolls.recordInTransaction(
            tx,
            fresh.campaignId,
            {
              expr,
              rolls: [natural],
              total: initiative,
              label,
              source: 'rolled',
              encounterId,
              ...(freshCombatant.kind === 'npc' && npcIdentityId !== null ? { npcId: npcIdentityId } : {}),
            },
            user,
          );
        }

        this.audit.logInTx(tx, {
          actor: auditActor(user),
          actorRole: role,
          action: 'encounter.combatant.roll_initiative',
          entityType: 'combatant',
          entityId: combatantId,
          campaignId: fresh.campaignId,
          detail: `${freshCombatant.name}: ${initiative}`,
        });

        const [updatedRow] = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
        committed = combatantToDomain(updatedRow);
        freshEncounterRow = fresh;

        recordEncounterOp(tx, opClaim, nowIso(), { body: { combatant: committed, roll }, role });
      });

      if (priorFromRace) {
        // The write branch above never ran (it returned early the moment it found this
        // race), so `committed`/`freshEncounterRow` were never assigned — falling through
        // to the fresh-write emit/return below would dereference undefined and 500 instead
        // of replaying. Resolve the race's outcome for THIS caller's role, or, on the rare
        // case that fails (role mismatch AND the combatant is no longer visible to it —
        // e.g. removed since), surface a 404 rather than crash. Either way, a race replay
        // must return here: the op already committed under the concurrent request, which
        // owns the ONE audit entry + SSE signal for it (same reasoning as the analogous
        // bulk-roll/turn-advance "an idempotent replay stops here" comments elsewhere).
        const raceReplay = await resolveReplay(priorFromRace);
        if (raceReplay) return raceReplay;
        throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
      }
      this.emitEncounterEvent('encounter.updated', freshEncounterRow.campaignId, encounterId, freshEncounterRow.hidden);
      if (roll && !freshEncounterRow.hidden) {
        this.rolls.emitDiceRolled?.(roll);
      }
      return { combatant: committed, roll };
    } catch (err) {
      // The original same-key request can commit after our early replay lookup but before
      // a mutable-row preflight (for example, before another DM ends the encounter).
      // Recheck the stored outcome before surfacing that later 404/409/403 so an ambiguous
      // retry still recovers the committed authoritative result.
      const latePrior = findPrior();
      if (latePrior) {
        const lateReplay = await resolveReplay(latePrior);
        if (lateReplay) return lateReplay;
      }
      throw err;
    }
  }

  /**
   * DM-only manual reorder (issue #1923) — POST .../combatants/:cid/reorder. This is the
   * documented answer to an unresolved initiative tie (initiative-tiebreak.ts's own doc
   * comment: "the DM can manually reorder") and the only mechanical expression of
   * Delay/Ready, which otherwise ship as log-only markers that clear themselves without
   * ever moving the combatant.
   *
   * `afterCombatantId` names the combatant the moved one should land immediately after
   * under `sortCombatants` (or the literal `'top'` to become first). The whole roster's
   * `sortOrder` is rewritten to the requested display order in one pass — cheap (an
   * encounter roster is at most a few dozen rows) and it guarantees the write reproduces
   * exactly under `sortCombatants`'s own comparator, rather than trying to slot one value
   * between two neighbors that might already be adjacent sortOrder integers.
   *
   * `initiative` is only ever touched while the encounter is `running` — `sortCombatants`
   * ignores `initiative` entirely while `preparing` (plain sortOrder ascending), so a
   * preparing-time reorder never overrides a rolled value. Whether it also establishes
   * tie-break order for later depends on whether the moved combatant already has a real
   * `initiative` at drag time: `manualOrder` is skipped whenever the landing value is
   * null (see that field's schema doc), which it usually is before `/start` — a
   * preparing-time drag of two still-unrolled combatants records ONLY `sortOrder`, and
   * once real values are rolled, a tie between them resolves through the adapter, not
   * this drag. Only a prep-time reorder among combatants that ALREADY carry a real
   * `initiative` (set ahead of the roll) establishes real tie-break order. Deciding what
   * "the DM's ordering intent" even means for combatants that have not rolled yet — which
   * of them the DM meant relative to which, when the tie groups they will land in do not
   * exist — is tracked as a follow-up (issue #2102), not attempted here: it is the exact
   * design question whose rushed first answer (stamping unconditionally during prep)
   * produced #2084's "encodes add order" defect in the first place. While running, a
   * move that leaves the moved combatant's own initiative
   * already sitting between its NEW neighbours' values (the ordinary within-a-tie case,
   * e.g. reordering a tied 14, but also a move that happens to land back where the value
   * already belonged) only rewrites `sortOrder` — issue #2084 finding 2: the old
   * "differs from both neighbours" predicate rewrote a rolled value whenever it merely
   * differed, including when it already sat correctly between them. A move that truly
   * crosses initiative values sets the moved combatant's `initiative` to a value between
   * its NEW neighbors — so the manual placement survives a later resort — and clears the
   * now-stale `initiativeBreakdown` (#1476: this must never fabricate a breakdown for a
   * manually-assigned value). `manualOrder` is stamped for every row sharing the moved
   * combatant's landing initiative — its whole tie group, not the roster and not just the
   * rows the drag physically crossed (issue #2084 finding 1, corrected to whole-group
   * scope by issue #2095 review) — see that field's own doc comment in @campfire/schema.
   *
   * `expectedTurnVersion` CAS: 409s when it no longer matches the encounter's current
   * `turnVersion` (bumped on every turn advance) — a drag issued against a roster the DM
   * is no longer looking at must not silently reorder the new one. Moving the current
   * actor (`currentCombatantId`) is refused outright — reordering the roster mid-turn
   * around the acting combatant itself has no sensible meaning. A combatant that was
   * delaying has that marker cleared and logged in the same transaction: the drag itself
   * IS Delay's mechanical resolution ("the fighter acts after the wizard now").
   */
  async reorderCombatant(
    encounterId: number,
    combatantId: number,
    input: CombatantReorderRequest,
    user: RequestUser,
    role: Role,
  ): Promise<Combatant> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    // Adapter lookup reads outside the transaction (rollCombatantInitiative precedent) —
    // it is deterministic from the campaign's ruleSystem/customMechanicsProfile, which a
    // concurrent reorder cannot itself change.
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);

    let committed!: Combatant;

    this.db.transaction((tx) => {
      const fresh = tx.select().from(encounters).where(eq(encounters.id, encounterId)).get();
      if (!fresh) throw new NotFoundException(`Encounter ${encounterId} not found`);
      this.assertMutable(fresh);
      this.assertCampaignWritableInTx(tx, fresh.campaignId);
      if (input.expectedTurnVersion !== undefined && fresh.turnVersion !== input.expectedTurnVersion) {
        throw new ConflictException({
          code: 'TURN_VERSION_MISMATCH',
          message: 'The turn has moved on since this order was loaded — refresh and try again.',
        });
      }
      if (fresh.currentCombatantId === combatantId) {
        throw new ForbiddenException('Cannot reorder the combatant whose turn it currently is.');
      }

      const rows = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all();
      const moved = rows.find((r) => r.id === combatantId);
      if (!moved) throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
      if (input.afterCombatantId === combatantId) {
        throw new BadRequestException('A combatant cannot be reordered after itself.');
      }
      if (input.afterCombatantId !== 'top' && !rows.some((r) => r.id === input.afterCombatantId)) {
        throw new NotFoundException(`Combatant ${input.afterCombatantId} not found in encounter ${encounterId}`);
      }

      const status = fresh.status as EncounterStatus;
      const sorted = this.sortCombatantsWithAdapter(rows.map(combatantToDomain), status, adapter);
      const withoutMoved = sorted.filter((c) => c.id !== combatantId);
      const insertAt = input.afterCombatantId === 'top'
        ? 0
        : withoutMoved.findIndex((c) => c.id === input.afterCombatantId) + 1;
      const prev = insertAt > 0 ? withoutMoved[insertAt - 1] : null;
      const next = insertAt < withoutMoved.length ? withoutMoved[insertAt] : null;

      // Cross-value initiative reassignment is only meaningful once `sortCombatants`
      // actually orders by initiative (status === 'running'); see the doc comment above.
      let newInitiative = moved.initiative;
      if (status === 'running') {
        const origInit = moved.initiative;
        const prevInit = prev?.initiative ?? null;
        const nextInit = next?.initiative ?? null;
        // Issue #2084 finding 2 (originally reported as review finding 4): the predicate
        // used to be "origInit differs from BOTH neighbours", which is true even when
        // origInit already sits strictly BETWEEN them — its natural, already-correct
        // position. Roster A(20), M(14), C(6): dragging M to just after A (a no-op, or
        // "Move after A" from the menu) has prev=20, next=6; 14 differs from both, so the
        // old code wrote floor((20+6)/2)=13 and nulled a real, already-fine
        // initiativeBreakdown for a move that changed nothing about the ordering. The
        // question that matters is whether the CURRENT value already lies within the new
        // neighbours' bounds, not whether it differs from them.
        const alreadyBetween =
          origInit !== null && (prevInit === null || origInit <= prevInit) && (nextInit === null || origInit >= nextInit);
        // Issue #2095 review (Codex P1): `alreadyBetween` above is `false` unconditionally
        // whenever `origInit === null` (an unrolled combatant), so a null-origin move used
        // to fall straight into reassignment below. Roster A(20), B(10), U(null), V(null):
        // dragging U to just after B — where it already sits — had prevInit=10, nextInit=
        // null, landing in the `prevInit != null` branch and writing `newInitiative = 9`.
        // That silently rolls an unrolled combatant in for a drop `sortOrder` alone should
        // have satisfied — the same class of bug as finding 2 above, at the rolled/null
        // boundary instead of between two rolled neighbours.
        //
        // `nextInit === null` is exactly "the drop still lands inside (or at the end of)
        // the unrolled tier": `sorted` above places every rolled row before every unrolled
        // one, so the only way an unrolled combatant's NEXT neighbour can be a rolled row is
        // a drop at the very top of the whole roster (`insertAt === 0`, `prevInit === null`
        // too) — deliberately rolling it in ahead of everyone. Any other `nextInit === null`
        // drop keeps at least the row immediately after it (if any) unrolled, so the
        // combatant belongs in the unrolled tier regardless of `prevInit`. Preserve `null`
        // there; only the two cases below (`nextInit !== null`) are actually placing an
        // unrolled combatant into the rolled region, which — unlike the null-preserving
        // cases — is a deliberate re-roll-by-position, not an accident of the drop math.
        const stillUnrolled = origInit === null && nextInit === null;
        if (!alreadyBetween && !stillUnrolled) {
          if (prevInit != null && nextInit != null) {
            newInitiative = prevInit === nextInit ? prevInit : Math.floor((prevInit + nextInit) / 2);
          } else if (prevInit != null) {
            newInitiative = prevInit - 1;
          } else if (nextInit != null) {
            newInitiative = nextInit + 1;
          }
          // else: neither neighbor has a rolled initiative to anchor to (both unrolled or
          // absent) — leave `initiative` untouched; the roster still lands in a valid
          // state (unrolled combatants always sort last, regardless of sortOrder).
        }
      }

      const orderedIds = [
        ...withoutMoved.slice(0, insertAt).map((c) => c.id),
        combatantId,
        ...withoutMoved.slice(insertAt).map((c) => c.id),
      ];
      // Issue #1923 review finding 1: on a running encounter, `sortCombatants` orders by
      // initiative and breaks ties via the adapter's own comparator (e.g. 5e's
      // initModDescThenSortOrderAsc, which compares initMod BEFORE sortOrder) — a
      // sortOrder-only rewrite is silently discarded whenever the tied combatants have
      // different initMod (different DEX), so the DM's drag has no visible effect. Stamp
      // `manualOrder` to hold the moved combatant's new position across a re-sort.
      //
      // Issue #2084 finding 1: NOT every combatant in the roster. The original fix
      // stamped the whole roster on every drag, so after one reorder EVERY row carried a
      // value, and `sortCombatants` consults `manualOrder` ahead of the adapter tiebreak
      // whenever a stamped row is involved — so `adapter.initiativeTiebreak` never ran
      // again for this encounter, including for ties the DM never touched. It was worse
      // while `preparing`, where most rows have no rolled initiative yet and the stamped
      // index encoded add order, not a DM decision.
      //
      // The narrower rule: stamp only rows that share the moved combatant's landing
      // (possibly just-reassigned) initiative value — its FULL tie group as it exists in
      // the newly computed order, not merely the ones the drag's own start/end positions
      // happened to span. A tie group nobody dragged into stays entirely null and keeps
      // falling through to the adapter, since only same-initiative rows are relevant to a
      // tiebreak comparison at all (`sortCombatants` never calls into `manualOrder` for
      // two different initiative values — it decides those numerically first).
      //
      // Issue #2095 review (Devin, Codex, and Copilot, same root cause, three independent
      // repros): an
      // earlier version stamped only the moved combatant plus whichever OTHER tie-group
      // members its start/end positions physically crossed — but #2088's
      // stamped-before-unstamped total-order rule (relanded in this same PR, see
      // `sortCombatants`) makes ANY stamped row sort ahead of ANY unstamped one within a
      // tie, with no regard for whether that row was crossed. A partial stamp therefore
      // does not merely fail to help the untouched members — it ACTIVELY sinks them below
      // the touched ones, an order the DM never asked for:
      //
      //   running A(20), W/X/Y/Z all tied at 14; drag Z to just after X. Crossing only
      //   spans Y, so the old code stamped {Z, Y} and left W/X null — sorting to
      //   A, Z, Y, W, X instead of the requested A, W, X, Z, Y.
      //
      // Smaller and nastier: a tied [A, B, C], no-op move of B to right after A crosses
      // NOBODY (insertAt already equals B's old position) — the old code still stamped
      // only B, and a stamped B alone now sorts ahead of unstamped A and C: a no-op drag
      // silently reorders its own tie group.
      //
      // Stamping the WHOLE landing group, using each member's index in this SAME
      // `orderedIds` pass, also closes a second issue both reviewers noted: `manualOrder`
      // is an absolute index into `orderedIds`, so a stamp from an EARLIER drag lives in a
      // different index space than one from this drag. A partial stamp could leave part of
      // a tie group holding stale indices from a prior operation while the rest got fresh
      // ones, risking duplicate or inverted values within one group. Every member of the
      // group is (re)stamped together here, in one consistent space, every time.
      //
      // Deliberately skipped altogether when the moved combatant's landing initiative is
      // null (unrolled): `sortCombatants` decides an unrolled tie by `sortOrder` alone
      // (its own null/null branch), same as every row while `preparing` — there is no
      // adapter tiebreak for a stamp to protect there, and stamping it anyway is exactly
      // what reproduced the preparing-time "encodes add order" bug even under this
      // narrower scheme, since prep-time rows are null far more often than not.
      const finalInitiative = newInitiative;
      const manualOrderIds = new Set<number>();
      if (finalInitiative !== null) {
        manualOrderIds.add(combatantId);
        for (const c of withoutMoved) {
          if (c.initiative === finalInitiative) manualOrderIds.add(c.id);
        }
      }
      orderedIds.forEach((id, index) => {
        tx.update(combatants)
          .set({ sortOrder: index, ...(manualOrderIds.has(id) ? { manualOrder: index } : {}) })
          .where(eq(combatants.id, id))
          .run();
      });
      const initiativeChanged = newInitiative !== moved.initiative;
      if (initiativeChanged) {
        tx.update(combatants)
          .set({ initiative: newInitiative, initiativeBreakdown: null })
          .where(eq(combatants.id, combatantId))
          .run();
      }

      const turnState = CombatantTurnState.parse(fromJsonText<unknown>(moved.turnState, null) ?? {});
      const delayCleared = turnState.delaying === true;
      if (delayCleared) {
        turnState.delaying = false;
        tx.update(combatants).set({ turnState: toJsonText(turnState) }).where(eq(combatants.id, combatantId)).run();
      }

      // Realign the positional turnIndex with the unchanged identity pointer (issue #49) —
      // reordering the OTHER combatants around the current actor can shift its position
      // even though the current actor itself can never be the one being moved (guarded
      // above). Mirrors rollCombatantInitiative's own late-joiner realignment.
      if (status === 'running') {
        const resorted = this.sortCombatantsWithAdapter(
          tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all().map(combatantToDomain),
          'running',
          adapter,
        );
        const turnIndex = turnIndexFor(resorted, fresh.currentCombatantId);
        const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
        tx.update(encounters)
          .set({
            turnIndex,
            combatantStateVersion: sql`${encounters.combatantStateVersion} + 1`,
            updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? fresh.updatedAt),
          })
          .where(eq(encounters.id, encounterId))
          .run();
      }

      // Name-free detail (issue #869 redaction rule) — actor/target ids carry identity;
      // listing redacts a hidden NPC's name from `target` at read time.
      this.appendEventInTransaction(tx, encounterId, fresh.round, 'override', {
        target: moved.name,
        targetId: combatantId,
        // Driven by `initiativeChanged` — the flag that governs whether the write above
        // actually happened — not by "did the move cross an initiative value". Those two
        // disagree when the move crosses values but neither neighbour has a rolled
        // initiative to anchor to: the anchoring block falls through its `else`,
        // `newInitiative` stays put, nothing is written, and the "(now N)" wording would
        // have announced a change that did not occur. Reachable by dragging a rolled
        // combatant down among not-yet-rolled ones mid-fight.
        detail: initiativeChanged ? `reordered in initiative (now ${newInitiative})` : 'reordered in initiative',
      });
      if (delayCleared) {
        this.appendEventInTransaction(tx, encounterId, fresh.round, 'note', {
          actor: moved.name,
          actorId: combatantId,
          detail: 'is no longer delaying',
        });
      }

      this.audit.logInTx(tx, {
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.combatant.reorder',
        entityType: 'combatant',
        entityId: combatantId,
        campaignId: fresh.campaignId,
        detail: moved.name,
      });

      const [updatedRow] = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
      committed = combatantToDomain(updatedRow);
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, encounterRow.hidden);
    return committed;
  }

  async start(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertNoSafetyHold(encounterRow.campaignId); // #599
    if (encounterRow.status !== 'preparing') {
      // Without this guard, /start on an already-'ended' encounter revives it with a
      // stale endedAt still set (or re-starts a 'running' one, resetting round/turnIndex
      // mid-fight) — status must be 'preparing' to (re)start.
      throw new BadRequestException(`Encounter must be in 'preparing' status to start (currently '${encounterRow.status}')`);
    }
    const rows = await this.listCombatantRows(encounterId);
    if (rows.length === 0) {
      // Without this guard an empty roster passes the (vacuous) initiative check below
      // and Start flips the encounter to 'running' with round=1 and currentCombatantId
      // null — a nonsensical fight with nobody in it that only manual End can clear
      // (issue #469). At least one combatant must exist before Start is meaningful.
      throw new BadRequestException('Cannot start an encounter with no combatants — add at least one combatant first');
    }
    if (rows.some((r) => r.initiative === null)) {
      throw new BadRequestException('All combatants must have initiative rolled before starting the encounter');
    }

    // The first actor is the top of the initiative order — pin it by identity (issue
    // #49), not just position, so later add/remove can't slide the pointer off it.
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    const sorted = this.sortCombatantsWithAdapter(rows.map(combatantToDomain), 'running', adapter);
    const statblocks = await this.statblockMapForCombatants(encounterRow.campaignId, sorted);
    const hasLairSlot = encounterHasLairSlotFromStatblocks(statblocks);
    const initial = initialEncounterTurnState(sorted, hasLairSlot);
    const currentCombatantId = initial.currentCombatantId;
    const turnPhase = initial.phase;
    const lairResumeCombatantId = initial.lairResumeCombatantId;
    const turnIndex = initial.turnIndex;

    // One authoritative live fight per campaign (issue #744): flip status to 'running'
    // AND set the campaign's activeEncounterId in the SAME transaction, after asserting
    // no other encounter is already running. better-sqlite3 transactions serialize writes,
    // so two concurrent /start calls cannot both pass the assertion — the loser's read
    // sees the winner's committed row and surfaces a 409 with the winner's name + link.
    const campaignId = encounterRow.campaignId;
    const ts = nowIso();
    const escalation = this.nextEscalationState(adapter, encounterRow, 1, 'start');
    // Fresh-prep encounters (including campaign clones) deliberately have no
    // historical allegiance. Capture the linked NPC's current disposition exactly
    // when play starts, so a later NPC edit cannot rewrite the finished fight's XP.
    const npcIds = [...new Set(rows.flatMap((row) => row.kind === 'npc' ? [row.npcId, row.npcIdentitySourceId].filter((id): id is number => id !== null) : []))];
    this.db.transaction((tx) => {
      this.assertNoOtherLiveEncounter(campaignId, encounterId, tx);
      const npcDispositionById = new Map(
        npcIds.length === 0
          ? []
          : tx
              .select({ id: npcs.id, disposition: npcs.disposition })
              .from(npcs)
              .where(inArray(npcs.id, npcIds))
              .all()
              .map((npc) => [npc.id, npc.disposition] as const),
      );
      for (const [npcId, disposition] of npcDispositionById) {
        tx.update(combatants)
          .set({ npcDispositionSnapshot: disposition })
          .where(and(eq(combatants.encounterId, encounterId), or(eq(combatants.npcId, npcId), eq(combatants.npcIdentitySourceId, npcId))))
          .run();
      }

      const expiredConditions: Array<{ combatantId: number; combatantName: string; conditionName: string }> = [];
      if (currentCombatantId !== null) {
        const starting = sorted.find((c) => c.id === currentCombatantId);
        if (starting) {
          const reset = resetTurnStateForStart(starting.turnState);
          const condTick = tickConditionInstancesAtTurnStart(starting.conditionInstances ?? []);
          const startSet: Partial<typeof combatants.$inferInsert> = { turnState: toJsonText(reset) };
          if (
            condTick.expired.length > 0 ||
            condTick.kept.some((c, i) => c.roundsRemaining !== starting.conditionInstances?.[i]?.roundsRemaining)
          ) {
            for (const c of condTick.expired) {
              expiredConditions.push({ combatantId: starting.id, combatantName: starting.name, conditionName: c.name });
            }
            Object.assign(startSet, conditionWriteSetFromInstances(condTick.kept));
          }
          tx.update(combatants).set(startSet).where(eq(combatants.id, starting.id)).run();
        }
      }

      const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
      tx.update(encounters)
        .set({
          status: 'running',
          round: 1,
          turnVersion: sql`${encounters.turnVersion} + 1`,
          turnIndex,
          currentCombatantId,
          turnPhase,
          lairResumeCombatantId,
          escalationDie: escalation.escalationDie,
          escalationDieHistory: escalation.escalationDieHistory ?? encounterRow.escalationDieHistory,
          // Turn timer (issue #1935): stamp the fresh server "now" the very first turn
          // begins, in the same transaction that flips status to running.
          turnStartedAt: ts,
          updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? encounterRow.updatedAt),
        })
        .where(eq(encounters.id, encounterId))
        .run();
      tx.update(campaigns).set({ activeEncounterId: encounterId, updatedAt: ts }).where(eq(campaigns.id, campaignId)).run();
      
      for (const e of expiredConditions) {
        this.appendEventInTransaction(tx, encounterId, 1, 'condition', {
          target: e.combatantName,
          targetId: e.combatantId,
          detail: `${e.conditionName} ended`,
        });
      }
    });

    // Seed the combat log with the opening turn (issue #61). Detail stays name-free
    // (issue #869) so listing can redact actor/target without prose leaking identity.
    const first =
      turnPhase === 'lair'
        ? null
        : currentCombatantId === null
          ? undefined
          : sorted.find((c) => c.id === currentCombatantId);
    await this.appendEvent(encounterId, 1, 'turn', {
      actor: turnPhase === 'lair' ? 'Lair' : first?.name ?? null,
      target: turnPhase === 'lair' ? 'Lair' : first?.name ?? null,
      actorId: first?.id ?? null,
      targetId: first?.id ?? null,
      detail: turnPhase === 'lair' ? 'Lair action (initiative 20)' : 'Combat started',
    });
    if (escalation.logDetail) {
      await this.appendEvent(encounterId, 1, 'override', {
        detail: escalation.logDetail,
        metadata: { escalationDie: escalation.escalationDie },
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.start',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId,
    });

    const snapshot = await this.getWithCombatantsOrThrow(encounterId, role);
    this.emitEncounterEvent('encounter.updated', campaignId, encounterId, snapshot.hidden);
    this.emitEncounterEvent('encounter.turn_changed', campaignId, encounterId, snapshot.hidden, {
      round: 1,
      turnIndex,
      currentCombatantId,
      combatantKind: first?.kind ?? null,
    });

    this.notifications.notifyCampaign(campaignId, user, {
      type: 'encounter_started',
      title: 'Encounter started',
      body: `Encounter '${encounterRow.name}' has begun.`,
      entityType: 'encounter',
      entityId: encounterId,
    }).catch(() => {});

    if (first?.kind === 'character' && first.characterId) {
      this.db
        .select({ ownerUserId: characters.ownerUserId })
        .from(characters)
        .where(eq(characters.id, first.characterId))
        .limit(1)
        .then(([char]) => {
          if (char && char.ownerUserId) {
            this.notifications.notifyUser(char.ownerUserId, campaignId, user, {
              type: 'encounter_turn',
              title: 'Your turn!',
              body: `It's ${first.name}'s turn in '${encounterRow.name}'.`,
              entityType: 'encounter',
              entityId: encounterId,
            }).catch(() => {});
          }
        })
        .catch(() => {});
    }

    return snapshot;
  }

  /**
   * DM/AI "Next turn" (issues #49, #413, #580).
   *
   * Two distinct failures used to share one gap here, and they need different fixes:
   *   - a RETRY of one intent (the response was lost; TanStack resends) must not advance
   *     twice — that is `idempotencyKey`, which replays the original response;
   *   - a RACE between two DM devices (two genuine intents arriving together) must not
   *     advance twice either — that is `expectedCurrentCombatantId`, a compare-and-swap
   *     against the live turn pointer, which 409s the loser instead of skipping a
   *     combatant's turn.
   * An idempotency key alone would let the race through (distinct keys, both fresh); CAS
   * alone would 409 a legitimate retry that had in fact already succeeded. Both are opt-in
   * so the classic bodyless call (and the MCP tool) keeps its historic behavior.
   */
  async nextTurn(
    encounterId: number,
    input: EncounterNextTurnInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertNoSafetyHold(encounterRow.campaignId); // #599
    if (encounterRow.status !== 'running') {
      throw new BadRequestException('Encounter is not running');
    }
    return this.advanceCurrentTurn(encounterRow, user, role, {
      auditAction: 'encounter.next_turn',
      expectedCurrentCombatantId: input.expectedCurrentCombatantId ?? undefined,
      requestedExpectedCurrentCombatantId: input.expectedCurrentCombatantId ?? null,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * End the current combatant's turn (issue #413). The player path: a character owner ends
   * their OWN active combatant's turn. Authorization is layered:
   *   1. the campaign's `dmControlsTurns` setting can forbid player advancement entirely;
   *   2. a non-DM must own the character linked to the CURRENT combatant (ownership);
   *   3. it must actually be that combatant's turn (current-turn validation);
   *   4. `requireDmTurnConfirmation` stages a player end-turn (409 asking for DM confirm);
   *      the DM then advances directly (a DM end-turn / next-turn IS the confirmation).
   * Advancement itself is serialized + double-advance-guarded inside advanceCurrentTurn via
   * `expectedCurrentCombatantId` — a stale/duplicate click after someone else advanced 409s
   * instead of skipping a second combatant's turn.
   */
  async endTurn(
    encounterId: number,
    input: EncounterEndTurnInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertNoSafetyHold(encounterRow.campaignId); // #599
    if (encounterRow.status !== 'running') {
      throw new BadRequestException('Encounter is not running');
    }
    const currentId = encounterRow.currentCombatantId;
    if (currentId === null) {
      throw new BadRequestException('No combatant currently has the turn');
    }
    const isDm = role === 'dm';
    const currentRole = role;
    // A successful player write changes the active combatant, so replay an exact,
    // actor-bound receipt after rechecking campaign authority but before active-owner
    // validation. Changed arguments fall through to the normal authorization path.
    if (!isDm && input.idempotencyKey) {
      const claim: EncounterOpClaim = {
        actorId: user.id,
        operation: 'turn.advance',
        key: input.idempotencyKey,
        encounterId,
        campaignId: encounterRow.campaignId,
        fingerprint: encounterOpFingerprint({ auditAction: 'encounter.end_turn', expectedCurrentCombatantId: input.expectedCurrentCombatantId ?? null }),
      };
      const prior = this.db.transaction((tx) => findExactPriorEncounterOp(tx, claim, Date.now()));
      if (prior && prior.responseRole === currentRole) {
        if (prior.response) return prior.response as EncounterWithCombatants;
        return this.getWithCombatantsOrThrow(encounterId, currentRole, user.id);
      }
    }
    const [campaign] = await this.db
      .select({ dmControlsTurns: campaigns.dmControlsTurns, requireDmTurnConfirmation: campaigns.requireDmTurnConfirmation })
      .from(campaigns)
      .where(eq(campaigns.id, encounterRow.campaignId))
      .limit(1);
    const dmControlsTurns = Boolean(campaign?.dmControlsTurns);
    const requireDmConfirm = Boolean(campaign?.requireDmTurnConfirmation);

    if (!isDm) {
      // (1) DM-only advancement setting: a player cannot end a turn at all.
      if (dmControlsTurns) {
        throw new ForbiddenException('This campaign is set to DM-only turn advancement — ask the DM to advance.');
      }
      // (2) + (3) ownership + current-turn validation: the player must own the character
      // linked to the CURRENT combatant.
      const current = await this.getCombatantRowOrThrow(encounterId, currentId);
      if (current.kind !== 'character' || current.characterId === null) {
        throw new ForbiddenException('Only the DM may end a monster or NPC turn.');
      }
      const [character] = await this.db.select().from(characters).where(eq(characters.id, current.characterId)).limit(1);
      if (!character || character.ownerUserId !== user.id) {
        throw new ForbiddenException('You may only end the turn of your own active character.');
      }
      // (4) configurable DM confirmation: stage the request for the DM (players cannot
      // self-confirm). The client shows a "waiting for DM" state; the DM then advances the
      // turn directly (end-turn / next-turn as dm) — that DM action IS the confirmation.
      if (requireDmConfirm) {
        await this.appendEvent(encounterId, encounterRow.round, 'note', {
          actor: current.name,
          actorId: current.id,
          detail: 'requested to end their turn (awaiting DM confirmation)',
        });
        this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, encounterRow.hidden);
        throw new ConflictException({
          code: 'TURN_END_NEEDS_DM_CONFIRM',
          message: 'This campaign requires the DM to confirm end-of-turn. Your request has been sent to the DM.',
          combatantId: current.id,
        });
      }
    }

    // Double-advance guard: only advance when the live current combatant still matches the
    // one the caller is ending. A player always ends the CURRENT combatant; an explicit
    // `expectedCurrentCombatantId` (a stale client) is honored when provided.
    const expected = input.expectedCurrentCombatantId ?? currentId;
    return this.advanceCurrentTurn(encounterRow, user, role, {
      auditAction: 'encounter.end_turn',
      expectedCurrentCombatantId: expected,
      requestedExpectedCurrentCombatantId: input.expectedCurrentCombatantId ?? null,
      endedByPlayer: !isDm,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * Serialized turn advance shared by DM "Next turn" and player "End turn" (issues #49 + #413).
   * Runs the whole read-compute-write inside ONE synchronous better-sqlite3 transaction so
   * concurrent advances cannot interleave (double-advance prevention): the FRESH current
   * pointer is read inside the tx, an optional `expectedCurrentCombatantId` that no longer
   * matches surfaces a 409 (someone already advanced), and the winner's committed pointer is
   * what the loser observes. Within the tx it also resolves per-turn effects: the ENDING
   * combatant's timed effects tick down (expiring ones are dropped) and the STARTING
   * combatant's per-turn action economy resets. Structured combat-log events (turn marker +
   * effect expiries) are appended after commit.
   */
  private async advanceCurrentTurn(
    encounterRow: typeof encounters.$inferSelect,
    user: RequestUser,
    role: Role,
    opts: {
      auditAction: string;
      expectedCurrentCombatantId?: number;
      /** The expectation as the CLIENT sent it (null/undefined when omitted) — see fingerprint below. */
      requestedExpectedCurrentCombatantId?: number | null;
      endedByPlayer?: boolean;
      idempotencyKey?: string;
    },
  ): Promise<EncounterWithCombatants> {
    const encounterId = encounterRow.id;
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);

    // Issue #580 — per-intent idempotency for the advance itself. Scoped by actor so two
    // DMs cannot collide on a shared key, and by encounter/campaign so a key minted at one
    // table can never be replayed against another.
    const opClaim: EncounterOpClaim | null = opts.idempotencyKey
      ? {
          actorId: user.id,
          operation: 'turn.advance',
          key: opts.idempotencyKey,
          encounterId,
          campaignId: encounterRow.campaignId,
          // Fingerprint the REQUEST, not the resolved expectation. `endTurn` defaults an
          // omitted `expectedCurrentCombatantId` to whoever currently holds the turn —
          // which, on the retry of an advance that already committed, is a DIFFERENT
          // combatant. Hashing the resolved value would make that retry look like a
          // different intent and 409 as key reuse, precisely when it most needs to replay.
          fingerprint: encounterOpFingerprint({
            auditAction: opts.auditAction,
            expectedCurrentCombatantId: opts.requestedExpectedCurrentCombatantId ?? null,
          }),
        }
      : null;
    let replayedEncounter: EncounterWithCombatants | null = null;
    let replayedWithoutBody = false;

    // Captured inside the tx for post-commit logging.
    let newRound = encounterRow.round;
    // The round the ENDING turn was in (before advanceTurn may increment it on a wrap).
    // Effect expiries happen at the end of that turn, so they must be logged under this
    // round, not the incremented `newRound` (issue #413 off-by-one).
    let endedRound = encounterRow.round;
    let newCurrentId: number | null = null;
    let newCurrentName: string | null = null;
    let endedName: string | null = null;
    let startingKind: string | null = null;
    let skippedTurns: Array<{ id: number; name: string; round: number }> = [];
    const expiredEffects: Array<{ combatantId: number; combatantName: string; effectName: string }> = [];
    const expiredConditions: Array<{ combatantId: number; combatantName: string; conditionName: string }> = [];
    // Issue #1921: recharge rolls for the starting combatant's spent recharge actions,
    // logged AFTER commit (mirrors expiredEffects/expiredConditions above).
    const rechargeRolls: Array<{ combatantId: number; combatantName: string; actionName: string; roll: number; needs: number; recovered: boolean }> = [];
    let escalationLogDetail: string | undefined;
    let escalationValue = encounterRow.escalationDie ?? 0;
    const turnTickSnapshot: TurnTickDelta = {
      toRound: encounterRow.round,
      toCurrentCombatantId: encounterRow.currentCombatantId,
      toPhase: encounterRow.turnPhase as EncounterTurnPhase,
      toLairResumeCombatantId: encounterRow.lairResumeCombatantId ?? null,
    };

    try {
      this.db.transaction((tx) => {
        // Dedup FIRST, before the CAS below. Order matters: a retry of an advance that
        // already succeeded would otherwise fail the compare-and-swap (the pointer has
        // moved — by this very operation) and surface a spurious "someone else advanced"
        // conflict for what was actually our own committed work.
        if (opClaim) {
          const prior = findPriorEncounterOp(tx, opClaim, Date.now());
          if (prior) {
            // Player projections include their own fog-concealed AoE templates, so a
            // role-only cached response is safe only for the DM's shared projection.
            if (role === 'dm' && prior.response && prior.responseRole === role) {
              replayedEncounter = prior.response as EncounterWithCombatants;
            } else {
              // Claim committed but its body was never backfilled (a crash in the moment
              // between commit and backfill), or it was rendered for a different role.
              // Either way the advance HAPPENED — fall through to fresh server truth
              // rather than re-running it.
              replayedWithoutBody = true;
            }
            return;
          }
        }
        const [fresh] = tx.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
        if (!fresh || (fresh.status as EncounterStatus) !== 'running') {
          throw new BadRequestException('Encounter is not running');
        }
        endedRound = fresh.round;
        const freshCurrentId = fresh.currentCombatantId;
        const freshPhase = (fresh.turnPhase as EncounterTurnPhase) ?? 'combatant';
        if (
          opts.expectedCurrentCombatantId !== undefined &&
          (freshPhase !== 'combatant' || freshCurrentId !== opts.expectedCurrentCombatantId)
        ) {
          // Someone advanced between the caller's read and this write — refuse rather than
          // skip a second combatant's turn or advance from the lair slot (double-advance prevention, issue #413).
          throw new ConflictException({
            code: 'TURN_ALREADY_ADVANCED',
            message: 'The turn already advanced — refresh the encounter before ending the turn again.',
            currentCombatantId: freshCurrentId,
          });
        }

        const rows = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all();
        const sorted = this.sortCombatantsWithAdapter(rows.map(combatantToDomain), 'running', adapter);
        const statblocks = new Map<number, ReturnType<RuleSystemAdapter['mapStatblock']>>();
        const ruleEntryIds = [...new Set(sorted.map((c) => c.ruleEntryId).filter((id): id is number => id !== null))];
        if (ruleEntryIds.length > 0) {
          const entryRows = tx
            .select({ id: ruleEntries.id, dataJson: ruleEntries.dataJson })
            .from(ruleEntries)
            .where(and(inArray(ruleEntries.id, ruleEntryIds), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, fresh.campaignId))))
            .all();
          for (const entry of entryRows) {
            const data = fromJsonText<Record<string, unknown>>(entry.dataJson ?? null, {});
            statblocks.set(entry.id, adapter.mapStatblock(data));
          }
        }
        const hasLairSlot = encounterHasLairSlotFromStatblocks(statblocks);

        const advanced = advanceEncounterTurn(
          sorted,
          freshCurrentId,
          fresh.round,
          freshPhase,
          hasLairSlot,
          fresh.lairResumeCombatantId ?? null,
        );
        const { turnIndex, round, currentCombatantId, phase, lairResumeCombatantId, roundWrapped, skipped } = advanced;
        newRound = round;
        newCurrentId = currentCombatantId;

        // Bind the snapshot to the post-advance encounter state so undo can verify it is
        // consuming the right snapshot when the turn pointer has moved without an advance.
        turnTickSnapshot.toRound = round;
        turnTickSnapshot.toCurrentCombatantId = currentCombatantId;
        turnTickSnapshot.toPhase = phase;
        turnTickSnapshot.toLairResumeCombatantId = lairResumeCombatantId;
        skippedTurns = skipped;
        const escalation = this.nextEscalationState(adapter, fresh, round, 'round');
        escalationValue = escalation.escalationDie;
        escalationLogDetail = roundWrapped ? escalation.logDetail : undefined;

        // Resolve effects on the ENDING combatant (the one whose turn we're leaving): tick
        // timed effects down, drop the expired. Only meaningful on a genuine combatant advance.
        const ending =
          freshPhase === 'combatant' && freshCurrentId !== null ? sorted.find((c) => c.id === freshCurrentId) : undefined;
        let endingConditionKept: ConditionInstance[] | undefined;
        if (ending) {
          endedName = ending.name;
          const effectPre = ending.activeEffects ?? [];
          const { kept: effectsKept, expired: effectsExpired } = tickEffectsAtTurnEnd(effectPre);
          const effectDelta = buildEffectTickDelta(effectPre, effectsKept);
          const conditionPre = ending.conditionInstances ?? [];
          const condTick = tickConditionInstancesAtTurnEnd(conditionPre);
          endingConditionKept = condTick.kept;
          const conditionDelta = buildConditionTickDelta(conditionPre, condTick.kept);
          turnTickSnapshot.ending = {
            combatantId: ending.id,
            conditionTicks: conditionDelta.ticks,
            conditionExpired: conditionDelta.expired,
            effectTicks: effectDelta.ticks,
            effectExpired: effectDelta.expired,
          };
          if (effectsExpired.length > 0) {
            for (const e of effectsExpired) expiredEffects.push({ combatantId: ending.id, combatantName: ending.name, effectName: e.name });
            tx.update(combatants).set({ activeEffects: toJsonText(effectsKept) }).where(eq(combatants.id, ending.id)).run();
          } else if (effectsKept.some((e, i) => e.roundsRemaining !== ending.activeEffects[i]?.roundsRemaining)) {
            // Durations changed (decremented) even though nothing expired — persist the tick.
            tx.update(combatants).set({ activeEffects: toJsonText(effectsKept) }).where(eq(combatants.id, ending.id)).run();
          }
          if (
            condTick.expired.length > 0 ||
            condTick.kept.some((c, i) => c.roundsRemaining !== ending.conditionInstances?.[i]?.roundsRemaining)
          ) {
            for (const c of condTick.expired) {
              expiredConditions.push({ combatantId: ending.id, combatantName: ending.name, conditionName: c.name });
            }
            tx.update(combatants)
              .set(conditionWriteSetFromInstances(condTick.kept))
              .where(eq(combatants.id, ending.id))
              .run();
          }
        } else if (freshPhase === 'lair') {
          endedName = 'Lair';
        }

        if (roundWrapped) {
          for (const row of rows) {
            const domain = combatantToDomain(row);
            if (domain.ruleEntryId === null) continue;
            const mapped = statblocks.get(domain.ruleEntryId);
            if (!mapped || !statblockSectionHasEntries(mapped.legendaryActions)) continue;
            const reset = resetLegendaryUsage(domain.turnState);
            if (reset !== domain.turnState) {
              tx.update(combatants).set({ turnState: toJsonText(reset) }).where(eq(combatants.id, row.id)).run();
            }
          }
        }

        // Reset the STARTING combatant's per-turn action economy (fresh action/bonus/reaction/
        // movement for its new turn). Concentration persists across turns.
        const starting = currentCombatantId === null ? undefined : sorted.find((c) => c.id === currentCombatantId);
        if (starting) {
          newCurrentName = starting.name;
          startingKind = starting.kind;
          // When the same combatant both ends and begins the turn, the start-of-turn tick must
          // run against the post-end-tick list, not the stale in-memory copy (issue #1445).
          const startConditionPre =
            starting.id === ending?.id ? (endingConditionKept ?? starting.conditionInstances ?? []) : (starting.conditionInstances ?? []);
          const condTick = tickConditionInstancesAtTurnStart(startConditionPre);
          const conditionDelta = buildConditionTickDelta(startConditionPre, condTick.kept);

          // Issue #1921: roll recharge for every currently-spent recharge action of the
          // combatant starting its turn, in this SAME transaction as resetTurnStateForStart
          // below. X/day pools never reach rollRechargeAtTurnStart at all — only entries
          // whose `uses.recharge` actually parses as `recharge-N-M` are passed in.
          const startingRow = rows.find((r) => r.id === starting.id);
          const rechargeEntries = startingRow
            ? (this.actionResolver?.usesTrackedActions(startingRow, fresh.campaignId) ?? [])
                .map((entry) => {
                  const range = parseRechargeRange(entry.uses.recharge);
                  // `max` rides along so the undo delta can clamp its `spent + 1` revert to
                  // the pool ceiling without re-resolving the action list at undo time.
                  return range
                    ? { key: entry.key, name: entry.name, min: range.min, max: effectiveActionUsesMax(entry.uses) }
                    : null;
                })
                .filter((e): e is { key: string; name: string; min: number; max: number } => e !== null)
            : [];
          let actionUsesRecharged: ActionUsesRechargeDelta[] = [];
          let nextActionUses: ActionUsesMap | null = null;
          if (startingRow && rechargeEntries.length > 0) {
            const currentUses = fromJsonText<ActionUsesMap>(startingRow.actionUses, {});
            const rolled = rollRechargeAtTurnStart(currentUses, rechargeEntries, () => rollDice('1d6').total);
            if (rolled.rolls.length > 0) {
              actionUsesRecharged = rolled.delta;
              nextActionUses = rolled.uses;
              for (const r of rolled.rolls) {
                rechargeRolls.push({
                  combatantId: starting.id,
                  combatantName: starting.name,
                  actionName: r.actionName,
                  roll: r.roll,
                  needs: r.needs,
                  recovered: r.recovered,
                });
              }
            }
          }

          // Active effects are not ticked at turn start; no effect delta to record.
          turnTickSnapshot.starting = {
            combatantId: starting.id,
            conditionTicks: conditionDelta.ticks,
            conditionExpired: conditionDelta.expired,
            effectTicks: [],
            effectExpired: [],
            actionUsesRecharged,
          };
          const reset = resetTurnStateForStart(starting.turnState);
          const startSet: Partial<typeof combatants.$inferInsert> = { turnState: toJsonText(reset) };
          if (
            condTick.expired.length > 0 ||
            condTick.kept.some((c, i) => c.roundsRemaining !== startConditionPre[i]?.roundsRemaining)
          ) {
            for (const c of condTick.expired) {
              expiredConditions.push({ combatantId: starting.id, combatantName: starting.name, conditionName: c.name });
            }
            Object.assign(startSet, conditionWriteSetFromInstances(condTick.kept));
          }
          if (nextActionUses) {
            startSet.actionUses = toJsonText(nextActionUses);
          }
          tx.update(combatants).set(startSet).where(eq(combatants.id, starting.id)).run();
        } else if (phase === 'lair') {
          newCurrentName = 'Lair';
        }

        const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
        tx.update(encounters)
          .set({
            turnIndex,
            round,
            turnVersion: sql`${encounters.turnVersion} + 1`,
            currentCombatantId,
            turnPhase: phase,
            lairResumeCombatantId,
            escalationDie: escalation.escalationDie,
            escalationDieHistory: escalation.escalationDieHistory ?? fresh.escalationDieHistory,
            // Turn timer (issue #1935): a fresh stamp for the NEW current turn, inside the
            // same serialized transaction as the pointer move. Guarded by the idempotency
            // dedup above (an early `return` there skips this whole tx.update), so a replayed
            // retry of the same intent never restamps a turn that already started.
            turnStartedAt: nowIso(),
            updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? fresh.updatedAt),
          })
          .where(eq(encounters.id, encounterId))
          .run();

        // Combat-log markers for auto-skipped dead/defeated combatants (issue #610).
        for (const skipped of skippedTurns) {
          this.appendEventInTransaction(tx, encounterId, skipped.round, 'turn', {
            actor: skipped.name,
            target: skipped.name,
            actorId: skipped.id,
            targetId: skipped.id,
            detail: 'skipped (down)',
          });
        }
        // Combat-log turn marker (issue #61). Names live on actor/target (+ ids); detail stays
        // name-free so #869 redaction cannot be bypassed by prose. The operation id (#580)
        // makes "did the turn advance twice?" answerable from the log alone: two turn markers
        // carrying the SAME operationId would be a double-advance, two markers with different
        // ids are two legitimate advances.
        const turnMeta: EncounterEventMetadata & { turnTickSnapshot?: TurnTickDelta } = opts.idempotencyKey
          ? { operationId: opts.idempotencyKey }
          : {};
        if (turnTickSnapshot.ending || turnTickSnapshot.starting) {
          turnMeta.turnTickSnapshot = turnTickSnapshot;
        }
        this.appendEventInTransaction(tx, encounterId, newRound, 'turn', {
          actor: newCurrentName,
          target: newCurrentName,
          actorId: newCurrentId,
          targetId: newCurrentId,
          detail:
            opts.endedByPlayer && endedName && endedName !== 'Lair'
              ? 'ended their turn'
              : newCurrentName === 'Lair'
                ? 'Lair action (initiative 20)'
                : '',
          metadata: turnMeta,
        });

        // Claim written in the SAME transaction as the pointer move. The response body is
        // the whole role-redacted encounter, which is assembled asynchronously below, so it
        // is backfilled immediately after commit instead of stored here. The atomic part is
        // the part that must be atomic: the claim can never be missing while the advance
        // stands (which would let a retry advance again), nor present while the advance
        // rolled back (which would wedge the turn).
        if (opClaim) recordEncounterOp(tx, opClaim, nowIso(), null);
      });
    } catch (err) {
      if (err instanceof EncounterOpRaceMarker) {
        // Same intent, two concurrent attempts: ours rolled back, theirs committed.
        const prior = await readEncounterOpAfterRace(this.db, err.claim);
        if (role === 'dm' && prior.response && prior.responseRole === role) return prior.response as EncounterWithCombatants;
        return this.getWithCombatantsOrThrow(encounterId, role, user.id);
      }
      throw err;
    }

    // An idempotent replay stops here — the advance already happened, so re-appending the
    // turn marker, re-auditing, or re-emitting would manufacture the very duplicate this
    // exists to prevent.
    if (replayedEncounter) return replayedEncounter;
    if (replayedWithoutBody) return this.getWithCombatantsOrThrow(encounterId, role, user.id);

    // Structured effect-expiry events (issue #413): one per expired effect on the combatant
    // whose turn just ended. Detail stays name-free (the effect name is generic content).
    for (const ex of expiredEffects) {
      // Log under the ENDING turn's round (endedRound), not newRound — on a wrap to the top
      // of the order advanceTurn increments the round, but the effect expired on the turn
      // that just ended (issue #413 off-by-one fix).
      await this.appendEvent(encounterId, endedRound, 'effect', {
        actor: ex.combatantName,
        actorId: ex.combatantId,
        detail: `effect expired: ${ex.effectName}`,
      });
    }
    for (const ex of expiredConditions) {
      await this.appendEvent(encounterId, endedRound, 'condition', {
        actor: ex.combatantName,
        actorId: ex.combatantId,
        detail: `condition expired: ${ex.conditionName}`,
      });
    }
    // Issue #1921: one combat-log line per recharge roll on the starting combatant's turn —
    // both outcomes are logged (acceptance criterion), under the NEW round (the roll happens
    // at the start of the combatant's turn, not the end of the prior one).
    //
    // The ability's NAME, the die result, and the THRESHOLD are all deliberately absent from
    // `detail`. An earlier revision embedded the name, reasoning by analogy with
    // `resolution.actionName` elsewhere in this file — but that analogy breaks: an action USE
    // is logged because the table just watched it happen. A recharge roll is invisible
    // bookkeeping that fires every turn for an ability that may never have been used, on a
    // monster whose statblock the DM may have deliberately left unrevealed (#1926) and whose
    // action list 403s a non-DM. The combat log is readable by every campaign member and
    // `redactEncounterEventsForViewer` masks only hidden-combatant identity, not action
    // names, so naming the ability here would hand players a statblock the server otherwise
    // withholds.
    //
    // `needed N+` is the same category of secret and had to go with it: it IS the statblock's
    // recharge condition, stated verbatim. Dropping the threshold alone would not have been
    // enough either — `rolled 3` plus `stays spent` bounds the threshold from below, and two
    // or three rounds of those lines converge on it exactly, so the roll goes too. What
    // survives is the acceptance criterion itself: both outcomes are logged, once per roll.
    //
    // Recovering the name, roll, and threshold FOR THE DM needs a DM-only log channel, which
    // does not exist yet (`metadata.dmText` is only scrubbed when the actor is a hidden NPC,
    // so it is not one) — that is the follow-up, not a reason to leak now.
    for (const r of rechargeRolls) {
      await this.appendEvent(encounterId, newRound, 'resource_changed', {
        actor: r.combatantName,
        actorId: r.combatantId,
        detail: r.recovered ? 'a limited-use ability recharges' : 'a limited-use ability stays spent',
      });
    }
    if (escalationLogDetail) {
      await this.appendEvent(encounterId, newRound, 'override', {
        detail: escalationLogDetail,
        metadata: { escalationDie: escalationValue },
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: opts.auditAction,
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
      // Issue #580: the operation id in the audit trail is what lets an operator
      // reconstruct, after the fact, whether a disputed double-advance came from two
      // clicks or from one click retried.
      detail: opts.idempotencyKey ? `round ${newRound} (op ${opts.idempotencyKey})` : `round ${newRound}`,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, encounterRow.hidden);
    this.emitEncounterEvent('encounter.turn_changed', encounterRow.campaignId, encounterId, encounterRow.hidden, {
      round: newRound,
      currentCombatantId: newCurrentId,
      combatantKind: startingKind,
    });

    const [newCurrentRow] = await this.db.select().from(combatants).where(eq(combatants.id, newCurrentId!)).limit(1);
    if (newCurrentRow?.kind === 'character' && newCurrentRow.characterId) {
      this.db
        .select({ ownerUserId: characters.ownerUserId })
        .from(characters)
        .where(eq(characters.id, newCurrentRow.characterId))
        .limit(1)
        .then(([char]) => {
          if (char && char.ownerUserId) {
            this.notifications.notifyUser(char.ownerUserId, encounterRow.campaignId, user, {
              type: 'encounter_turn',
              title: 'Your turn!',
              body: `It's ${newCurrentRow.name}'s turn in '${encounterRow.name}'.`,
              entityType: 'encounter',
              entityId: encounterId,
            }).catch(() => {});
          }
        })
        .catch(() => {});
    }

    const view = await this.getWithCombatantsOrThrow(encounterId, role, user.id);
    // Backfill the original response onto the already-committed claim (issue #580) so a
    // retry gets the turn pointer THIS call produced, not merely "some current state".
    // Best-effort by construction: the claim (the part that prevents a second advance) is
    // already durable, and a replay that finds no body falls back to fresh truth.
    if (opClaim) await backfillEncounterOpResponse(this.db, opClaim, { body: view, role });
    return view;
  }

  /**
   * DM undo of the last turn advance (issue #413). Steps the pointer BACKWARD over the sorted
   * order (see {@link retreatTurn}), decrementing the round when unwrapping past the top.
   * Serialized like advanceCurrentTurn so it can't race a concurrent advance. Timed condition
   * and effect ticks applied on the way forward are replayed from a snapshot stored in the
   * advance event's metadata (issue #1445). DM-only (enforced by the controller's `dm` role gate).
   */
  async undoTurn(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertNoSafetyHold(encounterRow.campaignId); // #599
    if (encounterRow.status !== 'running') {
      throw new BadRequestException('Encounter is not running');
    }
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    let newRound = encounterRow.round;
    let newCurrentId: number | null = null;
    let newCurrentName: string | null = null;
    let newCurrentKind: 'character' | 'monster' | 'npc' | null = null;
    let escalationLogDetail: string | undefined;
    let escalationValue = encounterRow.escalationDie ?? 0;
    let restoredLogEntries: Array<{
      combatantId: number;
      combatantName: string;
      conditionNames: string[];
      effectNames: string[];
      actionUsesNames: string[];
    }> = [];

    this.db.transaction((tx) => {
      // Issue #1445: the turn-advance event carries a snapshot of the ending/starting combatant
      // conditionInstances and activeEffects from before they were ticked. Read it directly from
      // metadataJson (not the public event-to-domain mapping) so undo can restore state.
      const [lastTurnEvent] = tx
        .select()
        .from(encounterEvents)
        .where(
          and(
            eq(encounterEvents.encounterId, encounterId),
            eq(encounterEvents.type, 'turn'),
            like(encounterEvents.metadataJson, '%"turnTickSnapshot"%'),
          ),
        )
        .orderBy(desc(encounterEvents.id))
        .limit(1)
        .all();
      const turnMeta = lastTurnEvent?.metadataJson
        ? (JSON.parse(lastTurnEvent.metadataJson) as EncounterEventMetadata & { turnTickSnapshot?: TurnTickDelta })
        : undefined;
      let snapshot = turnMeta?.turnTickSnapshot;

      const [fresh] = tx.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
      if (!fresh || (fresh.status as EncounterStatus) !== 'running') {
        throw new BadRequestException('Encounter is not running');
      }

      const rows = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all();
      const sorted = this.sortCombatantsWithAdapter(rows.map(combatantToDomain), 'running', adapter);
      const statblocks = new Map<number, ReturnType<RuleSystemAdapter['mapStatblock']>>();
      const ruleEntryIds = [...new Set(sorted.map((c) => c.ruleEntryId).filter((id): id is number => id !== null))];
      if (ruleEntryIds.length > 0) {
        const entryRows = tx
          .select({ id: ruleEntries.id, dataJson: ruleEntries.dataJson })
          .from(ruleEntries)
          .where(and(inArray(ruleEntries.id, ruleEntryIds), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, fresh.campaignId))))
          .all();
        for (const entry of entryRows) {
          const data = fromJsonText<Record<string, unknown>>(entry.dataJson ?? null, {});
          statblocks.set(entry.id, adapter.mapStatblock(data));
        }
      }
      const hasLairSlot = encounterHasLairSlotFromStatblocks(statblocks);
      const freshPhase = (fresh.turnPhase as EncounterTurnPhase) ?? 'combatant';

      if (
        fresh.round <= 1 &&
        freshPhase === 'combatant' &&
        sorted.length > 0 &&
        fresh.currentCombatantId === sorted[0].id
      ) {
        throw new BadRequestException('Cannot undo past the start of the encounter');
      }

      const { turnIndex, round, currentCombatantId, phase, lairResumeCombatantId, roundWrapped } = retreatEncounterTurn(
        sorted,
        fresh.currentCombatantId,
        fresh.round,
        freshPhase,
        hasLairSlot,
        fresh.lairResumeCombatantId ?? null,
      );
      newRound = round;
      newCurrentId = currentCombatantId;

      // Issue #1445: the snapshot belongs to the advance being undone. Because the turn
      // pointer can move without writing a snapshot (e.g. removing the current combatant),
      // only apply the newest 'turn' event's snapshot when its post-advance state (round,
      // current, phase, lair resume) or its ending combatant matches the state the undo
      // is retreating to. This prevents applying a stale snapshot to an unrelated transition.
      if (
        snapshot &&
        !(
          (snapshot.toRound === round &&
            snapshot.toCurrentCombatantId === currentCombatantId &&
            snapshot.toPhase === phase &&
            snapshot.toLairResumeCombatantId === (lairResumeCombatantId ?? null)) ||
          snapshot.ending?.combatantId === currentCombatantId
        )
      ) {
        snapshot = undefined;
      }

      const escalation = this.nextEscalationState(adapter, fresh, round, 'undo');
      escalationValue = escalation.escalationDie;
      escalationLogDetail = escalation.logDetail;

      if (roundWrapped) {
        for (const row of rows) {
          const domain = combatantToDomain(row);
          if (domain.ruleEntryId === null) continue;
          const mapped = statblocks.get(domain.ruleEntryId);
          if (!mapped || !statblockSectionHasEntries(mapped.legendaryActions)) continue;
          const reset = resetLegendaryUsage(domain.turnState);
          if (reset !== domain.turnState) {
            tx.update(combatants).set({ turnState: toJsonText(reset) }).where(eq(combatants.id, row.id)).run();
          }
        }
      }

      // Issue #1445: restore the conditionInstances and activeEffects that nextTurn ticked on
      // the ending and starting combatants. If a combatant was removed between the advance and
      // the undo, the row will not be found and the snapshot is skipped (safe, not throw).
      // Apply the stored delta to current state: only adjust roundsRemaining for ticked IDs that
      // are still in the post-tick state, and re-add only the expired IDs that are not present.
      // Then consume the snapshot so the next undo selects the previous turn's snapshot.
      const restoredLog: Array<{
        combatantId: number;
        combatantName: string;
        conditionNames: string[];
        effectNames: string[];
        actionUsesNames: string[];
      }> = [];
      if (snapshot) {
        type Working = {
          row: typeof combatants.$inferSelect;
          conditions: ConditionInstance[];
          effects: ActiveEffect[];
          actionUses: ActionUsesMap;
          conditionRestored: string[];
          effectRestored: string[];
          actionUsesRestored: string[];
        };
        const workByCombatant = new Map<number, Working>();
        for (const side of ['ending', 'starting'] as const) {
          const entry = snapshot[side];
          if (!entry) continue;
          let working = workByCombatant.get(entry.combatantId);
          if (!working) {
            const row = rows.find((r) => r.id === entry.combatantId);
            if (!row) continue;
            working = {
              row,
              conditions: parseConditionInstances(row.conditionInstances, fromJsonText<string[]>(row.conditions, [])),
              effects: parseActiveEffects(row.activeEffects),
              actionUses: fromJsonText<ActionUsesMap>(row.actionUses, {}),
              conditionRestored: [],
              effectRestored: [],
              actionUsesRestored: [],
            };
            workByCombatant.set(entry.combatantId, working);
          }

          const conditionResult = applyConditionTickDelta(entry, working.conditions);
          const effectResult = applyEffectTickDelta(entry, working.effects);
          working.conditions = conditionResult.merged;
          working.effects = effectResult.merged;
          working.conditionRestored.push(...conditionResult.restoredNames);
          working.effectRestored.push(...effectResult.restoredNames);
          // Issue #1921: put a recharged action back to "spent" if THIS is the turn-start
          // tick that recharged it — mirrors condition/effect tick undo above.
          if (entry.actionUsesRecharged && entry.actionUsesRecharged.length > 0) {
            const usesResult = undoActionUsesRecharge(working.actionUses, entry.actionUsesRecharged);
            working.actionUses = usesResult.uses;
            working.actionUsesRestored.push(...usesResult.restoredNames);
          }
        }

        for (const [combatantId, working] of workByCombatant) {
          const conditionNames = [...new Set(working.conditionRestored)];
          const effectNames = [...new Set(working.effectRestored)];
          const actionUsesNames = [...new Set(working.actionUsesRestored)];
          if (conditionNames.length > 0 || effectNames.length > 0 || actionUsesNames.length > 0) {
            restoredLog.push({
              combatantId,
              combatantName: working.row.name,
              conditionNames,
              effectNames,
              actionUsesNames,
            });

            const writeSet: Partial<typeof combatants.$inferInsert> = {
              activeEffects: toJsonText(working.effects),
              ...conditionWriteSetFromInstances(working.conditions),
            };
            if (actionUsesNames.length > 0) {
              writeSet.actionUses = toJsonText(working.actionUses);
            }
            tx.update(combatants).set(writeSet).where(eq(combatants.id, combatantId)).run();
          }
        }

        // Consume the snapshot so a second consecutive undo selects the previous turn.
        if (lastTurnEvent && turnMeta) {
          const consumedMeta: Record<string, unknown> = { ...turnMeta };
          delete consumedMeta.turnTickSnapshot;
          tx.update(encounterEvents)
            .set({
              metadataJson: Object.keys(consumedMeta).length > 0 ? JSON.stringify(consumedMeta) : null,
            })
            .where(eq(encounterEvents.id, lastTurnEvent.id))
            .run();
        }
      }
      restoredLogEntries = restoredLog;

      const restored =
        phase === 'combatant' && currentCombatantId !== null
          ? sorted.find((c) => c.id === currentCombatantId)
          : undefined;
      newCurrentName = phase === 'lair' ? 'Lair' : restored?.name ?? null;
      newCurrentKind = restored?.kind ?? null;
      if (restored) {
        const reset = resetTurnStateForStart(restored.turnState);
        tx.update(combatants).set({ turnState: toJsonText(reset) }).where(eq(combatants.id, restored.id)).run();
      }

      const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
      tx.update(encounters)
        .set({
          turnIndex,
          round,
          turnVersion: sql`${encounters.turnVersion} + 1`,
          currentCombatantId,
          turnPhase: phase,
          lairResumeCombatantId,
          escalationDie: escalation.escalationDie,
          escalationDieHistory: escalation.escalationDieHistory ?? fresh.escalationDieHistory,
          // Turn timer (issue #1935): undo restores a FRESH stamp, not the pre-advance one —
          // a documented restart. The prior elapsed time is intentionally gone; undo produces
          // a new "now" for whichever turn it retreats to, inside this same transaction.
          turnStartedAt: nowIso(),
          updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? fresh.updatedAt),
        })
        .where(eq(encounters.id, encounterId))
        .run();
    });

    await this.appendEvent(encounterId, newRound, 'override', {
      actor: newCurrentName,
      actorId: newCurrentId,
      targetId: newCurrentId,
      detail: 'turn advance undone',
    });
    if (escalationLogDetail) {
      await this.appendEvent(encounterId, newRound, 'override', {
        detail: escalationLogDetail,
        metadata: { escalationDie: escalationValue },
      });
    }

    // Issue #1445: log what timed state was restored, mirroring how expiry is logged.
    for (const entry of restoredLogEntries) {
      for (const name of entry.conditionNames) {
        await this.appendEvent(encounterId, newRound, 'condition', {
          actor: entry.combatantName,
          actorId: entry.combatantId,
          detail: `condition restored: ${name}`,
        });
      }
      for (const name of entry.effectNames) {
        await this.appendEvent(encounterId, newRound, 'effect', {
          actor: entry.combatantName,
          actorId: entry.combatantId,
          detail: `effect restored: ${name}`,
        });
      }
      // Issue #1921: undoing a turn advance that recharged an action puts it back to spent.
      // The ability's NAME stays out of `detail` for the same secrecy reason as the forward
      // recharge log — this is player-visible and would expose an unrevealed statblock.
      for (const _name of entry.actionUsesNames) {
        await this.appendEvent(encounterId, newRound, 'resource_changed', {
          actor: entry.combatantName,
          actorId: entry.combatantId,
          detail: 'limited-use ability recharge undone',
        });
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.undo_turn',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
      detail: `round ${newRound}`,
    });
    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, encounterRow.hidden);
    this.emitEncounterEvent('encounter.turn_changed', encounterRow.campaignId, encounterId, encounterRow.hidden, {
      round: newRound,
      currentCombatantId: newCurrentId,
      combatantKind: newCurrentKind,
      turnReverted: true,
    });
    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  async updateEscalationDie(
    encounterId: number,
    input: EncounterEscalationUpdateInput,
    user: RequestUser,
    role: Role,
  ): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    if (!isArchmageAdapter(adapter)) {
      throw new BadRequestException('Escalation die controls are only available for 13th Age encounters');
    }

    const held = input.held ?? (encounterRow.escalationDieHeld ?? false);
    const override = input.override !== undefined ? input.override : (encounterRow.escalationDieOverride ?? null);
    const previous = encounterRow.escalationDie ?? 0;
    const value = override ?? (held ? previous : archmageEscalationDieForRound(adapter, encounterRow.round));
    const source: EscalationDieHistoryEntry['source'] = input.override !== undefined ? 'override' : 'hold';
    const note =
      override !== null
        ? `override to +${value}`
        : held
          ? `held at +${value}`
          : `automatic round ${encounterRow.round} default +${value}`;
    const entry = this.escalationEntry(encounterRow.round, value, source, held, override, note);
    const history = this.appendEscalationHistory(encounterRow.escalationDieHistory, entry);

    const currentEnc = await this.db.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
    await this.db
      .update(encounters)
      .set({
        escalationDie: value,
        escalationDieHeld: held,
        escalationDieOverride: override,
        escalationDieHistory: history,
        updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? encounterRow.updatedAt),
      })
      .where(eq(encounters.id, encounterId));

    await this.appendEvent(encounterId, encounterRow.round, 'override', {
      detail: `escalation die ${note}`,
      metadata: { escalationDie: value },
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.escalation_die.update',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
      detail: JSON.stringify(input),
    });
    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, encounterRow.hidden);
    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  /**
   * Build the current-turn workspace read model (issue #413) — "what can I do now?" for the
   * active combatant. Derived server-side from the encounter + combatant + campaign-adapter
   * state on every read (no stored blob). Secrecy: the DETAILED workspace (action economy,
   * suggested actions, effects, prompts) is only populated for the DM or the user who owns
   * the current combatant's character; other viewers get identity + round only, so a monster's
   * turn never leaks its abilities/effects to players (mirrors the issue #43/#869 gates).
   */
  async getTurnWorkspace(encounterId: number, user: RequestUser, role: Role): Promise<TurnWorkspace> {
    const row = await this.getRowOrThrow(encounterId);
    if (role !== 'dm' && !isVisibleTo({ hidden: row.hidden }, role)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    const status = row.status as EncounterStatus;
    const [campaign] = await this.db
      .select({ dmControlsTurns: campaigns.dmControlsTurns, requireDmTurnConfirmation: campaigns.requireDmTurnConfirmation })
      .from(campaigns)
      .where(eq(campaigns.id, row.campaignId))
      .limit(1);
    const dmControlsTurns = Boolean(campaign?.dmControlsTurns);
    const requireDmTurnConfirmation = Boolean(campaign?.requireDmTurnConfirmation);

    const base: TurnWorkspace = {
      encounterId,
      status,
      round: row.round,
      current: null,
      next: null,
      isYourTurn: false,
      canEndTurn: false,
      dmControlsTurns,
      requireDmTurnConfirmation,
      actionEconomy: [],
      movement: null,
      reactionAvailable: false,
      concentration: null,
      activeEffects: [],
      suggestedActions: [],
      startPrompts: [],
      endPrompts: [],
      spellSlots: null,
      spells: [],
    };
    if (status !== 'running') {
      return base;
    }
    if (row.turnPhase === 'lair') {
      const isDm = role === 'dm';
      return {
        ...base,
        current: null,
        next: null,
        isYourTurn: false,
        canEndTurn: isDm,
      };
    }
    if (row.currentCombatantId === null) {
      return base;
    }

    const adapter = await this.adapterForCampaign(row.campaignId);
    const rows = await this.listCombatantRows(encounterId);
    const sorted = this.sortCombatantsWithAdapter(rows.map(combatantToDomain), 'running', adapter);
    const currentIdx = sorted.findIndex((c) => c.id === row.currentCombatantId);
    if (currentIdx < 0) return base;
    const current = sorted[currentIdx];
    const nextCombatant = sorted[(currentIdx + 1) % sorted.length];

    const isDm = role === 'dm';
    const currentActor = await this.toTurnActor(current);
    const nextActor = await this.toTurnActor(nextCombatant);
    const isYourTurn = currentActor.ownerUserId !== null && currentActor.ownerUserId === user.id;
    const canEndTurn = isDm || (isYourTurn && !dmControlsTurns);

    // Secrecy gate: only the DM or the current combatant's owner sees the detailed workspace.
    const canSeeDetail = isDm || isYourTurn;
    if (!canSeeDetail) {
      return { ...base, current: currentActor, next: nextActor, isYourTurn, canEndTurn };
    }

    const model = actionEconomyForAdapter(adapter);
    const used = current.turnState.used;
    const movementSlot = model.slots.find((s) => s.kind === 'movement');
    // Issue #1910 review (Devin, PR #1980, round 4): resolve the per-combatant
    // movement max as the combatant's own add-time speed snapshot, or — full
    // stop — the adapter's movement-slot max (e.g. 30 ft for 5e). Deliberately
    // NOT falling through to the linked character's live speed when the
    // snapshot is null: `combatant.speed === null` is unavoidably ambiguous
    // between "this row predates the speed column" and "the linked character
    // had no speed set at add time" (Character.speed defaults to null, so the
    // second case is every character until someone fills in a value) — the two
    // cases are indistinguishable at the DB level without a discriminator
    // column, and a live-character fallback resolves BOTH the same way,
    // reintroducing exactly the retroactive-change bug this snapshot exists to
    // prevent for the (overwhelmingly common) second case. Falling through to
    // the adapter default instead costs nothing relative to pre-PR behavior —
    // every combatant reported the hardcoded adapter constant before this
    // column existed, which for 5e is the same 30 the default resolves to now.
    //
    // Routed through the shared `movementSlotMax` (encounters.logic.ts, round 5 review)
    // rather than computed inline: `ActionResolverService.resolveActionEconomyCost` calls
    // the SAME function for the movement spend/guard path, so this DISPLAY value and that
    // ENFORCEMENT value cannot drift apart the way they did before round 5.
    const resolvedMovementMax = movementSlot ? movementSlotMax('movement', movementSlot.max, current.speed) : 0;
    const actionEconomy = model.slots.map((slot) => ({
      key: slot.key,
      label: slot.label,
      help: slot.help,
      kind: slot.kind,
      max: movementSlotMax(slot.kind, slot.max, current.speed),
      used: slot.kind === 'movement' ? current.turnState.movementUsedFt : used[slot.key] ?? 0,
      resetsAt: slot.resetsAt,
    }));
    const reactionSlot = model.slots.find((s) => s.kind === 'reaction');
    const suggestedActions = await this.suggestedActionsForCombatant(current);

    // Issue #1900: spellSlots/spells are the in-combat Spellbook's real data source, gated
    // by the exact same canSeeDetail check as the rest of the detailed workspace above — a
    // player never receives another PC's or a monster's spell data through this payload.
    // Scoped to character actors only (a monster/NPC has no persisted spell-slot pool).
    let spellSlots: Record<string, SpellSlotLevel> | null = null;
    let spells: TurnSpellEntry[] = [];
    if (current.kind === 'character' && current.characterId !== null) {
      spellSlots = await this.spellSlotsForCharacter(current.characterId);
      spells = deriveTurnSpells(suggestedActions);
    }

    return {
      ...base,
      current: currentActor,
      next: nextActor,
      isYourTurn,
      canEndTurn,
      actionEconomy,
      movement: movementSlot ? { maxFt: resolvedMovementMax, usedFt: current.turnState.movementUsedFt } : null,
      reactionAvailable: reactionSlot ? (used[reactionSlot.key] ?? 0) < reactionSlot.max : false,
      concentration: current.turnState.concentration,
      activeEffects: current.activeEffects,
      suggestedActions,
      startPrompts: deriveStartTurnPrompts(current),
      endPrompts: deriveEndTurnPrompts(current, model.slots),
      spellSlots,
      spells,
    };
  }

  /** The character's persisted per-level spell slot map (issue #1900), `{}` when it has none. */
  private async spellSlotsForCharacter(characterId: number): Promise<Record<string, SpellSlotLevel>> {
    const [character] = await this.db.select({ spellSlots: characters.spellSlots }).from(characters).where(eq(characters.id, characterId)).limit(1);
    return fromJsonText<Record<string, SpellSlotLevel>>(character?.spellSlots ?? null, {});
  }

  /** Resolve a combatant into a TurnActor, looking up the linked character's owner (issue #413). */
  private async toTurnActor(c: Combatant): Promise<TurnActor> {
    let ownerUserId: string | null = null;
    if (c.kind === 'character' && c.characterId !== null) {
      const [character] = await this.db
        .select({ ownerUserId: characters.ownerUserId })
        .from(characters)
        .where(eq(characters.id, c.characterId))
        .limit(1);
      ownerUserId = character?.ownerUserId ?? null;
    }
    return {
      combatantId: c.id,
      name: c.name,
      kind: c.kind,
      characterId: c.characterId,
      ownerUserId,
      deathState: c.deathState,
      deathSaveSuccesses: c.deathSaveSuccesses,
      deathSaveFailures: c.deathSaveFailures,
    };
  }

  /**
   * Gather suggested actions for the current combatant from its sheet / statblock (issue #413).
   * Characters draw from their `actions` list; monsters/NPCs from the linked compendium
   * statblock's actions/reactions/legendary actions (mapped via the campaign adapter so the
   * field names aren't hardcoded to one schema). Best-effort + defensive — a missing or
   * malformed source yields an empty list rather than throwing.
   */
  private async suggestedActionsForCombatant(c: Combatant): Promise<TurnSuggestedAction[]> {
    const out: TurnSuggestedAction[] = [];
    const pushAction = (defaultSource: string, actions: ReturnType<typeof combatantActionsFromStatblock>, startIndex: number) => {
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const source = typeof a.kind === 'string' && a.kind ? a.kind.slice(0, 40) : defaultSource;
        const bits = [a.toHit, a.damage, a.notes].filter(Boolean);
        out.push({
          name: a.name.slice(0, 160),
          source,
          // Monster/NPC statblock actions are never equipped-item rows.
          equippedItemName: null,
          summary: bits.join(' · ').slice(0, 600),
          toHit: a.toHit ?? '',
          damage: a.damage ?? '',
          actionIndex: startIndex + i,
          resolvable: isResolvableSpec(a.spec),
          spec: a.spec ?? null,
        });
      }
    };
    if (c.kind === 'character' && c.characterId !== null) {
      const [character] = await this.db
        .select({ id: characters.id, campaignId: characters.campaignId, actions: characters.actions })
        .from(characters)
        .where(eq(characters.id, c.characterId))
        .limit(1);
      if (!character) return out;
      // Issue #1901: sheet actions + equipped-item actions, in the SAME merged index space
      // ActionResolverService's listUsableActions/resolveSpec use — actionIndex N on this
      // payload means the same action N on those. Falls back to sheet-only (pre-#1901
      // behavior) when this service was constructed without the optional dependency (some
      // hand-rolled test doubles predate it).
      type ActionRow = { name?: unknown; kind?: unknown; notes?: unknown; damage?: unknown; toHit?: unknown; spec?: unknown };
      const rows: Array<{ row: ActionRow; itemName: string | null }> = this.actionResolver
        ? (this.actionResolver.characterUsableActionRows(character) as Array<{ row: ActionRow; itemName: string | null }>)
        : fromJsonText<ActionRow[]>(character.actions, []).map((row) => ({ row, itemName: null }));
      for (let i = 0; i < rows.length; i++) {
        const { row: a, itemName } = rows[i];
        if (typeof a?.name !== 'string' || a.name.length === 0) continue;
        const bits = [typeof a.toHit === 'string' ? a.toHit : '', typeof a.damage === 'string' ? a.damage : '', typeof a.notes === 'string' ? a.notes : ''].filter(Boolean);
        // Validate through the full ActionSpec schema (not a bare passthrough) — same as
        // resolveSpec's `ActionSpec.safeParse(raw?.spec)` — so isResolvableSpec always sees
        // a schema-defaulted spec (e.g. attack.bonus present as '' rather than absent) and
        // this stays best-effort/defensive per the doc comment above rather than throwing on
        // a spec shape that predates a field default or was never written through the
        // validated character-upsert path.
        const specParsed = ActionSpec.safeParse(a.spec);
        const spec = specParsed.success ? specParsed.data : undefined;
        out.push({
          name: a.name.slice(0, 160),
          // Issue #1901 review (devin-ai-integration): `source` is the Actions/Bonus/
          // Reactions tab bucketing key AND the fallback spell-list detector on the web side
          // (TurnWorkspace.tsx) — it must stay the action's economy/kind hint for an
          // equipped-item row exactly like a sheet action, never the equipping item's name.
          // The item name is carried separately via `equippedItemName` below so the UI can
          // still label it without corrupting `source`'s established meaning.
          source: typeof a.kind === 'string' && a.kind ? a.kind.slice(0, 40) : 'action',
          equippedItemName: itemName,
          summary: bits.join(' · ').slice(0, 600),
          toHit: typeof a.toHit === 'string' ? a.toHit : '',
          damage: typeof a.damage === 'string' ? a.damage : '',
          actionIndex: i,
          resolvable: isResolvableSpec(spec),
          spec: spec ?? null,
        });
      }
      return out.slice(0, 100);
    }
    if (c.statblock) {
      pushAction('action', combatantActionsFromStatblock(c.statblock), 0);
      return out.slice(0, 100);
    }
    if (c.ruleEntryId !== null) {
      const encounterRow = await this.getRowOrThrow(c.encounterId);
      const adapter = await this.adapterForCampaign(encounterRow.campaignId);
      const { ruleSystem } = await this.ruleSystemForCampaign(encounterRow.campaignId);
      const [entry] = await this.db.select({ dataJson: ruleEntries.dataJson }).from(ruleEntries).where(and(eq(ruleEntries.id, c.ruleEntryId), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, encounterRow.campaignId)))).limit(1);
      const data = fromJsonText<Record<string, unknown>>(entry?.dataJson ?? null, {});
      const expanded = expandStatblockActions(data, adapter, ruleSystem ?? '');
      pushAction('action', expanded, 0);
      return out.slice(0, 100);
    }
    return out;
  }

  /**
   * Declare / resolve action economy, movement, concentration, effects, and the delay/ready
   * turn-order tools on a combatant (issue #413). Authorization mirrors updateCombatant: the
   * DM may edit any combatant; a non-DM only a combatant linked to a character they own. The
   * whole read-modify-write runs in one synchronous transaction off the FRESH row so
   * concurrent declarations compose instead of clobbering (same pattern as the condition/HP
   * paths). Structured combat-log notes are appended for meaningful changes.
   */
  async updateCombatantTurnState(
    encounterId: number,
    combatantId: number,
    patch: CombatantTurnStatePatchInput,
    user: RequestUser,
    role: Role,
  ): Promise<Combatant> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounterRow);
    const existing = await this.getCombatantRowOrThrow(encounterId, combatantId);
    const isDm = role === 'dm';
    if (!isDm) {
      if (existing.kind !== 'character' || existing.characterId === null) {
        throw new ForbiddenException('Only the DM may modify this combatant’s turn state.');
      }
      const [character] = await this.db.select().from(characters).where(eq(characters.id, existing.characterId)).limit(1);
      if (!character || character.ownerUserId !== user.id) {
        throw new ForbiddenException('You may only modify the turn state of your own character.');
      }
    }
    if (patch.resolveConcentrationCheck && patch.concentration !== undefined) {
      throw new BadRequestException('Resolve a concentration check separately from directly setting concentration.');
    }

    const logs: Array<{ detail: string }> = [];
    let shouldNudge = false;
    let row!: typeof combatants.$inferSelect;
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    let legendaryMax = 0;
    if (existing.ruleEntryId !== null) {
      const [entry] = await this.db
        .select({ dataJson: ruleEntries.dataJson })
        .from(ruleEntries)
        .where(and(eq(ruleEntries.id, existing.ruleEntryId), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, encounterRow.campaignId))))
        .limit(1);
      const mapped = adapter.mapStatblock(fromJsonText<Record<string, unknown>>(entry?.dataJson ?? null, {}));
      if (statblockSectionHasEntries(mapped.legendaryActions)) legendaryMax = LEGENDARY_ACTIONS_PER_ROUND;
    }

    this.db.transaction((tx) => {
      const [fresh] = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
      const turnState = CombatantTurnState.parse(fromJsonText<unknown>(fresh.turnState, null) ?? {});
      const effects = zod.array(ActiveEffect).safeParse(fromJsonText<unknown>(fresh.activeEffects, null));
      const activeEffects: ActiveEffectType[] = effects.success ? effects.data : [];

      // Unconditionally nudge so the client receives the update (issue #1457)
      shouldNudge = true;


      // #1674 — bound EVERY slot against the same adapter-owned action-economy model the
      // action-resolver's apply_action spend path consumes (#1637), not a second copy of the
      // rule: `actionEconomySlotMax` (encounters.logic.ts) is the one place "how many of this
      // slot does this combatant have" is computed for the whole encounters module. Legendary
      // composes into that same helper via the `hasLegendaryActions` flag this method already
      // derived above (outside the transaction, unlike the resolver's in-transaction lookup —
      // different structural shape, same rule per #1637/#1674's shared reasoning).
      //
      // Convention (#1570/#1571, extended by #1637): count-based spends error, restores clamp.
      // `useSlot` / `setSlotUsed` past the slot's max is a 400 carrying
      // `code`/`slot`/`remaining`/`max` in the exact shape #1637 established; `releaseSlot`
      // keeps flooring at 0 with no error, matching `applySpellSlotDelta`'s refund asymmetry.
      // Movement is tracked as a distance, not a fixed spendable slot: adapter movement `max`
      // is an advisory/default display value and cannot represent per-combatant speed, Dash,
      // or gridless systems where `max === 0` means "undefined/unbounded".
      const hasLegendaryActions = legendaryMax > 0;
      const rejectSlotOverflow = (slot: string, usedBefore: number, max: number): never => {
        const remaining = Math.max(0, max - usedBefore);
        throw new BadRequestException({
          code: 'action_economy_exhausted',
          message: `Only ${remaining} of ${max} "${slot}" remain this turn.`,
          slot,
          remaining,
          max,
        });
      };

      if (patch.resetTurn) {
        turnState.used = {};
        turnState.movementUsedFt = 0;
      }
      if (patch.useSlot) {
        const usedBefore = turnState.used[patch.useSlot] ?? 0;
        const max = actionEconomySlotMax(adapter, patch.useSlot, hasLegendaryActions);
        // `max === null`: an unrecognised slot key — deliberately left unbounded rather than
        // guessed at, matching `actionEconomySlotMax`'s documented "refuse rather than guess".
        if (max !== null && usedBefore + 1 > max) {
          rejectSlotOverflow(patch.useSlot, usedBefore, max);
        }
        const next = usedBefore + 1;
        turnState.used[patch.useSlot] = next;
        if (patch.useSlot === LEGENDARY_ACTION_SLOT) {
          logs.push({ detail: `used legendary action (${next}/${legendaryMax})` });
        }
      }
      if (patch.releaseSlot) {
        if (patch.releaseSlot === LEGENDARY_ACTION_SLOT) {
          const next = Math.max(0, (turnState.used[LEGENDARY_ACTION_SLOT] ?? 0) - 1);
          if (next === 0) delete turnState.used[LEGENDARY_ACTION_SLOT];
          else turnState.used[LEGENDARY_ACTION_SLOT] = next;
          if (legendaryMax > 0) logs.push({ detail: `released legendary action (${next}/${legendaryMax})` });
        } else {
          turnState.used[patch.releaseSlot] = Math.max(0, (turnState.used[patch.releaseSlot] ?? 0) - 1);
        }
      }
      if (patch.setSlotUsed) {
        const { key, used: requested } = patch.setSlotUsed;
        const usedBefore = turnState.used[key] ?? 0;
        const max = actionEconomySlotMax(adapter, key, hasLegendaryActions);
        if (max !== null && requested > max) {
          rejectSlotOverflow(key, usedBefore, max);
        }
        turnState.used[key] = requested;
      }
      if (patch.resetMovement) turnState.movementUsedFt = 0;
      if (patch.moveFt !== undefined) {
        const next = turnState.movementUsedFt + patch.moveFt;
        turnState.movementUsedFt = Math.max(0, next);
      }

      const clearConcentration = (effectName?: string | null): void => {
        const { removed } = this.breakConcentration(tx, encounterId, combatantId, turnState, false, effectName);
        for (const cascade of removed) {
          this.appendEventInTransaction(tx, encounterId, encounterRow.round, 'condition', {
            actor: existing.name,
            actorId: existing.id,
            target: cascade.combatantName,
            targetId: cascade.combatantId,
            detail: `condition expired: ${cascade.condition.name} (concentration broken)`,
          });
          // Issue #1452: keep the post-commit SSE nudge firing when a cascade-only
          // change cleared structured condition links without a normal log event.
          shouldNudge = true;
        }
      };

      if (patch.concentration !== undefined) {
        const concentrationChanged = patch.concentration !== turnState.concentration;
        if (concentrationChanged) {
          logs.push({ detail: patch.concentration ? `began concentrating on ${patch.concentration}` : 'concentration ended' });
        }
        // Issue #1452: replacing concentration drops only the PREVIOUS effect, not the
        // freshly-applied one (UI/MCP apply the condition then set the marker). An
        // explicit clear cascades all links, even if the marker was already null.
        if (concentrationChanged && turnState.concentration != null) {
          if (patch.concentration) {
            // Replacing: only the previous named effect should be dropped.
            clearConcentration(turnState.concentration);
          } else {
            // Explicit end: drop every concentration-linked condition.
            clearConcentration();
          }
        } else if (!patch.concentration) {
          clearConcentration();
        }
        if (concentrationChanged && patch.concentration) {
          // Queued saves belong to the PRIOR effect and must never break the new one,
          // even when no marker made the actor look like it was concentrating.
          turnState.pendingConcentrationChecks = [];
        }
        turnState.concentration = patch.concentration;
      }
      if (patch.resolveConcentrationCheck) {
        const pending = turnState.pendingConcentrationChecks[0];
        if (!pending || pending.id !== patch.resolveConcentrationCheck.id) {
          throw new ConflictException('That concentration check is no longer first in the queue. Refresh and try again.');
        }
        if (patch.resolveConcentrationCheck.outcome === 'pass') {
          turnState.pendingConcentrationChecks = turnState.pendingConcentrationChecks.slice(1);
          logs.push({ detail: `passed concentration check (DC ${pending.dc})` });
        } else {
          logs.push({ detail: `failed concentration check (DC ${pending.dc}); concentration ended` });
          clearConcentration();
        }
      }
      if (patch.delaying !== undefined) {
        if (patch.delaying !== turnState.delaying) logs.push({ detail: patch.delaying ? 'is delaying their turn' : 'is no longer delaying' });
        turnState.delaying = patch.delaying;
      }
      if (patch.readied !== undefined) {
        if (patch.readied !== turnState.readied) logs.push({ detail: patch.readied ? `readied an action: ${patch.readied}` : 'released their readied action' });
        turnState.readied = patch.readied;
      }

      let nextEffects = activeEffects;
      if (patch.removeEffectId) {
        nextEffects = nextEffects.filter((e) => e.id !== patch.removeEffectId);
        if (nextEffects.length !== activeEffects.length) logs.push({ detail: `effect removed: ${patch.removeEffectId}` });
      }
      if (patch.addEffect) {
        nextEffects = [...nextEffects.filter((e) => e.id !== patch.addEffect!.id), patch.addEffect].slice(0, 50);
        logs.push({ detail: `effect applied: ${patch.addEffect.name}` });
      }

      const [updated] = tx
        .update(combatants)
        .set({ turnState: toJsonText(turnState), activeEffects: toJsonText(nextEffects) })
        .where(eq(combatants.id, combatantId))
        .returning()
        .all();
      row = updated;
      if (encounterRow.status === 'running') {
        const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
        tx.update(encounters)
          .set({
            combatantStateVersion: sql`${encounters.combatantStateVersion} + 1`,
            updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? encounterRow.updatedAt),
          })
          .where(eq(encounters.id, encounterId))
          .run();
      }
    });

    for (const l of logs) {
      await this.appendEvent(encounterId, encounterRow.round, 'note', {
        actor: existing.name,
        actorId: existing.id,
        detail: l.detail,
      });
    }
    if (logs.length > 0 || shouldNudge) {
      this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, encounterRow.hidden);
    }
    const domain = combatantToDomain(row);
    if (legendaryMax > 0) {
      const used = domain.turnState.used[LEGENDARY_ACTION_SLOT] ?? 0;
      return { ...domain, legendaryActions: { max: legendaryMax, used } };
    }
    return domain;
  }

  /**
   * Ends the encounter and writes each character-combatant's current HP back onto its
   * character row. Requires status 'running' — without this guard, /end on an already-
   * 'ended' encounter double-fires: it re-writes (harmless but wasteful) HP back onto
   * characters and stomps `endedAt` with a fresh timestamp, silently masking when combat
   * actually ended. The HP write-back + status update run in one db.transaction() (mirrors
   * QuestsService.remove()'s subquest-promotion pattern) so a mid-loop failure can't leave
   * some characters' HP synced and others not while the encounter still shows 'running'.
   *
   * Issue #711: the write-back now persists the FULL combat death/temp-HP slice, not just
   * hpCurrent. The combatant tracker has carried hpTemp/deathState/death-save counters
   * since issue #57; without this reconciliation a dead PC was silently resurrected on
   * sheet read and re-conscripted into the next fight. The dead/stable/dying/temp-HP
   * state travels back onto the character row, and a `dead` combatant additionally flips
   * the character's lifecycle `status` to 'dead' so it is excluded from future auto-add
   * (create() only auto-adds 'active' PCs, issue #115). A revived (hp > 0) character is
   * explicitly kept 'active' here so the death doesn't linger past a real revival —
   * revival is a deliberate transition, never a side effect.
   * Issue #1758: preserve explicit non-active lifecycle statuses (e.g. 'retired', 'inactive', 'draft')
   * so ending an encounter does not overwrite a caller's deliberate non-active choice.
   */
  async end(encounterId: number, user: RequestUser, role: Role): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    if (encounterRow.status !== 'running') {
      throw new BadRequestException(`Encounter must be 'running' to end (currently '${encounterRow.status}')`);
    }
    let rows: Array<typeof combatants.$inferSelect> = [];

    type CharacterWrite = {
      combatantId: number;
      characterId: number;
      hpCurrent: number;
      hpTemp: number;
      spCurrent: number;
      spMax: number;
      rpCurrent: number;
      rpMax: number;
      deathState: string;
      deathSaveSuccesses: number;
      deathSaveFailures: number;
      // Issue #486: conditions travel back with the HP slice on /end. #1047: the
      // structured copy travels with them, stripped to sheet scope.
      conditions: string;
      conditionInstances: string;
      status: string;
      sheetSyncedUpdatedAt: string | null;
    };
    const planCharacterWrites = (
      sourceRows: Array<typeof combatants.$inferSelect>,
      priors: Map<number, { status: string }>,
    ): CharacterWrite[] =>
      sourceRows.flatMap((row) => {
        if (row.kind !== 'character' || row.characterId === null) return [];
        const priorStatus = priors.get(row.characterId)?.status;
        const dead = row.deathState === 'dead';
        let nextStatus: string;
        if (dead) {
          nextStatus = 'dead';
        } else if (priorStatus === 'dead') {
          // Revival is deliberate and mirrors the sheet policy: only a positive-HP,
          // fully-recovered PC leaves 'dead'. dying/stable stay 'dead'.
          nextStatus = row.hpCurrent > 0 && row.deathState === 'none' ? 'active' : 'dead';
        } else if (priorStatus && priorStatus !== 'active') {
          nextStatus = priorStatus;
        } else {
          nextStatus = 'active';
        }
        return [{
          combatantId: row.id,
          characterId: row.characterId,
          hpCurrent: row.hpCurrent,
          hpTemp: row.hpTemp,
          spCurrent: row.spCurrent ?? 0,
          spMax: row.spMax ?? 0,
          rpCurrent: row.rpCurrent ?? 0,
          rpMax: row.rpMax ?? 0,
          deathState: row.deathState,
          deathSaveSuccesses: row.deathSaveSuccesses,
          deathSaveFailures: row.deathSaveFailures,
          ...sheetConditionWriteSetFromInstances(readConditionInstances(row.conditionInstances, row.conditions)),
          status: nextStatus,
          sheetSyncedUpdatedAt: row.sheetSyncedUpdatedAt ?? null,
        }];
      });
    let characterWrites: CharacterWrite[] = [];

    // The transaction below re-reads the character lifecycle + HP slices before it
    // plans the write-back. That keeps both the status policy and the #466 CAS guard
    // aligned with the combatant snapshot that actually wins the transaction.
    const priorById = new Map<
      number,
      {
        status: string;
        updatedAt: string;
        hpCurrent: number;
        hpTemp: number;
        spCurrent: number;
        spMax: number;
        rpCurrent: number;
        rpMax: number;
        deathState: string;
        deathSaveSuccesses: number;
        deathSaveFailures: number;
      }
    >();
    // Issue #466 safety net: refuse to end when the sheet advanced since the last
    // acknowledged sync AND still differs from the combatant snapshot. The DM must
    // reopen with an explicit resync direction first (or heal the combatant to match).
    let endConflicts: HpSyncConflict[] = [];

    const ts = nowIso();
    // Clear the campaign's activeEncounterId iff this encounter IS the active one (issue
    // #744) — done inside the same HP-write-back transaction so a crash mid-end can't leave
    // the pointer dangling at an 'ended' encounter. A third-party ended a non-active fight
    // (legacy drift where the pointer disagreed with status) leaves the pointer untouched.
    // Issue #466: each character UPDATE is compare-and-set on updatedAt when we hold a
    // sync token, so a race that heals the sheet mid-transaction cannot be clobbered.
    try {
      this.db.transaction((tx) => {
      // Re-read all mutable state after acquiring the SQLite write transaction. In
      // particular, a heal that lands while End is queued must be the value written back
      // to the character sheet, and a second End must see the winner's ended status.
      const [freshEncounter] = tx.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all();
      if (!freshEncounter || freshEncounter.status !== 'running') {
        throw new ConflictException({
          code: 'ENCOUNTER_ALREADY_ENDED',
          message: 'The encounter was already ended by another request.',
        });
      }
      rows = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all();
      priorById.clear();
      const rawCharacterIds = rows.flatMap((r) => (r.kind === 'character' && r.characterId !== null ? [r.characterId] : []));
      if (rawCharacterIds.length > 0) {
        const freshPriorRows = tx
          .select({
            id: characters.id,
            status: characters.status,
            updatedAt: characters.updatedAt,
            hpCurrent: characters.hpCurrent,
            hpTemp: characters.hpTemp,
            spCurrent: characters.spCurrent,
            spMax: characters.spMax,
            rpCurrent: characters.rpCurrent,
            rpMax: characters.rpMax,
            deathState: characters.deathState,
            deathSaveSuccesses: characters.deathSaveSuccesses,
            deathSaveFailures: characters.deathSaveFailures,
          })
          .from(characters)
          .where(inArray(characters.id, rawCharacterIds))
          .all();
        for (const row of freshPriorRows) priorById.set(row.id, row);
      }
      characterWrites = planCharacterWrites(rows, priorById);
      endConflicts = [];
      for (const w of characterWrites) {
        const prior = priorById.get(w.characterId);
        if (!prior) continue;
        const combatantSlice = hpSyncSliceOf(w);
        const sheetSlice = hpSyncSliceOf(prior);
        if (!canWriteBackHp({ sheet: { ...sheetSlice, updatedAt: prior.updatedAt }, combatant: combatantSlice, sheetSyncedUpdatedAt: w.sheetSyncedUpdatedAt })) {
          endConflicts.push({
            combatantId: w.combatantId,
            characterId: w.characterId,
            name: rows.find((row) => row.id === w.combatantId)?.name ?? `Character ${w.characterId}`,
            combatant: combatantSlice,
            sheet: { ...sheetSlice, updatedAt: prior.updatedAt },
          });
        }
      }
      if (endConflicts.length > 0) {
        throw new ConflictException({
          code: 'HP_SYNC_CONFLICT',
          message:
            'Character sheets changed since this encounter last synced HP. Reopen with an explicit resync direction for each conflict before ending again.',
          conflicts: endConflicts,
        });
      }
      for (const w of characterWrites) {
        const prior = priorById.get(w.characterId);
        // Issue #1902 rework (round 13, codex P2 sweep; corrected round 15, devin): PER
        // CHARACTER, from `prior` (already read fresh, inside this transaction, a few
        // lines above) — not the shared `ts` this whole encounter-end call uses for OTHER
        // purposes (endedAt, the encounter's own updatedAt). This column is the CAS token
        // `patchSpellSlots`'s `expectedUpdatedAt` guard depends on advancing on every
        // writer. Computed ONCE here (not inline in `set` below) because
        // `sheetSyncedUpdatedAt` on the combatant row MUST be stamped with this EXACT same
        // value — `sheetSyncedUpdatedAt` is defined as "the sheet's `updatedAt` at the
        // moment of sync" (see `CharactersService.syncActiveCombatants` and
        // `updateCombatant`'s mirror, which both write one shared value to both rows).
        // Round 13 advanced the character's token per-character but left the combatant
        // stamped with the shared `ts`, breaking that equality — `canWriteBackHp` and the
        // CAS predicate below both compare the two directly, so ANY later end would either
        // report a false HP_SYNC_CONFLICT or silently no-op its write-back (0 rows
        // matched) once the two values diverged.
        let sheetSyncToken = nextUpdatedAt(prior?.updatedAt ?? ts);
        // Issue #711: write the full combat slice — HP, temp HP, death state, and
        // death-save counters — so the sheet reflects the post-fight truth. The
        // lifecycle status flip is gated on a real change so a stable/dying PC
        // whose status was already 'active' doesn't get a spurious write.
        // Issue #486: also persist tracker conditions back onto the sheet.
        const set: Partial<typeof characters.$inferInsert> = {
          hpCurrent: w.hpCurrent,
          hpTemp: w.hpTemp,
          spCurrent: w.spCurrent,
          spMax: w.spMax,
          rpCurrent: w.rpCurrent,
          rpMax: w.rpMax,
          deathState: w.deathState,
          deathSaveSuccesses: w.deathSaveSuccesses,
          deathSaveFailures: w.deathSaveFailures,
          conditions: w.conditions,
          conditionInstances: w.conditionInstances,
          updatedAt: sheetSyncToken,
        };
        if (prior !== undefined && prior.status !== w.status) {
          set.status = w.status;
        }
        const where =
          w.sheetSyncedUpdatedAt != null
            ? and(eq(characters.id, w.characterId), eq(characters.updatedAt, w.sheetSyncedUpdatedAt))
            : eq(characters.id, w.characterId);
        const result = tx.update(characters).set(set).where(where).run();
        const changes = (result as unknown as { changes?: number }).changes ?? 0;
        if (changes === 0 && w.sheetSyncedUpdatedAt != null) {
          // CAS lost a race — re-read and fail the whole end rather than half-apply.
          const [fresh] = tx
            .select()
            .from(characters)
            .where(eq(characters.id, w.characterId))
            .limit(1)
            .all();
          if (fresh && !hpSyncSlicesEqual(hpSyncSliceOf(fresh), hpSyncSliceOf(w))) {
            throw new ConflictException({
              code: 'HP_SYNC_CONFLICT',
              message:
                'Character sheets changed since this encounter last synced HP. Reopen with an explicit resync direction for each conflict before ending again.',
              conflicts: [
                {
                  combatantId: w.combatantId,
                  characterId: w.characterId,
                  name: rows.find((r) => r.id === w.combatantId)?.name ?? `Character ${w.characterId}`,
                  combatant: hpSyncSliceOf(w),
                  sheet: { ...hpSyncSliceOf(fresh), updatedAt: fresh.updatedAt },
                },
              ],
            });
          }
          // Slices already match (e.g. name-only sheet edit) — bump updatedAt + token.
          // `nextUpdatedAt(fresh.updatedAt)` (issue #1902 rework, round 13) — `fresh` was
          // just read above, inside this same transaction. Reassign `sheetSyncToken` to
          // whatever was ACTUALLY written here, so the combatant marker below matches.
          if (fresh) {
            sheetSyncToken = nextUpdatedAt(fresh.updatedAt);
            tx.update(characters)
              .set({ updatedAt: sheetSyncToken })
              .where(eq(characters.id, w.characterId))
              .run();
          }
        }
        tx.update(combatants)
          .set({ sheetSyncedUpdatedAt: sheetSyncToken })
          .where(eq(combatants.id, w.combatantId))
          .run();
      }
      const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
      tx.update(encounters)
        // Turn timer (issue #1935): null the stamp when the encounter ends — there is no
        // "current turn" running any more, so no client should keep ticking a chip.
        .set({ status: 'ended', endedAt: ts, turnStartedAt: null, updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? encounterRow.updatedAt) })
        .where(and(eq(encounters.id, encounterId), eq(encounters.status, 'running')))
        .run();
      const [camp] = tx.select({ activeEncounterId: campaigns.activeEncounterId }).from(campaigns).where(eq(campaigns.id, encounterRow.campaignId)).limit(1).all();
      if (camp?.activeEncounterId === encounterId) {
        tx.update(campaigns).set({ activeEncounterId: null, updatedAt: ts }).where(eq(campaigns.id, encounterRow.campaignId)).run();
      }
      });
    } catch (err) {
      if (err instanceof ConflictException && endConflicts.length > 0) {
        await this.audit.log({
          actor: auditActor(user),
          actorRole: role,
          action: 'encounter.end_hp_conflict',
          entityType: 'encounter',
          entityId: encounterId,
          campaignId: encounterRow.campaignId,
          detail: JSON.stringify({ conflicts: endConflicts }),
        });
      }
      throw err;
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.end',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
    });

    this.emitEncounterEvent('encounter.updated', encounterRow.campaignId, encounterId, encounterRow.hidden);

    this.notifications.notifyCampaign(encounterRow.campaignId, user, {
      type: 'encounter_ended',
      title: 'Encounter ended',
      body: `Encounter '${encounterRow.name}' has concluded.`,
      entityType: 'encounter',
      entityId: encounterId,
    }).catch(() => {});

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  /**
   * Reopens an 'ended' encounter back to 'running' (issue #109) — an accidental /end
   * was previously unrecoverable (the ended page offered only Refresh/Delete). Requires
   * status 'ended'; clears endedAt and restores 'running' while PRESERVING round /
   * turnIndex / currentCombatantId when still valid, so combat resumes where it stopped
   * rather than resetting to the top of the order.
   *
   * Issue #489: reopen re-validates the turn pointer against the present roster.
   * Zero combatants → 409. A missing `currentCombatantId` or one whose initiative is
   * now null snaps to the top of the server-sorted running order and emits a combat-
   * log notice. `turnIndex` is always re-derived from that identity pointer.
   *
   * Issue #466: when sheet HP diverged from the combatant snapshot after the previous
   * End, the caller MUST supply a per-conflict `hpResync` direction (`keep_combatant`
   * or `pull_sheet`). Decisions are applied + audited inside the same transaction as
   * the status flip so a crash cannot leave a half-resynced fight.
   *
   * One authoritative live fight (issue #744): the status flip + activeEncounterId write
   * + the no-other-running assertion run in ONE transaction, mirroring start(). A reopen
   * racing another reopen/start serializes and the loser surfaces a 409 with the winner.
   */
  async reopen(
    encounterId: number,
    user: RequestUser,
    role: Role,
    input: EncounterReopenInput = {},
  ): Promise<EncounterWithCombatants> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    if (encounterRow.status !== 'ended') {
      throw new BadRequestException(`Encounter must be 'ended' to reopen (currently '${encounterRow.status}')`);
    }

    const combatantRows = await this.listCombatantRows(encounterId);
    // Issue #489: refuse to resume a fight with nobody in it (start has the same
    // guard via #469; reopen previously flipped status and left a null pointer).
    if (combatantRows.length === 0) {
      throw new ConflictException({
        code: 'REOPEN_NO_COMBATANTS',
        message: 'Cannot reopen an encounter with no combatants — add at least one combatant first',
      });
    }

    const conflicts = await this.collectHpSyncConflicts(combatantRows);
    const decisions = new Map((input.hpResync ?? []).map((d) => [d.combatantId, d.direction]));
    if (conflicts.length > 0) {
      const missing = conflicts.filter((c) => !decisions.has(c.combatantId));
      if (missing.length > 0) {
        throw new ConflictException({
          code: 'HP_SYNC_CONFLICT',
          message:
            'Character sheets changed after this encounter ended. Choose keep_combatant or pull_sheet for each conflict before reopening.',
          conflicts,
        });
      }
    }

    // Issue #489: re-derive the turn pointer against the present, initiative-bearing
    // roster before flipping status. A combatant removed (or initiative cleared) while
    // the fight was ended would otherwise leave a stale currentCombatantId until the
    // next /next-turn self-healed via advanceTurn.
    const adapter = await this.adapterForCampaign(encounterRow.campaignId);
    const sorted = this.sortCombatantsWithAdapter(combatantRows.map(combatantToDomain), 'running', adapter);
    const priorCurrentId = encounterRow.currentCombatantId;
    const priorCurrent = priorCurrentId == null ? undefined : sorted.find((c) => c.id === priorCurrentId);
    // Missing id OR present-but-null-initiative both snap to the top of the order
    // and emit a notice (issue #489) — even when that top happens to be the same id.
    const pointerInvalid = priorCurrent == null || priorCurrent.initiative === null;
    const currentCombatantId = pointerInvalid ? (sorted[0]?.id ?? null) : priorCurrentId;
    const turnIndex = turnIndexFor(sorted, currentCombatantId);
    const turnPointerSnapped = pointerInvalid;

    const campaignId = encounterRow.campaignId;
    const ts = nowIso();
    const decisionAudit: Array<{ combatantId: number; characterId: number; direction: string }> = [];
    this.db.transaction((tx) => {
      this.assertNoOtherLiveEncounter(campaignId, encounterId, tx);

      for (const conflict of conflicts) {
        const direction = decisions.get(conflict.combatantId)!;
        decisionAudit.push({
          combatantId: conflict.combatantId,
          characterId: conflict.characterId,
          direction,
        });
        if (direction === 'pull_sheet') {
          // Bring the combatant snapshot up to the live sheet; stamp the CAS token.
          tx.update(combatants)
            .set({
              hpCurrent: conflict.sheet.hpCurrent,
              hpTemp: conflict.sheet.hpTemp,
              spCurrent: conflict.sheet.spCurrent,
              spMax: conflict.sheet.spMax,
              rpCurrent: conflict.sheet.rpCurrent,
              rpMax: conflict.sheet.rpMax,
              deathState: conflict.sheet.deathState,
              deathSaveSuccesses: conflict.sheet.deathSaveSuccesses,
              deathSaveFailures: conflict.sheet.deathSaveFailures,
              sheetSyncedUpdatedAt: conflict.sheet.updatedAt,
            })
            .where(eq(combatants.id, conflict.combatantId))
            .run();
        } else {
          // keep_combatant: leave the snapshot; acknowledge the sheet revision so the
          // next /end may overwrite it deliberately (CAS token = current sheet.updatedAt).
          tx.update(combatants)
            .set({ sheetSyncedUpdatedAt: conflict.sheet.updatedAt })
            .where(eq(combatants.id, conflict.combatantId))
            .run();
        }
      }

      // Refresh CAS tokens for non-conflict character combatants too — their slices
      // already match, but stamping the current sheet.updatedAt keeps the next /end
      // from false-conflicting on an unrelated sheet edit (name/notes) that bumped
      // updatedAt without changing the HP slice.
      const conflictIds = new Set(conflicts.map((c) => c.combatantId));
      for (const row of combatantRows) {
        if (row.kind !== 'character' || row.characterId == null || conflictIds.has(row.id)) continue;
        const [sheet] = tx
          .select({ updatedAt: characters.updatedAt })
          .from(characters)
          .where(eq(characters.id, row.characterId))
          .limit(1)
          .all();
        if (sheet) {
          tx.update(combatants)
            .set({ sheetSyncedUpdatedAt: sheet.updatedAt })
            .where(eq(combatants.id, row.id))
            .run();
        }
      }

      const currentEnc = tx.select({ updatedAt: encounters.updatedAt }).from(encounters).where(eq(encounters.id, encounterId)).get();
      tx.update(encounters)
        .set({
          status: 'running',
          endedAt: null,
          aftermathDismissedAt: null,
          // A resumed encounter begins a fresh logical turn even if its pointer was
          // still valid, so player previews banked before End cannot be replayed.
          turnVersion: sql`${encounters.turnVersion} + 1`,
          // Issue #489: persist the re-validated pointer with the status flip.
          currentCombatantId,
          turnIndex,
          turnPhase: 'combatant',
          lairResumeCombatantId: null,
          // Turn timer (issue #1935): a reopened encounter begins a fresh turn (see the
          // turnVersion bump above), so the timer restarts too rather than resuming a stamp
          // from before the encounter ended.
          turnStartedAt: ts,
          updatedAt: nextUpdatedAt(currentEnc?.updatedAt ?? encounterRow.updatedAt),
        })
        .where(eq(encounters.id, encounterId))
        .run();
      tx.update(campaigns).set({ activeEncounterId: encounterId, updatedAt: ts }).where(eq(campaigns.id, campaignId)).run();
    });

    // Combat-log notice when reopen had to repair a dangling/null-initiative pointer
    // (issue #489). Appended after the status flip commits — a log failure must not
    // roll back a successful reopen.
    if (turnPointerSnapped) {
      const top = sorted.find((c) => c.id === currentCombatantId);
      await this.appendEvent(encounterId, encounterRow.round, 'note', {
        actor: top?.name ?? null,
        target: top?.name ?? null,
        actorId: currentCombatantId,
        targetId: currentCombatantId,
        detail:
          priorCurrentId == null || priorCurrent == null
            ? 'Turn pointer reset to top of order on reopen (previous current combatant missing)'
            : 'Turn pointer reset to top of order on reopen (previous current combatant had no initiative)',
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.reopen',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId,
      detail: JSON.stringify({
        ...(decisionAudit.length > 0 ? { hpResync: decisionAudit } : {}),
        ...(turnPointerSnapped
          ? { turnPointerSnapped: true, previousCombatantId: priorCurrentId, currentCombatantId, turnIndex }
          : { currentCombatantId, turnIndex }),
      }),
    });

    this.emitEncounterEvent('encounter.updated', campaignId, encounterId, encounterRow.hidden);

    return this.getWithCombatantsOrThrow(encounterId, role);
  }

  async remove(encounterId: number, user: RequestUser, role: Role): Promise<void> {
    const encounterRow = await this.getRowOrThrow(encounterId);
    const ts = nowIso();
    // Soft-delete (issue #701): stamp deleted_at and clear a dangling activeEncounterId
    // pointer in one transaction. Combatants, combat-log events, map/fog, and links
    // survive for restore — unlike the old hard delete (issue #272).
    this.db.transaction((tx) => {
      tx.update(encounters).set({ deletedAt: ts, updatedAt: ts }).where(eq(encounters.id, encounterId)).run();
      const [camp] = tx.select({ activeEncounterId: campaigns.activeEncounterId }).from(campaigns).where(eq(campaigns.id, encounterRow.campaignId)).limit(1).all();
      if (camp?.activeEncounterId === encounterId) {
        tx.update(campaigns).set({ activeEncounterId: null, updatedAt: ts }).where(eq(campaigns.id, encounterRow.campaignId)).run();
      }
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.delete',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: encounterRow.campaignId,
      detail: 'soft-delete (trashed)',
    });

    this.emitEncounterEvent('encounter.deleted', encounterRow.campaignId, encounterId, encounterRow.hidden);
  }

  /** Restore a trashed encounter (issue #701) — clears `deleted_at`. 404 if it isn't trashed. */
  async restore(encounterId: number, user: RequestUser, role: Role): Promise<Encounter> {
    const existing = await this.getRowOrThrow(encounterId, true);
    if (existing.deletedAt == null) throw new NotFoundException(`Encounter ${encounterId} is not in the trash`);
    const [row] = await this.db
      .update(encounters)
      .set({ deletedAt: null, updatedAt: nowIso() })
      .where(eq(encounters.id, encounterId))
      .returning();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.restore',
      entityType: 'encounter',
      entityId: encounterId,
      campaignId: existing.campaignId,
    });
    return encounterToDomain(row);
  }

  /**
   * Rolls an arbitrary dice expression for a campaign — any member may roll; result is
   * audited AND persisted to the shared per-campaign dice log (issue #35), so every
   * member sees the same roll feed via GET /campaigns/:id/rolls. Returns the persisted
   * DiceRoll — a superset of the old RollResult shape (expr/rolls/total), so existing
   * clients keep working unchanged.
   */
  async rollDiceForCampaign(campaignId: number, input: RollRequestInput, user: RequestUser, role: Role): Promise<DiceRoll> {
    const result = rollDice(input.expr);
    // Optional check context (issue #130): echo the label and compute success server-side
    // so every member's feed shows the same pass/fail, not a client's interpretation.
    const label = input.label?.trim();
    if (label) result.label = label;
    if (typeof input.dc === 'number') {
      result.dc = input.dc;
      result.success = result.total >= input.dc;
    }
    const persisted = await this.rolls.record(campaignId, result, user);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'dice.roll',
      entityType: null,
      entityId: null,
      campaignId,
      detail:
        `${result.label ? `${result.label}: ` : ''}${result.expr} = ${result.total}` +
        (result.dc != null ? ` vs DC ${result.dc} (${result.success ? 'success' : 'fail'})` : ''),
    });

    return persisted;
  }

  /**
   * Quick-roll a weapon attack (to-hit) or spell damage in an encounter (issue #1850).
   * Rolls the dice, records the entry in the campaign's shared dice_rolls log, AND
   * appends an event to the encounter's encounter_events feed with character identity,
   * formula breakdown, nat20/nat1 visual flags, and damage type icon.
   */
  async quickRoll(
    encounterId: number,
    body: QuickRollRequest,
    user: RequestUser,
    role: Role,
  ): Promise<{
    roll: DiceRoll;
    event: EncounterEvent;
    breakdown: string;
    isNat20: boolean;
    isNat1: boolean;
    total: number;
  }> {
    const encounter = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounter);

    const isDm = role === 'dm';
    const actorId: number | null = body.combatantId ?? null;
    let actorName = body.actorName?.trim() || '';
    let combatantRow: typeof combatants.$inferSelect | null = null;

    if (actorId != null) {
      const [found] = await this.db
        .select()
        .from(combatants)
        .where(and(eq(combatants.id, actorId), eq(combatants.encounterId, encounterId)))
        .limit(1);
      if (!found) {
        throw new NotFoundException(`Combatant ${actorId} not found in encounter ${encounterId}`);
      }
      combatantRow = found;
      actorName = combatantRow.name;

      if (!isDm) {
        if (combatantRow.kind !== 'character' || combatantRow.characterId === null) {
          throw new ForbiddenException('Only the DM may quick-roll for monsters or NPCs');
        }
        const [char] = await this.db
          .select({ ownerUserId: characters.ownerUserId })
          .from(characters)
          .where(eq(characters.id, combatantRow.characterId))
          .limit(1);
        if (!char || char.ownerUserId !== user.id) {
          throw new ForbiddenException('You may only quick-roll for your own character');
        }
      }
    } else {
      if (!isDm) {
        actorName = user.name || 'Player';
      } else if (!actorName) {
        actorName = user.name || 'DM';
      }
    }

    // Redact hidden NPC or hidden encounter identity in campaign-wide dice rolls log (issue #1850 / review finding)
    let isActorHidden = false;
    let npcIdentityId: number | null = null;
    if (combatantRow) {
      npcIdentityId = combatantRow.npcIdentitySourceId ?? combatantRow.npcId;
      if (combatantRow.kind === 'npc' && npcIdentityId !== null) {
        const [npc] = await this.db
          .select({ hidden: npcs.hidden })
          .from(npcs)
          .where(and(eq(npcs.id, npcIdentityId), eq(npcs.campaignId, encounter.campaignId)))
          .limit(1);
        if (npc?.hidden) {
          isActorHidden = true;
        }
      }
    }
    if (encounter.hidden) isActorHidden = true;

    const mode = body.mode || 'flat';
    let formula = '';
    const isToHit = body.kind === 'to-hit';
    let damageTypeIcon = '⚔️';
    let damageType = '';

    if (isToHit) {
      const trimmed = body.expr.trim();
      let mod = 0;
      if (/^[+-]?\d+$/.test(trimmed)) {
        mod = parseInt(trimmed, 10);
      } else {
        const match = /^([+-]?\d+)/.exec(trimmed);
        if (match) mod = parseInt(match[1], 10);
      }
      const sign = mod >= 0 ? `+${mod}` : `${mod}`;
      if (mode === 'advantage') formula = `2d20kh1${sign}`;
      else if (mode === 'disadvantage') formula = `2d20kl1${sign}`;
      else formula = `1d20${sign}`;
    } else {
      formula = body.expr.trim();
      const match = /^(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(.*)$/i.exec(formula);
      if (match) {
        formula = match[1].replace(/\s+/g, '');
        damageType = match[2].trim();
      }
      if (damageType) {
        const t = damageType.toLowerCase();
        if (t.includes('fire')) damageTypeIcon = '🔥';
        else if (t.includes('cold') || t.includes('ice')) damageTypeIcon = '❄️';
        else if (t.includes('lightning') || t.includes('electric')) damageTypeIcon = '⚡';
        else if (t.includes('thunder')) damageTypeIcon = '🔊';
        else if (t.includes('acid') || t.includes('poison')) damageTypeIcon = '🧪';
        else if (t.includes('radiant') || t.includes('holy')) damageTypeIcon = '✨';
        else if (t.includes('necrotic') || t.includes('dark')) damageTypeIcon = '💀';
        else if (t.includes('psychic') || t.includes('mind')) damageTypeIcon = '🧠';
        else if (t.includes('force')) damageTypeIcon = '💥';
      }
    }

    const rollRes = rollDice(formula);
    const naturalRoll = rollRes.rolls.length > 0 ? rollRes.rolls[0] : null;
    const isNat20 = isToHit && (naturalRoll === 20 || rollRes.rolls.includes(20));
    const isNat1 = isToHit && (naturalRoll === 1 || (rollRes.rolls.length === 1 && naturalRoll === 1));

    const breakdown = `${formula} (${rollRes.rolls.join(', ')}) = ${rollRes.total}`;
    const detail = isToHit
      ? `${body.actionName} (to-hit): ${rollRes.total} [${breakdown}]${isNat20 ? ' — CRITICAL HIT! (Nat 20)' : isNat1 ? ' — CRITICAL MISS! (Nat 1)' : ''}`
      : `${body.actionName} (damage): ${rollRes.total} ${damageTypeIcon} [${breakdown}]`;

    const diceActor = isActorHidden ? UNKNOWN_COMBATANT_LABEL : actorName;
    const diceLabel = `${diceActor} · ${body.actionName} (${body.kind})`;

    const roll = await this.rolls.record(
      encounter.campaignId,
      {
        expr: formula,
        rolls: rollRes.rolls,
        total: rollRes.total,
        label: diceLabel,
        actor: diceActor,
        natural20: isNat20 ? 1 : 0,
        encounterId,
        ...(combatantRow?.kind === 'npc' && npcIdentityId !== null
          ? { npcId: npcIdentityId }
          : {}),
      },
      user,
    );

    const now = nowIso();
    const performedBy = { userId: user.id, role, kind: 'human' };

    const [eventRow] = await this.db
      .insert(encounterEvents)
      .values({
        encounterId,
        round: encounter.round,
        type: 'roll',
        actor: actorName,
        actorId,
        target: null,
        targetId: null,
        detail,
        chainId: null,
        parentEventId: null,
        phase: 'roll',
        performedByJson: JSON.stringify(performedBy),
        metadataJson: JSON.stringify({
          actionName: body.actionName,
          kind: body.kind,
          expr: body.expr,
          formulaBreakdown: breakdown,
          naturalRoll,
          natural20: isNat20,
          natural1: isNat1,
          damageType,
          damageIcon: damageTypeIcon,
          total: rollRes.total,
        }),
        createdAt: now,
      })
      .returning()
      .all();

    if (!encounter.hidden) {
      this.events.emit({ type: 'encounter.updated', campaignId: encounter.campaignId, encounterId });
    }

    return {
      roll,
      event: eventToDomain(eventRow),
      breakdown,
      isNat20,
      isNat1,
      total: rollRes.total,
    };
  }

  /**
   * Rolls an adapter-native action dice pool (Open Legend) for a campaign. The request carries
   * a native attribute score only; the server gates on adapter.attributeDicePool, runs the
   * schema exploding-pool resolver with crypto RNG, and persists the pool/explosion/disadvantage
   * breakdown as ONE dice-log event.
   */
  async rollActionDiceForCampaign(
    campaignId: number,
    input: ActionRollRequestInput,
    user: RequestUser,
    role: Role,
  ): Promise<DiceRoll> {
    const adapter = await this.adapterForCampaign(campaignId);
    if (!adapter.attributeDicePool) {
      throw new BadRequestException(`${adapter.label} does not support native action dice pools`);
    }

    const result = rollOpenLegendActionDice(input.score);
    const label = input.label?.trim() || input.attribute?.trim();
    if (label) result.label = `${label}: ${result.label ?? 'Action dice'}`;
    if (typeof input.dc === 'number') {
      result.dc = input.dc;
      result.success = result.total >= input.dc;
    }

    const persisted = await this.rolls.record(campaignId, result, user);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'dice.roll',
      entityType: null,
      entityId: null,
      campaignId,
      detail:
        `${result.label ? `${result.label}: ` : ''}${result.expr} = ${result.total}` +
        (result.dc != null ? ` vs DC ${result.dc} (${result.success ? 'success' : 'fail'})` : ''),
    });

    return persisted;
  }

  /**
   * Records a paper-table / physical roll honestly (issue #673): the DM (or any member)
   * logs the total a player reported without Campfire fabricating dice, keep/drop, or
   * crit/fumble flavor. Optional label, actor attribution, natural d20, and DC travel
   * with the entry into the shared feed, export, and recap source material.
   */
  async logPhysicalRollForCampaign(
    campaignId: number,
    input: ManualRollRequestInput,
    user: RequestUser,
    role: Role,
  ): Promise<DiceRoll> {
    const label = input.label?.trim();
    const actor = input.actor?.trim();
    const result: RollResult = {
      expr: PHYSICAL_ROLL_EXPR,
      rolls: [],
      total: input.total,
      source: 'manual',
    };
    if (label) result.label = label;
    if (actor) result.actor = actor;
    if (typeof input.natural20 === 'number') result.natural20 = input.natural20;
    if (typeof input.dc === 'number') {
      result.dc = input.dc;
      result.success = input.total >= input.dc;
    }
    const persisted = await this.rolls.record(campaignId, result, user);

    const who = actor || user.name;
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'dice.roll',
      entityType: null,
      entityId: null,
      campaignId,
      detail:
        `physical roll logged for ${who}: ` +
        `${label ? `${label} ` : ''}= ${input.total}` +
        (input.natural20 != null ? ` (nat ${input.natural20})` : '') +
        (input.dc != null ? ` vs DC ${input.dc} (${result.success === true ? 'success' : 'fail'})` : ''),
    });

    return persisted;
  }

  /**
   * Inline spend or restore of ONE spell slot or bounded resource during combat (issue
   * #422), for a character-linked combatant OR — issue #1909 — a statblock combatant with
   * an inline statblock. Delta-based and transactional: the row is re-read INSIDE the same
   * synchronous better-sqlite3 transaction that decides and writes the new `used` value, so
   * two concurrent single-pip writes to DIFFERENT resources on the SAME sheet/statblock
   * both persist — unlike the whole-statblock/whole-character PATCH this REST/MCP surface
   * replaces, which raced last-writer-wins across the ENTIRE JSON blob built from whatever
   * the client last read, silently reverting the other writer's unrelated edits.
   *
   * Roles mirror `updateCombatant`'s statblock rule: the DM may adjust any combatant; a
   * player may adjust only a combatant linked to a character they own; a statblock
   * combatant (no linked character) is DM-only, since it has no owning player.
   *
   * RESPONSE CONTRACT (issue #1909 review, Codex P2 — decided deliberately, documented
   * here rather than left implicit): the returned `Combatant` reflects the COMMITTED write
   * for the statblock branch (the inline statblock lives ON the combatant row), but NOT for
   * the character branch — `Combatant` has no `resources`/`spellSlots` field at all; that
   * state lives exclusively on the linked CHARACTER row, which this method never re-reads
   * for its response. The returned object for a character-linked combatant is therefore
   * byte-identical to a fresh read of that SAME unchanged combatant row (nothing on it
   * ever writes), not because it is stale, but because the domain model has nowhere on a
   * `Combatant` to put a character's resource state. A caller of the character branch that
   * wants to confirm/display the new value must read the CHARACTER separately (e.g.
   * `GET /characters/:id`, or `get_character` over MCP) — the same second read every OTHER
   * character-resource caller (`POST /characters/:id/resources`/`.../spell-slots` returns
   * the `Character` itself) never needed, because THEIR response type already matches
   * what changed. This is a narrower contract than "Updated combatant" (the REST route's
   * summary) literally promises for the character branch specifically; see that route's
   * and the MCP tool's own doc comments for the corresponding caller-facing wording.
   */
  async adjustCombatantResource(
    encounterId: number,
    combatantId: number,
    patch: { key?: string; spellLevel?: number; delta?: number; expectedUsed?: number; idempotencyKey?: string },
    user: RequestUser,
    role: Role,
  ): Promise<Combatant> {
    // Issue #1909 review (Codex + Devin, same defect): retain a soft-deleted (trashed)
    // encounter row here — a keyed retry is a read of an already-committed response, not a
    // fresh write, and needs this row only to resolve `campaignId`/`hidden` for that replay.
    // `rollDeathSave` (`:4090`) and `rollCombatantInitiative` (`:5970`) both do the same. A
    // genuinely fresh write is unaffected: the transaction-local `assertMutable` below still
    // rejects it once no prior claim is found.
    const encounter = await this.getRowOrThrow(encounterId, true);
    // Issue #1909 review (Codex): a hidden/prep encounter auto-adds combatants for a
    // party's existing characters, so the OWNERSHIP branch just below could otherwise let
    // a non-DM player reach and mutate a combatant belonging to an encounter that every
    // sibling read/roll path (GET, /difficulty, /events, roll_death_save,
    // roll_combatant_initiative) treats as wholesale nonexistent for them. 404, not 403 —
    // a 403 would itself leak that a hidden encounter exists. `role` here is the caller's
    // already-resolved CAMPAIGN role floor (dm/player/viewer), independent of this
    // encounter's own `hidden` flag, so this check cannot be skipped by resolving role
    // first and relying on the ownership branch alone.
    if (!isVisibleTo({ hidden: encounter.hidden }, role)) {
      throw new NotFoundException(`Encounter ${encounterId} not found`);
    }
    // Issue #1909 review (Codex): a keyed retry may name a result that already committed
    // BEFORE the encounter ended — the transaction-local replay lookup must run first and
    // win, exactly like `updateCombatant`'s own ordering. An unkeyed (fresh) write still
    // fails immediately here; a keyed one instead hits the identical `assertMutable` check
    // inside each transaction below, AFTER the replay lookup finds nothing to replay.
    if (!patch.idempotencyKey) this.assertMutable(encounter);

    const delta = patch.delta ?? 1;

    // Issue #1909 review (Codex P1, secrecy): `combatantToDomain(row)` is the RAW row —
    // unlike `getWithCombatantsOrThrow`'s role-filtered projection, it never withholds a
    // fog-hidden token's exact position. A non-DM owning player adjusting their own
    // character-linked combatant would otherwise learn (via THIS response, and via a
    // same-role replay of the stored claim body) exactly where their token sits even when
    // fog conceals it from every other read path. Redacts using this encounter's own fog
    // PLUS the given `siblingProtects` boolean — together the same two conditions
    // `getWithCombatantsOrThrow` applies. `siblingProtects` is an explicit parameter
    // (issue #1909 review, Codex eighth finding), not a closed-over value, precisely
    // because the WRITE path (computed at write time, see `siblingFogProtectsAtWrite`
    // below) and the REPLAY path (recomputed fresh at replay time, see `resolveReplay`
    // below) legitimately need DIFFERENT answers to the same question asked at different
    // moments. Applied identically to the STORED claim body (so a same-role replay never
    // surfaces the raw position either) and to the fresh-write's own returned value —
    // never only on the way out, which a future caller of the stored body could too
    // easily miss. Declared here, BEFORE `resolveReplay` (issue #1909 review, Devin's
    // ninth-finding-adjacent fix): `resolveReplay` can be invoked from the EARLY,
    // transaction-free replay check below, which runs before the write path's own
    // `siblingFogProtectsAtWrite` computation — a pure function with no closed-over
    // dependency on that value has no such ordering constraint, so it is declared as
    // early as its one real dependency (`role`, a parameter available from the top of
    // this method) allows.
    const redactForRole = (c: Combatant, encounterFogJson: string | null, siblingProtects: boolean): Combatant => {
      if (role === 'dm') return c;
      const fog = parseFog(encounterFogJson);
      const invalidFog = encounterFogJson !== null && fog === null;
      if (invalidFog || siblingProtects) return redactTokenInFog(c, { enabled: true, revealed: [] });
      if (fog?.enabled) return redactTokenInFog(c, fog);
      return c;
    };

    // Issue #580 — per-intent idempotency, same mechanism `updateCombatant`/`rollDeathSave`
    // use above: `delta` is a RELATIVE write, so a retry after a lost response must replay
    // the ORIGINAL committed combatant rather than spend/restore a second time. Scoped to
    // its own operation name so a key reused for a different action still 409s instead of
    // silently replaying the wrong result. Built from fields alone (no combatant row
    // needed) so it can be checked before requiring one to exist — see the early replay
    // check just below.
    const opClaim: EncounterOpClaim | null = patch.idempotencyKey
      ? {
          actorId: user.id,
          operation: 'combatant.resource_adjust',
          key: patch.idempotencyKey,
          encounterId,
          campaignId: encounter.campaignId,
          fingerprint: encounterOpFingerprint({ combatantId, key: patch.key, spellLevel: patch.spellLevel, delta, expectedUsed: patch.expectedUsed }),
        }
      : null;
    let replayed: Combatant | null = null;
    let eventDetail = '';

    // Issue #1909 review (Devin/Codex secrecy finding): a stored response was rendered for
    // the ROLE that committed it — a DM-only projection (exact fog-hidden token position,
    // unbanded monster HP, an inline statblock) can be embedded in it. If the SAME actor's
    // role has since dropped within the replay window (e.g. a co-DM demoted to player who
    // still happens to own the linked character), replaying that body verbatim would hand
    // them content they may no longer be entitled to see. Mirrors the
    // `prior.responseRole === role` guard every OTHER keyed mutation that stores a
    // role-shaped body already has (`rollCombatantInitiative`, `advanceCurrentTurn`,
    // `undoTurn`): on a mismatch — or a missing body, which cannot happen for THIS
    // implementation since the claim and its body are written in the same transaction, but
    // is handled the same defensive way as those siblings anyway — fall through to a FRESH
    // role-filtered read (`getWithCombatantsOrThrow`) rather than trust the stored
    // projection. This never re-runs the effect a second time; only the returned VIEW is
    // re-derived. Deliberately does NOT require the combatant to still exist when a stored
    // body is being replayed verbatim — only the fresh-read fallback path does, and only
    // because it has no other way to answer "what is the combatant now".
    //
    // Issue #1909 review (Codex, eighth finding): a SAME-role match is not sufficient to
    // trust the stored body VERBATIM for a NON-DM viewer — the stored body was redacted
    // against the fog/sibling-map state as it stood at the ORIGINAL commit, not as it
    // stands now. If a DM has since enabled fog, or a sibling encounter's fog now protects
    // a previously-unprotected shared map, the stored body can still carry raw `tokenX`/
    // `tokenY` that `GET /encounters/:id` would withhold at THIS moment — the role hasn't
    // changed, but the world has. A stored replay response is a snapshot of an
    // AUTHORIZATION decision, not just of data, and that snapshot can go stale exactly like
    // the data it wraps. For a same-role NON-DM match, re-derive the redaction decision
    // fresh (below) rather than either trusting the stored body outright or falling all the
    // way through to `getWithCombatantsOrThrow` — the latter would require the COMBATANT to
    // still exist, which is not the question this finding is about and would undo the
    // replay-survives-combatant-removal/encounter-trash guarantees above for a non-DM
    // caller. The only per-role projection this endpoint's own `redactForRole` ever applies
    // is fog-based token concealment (its scope comment says so explicitly) — HP banding and
    // hidden-NPC-identity masking are never in a Combatant this method returns in the first
    // place (statblock writes are DM-only; character writes carry no HP field on the
    // combatant row) — so re-deriving just that one projection against CURRENT fog/sibling
    // state is sufficient, not a narrowing of what the previous fix already covered.
    const resolveReplay = async (prior: EncounterOpPrior): Promise<Combatant> => {
      const body = prior.response as Combatant | null;
      if (body && prior.responseRole === role) {
        if (role === 'dm') return body;
        const freshEncounterForReplay = await this.getRowOrThrow(encounterId, true);
        const freshSiblingProtects =
          freshEncounterForReplay.mapAttachmentId != null &&
          !fogConcealsPixels(parseFog(freshEncounterForReplay.fog)) &&
          (await this.attachmentsService.isFogProtectedEncounterMap(freshEncounterForReplay.mapAttachmentId, freshEncounterForReplay.campaignId));
        return redactForRole(body, freshEncounterForReplay.fog, freshSiblingProtects);
      }
      // Role MISMATCH (or a missing body, which cannot happen for THIS implementation
      // since the claim and its body are written in the same transaction, but handled the
      // same defensive way as the sibling keyed mutations that guard on this): mirrors
      // `rollCombatantInitiative`/`advanceCurrentTurn`/`undoTurn`'s own
      // `prior.responseRole === role` guard — fall through to a FULL fresh, role-filtered
      // read (`getWithCombatantsOrThrow`), since a role change can affect more projections
      // than fog alone (e.g. a demoted co-DM). This never re-runs the effect a second time;
      // only the returned VIEW is re-derived. Unlike the same-role branch above, THIS path
      // does require the combatant to still exist — it has no other way to answer "what is
      // the combatant now" for an unknown/changed role; a real combatant removal since the
      // original commit still 404s here, same as before this finding.
      //
      // Issue #1909 review (Devin, tenth finding): this fallback used to call
      // `getWithCombatantsOrThrow(encounterId, role)` with its default `includeDeleted =
      // false`, so it 404ed on a role-MISMATCHED replay against an encounter TRASHED since
      // the original commit — the exact class of gap the round-7 fix (the outer
      // `getRowOrThrow(encounterId, true)` plus the early transaction-free
      // `findPriorEncounterOp` short-circuit) closed for the SAME-role path, but this
      // second exit of the same function had the identical defect. `includeDeleted: true`
      // makes this fallback tolerate a trashed encounter exactly like the same-role branch
      // above and the early replay check do — a role-mismatched replay of an
      // already-committed outcome must survive the encounter having since been trashed
      // just as much as a same-role one does.
      const snapshot = await this.getWithCombatantsOrThrow(encounterId, role, undefined, true);
      const found = snapshot.combatants.find((c) => c.id === combatantId);
      if (!found) throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
      return found;
    };

    // Issue #1909 review (Codex): a keyed retry must replay an already-committed outcome
    // even if the combatant was removed (a real DELETE, not soft) since the original commit
    // — the same "the effect already happened, only the response was lost" guarantee every
    // other keyed encounter mutation provides. The transactional `findPriorEncounterOp`
    // check inside each branch below runs AFTER `getCombatantRowOrThrow`, which throws 404
    // unconditionally the moment the combatant is gone — so an ordinary post-action roster
    // change (the DM removing a defeated monster, say) landing between the original commit
    // and a lost-response retry would otherwise break replay for a request that already
    // succeeded. This is a plain, transaction-free SELECT purely as a short-circuit for
    // that case; it does not replace the race-safe `findPriorEncounterOp`/`recordEncounterOp`
    // pair still run inside each branch's own transaction for a genuinely FRESH write —
    // that pair is what actually protects against two concurrent requests with the SAME key
    // racing each other, and is untouched by this early check finding nothing.
    if (opClaim) {
      const earlyPrior = findPriorEncounterOp(this.db, opClaim, Date.now());
      if (earlyPrior) return resolveReplay(earlyPrior);
    }

    const combatant = await this.getCombatantRowOrThrow(encounterId, combatantId);
    let row: typeof combatants.$inferSelect = combatant;

    const isDm = role === 'dm';
    if (combatant.characterId !== null) {
      if (!isDm) {
        const [character] = await this.db.select().from(characters).where(eq(characters.id, combatant.characterId)).limit(1);
        if (!character || character.ownerUserId !== user.id) {
          throw new ForbiddenException('Only dm or the owning player may adjust this combatant\'s resources');
        }
      }
    } else if (!isDm) {
      throw new ForbiddenException('Only dm may adjust a statblock combatant\'s resources');
    }

    let priorClaim: EncounterOpPrior | null = null;
    // Issue #1909 review (Codex, sixth finding): `getWithCombatantsOrThrow`'s own token
    // redaction doesn't stop at THIS encounter's fog — when this encounter's own fog is
    // absent or fully revealed but a SIBLING encounter sharing the same `mapAttachmentId`
    // still conceals it (`isFogProtectedEncounterMap`), every token on the shared map is
    // still masked. That check is async (it queries sibling encounters), so it cannot run
    // inside the synchronous better-sqlite3 transaction below — awaited ONCE here, before
    // any transaction opens, since it depends only on `mapAttachmentId`/campaignId and
    // sibling encounters' fog, none of which THIS write touches. A sibling's fog could in
    // principle change between this read and the eventual commit; erring toward redaction
    // (a stale `true` still redacts) is the safe direction — a redaction that turns out to
    // have been momentarily unnecessary costs a caller one extra read, a missed one is the
    // disclosure this finding is about.
    // Issue #1909 review (Codex, eighth finding): computing this ONCE here and closing
    // over it (as the original version of this fix did) is exactly right for the WRITE
    // path just below (the sibling state at write time is what the write's own response
    // should reflect), but is the WRONG value for a REPLAY read that happens later — see
    // `resolveReplay`'s own fresh recomputation below, which intentionally does NOT reuse
    // this closed-over value. `siblingFogProtectsAtWrite` is named accordingly so a future
    // reader does not accidentally reach for it from the replay path.
    const siblingFogProtectsAtWrite =
      role !== 'dm' &&
      encounter.mapAttachmentId != null &&
      !fogConcealsPixels(parseFog(encounter.fog)) &&
      (await this.attachmentsService.isFogProtectedEncounterMap(encounter.mapAttachmentId, encounter.campaignId));
    let committedFogJson: string | null = null;

    if (combatant.characterId !== null) {
      const characterId = combatant.characterId;
      try {
        this.db.transaction((tx) => {
          if (opClaim) {
            const prior = findPriorEncounterOp(tx, opClaim, Date.now());
            if (prior) {
              priorClaim = prior;
              return;
            }
          }
          // Re-read the encounter INSIDE this transaction, after the replay lookup, so an
          // End that committed while this request was in flight can't be bypassed with the
          // stale outer `encounter` row (issue #1909 review, Codex) — same ordering
          // `updateCombatant` uses. A keyed retry whose claim already committed replayed
          // above and never reaches this line at all.
          const freshEncounter = tx.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all()[0];
          if (!freshEncounter) throw new NotFoundException(`Encounter ${encounterId} not found`);
          // Issue #1909 review (Codex P2): the outer `isVisibleTo` check above ran against
          // the STALE outer `encounter` row — if a DM hides this encounter in the window
          // between that check and this transaction, an owning player's in-flight write
          // would otherwise proceed on `assertMutable`/campaign-writability alone, letting a
          // non-DM mutate a character sheet and log a combat event for an encounter that
          // should now be wholesale nonexistent to them (AGENTS.md's server-enforced-secrecy
          // invariant). Only meaningful here: the statblock branch is DM-only, and a DM's
          // visibility never depends on `hidden`.
          if (!isVisibleTo({ hidden: freshEncounter.hidden }, role)) {
            throw new NotFoundException(`Encounter ${encounterId} not found`);
          }
          this.assertMutable(freshEncounter);
          // Issue #1909 review (Codex P2): `assertMutable` only covers the ENCOUNTER's own
          // deleted/ended status, not the CAMPAIGN's lifecycle — if the campaign was
          // archived or trashed in the window between the controller/MCP tool's role gate
          // and this transaction, `assertMutable` alone would let this write commit anyway.
          // Every OTHER encounter-write transaction that re-reads a fresh encounter row
          // pairs it with this recheck (`addCombatant` `:3863`, `removeCombatant` `:5163`,
          // `undoRemoveCombatant` `:5459`, `rollCombatantInitiative` `:5953`) —
          // `updateCombatant` itself turns out to be a pre-existing exception (missing it
          // too), noted here rather than silently left unmentioned.
          this.assertCampaignWritableInTx(tx, freshEncounter.campaignId);
          // Issue #1909 review (Codex): re-read the COMBATANT row too, inside this same
          // transaction — the outer `getCombatantRowOrThrow` above ran before this
          // transaction started, so a `removeCombatant` (a real DELETE, not a soft one) in
          // that window would otherwise leave this branch writing to the character's sheet
          // and inserting a `resource_changed` event for a combatant no longer in the
          // encounter, using only the stale outer row. Same TOCTOU class as the
          // `assertCampaignWritableInTx` gap above; `updateCombatant`'s own transaction
          // re-reads its combatant row the identical way (`:4499-4502`) after its own fresh
          // encounter read, so this mirrors the established sibling shape. `row` (used below
          // for the event detail and the idempotency claim's stored response body) is
          // reassigned to this fresh row so a name change in the same window isn't lost.
          const freshCombatant = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all()[0];
          if (!freshCombatant || freshCombatant.encounterId !== encounterId) {
            throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
          }
          row = freshCombatant;
          const character = tx.select().from(characters).where(eq(characters.id, characterId)).limit(1).all()[0];
          if (!character) throw new NotFoundException(`No such character ${characterId}`);

          if (patch.spellLevel !== undefined && patch.spellLevel >= 1 && patch.spellLevel <= 9) {
            const slots = fromJsonText<Record<string, { max: number; used: number }>>(character.spellSlots, {});
            const levelKey = String(patch.spellLevel);
            const slot = slots[levelKey];
            if (!slot || slot.max <= 0) {
              throw new BadRequestException(`No spell slots at level ${patch.spellLevel}`);
            }
            // Issue #1909 review (Devin, thirteenth finding): the statblock branch got this
            // malformed-entry guard and its character twin did not — the same
            // one-of-two-symmetric-branches omission as the twelfth finding's missing
            // `encounterId` check, in this same method. `character.spellSlots` is read with a
            // bare `fromJsonText` carrying a CLAIMED type and no runtime validation, so a
            // legacy/imported row can hold a non-numeric `used`/`max`. The check just above
            // does NOT catch it: `'three' <= 0` is false, so a string `max` sails through.
            // Then every NaN comparison is false, so `nextUsed < 0 || nextUsed > slot.max`
            // passes in BOTH directions and persists `used: NaN`, which serializes to `null`
            // and leaves the tracker unusable — the exact contradiction of the "never a
            // silent clamp" contract this PR's own REST and MCP docs state for both
            // branches. Placed before the CAS below so a malformed entry reports what is
            // actually wrong instead of a misleading STALE_WRITE.
            if (!Number.isInteger(slot.used) || !Number.isInteger(slot.max)) {
              throw new BadRequestException(`Spell slot entry for level ${patch.spellLevel} is malformed (used/max must be integers)`);
            }
            // Issue #1909 review (Codex P2): `delta` encodes an ABSOLUTE pip intent
            // ("set this slot's used to N") converted to a relative delta against whatever
            // `used` the caller last rendered. The transactional fresh-row read above
            // prevents the whole-blob lost-update this endpoint replaced, but does nothing
            // to stop a SECOND caller's delta — computed against the SAME stale baseline —
            // from landing on top of a first caller's fresh result (two clicks of "set to
            // 1" from a shared used:0 baseline would otherwise commit used:1 then used:2).
            // `expectedUsed` is optional (a purely relative caller, e.g. an AI DM's
            // "restore 2 charges", never sends it) but when present is checked against the
            // FRESH `slot.used` read just above, inside this same transaction — the same
            // per-value CAS shape as `expectedUpdatedAt` elsewhere, scoped to one resource
            // instead of the whole sheet/statblock.
            if (patch.expectedUsed !== undefined && patch.expectedUsed !== slot.used) {
              throw new ConflictException({
                code: 'STALE_WRITE',
                message: `Level ${patch.spellLevel} spell slot changed since last read (expected used ${patch.expectedUsed}, now ${slot.used})`,
                expectedUsed: patch.expectedUsed,
                currentUsed: slot.used,
              });
            }
            const nextUsed = slot.used + delta;
            if (nextUsed < 0 || nextUsed > slot.max) {
              throw new BadRequestException(`Spell slot adjustment would exceed bounds [0, ${slot.max}] (resulting used: ${nextUsed})`);
            }
            slot.used = nextUsed;
            slots[levelKey] = slot;
            // Issue #1902 rework (round 10): nextUpdatedAt, not nowIso — `updatedAt` is a CAS
            // token `patchSpellSlots`'s `expectedUpdatedAt` guard depends on advancing on
            // EVERY spellSlots writer. `character` was read INSIDE this same transaction
            // above, so there's no separate atomicity gap to guard here.
            tx.update(characters).set({ spellSlots: toJsonText(slots), updatedAt: nextUpdatedAt(character.updatedAt) }).where(eq(characters.id, characterId)).run();
            eventDetail = `${delta > 0 ? 'spent' : 'restored'} ${Math.abs(delta)} Level ${patch.spellLevel} spell slot`;
          } else if (patch.key) {
            const resources = fromJsonText<Record<string, { max: number; used: number; name?: string; recharge?: string }>>(character.resources, {});
            // Issue #1909 review (Devin, eleventh finding): this used to fall back to a
            // SYNTHESIZED `{max: 1, used: 0, ...}` entry when `patch.key` didn't exist on
            // the character, silently creating a brand-new max-1 resource and marking it
            // spent — the opposite of the spell-slot path just above, which 400s on an
            // unknown level (`No spell slots at level N`), and a direct contradiction of
            // this tool's own documented contract (`mcp-tools.ts`: "Spending past 0 or
            // restoring past max FAILS with a 400 — never a silent clamp — so success can
            // be trusted"). A fabricated pool made that promise false: the spend "succeeds"
            // against a resource that never existed. This PR is what made the defect
            // reachable at all — the web UI only ever sent keys it rendered FROM the
            // stored resources, so an unknown key could never occur before this REST/MCP
            // surface existed, and finding 9's AI-driver allow-list entry put a caller that
            // can plausibly hallucinate a key on the other end. Decision: unknown key 400s,
            // matching the spell-slot path and the documented contract, on BOTH branches of
            // this method (see the statblock branch's identical fix below) — create-on-
            // demand is a real feature someone could want, but it must be an explicit,
            // named capability, not an accident of `??`.
            const res = resources[patch.key];
            if (!res) {
              throw new BadRequestException(`No such resource '${patch.key}'`);
            }
            // Issue #1909 review (Devin, thirteenth finding): character-branch counterpart to
            // the statblock branch's identical guard. `character.resources` gets the same
            // unvalidated `fromJsonText` treatment as `spellSlots` above, and here there is
            // no prior check at all to lean on — a missing `used` reaches the arithmetic
            // directly. A string `max` additionally disables the upper bound outright, since
            // `nextUsed > 'three'` is false for any number.
            if (!Number.isInteger(res.used) || !Number.isInteger(res.max)) {
              throw new BadRequestException(`Resource '${patch.key}' entry is malformed (used/max must be integers)`);
            }
            // Issue #1909 review (Codex P2): same per-resource expected-value CAS as the
            // spell-slot branch above.
            if (patch.expectedUsed !== undefined && patch.expectedUsed !== res.used) {
              throw new ConflictException({
                code: 'STALE_WRITE',
                message: `Resource '${patch.key}' changed since last read (expected used ${patch.expectedUsed}, now ${res.used})`,
                expectedUsed: patch.expectedUsed,
                currentUsed: res.used,
              });
            }
            const nextUsed = res.used + delta;
            if (nextUsed < 0 || nextUsed > res.max) {
              throw new BadRequestException(`Resource '${patch.key}' adjustment would exceed bounds [0, ${res.max}] (resulting used: ${nextUsed})`);
            }
            res.used = nextUsed;
            resources[patch.key] = res;
            tx.update(characters).set({ resources: toJsonText(resources), updatedAt: nextUpdatedAt(character.updatedAt) }).where(eq(characters.id, characterId)).run();
            eventDetail = `${delta > 0 ? 'spent' : 'restored'} ${Math.abs(delta)} ${res.name || patch.key}`;
          } else {
            throw new BadRequestException('Must supply either spellLevel or key to adjust');
          }

          tx.insert(encounterEvents)
            .values({
              encounterId,
              round: freshEncounter.round,
              type: 'resource_changed',
              actor: row.name,
              actorId: row.id,
              target: null,
              targetId: null,
              detail: eventDetail,
              createdAt: nowIso(),
            })
            .run();

          // `row` was reassigned to the fresh in-transaction re-read above (issue #1909
          // review, Codex) — this branch never WRITES to the `combatants` row itself (the
          // resource lives on the linked character sheet), but the re-read still confirms
          // the combatant is still actually present before either the event or this claim
          // body references it.
          committedFogJson = freshEncounter.fog;
          if (opClaim) recordEncounterOp(tx, opClaim, nowIso(), { body: redactForRole(combatantToDomain(row), freshEncounter.fog, siblingFogProtectsAtWrite), role });
        });
        if (priorClaim) replayed = await resolveReplay(priorClaim);
      } catch (err) {
        // Issue #1909 review (Devin + Copilot, same defect): `recordEncounterOp` throws
        // this plain Error — never an HttpException — when a concurrent request with the
        // SAME idempotencyKey inserted its claim first; our own effect already rolled
        // back. Replay the winner's stored response instead of letting the marker escape
        // as an unhandled 500, exactly like `updateCombatant`/`removeCombatant` do —
        // through the same role-checked `resolveReplay` as the in-transaction replay above
        // (issue #1909 review, secrecy finding), not the raw stored body.
        if (opClaim && err instanceof EncounterOpRaceMarker) {
          const prior = await readEncounterOpAfterRace(this.db, err.claim);
          replayed = await resolveReplay(prior);
        } else {
          throw err;
        }
      }
    } else {
      // Statblock branch (issue #1909): inline monster/NPC resources live on the
      // combatant row's `statblockJson`, not a character sheet. Same fresh-row-inside-
      // the-transaction read-modify-write as the character branch above.
      if (!combatant.statblockJson) {
        throw new BadRequestException('This combatant has no inline statblock resources');
      }
      try {
        this.db.transaction((tx) => {
          if (opClaim) {
            const prior = findPriorEncounterOp(tx, opClaim, Date.now());
            if (prior) {
              priorClaim = prior;
              return;
            }
          }
          // Re-read the encounter row too, INSIDE this transaction, after the replay
          // lookup, so an End that committed while this request was in flight can't be
          // bypassed with the stale outer `encounter` row (issue #1909 review, Codex) —
          // same ordering `updateCombatant` uses — and so the `updatedAt` this write
          // advances from (below) is never a stale pre-transaction snapshot.
          const freshEncounter = tx.select().from(encounters).where(eq(encounters.id, encounterId)).limit(1).all()[0];
          if (!freshEncounter) throw new NotFoundException(`Encounter ${encounterId} not found`);
          this.assertMutable(freshEncounter);
          // Issue #1909 review (Codex P2): see the character branch's identical comment
          // above — `assertMutable` alone does not cover an archive/trash of the CAMPAIGN
          // landing in the window between the role gate and this transaction.
          this.assertCampaignWritableInTx(tx, freshEncounter.campaignId);
          // Issue #1909 review (Devin): this re-read must answer the SAME two questions the
          // character branch answers at `:8946-8949`, and it was collapsing them into one.
          // "Row is gone" and "row exists but carries no inline statblock" are different
          // facts with different correct answers, and the missing-row case is the whole
          // reason this re-read exists — reporting it as "has no inline statblock resources"
          // tells a DM whose monster a co-DM deleted mid-click that their statblock is
          // broken. The encounter-scoping half was simply absent: the stale outer row is
          // exactly what cannot be trusted here, so a combatant that moved encounters inside
          // this window would have been written through unscoped. Both branches were added
          // in this PR for the identical TOCTOU concern; the asymmetry was an oversight, not
          // a decision.
          const fresh = tx.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all()[0];
          if (!fresh || fresh.encounterId !== encounterId) {
            throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
          }
          if (!fresh.statblockJson) {
            throw new BadRequestException('This combatant has no inline statblock resources');
          }
          // Issue #1909 review (Devin P2): every READ path for this column
          // (`parseCombatantStatblock`, `:248-252`) uses `safeParse` and degrades a
          // corrupt/legacy row to `null` rather than throwing — this write path used
          // `.parse`, so a `ZodError` on a legacy/malformed stored statblock escaped as an
          // unhandled 500, inconsistent with the typed 400s this same branch deliberately
          // added for malformed `used`/`max` just below. `rawStatblock` is the ORIGINAL
          // parsed JSON (untouched by Zod's defaults/strip-unknown-keys), kept alongside
          // the validated `statblock` so the write below can merge only the ONE changed
          // resource/spell-slot entry back into it — see the write below for why.
          const rawStatblock = fromJsonText<Record<string, unknown>>(fresh.statblockJson, {});
          const parsedStatblock = CombatantStatblock.safeParse(rawStatblock);
          if (!parsedStatblock.success) {
            throw new BadRequestException("This combatant's inline statblock is malformed and cannot be adjusted here — open it in the statblock editor to fix or replace it.");
          }
          const statblock = parsedStatblock.data;

          if (patch.spellLevel !== undefined && patch.spellLevel >= 1 && patch.spellLevel <= 9) {
            const levelKey = String(patch.spellLevel);
            const slot = statblock.spellSlots[levelKey] as { max: number; used: number } | undefined;
            if (!slot || slot.max <= 0) {
              throw new BadRequestException(`No spell slots at level ${patch.spellLevel}`);
            }
            // Issue #1909 review (Codex P2): `CombatantStatblock.spellSlots`/`.resources`
            // are `z.record(..., z.any())` — no per-entry shape enforcement — so a stored
            // entry can be malformed (`{max: 3}` with no `used`, or `{}` entirely). Without
            // this check, `slot.used + delta` below would be `NaN`, and `NaN < 0 || NaN >
            // slot.max` is FALSE either way (every NaN comparison is false), so the
            // overspend/over-restore guard would silently pass and persist `used: NaN` —
            // which serializes to `null` and leaves the tracker unusable — directly
            // contradicting this endpoint's documented contract that overspend/
            // over-restore is always a typed 400, never a silent clamp (or, worse here, a
            // silent corruption). A non-numeric `max` would also disable the upper bound
            // entirely (`nextUsed > undefined` is always false). Validate numerically
            // BEFORE computing the delta so a malformed entry 400s, naming it, instead of
            // writing garbage.
            if (!Number.isInteger(slot.used) || !Number.isInteger(slot.max)) {
              throw new BadRequestException(`Spell slot entry for level ${patch.spellLevel} is malformed (used/max must be integers)`);
            }
            // Issue #1909 review (Codex P2): `delta` encodes an ABSOLUTE pip intent
            // ("set this slot's used to N") converted to a relative delta against whatever
            // `used` the caller last rendered. The transactional fresh-row read above
            // prevents the whole-blob lost-update this endpoint replaced, but does nothing
            // to stop a SECOND caller's delta — computed against the SAME stale baseline —
            // from landing on top of a first caller's fresh result (two clicks of "set to
            // 1" from a shared used:0 baseline would otherwise commit used:1 then used:2).
            // `expectedUsed` is optional (a purely relative caller, e.g. an AI DM's
            // "restore 2 charges", never sends it) but when present is checked against the
            // FRESH `slot.used` read just above, inside this same transaction — the same
            // per-value CAS shape as `expectedUpdatedAt` elsewhere, scoped to one resource
            // instead of the whole encounter.
            if (patch.expectedUsed !== undefined && patch.expectedUsed !== slot.used) {
              throw new ConflictException({
                code: 'STALE_WRITE',
                message: `Level ${patch.spellLevel} spell slot changed since last read (expected used ${patch.expectedUsed}, now ${slot.used})`,
                expectedUsed: patch.expectedUsed,
                currentUsed: slot.used,
              });
            }
            const nextUsed = slot.used + delta;
            if (nextUsed < 0 || nextUsed > slot.max) {
              throw new BadRequestException(`Spell slot adjustment would exceed bounds [0, ${slot.max}] (resulting used: ${nextUsed})`);
            }
            statblock.spellSlots[levelKey] = { ...slot, used: nextUsed };
            // Issue #1909 review (Devin P2): merge only the TOUCHED level back into the
            // ORIGINAL raw `rawStatblock.spellSlots`, not the re-parsed `statblock` as a
            // whole — `.safeParse` applies schema defaults and strips unknown keys, so
            // writing the re-parsed object back would silently normalize every OTHER
            // untouched part of the stored statblock (AC, actions, unrelated resources) on
            // a single pip click. Every field this endpoint didn't touch survives exactly
            // as stored.
            rawStatblock.spellSlots = { ...(rawStatblock.spellSlots as Record<string, unknown> | undefined), [levelKey]: statblock.spellSlots[levelKey] };
            eventDetail = `${delta > 0 ? 'spent' : 'restored'} ${Math.abs(delta)} Level ${patch.spellLevel} spell slot`;
          } else if (patch.key) {
            // Issue #1909 review (Devin, eleventh finding): see the character branch's
            // identical fix above for the full rationale — this branch had the SAME
            // synthesized-`{max: 1, used: 0, ...}`-on-missing-key fallback, silently
            // creating a brand-new resource on a typo or a hallucinated AI-driver key
            // instead of 400ing the way the spell-slot path above already does.
            const res = statblock.resources[patch.key] as { max: number; used: number; name?: string; recharge?: string } | undefined;
            if (!res) {
              throw new BadRequestException(`No such resource '${patch.key}'`);
            }
            // Issue #1909 review (Codex P2): same malformed-entry guard as the spell-slot
            // branch above — an EXISTING stored entry is not schema-enforced and can carry
            // a non-numeric `used`/`max`.
            if (!Number.isInteger(res.used) || !Number.isInteger(res.max)) {
              throw new BadRequestException(`Resource '${patch.key}' entry is malformed (used/max must be integers)`);
            }
            // Issue #1909 review (Codex P2): same per-resource expected-value CAS as the
            // spell-slot branch above.
            if (patch.expectedUsed !== undefined && patch.expectedUsed !== res.used) {
              throw new ConflictException({
                code: 'STALE_WRITE',
                message: `Resource '${patch.key}' changed since last read (expected used ${patch.expectedUsed}, now ${res.used})`,
                expectedUsed: patch.expectedUsed,
                currentUsed: res.used,
              });
            }
            const nextUsed = res.used + delta;
            if (nextUsed < 0 || nextUsed > res.max) {
              throw new BadRequestException(`Resource '${patch.key}' adjustment would exceed bounds [0, ${res.max}] (resulting used: ${nextUsed})`);
            }
            statblock.resources[patch.key] = { ...res, used: nextUsed };
            // Issue #1909 review (Devin P2): same merge-only-the-touched-entry rationale as
            // the spell-slot branch above.
            rawStatblock.resources = { ...(rawStatblock.resources as Record<string, unknown> | undefined), [patch.key]: statblock.resources[patch.key] };
            eventDetail = `${delta > 0 ? 'spent' : 'restored'} ${Math.abs(delta)} ${res.name || patch.key}`;
          } else {
            throw new BadRequestException('Must supply either spellLevel or key to adjust');
          }

          const [updated] = tx
            .update(combatants)
            .set({ statblockJson: toJsonText(rawStatblock) })
            .where(eq(combatants.id, combatantId))
            .returning()
            .all();
          row = updated;

          // Issue #1909 review (Devin + Copilot, same defect): this write touches the
          // COMBATANT row directly, exactly like updateCombatant's own writes — advance the
          // ENCOUNTER's `updatedAt` too (the CAS token `PATCH .../combatants/:cid`'s
          // `expectedUpdatedAt` validates against). Without this, a second writer holding a
          // pre-spend token could still PATCH the whole statblock, pass `assertNotStale` on
          // the encounter-wide check, and silently revert this spend.
          //
          // `combatantStateVersion` moves too, mirroring `updateCombatant`'s own
          // unconditional-when-running rule (issue #1637's action-preview ABA guard): a
          // statblock resource spend is a real combatant-state change and must invalidate an
          // in-flight action preview the same way any other combatant write does.
          if (freshEncounter.status === 'running') {
            tx.update(encounters)
              .set({
                combatantStateVersion: sql`${encounters.combatantStateVersion} + 1`,
                updatedAt: nextUpdatedAt(freshEncounter.updatedAt),
              })
              .where(eq(encounters.id, encounterId))
              .run();
          } else {
            tx.update(encounters)
              .set({ updatedAt: nextUpdatedAt(freshEncounter.updatedAt) })
              .where(eq(encounters.id, encounterId))
              .run();
          }

          // Issue #1909 review (Devin, seventh finding): use the in-transaction re-read
          // (`row`, reassigned to `updated` just above), not the pre-transaction
          // `combatant` snapshot — a combatant renamed in the window between the outer
          // fetch and this transaction must not be logged under its stale name. Matches
          // the character branch above (`actor: row.name`), which already does this and
          // documents why; this branch had drifted from it.
          tx.insert(encounterEvents)
            .values({
              encounterId,
              round: freshEncounter.round,
              type: 'resource_changed',
              actor: row.name,
              actorId: row.id,
              target: null,
              targetId: null,
              detail: eventDetail,
              createdAt: nowIso(),
            })
            .run();

          committedFogJson = freshEncounter.fog;
          // `redactForRole` is a no-op here in practice (this branch is DM-only, and a DM's
          // response is never redacted) but applied for consistency with the character
          // branch above rather than special-cased away.
          if (opClaim) recordEncounterOp(tx, opClaim, nowIso(), { body: redactForRole(combatantToDomain(row), freshEncounter.fog, siblingFogProtectsAtWrite), role });
        });
        if (priorClaim) replayed = await resolveReplay(priorClaim);
      } catch (err) {
        // Issue #1909 review (Devin + Copilot, same defect): same race-marker replay as
        // the character branch above — `recordEncounterOp` throws a plain Error (never an
        // HttpException) on a concurrent same-key insert; replay the winner instead of
        // letting it escape as an unhandled 500 — through the same role-checked
        // `resolveReplay` as the in-transaction replay above (issue #1909 review, secrecy
        // finding), not the raw stored body.
        if (opClaim && err instanceof EncounterOpRaceMarker) {
          const prior = await readEncounterOpAfterRace(this.db, err.claim);
          replayed = await resolveReplay(prior);
        } else {
          throw err;
        }
      }
    }

    // An idempotent replay stops here: no second audit row, no duplicate combat-log event,
    // no second SSE nudge — the first attempt already produced all of those.
    if (replayed) return replayed;

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'encounter.combatant.resource',
      entityType: 'combatant',
      entityId: combatantId,
      campaignId: encounter.campaignId,
      detail: eventDetail,
    });

    // `sheetMirrored` only for the character branch (issue #1902 rework, round 19
    // convention) — the statblock branch writes only the combatant row itself, which the
    // ordinary encounter.updated nudge already covers.
    //
    // Issue #1909 review (Codex P2): gating on the OUTER `encounter.hidden` (read before the
    // transaction) let a DM's concurrent hide land between that read and this emit, still
    // publishing the encounter id on the shared campaign stream. `emitEncounterEvent` exists
    // precisely to close this — it re-reads `hidden` itself at emit time — so route through
    // it instead of gating manually on a value that can go stale mid-request, matching every
    // other encounter-write path in this service.
    this.emitEncounterEvent('encounter.updated', encounter.campaignId, encounter.id, false, {
      sheetMirrored: combatant.characterId !== null,
    });

    // Issue #1909 review (Codex P1, secrecy): redact using the fog state committed inside
    // the transaction above, not a value read before it — see `redactForRole`'s own comment.
    return redactForRole(combatantToDomain(row), committedFogJson, siblingFogProtectsAtWrite);
  }

  async listTokenFormations(campaignId: number, _role: Role) {
    return this.db.select().from(campaignTokenFormations).where(eq(campaignTokenFormations.campaignId, campaignId));
  }
  async createTokenFormation(campaignId: number, input: { name: string; slots: unknown[] }, user: RequestUser, role: Role) {
    if (role !== 'dm') throw new ForbiddenException('Only dm may save formations');
    try {
      return this.db.insert(campaignTokenFormations).values({ campaignId, name: input.name.trim(), layoutJson: toJsonText(input.slots), createdBy: user.id, createdAt: nowIso() }).returning().get();
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new ConflictException('A formation with this name already exists');
      throw error;
    }
  }
  async deleteTokenFormation(campaignId: number, formationId: number, role: Role) {
    if (role !== 'dm') throw new ForbiddenException('Only dm may delete formations');
    const row = this.db.delete(campaignTokenFormations).where(and(eq(campaignTokenFormations.id, formationId), eq(campaignTokenFormations.campaignId, campaignId))).returning().get();
    if (!row) throw new NotFoundException('Formation not found'); return { ok: true };
  }

  async previewTokenBatch(encounterId: number, input: { placements: Array<{ combatantId: number; x: number; y: number }>; mapAspect: number }, user: RequestUser, role: Role) {
    if (role !== 'dm') throw new ForbiddenException('Only dm may batch-place tokens');
    const encounter = await this.getRowOrThrow(encounterId); this.assertMutable(encounter);
    // Abandoned previews are never replayable after a short operator window.
    this.db.delete(encounterTokenBatches).where(and(eq(encounterTokenBatches.encounterId, encounterId), eq(encounterTokenBatches.status, 'previewed'), lt(encounterTokenBatches.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()))).run();
    const ids = input.placements.map(p => p.combatantId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each combatant may appear once');
    const rows = await this.db.select().from(combatants).where(eq(combatants.encounterId, encounterId));
    const byId = new Map(rows.map(r => [r.id, r]));
    if (ids.some(id => !byId.has(id))) throw new BadRequestException('A token is not in this encounter');
    // Coordinates are token centres. Check every requested footprint against the
    // untouched roster and one another before persisting a preview, so a caller can
    // never turn "Place all" into overlapping tokens by bypassing the UI planner.
    const sizeCells: Record<string, number> = { tiny: .5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };
    const cellPercent = Math.max(1, encounter.gridSize ?? 5);
    const aspect = input.mapAspect;
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, (a.y - b.y) * aspect);
    const radius = (row: { tokenSize: string | null }) => (sizeCells[row.tokenSize ?? 'medium'] ?? 1) * cellPercent / 2;
    const requested = input.placements.map(p => ({ ...p, radius: radius(byId.get(p.combatantId)!) }));
    for (const p of requested) {
      if (p.x - p.radius < 0 || p.x + p.radius > 100 || p.y - p.radius / aspect < 0 || p.y + p.radius / aspect > 100) throw new BadRequestException('A token footprint is outside the map');
      for (const existing of rows) {
        if (ids.includes(existing.id) || existing.tokenX == null || existing.tokenY == null) continue;
        if (distance(p, { x: existing.tokenX, y: existing.tokenY }) < p.radius + radius(existing) - .001) throw new ConflictException('A token placement overlaps an existing token');
      }
    }
    for (let i = 0; i < requested.length; i++) for (let j = 0; j < i; j++) {
      const a = requested[i], b = requested[j];
      if (distance(a, b) < a.radius + b.radius - .001) throw new ConflictException('Token batch placements overlap');
    }
    const before = input.placements.map(p => { const r = byId.get(p.combatantId)!; return { id: r.id, tokenX: r.tokenX, tokenY: r.tokenY, tokenSize: r.tokenSize }; });
    const fingerprint = encounterOpFingerprint(input);
    const previewToken = randomUUID();
    this.db.insert(encounterTokenBatches).values({ encounterId, campaignId: encounter.campaignId, actorId: user.id, previewToken, fingerprint, status: 'previewed', beforeJson: toJsonText(before), planJson: toJsonText({ placements: input.placements, mapAspect: input.mapAspect }), createdAt: nowIso() }).run();
    return { previewToken, included: input.placements, omitted: [], conflicts: [], expiresAt: null };
  }

  async applyTokenBatch(encounterId: number, input: { previewToken: string; idempotencyKey: string }, user: RequestUser, role: Role) {
    if (role !== 'dm') throw new ForbiddenException('Only dm may batch-place tokens');
    const batch = this.db.select().from(encounterTokenBatches).where(eq(encounterTokenBatches.previewToken, input.previewToken)).get();
    if (!batch || batch.encounterId !== encounterId || batch.actorId !== user.id) throw new NotFoundException('Token batch preview not found');
    const keyOwner = this.db.select().from(encounterTokenBatches).where(and(eq(encounterTokenBatches.actorId, user.id), eq(encounterTokenBatches.applyKey, input.idempotencyKey))).get();
    if (keyOwner && keyOwner.id !== batch.id) throw new ConflictException('Idempotency key was already used for a different token batch');
    if (batch.status === 'applied') {
      if (batch.applyKey !== input.idempotencyKey) throw new ConflictException('Idempotency key was reused for a different token batch');
      return fromJsonText<{ batchId: number; undoToken: string; placements: Array<{ combatantId: number; x: number; y: number }>}>(batch.resultJson, { batchId: batch.id, undoToken: batch.previewToken, placements: [] });
    }
    const encounter = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounter);
    if (batch.status !== 'previewed') throw new ConflictException('Token batch is no longer applicable');
    const previewTtlMs = 24 * 60 * 60 * 1000;
    if (batch.createdAt < new Date(Date.now() - previewTtlMs).toISOString()) throw new ConflictException('Token batch preview has expired; preview again');
    const before = fromJsonText<Array<{ id:number; tokenX:number|null; tokenY:number|null; tokenSize?: string | null }>>(batch.beforeJson, []);
    const batchPlan = fromJsonText<{ placements: Array<{ combatantId:number; x:number; y:number }>; mapAspect: number }>(batch.planJson, { placements: [], mapAspect: 1 });
    const plan = batchPlan.placements;
    const result = { batchId: batch.id, undoToken: batch.previewToken, placements: plan };
    try {
      this.db.transaction(tx => {
      for (const slice of before) { const r = tx.select().from(combatants).where(eq(combatants.id, slice.id)).get(); if (!r || r.tokenX !== slice.tokenX || r.tokenY !== slice.tokenY || r.tokenSize !== slice.tokenSize) throw new ConflictException('Token positions changed; refresh preview'); }
      // Preview's obstacle snapshot is only advisory: an unselected token may have
      // moved while the operator reviewed the plan. Re-check it under the same write
      // transaction so batch placement can never commit into a newly occupied cell.
      const live = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all();
      const selected = new Set(plan.map(p => p.combatantId));
      const liveById = new Map(live.map(row => [row.id, row]));
      const cellPercent = Math.max(1, encounter.gridSize ?? 5);
      const aspect = batchPlan.mapAspect;
      const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, (a.y - b.y) * aspect);
      const batchSizes: Record<string, number> = { tiny: .5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };
      const radius = (row: { tokenSize: string | null }) => (batchSizes[row.tokenSize ?? 'medium'] ?? 1) * cellPercent / 2;
      for (let i = 0; i < plan.length; i++) {
        const source = liveById.get(plan[i].combatantId)!;
        const sourceRadius = radius(source);
        if (plan[i].x - sourceRadius < 0 || plan[i].x + sourceRadius > 100 || plan[i].y - sourceRadius / aspect < 0 || plan[i].y + sourceRadius / aspect > 100) throw new ConflictException('Grid size changed and a token no longer fits; refresh preview');
        for (let j = 0; j < i; j++) if (distance(plan[i], plan[j]) < sourceRadius + radius(liveById.get(plan[j].combatantId)!) - .001) throw new ConflictException('Grid size changed and batch tokens now overlap; refresh preview');
      }
      for (const p of plan) for (const other of live) {
        if (selected.has(other.id) || other.tokenX == null || other.tokenY == null) continue;
        if (distance(p, { x: other.tokenX, y: other.tokenY }) < radius(liveById.get(p.combatantId)!) + radius(other) - .001) throw new ConflictException('A token moved into this batch placement; refresh preview');
      }
      for (const p of plan) tx.update(combatants).set({ tokenX: clampPercent(p.x), tokenY: clampPercent(p.y) }).where(eq(combatants.id, p.combatantId)).run();
      if (encounter.status === 'running') {
        tx.update(encounters).set({ combatantStateVersion: sql`${encounters.combatantStateVersion} + 1` }).where(eq(encounters.id, encounterId)).run();
      }
      tx.insert(encounterEvents).values({ encounterId, round: encounter.round, type: 'token_batch', actor: user.name, actorId: null, target: null, targetId: null, detail: `${plan.length} token placements`, performedByJson: JSON.stringify({ userId: user.id, role, kind: 'human' }), createdAt: nowIso() }).run();
      this.audit.logInTx(tx, { actor: auditActor(user), actorRole: role, action: 'encounter.token_batch.apply', entityType: 'encounter', entityId: encounterId, campaignId: batch.campaignId, detail: `${plan.length} token placements` });
      const changed = tx.update(encounterTokenBatches).set({ status: 'applied', applyKey: input.idempotencyKey, afterJson: toJsonText(plan), resultJson: toJsonText(result), appliedAt: nowIso() }).where(and(eq(encounterTokenBatches.id, batch.id), eq(encounterTokenBatches.status, 'previewed'))).run();
      if (changed.changes !== 1) throw new ConflictException('Token batch was applied concurrently');
      });
    } catch (err) {
      // Two concurrent applies with the same idempotency key for different previews race
      // past the keyOwner pre-check; convert the partial unique-index violation to the
      // deterministic conflict response instead of a 500.
      if (isUniqueConstraintError(err)) throw new ConflictException('Idempotency key was already used for a different token batch');
      throw err;
    }
    this.emitEncounterEvent('encounter.updated', batch.campaignId, encounterId, false);
    return result;
  }

  async undoTokenBatch(encounterId: number, input: { undoToken: string; idempotencyKey: string }, user: RequestUser, role: Role) {
    if (role !== 'dm') throw new ForbiddenException('Only dm may undo a token batch');
    const batch = this.db.select().from(encounterTokenBatches).where(eq(encounterTokenBatches.previewToken, input.undoToken)).get();
    if (!batch || batch.encounterId !== encounterId || batch.actorId !== user.id) throw new NotFoundException('Token batch not found');
    const keyOwner = this.db.select().from(encounterTokenBatches).where(and(eq(encounterTokenBatches.actorId, user.id), eq(encounterTokenBatches.undoKey, input.idempotencyKey))).get();
    if (keyOwner && keyOwner.id !== batch.id) throw new ConflictException('Idempotency key was already used for a different token undo');
    if (batch.status === 'undone') {
      if (batch.undoKey !== input.idempotencyKey) throw new ConflictException('Idempotency key was reused for a different undo');
      return { ok: true, idempotent: true };
    }
    const encounter = await this.getRowOrThrow(encounterId);
    this.assertMutable(encounter);
    if (batch.status !== 'applied') throw new ConflictException('Token batch cannot be undone');
    const before = fromJsonText<Array<{ id:number; tokenX:number|null; tokenY:number|null; tokenSize?: string | null }>>(batch.beforeJson, []); const after = fromJsonText<Array<{ combatantId:number; x:number; y:number }>>(batch.afterJson, []); const batchPlan = fromJsonText<{ placements: Array<{ combatantId:number; x:number; y:number }>; mapAspect: number }>(batch.planJson, { placements: [], mapAspect: 1 });
    try {
      this.db.transaction(tx => {
      for (const p of after) {
        const row = tx.select().from(combatants).where(eq(combatants.id, p.combatantId)).get();
        if (!row || row.tokenX !== p.x || row.tokenY !== p.y) throw new ConflictException('A token changed after this batch');
      }
      const selected = new Set(before.map(p => p.id));
      const live = tx.select().from(combatants).where(eq(combatants.encounterId, encounterId)).all();
      const byId = new Map(live.map(row => [row.id, row]));
      const cellPercent = Math.max(1, encounter.gridSize ?? 5);
      const aspect = batchPlan.mapAspect;
      const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, (a.y - b.y) * aspect);
      const radius = (size: string | null) => ({ tiny:.5, small:1, medium:1, large:2, huge:3, gargantuan:4 }[size ?? 'medium'] ?? 1) * cellPercent / 2;
      for (let i = 0; i < before.length; i++) {
        const p = before[i], row = byId.get(p.id)!;
        const r = radius(row.tokenSize);
        if (p.tokenX != null && p.tokenY != null && (p.tokenX - r < 0 || p.tokenX + r > 100 || p.tokenY - r / aspect < 0 || p.tokenY + r / aspect > 100)) throw new ConflictException('Current token size no longer fits the undo position');
        for (let j = 0; j < i; j++) {
          const q = before[j], other = byId.get(q.id)!;
          if (p.tokenX != null && p.tokenY != null && q.tokenX != null && q.tokenY != null && distance({ x: p.tokenX, y: p.tokenY }, { x: q.tokenX, y: q.tokenY }) < r + radius(other.tokenSize) - .001) throw new ConflictException('Current token sizes make undo positions overlap');
        }
      }
      for (const p of before) if (p.tokenX != null && p.tokenY != null) for (const other of live) {
        if (!selected.has(other.id) && other.tokenX != null && other.tokenY != null && distance({ x: p.tokenX, y: p.tokenY }, { x: other.tokenX, y: other.tokenY }) < radius(byId.get(p.id)!.tokenSize) + radius(other.tokenSize) - .001) throw new ConflictException('A token moved into this batch\'s prior position; cannot undo');
      }
      for (const p of before) tx.update(combatants).set({ tokenX:p.tokenX, tokenY:p.tokenY }).where(eq(combatants.id,p.id)).run();
      if (encounter.status === 'running') {
        tx.update(encounters).set({ combatantStateVersion: sql`${encounters.combatantStateVersion} + 1` }).where(eq(encounters.id, encounterId)).run();
      }
      tx.insert(encounterEvents).values({ encounterId, round: encounter.round, type: 'token_batch', actor: user.name, actorId: null, target: null, targetId: null, detail: `${before.length} token placements undone`, performedByJson: JSON.stringify({ userId: user.id, role, kind: 'human' }), createdAt: nowIso() }).run();
      this.audit.logInTx(tx, { actor: auditActor(user), actorRole: role, action: 'encounter.token_batch.undo', entityType: 'encounter', entityId: encounterId, campaignId: batch.campaignId, detail: `${before.length} token placements` });
      const changed = tx.update(encounterTokenBatches).set({ status:'undone', undoKey: input.idempotencyKey, undoneAt:nowIso() }).where(and(eq(encounterTokenBatches.id,batch.id), eq(encounterTokenBatches.status, 'applied'))).run();
      if (changed.changes !== 1) throw new ConflictException('Token batch changed concurrently');
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ConflictException('Idempotency key was already used for a different token undo');
      throw err;
    }
    this.emitEncounterEvent('encounter.updated', batch.campaignId, encounterId, false); return { ok:true };
  }

  /**
   * Break a combatant's concentration inside a transaction. Removes every condition instance
   * sourced from the caster across the encounter, clears the caster's turn-state concentration,
   * and updates linked character sheets so the combatant/character mirror stays aligned.
   *
   * If `casterExcluded` is true, the caster's row is NOT updated (the caller owns that write,
   * e.g. the main `updateCombatant` write path). The caller receives the caster's resulting
   * condition instances to merge into its own write.
   *
   * Returns the removed conditions with combatant names so callers can log them.
   */
  private breakConcentration(
    tx: SyncDb,
    encounterId: number,
    casterCombatantId: number,
    turnState: { concentration: string | null; pendingConcentrationChecks: unknown[] } | null,
    casterExcluded: boolean,
    effectName?: string | null,
  ): {
    removed: { combatantId: number; combatantName: string; condition: ConditionInstance }[];
    casterInstances?: ConditionInstance[];
    sheetMirrored: boolean;
  } {
    // Issue #1902 rework (round 22, codex P2): report whether this cascade mirrored any
    // character sheet, matching the same signal `action-resolver.service.ts`'s
    // `breakConcentration` now returns — a cascade can touch a character-linked combatant
    // other than the caster the caller already has in hand.
    let sheetMirrored = false;
    const allRows = tx
      .select({
        id: combatants.id,
        name: combatants.name,
        characterId: combatants.characterId,
        conditions: combatants.conditions,
        conditionInstances: combatants.conditionInstances,
      })
      .from(combatants)
      .where(eq(combatants.encounterId, encounterId))
      .all();
    const withInstances = allRows.map((r) => ({
      id: r.id,
      name: r.name,
      characterId: r.characterId,
      conditionInstances: parseConditionInstances(r.conditionInstances, fromJsonText<string[]>(r.conditions, [])),
    }));
    const { updatedCombatants, removed } = cascadeConcentrationLoss(withInstances, casterCombatantId, effectName);
    const now = nowIso();
    for (const [combatantId, instances] of updatedCombatants) {
      if (casterExcluded && combatantId === casterCombatantId) continue;
      const row = withInstances.find((r) => r.id === combatantId);
      if (!row) continue;
      const write: Partial<typeof combatants.$inferInsert> = conditionWriteSetFromInstances(instances);
      // Issue #1902 rework (round 13, codex P2; corrected round 18, codex P2): computed
      // ONCE, BEFORE either write, and reused for both — see the matching fix (and its
      // fuller doc comment) in `action-resolver.service.ts`'s `breakConcentration` for why
      // the combatant's `sheetSyncedUpdatedAt` and the character's own `updatedAt` must be
      // the EXACT same value.
      let sheetToken: string | undefined;
      if (row.characterId != null) {
        const currentChar = tx.select({ updatedAt: characters.updatedAt }).from(characters).where(eq(characters.id, row.characterId)).get();
        sheetToken = nextUpdatedAt(currentChar?.updatedAt ?? now);
        Object.assign(write, { sheetSyncedUpdatedAt: sheetToken });
      }
      tx.update(combatants).set(write).where(eq(combatants.id, combatantId)).run();
      if (row.characterId != null) {
        tx.update(characters)
          .set({ ...sheetConditionWriteSetFromInstances(instances), updatedAt: sheetToken! })
          .where(eq(characters.id, row.characterId))
          .run();
        sheetMirrored = true;
      }
    }
    if (turnState) {
      turnState.concentration = null;
      turnState.pendingConcentrationChecks = [];
    }
    const casterRow = withInstances.find((r) => r.id === casterCombatantId);
    const casterInstances = updatedCombatants.get(casterCombatantId) ?? casterRow?.conditionInstances;
    return {
      removed: removed.map((r) => ({
        combatantId: r.combatantId,
        combatantName: allRows.find((row) => row.id === r.combatantId)?.name ?? 'Unknown',
        condition: r.condition,
      })),
      casterInstances,
      sheetMirrored,
    };
  }
}
