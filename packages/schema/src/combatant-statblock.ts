/**
 * Combatant statblock model + action expansion (issue #425).
 *
 * Manual monsters store a bounded {@link CombatantStatblock} on the combatant row;
 * compendium monsters expand their linked rule-entry `dataJson` into the same
 * {@link CharacterAction} shape at read time. Both paths feed the structured action
 * resolver (#414) so DMs can run attacks/saves without leaving the tracker.
 */
import { z } from 'zod';
import { ActionSpec, isResolvableSpec } from './action-resolver';
import { CharacterAction } from './character-action';

// ---------------------------------------------------------------------------
// Inline help (issue #425) — surfaced in the statblock editor + Use flow.
// ---------------------------------------------------------------------------

/** Field-level help for the quick statblock editor and action controls. */
export const COMBATANT_STATBLOCK_HELP = {
  ac: 'Armor Class — the target number an attack roll must meet or exceed.',
  abilityScores: 'Ability scores or modifiers used for attack/save math when an action does not carry an explicit bonus.',
  actions: 'Named attacks, spells, and features. Actions with enough structure show a Use button; others keep their full prose.',
  traits: 'Passive special abilities (keen senses, magic resistance, etc.).',
  notes: 'Freeform DM notes — never used for resolver math.',
  actionName: 'Short label shown on the combat card and in the turn workspace.',
  actionKind: 'Category hint: melee, ranged, spell, reaction, legendary, or feature.',
  toHit: 'Printed attack bonus (e.g. +5). When set, it overrides ability-based math.',
  damage: 'Damage expression shown in prose (e.g. 2d6+3 slashing).',
  targetAc: 'Which defence the attack compares against (usually AC).',
  actionNotes: 'Full rules text — always preserved even when the action is resolver-ready.',
  resolvable: 'When true, Campfire can roll attack/save math and apply damage atomically.',
  library: 'Campaign library entries can be cloned, edited, and re-added to future encounters.',
} as const;

// ---------------------------------------------------------------------------
// Statblock data model
// ---------------------------------------------------------------------------

export const CombatantStatblock = z.object({
  ac: z.number().int().min(0).max(40).nullable().default(10),
  abilityScores: z.record(z.string(), z.number().int()).default(() => ({
    STR: 10,
    DEX: 10,
    CON: 10,
    INT: 10,
    WIS: 10,
    CHA: 10,
  })),
  actions: z.array(CharacterAction).max(50).default([]),
  resources: z.record(z.string().max(80), z.any()).default({}),
  spellSlots: z.record(z.string().regex(/^[1-9]$/), z.any()).default({}),
  traits: z
    .array(z.object({ name: z.string().max(120).default(''), text: z.string().max(1200).default('') }))
    .max(30)
    .default([]),
  notes: z.string().max(2000).default(''),
});
export type CombatantStatblock = z.infer<typeof CombatantStatblock>;

/** Sensible defaults for a brand-new manual monster (issue #425). */
export function defaultCombatantStatblock(): CombatantStatblock {
  return CombatantStatblock.parse({
    ac: 10,
    abilityScores: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    actions: [
      {
        name: 'Claw',
        kind: 'melee',
        toHit: '+3',
        damage: '1d4+1 slashing',
        targetAc: 'AC',
        notes: 'Melee Weapon Attack.',
        spec: {
          mode: 'attack',
          attack: { bonus: '+3' },
          cost: { slot: 'action', count: 1 },
          targets: { count: 1, allow: 'enemy' },
          outcomes: { hit: { damage: [{ formula: '1d4', flat: 1, type: 'slashing' }] } },
        },
      },
    ],
    traits: [],
    notes: '',
  });
}

// ---------------------------------------------------------------------------
// Campaign library (homebrew monsters reusable across encounters)
// ---------------------------------------------------------------------------

