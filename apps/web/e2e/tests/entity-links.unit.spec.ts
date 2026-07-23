import { test, expect } from '@playwright/test';
import type { EntityType, MentionTarget, Notification, Proposal, SearchResult } from '@campfire/schema';
import {
  cfLinkHref,
  cfLinkToken,
  entityDomId,
  entityHref,
  mentionTargetHref,
  noteTargetHref,
  notificationHref,
  parseCfLink,
  proposalTargetHref,
  resolveUniqueByName,
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
  scheduled_session: '/c/7/sessions?tab=schedule&schedule=11#entity-scheduled_session-11',
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
    'quest', 'npc', 'faction', 'location', 'character', 'session', 'encounter', 'scheduled_session', 'note', 'timeline', 'item', 'arc', 'beat',
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

  test('notifications route every type to its exact destination (issue #446)', () => {
    const base = {
      id: 1, userId: 2, campaignId, title: 'Notice', body: '', actorName: '', readAt: null,
      createdAt: '2026-07-22T00:00:00.000Z', entityType: null, entityId: null, commentId: null, data: null,
    } satisfies Omit<Notification, 'type'>;
    const href = (type: Notification['type'], patch: Partial<Notification> = {}) =>
      notificationHref({ ...base, type, ...patch } as Notification);

    // Schedule/RSVP → Schedule tab (+ exact card when entityId is a schedule row).
    expect(href('session_scheduled')).toBe('/c/7/sessions?tab=schedule');
    expect(href('session_rsvp')).toBe('/c/7/sessions?tab=schedule');
    expect(href('session_scheduled', { entityId: 11 })).toBe(expected.scheduled_session);
    expect(href('session_rsvp', { entityId: 11 })).toBe(expected.scheduled_session);
    // Legacy log-session playedAt ping must NOT open the session log.
    expect(href('session_scheduled', { entityType: 'session', entityId: 11 })).toBe(
      '/c/7/sessions?tab=schedule',
    );
    // Issue #820: cancelled nights route to a stable cancelled-event detail.
    expect(href('session_scheduled', {
      entityId: 11,
      data: {
        kind: 'schedule',
        scheduleId: 11,
        scheduledAt: '2026-07-22T00:00:00.000Z',
        durationMinutes: 240,
        changeType: 'cancelled',
        changedFields: [],
        label: 'Game night',
      },
    })).toBe('/c/7/sessions?tab=schedule&cancelled=11#cancelled-schedule-11');

    // Quest detail route (not an ignored ?quest= query).
    expect(href('quest_updated', { entityType: 'quest', entityId: 11 })).toBe(expected.quest);
    expect(href('quest_updated')).toBe('/c/7/quests');

    // Comment replies: parent entity + optional comment focus (session and non-session).
    expect(href('comment_reply', { entityType: 'session', entityId: 11, commentId: 19 })).toBe(
      '/c/7/sessions?session=11&comment=19#entity-comment-19',
    );
    expect(href('comment_reply', { entityType: 'quest', entityId: 11, commentId: 19 })).toBe(
      '/c/7/quests/11?comment=19#entity-comment-19',
    );
    expect(href('comment_reply', { entityType: 'npc', entityId: 11 })).toBe(expected.npc);
    expect(href('comment_reply')).toBe('/c/7');

    expect(href('recap_posted', { entityType: 'session', entityId: 11 })).toBe(expected.session);
    expect(href('note_shared', { entityType: 'session', entityId: 11 })).toBe(expected.session);
    expect(href('note_reply')).toBe('/c/7/notes');
    expect(href('note_shared')).toBe('/c/7/notes');
    expect(href('proposal_submitted')).toBe('/c/7/proposals');
    expect(href('proposal_resolved')).toBe('/c/7/proposals');
    expect(href('ai_dm_alert')).toBe('/c/7/table');
    expect(href('added_to_campaign')).toBe('/c/7');
    expect(href('character_reassigned', { entityType: 'character', entityId: 11 })).toBe(expected.character);
    expect(href('recap_share_enabled')).toBe('/c/7');
    expect(href('recap_share_extended')).toBe('/c/7');
  });
});

