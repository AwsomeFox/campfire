import { z } from 'zod';
import type { AbilityRepresentation, MonsterStatblockData, RuleSystemAdapter, StatblockPresentation } from './index';
import { initModDescThenSortOrderAsc, sortOrderAscTiebreak } from './initiative-tiebreak';
import type { AttackRollInput, AttackRollResult } from './action-resolver';

// ---------- OSR (Old-School Renaissance) native adapters (issues #70, #300, #765) ----------
// Each advertised retroclone variant owns its own mechanics profile — ability table,
// save vocabulary, AC convention/anchor, initiative mode, and tiebreak rules — instead
// of every slug sharing one Basic Fantasy / B/X profile.

/** Family id kept for backward-compat tests; generic 'osr' slug aliases basic-fantasy. */
export const OSR_ADAPTER_ID = 'osr';

/**
 * Rule-pack slugs that resolve to a native OSR adapter. The importer stamps a pack with
 * one of these slugs per source system; a campaign whose `ruleSystem` is any of them gets
 * that variant's combat behavior. 'osr' is the generic catch-all and aliases basic-fantasy.
 */
export const OSR_RULE_SYSTEM_SLUGS = [
  'osr',
  'basic-fantasy',
  'osric',
  'swords-wizardry',
  'labyrinth-lord',
  'old-school-essentials',
  'ose',
] as const;

export type OsrRuleSystemSlug = (typeof OSR_RULE_SYSTEM_SLUGS)[number];

/** How initiative is rolled for an OSR variant (issue #765). */
export type OsrInitiativeMode = 'individual' | 'group';

/** Which AC convention a variant uses by default (issue #765). */
export type AcMode = 'descending' | 'ascending';

/**
 * Complete native mechanics profile for one OSR variant (issue #765). Exposed for UI copy,
 * migration preview, and fixture-vector tests so every call site can show the exact variant
 * and active options wherever math is derived.
 */
export interface OsrMechanicsProfile {
  readonly slug: string;
  readonly label: string;
  /** One-line summary for install pickers / campaign settings. */
  readonly mechanicsSummary: string;
  readonly abilityTable: 'bx-banded' | 'sw-banded' | 'adnd-linear';
  readonly abilityCap: number;
  readonly saves: readonly string[];
  readonly acMode: AcMode;
  /** Unarmored AC in this variant's native convention. */
  readonly acAnchor: number;
  readonly initiativeMode: OsrInitiativeMode;
  readonly initiativeDie: number;
  /** Whether individual initiative adds the DEX modifier to the d6 roll. */
  readonly initiativeUsesDexMod: boolean;
  readonly tiebreak: 'dex-then-order' | 'order-only';
  /**
   * OPTIONAL — this variant's own condition vocabulary (issue #1502). Every one of the six
   * built-in OSR profiles omits this and keeps sharing {@link OSR_CONDITIONS} (their existing,
   * unchanged behavior). A homebrew profile that doesn't play like a D&D retroclone — no
   * Blinded/Paralyzed/etc. — declares its own closed list here instead of inheriting a
   * vocabulary that isn't its own, the same "don't assume another system's terms" principle
   * {@link NEUTRAL_STATBLOCK_PRESENTATION} already applies to labels (issue #763).
   */
  readonly conditions?: readonly string[];
}

// ---------- Ability modifier tables ----------

/** B/X banded table (±3): Basic Fantasy, Labyrinth Lord, OSE. */
export function osrBxAbilityModifier(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 3) return -3;
  if (score <= 5) return -2;
  if (score <= 8) return -1;
  if (score <= 12) return 0;
  if (score <= 15) return 1;
  if (score <= 17) return 2;
  return 3;
}

/** Swords & Wizardry banded table (±2 cap). */
export function osrSwAbilityModifier(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 4) return -2;
  if (score <= 8) return -1;
  if (score <= 12) return 0;
  if (score <= 15) return 1;
  return 2;
}

/** OSRIC / AD&D linear table: floor((score - 10) / 2). */
export function osrAdndAbilityModifier(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.floor((score - 10) / 2);
}

