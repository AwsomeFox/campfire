import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  ActionApplyPolicy,
  ActionResolution,
  ActionResolveRequest,
  ActionResolveResult,
  ActionSpec,
  ActionTargetAllow,
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
  classifyAttackOutcome,
  classifySaveOutcome,
  combatantActionsFromStatblock,
  computeAttackModifier,
  computeSaveDc,
  CombatantStatblock,
  CombatantTurnState,
  criticalDamageRuleForAdapter,
  dnd5eProficiencyBonus,
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
  type ActionRollFn,
  type CharacterAction,
  type OutcomeKey,
  type PendingConcentrationCheck,
  type ResolverAdapter,
  type RuleSystemAdapter,
  type SpellSlotMap,
  type TargetDefenses,
} from '@campfire/schema';

import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns, characters, combatants, encounterEvents, encounters, ruleEntries } from '../../db/schema';
import { CampaignEventsService } from '../events/campaign-events.service';
import { AuditService } from '../audit/audit.service';
import { TableSafetyService } from '../safety/table-safety.service';
import { fromJsonText, toJsonText } from '../../common/json';
import { conditionWriteSetFromNames, readConditionInstances, sheetConditionWriteSetFromNames } from '../../common/conditions';
import { nowIso } from '../../common/time';
import { rollDice } from '../../common/dice';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import {
  applyCombatantHp,
  concentrationCheckForDamage,
  enqueueConcentrationCheck,
  type CombatantHpState,
} from './encounters.logic';

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
   * Proficiency bonus for a character under this adapter. 5e's fixed +2..+6 by level is the
   * one system whose proficiency is derivable from level alone; other systems (PF2e level+rank)
   * need per-check rank the sheet action doesn't carry, so they return 0 and rely on the
   * action's explicit attack bonus / fixed DC instead — never silent math.
   */
  private proficiencyBonus(adapter: RuleSystemAdapter, level: number): number {
    return adapter.id === DND5E_ADAPTER_ID ? dnd5eProficiencyBonus(level) : 0;
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
    const entry = this.db.select({ dataJson: ruleEntries.dataJson }).from(ruleEntries).where(eq(ruleEntries.id, row.ruleEntryId)).get();
    return entry ? fromJsonText<Record<string, unknown>>(entry.dataJson, {}) : null;
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

  /** Resolve the structured spec for an action request: inline spec, sheet action, or statblock action. */
  private resolveSpec(actor: typeof combatants.$inferSelect, req: ActionResolveRequest, campaignId: number): { spec: ActionSpec; name: string } {
    if (req.spec) {
      const spec = ActionSpec.parse(req.spec);
      if (!isResolvableSpec(spec)) {
        throw new BadRequestException('The inline action spec has no resolvable mode/DC/attack — fall back to a statblock rather than inventing numbers.');
      }
      return { spec, name: req.actionName ?? 'Action' };
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
      const parsed = ActionSpec.safeParse(raw?.spec);
      if (!parsed.success || !isResolvableSpec(parsed.data)) {
        throw new BadRequestException(
          `"${name}" has no resolvable structured spec — fall back to its statblock (toHit/damage/notes) rather than inventing numbers.`,
        );
      }
      return { spec: parsed.data, name };
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
    const parsed = ActionSpec.safeParse(action.spec);
    if (!parsed.success || !isResolvableSpec(parsed.data)) {
      throw new BadRequestException(
        `"${action.name}" has no resolvable structured spec — fall back to its statblock (toHit/damage/notes) rather than inventing numbers.`,
      );
    }
    return { spec: parsed.data, name: action.name };
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
   * action is DM-only; a player may only act with their own PC (issue #414 authorization).
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
    }

    const adapter = this.adapterForCampaign(encounter.campaignId);
    const { spec, name } = this.resolveSpec(actor, req, encounter.campaignId);
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
    let applied = false;
    let undoToken: ActionUndoToken | null = null;
    if (req.commit && canApply) {
      undoToken = this.applyInternal(encounter, resolution, actor, user, role);
      applied = true;
    }
    return ActionResolveResult.parse({ resolution, applied, canApply, policy, undoToken });
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
      const nat = this.rollD20(roll);
      const total = nat + modifier;
      const ac = this.targetDefenseValue(target, adapter as unknown as RuleSystemAdapter);
      if (ac === null) throw new BadRequestException(`Target "${target.name}" has no known AC — resolve manually rather than inventing one.`);
      outcome = classifyAttackOutcome(adapter, total, nat, ac);
      // #1053 review — `critical` is set in ATTACK mode only. A PF2e critical save FAILURE also
      // doubles damage under that system, and this flag never becomes true in save/check mode,
      // so `double-total` is wired to attacks and not to saves. Left deliberately rather than
      // overlooked: a `critFailure` branch may already be authored with the doubled numbers, so
      // wiring it needs a decision about double-counting, not a one-line change. Tracked in #1600 —
      // called out here so the seam is not mistaken for complete.
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
      dmDetail = `attack ${total} (d20 ${nat} ${signedModifier(modifier)}${detail}) vs AC ${ac} → ${outcome}`;
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
      // #1053: the crit rule is the SYSTEM's, not 5e's. `criticalDamageRuleForAdapter` returns
      // 'double-dice' for any adapter that has not declared one, so 5e and every unaudited
      // system keep the behaviour they had; PF2e/SF2e now double the total as their rules say.
      const rolled = rollBranchDamage(damageBranch, roll, { critical, criticalRule: criticalDamageRuleForAdapter(adapter) });
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
   * Apply a previously-previewed resolution (issue #414 confirm path). The applier must be the
   * DM, or the actor's owning player under an automatic policy. Because the applier is trusted
   * (a DM can already set arbitrary combatant HP), the echoed resolution's rolled numbers are
   * applied verbatim so the committed result is byte-identical to the preview the table read.
   */
  apply(encounterId: number, resolution: ActionResolution, user: RequestUser, role: Role): { undoToken: ActionUndoToken } {
    const encounter = this.encounterRowOrThrow(encounterId);
    // #599: applying a resolution writes damage, conditions, and death saves to the board. That
    // is play advancing, and it is precisely what someone raising an X-Card mid-swing is asking
    // to stop. `resolve` (the preview) stays open — computing a number nobody has committed is
    // harmless, and blocking it would only hide from the table what was about to happen.
    this.safety?.assertNotHeld(encounter.campaignId);
    const actor = this.combatantRowOrThrow(encounterId, resolution.actorCombatantId);
    const isDm = role === 'dm';
    if (!isDm) {
      if (actor.kind !== 'character' || !this.isCharacterOwnedBy(actor, user)) {
        throw new ForbiddenException('Only the DM may apply a monster/NPC action.');
      }
      const { canApply } = this.policyFor(encounter.campaignId, actor, user, role);
      if (!canApply) throw new ForbiddenException('This campaign requires the DM to apply action consequences.');
    }
    const { spec } = this.resolveSpec(actor, {
      actorCombatantId: resolution.actorCombatantId,
      actionName: resolution.actionName,
      targetIds: [],
      commit: false,
    }, encounter.campaignId);
    for (const t of resolution.targets) {
      const target = this.combatantRowOrThrow(encounterId, t.combatantId);
      this.assertTargetAllowed(spec.targets.allow, actor, target, resolution.actionName);
    }
    const undoToken = this.applyInternal(encounter, resolution, actor, user, role);
    return { undoToken };
  }

  /** The atomic core: write every target's consequences + the actor's costs in ONE transaction. */
  private applyInternal(
    encounter: typeof encounters.$inferSelect,
    resolution: ActionResolution,
    actor: typeof combatants.$inferSelect,
    user: RequestUser,
    role: Role,
  ): ActionUndoToken {
    const round = encounter.round;
    const chainId = `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const performedBy = this.performedByFrom(user, role);
    const ruleSystem = this.adapterForCampaign(encounter.campaignId).id;
    const undoTargets: ActionUndoToken['targets'] = [];
    let concentrationBefore: string | null = null;
    let pendingConcentrationChecksBefore: PendingConcentrationCheck[] = [];
    const consequenceLogs: Array<{ type: 'damage' | 'heal' | 'condition' | 'death' | 'effect' | 'note' | 'resource_changed'; target?: string; targetId?: number; detail: string }> = [];

    this.db.transaction((tx) => {
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
        const character = tx.select().from(characters).where(eq(characters.id, actor.characterId)).limit(1).all()[0];
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
          .where(eq(combatants.encounterId, encounter.id))
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
        const fresh = tx.select().from(combatants).where(eq(combatants.id, t.combatantId)).limit(1).all()[0];
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
        if (fresh.kind === 'character' && fresh.characterId !== null && encounter.status !== 'ended') {
          const [sheetRow] = tx
            .select({ conditionInstances: characters.conditionInstances })
            .from(characters)
            .where(eq(characters.id, fresh.characterId))
            .limit(1)
            .all();
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
      const actorFresh = tx.select().from(combatants).where(eq(combatants.id, actor.id)).limit(1).all()[0];
      if (actorFresh) {
        const turnState = CombatantTurnState.parse(fromJsonText<unknown>(actorFresh.turnState, null) ?? {});
        if (resolution.costSlot && resolution.costCount > 0) {
          turnState.used[resolution.costSlot] = (turnState.used[resolution.costSlot] ?? 0) + resolution.costCount;
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
    });

    // Persist correlated combat-log chain after commit (a log failure must not roll back the apply).
    this.persistActionChain(encounter, round, actor, chainId, performedBy, ruleSystem, resolution, consequenceLogs);

    void this.audit
      .log({
        actor: auditActor(user),
        actorRole: role,
        action: 'encounter.action.resolve',
        entityType: 'combatant',
        entityId: actor.id,
        campaignId: encounter.campaignId,
        detail: JSON.stringify({ action: resolution.actionName, targets: resolution.targets.map((t) => t.combatantId) }),
      })
      .catch(() => undefined);

    if (!encounter.hidden) this.events.emit({ type: 'encounter.updated', campaignId: encounter.campaignId, encounterId: encounter.id });

    return ActionUndoToken.parse({
      encounterId: encounter.id,
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

  /**
   * Reverse an applied resolution (issue #414 undo). Restores each target's HP / temp HP /
   * death-save state / conditions to the pre-apply snapshot, removes the effects the apply
   * added, and refunds the actor's action-economy slot, spell slot, and concentration. The DM
   * may undo any resolution; a player only one whose actor is their own character.
   */
  undo(encounterId: number, token: ActionUndoToken, user: RequestUser, role: Role): { ok: true } {
    const encounter = this.encounterRowOrThrow(encounterId);
    if (token.encounterId !== encounterId) throw new BadRequestException('Undo token is for a different encounter.');
    const actor = this.combatantRowOrThrow(encounterId, token.actorCombatantId);
    if (role !== 'dm') {
      if (actor.kind !== 'character' || !this.isCharacterOwnedBy(actor, user)) {
        throw new ForbiddenException('Only the DM may undo a monster/NPC action.');
      }
    }

    this.db.transaction((tx) => {
      for (const t of token.targets) {
        const fresh = tx.select().from(combatants).where(eq(combatants.id, t.combatantId)).limit(1).all()[0];
        if (!fresh) continue;
        const effects = fromJsonText<Array<Record<string, unknown>>>(fresh.activeEffects, []);
        const keptEffects = effects.filter((e) => !t.effectIdsAdded.includes(String(e.id)));
        const targetTurnState = CombatantTurnState.parse(fromJsonText<unknown>(fresh.turnState, null) ?? {});
        if (token.chainId) {
          const checkId = `action-${token.chainId}-${fresh.id}`;
          targetTurnState.pendingConcentrationChecks = targetTurnState.pendingConcentrationChecks.filter(
            (check) => check.id !== checkId,
          );
        }
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
          const [undoSheetRow] = tx
            .select({ conditionInstances: characters.conditionInstances })
            .from(characters)
            .where(eq(characters.id, fresh.characterId))
            .limit(1)
            .all();
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
      // Refund the actor's resources.
      const actorFresh = tx.select().from(combatants).where(eq(combatants.id, actor.id)).limit(1).all()[0];
      if (actorFresh) {
        const turnState = CombatantTurnState.parse(fromJsonText<unknown>(actorFresh.turnState, null) ?? {});
        if (token.costSlot && token.costCount > 0) {
          turnState.used[token.costSlot] = Math.max(0, (turnState.used[token.costSlot] ?? 0) - token.costCount);
        }
        if (token.startedConcentration) {
          turnState.concentration = token.concentrationBefore;
          turnState.pendingConcentrationChecks = token.pendingConcentrationChecksBefore.map((check) => ({
            ...check,
          }));
        }
        tx.update(combatants).set({ turnState: toJsonText(turnState) }).where(eq(combatants.id, actor.id)).run();
      }
      if (token.spellLevelSpent > 0 && actor.characterId !== null) {
        const character = tx.select().from(characters).where(eq(characters.id, actor.characterId)).limit(1).all()[0];
        if (character) {
          const slots = fromJsonText<Record<string, { max: number; used: number }>>(character.spellSlots, {});
          const slot = slots[String(token.spellLevelSpent)];
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
        detail: `undid ${token.actionName}`,
        chainId: undoChainId,
        parentEventId: null,
        phase: 'undo',
        performedByJson: JSON.stringify(performedBy),
        metadataJson: token.chainId ? JSON.stringify({ actionName: token.actionName, undoOfChainId: token.chainId }) : JSON.stringify({ actionName: token.actionName }),
        createdAt: nowIso(),
      })
      .run();

    if (!encounter.hidden) this.events.emit({ type: 'encounter.updated', campaignId: encounter.campaignId, encounterId: encounter.id });
    return { ok: true };
  }
}
