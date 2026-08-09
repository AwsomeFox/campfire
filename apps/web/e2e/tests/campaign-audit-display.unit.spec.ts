import { expect, test } from '@playwright/test';
import type { AuditEntry, TimelineEventAuditPayload } from '@campfire/schema';
import { timelineAuditTarget } from '../../src/features/admin/campaignAuditDisplay';

function timelineAuditEntry(action: TimelineEventAuditPayload['action'] = 'timeline.event.create'): AuditEntry {
  return {
    id: 1,
    campaignId: 7,
    actor: '1',
    actorRole: 'dm',
    action,
    entityType: 'timeline_event',
    entityId: 11,
    detail: 'Timeline event “Old title” created',
    payload: {
      version: 1,
      kind: 'timeline_event',
      action,
      actor: { id: '1', role: 'dm' },
      source: { transport: 'rest', requestId: null },
      entity: { type: 'timeline_event', id: 11, label: 'Old title', navigation: { route: 'timeline', query: 'event' } },
      changes: [{ field: 'title', before: null, after: 'Old title', visibility: 'member' }],
      snapshot: null,
      reason: null,
    },
    requestId: null,
    createdAt: '2026-08-09T18:00:00.000Z',
  };
}

test.describe('timeline audit links', () => {
  test('uses the current Trash state for historical rows', () => {
    expect(timelineAuditTarget(timelineAuditEntry(), new Set())).toEqual({
      label: 'Old title',
      href: '/c/7/timeline?event=11#entity-timeline-11',
    });
    for (const action of ['timeline.event.create', 'timeline.event.update', 'timeline.event.restore'] as const) {
      expect(timelineAuditTarget(timelineAuditEntry(action), new Set([11]))).toEqual({
        label: 'Old title',
        href: '/c/7/trash',
      });
    }
  });

  test('does not render a target while current state is unavailable', () => {
    expect(timelineAuditTarget(timelineAuditEntry(), null)).toBeNull();
  });
});