/** @deprecated Use {@link osrBxAbilityModifier} — kept for existing imports. */
export const osrAbilityModifier = osrBxAbilityModifier;

// ---------- Save categories ----------

/** Five B/X save categories (Basic Fantasy, Labyrinth Lord, OSRIC). */
export const OSR_BX_SAVES = [
  'Death Ray or Poison',
  'Magic Wands',
  'Paralysis or Petrify',
  'Dragon Breath',
  'Spells',
] as const;

/** Three OSE B/X save categories (DEX / WIS / CON). */
export const OSR_OSE_SAVES = ['DEX Save', 'WIS Save', 'CON Save'] as const;

/** @deprecated Use {@link OSR_BX_SAVES} — kept for existing imports. */
export const OSR_SAVES = OSR_BX_SAVES;
export type OsrSaveCategory = (typeof OSR_BX_SAVES)[number];

/**
 * Whether an OSR saving throw succeeds: roll d20, add any situational modifier, and
 * meet-or-beat the target number for the category.
 */
export function savingThrowSucceeds(roll: number, target: number, modifier = 0): boolean {
  if (roll <= 1) return false;
  if (roll >= 20) return true;
  return roll + modifier >= target;
}

// ---------- AC / to-hit: descending (THAC0) AND ascending, one normalized path ----------

/** Convert a descending armor class to its ascending equivalent (self-inverse: 19 - x). */
export function descendingToAscendingAc(descendingAc: number): number {
  return 19 - descendingAc;
}
/** Convert an ascending armor class to its descending equivalent (self-inverse: 19 - x). */
export function ascendingToDescendingAc(ascendingAc: number): number {
  return 19 - ascendingAc;
}
/** The ascending attack bonus exactly equivalent to a descending THAC0 (19 - THAC0). */
export function thac0ToAttackBonus(thac0: number): number {
  return 19 - thac0;
}
/** The descending THAC0 exactly equivalent to an ascending attack bonus (19 - bonus). */
export function attackBonusToThac0(attackBonus: number): number {
  return 19 - attackBonus;
}

export interface OsrAttack {
  roll: number;
  thac0: number;
  targetAc: number;
  mode: AcMode;
}

/** Whether an OSR attack hits, working identically in both AC conventions. */
export function osrAttackHits(attack: OsrAttack): boolean {
  if (attack.roll <= 1) return false;
  if (attack.roll >= 20) return true;
  const descendingAc = attack.mode === 'descending' ? attack.targetAc : ascendingToDescendingAc(attack.targetAc);
  return attack.roll >= attack.thac0 - descendingAc;
}

// ---------- Variant profiles (issue #765) ----------

export const OSR_CONDITIONS = [
  'Blinded',
  'Charmed',
  'Confused',
  'Deafened',
  'Feared',
  'Held',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Sleeping',
  'Stunned',
  'Unconscious',
] as const;

const OSR_STATBLOCK_PRESENTATION: StatblockPresentation = {
  rating: { full: 'Hit Dice', short: 'HD' },
  defense: { full: 'Armor Class', short: 'AC' },
  hitPoints: { full: 'Hit Points', short: 'HP' },
  abilities: { full: 'Abilities' },
  actions: { full: 'Actions' },
  creatureType: { full: 'Type' },
};

/** @deprecated Use per-adapter presentation — kept for existing imports. */
export { OSR_STATBLOCK_PRESENTATION };

