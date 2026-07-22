import { test, expect } from '@playwright/test';
import type { EntityType, MentionTarget, Notification, Proposal, SearchResult } from '@campfire/schema';
import {
  entityDomId,
  entityHref,
  mentionTargetHref,
  noteTargetHref,
  notificationHref,
  proposalTargetHref,
  searchResultHref,
} from '../../src/lib/entityLinks';

const campaignId = 7;

const expected = {
  quest: '/c/7/quests/11#entity-quest-11',
  npc: '/c/7/npcs/11#entity-npc-11',
  faction: '/c/7/factions/11#entity-faction-11',
  location: '/c/7/locations/11#entity-location-11',
  character: '/c/7/characters/11#entity-character-11',
  encounter: '/c/7/encounters/11#entity-encounter-11',
  session: '/c/7/sessions?session=11#entity-session-11',
  timeline: '/c/7/timeline?event=11#entity-timeline-11',
  item: '/c/7/inventory?item=11#entity-item-11',
  note: '/c/7/notes?note=11#entity-note-11',
  arc: '/c/7/storylines?arc=11#entity-arc-11',
  beat: '/c/7/storylines?beat=11#entity-beat-11',
} as const;

test.describe('typed entity URL contract', () => {
  for (const [type, href] of Object.entries(expected)) {
    test(`${type} has a stable route and focus target`, () => {
      expect(entityHref(campaignId, { type: type as keyof typeof expected, id: 11 })).toBe(href);
    });
  }

  test('campaign and missing ids fall back to safe list destinations', () => {
    expect(entityHref(campaignId, { type: 'campaign', id: 11 })).toBe('/c/7');
    expect(entityHref(campaignId, { type: 'session' })).toBe('/c/7/sessions');
    expect(entityHref(campaignId, { type: 'quest', id: null })).toBe('/c/7/quests');
  });

  test('comments preserve their parent selector and focus the comment', () => {
    expect(entityHref(campaignId, { type: 'comment', id: 19, parentType: 'session', parentId: 11 })).toBe(
      '/c/7/sessions?session=11&comment=19#entity-comment-19',
    );
  });

  test('DOM ids match URL fragments', () => {
    expect(entityDomId('beat', 42)).toBe('entity-beat-42');
  });
});

test.describe('source adapters', () => {
  const mentionTypes: MentionTarget['type'][] = [
    'quest', 'npc', 'faction', 'location', 'character', 'session', 'timeline', 'arc', 'beat',
  ];
  for (const type of mentionTypes) {
    test(`mention ${type} uses the canonical target`, () => {
      expect(mentionTargetHref(campaignId, { type, id: 11, name: 'Target' })).toBe(expected[type]);
    });
  }

  const searchTypes = [
    'quest', 'npc', 'faction', 'location', 'character', 'session', 'note', 'timeline', 'item', 'arc', 'beat',
  ] as const satisfies readonly SearchResult['type'][];
  for (const type of searchTypes) {
    test(`search ${type} uses the canonical target`, () => {
      const result = {
        type, id: 11, campaignId, title: 'Target', snippet: '', matchedField: 'title', entityType: null, entityId: null,
      } satisfies SearchResult;
      expect(searchResultHref(campaignId, result)).toBe(expected[type]);
    });
  }

  test('search comments retain their discussion parent', () => {
    const result = {
      type: 'comment', id: 19, campaignId, title: 'Comment', snippet: '', matchedField: 'body',
      entityType: 'session', entityId: 11,
    } satisfies SearchResult;
    expect(searchResultHref(campaignId, result)).toBe('/c/7/sessions?session=11&comment=19#entity-comment-19');
  });

  const noteEntityTypes: EntityType[] = ['quest', 'npc', 'faction', 'location', 'character', 'session', 'encounter', 'campaign'];
  for (const entityType of noteEntityTypes) {
    test(`note anchored to ${entityType} uses the canonical target`, () => {
      expect(noteTargetHref(campaignId, { id: 91, entityType, entityId: 11 })).toBe(
        entityType === 'campaign' ? '/c/7' : expected[entityType],
      );
    });
  }

  test('unanchored notes focus the note itself', () => {
    expect(noteTargetHref(campaignId, { id: 11 })).toBe(expected.note);
  });

  for (const entityType of noteEntityTypes) {
    test(`proposal target ${entityType} uses the canonical target`, () => {
      const proposal = { entityType, entityId: 11 } as Pick<Proposal, 'entityType' | 'entityId'>;
      expect(proposalTargetHref(campaignId, proposal)).toBe(entityType === 'campaign' ? '/c/7' : expected[entityType]);
    });
  }

  test('create proposals have no nonexistent target', () => {
    expect(proposalTargetHref(campaignId, { entityType: 'session', entityId: null })).toBeNull();
  });

  test('unexpected generated proposal types do not fall back to the dashboard', () => {
    expect(proposalTargetHref(campaignId, { entityType: 'map', entityId: 11 } as never)).toBeNull();
  });

  test('notifications open session, quest, note, proposal, schedule, and AI destinations', () => {
    const base = {
      id: 1, userId: 2, campaignId, title: 'Notice', body: '', actorName: '', readAt: null,
      createdAt: '2026-07-22T00:00:00.000Z', entityType: null, entityId: null,
    } satisfies Omit<Notification, 'type'>;
    const href = (type: Notification['type'], patch: Partial<Notification> = {}) =>
      notificationHref({ ...base, type, ...patch } as Notification);

    expect(href('recap_posted', { entityType: 'session', entityId: 11 })).toBe(expected.session);
    expect(href('quest_updated', { entityType: 'quest', entityId: 11 })).toBe(expected.quest);
    expect(href('note_shared', { entityType: 'session', entityId: 11 })).toBe(expected.session);
    expect(href('comment_reply', { entityType: 'session', entityId: 11 })).toBe(expected.session);
    expect(href('proposal_submitted')).toBe('/c/7/proposals');
    expect(href('session_scheduled')).toBe('/c/7/sessions?tab=schedule');
    expect(href('ai_dm_alert')).toBe('/c/7/table');
    expect(href('added_to_campaign')).toBe('/c/7');
  });
});