export const CampaignLibraryMonster = z.object({
  id: z.number().int(),
  campaignId: z.number().int(),
  name: z.string().min(1).max(120),
  statblock: CombatantStatblock,
  sourceRuleEntryId: z.number().int().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CampaignLibraryMonster = z.infer<typeof CampaignLibraryMonster>;

export const CampaignLibraryMonsterCreate = z.object({
  name: z.string().min(1).max(120),
  statblock: CombatantStatblock,
  sourceRuleEntryId: z.number().int().optional(),
});
export type CampaignLibraryMonsterCreate = z.infer<typeof CampaignLibraryMonsterCreate>;

export const CampaignLibraryMonsterUpdate = z
  .object({
    name: z.string().min(1).max(120),
    statblock: CombatantStatblock,
  })
  .partial();
export type CampaignLibraryMonsterUpdate = z.infer<typeof CampaignLibraryMonsterUpdate>;

// ---------------------------------------------------------------------------
// Compendium → CharacterAction expansion
// ---------------------------------------------------------------------------

const ABILITY_ALIASES: Record<string, string> = {
  strength: 'STR',
  str: 'STR',
  dexterity: 'DEX',
  dex: 'DEX',
  constitution: 'CON',
  con: 'CON',
  intelligence: 'INT',
  int: 'INT',
  wisdom: 'WIS',
  wis: 'WIS',
  charisma: 'CHA',
  cha: 'CHA',
};

function normalizeAbility(raw: string): string {
  const k = raw.trim().toLowerCase();
  return ABILITY_ALIASES[k] ?? raw.toUpperCase().slice(0, 3);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatDamageList(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const parts: string[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o) continue;
    const expr =
      typeof o.expression === 'string'
        ? o.expression
        : typeof o.damage_dice === 'string'
          ? o.damage_dice
          : '';
    const type = typeof o.type === 'string' ? o.type : '';
    const bit = type ? `${expr} ${type}`.trim() : expr.trim();
    if (bit) parts.push(bit);
  }
  return parts.join(' + ');
}

function damagePartsFrom(raw: unknown): Array<{ formula: string; flat: number; type: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ formula: string; flat: number; type: string }> = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o) continue;
    const expr =
      typeof o.expression === 'string'
        ? o.expression
        : typeof o.damage_dice === 'string'
          ? o.damage_dice
          : '';
    const type = typeof o.type === 'string' ? o.type.toLowerCase() : '';
    if (!expr.trim()) continue;
    const m = expr.trim().match(/^(\d+d\d+)(?:\s*([+-])\s*(\d+))?$/i);
    if (m) {
      const base = m[1];
      const sign = m[2] === '-' ? -1 : 1;
      const flat = m[3] ? sign * Number(m[3]) : 0;
      // #1053: `flat` accepts negatives now, so a penalty stays OUT of the dice formula. It
      // used to be folded back in as "1d8-1" because the schema was `.min(0)` — and a 5e
      // critical then re-rolled that formula and doubled the penalty. Keeping the split is
      // what lets the resolver apply the campaign system's critical rule to the right half.
      out.push({ formula: base, flat, type });
    } else {
      out.push({ formula: expr.trim(), flat: 0, type });
    }
  }
  return out;
}

function rechargeFromUsage(raw: unknown): string {
  const u = asRecord(raw);
  if (!u) return '';
  const type = typeof u.type === 'string' ? u.type.toLowerCase() : '';
  if (type === 'recharge') {
    const min = numberOrNull(u.min);
    const max = numberOrNull(u.max) ?? 6;
    if (min !== null) return `recharge-${min}-${max}`;
  }
  const label = typeof u.label === 'string' ? u.label : '';
  const m = label.match(/Recharge\s+(\d+)(?:\s*[-\u2013]\s*(\d+))?/i);
  if (m) return `recharge-${m[1]}-${m[2] ?? 6}`;
  return '';
}

/**
 * Issue #1921: parse a per-day usage limit ("1/Day", "2/Day") into {@link ActionUses.max}.
 * The open5e importer already normalizes a structured `PER_DAY` usage limit into
 * `{ type: 'perDay', uses: N, label: 'N/Day' }` (open5e-importer.ts's `usageFrom`); the
 * `label` regex is the fallback for any other producer that only carries prose. Returns 0
 * (no per-day pool) for anything else, including a `recharge`-typed usage object.
 */
