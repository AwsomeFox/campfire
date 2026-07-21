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

/** Entity-type → slug. Keys match the entity `type`/`entityType` strings used across notes, search, proposals, trash, inbox, etc. */
export const ENTITY_ICON: Record<string, string> = {
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
};

/** Note visibility → slug (private / shared-with-DM / shared-with-party / whisper). */
export const NOTE_VISIBILITY_ICON: Record<string, string> = {
  private: 'padlock',
  dm_shared: 'top-hat',
  party_shared: 'meeple',
  whisper: 'secret-book',
};
