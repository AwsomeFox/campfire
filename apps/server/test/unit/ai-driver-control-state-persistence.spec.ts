import { describe, expect, it, jest } from '@jest/globals';
import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';

type Ctor = ConstructorParameters<typeof AiDriverService>;
type PersistedRow = {
  campaignId: number;
  status: string;
  state: string;
  scene: string | null;
  lastNarration: string | null;
  lastTurnAt: string | null;
  turnCount: number;
  stuck: string | null;
  actingDm: string | null;
  vote: string | null;
  takeoverRequestedBy: string | null;
  lastInput: string | null;
  updatedAt: string;
};

function makeDb(seed?: PersistedRow) {
  const rows = new Map<number, PersistedRow>();
  if (seed) rows.set(seed.campaignId, seed);
  return {
    rows,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              get: () => rows.values().next().value,
            }),
          }),
        }),
      }),
      insert: () => ({
        values: (values: PersistedRow) => ({
          onConflictDoUpdate: ({ set }: { set: Partial<PersistedRow> }) => ({
            run: () => {
              rows.set(values.campaignId, { ...values, ...set });
            },
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          run: () => rows.clear(),
        }),
      }),
    },
  };
}

function makeService(db: unknown): AiDriverService {
  const aiDm = { registerDriverSessionTeardown: jest.fn() };
  const audit = { log: jest.fn(async () => undefined) };
  const stream = { emit: jest.fn() };
  const notifications = {
    memberRoles: jest.fn(async () => new Map<number, string>([[1, 'player'], [2, 'player']])),
    notifyCampaign: jest.fn(async () => undefined),
  };
  return new AiDriverService(
    aiDm as unknown as Ctor[0],
    undefined as unknown as Ctor[1],
    audit as unknown as Ctor[2],
    stream as unknown as Ctor[3],
    notifications as unknown as Ctor[4],
    undefined as unknown as Ctor[5],
    undefined as unknown as Ctor[6],
    undefined as unknown as Ctor[7],
    undefined as unknown as Ctor[8],
    undefined as unknown as Ctor[9],
    undefined as unknown as Ctor[10],
    undefined as unknown as Ctor[11],
    db as Ctor[12],
  );
}

describe('AiDriverService control-state persistence (#559)', () => {
  it('persists pause state and hydrates it after a restart', () => {
    const store = makeDb();
    const service = makeService(store.db);

    service.setPaused(7, true);

    const restarted = makeService(store.db);
    const session = restarted.getSession(7);
    expect(session.status).toBe('paused');
    expect(session.state).toBe('paused');
    expect(session.levers).toContain('resume');
  });

  it('persists takeover request, grant, and handback transitions', async () => {
    const store = makeDb();
    const service = makeService(store.db);
    const player = { id: 'player-1', name: 'Player One', serverRole: 'user' as const };
    const dm = { id: 'dm-1', name: 'DM One', serverRole: 'user' as const };

    await service.requestTakeover(7, player, 'player');
    await service.grantTakeover(7, dm, undefined, 'take it from here', 'dm');

    const restarted = makeService(store.db);
    const held = restarted.getSession(7);
    expect(held.status).toBe('paused');
    expect(held.state).toBe('human_control');
    expect(held.actingDm?.memberId).toBe('player-1');

    await restarted.handback(7, player, 'resolved by the table', 'player');
    const handedBack = makeService(store.db).getSession(7);
    expect(handedBack.status).toBe('idle');
    expect(handedBack.state).toBe('running');
    expect(handedBack.actingDm).toBeNull();
  });

  it('persists open votes, ballots, and resolved pause outcome', async () => {
    const store = makeDb();
    const service = makeService(store.db);
    const p1 = { id: '1', name: 'P1', serverRole: 'user' as const };
    const p2 = { id: '2', name: 'P2', serverRole: 'user' as const };

    await service.openVote(7, p1, 'pause', 'player');
    await service.castVote(7, p1, true, 'player');

    const restarted = makeService(store.db);
    expect(restarted.getSession(7).vote?.ballots).toEqual({ '1': true });

    await restarted.castVote(7, p2, true, 'player');
    const resolved = makeService(store.db).getSession(7);
    expect(resolved.state).toBe('paused');
    expect(resolved.vote?.resolved).toBe(true);
    expect(resolved.vote?.outcome).toBe('passed');
  });

  it('hydrates stuck state with replay input for retry levers', () => {
    const store = makeDb({
      campaignId: 7,
      status: 'idle',
      state: 'awaiting_players',
      scene: null,
      lastNarration: 'The ruling stalled.',
      lastTurnAt: '2026-07-26T00:00:00.000Z',
      turnCount: 3,
      stuck: JSON.stringify({
        reason: 'provider_error',
        detail: 'The AI provider failed during generation.',
        since: '2026-07-26T00:00:01.000Z',
        turn: 3,
      }),
      actingDm: null,
      vote: null,
      takeoverRequestedBy: null,
      lastInput: 'I open the crypt door.',
      updatedAt: '2026-07-26T00:00:02.000Z',
    });

    const service = makeService(store.db);
    const session = service.getSession(7);
    expect(session.state).toBe('awaiting_players');
    expect(session.stuck?.reason).toBe('provider_error');
    expect(session.levers).toContain('retry');
    expect((service as unknown as { requireReplayInput: (campaignId: number) => string }).requireReplayInput(7)).toBe(
      'I open the crypt door.',
    );
  });
});
