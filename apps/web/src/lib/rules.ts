/**
 * Compendium / rule-pack + rule-SYSTEM metadata. The domain types themselves
 * (RulePack, RuleEntry, RuleEntryType, RulePackInstall, RulePackInstallSource,
 * RulePackInstallSection, OsrInstallSystem) live in @campfire/schema — import
 * those directly.
 *
 * This module is the single web-side source of truth (#347/#348) mapping each
 * installable rule SOURCE to: its display name + license + blurb, the section
 * checkboxes valid for THAT source, the pack slug the importer installs it
 * under, and a one-line mechanics summary (initiative / ability-mod / DC model /
 * conditions / degree-of-success). RulePacksCard (install picker), the campaign
 * wizard and campaign settings all consume it so the copy stays consistent.
 *
 * It is deliberately SOURCE-AWARE and resilient (#346 wires the real upstream
 * sources in parallel): the section vocabulary per source mirrors the server's
 * RulesService.SECTIONS_BY_SOURCE, and SOURCES_REQUIRING_URL mirrors the
 * server's dead/absent-default gate — a source that needs a mirror URL is
 * surfaced honestly with a URL field rather than a broken install button.
 */
import type { RulePackInstallSection, RulePackInstallSource, OsrInstallSystem, CustomMechanicsProfile, RuleSystemAdapter } from '@campfire/schema';
import {
  actionEconomyForAdapter,
  ddbImportSupported,
  DND5E_ADAPTER_ID,
  DND5E_PACK_SLUG,
  encounterDifficultySupported,
  OPEN_LEGEND_PACK_SLUG,
  PF2E_PACK_SLUG,
  SF2E_PACK_SLUG,
  PF1E_PACK_SLUG,
  STARFINDER_ADAPTER_ID,
  OSR_RULE_SYSTEM_SLUGS,
  osrMechanicsProfile,
  ruleSystemAdapter,
} from '@campfire/schema';

/** The Open5e/5e-shaped section list — kept for callers that only need the 5e vocabulary. */
export const RULE_SECTIONS = ['spells', 'monsters', 'items', 'conditions', 'classes', 'races', 'feats'] as const;
export type RuleSection = (typeof RULE_SECTIONS)[number];

/** Display label for every member of the RulePackInstallSection union. */
export const SECTION_LABELS: Record<RulePackInstallSection, string> = {
  spells: 'Spells',
  monsters: 'Monsters',
  items: 'Items',
  conditions: 'Conditions',
  classes: 'Classes',
  races: 'Races',
  feats: 'Feats',
  equipment: 'Equipment',
  starships: 'Starships',
  vehicles: 'Vehicles',
  creatures: 'Creatures',
  ancestries: 'Ancestries',
  backgrounds: 'Backgrounds',
  hazards: 'Hazards',
  deities: 'Deities',
  rituals: 'Rituals',
  planes: 'Planes',
  curses: 'Curses',
  diseases: 'Diseases',
  banes: 'Banes',
  boons: 'Boons',
  // Datasworn / Ironsworn: Starforged (issue #405)
  npcs: 'NPCs',
  assets: 'Assets',
  moves: 'Moves',
  oracles: 'Oracles',
  truths: 'Truths',
};

/** Human label for a section name (falls back to a title-cased raw value for anything unknown). */
export function sectionLabel(section: string): string {
  return SECTION_LABELS[section as RulePackInstallSection] ?? section.charAt(0).toUpperCase() + section.slice(1);
}

/**
 * Sources whose default upstream API is dead/placeholder or absent (tracked in #346) and
 * therefore require the admin to pass an explicit mirror/self-hosted `url`. Mirrors the
 * server's RulesService.SOURCES_REQUIRING_URL — the single gate. When #346 validates a live
 * default for one of these, delete it from this set (a one-line change) and it becomes a
 * plain one-click install.
 */
export const SOURCES_REQUIRING_URL = new Set<RulePackInstallSource>(['pf1e', 'starfinder', 'archmage', 'osr']);

export interface OsrVariantMeta {
  value: OsrInstallSystem;
  label: string;
  /** Pack slug this variant installs under (== OsrSource.systemSlug server-side). */
  slug: string;
  license: string;
}