export const OSR_VARIANT_PROFILES: Record<string, OsrMechanicsProfile> = {
  'basic-fantasy': {
    slug: 'basic-fantasy',
    label: 'Basic Fantasy RPG',
    mechanicsSummary:
      'Initiative d6 + DEX (individual) · B/X banded mods (±3) · 5 saves · descending AC (unarmored 9) · DEX tiebreak.',
    abilityTable: 'bx-banded',
    abilityCap: 3,
    saves: OSR_BX_SAVES,
    acMode: 'descending',
    acAnchor: 9,
    initiativeMode: 'individual',
    initiativeDie: 6,
    initiativeUsesDexMod: true,
    tiebreak: 'dex-then-order',
  },
  osric: {
    slug: 'osric',
    label: 'OSRIC',
    mechanicsSummary:
      'Initiative d6 (individual) · AD&D linear mods · 5 saves · descending AC (unarmored 10) · DEX tiebreak.',
    abilityTable: 'adnd-linear',
    abilityCap: 5,
    saves: OSR_BX_SAVES,
    acMode: 'descending',
    acAnchor: 10,
    initiativeMode: 'individual',
    initiativeDie: 6,
    initiativeUsesDexMod: false,
    tiebreak: 'dex-then-order',
  },
  'swords-wizardry': {
    slug: 'swords-wizardry',
    label: 'Swords & Wizardry',
    mechanicsSummary:
      'Initiative d6 per side (group) · S&W banded mods (±2) · 5 saves · ascending AC (unarmored 10) · order tiebreak.',
    abilityTable: 'sw-banded',
    abilityCap: 2,
    saves: OSR_BX_SAVES,
    acMode: 'ascending',
    acAnchor: 10,
    initiativeMode: 'group',
    initiativeDie: 6,
    initiativeUsesDexMod: false,
    tiebreak: 'order-only',
  },
  'labyrinth-lord': {
    slug: 'labyrinth-lord',
    label: 'Labyrinth Lord',
    mechanicsSummary:
      'Initiative d6 per side (group) · B/X banded mods (±3) · 5 saves · descending AC (unarmored 9) · order tiebreak.',
    abilityTable: 'bx-banded',
    abilityCap: 3,
    saves: OSR_BX_SAVES,
    acMode: 'descending',
    acAnchor: 9,
    initiativeMode: 'group',
    initiativeDie: 6,
    initiativeUsesDexMod: false,
    tiebreak: 'order-only',
  },
  'old-school-essentials': {
    slug: 'old-school-essentials',
    label: 'Old-School Essentials',
    mechanicsSummary:
      'Initiative d6 per side (group) · B/X banded mods (±3) · 3 saves (DEX/WIS/CON) · ascending AC (unarmored 10) · order tiebreak.',
    abilityTable: 'bx-banded',
    abilityCap: 3,
    saves: OSR_OSE_SAVES,
    acMode: 'ascending',
    acAnchor: 10,
    initiativeMode: 'group',
    initiativeDie: 6,
    initiativeUsesDexMod: false,
    tiebreak: 'order-only',
  },
  ose: {
    slug: 'ose',
    label: 'Old-School Essentials',
    mechanicsSummary:
      'Initiative d6 per side (group) · B/X banded mods (±3) · 3 saves (DEX/WIS/CON) · ascending AC (unarmored 10) · order tiebreak.',
    abilityTable: 'bx-banded',
    abilityCap: 3,
    saves: OSR_OSE_SAVES,
    acMode: 'ascending',
    acAnchor: 10,
    initiativeMode: 'group',
    initiativeDie: 6,
    initiativeUsesDexMod: false,
    tiebreak: 'order-only',
  },
  osr: {
    slug: 'osr',
    label: 'OSR (generic)',
    mechanicsSummary:
      'Initiative d6 + DEX (individual) · B/X banded mods (±3) · 5 saves · descending AC (unarmored 9) · DEX tiebreak.',
    abilityTable: 'bx-banded',
    abilityCap: 3,
    saves: OSR_BX_SAVES,
    acMode: 'descending',
    acAnchor: 9,
    initiativeMode: 'individual',
    initiativeDie: 6,
    initiativeUsesDexMod: true,
    tiebreak: 'dex-then-order',
  },
};

/** Resolve the native mechanics profile for a rule-pack slug (issue #765). */
export function osrMechanicsProfile(slug: string | null | undefined): OsrMechanicsProfile {
  if (slug && OSR_VARIANT_PROFILES[slug]) return OSR_VARIANT_PROFILES[slug];
  return OSR_VARIANT_PROFILES['basic-fantasy'];
}

