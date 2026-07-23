/**
 * Shared authoring / composer field vocabulary (issue #886).
 *
 * Plain strings so unit specs can pin accessible names, help copy, and id
 * prefixes without mounting pages. Each surface keeps its own prefix so
 * remounts and multi-editor pages never collide.
 */

/** Character sheet metadata editor (SheetEditForm). */
export const CHARACTER_EDIT_PREFIX = 'character-edit';
export const CHARACTER_ACTION_PREFIX = 'character-action';
export const CHARACTER_STORY_PREFIX = 'character-story';
export const CHARACTER_CONDITION_PREFIX = 'character-condition';

export const CHARACTER_FIELD = {
  name: 'name',
  species: 'species',
  className: 'className',
  background: 'background',
  level: 'level',
  ac: 'ac',
  hpMax: 'hpMax',
  status: 'status',
} as const;

export const CHARACTER_ACTION_FIELD = {
  name: 'name',
  kind: 'kind',
  toHit: 'toHit',
  damage: 'damage',
  notes: 'notes',
} as const;

export const CHARACTER_NAME_LABEL = 'Name';
export const CHARACTER_SPECIES_LABEL = 'Species';
export const CHARACTER_CLASS_LABEL = 'Class';
export const CHARACTER_BACKGROUND_LABEL = 'Background';
export const CHARACTER_LEVEL_LABEL = 'Level';
export const CHARACTER_AC_LABEL = 'Armor class';
export const CHARACTER_HP_MAX_LABEL = 'Max HP';
export const CHARACTER_STATUS_LABEL = 'Status';
export const CHARACTER_STATUS_HELP =
  'Only active characters are auto-added to new encounters. Dead, retired, or inactive PCs stay on the roster.';
export const CHARACTER_HP_MAX_HELP = 'Current HP is clamped to the new max automatically.';
export const CHARACTER_STORY_LABEL = 'Story notes';
export const CHARACTER_STORY_HELP = 'Optional markdown backstory and roleplay notes for this character.';
export const CHARACTER_CONDITION_LABEL = 'Condition';
export const CHARACTER_CONDITION_HELP = 'Add a condition from the rules vocabulary or type a custom name.';

export const CHARACTER_ACTION_NAME_LABEL = 'Action name';
export const CHARACTER_ACTION_KIND_LABEL = 'Kind';
export const CHARACTER_ACTION_TO_HIT_LABEL = 'To hit';
export const CHARACTER_ACTION_DAMAGE_LABEL = 'Damage';
export const CHARACTER_ACTION_NOTES_LABEL = 'Notes';
export const CHARACTER_ACTION_TO_HIT_HELP = 'Modifier (+5) or dice expression (1d20+5).';
export const CHARACTER_ACTION_DAMAGE_HELP = 'Dice and type, e.g. 1d8+3 slashing or 5 fire.';

/** Location editor. */
export const LOCATION_EDIT_PREFIX = 'location-editor';
export const LOCATION_FIELD = {
  name: 'name',
  kind: 'kind',
  parentId: 'parentId',
  body: 'body',
  dmSecret: 'dmSecret',
} as const;

export const LOCATION_NAME_LABEL = 'Name';
export const LOCATION_KIND_LABEL = 'Kind';
export const LOCATION_PARENT_LABEL = 'Parent location';
export const LOCATION_BODY_LABEL = 'Description';
export const LOCATION_BODY_HELP = 'Optional markdown describing this place for the table.';
export const LOCATION_DM_SECRET_LABEL = 'DM secret';
export const LOCATION_DM_SECRET_HELP =
  'Visible only to DMs. Players never receive this text — it is stripped from every non-DM API response.';

/** Session Zero charter + support preference. */
export const SESSION_ZERO_PREFIX = 'session-zero';
export const SESSION_ZERO_FIELD = {
  lines: 'lines',
  veils: 'veils',
  safetyTools: 'safetyTools',
  houseRules: 'houseRules',
  tone: 'tone',
  supportText: 'supportText',
} as const;

export const SESSION_ZERO_LINES_LABEL = 'Lines (hard limits)';
export const SESSION_ZERO_LINES_HELP = 'Content that never appears at the table. One entry per line.';
export const SESSION_ZERO_VEILS_LABEL = 'Veils (soft limits)';
export const SESSION_ZERO_VEILS_HELP = 'Content that may exist but stays off-screen. One entry per line.';
export const SESSION_ZERO_TOOLS_LABEL = 'Safety tools';
export const SESSION_ZERO_TOOLS_HELP = 'Tools the table agreed to use. One entry per line.';
export const SESSION_ZERO_HOUSE_RULES_LABEL = 'House rules';
export const SESSION_ZERO_HOUSE_RULES_HELP = 'Optional markdown for table conventions and rules-as-written deviations.';
export const SESSION_ZERO_TONE_LABEL = 'Tone & content expectations';
export const SESSION_ZERO_TONE_HELP =
  'Optional markdown for grit vs. heroism, comedy vs. seriousness, spotlight and PvP norms.';