/** The OSR retroclone variants the single `osr` importer can install under (issue #345). */
export const OSR_VARIANTS: OsrVariantMeta[] = [
  { value: 'basic-fantasy', label: 'Basic Fantasy RPG', slug: 'basic-fantasy', license: 'CC-BY-SA-4.0' },
  { value: 'osric', label: 'OSRIC', slug: 'osric', license: 'OGL 1.0a' },
  { value: 'swords-wizardry', label: 'Swords & Wizardry', slug: 'swords-wizardry', license: 'OGL 1.0a' },
  { value: 'labyrinth-lord', label: 'Labyrinth Lord', slug: 'labyrinth-lord', license: 'OGL 1.0a' },
  { value: 'old-school-essentials', label: 'Old-School Essentials', slug: 'old-school-essentials', license: 'OGL 1.0a' },
];

export interface RuleSystemMeta {
  /** Install-endpoint `source` key. */
  source: RulePackInstallSource;
  /** Display name shown in pickers. */
  label: string;
  /** Upstream + license label. */
  license: string;
  /** One-line description of the system / its content. */
  blurb: string;
  /** One-line mechanics summary: initiative · ability mod · DC model · conditions · degrees. */
  mechanics: string;
  /** Section checkboxes valid for THIS source (mirrors server SECTIONS_BY_SOURCE). */
  sections: RulePackInstallSection[];
  /**
   * Pack slug the importer installs this system under — what a campaign's `ruleSystem`
   * holds, so an installed pack can be matched back to its system. For OSR this is the
   * default (basic-fantasy) variant; use `osrVariants` for the full set.
   */
  packSlug: string;
  /** Whether this source needs an explicit mirror URL (see SOURCES_REQUIRING_URL). */
  requiresUrl: boolean;
  /** OSR only: the retroclone variant sub-select. */
  osrVariants?: OsrVariantMeta[];
}

const FIVE_E_SECTIONS: RulePackInstallSection[] = ['spells', 'monsters', 'items', 'conditions', 'classes', 'races', 'feats'];
const AON_SECTIONS: RulePackInstallSection[] = [
  'creatures',
  'spells',
  'equipment',
  'feats',
  'ancestries',
  'classes',
  'backgrounds',
  'conditions',
  'vehicles',
  'hazards',
  'deities',
  'rituals',
  'planes',
  'curses',
  'diseases',
];

/**
 * Every installable rule system, in picker order. `sections` mirror the server's
 * RulesService.SECTIONS_BY_SOURCE exactly (a section the server would 400 is never
 * offered). The back-compat-only `other` placeholder source is intentionally omitted —
 * it isn't a user-facing system.
 */