/** Whether a slug is a known OSR variant. */
export function isOsrSlug(slug: string | null | undefined): slug is OsrRuleSystemSlug {
  return !!slug && (OSR_RULE_SYSTEM_SLUGS as readonly string[]).includes(slug);
}

// ---------- Migration preview (issue #765) ----------

export interface OsrMigrationPreview {
  fromSlug: string;
  toSlug: string;
  from: OsrMechanicsProfile;
  to: OsrMechanicsProfile;
  /** Human-readable list of mechanics that would change. */
  changes: string[];
}

/**
 * The change-detection at the heart of a migration preview, factored out (issue #1502) so it
 * runs over any two profile OBJECTS — not just two registry slugs — which is what a homebrew
 * campaign editing its own stored profile in place needs (there is no second slug to look up;
 * the "from" and "to" are the same slug's profile before/after the edit).
 */
/**
 * Element-wise list comparison. NOT `a.join() === b.join()`: a homebrew profile supplies its
 * own `saves` / `conditions` vocabulary as free text (issue #1502), so `['poison,death']` and
 * `['poison', 'death']` join to the same string and a real re-split of a save category would
 * be reported as "no change" in the migration preview a DM reads before committing.
 */
function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function diffMechanicsProfiles(from: OsrMechanicsProfile, to: OsrMechanicsProfile): string[] {
  const changes: string[] = [];
  if (from.abilityTable !== to.abilityTable) {
    changes.push(`Ability modifiers: ${from.abilityTable} (±${from.abilityCap}) → ${to.abilityTable} (±${to.abilityCap})`);
  }
  if (!sameStringList(from.saves, to.saves)) {
    changes.push(`Save categories: ${from.saves.length} (${from.saves.join(', ')}) → ${to.saves.length} (${to.saves.join(', ')})`);
  }
  if (from.acMode !== to.acMode || from.acAnchor !== to.acAnchor) {
    changes.push(`AC convention: ${from.acMode} (unarmored ${from.acAnchor}) → ${to.acMode} (unarmored ${to.acAnchor})`);
  }
  if (from.initiativeMode !== to.initiativeMode || from.initiativeUsesDexMod !== to.initiativeUsesDexMod) {
    const fromInit = from.initiativeMode === 'group' ? 'group d6 per side' : `individual d6${from.initiativeUsesDexMod ? ' + DEX' : ''}`;
    const toInit = to.initiativeMode === 'group' ? 'group d6 per side' : `individual d6${to.initiativeUsesDexMod ? ' + DEX' : ''}`;
    changes.push(`Initiative: ${fromInit} → ${toInit}`);
  }
  if (from.tiebreak !== to.tiebreak) {
    changes.push(`Initiative ties: ${from.tiebreak === 'dex-then-order' ? 'higher DEX first' : 'insertion order'} → ${to.tiebreak === 'dex-then-order' ? 'higher DEX first' : 'insertion order'}`);
  }
  const fromConditions = from.conditions ?? OSR_CONDITIONS;
  const toConditions = to.conditions ?? OSR_CONDITIONS;
  if (!sameStringList(fromConditions, toConditions)) {
    changes.push(`Conditions: ${fromConditions.length} (${fromConditions.join(', ')}) → ${toConditions.length} (${toConditions.join(', ')})`);
  }
  if (changes.length === 0) changes.push('No mechanics changes — profiles are identical.');
  return changes;
}

/** Preview how combat math would change when migrating a campaign between OSR variants. */
export function previewOsrMigration(fromSlug: string, toSlug: string): OsrMigrationPreview {
  const from = osrMechanicsProfile(fromSlug);
  const to = osrMechanicsProfile(toSlug);
  return { fromSlug: from.slug, toSlug: to.slug, from, to, changes: diffMechanicsProfiles(from, to) };
}

/**
 * Same diff, over two arbitrary mechanics profile OBJECTS rather than two registry slugs
 * (issue #1502) — the seam a homebrew campaign's "you edited your rules, here's what shifts"
 * preview needs when comparing its OWN stored profile before/after an in-place edit, which
 * {@link previewOsrMigration}'s slug-keyed lookup cannot express (both sides would resolve to
 * the same registered slug). Reuses the exact same change-detection {@link previewOsrMigration}
 * uses, so the two never drift.
 */
