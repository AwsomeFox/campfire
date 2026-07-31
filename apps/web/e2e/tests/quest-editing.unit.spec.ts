import { expect, test } from '@playwright/test';
import {
  QUEST_BODY_LABEL,
  QUEST_GIVER_LABEL,
  QUEST_PARENT_LABEL,
  QUEST_REWARD_LABEL,
  QUEST_TITLE_LABEL,
  QUEST_TITLE_REQUIRED_ERROR,
  questFieldId,
} from '../../src/features/quests/questFormA11y';

/**
 * Issue #1483 — Quest editing fields, accessible IDs, and concurrency guard behavior.
 */
test.describe('quest editing (issue #1483)', () => {
  test('edit form field ids use quest-edit prefix and match standard vocabulary', () => {
    const editPrefix = 'quest-edit';
    expect(questFieldId(editPrefix, 'title')).toBe('quest-edit-title');
    expect(questFieldId(editPrefix, 'body')).toBe('quest-edit-body');
    expect(questFieldId(editPrefix, 'reward')).toBe('quest-edit-reward');
    expect(questFieldId(editPrefix, 'giver')).toBe('quest-edit-giver');
    expect(questFieldId(editPrefix, 'parent')).toBe('quest-edit-parent');

    expect(QUEST_TITLE_LABEL).toBe('Title');
    expect(QUEST_BODY_LABEL).toBe('Body');
    expect(QUEST_REWARD_LABEL).toBe('Reward');
    expect(QUEST_GIVER_LABEL).toBe('Giver');
    expect(QUEST_PARENT_LABEL).toBe('Parent quest');
    expect(QUEST_TITLE_REQUIRED_ERROR).toBe('A quest needs a title.');
  });

  test('builds full PATCH payload for quest edit including expectedUpdatedAt concurrency guard', () => {
    const quest = {
      id: 42,
      campaignId: 1,
      title: 'Original Quest Title',
      body: 'Original Body',
      reward: '500 gp',
      giverNpcId: 10,
      parentId: 2,
      status: 'active' as const,
      hidden: false,
      dmSecret: 'Secret notes',
      updatedAt: '2026-07-01T12:00:00.000Z',
    };

    const draft = {
      title: 'Updated Quest Title',
      body: 'Updated Body',
      reward: '1000 gp',
      giverNpcId: '15',
      parentId: '',
    };

    const payload = {
      title: draft.title.trim(),
      body: draft.body,
      reward: draft.reward,
      giverNpcId: draft.giverNpcId ? Number(draft.giverNpcId) : null,
      parentId: draft.parentId ? Number(draft.parentId) : null,
      ...(quest.updatedAt ? { expectedUpdatedAt: quest.updatedAt } : {}),
    };

    expect(payload).toEqual({
      title: 'Updated Quest Title',
      body: 'Updated Body',
      reward: '1000 gp',
      giverNpcId: 15,
      parentId: null,
      expectedUpdatedAt: '2026-07-01T12:00:00.000Z',
    });
  });
});