export const RULE_SYSTEMS: RuleSystemMeta[] = [
  {
    source: 'open5e',
    label: 'D&D 5e SRD',
    license: 'Open5e · OGL 1.0a',
    blurb: 'The D&D 5e System Reference Document pulled from the open Open5e API.',
    mechanics: 'Initiative d20 + DEX · ability mod ⌊(score−10)/2⌋ · fixed DCs · 5e conditions · pass/fail.',
    sections: FIVE_E_SECTIONS,
    packSlug: 'open5e-srd',
    requiresUrl: SOURCES_REQUIRING_URL.has('open5e'),
  },
  {
    source: 'pf2e',
    label: 'Pathfinder 2e',
    license: 'Archives of Nethys · ORC / OGL',
    blurb: 'Open rules and setting reference content from Archives of Nethys. Adventure, scenario, and story publications are excluded.',
    mechanics: 'Initiative d20 + Perception · proficiency adds your level · level-based DCs · PF2e conditions · four degrees of success.',
    sections: AON_SECTIONS,
    packSlug: PF2E_PACK_SLUG,
    requiresUrl: SOURCES_REQUIRING_URL.has('pf2e'),
  },
  {
    source: 'sf2e',
    label: 'Starfinder 2e',
    license: 'Archives of Nethys · ORC / OGL',
    blurb: 'Open rules and setting reference content from Archives of Nethys. Adventure, scenario, and story publications are excluded.',
    mechanics: 'Initiative d20 + Perception · proficiency adds your level · level-based DCs · PF2e-style mechanics & conditions · four degrees of success.',
    sections: AON_SECTIONS,
    packSlug: SF2E_PACK_SLUG,
    requiresUrl: SOURCES_REQUIRING_URL.has('sf2e'),
  },
  {
    source: 'pf1e',
    label: 'Pathfinder 1e SRD',
    license: 'OGL 1.0a',
    blurb: 'The Pathfinder 1e (3.x-lineage) System Reference Document.',
    mechanics: 'Initiative d20 + DEX · d20/3.x math · CMB/CMD & fixed DCs · Pathfinder conditions · pass/fail.',
    sections: FIVE_E_SECTIONS,
    packSlug: PF1E_PACK_SLUG,
    requiresUrl: SOURCES_REQUIRING_URL.has('pf1e'),
  },
  {
    source: 'starfinder',
    label: 'Starfinder 1e',
    license: 'OGL 1.0a',
    blurb: 'Starfinder 1e SRD — science-fantasy, adds equipment, starships and vehicles.',
    mechanics: 'Initiative d20 + DEX · KAC/EAC armor classes · fixed DCs · Starfinder conditions · pass/fail.',
    sections: ['spells', 'monsters', 'equipment', 'conditions', 'classes', 'races', 'feats', 'starships', 'vehicles'],
    packSlug: STARFINDER_ADAPTER_ID, // 'starfinder-1e'
    requiresUrl: SOURCES_REQUIRING_URL.has('starfinder'),
  },
  {
    source: 'archmage',
    label: '13th Age (Archmage SRD)',
    license: 'OGL 1.0a',
    blurb: 'The 13th Age / Archmage Engine SRD — monsters and conditions.',
    mechanics: 'Initiative d20 + DEX · escalation die raises PC attacks each round · fixed DCs · 13th Age conditions · pass/fail.',
    sections: ['monsters', 'conditions'],
    packSlug: 'archmage-srd',
    requiresUrl: SOURCES_REQUIRING_URL.has('archmage'),
  },
  {
    source: 'open-legend',
    label: 'Open Legend',
    license: 'Community codex · OGL',
    blurb: 'Open Legend — attribute-driven, classless; adds banes, boons and feats.',
    mechanics: 'Action rolls are exploding attribute dice pools (not d20+mod) · attribute IS its own modifier · banes & boons instead of conditions.',
    // Mirrors the server's SECTIONS_BY_SOURCE['open-legend'] (ALL_OPEN_LEGEND_SECTIONS) exactly —
    // the only three sections that exist as open data. Offering creatures/items here made the
    // one-click install 400 before any job enqueued (issue #380).
    sections: ['boons', 'banes', 'feats'],
    packSlug: OPEN_LEGEND_PACK_SLUG,
    requiresUrl: SOURCES_REQUIRING_URL.has('open-legend'),
  },
  {
    source: 'osr',
    label: 'OSR retroclones',
    license: 'Per-variant (CC-BY-SA / OGL)',
    blurb: 'Old-school B/X retroclones — pick a variant below.',
    mechanics: 'Initiative d6 (side/individual) · banded ability modifiers (±3) · ascending/descending AC · OSR condition subset · pass/fail.',
    sections: ['monsters', 'spells', 'items', 'conditions'],
    packSlug: 'basic-fantasy',
    requiresUrl: SOURCES_REQUIRING_URL.has('osr'),
    osrVariants: OSR_VARIANTS,
  },
  {
    source: 'cepheus',
    label: 'Cepheus Engine SRD',
    license: 'orffen/cepheus-srd · OGL 1.0a',
    blurb: 'Cepheus Engine — a Classic-Era 2D6 science-fiction SRD, imported as section-level rules text from its mdBook Markdown.',
    mechanics: 'Task resolution is 2D6 + characteristic DM + skill vs. a target of 8+ · reference text only (no combat adapter — falls back to 5e turn order).',
    // Cepheus imports the whole SRD; its mdBook "books" are not a per-statblock section
    // filter (the server rejects a foreign `sections` value), so the picker offers no
    // section checkboxes — mirroring RulesService.SECTIONS_BY_SOURCE['cepheus'].
    sections: [],
    packSlug: 'cepheus-srd',
    requiresUrl: SOURCES_REQUIRING_URL.has('cepheus'),
  },
  {
    source: 'datasworn',
    label: 'Ironsworn: Starforged',
    license: 'datasworn · CC-BY-4.0',
    blurb:
      'Ironsworn: Starforged via the canonical datasworn dataset — a PbtA sci-fi reference pack. ' +
      'NPCs import as statblocks; assets, moves, oracles and truths import as reference sections.',
    mechanics:
      'PbtA/narrative: no initiative/AC/levels — action rolls vs oracles & moves. Imported as reference text, with NPCs as the one statblock section.',
    sections: ['npcs', 'assets', 'moves', 'oracles', 'truths'],
    packSlug: 'ironsworn-starforged',
    requiresUrl: SOURCES_REQUIRING_URL.has('datasworn'),
  },
];

