/**
 * Ruleset-guided character creation (issue #719).
 *
 * Starter templates, completion checklist, and draft-vs-active resolution shared by
 * the API, the party roster form, and the character sheet.
 */
import type { Character, CharacterAction, RuleSystemAdapter, SkillRank, SpellSlotLevel } from './index';
// Value import from action-resolver.ts directly (not './index') — same reasoning as
// combatant-statblock.ts: index.ts re-exports this module, so a runtime import FROM index.ts
// here would be circular.
import { ActionSpec } from './action-resolver';

const DND5E_ADAPTER_ID = 'dnd5e';
const OPEN_LEGEND_ADAPTER_ID = 'open-legend';
const PF2E_ADAPTER_ID = 'pf2e';
const STARFINDER_ADAPTER_ID = 'starfinder-1e';
const DND5E_ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
const OPEN_LEGEND_ABILITY_KEYS = [
  'AGILITY',
  'FORTITUDE',
  'MIGHT',
  'LEARNING',
  'LOGIC',
  'PERCEPTION',
  'WILL',
  'DECEPTION',
  'PERSUASION',
  'PRESENCE',
  'ALTERATION',
  'CREATION',
  'ENERGY',
  'ENTROPY',
  'INFLUENCE',
  'MOVEMENT',
  'PRESCIENCE',
  'PROTECTION',
] as const;

function dnd5eProficiencyBonus(level: number): number {
  return Math.floor((level - 1) / 4) + 2;
}

export type CharacterCreationPath = 'template' | 'blank';

export interface CharacterStarterTemplate {
  id: string;
  label: string;
  /** Plain-language summary of what this template sets up. */
  description: string;
  className: string;
  stats: Record<string, number>;
  ac: number | null;
  eac?: number | null;
  kac?: number | null;
  hpMax: number;
  saveProficiencies: string[];
  skills: Record<string, SkillRank>;
  actions: CharacterAction[];
  /** Human-readable breakdown lines shown in the creation UI. */
  breakdown: string[];
  /**
   * Starting spell slots (issue #1932), keyed "1".."9". Omitted entirely for a non-caster
   * archetype — `characterCreateFromTemplate` only writes the field when a template sets it,
   * so a martial template's sheet keeps the schema's empty-object default rather than an
   * explicit `{}` that would falsely claim "this archetype was checked for slots".
   */
  spellSlots?: Record<string, SpellSlotLevel>;
}

export interface CharacterChecklistItem {
  id: string;
  label: string;
  description: string;
  done: boolean;
}

/** Ability keys the sheet expects for a given adapter family. */
export function abilityKeysForAdapter(adapter: RuleSystemAdapter): readonly string[] {
  return adapter.characterSheet?.abilityFields.map((field) => field.key) ?? DND5E_ABILITY_KEYS;
}

export function abilityLabelForAdapter(adapter: RuleSystemAdapter, key: string): string {
  return adapter.characterSheet?.abilityFields.find((field) => field.key === key)?.label ?? key;
}

function classFieldForAdapter(adapter: RuleSystemAdapter) {
  return adapter.characterSheet?.classField ?? { label: 'Class', placeholder: 'Class', required: true, visible: true };
}

export function classRequiredForAdapter(adapter: RuleSystemAdapter): boolean {
  const field = classFieldForAdapter(adapter);
  return field.visible && field.required;
}

function hasDefense(
  character: Pick<Character, 'ac' | 'eac' | 'kac'>,
  adapter: RuleSystemAdapter,
): boolean {
  if (adapter.id === STARFINDER_ADAPTER_ID) {
    return character.eac != null || character.kac != null;
  }
  return character.ac != null;
}

function hasAbilityScores(
  character: Pick<Character, 'stats'>,
  adapter: RuleSystemAdapter,
): boolean {
  const keys = abilityKeysForAdapter(adapter);
  return keys.every((key) => {
    const v = character.stats[key] ?? character.stats[key.toLowerCase()];
    return typeof v === 'number' && Number.isFinite(v);
  });
}

