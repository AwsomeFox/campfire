/**
 * Default compendium icon derivation (issue #305).
 *
 * Rule entries imported from Open5e (or uploaded) don't carry an icon, but the
 * compendium list + reader want an on-theme game-icons.net glyph for every entry so
 * the screen is scannable at a glance. Rather than store a slug on every one of the
 * thousands of imported rows, we derive a sensible default here on the client from the
 * entry's `type` plus the structured hints in `dataJson` (spell school, monster type,
 * item category) — the same game-icons vocabulary the bundled catalog (#302) already
 * uses. A DM can still override any entry with `RuleEntry.iconSlug`; that override wins.
 *
 * Every slug returned here is a member of the bundled catalog, and <GameIcon> renders
 * nothing for an unknown slug, so a shrunk catalog degrades gracefully to no icon.
 */
import type { RuleEntry, RuleEntryType } from '@campfire/schema';
import { isKnownIcon } from './icons';

/** Fallback glyph per entry type when no more specific hint is available. */
const TYPE_DEFAULT: Record<RuleEntryType, string> = {
  spell: 'spell-book',
  monster: 'death-skull',
  item: 'chest',
  condition: 'aura',
  class: 'wizard-staff',
  race: 'meeple',
  feat: 'laurel-crown',
  section: 'open-book',
  other: 'open-book',
};

/** D&D spell school -> spell-school/arcane glyph. */
const SPELL_SCHOOL: Record<string, string> = {
  abjuration: 'magic-shield',
  conjuration: 'magic-gate',
  divination: 'sunbeams',
  enchantment: 'aura',
  evocation: 'fire',
  illusion: 'magic-swirl',
  necromancy: 'death-skull',
  transmutation: 'whirlwind',
};

/** Creature type -> creature silhouette. Matched by substring so "swarm of beasts" -> beast. */
const MONSTER_TYPE: Array<[string, string]> = [
  ['dragon', 'dragon-head'],
  ['undead', 'skeleton'],
  ['fiend', 'devil-mask'],
  ['celestial', 'sun'],
  ['construct', 'golem-head'],
  ['elemental', 'tornado'],
  ['fey', 'fairy'],
  ['aberration', 'cyclops'],
  ['giant', 'cyclops'],
  ['monstrosity', 'hydra'],
  ['ooze', 'bubbling-flask'],
  ['plant', 'forest-entrance'],
  ['beast', 'wolf-head'],
  ['humanoid', 'orc-head'],
];

/** Magic-item category -> item glyph. Matched by substring against category + name. */
const ITEM_CATEGORY: Array<[string, string]> = [
  ['weapon', 'crossed-swords'],
  ['sword', 'crossed-swords'],
  ['armor', 'breastplate'],
  ['shield', 'shield'],
  ['potion', 'round-potion'],
  ['scroll', 'scroll-unfurled'],
  ['ring', 'ring'],
  ['wand', 'crystal-wand'],
  ['rod', 'crystal-wand'],
  ['staff', 'crystal-wand'],
  ['wondrous', 'gem-pendant'],
];

/** Condition name -> condition glyph. */
const CONDITION_NAME: Array<[string, string]> = [
  ['poison', 'poison-bottle'],
  ['charm', 'heart-bottle'],
  ['frighten', 'ghost'],
  ['stun', 'lightning-arc'],
  ['grapple', 'whip'],
  ['restrain', 'whip'],
  ['blind', 'aura'],
  ['exhaust', 'hourglass'],
];

/** Parse a rule entry's JSON blob, tolerating null/malformed data. */
function readData(dataJson: string | null): Record<string, unknown> {
  if (!dataJson) return {};
  try {
    const parsed = JSON.parse(dataJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstMatch(haystack: string, table: Array<[string, string]>): string | null {
  for (const [needle, slug] of table) {
    if (haystack.includes(needle)) return slug;
  }
  return null;
}

/**
 * The bundled-catalog slug to show for an entry. A DM's manual override
 * (`entry.iconSlug`) wins; otherwise a default is derived from type + dataJson.
 * Returns '' only when nothing sensible resolves (never happens for the enum types
 * above, but keeps the return type honest) — callers pass the result straight to
 * <GameIcon>, which renders nothing for '' / unknown slugs.
 */
export function ruleEntryIconSlug(entry: Pick<RuleEntry, 'type' | 'dataJson' | 'iconSlug' | 'name'>): string {
  if (entry.iconSlug && isKnownIcon(entry.iconSlug)) return entry.iconSlug;

  const data = readData(entry.dataJson);
  let slug: string | null = null;

  switch (entry.type) {
    case 'spell': {
      const school = String(data.school ?? '').toLowerCase();
      slug = SPELL_SCHOOL[school] ?? null;
      break;
    }
    case 'monster': {
      const creatureType = String(data.type ?? '').toLowerCase();
      slug = firstMatch(creatureType, MONSTER_TYPE);
      break;
    }
    case 'item': {
      const hint = `${String(data.category ?? '')} ${entry.name}`.toLowerCase();
      slug = firstMatch(hint, ITEM_CATEGORY);
      break;
    }
    case 'condition': {
      slug = firstMatch(entry.name.toLowerCase(), CONDITION_NAME);
      break;
    }
    default:
      slug = null;
  }

  return slug ?? TYPE_DEFAULT[entry.type] ?? '';
}