function usesMaxFromUsage(raw: unknown): number {
  const u = asRecord(raw);
  if (!u) return 0;
  // Floor and clamp into `ActionUses.max`'s domain (integer, 0–99). Statblock JSON is
  // external data — a compendium row, a DDB import, a homebrew paste — so `uses: 100`,
  // `uses: 2.5`, or a five-digit `N/Day` label are all reachable, and every one of them
  // makes `ActionSpec.parse` throw. That throw escapes `expandRawStatblockAction`, which
  // `expandStatblockActions` calls in an unguarded loop, so ONE malformed usage object
  // takes out the whole creature's action list and `listUsableActions` 500s. Degrading to
  // a clamped pool matches how every other unparseable statblock field here behaves:
  // produce nothing rather than throw.
  const clamp = (n: number) => Math.max(0, Math.min(99, Math.floor(n)));
  const type = typeof u.type === 'string' ? u.type.toLowerCase() : '';
  if (type === 'perday') {
    const n = numberOrNull(u.uses ?? u.param);
    if (n !== null && n > 0) return clamp(n);
  }
  const label = typeof u.label === 'string' ? u.label : '';
  const m = label.match(/^\s*(\d+)\s*\/\s*Day\s*$/i);
  if (m) return clamp(Number(m[1]));
  return 0;
}

function savingThrowFrom(item: Record<string, unknown>, desc: string): { dc: number; ability: string } | null {
  // A dedicated, explicit opt-out signal (issue #1903 review, PR #1950 round 12 — replacing
  // round 10's overloading of `savingThrow: null`) means the caller has already determined
  // there is no confidently-resolvable save for this entry and does NOT want the free-text
  // `desc` scanned for a "DC N Ability" phrase either — DDB feature/spell descriptions very
  // commonly contain exactly that phrasing ("...must make a DC 13 Dexterity saving
  // throw..."), so without this escape hatch a caller's deliberate "leave this text-only"
  // decision (e.g. an unresolvable save ability, or an activation type with no representable
  // action-economy slot) could be silently overridden by the desc-regex fallback below,
  // resolving the entry against the wrong resource anyway.
  //
  // round 10 originally implemented this by treating an explicit `null` on `savingThrow` OR
  // `saving_throw` as the opt-out. That was too broad: those two keys are shared with OTHER
  // callers (open5e/pf2e importers spread raw statblock data verbatim into `dataJson`) that
  // may legitimately set one of them to `null` as "we didn't find a structured value here"
  // while still wanting `save_dc`/`dc` or the desc-regex fallback to run — round 10's guard
  // bailed on that case too, silently losing resolvability for compendium monster actions
  // whose only save-DC signal is in prose. A dedicated field name avoids colliding with
  // `savingThrow`/`saving_throw`'s existing, wider-audience semantics entirely.
  if (item.noSaveInference === true) return null;
  const direct = asRecord(item.savingThrow ?? item.saving_throw);
  if (direct) {
    const dc = numberOrNull(direct.dc);
    const ability = typeof direct.ability === 'string' ? normalizeAbility(direct.ability) : 'DEX';
    if (dc !== null) return { dc, ability };
  }
  const dc = numberOrNull(item.save_dc ?? item.dc);
  const abilityRaw =
    typeof item.save_ability === 'string'
      ? item.save_ability
      : typeof item.saving_throw_ability === 'string'
        ? item.saving_throw_ability
        : '';
  if (dc !== null) return { dc, ability: abilityRaw ? normalizeAbility(abilityRaw) : 'DEX' };
  const match = desc.match(/\bDC\s+(\d+)\s+(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma|STR|DEX|CON|INT|WIS|CHA)\b/i);
  if (!match) return null;
  return { dc: Number(match[1]), ability: normalizeAbility(match[2]) };
}

function attackBonusFrom(item: Record<string, unknown>): number | null {
  return numberOrNull(item.attackBonus) ?? numberOrNull(item.attack_bonus) ?? numberOrNull(item.to_hit_mod) ?? null;
}

function costSlotForSource(source: string): string {
  if (source === 'reaction') return 'reaction';
  if (source === 'legendary') return 'legendary';
  // 'bonus' (issue #1903 review, PR #1950): a caller mapping a bonus-action-activated
  // feature (e.g. the D&D Beyond importer) needs its cost tracked against the DND5E_ACTION_ECONOMY
  // 'bonus' slot, not the default 'action' slot — otherwise resolving it would silently
  // consume the actor's action instead of their bonus action. No existing caller passed
  // 'bonus' before this, so adding the branch changes nothing for 'action'/'reaction'/'legendary'/'special'.
  if (source === 'bonus') return 'bonus';
  return 'action';
}

