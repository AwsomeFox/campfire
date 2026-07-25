import {
  filterSourceByScope,
  postSessionScope,
  scheduledSessionWindow,
  sourceStatsFrom,
  estimatePromptTokens,
} from '../../src/modules/scribe/scribe-scope';
import type { RecapDraftSource } from '../../src/modules/sessions/sessions.service';

const WINDOW_START = '2026-01-10T18:00:00.000Z';
const WINDOW_END = '2026-01-10T22:00:00.000Z';

function sessionScope() {
  return scheduledSessionWindow(42, WINDOW_START, 240);
}

function fullSource(): RecapDraftSource {
  return {
    resolvedInbox: [
      { body: 'old note', resolvedNote: 'done', entityName: null, updatedAt: '2026-01-01T12:00:00.000Z' },
      { body: 'session note', resolvedNote: 'handled', entityName: 'Goblin', updatedAt: '2026-01-10T19:00:00.000Z' },
    ] as unknown as RecapDraftSource['resolvedInbox'],
    encounters: [
      { name: 'Prep', status: 'preparing', combatants: [] },
      {
        name: 'Cave fight',
        status: 'ended',
        combatants: [],
        endedAt: '2026-01-10T20:00:00.000Z',
        updatedAt: '2026-01-10T20:00:00.000Z',
      },
      {
        name: 'Last week',
        status: 'ended',
        combatants: [],
        endedAt: '2026-01-03T20:00:00.000Z',
        updatedAt: '2026-01-03T20:00:00.000Z',
      },
    ] as RecapDraftSource['encounters'],
    diceRolls: [
      { label: 'old', actor: 'A', rollerName: 'A', total: 10, createdAt: '2026-01-01T12:00:00.000Z' },
      { label: 'session', actor: 'B', rollerName: 'B', total: 18, createdAt: '2026-01-10T19:30:00.000Z' },
    ],
  };
}

describe('scribe-scope (issue #499)', () => {
  it('computes a scheduled session window from start + duration', () => {
    const scope = scheduledSessionWindow(7, WINDOW_START, 240);
    expect(scope.scheduledSessionId).toBe(7);
    expect(scope.windowStart).toBe(WINDOW_START);
    expect(scope.windowEnd).toBe(WINDOW_END);
  });

  it('caps the window at the next scheduled session start', () => {
    const scope = postSessionScope(1, WINDOW_START, 240, {
      now: new Date('2026-01-15T12:00:00.000Z'),
      nextSessionStartAt: '2026-01-11T18:00:00.000Z',
    });
    expect(scope.windowEnd).toBe('2026-01-11T18:00:00.000Z');
  });

  it('filters source material to the session window only', () => {
    const filtered = filterSourceByScope(fullSource(), sessionScope());
    expect(filtered.resolvedInbox).toHaveLength(1);
    expect(filtered.resolvedInbox[0].body).toBe('session note');
    expect(filtered.encounters).toHaveLength(1);
    expect(filtered.encounters[0].name).toBe('Cave fight');
    expect(filtered.diceRolls).toHaveLength(1);
    expect(filtered.diceRolls![0].label).toBe('session');
  });

  it('includes encounters linked to a session played inside the window', () => {
    const source = fullSource();
    source.encounters.push({
      name: 'Linked fight',
      status: 'ended',
      combatants: [],
      sessionId: 99,
      endedAt: null,
      updatedAt: '2025-12-01T00:00:00.000Z',
    } as RecapDraftSource['encounters'][number]);
    const filtered = filterSourceByScope(
      source,
      sessionScope(),
      new Map([[99, '2026-01-10T21:00:00.000Z']]),
    );
    expect(filtered.encounters.map((e) => e.name)).toEqual(expect.arrayContaining(['Cave fight', 'Linked fight']));
  });

  it('filters by cursor for incremental cron runs', () => {
    const filtered = filterSourceByScope(fullSource(), { sinceAt: '2026-01-09T00:00:00.000Z', sinceMs: Date.parse('2026-01-09T00:00:00.000Z') });
    expect(filtered.resolvedInbox).toHaveLength(1);
    expect(filtered.encounters).toHaveLength(1);
    expect(filtered.diceRolls).toHaveLength(1);
  });

  it('builds source stats and estimates prompt tokens', () => {
    const filtered = filterSourceByScope(fullSource(), sessionScope());
    const stats = sourceStatsFrom(filtered, sessionScope());
    expect(stats).toMatchObject({
      scheduledSessionId: 42,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      resolvedInbox: 1,
      encounters: 1,
      diceRolls: 1,
    });
    expect(estimatePromptTokens('abcd')).toBe(1);
  });

  it('filters many rows efficiently for long campaigns (#499)', () => {
    const inbox = Array.from({ length: 500 }, (_, i) => ({
      body: `note ${i}`,
      resolvedNote: 'ok',
      entityName: null,
      updatedAt: i < 250 ? '2026-01-01T12:00:00.000Z' : '2026-01-10T19:00:00.000Z',
    }));
    const source: RecapDraftSource = {
      resolvedInbox: inbox as unknown as RecapDraftSource['resolvedInbox'],
      encounters: [],
      diceRolls: [],
    };
    const filtered = filterSourceByScope(source, sessionScope());
    expect(filtered.resolvedInbox).toHaveLength(250);
  });
});
