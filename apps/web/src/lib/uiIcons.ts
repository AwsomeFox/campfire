/**
 * Shared UI icon vocabulary — maps app concepts (entity types, note visibility,
 * nav sections) to game-icons.net slugs rendered by <GameIcon>.
 *
 * Historically these were inline emoji (📜 🤝 🏴 …); they're now the same
 * game-icons set the compendium (#302/#305) and inventory (#307) already use, so
 * the whole app draws from one icon pack instead of the OS emoji font. Every slug
 * here is a real game-icons slug (curated set or full lazy set); <GameIcon>
 * renders nothing for an unknown slug, so a typo degrades to no icon rather than
 * a crash.
 */

/** Entity-type → slug. Keys match the entity `type`/`entityType` strings used across notes, search, proposals, trash, inbox, etc. `as const` keeps the literal keys/values so misspelled lookups fail to compile. */
export const ENTITY_ICON = {
  quest: 'scroll-unfurled',
  npc: 'hooded-figure',
  faction: 'black-flag',
  location: 'treasure-map',
  session: 'book-cover',
  character: 'shield',
  encounter: 'crossed-swords',
  campaign: 'campfire',
  item: 'backpack',
  note: 'quill-ink',
  timeline: 'sands-of-time',
  comment: 'chat-bubble',
  arc: 'oak-leaf',
  beat: 'film-strip',
} as const;

/** Note visibility → slug (private / shared-with-DM / shared-with-party / whisper). `as const` for `keyof`-checked, typo-proof lookups. */
export const NOTE_VISIBILITY_ICON = {
  private: 'padlock',
  dm_shared: 'top-hat',
  party_shared: 'meeple',
  whisper: 'secret-book',
} as const;
