import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  ActionApplyPolicy,
  ActionApplyRequest,
  ActionResolution,
  ActionResolveRequest,
  ActionResolveResult,
  ActionSpec,
  ActionTargetAllow,
  ActionUndoTarget,
  ActionUndoToken,
  ARCHMAGE_ADAPTER_ID,
  DND5E_ADAPTER_ID,
  EncounterEventMetadata,
  EncounterEventPerformedBy,
  EncounterEventPhase,
  ResolvedTarget,
  Role,
  UsableAction,
  applyDamageModifiers,
  damageDefensesFromStatblock,
  resolveAttackForAdapter,
  checkProficiencyBonusForAdapter,
  classifySaveOutcome,
  combatantActionsFromStatblock,
  computeAttackModifier,
  computeSaveDc,
  CombatantStatblock,
  CombatantTurnState,
  criticalDamageRuleForAdapter,
  expandStatblockActions,
  isResolvableSpec,
  normalizeStats,
  pickOutcomeBranch,
  resolveAbilityModifier,
  rollBranchDamage,
  ruleSystemAdapter,
  signedModifier,
  // #1571 — the SAME overspend rule `CharactersService.patchSpellSlots` enforces (#1039),
  // routed through here rather than re-implemented, so the standalone spend path and the
  // apply_action path cannot drift apart on what "overspend" means.
  applySpellSlotDelta,
  // #1637 — the adapter-owned action-economy model (#413/#618): `actionEconomyForAdapter`
  // resolves the per-slot max the same way the turn workspace and `updateCombatantTurnState`
  // already do, so this resolver doesn't invent a second notion of "how many actions". The
  // legendary-action slot is the one exception the adapter model doesn't cover (it's a
  // per-MONSTER capability, not a per-system one) — `LEGENDARY_ACTION_SLOT` /
  // `LEGENDARY_ACTIONS_PER_ROUND` / `statblockSectionHasEntries` are the exact same trio
  // `updateCombatantTurnState` already uses to bound it.
  actionEconomyForAdapter,
  LEGENDARY_ACTION_SLOT,
  LEGENDARY_ACTIONS_PER_ROUND,
  statblockSectionHasEntries,
  type ActionEconomySlotKind,
  type ActionRollFn,
  type CharacterAction,
  type OutcomeBranch,
  type OutcomeKey,
  type PendingConcentrationCheck,
  type ResolverAdapter,
  type RuleSystemAdapter,
  type SpellSlotMap,
  type TargetDefenses,
} from '@campfire/schema';

import { DB, type DrizzleDb } from '../../db/db.module';
import { actionApplyChains, actionPendingResolutions, campaigns, characters, combatants, encounterEvents, encounters, ruleEntries } from '../../db/schema';
import { CampaignEventsService } from '../events/campaign-events.service';
import { AuditService } from '../audit/audit.service';
import { TableSafetyService } from '../safety/table-safety.service';
import { fromJsonText, toJsonText } from '../../common/json';
import { conditionWriteSetFromNames, readConditionInstances, sheetConditionWriteSetFromNames } from '../../common/conditions';
import { nowIso } from '../../common/time';
import { rollDice, parseCompoundDiceExpr } from '../../common/dice';
import { auditActor, roleAtLeast } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import {
  applyCombatantHp,
  concentrationCheckForDamage,
  enqueueConcentrationCheck,
  type CombatantHpState,
} from './encounters.logic';

type ResolvedActionEconomyCost = {
  slot: string;
  kind: ActionEconomySlotKind | 'legendary';
  max: number | null;
};

/** A sheet action has no durable id. Store a canonical content fingerprint with a pending
 * resolution so apply() can reject a same-named replacement after an edit or reorder. */
function actionFingerprint(action: unknown): string {
  const canonicalize = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
  };

  return createHash('sha256').update(canonicalize(action)).digest('hex');
}

/**
 * Structured action resolver (issue #414) — the server orchestration around the pure,
 * system-aware resolver math in @campfire/schema. It runs the "Use flow": pick an action
 * (from the actor's sheet or an inline/ad-hoc spec), pick legal targets, roll the attack or
 * request saves with the correct modifiers, compare against AC / DC, classify the outcome,
 * PREVIEW the per-target consequences, and — under the campaign policy — apply damage /
 * healing / temp HP / conditions / resource cost ATOMICALLY, writing structured combat-log
 * events and returning an undo token that reverses the whole apply.
 *
 * Authorization: a player may resolve (and, under an automatic policy, apply) their OWN PC's
 * action against any legal target — including a monster, so a player can finish an attack
 * end-to-end. A monster/NPC-controlled action is DM-authorized. When the campaign requires DM
 * turn confirmation (or DM-only turn control), a player's resolve becomes a DECLARATION the DM
 * applies (player-declares / dm-confirmed) rather than an automatic commit.
 *
 * Player-safe vs DM-only text is separated on every {@link ResolvedTarget} so the monster-HP
 * redaction (issue #43) is preserved: the AC/DC and roll internals live in `dmText`, while the
 * player-facing line never leaks a monster's numbers.
 */