export function previewMechanicsProfileMigration(from: OsrMechanicsProfile, to: OsrMechanicsProfile): OsrMigrationPreview {
  return { fromSlug: from.slug, toSlug: to.slug, from, to, changes: diffMechanicsProfiles(from, to) };
}

// ---------- Adapter factory ----------

function abilityFnFor(profile: OsrMechanicsProfile): (score: number) => number {
  switch (profile.abilityTable) {
    case 'sw-banded':
      return osrSwAbilityModifier;
    case 'adnd-linear':
      return osrAdndAbilityModifier;
    default:
      return osrBxAbilityModifier;
  }
}

function osrDexScore(abilities: Record<string, unknown> | null | undefined): number | null {
  if (!abilities) return null;
  const raw = abilities.DEX ?? abilities.dexterity ?? abilities.dex;
  return typeof raw === 'number' ? raw : null;
}

function preferredAc(d: Record<string, unknown>, profile: OsrMechanicsProfile): number | undefined {
  const asc = d.armorClassAscending ?? d.ascendingArmorClass ?? d.aac;
  const desc = d.armorClass ?? d.armor_class ?? d.ac;
  if (profile.acMode === 'ascending') {
    if (typeof asc === 'number') return asc;
    if (typeof desc === 'number') return descendingToAscendingAc(desc);
    return undefined;
  }
  // Descending-native: store descending AC in the armorClass slot for display consistency.
  if (typeof desc === 'number') return desc;
  if (typeof asc === 'number') return ascendingToDescendingAc(asc);
  return undefined;
}

