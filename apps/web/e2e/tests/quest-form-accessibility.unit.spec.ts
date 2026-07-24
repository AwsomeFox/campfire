import { expect, test } from '@playwright/test';
import {
  NOTE_BODY_LABEL,
  NOTE_VISIBILITY_GROUP_LABEL,
  NOTE_VISIBILITY_HELP,
  NOTE_VISIBILITY_ORDER,
  noteVisibilityOptionLabel,
} from '../../src/components/noteVisibilityA11y';
import {
  QUEST_AUDIENCE_DM_HELP,
  QUEST_AUDIENCE_GROUP_LABEL,
  QUEST_BODY_LABEL,
  QUEST_GIVER_LABEL,
  QUEST_NEW_FORM_PREFIX,
  QUEST_PARENT_LABEL,
  QUEST_REWARD_LABEL,
  QUEST_TITLE_HELP,
  QUEST_TITLE_LABEL,
  QUEST_TITLE_REQUIRED_ERROR,
  questFieldId,
} from '../../src/features/quests/questFormA11y';

/**
 * Issue #452 — quest authoring labels + note visibility vocabulary.
 */

test.describe('quest form a11y vocabulary (issue #452)', () => {
  test('create fields use persistent labels and stable ids', () => {
    expect(QUEST_TITLE_LABEL).toBe('Title');
    expect(QUEST_BODY_LABEL).toBe('Body');
    expect(QUEST_REWARD_LABEL).toBe('Reward');
    expect(QUEST_GIVER_LABEL).toBe('Giver');
    expect(QUEST_PARENT_LABEL).toBe('Parent quest');
    expect(questFieldId(QUEST_NEW_FORM_PREFIX, 'title')).toBe('quest-new-title');
    expect(QUEST_TITLE_HELP).toMatch(/Required/i);
    expect(QUEST_TITLE_REQUIRED_ERROR).toMatch(/title/i);
  });

  test('audience group explains DM-only default for prep', () => {
    expect(QUEST_AUDIENCE_GROUP_LABEL).toBe('Audience');
    expect(QUEST_AUDIENCE_DM_HELP).toMatch(/Hidden from players|Default for prep/i);
  });
});

test.describe('note visibility a11y vocabulary (issue #452)', () => {
  test('exactly-one Private/DM/Party/Whisper options with secret help', () => {
    expect(NOTE_VISIBILITY_ORDER).toEqual(['private', 'dm_shared', 'party_shared', 'whisper']);
    expect(NOTE_VISIBILITY_GROUP_LABEL).toBe('Note visibility');
    expect(NOTE_BODY_LABEL).toBe('Note body');
    expect(NOTE_VISIBILITY_HELP.private).toMatch(/Only you/i);
    expect(NOTE_VISIBILITY_HELP.whisper).toMatch(/Secret|exactly one/i);
    expect(noteVisibilityOptionLabel('private')).toMatch(/^Private —/);
    expect(noteVisibilityOptionLabel('dm_shared')).not.toBe(noteVisibilityOptionLabel('party_shared'));
  });
});