/** Metadata for an install source, or undefined for a non-picker source ('other'). */
export function ruleSystemBySource(source: RulePackInstallSource): RuleSystemMeta | undefined {
  return RULE_SYSTEMS.find((s) => s.source === source);
}

/**
 * Match an installed pack's slug back to its rule-system metadata (for usage/mechanics
 * display). Handles the OSR family, whose several variant slugs all map to the one OSR meta.
 * Returns undefined for a slug we don't recognise (e.g. a generic uploaded pack).
 */
export function ruleSystemForPackSlug(slug: string | null | undefined): RuleSystemMeta | undefined {
  if (!slug) return undefined;
  const direct = RULE_SYSTEMS.find((s) => s.packSlug === slug);
  if (direct) return direct;
  if ((OSR_RULE_SYSTEM_SLUGS as readonly string[]).includes(slug)) return RULE_SYSTEMS.find((s) => s.source === 'osr');
  return undefined;
}

/** One-line mechanics summary for a pack slug, or undefined if the system isn't recognised. */
export function mechanicsForPackSlug(slug: string | null | undefined): string | undefined {
  if (slug && (OSR_RULE_SYSTEM_SLUGS as readonly string[]).includes(slug)) {
    return osrMechanicsProfile(slug).mechanicsSummary;
  }
  return ruleSystemForPackSlug(slug)?.mechanics;
}

/**
 * Helper to resolve the rule system adapter for a campaign object, including its
 * optional custom mechanics profile (issue #2003).
 */
export function ruleSystemAdapterForCampaign(
  campaign?: { ruleSystem?: string | null; customMechanicsProfile?: CustomMechanicsProfile | null } | null,
): RuleSystemAdapter {
  return ruleSystemAdapter(campaign?.ruleSystem, campaign?.customMechanicsProfile);
}

/**
 * The rule-system label a campaign's `ruleSystem` slug resolves to for COMBAT — via the
 * schema's adapter registry, which falls back to D&D 5e for any unknown/removed slug. Use
 * this to explain what an unrecognised (e.g. uninstalled) slug actually behaves as.
 */
export function ruleSystemAdapterLabel(
  slug: string | null | undefined,
  customMechanicsProfile?: CustomMechanicsProfile | null,
): string {
  return ruleSystemAdapter(slug ?? '', customMechanicsProfile).label;
}

export type RulesetCapabilityStatus = 'available' | 'fallback' | 'limited' | 'unavailable';

export interface RulesetCapability {
  key:
    | 'compendium'
    | 'characterMath'
    | 'combatMath'
    | 'encounterGeneration'
    | 'difficulty'
    | 'actions'
    | 'ai'
    | 'ddb';
  label: string;
  status: RulesetCapabilityStatus;
  summary: string;
}

export interface RulesetCapabilityProfile {
  slug: string;
  name: string;
  isHomebrew: boolean;
  adapterLabel: string;
  mechanicsSummary: string;
  migrationPreview: string[];
  capabilities: RulesetCapability[];
}

