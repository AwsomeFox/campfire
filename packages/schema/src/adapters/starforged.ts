/**
 * Ironsworn: Starforged rule-system adapter (issue #405).
 *
 * Starforged is imported (from the canonical rsek/datasworn CC-BY-4.0 dataset) as a selectable
 * rule pack under the slug `ironsworn-starforged`. Without a registered adapter,
 * `ruleSystemAdapter()` falls back to `Dnd5eAdapter` for any unregistered slug, so a campaign
 * that picked Starforged would silently inherit D&D 5e combat mechanics — a d20 initiative
 * roll, Armor Class, a 20-level cap, the 5e ability-modifier curve, and the 5e condition chips.
 * Starforged is a PbtA / narrative game with none of those concepts, so that fallback is wrong.
 * This adapter is the minimal, honest NEUTRAL implementation that keeps the pack off the 5e path.
 *
 * Design (Starforged is PbtA / narrative — NOT d20):
 *  - Presentation: NEUTRAL (Rating / Defense / …), never 5e's "Challenge" / "Armor Class".
 *  - No d20 initiative. Starforged has no initiative roll at all; the shared seam still
 *    requires a die for the generic roller, so this reports the d6 *action die* Starforged
 *    actually uses — never a d20 — and `initiativeModifier` is a flat 0 (there is no
 *    DEX-style governing attribute to derive one from). Ties preserve add order.
 *  - No level cap. Starforged tracks advancement through legacy tracks, not levels, so
 *    `maxLevel` is Infinity (like Open Legend / OSR) — a `level >= maxLevel` gate never trips.
 *  - Ability values are used directly (identity), not run through 5e's floor((score-10)/2).
 *  - Conditions are Starforged's own IMPACTS vocabulary (see STARFORGED_IMPACTS), not the
 *    5e list.
 *  - Statblocks (imported NPCs) carry a narrative RANK and NATURE, not AC / HP / CR /
 *    ability scores — `mapStatblock` surfaces exactly what exists and leaves the 5e-shaped
 *    numeric fields undefined, and `monsterHitPoints` is always null (NPCs have no HP pool).
 *  - Does NOT opt into `supportsDdbImport` or `supportsEncounterDifficulty`, so the D&D
 *    Beyond import affordance and the 5e XP-budget difficulty estimate stay off for it.
 */
import type {
  AbilityRepresentation,
  MonsterStatblockData,
  RuleSystemAdapter,
  StatblockPresentation,
} from '../index';
import { sortOrderAscTiebreak } from '../initiative-tiebreak';

/** Family id of the Starforged adapter (not a pack slug). */
export const STARFORGED_ADAPTER_ID = 'starforged';

/**
 * Rule-pack slug the datasworn importer installs Starforged under — what a campaign's
 * `ruleSystem` holds. MUST stay in sync with `DATASWORN_PACK_SLUG` in the server's
 * apps/server/src/modules/rules/datasworn-importer.ts (the schema package cannot import
 * from the server, so the value is mirrored here as the schema-side source of truth the
 * ADAPTERS registry keys on, exactly as the sibling *_PACK_SLUG constants do).
 */
export const STARFORGED_PACK_SLUG = 'ironsworn-starforged';

/**
 * Starforged's IMPACTS — its narrative status vocabulary, the analogue of 5e's conditions
 * (offered as the combat-UI chips and validated for non-DM condition adds). These are the
 * standard impacts from the CC-BY-4.0 Starforged text, grouped as misfortunes, lasting
 * effects, burdens, and vehicle impacts. Deliberately NOT the 5e CONDITIONS list.
 */
export const STARFORGED_IMPACTS = [
  // Misfortunes
  'Wounded',
  'Shaken',
  'Unprepared',
  // Lasting effects
  'Permanently Harmed',
  'Traumatized',
  // Burdens
  'Doomed',
  'Tormented',
  'Indebted',
  // Vehicle
  'Battered',
  'Cursed',
] as const;
export type StarforgedImpact = (typeof STARFORGED_IMPACTS)[number];