/** Whether a sheet has the combat essentials needed to join encounters as an active PC. */
export function isCharacterSheetComplete(
  character: Pick<Character, 'stats' | 'ac' | 'eac' | 'kac' | 'hpMax' | 'className' | 'name'>,
  adapter: RuleSystemAdapter,
): boolean {
  if (!character.name?.trim()) return false;
  if (classRequiredForAdapter(adapter) && !character.className?.trim()) return false;
  if (character.hpMax < 1) return false;
  if (!hasDefense(character, adapter)) return false;
  return hasAbilityScores(character, adapter);
}

function checklistDefenseLabel(adapter: RuleSystemAdapter): string {
  if (adapter.id === STARFINDER_ADAPTER_ID) {
    return 'Energy and kinetic armor class (EAC / KAC)';
  }
  const defense = adapter.presentation?.defense;
  if (!defense) return 'Defense';
  return defense.short ? `${defense.full} (${defense.short})` : defense.full;
}

/** Completion checklist for draft characters — plain-language, ruleset-aware. */
export function characterCompletionChecklist(
  character: Character,
  adapter: RuleSystemAdapter,
): CharacterChecklistItem[] {
  const defenseLabel = checklistDefenseLabel(adapter);
  const classField = classFieldForAdapter(adapter);

  const items: CharacterChecklistItem[] = [
    {
      id: 'name',
      label: 'Character name',
      description: 'Every hero needs a name your table will recognize.',
      done: Boolean(character.name?.trim()),
    },
    {
      id: 'abilities',
      label: adapter.presentation?.abilities.full ?? 'Ability scores',
      description: `Set each ${adapter.label} ${adapter.presentation?.abilities.full.toLowerCase() ?? 'ability'} so rolls use your numbers, not placeholders.`,
      done: hasAbilityScores(character, adapter),
    },
    {
      id: 'defense',
      label: defenseLabel,
      description: 'Armor class (or equivalent) tells the table how hard you are to hit.',
      done: hasDefense(character, adapter),
    },
    {
      id: 'hp',
      label: 'Hit points',
      description: 'Maximum HP tracks how much damage you can take before going down.',
      done: character.hpMax >= 1,
    },
    {
      id: 'actions',
      label: 'At least one action',
      description: 'Attacks, spells, or features you can use in play (optional but recommended).',
      done: (character.actions?.length ?? 0) > 0,
    },
  ];
  if (classField.visible && classField.required) {
    items.splice(1, 0, {
      id: 'class',
      label: classField.label,
      description: 'What kind of character are they — fighter, wizard, operative, etc.?',
      done: Boolean(character.className?.trim()),
    });
  }
  return items;
}

/** True when a create payload only carries identity fields — no combat numbers yet. */
export function isMinimalCharacterCreate(input: {
  status?: Character['status'];
  hpMax?: number;
  hpCurrent?: number;
  ac?: number | null;
  eac?: number | null;
  kac?: number | null;
  // Issue #1910 review (Codex, PR #1980, round 5): a `{ name, speed }` create is a combat-data
  // create by the same argument that put `speed` next to ac/eac/kac in the schema in the first
  // place — omitting it here made that create silently land as `draft` with 0/0 HP (skipped by
  // encounter auto-add) instead of `active` with the legacy 10/10 default, unlike an otherwise-
  // equivalent `{ name, ac }` create.
  speed?: number | null;
  stats?: Record<string, number>;
}): boolean {
  if (input.status !== undefined) return false;
  const hasCombatData =
    (input.hpMax != null && input.hpMax > 0) ||
    (input.hpCurrent != null && input.hpCurrent > 0) ||
    input.ac != null ||
    input.eac != null ||
    input.kac != null ||
    input.speed != null ||
    (input.stats != null && Object.keys(input.stats).length > 0);
  return !hasCombatData;
}