/** Build a native RuleSystemAdapter for one OSR variant profile (issue #765). */
export function createOsrVariantAdapter(profile: OsrMechanicsProfile): RuleSystemAdapter {
  const abilityFn = abilityFnFor(profile);
  const tiebreak = profile.tiebreak === 'dex-then-order' ? initModDescThenSortOrderAsc : sortOrderAscTiebreak;
  return {
    id: profile.slug,
    label: profile.label,
    presentation: OSR_STATBLOCK_PRESENTATION,
    characterSheet: {
      abilityFields: [
        { key: 'STR', label: 'STR' },
        { key: 'DEX', label: 'DEX' },
        { key: 'CON', label: 'CON' },
        { key: 'INT', label: 'INT' },
        { key: 'WIS', label: 'WIS' },
        { key: 'CHA', label: 'CHA' },
      ],
      classField: { label: 'Class', placeholder: 'Class', required: true, visible: true },
      supportsSavingThrowEditor: true,
      supportsSkillEditor: false,
      supportsSpellSlotEditor: false,
      genericModeDescription:
        'OSR sheets use native ability math and concise actions/resources; Campfire does not expose the fixed 5e skill list or spell-slot pips for this ruleset.',
    },
    abilityModifier: abilityFn,
    initiativeDie: profile.initiativeDie,
    maxLevel: Infinity,
    initiativeModel: {
      mode: profile.initiativeMode,
      usesDexModifier: profile.initiativeUsesDexMod,
    },
    initiativeModifier(
      abilities: Record<string, unknown> | null | undefined,
      representation: AbilityRepresentation = 'score',
    ): number {
      if (!profile.initiativeUsesDexMod) return 0;
      const dex = osrDexScore(abilities);
      if (dex === null) return 0;
      return representation === 'score' ? abilityFn(dex) : Math.trunc(dex);
    },
    initiativeTiebreak: tiebreak,
    // A homebrew profile's OWN vocabulary (issue #1502) when it declares one; every built-in
    // OSR profile omits `conditions` and keeps the shared OSR_CONDITIONS list unchanged.
    conditions: profile.conditions ?? OSR_CONDITIONS,
    /**
     * This variant's OWN attack roll (issue #1598), via {@link osrAttackHits} — the function
     * this file already provided but nothing called. `osrAttackHits` reads the ATTACKER'S
     * THAC0, which this codebase does not store per-character; `attackBonusToThac0` derives an
     * equivalent THAC0 from the resolver's already-computed ascending-style `modifier` instead
     * (an ability modifier from a d20-shaped `computeAttackModifier`), so no new stored field is
     * needed and the two representations stay provably interchangeable (the pair is a bijection
     * — see the round-trip test in osr-adapter.spec.ts). `roll` stays the NATURAL d20 face
     * (never nat+modifier) because `osrAttackHits`' own nat-1-always-misses/nat-20-always-hits
     * rule is defined in terms of the die face, exactly like the 5e path it replaces.
     *
     * No separate crit tier, on purpose: base OSR rules (B/X, OSRIC, Labyrinth Lord, OSE) have
     * no critical-hit multiplier — a natural 20 always hits (already inside `osrAttackHits`) but
     * does not double damage by the written rules. Reporting a nat-20 as `crit` here would
     * invent a house rule this adapter has no authority to assume, the same "assume one
     * system's convention" mistake #1598 exists to close on the OTHER side of the comparison.
     */
    resolveAttack(input: AttackRollInput): AttackRollResult {
      const r = input.roll('1d20');
      const naturalRoll = r.rolls[0] ?? r.total;
      const thac0 = attackBonusToThac0(input.modifier);
      const hit = osrAttackHits({ roll: naturalRoll, thac0, targetAc: input.targetAc, mode: profile.acMode });
      const total = naturalRoll + input.modifier;
      return {
        total,
        naturalRoll,
        outcome: hit ? 'hit' : 'miss',
        targetLabel:
          profile.acMode === 'descending'
            ? `ascending AC ${descendingToAscendingAc(input.targetAc)} (descending AC ${input.targetAc})`
            : undefined,
      };
    },
    mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
      const abilityScores = (d.abilityScores ?? d.ability_scores) as Record<string, unknown> | undefined;
      return {
        size: d.size,
        creatureType: d.type ?? d.creatureType ?? d.category,
        challengeRating: d.hitDice ?? d.hit_dice ?? d.hd ?? d.challengeRating,
        armorClass: preferredAc(d, profile),
        hitPoints: d.hitPoints ?? d.hit_points ?? d.hp,
        speed: d.movement ?? d.speed,
        abilityScores: abilityScores && typeof abilityScores === 'object' ? abilityScores : undefined,
        abilityRepresentation: 'score',
        specialAbilities: d.specialAbilities ?? d.special_abilities ?? d.abilities,
        actions: d.actions ?? d.attacks,
      };
    },
    monsterHitPoints(d: Record<string, unknown>): number | null {
      const hp = d.hitPoints ?? d.hit_points ?? d.hp;
      return typeof hp === 'number' && hp > 0 ? Math.round(hp) : null;
    },
  };
}

// ---------- Homebrew mechanics profile (issue #1502) ----------
// `createOsrVariantAdapter` above already manufactures a complete RuleSystemAdapter from 13
// pure-data fields — no functions — selecting behavior from closed enums rather than executing
// arbitrary code. The six built-in OSR variants (and the OSR_CONDITIONS default) prove the shape
// works; the only thing making it a fixed list rather than a homebrew system builder is that
// nothing validates and accepts an ARBITRARY caller-supplied profile. `HomebrewMechanicsProfile`
// is that runtime-validated boundary — every field is the exact same closed-enum/data shape as
// `OsrMechanicsProfile`, so a persisted or uploaded profile can never smuggle in unvetted code,
// only a selection among already-audited strategies (ability table, save list, AC convention,
// initiative model, tiebreak, optional condition vocabulary).

