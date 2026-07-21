/**
 * Default item-type → game-icons slug mapping for the inventory screen (issue #307).
 *
 * Inventory items carry no structured `type` column, so we derive a sensible
 * default icon from the item's name with an ordered keyword heuristic (weapon /
 * armor / consumable / scroll-book / valuables / gear …). A DM can always override
 * per item via <IconPicker>, which sets an explicit `iconSlug`; `itemIconSlug`
 * prefers that override and only falls back to the heuristic when it's ''.
 *
 * Every slug below exists in the bundled catalog (apps/web/src/lib/icons); an
 * unknown slug would simply render nothing via <GameIcon>, so keep them in sync.
 */

/** Broad item categories, used for the fallback-by-type default and labels. */
export type ItemKind = 'weapon' | 'armor' | 'consumable' | 'scroll' | 'valuable' | 'gear';

/** Generic per-kind default when no more specific keyword matched. */
const KIND_DEFAULT: Record<ItemKind, string> = {
  weapon: 'sword-brandish',
  armor: 'breastplate',
  consumable: 'round-potion',
  scroll: 'scroll-unfurled',
  valuable: 'gem-pendant',
  gear: 'backpack',
};

/**
 * Ordered, first-match-wins keyword table. More specific terms come before
 * broader ones so e.g. "poison" beats the generic potion default and "spellbook"
 * beats "book". Each entry maps to a concrete bundled slug.
 */
const KEYWORD_ICONS: ReadonlyArray<[RegExp, string]> = [
  // weapons — specific shapes first
  [/\b(bow|crossbow|arrow|sling)\b/i, 'bow-arrow'],
  [/\b(axe|hatchet|greataxe|handaxe)\b/i, 'battle-axe'],
  [/\b(mace|morningstar|maul|warhammer|hammer|flail)\b/i, 'flanged-mace'],
  [/\b(dagger|knife|dirk|shiv|stiletto)\b/i, 'stiletto'],
  [/\b(spear|halberd|glaive|pike|lance|trident|javelin|polearm)\b/i, 'halberd'],
  [/\b(whip)\b/i, 'whip'],
  [/\b(katana|scimitar)\b/i, 'katana'],
  [/\b(club|staff|quarterstaff|cudgel)\b/i, 'wood-club'],
  [/\b(sword|blade|rapier|sabre|saber|longsword|shortsword|greatsword|falchion|scimitar)\b/i, 'sword-brandish'],
  // armor & worn protection
  [/\b(shield|buckler|aegis)\b/i, 'shield'],
  [/\b(helm|helmet|coif|barbute)\b/i, 'helmet'],
  [/\b(gauntlet|glove|bracer)\b/i, 'gauntlet'],
  [/\b(boot|greave|sabaton)\b/i, 'leather-boot'],
  [/\b(cloak|cape|mantle|robe)\b/i, 'cloak'],
  [/\b(armou?r|mail|plate|breastplate|cuirass|hauberk|brigandine)\b/i, 'breastplate'],
  // consumables
  [/\b(poison|venom|toxin)\b/i, 'poison-bottle'],
  [/\b(potion|elixir|philter|draught|oil|flask|vial|tonic|antitoxin|brew)\b/i, 'round-potion'],
  [/\b(ration|food|bread|meat|meal|waterskin|drink)\b/i, 'heart-bottle'],
  // scrolls, books & documents
  [/\b(spellbook|grimoire|tome)\b/i, 'spell-book'],
  [/\b(scroll|parchment|deed|letter|note|contract)\b/i, 'scroll-unfurled'],
  [/\b(book|manual|journal|codex|folio)\b/i, 'book-cover'],
  [/\b(map|chart)\b/i, 'treasure-map'],
  [/\b(quill|feather|pen|ink)\b/i, 'quill-ink'],
  // valuables / treasure / magic trinkets
  [/\b(ring|band|signet)\b/i, 'ring'],
  [/\b(gem|jewel|diamond|ruby|emerald|sapphire|amethyst|crystal|pearl)\b/i, 'cut-diamond'],
  [/\b(crown|tiara|diadem)\b/i, 'crown'],
  [/\b(amulet|necklace|pendant|talisman|locket|brooch)\b/i, 'gem-pendant'],
  [/\b(wand|rod|scepter|sceptre)\b/i, 'crystal-wand'],
  [/\b(coin|gold|silver|copper|platinum|gp|sp|cp|treasure|bullion|ingot|bar)\b/i, 'coins'],
  [/\b(chest|coffer|strongbox|lockbox)\b/i, 'chest'],
  // gear / adventuring kit
  [/\b(torch)\b/i, 'torch'],
  [/\b(lantern|lamp)\b/i, 'lantern'],
  [/\b(candle)\b/i, 'candle-flame'],
  [/\b(key)\b/i, 'key'],
  [/\b(rope|grappl|chain|net)\b/i, 'knapsack'],
  [/\b(pack|backpack|bag|sack|pouch|haversack|satchel)\b/i, 'backpack'],
  [/\b(compass)\b/i, 'compass'],
  [/\b(kit|tool|toolkit|thieves)\b/i, 'knapsack'],
];

/**
 * Derive a default icon slug from an item name using the keyword table, then a
 * per-kind fallback keyed off any broad category words, and finally the generic
 * "gear" glyph so every row always shows something.
 */
export function defaultItemIconSlug(name: string): string {
  const n = (name || '').toLowerCase();
  for (const [re, slug] of KEYWORD_ICONS) {
    if (re.test(n)) return slug;
  }
  // Broad category fall-through when no concrete keyword matched.
  if (/\b(weapon|arm(s)?)\b/.test(n)) return KIND_DEFAULT.weapon;
  if (/\b(armor|armour|shield)\b/.test(n)) return KIND_DEFAULT.armor;
  if (/\b(consumable|drink)\b/.test(n)) return KIND_DEFAULT.consumable;
  if (/\b(scroll|book|paper)\b/.test(n)) return KIND_DEFAULT.scroll;
  if (/\b(valuable|treasure|jewel)\b/.test(n)) return KIND_DEFAULT.valuable;
  return KIND_DEFAULT.gear;
}

/**
 * The slug to render for an item: the DM's explicit override when set, else the
 * name-derived default. Never returns '', so a row always has an icon.
 */
export function itemIconSlug(item: { name: string; iconSlug?: string }): string {
  return item.iconSlug && item.iconSlug.trim() ? item.iconSlug : defaultItemIconSlug(item.name);
}

/**
 * Per-denomination coin glyph + tint for the treasury card (issue #307). All use
 * the same bundled coin icon, coloured by metal via `fill: currentColor`.
 */
export const COIN_ICON = 'coins';
export const COIN_COLORS: Record<'pp' | 'gp' | 'ep' | 'sp' | 'cp', string> = {
  pp: '#cbd5e1', // platinum — pale slate
  gp: '#fbbf24', // gold — amber
  ep: '#a3e635', // electrum — lime
  sp: '#e2e8f0', // silver — light grey
  cp: '#d97706', // copper — bronze/orange
};
