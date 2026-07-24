/**
 * Quest authoring form a11y vocabulary (issue #452).
 *
 * Persistent labels/help/errors for create-quest fields. Kept as plain strings
 * so unit specs can pin accessible names without mounting i18n.
 */

export const QUEST_NEW_FORM_PREFIX = 'quest-new';

export type QuestCreateField =
  | 'title'
  | 'body'
  | 'reward'
  | 'giver'
  | 'parent';

export function questFieldId(prefix: string, field: QuestCreateField): string {
  return `${prefix}-${field}`;
}

export function questFieldHelpId(prefix: string, field: QuestCreateField): string {
  return `${prefix}-${field}-help`;
}

export function questFieldErrorId(prefix: string, field: QuestCreateField): string {
  return `${prefix}-${field}-error`;
}

export const QUEST_TITLE_LABEL = 'Title';
export const QUEST_BODY_LABEL = 'Body';
export const QUEST_REWARD_LABEL = 'Reward';
export const QUEST_GIVER_LABEL = 'Giver';
export const QUEST_PARENT_LABEL = 'Parent quest';
/** Creation-time Audience group (issue #754); replaces the old hidden checkbox. */
export const QUEST_AUDIENCE_GROUP_LABEL = 'Audience';
export const QUEST_AUDIENCE_DM_LABEL = /DM only/;
export const QUEST_AUDIENCE_PLAYERS_LABEL = /Visible to players/;
export const QUEST_AUDIENCE_DM_HELP = 'Hidden from players until you reveal it. Default for prep.';

export const QUEST_TITLE_HELP = 'Required. Shown on the quest board and detail page.';
export const QUEST_BODY_HELP = 'Optional markdown describing the quest for the party.';
export const QUEST_REWARD_HELP = 'Optional reward text (treasure, XP, favors).';
export const QUEST_GIVER_HELP = 'Optional NPC who offered this quest.';
export const QUEST_PARENT_HELP = 'Optional parent quest when this is a subquest.';

export const QUEST_TITLE_REQUIRED_ERROR = 'A quest needs a title.';
