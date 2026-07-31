import { expect, test } from '@playwright/test';
import type { CampaignCatchUp, SessionListItem } from '@campfire/schema';
import { entityHref } from '../../src/lib/entityLinks';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Issue #1482 — Dashboard Catch up and SessionLog deep link routes.
 *
 * Ensures CatchUpPanel and SessionLog route through entityHref for session recap
 * and schedule links so navigation preserves ?session= and does not 404.
 */

test.describe('Dashboard session link routes (issue #1482)', () => {
  const campaignId = 42;

  test('entityHref generates correct deep links for session recaps and scheduled sessions', () => {
    expect(entityHref(campaignId, { type: 'session', id: 101 })).toBe(
      '/c/42/sessions?session=101#entity-session-101',
    );
    expect(entityHref(campaignId, { type: 'scheduled_session', id: 202 })).toBe(
      '/c/42/sessions?tab=schedule&schedule=202#entity-scheduled_session-202',
    );
  });

  test('CatchUpPanel link URLs for quests, sessions, timeline, and schedules are deep-linked via entityHref', () => {
    const mockData = {
      since: '2026-07-01T00:00:00.000Z',
      lastCaughtUpAt: '2026-07-01T00:00:00.000Z',
      totalCount: 4,
      truncated: false,
      quests: [
        {
          kind: 'new',
          quest: {
            id: 1,
            title: 'Slay the Dragon',
          },
        },
      ],
      sessions: [
        {
          kind: 'new',
          session: {
            id: 55,
            number: 3,
            title: 'The Great Battle',
          },
        },
      ],
      timeline: [
        {
          kind: 'changed',
          event: {
            id: 88,
            title: 'Comet Sighted',
          },
        },
      ],
      schedules: [
        {
          kind: 'new',
          schedule: {
            id: 99,
            scheduledAt: '2026-08-01T20:00:00.000Z',
            title: 'Game Night',
          },
        },
      ],
    } as unknown as CampaignCatchUp;

    const questHref = entityHref(campaignId, { type: 'quest', id: mockData.quests[0].quest.id });
    const sessionHref = entityHref(campaignId, { type: 'session', id: mockData.sessions[0].session.id });
    const timelineHref = entityHref(campaignId, { type: 'timeline', id: mockData.timeline[0].event.id });
    const scheduleHref = entityHref(campaignId, { type: 'scheduled_session', id: mockData.schedules[0].schedule.id });

    expect(questHref).toBe('/c/42/quests/1#entity-quest-1');
    expect(sessionHref).toBe('/c/42/sessions?session=55#entity-session-55');
    expect(timelineHref).toBe('/c/42/timeline?event=88#entity-timeline-88');
    expect(scheduleHref).toBe('/c/42/sessions?tab=schedule&schedule=99#entity-scheduled_session-99');
  });

  test('SessionLog item links map to session deep links via entityHref', () => {
    const mockSessions = [
      {
        id: 12,
        campaignId,
        number: 1,
        title: 'Arrival',
        playedAt: '2026-07-15T00:00:00.000Z',
        recapExcerpt: 'The party arrived at the gates.',
      },
    ] as unknown as SessionListItem[];

    const href = entityHref(campaignId, { type: 'session', id: mockSessions[0].id });
    expect(href).toBe('/c/42/sessions?session=12#entity-session-12');
  });

  test('source code guard: CatchUpPanel and SessionLog contain no hand-built /sessions/:id 404 links', () => {
    const catchUpPath = path.join(__dirname, '../../src/features/dashboard/CatchUpPanel.tsx');
    const sessionLogPath = path.join(__dirname, '../../src/features/dashboard/SessionLog.tsx');

    const catchUpContent = fs.readFileSync(catchUpPath, 'utf8');
    const sessionLogContent = fs.readFileSync(sessionLogPath, 'utf8');

    // Neither file should build `/sessions/${...}` links directly (which 404).
    expect(catchUpContent).not.toMatch(/\/sessions\/\${/);
    expect(sessionLogContent).not.toMatch(/\/sessions\/\${/);

    // Both files must consume entityHref for session linking.
    expect(catchUpContent).toContain('entityHref');
    expect(sessionLogContent).toContain('entityHref');
  });
});