/** Resolve lifecycle status for a new character when the caller omitted it. */
export function resolveCharacterCreateStatus(
  input: {
    status?: Character['status'];
    hpMax?: number;
    hpCurrent?: number;
    ac?: number | null;
    eac?: number | null;
    kac?: number | null;
    speed?: number | null;
    stats?: Record<string, number>;
    name?: string;
    className?: string;
    deathState?: Character['deathState'];
  },
  _adapter: RuleSystemAdapter,
): Character['status'] {
  if (input.status) return input.status;
  if (input.deathState === 'dead') return 'dead';
  // Name-only party-page creates become drafts; API callers that already pass combat
  // numbers without an explicit status keep the historical active default (issue #719).
  if (isMinimalCharacterCreate(input)) return 'draft';
  return 'active';
}

function dnd5eHpMax(level: number, conScore: number): number {
  const conMod = Math.floor((conScore - 10) / 2);
  // Level 1: max hit die + CON; each additional level: average die + CON.
  const first = 10 + conMod;
  const perLevel = 6 + conMod;
  return Math.max(1, first + Math.max(0, level - 1) * perLevel);
}

function dnd5eLongswordAction(prof: number, strMod: number): CharacterAction {
  const toHit = signed(prof + strMod);
  const dmgMod = strMod;
  return {
    name: 'Longsword',
    kind: 'melee',
    toHit,
    damage: `1d8${dmgMod ? signed(dmgMod) : ''} slashing`,
    targetAc: 'AC',
    notes: 'Starter melee attack — edit on the sheet after creation.',
    // Issue #1932: a resolvable spec (same bonus the toHit text already shows — one
    // source, not a second hand-computed copy) so this action carries a one-tap Use
    // button immediately, not just freeform prose.
    spec: ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: toHit },
      cost: { slot: 'action', count: 1 },
      targets: { count: 1, allow: 'enemy' },
      outcomes: { hit: { damage: [{ formula: '1d8', flat: dmgMod, type: 'slashing' }] } },
    }),
  };
}