/** Expand one raw statblock action into a {@link CharacterAction} with optional spec. */
export function expandRawStatblockAction(raw: unknown, source: string, ruleSystem = ''): CharacterAction {
  const item = asRecord(raw) ?? {};
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, 120) : 'Action';
  const desc =
    typeof item.desc === 'string'
      ? item.desc
      : typeof item.description === 'string'
        ? item.description
        : typeof item.text === 'string'
          ? item.text
          : '';
  const kind =
    source === 'legendary'
      ? 'legendary'
      : source === 'reaction'
        ? 'reaction'
        : source === 'action'
          ? 'action'
          : source.slice(0, 40);

  const attackBonus = attackBonusFrom(item);
  const damageText = formatDamageList(item.damage);
  const damageParts = damagePartsFrom(item.damage);
  const save = savingThrowFrom(item, desc);
  const recharge = rechargeFromUsage(item.usage);
  // Issue #1921: a per-day usage ("1/Day") and a recharge condition are mutually exclusive
  // in practice (a statblock action carries at most one usage note), but nothing stops both
  // parsers from matching the same raw `usage` object — `usesMaxFromUsage` only fires for
  // `perDay`/`N/Day` shapes, `rechargeFromUsage` only for `recharge`/`Recharge N-M` shapes,
  // so passing both through untouched below is safe either way.
  const usesMax = usesMaxFromUsage(item.usage);
  const usesSpec = recharge || usesMax > 0 ? { recharge, ...(usesMax > 0 ? { max: usesMax } : {}) } : {};

  let spec: ActionSpec | undefined;
  let toHit = '';
  const damage = damageText;
  const targetAc = 'AC';

  if (attackBonus !== null) {
    toHit = attackBonus >= 0 ? `+${attackBonus}` : String(attackBonus);
    const outcomes =
      damageParts.length > 0
        ? { hit: { damage: damageParts.map((p) => ({ formula: p.formula, flat: p.flat, type: p.type })) } }
        : {};
    spec = ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: toHit },
      cost: { slot: costSlotForSource(source), count: 1 },
      uses: usesSpec,
      targets: { count: 1, allow: 'enemy' },
      outcomes,
      provenance: { ruleSystem, source: 'statblock' },
    });
  } else if (save) {
    const outcomes =
      damageParts.length > 0
        ? {
            failure: { damage: damageParts.map((p) => ({ formula: p.formula, flat: p.flat, type: p.type })) },
            success: { halfDamage: true },
          }
        : {};
    spec = ActionSpec.parse({
      mode: 'save',
      save: { ability: save.ability, dc: { kind: 'fixed', dc: save.dc } },
      cost: { slot: costSlotForSource(source), count: 1 },
      uses: usesSpec,
      targets: { count: 0, allow: 'enemy' },
      outcomes,
      provenance: { ruleSystem, source: 'statblock' },
    });
  }

  if (spec && !isResolvableSpec(spec)) spec = undefined;

  return CharacterAction.parse({
    name: name || 'Action',
    kind,
    toHit,
    damage,
    targetAc,
    notes: desc.slice(0, 500),
    ...(spec ? { spec } : {}),
  });
}

/** Expand all action sections from a monster `dataJson` via the campaign adapter. */
export function expandStatblockActions(
  data: Record<string, unknown>,
  adapter: {
    mapStatblock: (d: Record<string, unknown>) => {
      actions?: unknown;
      reactions?: unknown;
      legendaryActions?: unknown;
      specialAbilities?: unknown;
    };
  },
  ruleSystem = '',
): CharacterAction[] {
  const mapped = adapter.mapStatblock(data);
  const out: CharacterAction[] = [];
  const push = (source: string, raw: unknown) => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      out.push(expandRawStatblockAction(item, source, ruleSystem));
      if (out.length >= 50) return;
    }
  };
  push('action', mapped.actions ?? data.actions);
  push('reaction', mapped.reactions ?? data.reactions);
  push('legendary', mapped.legendaryActions ?? data.legendary_actions ?? data.legendaryActions);
  push('special', mapped.specialAbilities ?? data.special_abilities ?? data.specialAbilities);
  return out.slice(0, 50);
}

/** Read actions from an inline combatant statblock (manual / library snapshot). */
export function combatantActionsFromStatblock(statblock: CombatantStatblock | null | undefined): CharacterAction[] {
  if (!statblock) return [];
  return statblock.actions.slice(0, 50);
}