@Injectable()
export class ActionResolverService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly events: CampaignEventsService,
    private readonly audit: AuditService,
    /** #599 — optional and last; several specs construct this service positionally. */
    @Optional() private readonly safety?: TableSafetyService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads / helpers
  // -------------------------------------------------------------------------

  private encounterRowOrThrow(encounterId: number): typeof encounters.$inferSelect {
    const row = this.db.select().from(encounters).where(eq(encounters.id, encounterId)).get();
    if (!row) throw new NotFoundException(`Encounter ${encounterId} not found`);
    return row;
  }

  private combatantRowOrThrow(encounterId: number, combatantId: number): typeof combatants.$inferSelect {
    const row = this.db
      .select()
      .from(combatants)
      .where(and(eq(combatants.id, combatantId), eq(combatants.encounterId, encounterId)))
      .get();
    if (!row) throw new NotFoundException(`Combatant ${combatantId} not found in encounter ${encounterId}`);
    return row;
  }

  /** Enforce spec.targets.allow server-side so clients/MCP cannot bypass the UI picker. */
  private assertTargetAllowed(
    allow: ActionTargetAllow,
    actor: typeof combatants.$inferSelect,
    target: typeof combatants.$inferSelect,
    actionName: string,
  ): void {
    if (allow === 'self') {
      if (target.id !== actor.id) {
        throw new BadRequestException(`"${actionName}" may only target the actor.`);
      }
      return;
    }
    if (target.id === actor.id) {
      throw new BadRequestException(`"${actionName}" cannot target the actor.`);
    }
    if (allow === 'enemy' && !this.isEnemyTarget(actor, target)) {
      throw new BadRequestException(`"${actionName}" may only target enemies.`);
    }
    if (allow === 'ally' && !this.isAllyTarget(actor, target)) {
      throw new BadRequestException(`"${actionName}" may only target allies.`);
    }
  }

  private isEnemyTarget(actor: typeof combatants.$inferSelect, target: typeof combatants.$inferSelect): boolean {
    return actor.kind === 'character'
      ? target.kind === 'monster' || target.kind === 'npc'
      : target.kind === 'character';
  }

  private isAllyTarget(actor: typeof combatants.$inferSelect, target: typeof combatants.$inferSelect): boolean {
    return actor.kind === 'character'
      ? target.kind === 'character'
      : target.kind === 'monster' || target.kind === 'npc';
  }

  private adapterForCampaign(campaignId: number): RuleSystemAdapter {
    const c = this.db.select({ ruleSystem: campaigns.ruleSystem }).from(campaigns).where(eq(campaigns.id, campaignId)).get();
    return ruleSystemAdapter(c?.ruleSystem ?? '');
  }

  /**
   * Proficiency bonus for a character under this adapter (issue #1599). The rule decision now
   * lives on the adapter itself — {@link checkProficiencyBonusForAdapter} asks
   * `adapter.checkProficiencyBonus` when the system declared one (5e's own level curve, PF2e's
   * trained-floor rank bonus — see each adapter's declaration in index.ts) and falls back to 0
   * for every adapter that has not (OSR, Open Legend, and any unaudited system), never silent
   * 5e math on a table that isn't 5e. This resolver no longer asks "which system is this"
   * itself for proficiency, matching the shape #1598 established for the attack roll.
   */
  private proficiencyBonus(adapter: RuleSystemAdapter, level: number): number {
    return checkProficiencyBonusForAdapter(adapter, level);
  }

  private isFearPreventingEscalation(row: typeof combatants.$inferSelect): boolean {
    return fromJsonText<string[]>(row.conditions, []).some((c) => c.trim().toLowerCase() === 'fear');
  }

  private linkedCharacter(row: typeof combatants.$inferSelect): typeof characters.$inferSelect | null {
    if (row.characterId === null) return null;
    return this.db.select().from(characters).where(eq(characters.id, row.characterId)).get() ?? null;
  }

  /** The statblock `dataJson` for a monster/NPC combatant with a linked rule entry (else null). */
  private statblockData(row: typeof combatants.$inferSelect): Record<string, unknown> | null {
    if (row.ruleEntryId === null) return null;
    const encounter = this.db.select({ campaignId: encounters.campaignId }).from(encounters).where(eq(encounters.id, row.encounterId)).get();
    const entry = this.db.select({ dataJson: ruleEntries.dataJson }).from(ruleEntries).where(and(eq(ruleEntries.id, row.ruleEntryId), encounter ? or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, encounter.campaignId)) : isNull(ruleEntries.campaignId))).get();
    return entry ? fromJsonText<Record<string, unknown>>(entry.dataJson, {}) : null;
  }

  /**
   * Resolve one authored cost key to the slot that the turn workspace actually accounts for.
   *
   * `max === null` means "not a slot this resolver can bound" — a `cost.slot` key the adapter's
   * own {@link actionEconomyForAdapter} model doesn't declare, and that isn't the legendary slot
   * either. Refusing to invent a cap for an unrecognised key follows the same "refuse rather than
   * guess" rule this resolver already applies elsewhere.
   */
  private resolveActionEconomyCost(actor: typeof combatants.$inferSelect, adapter: RuleSystemAdapter, slot: string): ResolvedActionEconomyCost {
    if (slot === LEGENDARY_ACTION_SLOT) {
      if (this.inlineStatblockHasLegendaryAction(actor)) {
        return { slot: LEGENDARY_ACTION_SLOT, kind: 'legendary', max: LEGENDARY_ACTIONS_PER_ROUND };
      }
      const data = this.statblockData(actor);
      if (!data) return { slot: LEGENDARY_ACTION_SLOT, kind: 'legendary', max: 0 };
      const mapped = adapter.mapStatblock(data);
      return {
        slot: LEGENDARY_ACTION_SLOT,
        kind: 'legendary',
        max: statblockSectionHasEntries(mapped.legendaryActions) ? LEGENDARY_ACTIONS_PER_ROUND : 0,
      };
    }

    const model = actionEconomyForAdapter(adapter);
    const declared =
      model.slots.find((s) => s.key === slot) ??
      // Generated/default structured actions historically say "action"; PF2e's declared pool
      // is keyed "actions", so map the generic default to the adapter's primary action slot.
      (slot === 'action' ? model.slots.find((s) => s.kind === 'action') : undefined);
    return declared ? { slot: declared.key, kind: declared.kind, max: declared.max } : { slot, kind: 'resource', max: null };
  }

  private inlineStatblockHasLegendaryAction(actor: typeof combatants.$inferSelect): boolean {
    const inline = this.inlineStatblock(actor);
    return inline?.actions.some((action) => action.kind?.toLowerCase() === LEGENDARY_ACTION_SLOT || action.spec?.cost.slot === LEGENDARY_ACTION_SLOT) ?? false;
  }

  private turnStateUsageForCost(turnState: CombatantTurnState, cost: ResolvedActionEconomyCost): number {
    return cost.kind === 'movement' ? turnState.movementUsedFt : turnState.used[cost.slot] ?? 0;
  }

  private spendActionEconomyCost(turnState: CombatantTurnState, cost: ResolvedActionEconomyCost, count: number): void {
    if (cost.kind === 'movement') {
      turnState.movementUsedFt += count;
      return;
    }
    turnState.used[cost.slot] = (turnState.used[cost.slot] ?? 0) + count;
  }

  private refundActionEconomyCost(turnState: CombatantTurnState, cost: ResolvedActionEconomyCost, count: number): void {
    if (cost.kind === 'movement') {
      turnState.movementUsedFt = Math.max(0, turnState.movementUsedFt - count);
      return;
    }
    turnState.used[cost.slot] = Math.max(0, (turnState.used[cost.slot] ?? 0) - count);
  }

  /** A target's AC / primary-defence number, or null when unknown (caller must not invent one). */
  private targetDefenseValue(row: typeof combatants.$inferSelect, adapter: RuleSystemAdapter): number | null {
    const character = this.linkedCharacter(row);
    if (character) return character.ac ?? null;
    const data = this.statblockData(row);
    if (data) {
      const mapped = adapter.mapStatblock(data);
      const ac = Number(mapped.armorClass);
      if (Number.isFinite(ac)) return ac;
    }
    return null;
  }

  /** Damage-type defences for a target from its statblock/sheet (best-effort; empty when none). */
  private targetDefenses(
    row: typeof combatants.$inferSelect,
    damageTypes?: readonly string[],
  ): TargetDefenses {
    const data = this.statblockData(row);
    return damageDefensesFromStatblock(data, damageTypes?.length ? damageTypes : undefined);
  }

  /** A target's saving-throw modifier for one ability (character: mod + prof; monster: statblock mod). */
  private targetSaveModifier(row: typeof combatants.$inferSelect, ability: string, adapter: RuleSystemAdapter): number {
    const character = this.linkedCharacter(row);
    if (character) {
      const stats = normalizeStats(fromJsonText<Record<string, number>>(character.stats, {}));
      const score = stats[ability.toUpperCase()] ?? 10;
      const mod = adapter.abilityModifier(score);
      const profs = fromJsonText<string[]>(character.saveProficiencies, []).map((a) => a.toUpperCase());
      return mod + (profs.includes(ability.toUpperCase()) ? this.proficiencyBonus(adapter, character.level) : 0);
    }
    const data = this.statblockData(row);
    if (data) {
      const mapped = adapter.mapStatblock(data);
      const scores = mapped.abilityScores;
      if (scores) {
        const raw = scores[ability.toLowerCase()] ?? scores[ability.toUpperCase()] ?? scores[ability];
        if (typeof raw === 'number') return resolveAbilityModifier(adapter, raw, mapped.abilityRepresentation);
      }
    }
    return 0;
  }

  /** Parse inline homebrew statblock JSON from a combatant row (issue #425). */
  private inlineStatblock(row: typeof combatants.$inferSelect): CombatantStatblock | null {
    if (!row.statblockJson) return null;
    const parsed = CombatantStatblock.safeParse(fromJsonText(row.statblockJson, null));
    return parsed.success ? parsed.data : null;
  }

  /**
   * All structured actions for a combatant: inline statblock first, else expanded
   * compendium statblock actions (issue #425).
   */
  combatantActions(actor: typeof combatants.$inferSelect, campaignId: number): CharacterAction[] {
    const inline = this.inlineStatblock(actor);
    if (inline) return combatantActionsFromStatblock(inline);
    const data = this.statblockData(actor);
    if (!data) return [];
    const adapter = this.adapterForCampaign(campaignId);
    const c = this.db.select({ ruleSystem: campaigns.ruleSystem }).from(campaigns).where(eq(campaigns.id, campaignId)).get();
    return expandStatblockActions(data, adapter, c?.ruleSystem ?? '');
  }

  private actionToUsable(a: CharacterAction, index: number): UsableAction {
    const spec = a.spec ?? null;
    return UsableAction.parse({
      index,
      name: a.name,
      kind: a.kind ?? '',
      mode: spec?.mode ?? 'none',
      toHit: a.toHit ?? '',
      damage: a.damage ?? '',
      notes: a.notes ?? '',
      resolvable: isResolvableSpec(spec),
      spec,
    });
  }

  /** Actor ability stats + level for the modifier/DC math (character or monster statblock). */
  private actorStats(row: typeof combatants.$inferSelect): { stats: Record<string, number>; level: number } {
    const inline = this.inlineStatblock(row);
    if (inline?.abilityScores) {
      return { stats: normalizeStats(inline.abilityScores), level: 1 };
    }
    const data = this.statblockData(row);
    if (data) {
      const encounter = this.db.select({ campaignId: encounters.campaignId }).from(encounters).where(eq(encounters.id, row.encounterId)).get();
      if (encounter) {
        const adapter = this.adapterForCampaign(encounter.campaignId);
        const mapped = adapter.mapStatblock(data);
        if (mapped.abilityScores && typeof mapped.abilityScores === 'object') {
          const scores: Record<string, number> = {};
          for (const [k, v] of Object.entries(mapped.abilityScores)) {
            if (typeof v === 'number') scores[k.toUpperCase()] = v;
          }
          return { stats: normalizeStats(scores), level: 1 };
        }
      }
    }
    const character = this.linkedCharacter(row);
    if (character) {
      return { stats: normalizeStats(fromJsonText<Record<string, number>>(character.stats, {})), level: character.level };
    }
    return { stats: {}, level: 1 };
  }

  private isCharacterOwnedBy(row: typeof combatants.$inferSelect, user: RequestUser): boolean {
    const character = this.linkedCharacter(row);
    return character !== null && character.ownerUserId === user.id;
  }

  /** A player may act only with their owned character while it holds the live combat turn. */
  private assertPlayerActiveTurn(encounter: typeof encounters.$inferSelect, actor: typeof combatants.$inferSelect, role: Role): void {
    if (role === 'dm') return;
    if (encounter.status !== 'running' || encounter.turnPhase !== 'combatant' || encounter.currentCombatantId !== actor.id) {
      throw new ForbiddenException('Players may only resolve or apply actions on their active turn.');
    }
  }

  /** Resolve the structured spec for an action request: inline spec, sheet action, or statblock action. */
  private resolveSpec(
    actor: typeof combatants.$inferSelect,
    req: ActionResolveRequest,
    campaignId: number,
  ): { spec: ActionSpec; name: string; actionIndex: number | null; actionFingerprint: string | null } {
    if (req.spec) {
      const spec = ActionSpec.parse(req.spec);
      if (!isResolvableSpec(spec)) {
        throw new BadRequestException('The inline action spec has no resolvable mode/DC/attack — fall back to a statblock rather than inventing numbers.');
      }
      // Empty string distinguishes an intentionally inline action from a legacy row with no
      // fingerprint. Inline actions have no sheet identity to compare at apply time.
      return { spec, name: req.actionName ?? 'Action', actionIndex: null, actionFingerprint: '' };
    }
    const character = this.linkedCharacter(actor);
    if (character) {
      const actions = fromJsonText<Array<Record<string, unknown>>>(character.actions, []);
      let idx = req.actionIndex ?? -1;
      if (idx < 0 && req.actionName) idx = actions.findIndex((a) => String(a?.name ?? '') === req.actionName);
      if (idx < 0 || idx >= actions.length) {
        throw new NotFoundException(`Action ${req.actionName ?? req.actionIndex} not found on this character.`);
      }
      const raw = actions[idx];
      const name = String(raw?.name ?? 'Action');
      if (req.actionIndex !== undefined && req.actionName && name !== req.actionName) {
        throw new BadRequestException(`Action "${req.actionName}" changed or moved before it could be applied.`);
      }
      const parsed = ActionSpec.safeParse(raw?.spec);
      if (!parsed.success || !isResolvableSpec(parsed.data)) {
        throw new BadRequestException(
          `"${name}" has no resolvable structured spec — fall back to its statblock (toHit/damage/notes) rather than inventing numbers.`,
        );
      }
      return { spec: parsed.data, name, actionIndex: idx, actionFingerprint: actionFingerprint(raw) };
    }
    const statActions = this.combatantActions(actor, campaignId);
    let idx = req.actionIndex ?? -1;
    if (idx < 0 && req.actionName) idx = statActions.findIndex((a) => a.name === req.actionName);
    if (idx < 0 || idx >= statActions.length) {
      if (statActions.length === 0) {
        throw new BadRequestException(
          'This combatant has no sheet actions; pass an inline `spec` to resolve an ad-hoc action.',
        );
      }
      throw new NotFoundException(`Action ${req.actionName ?? req.actionIndex} not found on this combatant.`);
    }
    const action = statActions[idx];
    if (req.actionIndex !== undefined && req.actionName && action.name !== req.actionName) {
      throw new BadRequestException(`Action "${req.actionName}" changed or moved before it could be applied.`);
    }
    const parsed = ActionSpec.safeParse(action.spec);
    if (!parsed.success || !isResolvableSpec(parsed.data)) {
      throw new BadRequestException(
        `"${action.name}" has no resolvable structured spec — fall back to its statblock (toHit/damage/notes) rather than inventing numbers.`,
      );
    }
    return { spec: parsed.data, name: action.name, actionIndex: idx, actionFingerprint: actionFingerprint(action) };
  }

  // -------------------------------------------------------------------------
  // List usable actions
  // -------------------------------------------------------------------------

  /**
   * List a combatant's usable actions (issue #414, #425). Characters use sheet actions;
   * monsters/NPCs use inline statblocks or expanded compendium actions. A player may list
   * only their own character's actions; the DM may list any.
   */
  listUsableActions(encounterId: number, combatantId: number, user: RequestUser, role: Role): UsableAction[] {
    const encounter = this.encounterRowOrThrow(encounterId);
    const combatant = this.combatantRowOrThrow(encounterId, combatantId);
    const isDm = role === 'dm';
    if (!isDm && !this.isCharacterOwnedBy(combatant, user)) {
      throw new ForbiddenException('You may only list actions for your own character.');
    }
    const character = this.linkedCharacter(combatant);
    if (character) {
      const actions = fromJsonText<Array<Record<string, unknown>>>(character.actions, []);
      return actions.map((a, index) => {
        const parsed = ActionSpec.safeParse(a?.spec);
        const spec = parsed.success ? parsed.data : null;
        return UsableAction.parse({
          index,
          name: String(a?.name ?? ''),
          kind: typeof a?.kind === 'string' ? a.kind : '',
          mode: spec?.mode ?? 'none',
          toHit: typeof a?.toHit === 'string' ? a.toHit : '',
          damage: typeof a?.damage === 'string' ? a.damage : '',
          notes: typeof a?.notes === 'string' ? a.notes : '',
          resolvable: isResolvableSpec(spec),
          spec,
        });
      });
    }
    return this.combatantActions(combatant, encounter.campaignId).map((a, index) => this.actionToUsable(a, index));
  }

  // -------------------------------------------------------------------------
  // Resolve (+ optional atomic commit)
  // -------------------------------------------------------------------------

  /** Determine the apply policy + whether THIS caller may commit, from campaign settings + role. */
  private policyFor(campaignId: number, actor: typeof combatants.$inferSelect, user: RequestUser, role: Role): { policy: ActionApplyPolicy; canApply: boolean } {
    if (role === 'dm') return { policy: 'automatic', canApply: true };
    // Issue #1450 defense in depth: this service must be safe regardless of how it is
    // called (REST route or MCP tool) or what upstream gate ran, since both call sites
    // resolve the caller's role from the SAME `requireMember(..., { write: true })`-style
    // helper that a viewer also passes. A viewer owns nothing to act with under normal
    // play, but must never be treated as authorized to apply consequences even if some
    // future caller forgets the role gate.
    if (!roleAtLeast(role, 'player')) {
      throw new ForbiddenException('Viewers may not resolve or apply combat actions.');
    }
    // Non-DM: must own the actor character (enforced by the caller before this point).
    const c = this.db
      .select({ dmControlsTurns: campaigns.dmControlsTurns, requireDmTurnConfirmation: campaigns.requireDmTurnConfirmation })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .get();
    if (c?.requireDmTurnConfirmation) return { policy: 'dm-confirmed', canApply: false };
    if (c?.dmControlsTurns) return { policy: 'player-declares', canApply: false };
    return { policy: 'automatic', canApply: true };
  }

  /**
   * Resolve an action into a full preview, and — when `commit` is set and the caller is
   * authorized under the policy — apply it atomically in the same call. A monster/NPC-actor
   * action is DM-only; a player may act only with their own PC on its active turn.
   */
  resolve(encounterId: number, req: ActionResolveRequest, user: RequestUser, role: Role): ActionResolveResult {
    const encounter = this.encounterRowOrThrow(encounterId);
    const actor = this.combatantRowOrThrow(encounterId, req.actorCombatantId);
    const isDm = role === 'dm';

    // Authorization: monster/NPC actions are DM-only; a player may act only with their own PC.
    if (!isDm) {
      if (actor.kind !== 'character' || !this.isCharacterOwnedBy(actor, user)) {
        throw new ForbiddenException('Only the DM may resolve a monster/NPC action; a player may act only with their own character.');
      }
      this.assertPlayerActiveTurn(encounter, actor, role);
    }

    const adapter = this.adapterForCampaign(encounter.campaignId);
    const { spec, name, actionIndex, actionFingerprint: selectedActionFingerprint } = this.resolveSpec(actor, req, encounter.campaignId);
    const { policy, canApply } = this.policyFor(encounter.campaignId, actor, user, role);

    // Validate target legality (count + at least one when the action needs a target).
    const targetIds = req.targetIds;
    if (spec.targets.count > 0 && targetIds.length === 0) {
      throw new BadRequestException(`"${name}" needs at least one target.`);
    }
    if (spec.targets.count > 0 && targetIds.length > spec.targets.count) {
      throw new BadRequestException(`"${name}" targets at most ${spec.targets.count}, got ${targetIds.length}.`);
    }

    const roll: ActionRollFn = (expr) => {
      const r = rollDice(expr);
      return { total: r.total, rolls: r.rolls };
    };
    const { stats: actorStats, level } = this.actorStats(actor);
    const prof = this.proficiencyBonus(adapter, level);

    const resolvedTargets: ResolvedTarget[] = [];
    for (const tid of targetIds) {
      const target = this.combatantRowOrThrow(encounterId, tid);
      this.assertTargetAllowed(spec.targets.allow, actor, target, name);
      resolvedTargets.push(this.resolveOneTarget(spec, name, adapter as unknown as ResolverAdapter, encounter, actor, actorStats, prof, roll, target));
    }

    const resolution = this.buildResolution(spec, name, actor, resolvedTargets);

    // Issue #1451 (review): bound action_pending_resolutions growth BEFORE inserting another
    // row — every resolve (including a preview the player never applies) would otherwise
    // accumulate a permanent row, since the table used to be pruned only on apply. Sweeping
    // this encounter's stale/excess rows on every resolve call bounds growth to (live
    // encounters) × (TTL window of resolve traffic) rather than "however many times anyone has
    // ever previewed" — see sweepStalePendingResolutions's doc comment for the state-dependent
    // lifetime this now enforces.
    this.sweepStalePendingResolutions(encounter, !canApply, user, role);

    // Mint the chain id HERE, at resolve time, and persist the EXACT resolution the server
    // just computed — regardless of whether this call also commits it. This is the only copy
    // `/actions/apply` will ever read: a later apply takes `{ chainId }` alone, so a
    // client-edited `totalDamage` (or an injected condition/effect never in the action spec)
    // in the request body is simply never consulted.
    //
    // When the campaign policy prevents THIS caller from applying immediately, the only way this
    // resolution is ever consumed is a later, separate DM `apply()` call — a genuine declaration,
    // exempt from the TTL (see the sweep's doc comment). A collaborative AI handoff can turn an
    // initially automatic preview into that same kind of pending human decision; the driver marks
    // that persisted chain with `retainPendingChainForConfirmation()` when it queues the approval.
    const chainId = this.mintChainId();
    this.persistPendingResolution(encounter, actor, chainId, resolution, actionIndex, selectedActionFingerprint, !canApply, encounter.round);

    let applied = false;
    let undoToken: ActionUndoToken | null = null;
    if (req.commit && canApply) {
      // Cheap backstop (issue #1451), even though this resolution is already the server's own
      // roll: bound each target's damage/heal/temp-HP against what this exact dice spec could
      // ever produce, so a future caller of applyInternal (or a bug in this round trip) cannot
      // silently commit a number the spec itself could never have rolled.
      this.assertResolutionWithinSpecBounds(spec, resolution);
      undoToken = this.applyInternal(encounter, resolution, actor, user, role, spec.targets.allow, chainId, encounter.round);
      applied = true;
    }
    return ActionResolveResult.parse({ resolution, applied, canApply, policy, undoToken, chainId });
  }

  /** Resolve a single target: roll attack or the target's save, classify, roll damage, apply defences. */
  private resolveOneTarget(
    spec: ActionSpec,
    actionName: string,
    adapter: ResolverAdapter,
    encounter: typeof encounters.$inferSelect,
    actor: typeof combatants.$inferSelect,
    actorStats: Record<string, number>,
    prof: number,
    roll: ActionRollFn,
    target: typeof combatants.$inferSelect,
  ): ResolvedTarget {
    const base = {
      combatantId: target.id,
      name: target.name,
      attackTotal: null as number | null,
      naturalRoll: null as number | null,
      vsValue: null as number | null,
      escalationDie: 0,
      escalationApplied: false,
      escalationPrevented: false,
      saveTotal: null as number | null,
      saveDc: null as number | null,
      degree: null as ResolvedTarget['degree'],
      damage: [] as ResolvedTarget['damage'],
      totalDamage: 0,
      healing: 0,
      tempHp: 0,
      effects: [] as ResolvedTarget['effects'],
    };

    let outcome: OutcomeKey;
    let critical = false;
    let playerVerb = '';
    let dmDetail = '';

    if (spec.mode === 'attack') {
      const attack = computeAttackModifier(spec, adapter, actorStats, prof);
      let modifier = attack.modifier;
      const escalationDie = adapter.id === ARCHMAGE_ADAPTER_ID ? Math.max(0, Math.min(6, encounter.escalationDie ?? 0)) : 0;
      const escalationPrevented = adapter.id === ARCHMAGE_ADAPTER_ID && actor.kind === 'character' && this.isFearPreventingEscalation(actor);
      const escalationApplied = actor.kind === 'character' && escalationDie > 0 && !escalationPrevented;
      if (escalationApplied) modifier += escalationDie;
      const ac = this.targetDefenseValue(target, adapter as unknown as RuleSystemAdapter);
      if (ac === null) throw new BadRequestException(`Target "${target.name}" has no known AC — resolve manually rather than inventing one.`);
      // #1598 — the roll AND its classification are the adapter's own, not this resolver's:
      // resolveAttackForAdapter asks adapter.resolveAttack when the system declared one (OSR's
      // descending-AC thac0 comparison, Open Legend's exploding dice pool — see each adapter's
      // own resolveAttack for why), and falls back to defaultAttackRoll (today's d20-vs-ascending
      // -AC behaviour, byte-identical) for every adapter that has not. The resolver does not ask
      // "which system is this" itself — see osr-adapter.ts / index.ts's OpenLegendAdapter for
      // where that decision actually lives.
      const attackResult = resolveAttackForAdapter(adapter, { modifier, targetAc: ac, roll });
      const { total, naturalRoll: nat, outcome: resolvedOutcome } = attackResult;
      outcome = resolvedOutcome;
      // #1598: attack crit — see the save/check branch below for the #1600 counterpart.
      critical = outcome === 'crit';
      base.attackTotal = total;
      base.naturalRoll = nat;
      base.vsValue = ac;
      base.escalationDie = escalationDie;
      base.escalationApplied = escalationApplied;
      base.escalationPrevented = escalationPrevented;
      playerVerb = outcome === 'crit' ? 'critically hits' : outcome === 'hit' ? 'hits' : outcome === 'critMiss' ? 'critically misses' : 'misses';
      const parts = [...attack.breakdown.map((b) => `${b.label} ${b.value >= 0 ? '+' : ''}${b.value}`)];
      if (adapter.id === ARCHMAGE_ADAPTER_ID) {
        if (escalationApplied) parts.push(`escalation die +${escalationDie}`);
        else if (escalationPrevented) parts.push(`escalation die +${escalationDie} blocked by Fear`);
        else if (actor.kind !== 'character') parts.push('no escalation die for monsters/NPCs');
      }
      const detail = parts.length ? `; ${parts.join(', ')}` : '';
      // `nat` is null for a system with no single "natural roll" to show as d20-style evidence
      // (Open Legend's exploding pool) — named separately so the byte-identical `(d20 N +M)`
      // phrasing every existing #414 test asserts on is UNCHANGED for every system that has one.
      const targetLabel = attackResult.targetLabel ?? `AC ${ac}`;
      dmDetail =
        nat === null
          ? `attack ${total}${detail} vs ${targetLabel} → ${outcome}`
          : `attack ${total} (d20 ${nat} ${signedModifier(modifier)}${detail}) vs ${targetLabel} → ${outcome}`;
    } else if (spec.mode === 'save' || spec.mode === 'check') {
      const { dc } = computeSaveDc(spec.save.dc, adapter, actorStats, prof);
      if (dc === null) throw new BadRequestException(`"${actionName}" has no resolvable DC — resolve manually rather than inventing one.`);
      const saveMod = this.targetSaveModifier(target, spec.save.ability, adapter as unknown as RuleSystemAdapter);
      const nat = this.rollD20(roll);
      const total = nat + saveMod;
      const { outcome: o, degree } = classifySaveOutcome(adapter, total, nat, dc);
      outcome = o;
      base.saveTotal = total;
      base.saveDc = dc;
      base.naturalRoll = nat;
      base.degree = degree;
      const savedText = degree === 'criticalSuccess' ? 'critically succeeds' : degree === 'success' ? 'succeeds' : degree === 'criticalFailure' ? 'critically fails' : 'fails';
      playerVerb = `${spec.save.ability || 'the'} save ${savedText}`;
      dmDetail = `${spec.save.ability || ''} save ${total} (d20 ${nat} ${signedModifier(saveMod)}) vs DC ${dc} → ${degree}`;
    } else {
      outcome = 'hit'; // mode 'none' shouldn't reach here (isResolvableSpec gates it)
    }

    // Select the outcome branch (with crit → hit / degree fallbacks) and roll its damage.
    const branch = pickOutcomeBranch(spec, outcome);
    // A closed adapter vocabulary lets the shared parser conservatively exclude
    // qualified Open5e display clauses instead of flattening them into unconditional
    // resistance during structured action resolution.
    const defenses = this.targetDefenses(
      target,
      (adapter as unknown as RuleSystemAdapter).damageTypes,
    );
    if (branch) {
      // Save-for-half: a branch flagged halfDamage with NO damage of its own borrows the
      // failure branch's damage at half (the common "save for half" authoring shape).
      const damageBranch = branch.damage.length === 0 && branch.halfDamage ? pickOutcomeBranch(spec, 'failure') ?? branch : branch;
      const half = branch.halfDamage;
      const outcomes = spec.outcomes as Partial<Record<OutcomeKey, OutcomeBranch>>;
      const successBranch = outcomes.success;
      // #1600 — PF2e/SF2e critical failures double damage for basic saves: the selected
      // damage is the fallback failure branch, and ordinary success is "half that damage".
      // Checks and explicit critFailure branches carry their own degree-specific consequences.
      const basicSaveCriticalFailure =
        spec.mode === 'save' &&
        base.degree === 'criticalFailure' &&
        outcomes.critFailure === undefined &&
        outcomes.failure === damageBranch &&
        successBranch?.halfDamage === true &&
        successBranch.damage.length === 0;
      // #1053: the crit rule is the SYSTEM's, not 5e's. `criticalDamageRuleForAdapter` returns
      // 'double-dice' for any adapter that has not declared one, so 5e and every unaudited
      // system keep the behaviour they had; PF2e/SF2e now double the total as their rules say.
      const rolled = rollBranchDamage(damageBranch, roll, { critical: critical || basicSaveCriticalFailure, criticalRule: criticalDamageRuleForAdapter(adapter) });
      for (const part of rolled.parts) {
        const { final, applied } = applyDamageModifiers(part.amount, part.type, defenses, { half });
        base.damage.push({ type: part.type, amount: final, applied });
        base.totalDamage += final;
      }
      if (branch.healing.trim() !== '') base.healing = Math.max(0, roll(branch.healing).total);
      if (branch.tempHp.trim() !== '') base.tempHp = Math.max(0, roll(branch.tempHp).total);
      for (const eff of branch.effects) {
        if (!eff.condition) continue;
        base.effects.push({ condition: eff.condition, rounds: eff.rounds, saveEnds: eff.saveEnds, ongoingDamage: eff.ongoingDamage });
      }
    }

    const conseq: string[] = [];
    if (base.totalDamage > 0) conseq.push(`${base.totalDamage} damage`);
    if (base.healing > 0) conseq.push(`heals ${base.healing}`);
    if (base.tempHp > 0) conseq.push(`${base.tempHp} temp HP`);
    if (base.effects.length > 0) conseq.push(base.effects.map((e) => e.condition).join(', '));
    const playerText = `${playerVerb}${conseq.length ? ` — ${conseq.join(', ')}` : ''}`.trim();
    const resistNote = base.damage
      .filter((d) => d.applied !== 'normal' && d.applied !== 'halved')
      .map((d) => `${d.type} ${d.applied}`)
      .join(', ');
    const dmText = `${dmDetail}${conseq.length ? `; ${conseq.join(', ')}` : ''}${resistNote ? ` [${resistNote}]` : ''}`;

    return ResolvedTarget.parse({ ...base, outcome, playerText, dmText });
  }

  private rollD20(roll: ActionRollFn): number {
    const r = roll('1d20');
    return r.rolls[0] ?? r.total;
  }

  private buildResolution(spec: ActionSpec, name: string, actor: typeof combatants.$inferSelect, targets: ResolvedTarget[]): ActionResolution {
    const playerLines = targets.map((t) => `${t.name}: ${t.playerText}`);
    const dmLines = targets.map((t) => `${t.name}: ${t.dmText}`);
    return ActionResolution.parse({
      actorCombatantId: actor.id,
      actorName: actor.name,
      actionName: name,
      mode: spec.mode,
      playerSummary: `${actor.name} uses ${name}. ${playerLines.join(' | ')}`.trim(),
      dmSummary: `${actor.name} · ${name} — ${dmLines.join(' | ')}`.trim(),
      targets,
      costSlot: spec.cost.slot,
      costCount: spec.cost.count,
      usesSpent: spec.uses.max > 0 ? 1 : 0,
      spellLevelSpent: spec.uses.spellLevel,
      startsConcentration: spec.uses.concentration,
    });
  }

  /** Issue #426: attribute the human/token actor who committed an action chain. */
  private performedByFrom(user: RequestUser, role: Role): EncounterEventPerformedBy {
    const userId = user.tokenContext ? `token:${user.tokenContext.name}` : user.id;
    const kind = user.id.startsWith('ai-dm') ? 'ai' : 'human';
    return { userId, role, kind };
  }

  private targetMetadata(t: ResolvedTarget): EncounterEventMetadata {
    const damageSummary =
      t.damage.length > 0
        ? t.damage.map((d) => `${d.amount} ${d.type || 'untyped'}${d.applied !== 'normal' ? ` (${d.applied})` : ''}`).join(', ')
        : undefined;
    return {
      outcome: t.outcome,
      naturalRoll: t.naturalRoll,
      attackTotal: t.attackTotal,
      escalationDie: t.escalationDie || undefined,
      escalationApplied: t.escalationApplied || undefined,
      escalationPrevented: t.escalationPrevented || undefined,
      saveTotal: t.saveTotal,
      vsValue: t.vsValue,
      saveDc: t.saveDc,
      degree: t.degree ?? undefined,
      damageSummary,
      playerText: t.playerText || undefined,
      dmText: t.dmText || undefined,
    };
  }

  private rulingDetail(t: ResolvedTarget): string {
    if (t.playerText.trim()) return t.playerText.trim();
    if (t.outcome === 'miss') return 'missed';
    if (t.outcome === 'crit') return 'critical hit';
    if (t.outcome === 'hit') return 'hit';
    if (t.outcome === 'success') return 'saved';
    if (t.outcome === 'failure') return 'failed save';
    return t.outcome;
  }

  /** Persist a correlated action chain (issue #426). parentIndex references prior insert positions. */
  private persistActionChain(
    encounter: typeof encounters.$inferSelect,
    round: number,
    actor: typeof combatants.$inferSelect,
    chainId: string,
    performedBy: EncounterEventPerformedBy,
    ruleSystem: string,
    resolution: ActionResolution,
    consequenceLogs: Array<{
      type: 'damage' | 'heal' | 'condition' | 'death' | 'effect' | 'note' | 'resource_changed';
      target?: string;
      targetId?: number;
      detail: string;
    }>,
  ): void {
    type ChainEntry = {
      type: 'damage' | 'heal' | 'condition' | 'death' | 'effect' | 'note' | 'resource_changed' | 'roll';
      phase: EncounterEventPhase;
      target?: string;
      targetId?: number;
      detail: string;
      metadata?: EncounterEventMetadata;
      parentIndex?: number;
    };

    const entries: ChainEntry[] = [
      {
        type: 'note',
        phase: 'declare',
        detail: `used ${resolution.actionName}`,
        metadata: {
          actionName: resolution.actionName,
          mode: resolution.mode,
          playerText: resolution.playerSummary || undefined,
          dmText: resolution.dmSummary || undefined,
          ruleSystem,
        },
      },
    ];

    for (const t of resolution.targets) {
      const rulingIndex = entries.length;
      entries.push({
        type: 'roll',
        phase: 'ruling',
        target: t.name,
        targetId: t.combatantId,
        detail: this.rulingDetail(t),
        parentIndex: 0,
        metadata: { actionName: resolution.actionName, mode: resolution.mode, ruleSystem, ...this.targetMetadata(t) },
      });
      for (const l of consequenceLogs) {
        if (l.targetId !== t.combatantId) continue;
        entries.push({
          type: l.type,
          phase: 'consequence',
          target: l.target,
          targetId: l.targetId,
          detail: l.detail,
          parentIndex: rulingIndex,
          metadata: { actionName: resolution.actionName, mode: resolution.mode },
        });
      }
    }

    if (resolution.costSlot && resolution.costCount > 0) {
      entries.push({
        type: 'resource_changed',
        phase: 'resource',
        detail: `spent ${resolution.costCount} ${resolution.costSlot}`,
        parentIndex: 0,
        metadata: { actionName: resolution.actionName, costSlot: resolution.costSlot, costCount: resolution.costCount, ruleSystem },
      });
    }
    if (resolution.spellLevelSpent > 0) {
      entries.push({
        type: 'resource_changed',
        phase: 'resource',
        detail: `spent level-${resolution.spellLevelSpent} spell slot`,
        parentIndex: 0,
        metadata: { actionName: resolution.actionName, spellLevelSpent: resolution.spellLevelSpent, ruleSystem },
      });
    }

    const insertedIds: number[] = [];
    for (const entry of entries) {
      const parentEventId = entry.parentIndex != null ? (insertedIds[entry.parentIndex] ?? null) : null;
      const row = this.db
        .insert(encounterEvents)
        .values({
          encounterId: encounter.id,
          round,
          type: entry.type,
          actor: actor.name,
          actorId: actor.id,
          target: entry.target ?? null,
          targetId: entry.targetId ?? null,
          detail: entry.detail,
          chainId,
          parentEventId,
          phase: entry.phase,
          performedByJson: JSON.stringify(performedBy),
          metadataJson: entry.metadata && Object.keys(entry.metadata).length > 0 ? JSON.stringify(entry.metadata) : null,
          createdAt: nowIso(),
        })
        .returning()
        .get();
      insertedIds.push(row.id);
    }
  }

  // -------------------------------------------------------------------------
  // Apply (atomic) + undo
  // -------------------------------------------------------------------------

  /**
   * Mint a chain id — the correlation key shared by the pending-resolution row, the apply-chain
   * undo snapshot, and the combat-log entries for one resolve/apply (issues #414, #426, #1449).
   *
   * Issue #1451 review: this is a LOOKUP KEY, not a credential — `apply()` re-authorizes the
   * caller against the chain's stored actor/encounter on every call regardless of who supplies
   * a (real or guessed) chainId, so guessability does not bypass authorization. `randomUUID()`
   * is used anyway as cheap insurance over the previous `Math.random()` suffix.
   */
  private mintChainId(): string {
    return `chain-${randomUUID()}`;
  }

  /** Issue #1451 (review): bound how long an unconsumed preview lives, and how many any one
   *  encounter can accumulate — see {@link sweepStalePendingResolutions}. */
  private static readonly PENDING_RESOLUTION_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly MAX_PENDING_RESOLUTIONS_PER_ENCOUNTER = 200;

  /**
   * Issue #1451 (review — Devin + Codex P1, then corrected against Devin's follow-up): every
   * resolve used to insert a permanent row that was only ever marked consumed, never deleted or
   * expired — a player who repeatedly previews (and never applies) could grow
   * `action_pending_resolutions` without bound, a real problem for a product whose whole design
   * is one SQLite volume. The first fix bounded EVERY row by age + count uniformly — but that
   * broke the dm-confirmed/player-declares workflow: a player's legitimate declaration, sitting
   * in the table awaiting a DM's `apply()`, is indistinguishable by shape from an abandoned
   * preview, and a DM can legitimately take longer than any fixed TTL to get to their queue. A
   * declaration silently evaporating out from under a player is a worse failure than the disk
   * growth this exists to bound.
   *
   * INVARIANT CHOSEN (state this in review — see the PR body): lifetime now depends on STATE,
   * not just age.
   *  - `awaitingConfirmation = false` (an ordinary preview under automatic policy, disposable and
   *    free to re-derive): TTL-eligible, AND silently evicted by the per-encounter cap — matches
   *    the original fix's reasoning, since re-previewing costs nothing.
   *  - `awaitingConfirmation = true` (a declaration only a LATER, different caller's `apply()`
   *    can ever consume): EXEMPT from the TTL entirely — no age-based expiry, ever. It is still
   *    subject to the SAME per-encounter cap (an unbounded declaration queue reopens the exact
   *    growth vector this whole fix exists to close), but evicting one is AUDITED and never
   *    silent (`encounter.action.declaration_evicted`), mirroring the established, already-loud
   *    pattern `AiDriverService.announceEvictedConfirmation` (#1558) uses for the AI driver's own
   *    confirmation queue eviction.
   *
   * A CONSUMED resolution does not rely on either of these — `applyInternal` deletes its row
   * immediately (see the transaction there), so this sweep only ever has abandoned previews and
   * pending declarations left to reclaim.
   */
  private sweepStalePendingResolutions(
    encounter: typeof encounters.$inferSelect,
    incomingAwaitingConfirmation: boolean,
    user: RequestUser,
    role: Role,
  ): void {
    const cutoff = new Date(Date.now() - ActionResolverService.PENDING_RESOLUTION_TTL_MS).toISOString();
    // TTL: ONLY ordinary previews expire by age. A declaration awaiting DM confirmation must
    // survive indefinitely by age alone.
    this.db
      .delete(actionPendingResolutions)
      .where(
        and(
          eq(actionPendingResolutions.encounterId, encounter.id),
          lt(actionPendingResolutions.createdAt, cutoff),
          eq(actionPendingResolutions.awaitingConfirmation, false),
        ),
      )
      .run();

    this.capPendingResolutions(encounter, false, incomingAwaitingConfirmation === false, user, role);
    this.capPendingResolutions(encounter, true, incomingAwaitingConfirmation === true, user, role);
  }

  /**
   * Evict the oldest rows in one (encounter, awaitingConfirmation) partition past the cap.
   * Reserve a slot only for the partition the imminent insert will join; a full other
   * partition is valid and must remain untouched.
   */
  private capPendingResolutions(
    encounter: typeof encounters.$inferSelect,
    awaitingConfirmation: boolean,
    reserveSlotForIncoming: boolean,
    user: RequestUser,
    role: Role,
  ): void {
    const rows = this.db
      .select({
        id: actionPendingResolutions.id,
        actionName: actionPendingResolutions.actionName,
        actorCombatantId: actionPendingResolutions.actorCombatantId,
      })
      .from(actionPendingResolutions)
      .where(
        and(
          eq(actionPendingResolutions.encounterId, encounter.id),
          eq(actionPendingResolutions.awaitingConfirmation, awaitingConfirmation),
        ),
      )
      .orderBy(desc(actionPendingResolutions.createdAt))
      .all();
    const maximumExistingRows = ActionResolverService.MAX_PENDING_RESOLUTIONS_PER_ENCOUNTER - (reserveSlotForIncoming ? 1 : 0);
    if (rows.length <= maximumExistingRows) return;
    const evicted = rows.slice(maximumExistingRows);
    if (evicted.length === 0) return;
    this.db
      .delete(actionPendingResolutions)
      .where(inArray(actionPendingResolutions.id, evicted.map((r) => r.id)))
      .run();
    if (!awaitingConfirmation) return; // an ordinary preview is cheap to re-derive — no audit needed.
    // A DECLARATION never disappears in silence (issue #1451 review) — same treatment #1558
    // gives the AI driver's own confirmation-queue eviction.
    for (const row of evicted) {
      void this.audit
        .log({
          actor: auditActor(user),
          actorRole: role,
          action: 'encounter.action.declaration_evicted',
          entityType: 'encounter',
          entityId: encounter.id,
          campaignId: encounter.campaignId,
          detail: JSON.stringify({
            chainId: row.id,
            actionName: row.actionName,
            actorCombatantId: row.actorCombatantId,
            reason: `encounter reached its ${ActionResolverService.MAX_PENDING_RESOLUTIONS_PER_ENCOUNTER}-declaration cap — never applied`,
          }),
        })
        .catch(() => undefined);
    }
    if (!encounter.hidden) this.events.emit({ type: 'encounter.updated', campaignId: encounter.campaignId, encounterId: encounter.id });
  }

  /**
   * Issue #1451: persist the exact resolution `resolve()` just computed, keyed by `chainId`.
   * This is the ONLY copy `apply()` will ever read back — the request body `/actions/apply`
   * receives later carries nothing but the chain id, so a client cannot smuggle a different
   * `totalDamage`, an injected condition, or an unresolved effect payload into the apply step.
   * Not keyed on `targetsAllow` (unlike `action_apply_chains`): `apply()` re-validates targeting
   * against the CURRENT spec, never a resolve-time snapshot — see `apply()`'s doc comment.
   */
  private persistPendingResolution(
    encounter: typeof encounters.$inferSelect,
    actor: typeof combatants.$inferSelect,
    chainId: string,
    resolution: ActionResolution,
    actionIndex: number | null,
    actionFingerprint: string | null,
    awaitingConfirmation: boolean,
    turnRound: number,
  ): void {
    this.db
      .insert(actionPendingResolutions)
      .values({
        id: chainId,
        encounterId: encounter.id,
        campaignId: encounter.campaignId,
        actorCombatantId: actor.id,
        actionName: resolution.actionName,
        actionIndex,
        actionFingerprint,
        awaitingConfirmation,
        turnRound,
        resolutionJson: toJsonText(resolution),
        createdAt: nowIso(),
      })
      .run();
  }

  /**
   * Issue #1451: a cheap, deliberately PERMISSIVE upper bound on what a dice expression could
   * ever total, used only to catch a resolution wildly outside anything the action's spec could
   * legitimately roll. Ignores keep/drop reduction and negative modifiers (both only ever LOWER
   * a real roll) so a legitimate result can never trip it — this is a backstop, not a re-derivation.
   *
   * Issue #1451 review (Kilo): a formula this backstop cannot parse returns `Infinity` — NO
   * bound from this term — rather than 0. This is a backstop, not the primary control (the
   * primary control is that `apply()` only ever writes the server's own persisted resolution),
   * so it must fail OPEN on an internal parsing surprise, not silently reject every legitimate
   * damage/heal number for a branch it merely failed to parse.
   */
  private maxDiceExprTotal(expr: string): number {
    if (!expr || !expr.trim()) return 0;
    let terms: ReturnType<typeof parseCompoundDiceExpr>;
    try {
      terms = parseCompoundDiceExpr(expr);
    } catch {
      return Infinity;
    }
    let max = 0;
    for (const t of terms) {
      max += t.kind === 'die' ? t.count * t.sides : Math.max(0, t.value);
    }
    return max;
  }

  /**
   * The maximum damage ONE target's branch could ever take (issue #1451): each part's dice+flat
   * ceiling, times 4 to cover the worst realistic stack of multipliers this resolver can apply —
   * a critical hit doubling the total (the larger of the two supported crit rules,
   * {@link CriticalDamageRule}) AND a vulnerability doubling it again on top. Generous on
   * purpose; it exists to catch an order-of-magnitude-inflated number, not to re-derive the roll.
   */
  private maxBranchDamage(branch: OutcomeBranch): number {
    const partsMax = branch.damage.reduce((sum, p) => sum + this.maxDiceExprTotal(p.formula) + Math.max(0, p.flat), 0);
    return partsMax * 4;
  }

  /** The widest damage/heal/temp-HP bound across every outcome branch this spec declares. */
  private specDamageBounds(spec: ActionSpec): { maxDamage: number; maxHealing: number; maxTempHp: number } {
    let maxDamage = 0;
    let maxHealing = 0;
    let maxTempHp = 0;
    for (const branch of Object.values(spec.outcomes)) {
      if (!branch) continue;
      maxDamage = Math.max(maxDamage, this.maxBranchDamage(branch));
      maxHealing = Math.max(maxHealing, this.maxDiceExprTotal(branch.healing));
      maxTempHp = Math.max(maxTempHp, this.maxDiceExprTotal(branch.tempHp));
    }
    return { maxDamage, maxHealing, maxTempHp };
  }

  /**
   * Issue #1451 cheap backstop: bound every target's damage/healing/temp-HP against what this
   * action's OWN dice spec could ever roll, on BOTH the player and the DM path — even though
   * (after this fix) the resolution being applied is always the server's own, never a
   * client-echoed one. Defense in depth against a bug in that round trip, not the primary gate.
   */
  private assertResolutionWithinSpecBounds(spec: ActionSpec, resolution: ActionResolution): void {
    const { maxDamage, maxHealing, maxTempHp } = this.specDamageBounds(spec);
    for (const t of resolution.targets) {
      if (t.totalDamage > maxDamage) {
        throw new BadRequestException(
          `"${resolution.actionName}" cannot deal ${t.totalDamage} damage — its dice spec bounds a single target's damage at ${maxDamage}.`,
        );
      }
      if (t.healing > maxHealing) {
        throw new BadRequestException(
          `"${resolution.actionName}" cannot heal ${t.healing} — its dice spec bounds healing at ${maxHealing}.`,
        );
      }
      if (t.tempHp > maxTempHp) {
        throw new BadRequestException(
          `"${resolution.actionName}" cannot grant ${t.tempHp} temp HP — its dice spec bounds it at ${maxTempHp}.`,
        );
      }
    }
  }

  /** Audit a rejected apply attempt (issue #1451) — mirrors auditRejectedUndo (issue #1449). */
  private auditRejectedApply(
    encounter: typeof encounters.$inferSelect,
    chainId: string,
    user: RequestUser,
    role: Role,
    reason: string,
  ): void {
    void this.audit
      .log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.action.apply_rejected',
        entityType: 'encounter',
        entityId: encounter.id,
        campaignId: encounter.campaignId,
        detail: JSON.stringify({ reason, chainId }),
      })
      .catch(() => undefined);
  }

  /**
   * Transition an otherwise-disposable preview into a pending human decision when the AI driver
   * queues `apply_action` for collaborative confirmation. This is deliberately a transition on
   * the persisted chain, rather than a guess based on the AI seat's `canApply`: collaborative
   * handoff defers the write even when that seat has automatic-policy authority. Returns the
   * server-derived `actionName`/`actorCombatantId` used by the confirmation prompt, never any
   * caller-provided display fields. Returns null for an unknown or cross-encounter chain. This
   * cannot authorize or determine WHAT gets applied: `apply()` exclusively re-reads this same
   * row for that purpose.
   */
  retainPendingChainForConfirmation(
    encounterId: number,
    chainId: string,
    user: RequestUser,
    role: Role,
  ): { actionName: string; actorCombatantId: number; promoted: boolean } | null {
    const pending = this.db
      .select({
        encounterId: actionPendingResolutions.encounterId,
        actionName: actionPendingResolutions.actionName,
        actorCombatantId: actionPendingResolutions.actorCombatantId,
        awaitingConfirmation: actionPendingResolutions.awaitingConfirmation,
      })
      .from(actionPendingResolutions)
      .where(eq(actionPendingResolutions.id, chainId))
      .get();
    if (!pending || pending.encounterId !== encounterId) return null;

    // A collaborative confirmation promotes an existing disposable preview into the declaration
    // partition. That is an incoming declaration just as much as resolve() creating one is, so
    // reserve capacity before the transition rather than letting confirmations grow past the cap.
    if (!pending.awaitingConfirmation) {
      this.capPendingResolutions(this.encounterRowOrThrow(encounterId), true, true, user, role);
    }
    this.db
      .update(actionPendingResolutions)
      .set({ awaitingConfirmation: true })
      .where(and(eq(actionPendingResolutions.id, chainId), eq(actionPendingResolutions.encounterId, encounterId)))
      .run();
    return {
      actionName: pending.actionName,
      actorCombatantId: pending.actorCombatantId,
      // Only the transition made for this confirmation is reversible when the confirmation
      // disappears. A player declaration already awaiting a DM must remain retained.
      promoted: !pending.awaitingConfirmation,
    };
  }

  /** Release the temporary TTL exemption created for a collaborative AI confirmation. */
  releasePendingChainForConfirmation(encounterId: number, chainId: string): void {
    this.db
      .update(actionPendingResolutions)
      .set({ awaitingConfirmation: false })
      .where(and(eq(actionPendingResolutions.id, chainId), eq(actionPendingResolutions.encounterId, encounterId)))
      .run();
  }

  /**
   * Apply a previously resolved action chain (issue #414 confirm path). `chainId` is a LOOKUP
   * KEY, not a source of truth (issue #1451): the resolution applied is always the exact one
   * `resolve()` computed and persisted server-side (`action_pending_resolutions`), never
   * anything the request body carries. Before this fix, `apply()` took the full
   * `ActionResolution` from the client and wrote its `totalDamage`/`healing`/`effects` verbatim
   * — trusting the applier was "safe" because a DM can already set arbitrary HP, which is false
   * for the player who can also reach this route under an automatic policy. Now a player cannot
   * inflate damage, alter a per-target delta, or inject a condition/effect never in the resolved
   * spec: none of that is read from anywhere the caller can influence. The applier must still be
   * the DM, or the actor's owning player under an automatic policy.
   *
   * `req` carries `chainId` ONLY (issue #1451 review, second pass) — an earlier revision also
   * accepted optional caller-supplied `actionName`/`actorCombatantId` for a DM confirmation
   * prompt under collaborative handoff (#1051), but that let a caller label a damaging chain
   * with a harmless-looking action/actor and obtain approval under a false summary; the
   * confirmation now derives its label server-side instead — see
   * {@link ActionResolverService.retainPendingChainForConfirmation}.
   *
   * Issue #1451 review: the actual single-use claim happens inside `applyInternal`'s
   * transaction (a conditional delete, mirroring `undo()`'s `action_apply_chains.undone_at`
   * guard from #1449) — a concurrent second apply for this chainId either loses the lookup
   * below (already deleted) or loses that transactional claim, never both writing state.
   */
  apply(encounterId: number, req: ActionApplyRequest, user: RequestUser, role: Role): { undoToken: ActionUndoToken } {
    const encounter = this.encounterRowOrThrow(encounterId);
    // #599: applying a resolution writes damage, conditions, and death saves to the board. That
    // is play advancing, and it is precisely what someone raising an X-Card mid-swing is asking
    // to stop. `resolve` (the preview) stays open — computing a number nobody has committed is
    // harmless, and blocking it would only hide from the table what was about to happen.
    this.safety?.assertNotHeld(encounter.campaignId);

    const pending = this.db.select().from(actionPendingResolutions).where(eq(actionPendingResolutions.id, req.chainId)).get();
    if (!pending) {
      // Unknown AND already-consumed collapse to the same outcome (issue #1451 review): a
      // consumed resolution's row is deleted, not flagged, so there is nothing left to
      // distinguish "never existed" from "already applied" — both are equally not appliable.
      this.auditRejectedApply(encounter, req.chainId, user, role, 'unknown_or_consumed_chain');
      throw new BadRequestException('This resolution is unknown or has already been applied.');
    }
    if (pending.encounterId !== encounterId) {
      this.auditRejectedApply(encounter, req.chainId, user, role, 'cross_encounter_chain');
      throw new BadRequestException('This chain belongs to a different encounter.');
    }

    const resolution = ActionResolution.parse(fromJsonText<unknown>(pending.resolutionJson, {}));
    const actor = this.combatantRowOrThrow(encounterId, pending.actorCombatantId);
    const isDm = role === 'dm';
    if (!isDm) {
      if (actor.kind !== 'character' || !this.isCharacterOwnedBy(actor, user)) {
        this.auditRejectedApply(encounter, req.chainId, user, role, 'not_actor_owner');
        throw new ForbiddenException('Only the DM may apply a monster/NPC action.');
      }
      this.assertPlayerActiveTurn(encounter, actor, role);
      const { canApply } = this.policyFor(encounter.campaignId, actor, user, role);
      if (!canApply) {
        this.auditRejectedApply(encounter, req.chainId, user, role, 'policy_forbids');
        throw new ForbiddenException('This campaign requires the DM to apply action consequences.');
      }
    }
    if (pending.actionFingerprint === null) {
      this.auditRejectedApply(encounter, req.chainId, user, role, 'legacy_action_without_fingerprint');
      throw new BadRequestException('This resolution was created before action identity verification; resolve the action again.');
    }

    // Issue #1451 review (Codex): validate against the CURRENT spec's targeting rule AND target
    // count, never a resolve-time snapshot — an action edited between preview and apply (e.g.
    // restricted to `self`, or to fewer targets) must not still apply its OLD, wider targeting.
    // This mirrors exactly what the pre-#1451 `apply()` already did; `action_pending_resolutions`
    // does not persist `targetsAllow` at all (unlike `action_apply_chains`, which UNDO
    // deliberately snapshots — undo restores a thing that already happened under the old rule).
    const { spec, actionFingerprint: currentActionFingerprint } = this.resolveSpec(actor, {
      actorCombatantId: pending.actorCombatantId,
      actionName: pending.actionName,
      // `actionName` is not unique on character sheets. Persisting the selected index keeps
      // this current-spec validation paired with the exact action previewed by resolve().
      ...(pending.actionIndex !== null ? { actionIndex: pending.actionIndex } : {}),
      targetIds: [],
      commit: false,
    }, encounter.campaignId);
    if (spec.targets.count > 0 && resolution.targets.length > spec.targets.count) {
      this.auditRejectedApply(encounter, req.chainId, user, role, 'target_count_narrowed');
      throw new BadRequestException(
        `"${resolution.actionName}" now targets at most ${spec.targets.count}, but this resolution has ${resolution.targets.length}.`,
      );
    }
    for (const t of resolution.targets) {
      const target = this.combatantRowOrThrow(encounterId, t.combatantId);
      this.assertTargetAllowed(spec.targets.allow, actor, target, resolution.actionName);
    }
    this.assertResolutionWithinSpecBounds(spec, resolution);
    if (pending.actionIndex !== null && currentActionFingerprint !== pending.actionFingerprint) {
      this.auditRejectedApply(encounter, req.chainId, user, role, 'action_changed_or_moved');
      throw new BadRequestException(`Action "${pending.actionName}" changed or moved before it could be applied.`);
    }

    const undoToken = this.applyInternal(encounter, resolution, actor, user, role, spec.targets.allow, pending.id, pending.turnRound);
    return { undoToken };
  }

  /** The atomic core: write every target's consequences + the actor's costs in ONE transaction. */
  private applyInternal(
    encounter: typeof encounters.$inferSelect,
    resolution: ActionResolution,
    actor: typeof combatants.$inferSelect,
    user: RequestUser,
    role: Role,
    /**
     * Issue #1449: the spec's target-allow rule at apply time, persisted alongside the chain
     * snapshot so `undo()` can re-run `assertTargetAllowed` without having to re-resolve the
     * action (which may no longer exist on the sheet by the time undo runs).
     */
    targetsAllow: ActionTargetAllow,
    /**
     * Issue #1451: the SAME chain id `resolve()` minted for this resolution's
     * `action_pending_resolutions` row — reused here (rather than minting a fresh one) so one
     * id correlates the pending resolution, the apply-chain undo snapshot, and the combat-log
     * entries for a single resolve/apply. Claimed (marked consumed) inside this transaction.
     */
    chainId: string,
    /** The resolve-time round stored with the opaque pending chain, never client input. */
    turnRound: number,
  ): ActionUndoToken {
    const performedBy = this.performedByFrom(user, role);
    const adapter = this.adapterForCampaign(encounter.campaignId);
    const ruleSystem = adapter.id;
    const undoTargets: ActionUndoToken['targets'] = [];
    let concentrationBefore: string | null = null;
    let pendingConcentrationChecksBefore: PendingConcentrationCheck[] = [];
    const consequenceLogs: Array<{ type: 'damage' | 'heal' | 'condition' | 'death' | 'effect' | 'note' | 'resource_changed'; target?: string; targetId?: number; detail: string }> = [];
    let committedEncounter = encounter;

    this.db.transaction((tx) => {
      // Issue #1451 review (Kilo, MUST FIX): claim the pending resolution FIRST, atomically,
      // inside this transaction — not via a pre-transaction `SELECT` + `consumedAt` flag, which
      // is a TOCTOU: two concurrent `apply()` calls for the same chainId could both observe an
      // unconsumed row before either transaction committed, and both go on to write damage.
      // Deleting the row IS the claim (there is no separate `consumedAt` column to race on): a
      // concurrent second apply either already lost the pre-transaction lookup in `apply()`
      // (row gone) or loses THIS delete (0 rows affected) and rolls back before touching any
      // combatant state — mirrors `undo()`'s `action_apply_chains.undone_at` conditional-update
      // guard (#1449) exactly, just via delete instead of a flag (issue #1451's growth-bound
      // fix also wants the row gone once consumed, not kept forever).
      const claimed = tx.delete(actionPendingResolutions).where(eq(actionPendingResolutions.id, chainId)).run();
      if (claimed.changes === 0) {
        throw new BadRequestException('This resolution is unknown or has already been applied.');
      }

      // The outer authorize check improves feedback for previews, but cannot authorize a
      // write: another request can advance the encounter between that check and this
      // transaction. Re-read the turn inside the transaction before any consequence or
      // resource mutation so a stale player action is atomically rejected.
      const liveEncounter = tx.select().from(encounters).where(eq(encounters.id, encounter.id)).get();
      if (!liveEncounter) throw new NotFoundException(`Encounter ${encounter.id} not found.`);
      if (role !== 'dm' && turnRound !== liveEncounter.round) throw new ForbiddenException('Action preview is from a previous turn.');
      this.assertPlayerActiveTurn(liveEncounter, actor, role);
      committedEncounter = liveEncounter;

      // #1571 — VALIDATE THE SPELL SLOT SPEND FIRST, before any target consequence (damage,
      // saves, conditions) is written. `patchSpellSlots` (the standalone spend path, #1039)
      // fails loudly on overspend instead of silently clamping; this used to be a second,
      // looser copy of that rule — `Math.min(slot.max, used + 1)` — which let a caster at
      // `used === max` "cast" for free, with nothing reporting the slot was never paid for.
      // Routing through the same `applySpellSlotDelta` this transaction now calls means a
      // future change to the overspend policy cannot land on one path and miss the other.
      //
      // Deciding this validates HERE, ahead of the target loop below, rather than deducting
      // at the bottom and unwinding on failure: unwinding already-written HP/condition/death
      // state is the more fragile design, and it leaves a partial-application window between
      // "damage landed" and "the cast turned out to be unpayable". Failing before any of that
      // is written keeps the transaction simple and gives the caller (frequently the AI
      // Driver) a clean retry — nothing here to undo.
      let spellSlotSpend: { characterId: number; slots: SpellSlotMap } | null = null;
      if (resolution.spellLevelSpent > 0 && actor.characterId !== null) {
        const character = tx.select().from(characters).where(eq(characters.id, actor.characterId)).get();
        if (character) {
          const slots = fromJsonText<SpellSlotMap>(character.spellSlots, {});
          const outcome = applySpellSlotDelta(slots, resolution.spellLevelSpent, 1);
          if (!outcome.ok) {
            // Same shape `patchSpellSlots` throws (#1570): `code`/`message` plus `remaining`
            // and `max` so the caller — an AI Driver as often as a human — can self-correct
            // (cast at a different level, or take a rest) instead of retrying blind.
            throw new BadRequestException({
              code: outcome.reason,
              message: outcome.message,
              level: outcome.level,
              remaining: outcome.remaining,
              max: outcome.max,
            });
          }
          spellSlotSpend = { characterId: actor.characterId, slots: outcome.slots };
        }
      }

      // Snapshot concentration BEFORE any target consequences. The actor can target itself,
      // and target processing may enqueue a check for this very action; that generated check
      // is not part of the pre-apply state an undo must restore.
      const actorBeforeTargets = tx
        .select({ turnState: combatants.turnState })
        .from(combatants)
        .where(eq(combatants.id, actor.id))
        .limit(1)
        .get();
      if (actorBeforeTargets) {
        const actorTurnStateBefore = CombatantTurnState.parse(
          fromJsonText<unknown>(actorBeforeTargets.turnState, null) ?? {},
        );
        // #1637 — VALIDATE THE ACTION-ECONOMY SPEND FIRST too, same convention as the spell-slot
        // check above and for the same reason: before any target consequence is written, not
        // late-and-unwind. Worse than #1571's bug (a silent CLAMP that at least kept the stored
        // value legal): this had NO check at all — `turnState.used[costSlot]` just grew past the
        // slot's max forever, so an actor could "spend" an action/bonus/reaction it did not have,
        // repeatedly, and the sheet recorded a value out of range rather than a rejected spend.
        if (resolution.costSlot && resolution.costCount > 0) {
          const actionEconomyCost = this.resolveActionEconomyCost(actor, adapter, resolution.costSlot);
          const usedBefore = this.turnStateUsageForCost(actorTurnStateBefore, actionEconomyCost);
          const max = actionEconomyCost.max;
          // `max === null`: an unrecognised slot key — see resolveActionEconomyCost's doc comment
          // for why that is deliberately NOT bounded rather than guessed at.
          if (max !== null && usedBefore + resolution.costCount > max) {
            const remaining = Math.max(0, max - usedBefore);
            // Same shape #1570/#1571 introduced for spell slots (`code`/`message` plus
            // `remaining`/`max`) so the caller — an AI Driver as often as a human — can
            // self-correct (a different action, or a new turn) instead of retrying blind.
            throw new BadRequestException({
              code: 'action_economy_exhausted',
              message:
                `"${resolution.actionName}" costs ${resolution.costCount} ${resolution.costSlot}` +
                `, but only ${remaining} of ${max} remain this turn.`,
              slot: actionEconomyCost.slot,
              remaining,
              max,
            });
          }
        }
        concentrationBefore = actorTurnStateBefore.concentration;
        pendingConcentrationChecksBefore = actorTurnStateBefore.pendingConcentrationChecks.map(
          (check) => ({ ...check }),
        );
      }

      const concentratingCombatantIds = new Set<number>();
      if (ruleSystem === DND5E_ADAPTER_ID && resolution.targets.some((target) => target.totalDamage > 0)) {
        const encounterCombatants = tx
          .select({
            id: combatants.id,
            turnState: combatants.turnState,
            conditions: combatants.conditions,
            conditionInstances: combatants.conditionInstances,
          })
          .from(combatants)
          .where(eq(combatants.encounterId, liveEncounter.id))
          .all();
        for (const candidate of encounterCombatants) {
          if (fromJsonText<{ concentration?: string | null }>(candidate.turnState, {}).concentration != null) {
            concentratingCombatantIds.add(candidate.id);
          }
          for (const condition of readConditionInstances(candidate.conditionInstances, candidate.conditions)) {
            if (condition.isConcentration && condition.sourceCombatantId != null) {
              concentratingCombatantIds.add(condition.sourceCombatantId);
            }
          }
        }
      }

      for (const t of resolution.targets) {
        const fresh = tx.select().from(combatants).where(eq(combatants.id, t.combatantId)).get();
        if (!fresh) continue;
        const conditionsBefore = fromJsonText<string[]>(fresh.conditions, []);
        const effects = fromJsonText<Array<Record<string, unknown>>>(fresh.activeEffects, []);
        undoTargets.push({
          combatantId: fresh.id,
          hpBefore: fresh.hpCurrent,
          hpTempBefore: fresh.hpTemp,
          deathStateBefore: fresh.deathState,
          deathSaveSuccessesBefore: fresh.deathSaveSuccesses,
          deathSaveFailuresBefore: fresh.deathSaveFailures,
          conditionsBefore: [...conditionsBefore],
          effectIdsAdded: [],
        });
        const undoRef = undoTargets[undoTargets.length - 1];

        const net = t.healing - t.totalDamage;
        const state: CombatantHpState = {
          kind: fresh.kind as CombatantHpState['kind'],
          hpCurrent: fresh.hpCurrent,
          hpMax: fresh.hpMax,
          hpTemp: fresh.hpTemp,
          deathState: fresh.deathState as CombatantHpState['deathState'],
          deathSaveSuccesses: fresh.deathSaveSuccesses,
          deathSaveFailures: fresh.deathSaveFailures,
        };
        const result = applyCombatantHp(state, {
          hpDelta: net !== 0 ? net : undefined,
          // Temp HP doesn't stack — take the higher of current and the grant.
          hpTemp: t.tempHp > 0 ? Math.max(fresh.hpTemp, t.tempHp) : undefined,
        });
        const concentrationCheck = concentrationCheckForDamage(
          concentratingCombatantIds.has(fresh.id),
          t.totalDamage,
        );
        const targetTurnState = CombatantTurnState.parse(fromJsonText<unknown>(fresh.turnState, null) ?? {});
        const nextTargetTurnState = concentrationCheck
          ? enqueueConcentrationCheck(targetTurnState, {
              id: `action-${chainId}-${fresh.id}`,
              ...concentrationCheck,
            })
          : targetTurnState;

        // Conditions: union (idempotent).
        const conditions = new Set(conditionsBefore);
        for (const e of t.effects) if (e.condition) conditions.add(e.condition);

        // Structured active effects: add for durationed / save-ends / ongoing effects.
        const nextEffects = [...effects];
        for (const e of t.effects) {
          if (e.rounds === null && !e.saveEnds && e.ongoingDamage === 0) continue; // a plain condition, no timed effect
          const id = `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          nextEffects.push({
            id,
            name: `${resolution.actionName}: ${e.condition || 'effect'}`,
            kind: e.ongoingDamage > 0 ? 'ongoing-damage' : 'condition',
            timing: e.saveEnds ? 'end-of-turn' : 'none',
            roundsRemaining: e.rounds,
            amount: e.ongoingDamage > 0 ? e.ongoingDamage : null,
            saveAbility: null,
            saveDc: null,
            notes: e.condition || '',
          });
          undoRef.effectIdsAdded.push(id);
        }

        tx.update(combatants)
          .set({
            hpCurrent: result.hpCurrent,
            hpTemp: result.hpTemp,
            deathState: result.deathState,
            deathSaveSuccesses: result.deathSaveSuccesses,
            deathSaveFailures: result.deathSaveFailures,
            turnState: toJsonText(nextTargetTurnState),
            // Structured instances must move with the names (see common/conditions.ts):
            // a resolved action that removes a condition has to drop its instance too.
            ...conditionWriteSetFromNames([...conditions], fresh.conditionInstances),
            activeEffects: toJsonText(nextEffects),
          })
          .where(eq(combatants.id, fresh.id))
          .run();

        // Mirror the HP/condition slice onto a linked, live character sheet (issue #711/#486).
        if (fresh.kind === 'character' && fresh.characterId !== null && liveEncounter.status !== 'ended') {
          const sheetRow = tx
            .select({ conditionInstances: characters.conditionInstances })
            .from(characters)
            .where(eq(characters.id, fresh.characterId))
            .get();
          const sheetPriorInstances = sheetRow?.conditionInstances ?? null;
          tx.update(characters)
            .set({
              hpCurrent: result.hpCurrent,
              hpTemp: result.hpTemp,
              deathState: result.deathState,
              deathSaveSuccesses: result.deathSaveSuccesses,
              deathSaveFailures: result.deathSaveFailures,
              // #1047: the sheet has a structured copy now too, so the mirror must move
              // the pair or it recreates the #423 desync one table over.
              ...sheetConditionWriteSetFromNames([...conditions], sheetPriorInstances),
              updatedAt: nowIso(),
            })
            .where(eq(characters.id, fresh.characterId))
            .run();
        }

        // Combat-log lines (name-free detail; deltas only — never a monster's exact HP).
        const poolDelta = result.hpCurrent + result.hpTemp - (fresh.hpCurrent + fresh.hpTemp);
        if (poolDelta < 0) consequenceLogs.push({ type: 'damage', target: fresh.name, targetId: fresh.id, detail: `took ${-poolDelta} damage` });
        else if (poolDelta > 0) consequenceLogs.push({ type: 'heal', target: fresh.name, targetId: fresh.id, detail: `healed ${poolDelta} HP` });
        for (const c of conditions) if (!conditionsBefore.includes(c)) consequenceLogs.push({ type: 'condition', target: fresh.name, targetId: fresh.id, detail: `gained ${c}` });
        if (result.deathState === 'dead' && fresh.deathState !== 'dead') consequenceLogs.push({ type: 'death', target: fresh.name, targetId: fresh.id, detail: 'died' });
        else if ((fresh.kind === 'monster' || fresh.kind === 'npc') && result.hpCurrent <= 0 && fresh.hpCurrent > 0)
          consequenceLogs.push({ type: 'death', target: fresh.name, targetId: fresh.id, detail: 'dropped to 0 HP' });
      }

      // Spend the actor's resources: action-economy slot, spell slot, concentration.
      // #1637 — the action-economy spend, like spellSlotSpend, was already validated at the top
      // of this transaction, before any consequence above was written — this is just the write.
      const actorFresh = tx.select().from(combatants).where(eq(combatants.id, actor.id)).get();
      if (actorFresh) {
        const turnState = CombatantTurnState.parse(fromJsonText<unknown>(actorFresh.turnState, null) ?? {});
        if (resolution.costSlot && resolution.costCount > 0) {
          this.spendActionEconomyCost(
            turnState,
            this.resolveActionEconomyCost(actorFresh, adapter, resolution.costSlot),
            resolution.costCount,
          );
        }
        if (resolution.startsConcentration) {
          // Starting this action's effect replaces the prior concentration; queued saves
          // were created for that prior effect and must not be allowed to break the new one.
          turnState.pendingConcentrationChecks = [];
          turnState.concentration = resolution.actionName;
        }
        tx.update(combatants).set({ turnState: toJsonText(turnState) }).where(eq(combatants.id, actor.id)).run();
      }
      // The spend was already validated (and the replacement blob computed) at the top of
      // this transaction, before any consequence above was written — this is just the write.
      if (spellSlotSpend) {
        tx.update(characters)
          .set({ spellSlots: toJsonText(spellSlotSpend.slots), updatedAt: nowIso() })
          .where(eq(characters.id, spellSlotSpend.characterId))
          .run();
      }

      // Issue #1449: persist the pre-apply snapshot server-side, keyed by chainId, so undo()
      // can restore from THIS row rather than trusting the client-echoed undo token. Written in
      // the SAME transaction as the state it snapshots — a failed insert here rolls back the
      // whole apply rather than leaving state that was written but can never be safely undone.
      tx.insert(actionApplyChains)
        .values({
          id: chainId,
          encounterId: encounter.id,
          campaignId: encounter.campaignId,
          actorCombatantId: actor.id,
          actionName: resolution.actionName,
          targetsAllow,
          costSlot: resolution.costSlot,
          costCount: resolution.costCount,
          spellLevelSpent: resolution.spellLevelSpent,
          concentrationBefore,
          pendingConcentrationChecksBeforeJson: toJsonText(pendingConcentrationChecksBefore),
          startedConcentration: resolution.startsConcentration,
          targetsJson: toJsonText(undoTargets),
          createdAt: nowIso(),
        })
        .run();
    });

    // Persist correlated combat-log chain after commit (a log failure must not roll back the apply).
    this.persistActionChain(committedEncounter, committedEncounter.round, actor, chainId, performedBy, ruleSystem, resolution, consequenceLogs);

    void this.audit
      .log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.action.resolve',
        entityType: 'combatant',
        entityId: actor.id,
        campaignId: committedEncounter.campaignId,
        detail: JSON.stringify({ action: resolution.actionName, targets: resolution.targets.map((t) => t.combatantId) }),
      })
      .catch(() => undefined);

    if (!committedEncounter.hidden) this.events.emit({ type: 'encounter.updated', campaignId: committedEncounter.campaignId, encounterId: committedEncounter.id });

    return ActionUndoToken.parse({
      encounterId: committedEncounter.id,
      actorCombatantId: actor.id,
      actionName: resolution.actionName,
      chainId,
      targets: undoTargets,
      costSlot: resolution.costSlot,
      costCount: resolution.costCount,
      spellLevelSpent: resolution.spellLevelSpent,
      concentrationBefore,
      pendingConcentrationChecksBefore,
      startedConcentration: resolution.startsConcentration,
    });
  }

  /** Audit a rejected undo attempt (issue #1449) — this endpoint used to succeed silently on forged input. */
  private auditRejectedUndo(
    encounter: typeof encounters.$inferSelect,
    token: ActionUndoToken,
    user: RequestUser,
    role: Role,
    reason: string,
  ): void {
    void this.audit
      .log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.action.undo_rejected',
        entityType: 'encounter',
        entityId: encounter.id,
        campaignId: encounter.campaignId,
        detail: JSON.stringify({ reason, chainId: token.chainId, claimedActorCombatantId: token.actorCombatantId }),
      })
      .catch(() => undefined);
  }

  /**
   * Reverse an applied resolution (issue #414 undo). Restores each target's HP / temp HP /
   * death-save state / conditions to the pre-apply snapshot, removes the effects the apply
   * added, and refunds the actor's action-economy slot, spell slot, and concentration. The DM
   * may undo any resolution; a player only one whose actor is their own character.
   *
   * Issue #1449: `token` is a LOOKUP KEY, not a source of truth. Only `token.chainId` is
   * trusted; every other field the client echoes back (actor, targets, hpBefore, costs,
   * concentration) is ignored in favor of the `action_apply_chains` row `apply()` persisted
   * for that exact chain. A token naming an unrelated combatant, a chain from a different
   * encounter, or a chain that was never applied here (or already undone) is rejected before
   * any state is touched.
   */
  undo(encounterId: number, token: ActionUndoToken, user: RequestUser, role: Role): { ok: true } {
    const encounter = this.encounterRowOrThrow(encounterId);
    if (token.encounterId !== encounterId) {
      this.auditRejectedUndo(encounter, token, user, role, 'cross_encounter_token');
      throw new BadRequestException('Undo token is for a different encounter.');
    }
    if (!token.chainId) {
      this.auditRejectedUndo(encounter, token, user, role, 'missing_chain_id');
      throw new BadRequestException('Undo token has no chain id.');
    }
    const chain = this.db.select().from(actionApplyChains).where(eq(actionApplyChains.id, token.chainId)).get();
    if (!chain) {
      this.auditRejectedUndo(encounter, token, user, role, 'unknown_chain_id');
      throw new BadRequestException('This action was never applied on this server (unknown chain).');
    }
    if (chain.encounterId !== encounterId) {
      this.auditRejectedUndo(encounter, token, user, role, 'cross_encounter_chain');
      throw new BadRequestException('This chain belongs to a different encounter.');
    }
    if (chain.undoneAt) {
      this.auditRejectedUndo(encounter, token, user, role, 'already_undone');
      throw new BadRequestException('This action was already undone.');
    }

    // The actor and every target below come from the STORED chain, never from `token` — see
    // doc comment above. `combatantRowOrThrow` scopes the actor read to this encounter,
    // matching the apply-side check the original vulnerability report called out.
    const actor = this.combatantRowOrThrow(encounterId, chain.actorCombatantId);
    const adapter = this.adapterForCampaign(encounter.campaignId);
    if (role !== 'dm') {
      // Issue #1450 defense in depth: undo() never routes through policyFor, so it needs
      // its own role floor. Ownership alone is not enough — a member demoted from player
      // to viewer keeps `characters.ownerUserId`, so the ownership check below would
      // otherwise still pass for them.
      if (!roleAtLeast(role, 'player')) {
        this.auditRejectedUndo(encounter, token, user, role, 'viewer_role');
        throw new ForbiddenException('Viewers may not undo combat actions.');
      }
      if (actor.kind !== 'character' || !this.isCharacterOwnedBy(actor, user)) {
        this.auditRejectedUndo(encounter, token, user, role, 'not_actor_owner');
        throw new ForbiddenException('Only the DM may undo a monster/NPC action.');
      }
    }

    const targetsAllowParsed = ActionTargetAllow.safeParse(chain.targetsAllow);
    const targetsAllow: ActionTargetAllow = targetsAllowParsed.success ? targetsAllowParsed.data : 'any';
    const storedTargets = fromJsonText<ActionUndoTarget[]>(chain.targetsJson, []);
    // Issue #1449: re-run the same target-allow gate `apply()` enforced at commit time, for
    // defense in depth — every stored target that still EXISTS is scoped to this encounter
    // and legality-checked before anything is written. A target combatant can legitimately
    // be removed from the fight between apply and undo (removeCombatant is ordinary DM
    // cleanup, e.g. clearing out a killed monster); skip it here rather than throw, matching
    // the revert loop below (`if (!fresh) continue`) — a REMOVED target is not the same as a
    // FORGED one, and only the latter should ever block an otherwise-legitimate undo.
    for (const t of storedTargets) {
      const target = this.db
        .select()
        .from(combatants)
        .where(and(eq(combatants.id, t.combatantId), eq(combatants.encounterId, encounterId)))
        .get();
      if (!target) continue;
      this.assertTargetAllowed(targetsAllow, actor, target, chain.actionName);
    }

    const pendingConcentrationChecksBefore = fromJsonText<PendingConcentrationCheck[]>(
      chain.pendingConcentrationChecksBeforeJson,
      [],
    );

    this.db.transaction((tx) => {
      // Claim the chain (single-use) FIRST, inside the same transaction as the revert. A
      // concurrent second undo either sees `undoneAt` already set above and never reaches
      // here, or loses this conditional UPDATE (0 rows changed) and is rejected instead of
      // double-reverting the same chain.
      const claimed = tx
        .update(actionApplyChains)
        .set({ undoneAt: nowIso() })
        .where(and(eq(actionApplyChains.id, chain.id), isNull(actionApplyChains.undoneAt)))
        .run();
      if (claimed.changes === 0) {
        throw new BadRequestException('This action was already undone.');
      }

      for (const t of storedTargets) {
        const fresh = tx
          .select()
          .from(combatants)
          .where(and(eq(combatants.id, t.combatantId), eq(combatants.encounterId, encounterId)))
          .get();
        if (!fresh) continue;
        const effects = fromJsonText<Array<Record<string, unknown>>>(fresh.activeEffects, []);
        const keptEffects = effects.filter((e) => !t.effectIdsAdded.includes(String(e.id)));
        const targetTurnState = CombatantTurnState.parse(fromJsonText<unknown>(fresh.turnState, null) ?? {});
        const checkId = `action-${chain.id}-${fresh.id}`;
        targetTurnState.pendingConcentrationChecks = targetTurnState.pendingConcentrationChecks.filter(
          (check) => check.id !== checkId,
        );
        tx.update(combatants)
          .set({
            hpCurrent: t.hpBefore,
            hpTemp: t.hpTempBefore,
            deathState: t.deathStateBefore,
            deathSaveSuccesses: t.deathSaveSuccessesBefore,
            deathSaveFailures: t.deathSaveFailuresBefore,
            // UNDO is the worst place to half-revert. Restoring only the names left the
            // structured instance the action had added, which the next write re-derived
            // into visibility — the DM undoes, watches the condition come back, and has no
            // model for why. Roll both columns back together (see common/conditions.ts).
            ...conditionWriteSetFromNames(t.conditionsBefore, fresh.conditionInstances),
            activeEffects: toJsonText(keptEffects),
            turnState: toJsonText(targetTurnState),
          })
          .where(eq(combatants.id, fresh.id))
          .run();
        if (fresh.kind === 'character' && fresh.characterId !== null && encounter.status !== 'ended') {
          const undoSheetRow = tx
            .select({ conditionInstances: characters.conditionInstances })
            .from(characters)
            .where(eq(characters.id, fresh.characterId))
            .get();
          const undoSheetPriorInstances = undoSheetRow?.conditionInstances ?? null;
          tx.update(characters)
            .set({
              hpCurrent: t.hpBefore,
              hpTemp: t.hpTempBefore,
              deathState: t.deathStateBefore,
              deathSaveSuccesses: t.deathSaveSuccessesBefore,
              deathSaveFailures: t.deathSaveFailuresBefore,
              // #1047: undo must roll the sheet's structured copy back too.
              ...sheetConditionWriteSetFromNames(t.conditionsBefore, undoSheetPriorInstances),
              updatedAt: nowIso(),
            })
            .where(eq(characters.id, fresh.characterId))
            .run();
        }
      }
      // Refund the actor's resources — from the STORED chain, never the client token.
      // #1637 review: this is the mirror image of the apply-side spend, and was ALREADY correct
      // — a refund can only ever SUBTRACT from `used`, and `Math.max(0, ...)` already floors it
      // at zero, so there is no "goes out of range" direction here the way the unguarded spend
      // had. This matches `applySpellSlotDelta`'s own asymmetry (spend errors, restore clamps —
      // see packages/schema/src/spell-slots.ts): a restore cannot invent a slot, so refusing an
      // overshoot would be noise, not protection. No change needed; documented so a future
      // reader does not have to re-derive that this was checked.
      const actorFresh = tx.select().from(combatants).where(eq(combatants.id, actor.id)).get();
      if (actorFresh) {
        const turnState = CombatantTurnState.parse(fromJsonText<unknown>(actorFresh.turnState, null) ?? {});
        if (chain.costSlot && chain.costCount > 0) {
          this.refundActionEconomyCost(
            turnState,
            this.resolveActionEconomyCost(actorFresh, adapter, chain.costSlot),
            chain.costCount,
          );
        }
        if (chain.startedConcentration) {
          turnState.concentration = chain.concentrationBefore;
          turnState.pendingConcentrationChecks = pendingConcentrationChecksBefore.map((check) => ({
            ...check,
          }));
        }
        tx.update(combatants).set({ turnState: toJsonText(turnState) }).where(eq(combatants.id, actor.id)).run();
      }
      if (chain.spellLevelSpent > 0 && actor.characterId !== null) {
        const character = tx.select().from(characters).where(eq(characters.id, actor.characterId)).get();
        if (character) {
          const slots = fromJsonText<Record<string, { max: number; used: number }>>(character.spellSlots, {});
          const slot = slots[String(chain.spellLevelSpent)];
          if (slot) {
            slot.used = Math.max(0, (slot.used ?? 0) - 1);
            tx.update(characters).set({ spellSlots: toJsonText(slots), updatedAt: nowIso() }).where(eq(characters.id, actor.characterId)).run();
          }
        }
      }
    });

    const undoChainId = `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const performedBy = this.performedByFrom(user, role);
    this.db
      .insert(encounterEvents)
      .values({
        encounterId: encounter.id,
        round: encounter.round,
        type: 'correction',
        actor: actor.name,
        actorId: actor.id,
        target: null,
        targetId: null,
        detail: `undid ${chain.actionName}`,
        chainId: undoChainId,
        parentEventId: null,
        phase: 'undo',
        performedByJson: JSON.stringify(performedBy),
        metadataJson: JSON.stringify({ actionName: chain.actionName, undoOfChainId: chain.id }),
        createdAt: nowIso(),
      })
      .run();

    void this.audit
      .log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.action.undo',
        entityType: 'combatant',
        entityId: actor.id,
        campaignId: encounter.campaignId,
        detail: JSON.stringify({ action: chain.actionName, chainId: chain.id, targets: storedTargets.map((t) => t.combatantId) }),
      })
      .catch(() => undefined);

    if (!encounter.hidden) this.events.emit({ type: 'encounter.updated', campaignId: encounter.campaignId, encounterId: encounter.id });
    return { ok: true };
  }
}
