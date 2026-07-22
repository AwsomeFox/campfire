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
import type { RulePackInstallSection, RulePackInstallSource, OsrInstallSystem } from '@campfire/schema';
import {
  OPEN_LEGEND_PACK_SLUG,
  PF2E_PACK_SLUG,
  SF2E_PACK_SLUG,
  PF1E_PACK_SLUG,
  STARFINDER_ADAPTER_ID,
  OSR_RULE_SYSTEM_SLUGS,
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
  banes: 'Banes',
  boons: 'Boons',
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
    blurb: 'Pathfinder 2e (remaster) content from the Archives of Nethys open dataset.',
    mechanics: 'Initiative d20 + Perception · proficiency adds your level · level-based DCs · PF2e conditions · four degrees of success.',
    // PF2e accepts the 5e-shaped section names (the importer imports its full set regardless).
    sections: FIVE_E_SECTIONS,
    packSlug: PF2E_PACK_SLUG,
    requiresUrl: SOURCES_REQUIRING_URL.has('pf2e'),
  },
  {
    source: 'sf2e',
    label: 'Starfinder 2e',
    license: 'Archives of Nethys · ORC / OGL',
    blurb: 'Starfinder 2e (remaster/playtest) content from the Archives of Nethys open dataset.',
    mechanics: 'Initiative d20 + Perception · proficiency adds your level · level-based DCs · PF2e-style mechanics & conditions · four degrees of success.',
    sections: FIVE_E_SECTIONS,
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
  return ruleSystemForPackSlug(slug)?.mechanics;
}

/**
 * The rule-system label a campaign's `ruleSystem` slug resolves to for COMBAT — via the
 * schema's adapter registry, which falls back to D&D 5e for any unknown/removed slug. Use
 * this to explain what an unrecognised (e.g. uninstalled) slug actually behaves as.
 */
export function ruleSystemAdapterLabel(slug: string | null | undefined): string {
  return ruleSystemAdapter(slug ?? '').label;
}