function dnd5eGreataxeAction(prof: number, strMod: number): CharacterAction {
  const toHit = signed(prof + strMod);
  const dmgMod = strMod;
  return {
    name: 'Greataxe',
    kind: 'melee',
    toHit,
    damage: `1d12${dmgMod ? signed(dmgMod) : ''} slashing`,
    targetAc: 'AC',
    notes: 'Starter melee attack — edit on the sheet after creation.',
    spec: ActionSpec.parse({
      mode: 'attack',
      attack: { bonus: toHit },
      cost: { slot: 'action', count: 1 },
      targets: { count: 1, allow: 'enemy' },
      outcomes: { hit: { damage: [{ formula: '1d12', flat: dmgMod, type: 'slashing' }] } },
    }),
  };
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function dnd5eTemplates(level: number): CharacterStarterTemplate[] {
  const prof = dnd5eProficiencyBonus(level);
  const fighterStats = { STR: 16, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 };
  const wizardStats = { STR: 8, DEX: 14, CON: 14, INT: 16, WIS: 12, CHA: 10 };
  const rogueStats = { STR: 10, DEX: 16, CON: 14, INT: 12, WIS: 12, CHA: 10 };
  const barbarianStats = { STR: 17, DEX: 13, CON: 16, INT: 8, WIS: 10, CHA: 8 };
  const fighterCon = fighterStats.CON;
  const fighterHp = dnd5eHpMax(level, fighterCon);
  const wizardHp = dnd5eHpMax(level, wizardStats.CON);
  const rogueHp = dnd5eHpMax(level, rogueStats.CON);
  const barbarianHp = dnd5eHpMax(level, barbarianStats.CON);
  const fighterStrMod = Math.floor((fighterStats.STR - 10) / 2);
  const fighterDexMod = Math.floor((fighterStats.DEX - 10) / 2);
  const rogueDexMod = Math.floor((rogueStats.DEX - 10) / 2);
  const wizardIntMod = Math.floor((wizardStats.INT - 10) / 2);
  const barbarianStrMod = Math.floor((barbarianStats.STR - 10) / 2);
  const barbarianDexMod = Math.floor((barbarianStats.DEX - 10) / 2);
  const barbarianConMod = Math.floor((barbarianStats.CON - 10) / 2);
  const rapierToHit = signed(prof + rogueDexMod);
  const fireBoltToHit = signed(prof + wizardIntMod);
  // 5e spell save DC = 8 + proficiency + spellcasting ability modifier.
  const wizardSpellSaveDc = 8 + prof + wizardIntMod;

  return [
    {
      id: '5e-fighter',
      label: 'Fighter (armored striker)',
      description: 'A durable front-liner with chain mail, a longsword, and strong physical saves.',
      className: 'Fighter',
      stats: fighterStats,
      ac: 18,
      hpMax: fighterHp,
      saveProficiencies: ['STR', 'CON'],
      skills: { Athletics: 'proficient', Perception: 'proficient' },
      actions: [dnd5eLongswordAction(prof, fighterStrMod)],
      breakdown: [
        `AC 18 = chain mail (16) + shield (+2) — Dex bonus capped by medium armor`,
        `HP ${fighterHp} = level ${level} fighter hit dice + CON modifier (+${Math.floor((fighterCon - 10) / 2)})`,
        `Attack ${signed(prof + fighterStrMod)} = proficiency (+${prof}) + STR (${signed(fighterStrMod)})`,
        'Saving throws: proficient in STR and CON',
      ],
    },
    {
      id: '5e-wizard',
      label: 'Wizard (arcane caster)',
      description: 'A scholarly spellcaster with light armor expectations and strong mental saves.',
      className: 'Wizard',
      stats: wizardStats,
      ac: 12,
      hpMax: wizardHp,
      saveProficiencies: ['INT', 'WIS'],
      skills: { Arcana: 'proficient', Investigation: 'proficient' },
      actions: [
        {
          name: 'Fire Bolt',
          kind: 'spell',
          toHit: fireBoltToHit,
          damage: '1d10 fire',
          targetAc: 'AC',
          notes: 'Ranged spell attack cantrip — edit spell list on the sheet after creation.',
          // Issue #1932: at-will cantrip — no spellLevel cost (uses.spellLevel defaults 0).
          spec: ActionSpec.parse({
            mode: 'attack',
            attack: { bonus: fireBoltToHit },
            cost: { slot: 'action', count: 1 },
            targets: { count: 1, allow: 'enemy' },
            outcomes: { hit: { damage: [{ formula: '1d10', flat: 0, type: 'fire' }] } },
          }),
        },
        {
          name: 'Burning Hands',
          kind: 'spell',
          toHit: `DC ${wizardSpellSaveDc} DEX`,
          damage: '3d6 fire (half on save)',
          targetAc: 'DEX save',
          notes: '1st-level spell — a 15-ft cone; targets in it make a DEX save. Consumes a 1st-level spell slot.',
          spec: ActionSpec.parse({
            mode: 'save',
            save: { ability: 'DEX', dc: { kind: 'fixed', dc: wizardSpellSaveDc } },
            cost: { slot: 'action', count: 1 },
            uses: { spellLevel: 1 },
            range: { range: 'self', shape: 'cone', size: '15 ft' },
            targets: { count: 0, allow: 'enemy' },
            outcomes: {
              failure: { damage: [{ formula: '3d6', flat: 0, type: 'fire' }] },
              success: { halfDamage: true },
            },
          }),
        },
      ],
      // Issue #1932: a level-1 wizard has two 1st-level slots — enough for Burning Hands
      // above to show real slot pips (max/used), not just a described cost.
      spellSlots: { '1': { max: 2, used: 0 } },
      breakdown: [
        `AC 12 = 10 + DEX modifier (+${Math.floor((wizardStats.DEX - 10) / 2)})`,
        `HP ${wizardHp} = level ${level} wizard hit dice + CON modifier`,
        `Spell attack ${fireBoltToHit} = proficiency + INT`,
        `Spell save DC ${wizardSpellSaveDc} = 8 + proficiency + INT`,
        'Saving throws: proficient in INT and WIS',
      ],
    },
    {
      id: '5e-rogue',
      label: 'Rogue (skilled striker)',
      description: 'A nimble scout with leather armor, finesse weapons, and expertise-ready skills.',
      className: 'Rogue',
      stats: rogueStats,
      ac: 15,
      hpMax: rogueHp,
      saveProficiencies: ['DEX', 'INT'],
      skills: { Stealth: 'expertise', Perception: 'proficient', Acrobatics: 'proficient' },
      actions: [
        {
          name: 'Rapier',
          kind: 'melee',
          toHit: rapierToHit,
          damage: `1d8${rogueDexMod ? signed(rogueDexMod) : ''} piercing`,
          targetAc: 'AC',
          notes: 'Finesse melee attack using DEX.',
          spec: ActionSpec.parse({
            mode: 'attack',
            attack: { bonus: rapierToHit },
            cost: { slot: 'action', count: 1 },
            targets: { count: 1, allow: 'enemy' },
            outcomes: { hit: { damage: [{ formula: '1d8', flat: rogueDexMod, type: 'piercing' }] } },
          }),
        },
      ],
      breakdown: [
        `AC 15 = leather armor (11) + DEX (+${rogueDexMod})`,
        `HP ${rogueHp} = level ${level} rogue hit dice + CON modifier`,
        `Attack ${rapierToHit} = DEX (${signed(rogueDexMod)}) + proficiency (+${prof})`,
        'Stealth starts at expertise; other skills at proficiency',
      ],
    },
    {
      id: '5e-barbarian',
      label: 'Barbarian (reckless brute)',
      description: 'A hard-hitting melee brute — the highest HP of the starting archetypes, unarmored but tough.',
      className: 'Barbarian',
      stats: barbarianStats,
      // Unarmored Defense: 10 + DEX modifier + CON modifier.
      ac: 10 + barbarianDexMod + barbarianConMod,
      hpMax: barbarianHp,
      saveProficiencies: ['STR', 'CON'],
      skills: { Athletics: 'proficient', Perception: 'proficient' },
      actions: [dnd5eGreataxeAction(prof, barbarianStrMod)],
      breakdown: [
        `AC ${10 + barbarianDexMod + barbarianConMod} = 10 (unarmored defense) + DEX (${signed(barbarianDexMod)}) + CON (${signed(barbarianConMod)})`,
        `HP ${barbarianHp} = level ${level} barbarian hit dice + CON modifier (+${barbarianConMod})`,
        `Attack ${signed(prof + barbarianStrMod)} = proficiency (+${prof}) + STR (${signed(barbarianStrMod)})`,
        'Saving throws: proficient in STR and CON',
      ],
    },
  ];
}

function pf2eTemplates(level: number): CharacterStarterTemplate[] {
  const prof = Math.floor((level + 7) / 4) + 2; // trained proficiency at level
  const championStats = { STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 10 };
  const wizardStats = { STR: 10, DEX: 14, CON: 14, INT: 18, WIS: 12, CHA: 10 };
  const strMod = Math.floor((championStats.STR - 10) / 2);
  const intMod = Math.floor((wizardStats.INT - 10) / 2);
  const hpChampion = 20 + (level - 1) * 8;
  const hpWizard = 12 + (level - 1) * 5;

  return [
    {
      id: 'pf2e-champion',
      label: 'Champion (armored martial)',
      description: 'A heavily armored defender with high AC and strong Fortitude/Reflex training.',
      className: 'Champion',
      stats: championStats,
      ac: 10 + prof + Math.floor((championStats.DEX - 10) / 2) + 4,
      hpMax: hpChampion,
      saveProficiencies: ['STR', 'CON'],
      skills: { Athletics: 'proficient', Religion: 'proficient' },
      actions: [
        {
          name: 'Longsword',
          kind: 'melee',
          toHit: signed(prof + strMod),
          damage: '1d8 slashing',
          targetAc: 'AC',
          notes: 'Starter melee strike — adjust for your exact gear on the sheet.',
        },
      ],
      breakdown: [
        `AC includes level (+${prof}) + Dex + armor — PF2e uses proficiency tiers`,
        `HP ${hpChampion} ≈ champion base + per-level gains at level ${level}`,
        `Attack +${prof + strMod} = trained proficiency (+${prof}) + STR (${signed(strMod)})`,
      ],
    },
    {
      id: 'pf2e-wizard',
      label: 'Wizard (arcane caster)',
      description: 'A frail but accurate spellcaster with high spell DCs and mental defenses.',
      className: 'Wizard',
      stats: wizardStats,
      ac: 10 + prof + Math.floor((wizardStats.DEX - 10) / 2),
      hpMax: hpWizard,
      saveProficiencies: ['INT', 'WIS'],
      skills: { Arcana: 'proficient', Occultism: 'proficient' },
      actions: [
        {
          name: 'Telekinetic Projectile',
          kind: 'spell',
          toHit: signed(prof + intMod),
          damage: '1d6 bludgeoning',
          targetAc: 'AC',
          notes: 'Cantrip attack — add your spell repertoire on the sheet.',
        },
      ],
      breakdown: [
        `AC = 10 + level-based proficiency + Dex (unarmored)`,
        `HP ${hpWizard} ≈ wizard base + per-level gains at level ${level}`,
        `Spell attack +${prof + intMod} = trained proficiency + INT`,
      ],
    },
  ];
}

function openLegendTemplates(): CharacterStarterTemplate[] {
  const nativeStats = (scores: Partial<Record<(typeof OPEN_LEGEND_ABILITY_KEYS)[number], number>>) =>
    Object.fromEntries(OPEN_LEGEND_ABILITY_KEYS.map((key) => [key, scores[key] ?? 0])) as Record<string, number>;
  const warriorStats = nativeStats({ MIGHT: 5, AGILITY: 4, FORTITUDE: 5, LEARNING: 2, LOGIC: 2, PERCEPTION: 3, WILL: 3, MOVEMENT: 2, PRESENCE: 1 });
  const mageStats = nativeStats({ MIGHT: 2, AGILITY: 3, FORTITUDE: 3, LEARNING: 5, LOGIC: 5, PERCEPTION: 3, WILL: 4, ENERGY: 5, CREATION: 3, PROTECTION: 2 });
  return [
    {
      id: 'ol-warrior',
      label: 'Physical hero',
      description: 'Classless Open Legend template with high Might and Fortitude for melee pools; Guard defense from armor training.',
      className: '',
      stats: warriorStats,
      ac: 18,
      hpMax: 28,
      saveProficiencies: [],
      skills: {},
      actions: [
        {
          name: 'Melee strike',
          kind: 'melee',
          toHit: `${warriorStats.MIGHT}`,
          damage: 'Might vs Guard',
          targetAc: 'Guard',
          notes: 'Open Legend uses attribute scores directly — edit feats and banes on the sheet.',
        },
      ],
      breakdown: [
        'Attributes are rolled as exploding dice pools (Might 5 → 1d10 + 1d4)',
        'Guard 18 ≈ 10 + Fortitude (5) + armor training (+3)',
        'HP 28 = 20 + 2× Fortitude (5) per Open Legend baseline',
      ],
    },
    {
      id: 'ol-mage',
      label: 'Arcane hero',
      description: 'Classless Open Legend template with high Learning, Logic, and Energy for invocation pools.',
      className: '',
      stats: mageStats,
      ac: 14,
      hpMax: 20,
      saveProficiencies: [],
      skills: {},
      actions: [
        {
          name: 'Fire blast',
          kind: 'spell',
          toHit: `${mageStats.LEARNING}`,
          damage: 'Energy vs Guard',
          targetAc: 'Guard',
          notes: 'Energy attacks use your Energy attribute — set banes/boons on the sheet.',
        },
      ],
      breakdown: [
        'Learning/Logic drive your invocation dice pools',
        'Guard 14 = 10 + Fortitude (3) + light wards (+1)',
        'HP 20 = baseline 20 for a less-tough caster build',
      ],
    },
  ];
}

function homebrewTemplates(level: number): CharacterStarterTemplate[] {
  return dnd5eTemplates(level).map((t) => ({
    ...t,
    id: `homebrew-${t.id}`,
    description: `${t.description} (Uses ${DND5E_ADAPTER_ID} math — adjust for your homebrew table.)`,
  }));
}

/** Starter templates offered for the campaign's active ruleset. */
export function starterTemplatesForAdapter(adapter: RuleSystemAdapter, level = 1): CharacterStarterTemplate[] {
  switch (adapter.id) {
    case PF2E_ADAPTER_ID:
      return pf2eTemplates(level);
    case OPEN_LEGEND_ADAPTER_ID:
      return openLegendTemplates();
    case DND5E_ADAPTER_ID:
      return dnd5eTemplates(level);
    default:
      return homebrewTemplates(level);
  }
}

export function findStarterTemplate(
  adapter: RuleSystemAdapter,
  templateId: string,
  level = 1,
): CharacterStarterTemplate | undefined {
  return starterTemplatesForAdapter(adapter, level).find((t) => t.id === templateId);
}

/** Build a CharacterCreate-shaped payload from a starter template. */
export function characterCreateFromTemplate(
  template: CharacterStarterTemplate,
  opts: { name: string; species?: string; level: number; status?: Character['status'] },
): {
  name: string;
  species: string;
  className: string;
  level: number;
  status: Character['status'];
  stats: Record<string, number>;
  ac: number | null;
  eac: number | null;
  kac: number | null;
  hpMax: number;
  hpCurrent: number;
  saveProficiencies: string[];
  skills: Record<string, SkillRank>;
  actions: CharacterAction[];
  // Issue #1932: only present when the template declares starting slots (the caster
  // archetypes) — omitted entirely for a martial template, never an explicit `{}` that
  // would falsely claim "checked, no slots" for an archetype the caster question never
  // applies to.
  spellSlots?: Record<string, SpellSlotLevel>;
} {
  return {
    name: opts.name.trim(),
    species: opts.species?.trim() ?? '',
    className: template.className,
    level: opts.level,
    status: opts.status ?? 'draft',
    stats: { ...template.stats },
    ac: template.ac,
    eac: template.eac ?? null,
    kac: template.kac ?? null,
    hpMax: template.hpMax,
    hpCurrent: template.hpMax,
    saveProficiencies: [...template.saveProficiencies],
    skills: { ...template.skills },
    actions: template.actions.map((a) => ({ ...a })),
    ...(template.spellSlots ? { spellSlots: { ...template.spellSlots } } : {}),
  };
}

/** Blank-sheet create payload — intentionally incomplete, always a draft. */
export function blankCharacterCreate(opts: {
  name: string;
  species?: string;
  className?: string;
  level: number;
}): {
  name: string;
  species: string;
  className: string;
  level: number;
  status: 'draft';
  stats: Record<string, number>;
  ac: null;
  hpMax: number;
  hpCurrent: number;
} {
  return {
    name: opts.name.trim(),
    species: opts.species?.trim() ?? '',
    className: opts.className?.trim() ?? '',
    level: opts.level,
    status: 'draft',
    stats: {},
    ac: null,
    hpMax: 0,
    hpCurrent: 0,
  };
}