const CAPABILITY_STATUS_LABEL: Record<RulesetCapabilityStatus, string> = {
  available: 'Available',
  fallback: 'Fallback',
  limited: 'Limited',
  unavailable: 'Unavailable',
};

export function capabilityStatusLabel(status: RulesetCapabilityStatus): string {
  return CAPABILITY_STATUS_LABEL[status];
}

function hasNativeAdapter(slug: string): boolean {
  if (!slug) return false;
  if (slug === DND5E_ADAPTER_ID || slug === DND5E_PACK_SLUG || slug === 'dnd5e' || slug === 'open5e') return true;
  return ruleSystemAdapter(slug).id !== DND5E_ADAPTER_ID;
}

function actionEconomySummary(slug: string, native: boolean): { status: RulesetCapabilityStatus; summary: string } {
  const adapter = ruleSystemAdapter(slug);
  const actions = actionEconomyForAdapter(adapter).slots.map((slot) => slot.label).join(', ');
  if (!native) {
    return {
      status: 'fallback',
      summary: `Uses ${adapter.label} fallback turn slots (${actions}) and condition suggestions.`,
    };
  }
  return {
    status: 'available',
    summary: `Uses ${adapter.label} turn slots (${actions}) and condition suggestions.`,
  };
}

export function homebrewCapabilities(): RulesetCapabilityProfile {
  const fallbackAdapter = ruleSystemAdapter('');
  const actionSummary = actionEconomySummary('', false);
  return {
    slug: '',
    name: 'None / homebrew',
    isHomebrew: true,
    adapterLabel: fallbackAdapter.label,
    mechanicsSummary:
      `No installed rules text. Combat math falls back to ${fallbackAdapter.label} defaults; this does not select a 5e rules pack.`,
    migrationPreview: [
      'Settings can attach an installed rules pack later without deleting sheets, notes, encounters or combatants.',
      'Adding a pack enables that pack compendium, rules lookups, AI context and any native action/difficulty math it supports.',
      `Until then, combat uses ${fallbackAdapter.label} fallback math and actions, while D&D Beyond import stays hidden because no explicit 5e pack is selected.`,
    ],
    capabilities: [
      {
        key: 'compendium',
        label: 'Compendium and rules lookup',
        status: 'unavailable',
        summary: 'No rules entries, monsters, spells or source text are installed for this campaign.',
      },
      {
        key: 'characterMath',
        label: 'Character math',
        status: 'fallback',
        summary: `Generic sheets still work, but ability modifiers and progression math use ${fallbackAdapter.label} fallback defaults where the app needs a rule model.`,
      },
      {
        key: 'combatMath',
        label: 'Combat math',
        status: 'fallback',
        summary: `Initiative, condition suggestions and statblock interpretation fall back to ${fallbackAdapter.label}.`,
      },
      {
        key: 'encounterGeneration',
        label: 'Encounter generation',
        status: 'limited',
        summary: 'No pack monsters or hazards are available to search; use manual combatants or provide your own statblocks.',
      },
      {
        key: 'difficulty',
        label: 'Difficulty estimates',
        status: encounterDifficultySupported('') ? 'fallback' : 'unavailable',
        summary: `Difficulty uses ${fallbackAdapter.label} XP/CR fallback when the combatants have compatible data; otherwise it remains unknown.`,
      },
      {
        key: 'actions',
        label: 'Actions and conditions',
        status: actionSummary.status,
        summary: actionSummary.summary,
      },
      {
        key: 'ai',
        label: 'AI rules context',
        status: 'limited',
        summary: 'AI can use campaign notes and your prompt, but has no installed rules pack to cite or retrieve from.',
      },
      {
        key: 'ddb',
        label: 'D&D Beyond import',
        status: ddbImportSupported('') ? 'available' : 'unavailable',
        summary: 'Hidden until you select an explicit D&D 5e-compatible pack.',
      },
    ],
  };
}