export const SESSION_ZERO_SUPPORT_LABEL = 'What would help you participate comfortably?';
export const SESSION_ZERO_SUPPORT_HELP =
  'Optional. Examples: extra processing time, explicit turn cues, breaks, reading support, motion limits, or avoiding timers.';

/** Encounter create form. */
export const ENCOUNTER_CREATE_PREFIX = 'encounter';
export const ENCOUNTER_FIELD = {
  name: 'name',
  locationId: 'locationId',
  questId: 'questId',
  sessionId: 'sessionId',
} as const;

export const ENCOUNTER_LOCATION_LABEL = 'Location';
export const ENCOUNTER_LOCATION_HELP = 'Optional place this fight or scene is set.';
export const ENCOUNTER_QUEST_LABEL = 'Quest';
export const ENCOUNTER_QUEST_HELP = 'Optional quest this encounter advances.';
export const ENCOUNTER_SESSION_LABEL = 'Session';
export const ENCOUNTER_SESSION_HELP = 'Optional session log entry to attach.';

/** Inventory add-item form. */
export const INVENTORY_ADD_PREFIX = 'inventory-add';
export const INVENTORY_FIELD = {
  name: 'name',
  qty: 'qty',
  owner: 'owner',
  notes: 'notes',
} as const;

export const INVENTORY_NAME_LABEL = 'Item name';
export const INVENTORY_NAME_HELP = 'Required. Shown on the party stash and character sheets.';
export const INVENTORY_OWNER_LABEL = 'Owner';
export const INVENTORY_OWNER_HELP = 'Party stash or a specific character.';
export const INVENTORY_NOTES_LABEL = 'Notes';
export const INVENTORY_NOTES_HELP = 'Optional short description or usage notes.';

/** Map import attribution form (GetAMapPanel). */
export const MAP_IMPORT_PREFIX = 'map-import';
export const MAP_IMPORT_FIELD = {
  title: 'title',
  author: 'author',
  sourceUrl: 'sourceUrl',
  file: 'file',
} as const;

export const MAP_TITLE_LABEL = 'Map title';
export const MAP_TITLE_HELP = 'Required. A short name the table will recognize (e.g. The Sunken Abbey).';
export const MAP_AUTHOR_LABEL = 'Author to credit';
export const MAP_AUTHOR_HELP = 'Required for CC-BY-SA attribution. Stamped onto the saved map.';
export const MAP_SOURCE_URL_LABEL = 'Source URL';
export const MAP_SOURCE_URL_HELP = 'Optional link back to the original map listing.';
export const MAP_FILE_LABEL = 'Map image file';
export const MAP_FILE_HELP =
  'Upload the battle or location map image to attach. Accepts PNG, JPEG, or WebP. The credit is stamped onto the saved map, which stays DM-only until you reveal it.';
export const MAP_FILE_ACCEPT = 'image/png,image/jpeg,image/webp';

/** Notes compose (NotesRail). */
export const NOTES_COMPOSE_PREFIX = 'notes-compose';
export const NOTES_FIELD = {
  body: 'body',
  whisperTo: 'whisperTo',
} as const;

/** Comments compose / edit. */
export const COMMENTS_COMPOSE_PREFIX = 'comments-compose';
export const COMMENTS_EDIT_PREFIX = 'comments-edit';
export const COMMENTS_FIELD = {
  body: 'body',
  characterId: 'characterId',
} as const;

export const COMMENT_BODY_LABEL = 'Comment';
export const COMMENT_BODY_HELP = 'Visible to every campaign member. Markdown is supported.';
export const COMMENT_EDIT_LABEL = 'Edit comment';
export const COMMENT_EDIT_HELP = 'Update the comment body. Markdown is supported.';
export const COMMENT_SPEAKER_LABEL = 'Speaking as';
export const COMMENT_SPEAKER_HELP = 'Choose which owned character is speaking in character.';

/** AI Table composer. */
export const AI_TABLE_PREFIX = 'ai-table';
export const AI_TABLE_FIELD = {
  scene: 'scene',
  action: 'action',
} as const;