/** Runtime-validated general mechanics profile a homebrew rule system persists (issue #1502). */
export const HomebrewMechanicsProfile = z
  .object({
    slug: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    mechanicsSummary: z.string().max(500).default(''),
    abilityTable: z.enum(['bx-banded', 'sw-banded', 'adnd-linear']),
    abilityCap: z.number().int().min(1).max(10),
    saves: z.array(z.string().min(1).max(80)).min(1).max(12),
    acMode: z.enum(['descending', 'ascending']),
    acAnchor: z.number().int().min(0).max(30),
    initiativeMode: z.enum(['individual', 'group']),
    initiativeDie: z.number().int().min(2).max(100),
    initiativeUsesDexMod: z.boolean(),
    tiebreak: z.enum(['dex-then-order', 'order-only']),
    // Optional own condition vocabulary (see OsrMechanicsProfile.conditions above). Omit to
    // keep the shared OSR_CONDITIONS list.
    conditions: z.array(z.string().min(1).max(60)).min(1).max(40).optional(),
  })
  .strict();
export type HomebrewMechanicsProfile = z.infer<typeof HomebrewMechanicsProfile>;

/**
 * Validate an arbitrary (persisted, uploaded, or hand-authored) profile and build its
 * RuleSystemAdapter (issue #1502) — the widened, runtime-checked entry point onto the exact
 * same factory the six built-in OSR variants already use. Throws a ZodError (out-of-enum
 * strategy value, missing field, wrong type) rather than silently accepting malformed input.
 */
export function createHomebrewRuleSystemAdapter(rawProfile: unknown): RuleSystemAdapter {
  const profile = HomebrewMechanicsProfile.parse(rawProfile);
  return createOsrVariantAdapter(profile);
}

/**
 * Non-throwing sibling for RESOLUTION (review). `ruleSystemAdapter` runs on hot read paths —
 * a character sheet, a turn, a statblock render — and must never throw, so it cannot use the
 * parsing factory above. But it must not skip validation either: the server reads the stored
 * profile with an unchecked `JSON.parse` cast, so a row written by an older version, restored
 * from a backup, repaired by hand, or (once import carries the field) supplied by an untrusted
 * export document would otherwise ride straight into the combat-math seam — where an unknown
 * `abilityTable` silently degrades to `bx-banded` rather than being rejected.
 *
 * `null` means "this profile is not usable"; the caller falls back to its own default, which
 * is the same thing that happens when no profile is stored at all. Returning the default
 * rather than throwing keeps a malformed row from taking down every read of the campaign.
 */
export function tryCreateHomebrewRuleSystemAdapter(rawProfile: unknown): RuleSystemAdapter | null {
  const parsed = HomebrewMechanicsProfile.safeParse(rawProfile);
  return parsed.success ? createOsrVariantAdapter(parsed.data) : null;
}

// ---------- Per-variant adapter exports ----------

export const BasicFantasyAdapter = createOsrVariantAdapter(OSR_VARIANT_PROFILES['basic-fantasy']);
export const OsricAdapter = createOsrVariantAdapter(OSR_VARIANT_PROFILES.osric);
export const SwordsWizardryAdapter = createOsrVariantAdapter(OSR_VARIANT_PROFILES['swords-wizardry']);
export const LabyrinthLordAdapter = createOsrVariantAdapter(OSR_VARIANT_PROFILES['labyrinth-lord']);
export const OldSchoolEssentialsAdapter = createOsrVariantAdapter(OSR_VARIANT_PROFILES['old-school-essentials']);
export const OseAdapter = createOsrVariantAdapter(OSR_VARIANT_PROFILES.ose);

/** Map from rule-pack slug → native adapter (issue #765). */
export const OSR_VARIANT_ADAPTERS: Record<string, RuleSystemAdapter> = {
  'basic-fantasy': BasicFantasyAdapter,
  osric: OsricAdapter,
  'swords-wizardry': SwordsWizardryAdapter,
  'labyrinth-lord': LabyrinthLordAdapter,
  'old-school-essentials': OldSchoolEssentialsAdapter,
  ose: OseAdapter,
  osr: createOsrVariantAdapter(OSR_VARIANT_PROFILES.osr),
};

/**
 * @deprecated Use per-variant adapters via {@link OSR_VARIANT_ADAPTERS} or
 * {@link ruleSystemAdapter}(slug). Kept as an alias for BasicFantasyAdapter.
 */
export const OsrAdapter = BasicFantasyAdapter;