// --------------------------------------------------------------------------
// Identity-persisted mention tokens + same-name disambiguation (issue #739).
//
// A typed mention authored as `[Vex](/.cf/npc/5)` binds the link to NPC #5 by
// ID, so it survives renames and same-name collisions. The auto-linker refuses
// to silently resolve an ambiguous name; only a typed token disambiguates.
// --------------------------------------------------------------------------
test.describe('typed mention tokens (issue #739)', () => {
  test('cfLinkToken serializes a typed mention into the synthetic relative URL', () => {
    expect(cfLinkToken('npc', 5)).toBe('/.cf/npc/5');
    expect(cfLinkToken('arc', 42)).toBe('/.cf/arc/42');
  });

  test('parseCfLink accepts well-formed tokens and rejects everything else', () => {
    expect(parseCfLink('/.cf/npc/5')).toEqual({ type: 'npc', id: 5 });
    expect(parseCfLink(' /.cf/session/11 ')).toEqual({ type: 'session', id: 11 });
    // Real app URLs, mailto, fragments, and bare strings are not typed tokens.
    expect(parseCfLink('/c/7/npcs/5')).toBeNull();
    expect(parseCfLink('mailto:x@y')).toBeNull();
    expect(parseCfLink('#entity-npc-5')).toBeNull();
    expect(parseCfLink('')).toBeNull();
    expect(parseCfLink(null)).toBeNull();
    // Malformed: non-numeric id, missing segments, mixed-case type.
    expect(parseCfLink('/.cf/npc/abc')).toBeNull();
    expect(parseCfLink('/.cf/npc/')).toBeNull();
    expect(parseCfLink('/.cf/npc/0')).toBeNull(); // id must be a positive integer
    expect(parseCfLink('/.cf/NPC/5')).toBeNull();
  });

  test('cfLinkHref resolves to the same canonical URL as a direct entityHref', () => {
    // A typed token carries the same destination every other surface uses, so a
    // mention picked today and a search result match land on the same page+focus.
    expect(cfLinkHref(campaignId, parseCfLink('/.cf/npc/11')!)).toBe(expected.npc);
    expect(cfLinkHref(campaignId, parseCfLink('/.cf/session/11')!)).toBe(expected.session);
    expect(cfLinkHref(campaignId, parseCfLink('/.cf/beat/11')!)).toBe(expected.beat);
    // A bare comment token has no parent context (a comment lives inside an
    // entity's thread), so it is not a navigable surface on its own — degrade.
    expect(cfLinkHref(campaignId, parseCfLink('/.cf/comment/19')!)).toBeNull();
  });
});

test.describe('same-name disambiguation (issue #739)', () => {
  const targets = (name: string) => [
    { type: 'npc' as const, id: 5, name },
    { type: 'npc' as const, id: 6, name }, // SAME name, different record
    { type: 'quest' as const, id: 7, name: 'Unrelated' },
  ];

  test('a name shared by two targets does NOT auto-resolve (collision returns null)', () => {
    expect(resolveUniqueByName(targets('Vex'), 'Vex')).toBeNull();
  });

  test('a uniquely-named target resolves to that single record', () => {
    const hit = resolveUniqueByName(targets('Vex'), 'Unrelated');
    expect(hit).toEqual({ type: 'quest', id: 7, name: 'Unrelated' });
  });

  test('a name with no match returns null', () => {
    expect(resolveUniqueByName(targets('Vex'), 'Nobody')).toBeNull();
  });

  test('matching is case-insensitive and trims surrounding whitespace', () => {
    const list = [{ type: 'npc' as const, id: 5, name: ' Vex ' }];
    expect(resolveUniqueByName(list, 'vex')).toEqual({ type: 'npc', id: 5, name: ' Vex ' });
    expect(resolveUniqueByName(list, ' VEX ')).toEqual({ type: 'npc', id: 5, name: ' Vex ' });
  });

  test('canonically equivalent Unicode names remain ambiguous', () => {
    const list = [
      { type: 'npc' as const, id: 5, name: 'Amélie' },
      { type: 'character' as const, id: 6, name: 'AME\u0301LIE' },
    ];
    expect(resolveUniqueByName(list, 'ame\u0301lie')).toBeNull();
  });
});