export function rulePackCapabilities(pack: {
  slug: string;
  name: string;
  entryCount: number;
}): RulesetCapabilityProfile {
  const native = hasNativeAdapter(pack.slug);
  const adapter = ruleSystemAdapter(pack.slug);
  const actionSummary = actionEconomySummary(pack.slug, native);
  const compendiumAvailable = pack.entryCount > 0;
  const ddbAvailable = ddbImportSupported(pack.slug);
  const difficultyAvailable = encounterDifficultySupported(pack.slug);
  const adapterCopy = native
    ? adapter.label
    : `${adapter.label} fallback because this pack does not have a native combat adapter`;
  return {
    slug: pack.slug,
    name: pack.name,
    isHomebrew: false,
    adapterLabel: adapter.label,
    mechanicsSummary:
      mechanicsForPackSlug(pack.slug) ??
      `Rules text is installed; combat math uses ${adapterCopy}.`,
    migrationPreview: [
      'Settings can switch to another installed pack or back to None / homebrew later.',
      'Switching keeps existing sheets, notes, encounters and combatants, but changes how stored stats are interpreted.',
      'Compendium results, AI rules context, action economy, difficulty and D&D Beyond import availability update to the newly selected system.',
    ],
    capabilities: [
      {
        key: 'compendium',
        label: 'Compendium and rules lookup',
        status: compendiumAvailable ? 'available' : 'unavailable',
        summary: compendiumAvailable
          ? `${pack.entryCount} installed entries can power search, reader pages and rules lookup.`
          : 'The pack is installed but currently has no entries to search.',
      },
      {
        key: 'characterMath',
        label: 'Character math',
        status: native ? 'available' : 'fallback',
        summary: native
          ? `Character calculations use the ${adapter.label} adapter.`
          : `Character calculations use ${adapter.label} fallback defaults because this pack has no native adapter.`,
      },
      {
        key: 'combatMath',
        label: 'Combat math',
        status: native ? 'available' : 'fallback',
        summary: native
          ? `Initiative, conditions and statblock interpretation use ${adapter.label}.`
          : `Initiative, conditions and statblock interpretation fall back to ${adapter.label}.`,
      },
      {
        key: 'encounterGeneration',
        label: 'Encounter generation',
        status: compendiumAvailable ? 'available' : 'limited',
        summary: compendiumAvailable
          ? 'Generator and add-combatant search can draw on matching compendium monsters or hazards when the pack provides them.'
          : 'No pack monsters or hazards are available; use manual combatants or provide your own statblocks.',
      },
      {
        key: 'difficulty',
        label: 'Difficulty estimates',
        status: difficultyAvailable ? (native ? 'available' : 'fallback') : 'unavailable',
        summary: difficultyAvailable
          ? native || adapter.id !== DND5E_ADAPTER_ID
            ? `Difficulty uses ${adapter.label} encounter math when combatants have compatible data.`
            : `Difficulty uses ${adapter.label} fallback XP/CR math when combatants have compatible data.`
          : `${adapter.label} does not provide automatic encounter difficulty math; judge balance manually.`,
      },
      {
        key: 'actions',
        label: 'Actions and conditions',
        status: actionSummary.status,
        summary: actionSummary.summary,
      },
      {
        key: 'ai',
        label: 'AI rules context',
        status: compendiumAvailable ? 'available' : 'limited',
        summary: compendiumAvailable
          ? 'AI rules lookup can retrieve and cite this pack alongside campaign notes.'
          : 'AI can use campaign notes and prompts, but this pack has no rules entries to retrieve.',
      },
      {
        key: 'ddb',
        label: 'D&D Beyond import',
        status: ddbAvailable ? 'available' : 'unavailable',
        summary: ddbAvailable
          ? 'D&D Beyond character import is available because this is an explicit 5e-compatible pack.'
          : 'D&D Beyond import stays hidden for this ruleset.',
      },
    ],
  };
}

export function rulesetCapabilitiesForSelection(
  slug: string | null | undefined,
  packs: Array<{ slug: string; name: string; entryCount: number }> | null | undefined,
): RulesetCapabilityProfile {
  if (!slug) return homebrewCapabilities();
  const pack = packs?.find((p) => p.slug === slug);
  if (pack) return rulePackCapabilities(pack);
  return rulePackCapabilities({ slug, name: slug, entryCount: 0 });
}