/**
 * Neutral / narrative statblock labels for Starforged. Intentionally the same NEUTRAL copy
 * (Rating / Defense / …) the resolver uses for unknown packs — Starforged has no 5e-style
 * Challenge / Armor Class, so it must never surface that jargon. Defined locally (not imported
 * from ../index) to match the sibling-adapter pattern and avoid a runtime import cycle; kept in
 * lockstep with NEUTRAL_STATBLOCK_PRESENTATION in ../index by intent. Satisfies the #763
 * invariant that every registered adapter exposes complete presentation metadata.
 */
export const STARFORGED_STATBLOCK_PRESENTATION: StatblockPresentation = {
  rating: { full: 'Rating' },
  defense: { full: 'Defense' },
  hitPoints: { full: 'Hit Points', short: 'HP' },
  abilities: { full: 'Abilities' },
  actions: { full: 'Actions' },
  creatureType: { full: 'Type' },
};

/**
 * The neutral / narrative Starforged adapter. Every member is the least-surprising, safe
 * default for a PbtA reference pack — nothing here reproduces 5e combat behavior.
 */
export const StarforgedAdapter: RuleSystemAdapter = {
  id: STARFORGED_ADAPTER_ID,
  label: 'Ironsworn: Starforged',
  // Neutral labels (Rating / Defense / …) — never the 5e "Challenge" / "Armor Class" copy the
  // unknown-slug fallback would otherwise have produced (issue #763).
  presentation: STARFORGED_STATBLOCK_PRESENTATION,
  // Starforged stats (0–4) are used directly; there is no 5e score→modifier curve. Identity
  // (truncated) — mirrors Open Legend's "the attribute IS its modifier" treatment.
  abilityModifier(score: number): number {
    return Number.isFinite(score) ? Math.trunc(score) : 0;
  },
  // No d20 initiative in Starforged. The seam still needs a die for the generic roller; the
  // d6 action die is the honest narrative choice — anything but the 5e d20.
  initiativeDie: 6,
  // No levels. Advancement is via legacy tracks, so there is no hard character-level cap;
  // Infinity means a `level >= maxLevel` check never blocks (issue #535), like Open Legend / OSR.
  maxLevel: Infinity,
  // No governing attribute drives turn order — always 0 (never invent a DEX-style modifier).
  initiativeModifier(
    _abilities: Record<string, unknown> | null | undefined,
    _representation: AbilityRepresentation = 'native',
    _level?: number,
  ): number {
    return 0;
  },
  // With a flat 0 initiative modifier there is nothing to sort by, so preserve add order
  // (PF2e-style) rather than re-sorting on a DEX proxy.
  initiativeTiebreak: sortOrderAscTiebreak,
  // Starforged impacts, NOT the 5e condition list.
  conditions: STARFORGED_IMPACTS,
  // Imported NPCs carry a narrative rank + nature, not AC / HP / CR / ability scores. Surface
  // what exists (rank as the difficulty proxy in the rating slot, nature as the type) and leave
  // the 5e-shaped numeric fields undefined so nothing fabricates a 5e statblock.
  mapStatblock(d: Record<string, unknown>): MonsterStatblockData {
    return {
      size: d.size,
      creatureType: d.nature ?? d.creatureType ?? d.type,
      // Ironsworn RANK (troublesome → epic) is the narrative difficulty proxy — no CR exists.
      challengeRating: d.rank ?? d.challengeRating,
      armorClass: undefined, // no Armor Class in Starforged
      hitPoints: undefined, // NPCs track no HP pool
      speed: undefined,
      abilityScores: undefined, // no ability-score block
      abilityRepresentation: 'native',
      specialAbilities: d.features ?? d.specialAbilities,
      actions: d.tactics ?? d.actions,
    };
  },
  // Starforged NPCs have no hit-point pool — always null (the encounter layer already
  // handles a null max HP for statblocks that don't carry one).
  monsterHitPoints(): number | null {
    return null;
  },
};
