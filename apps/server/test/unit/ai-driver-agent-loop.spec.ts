import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';
import { MockAiProvider } from '../../src/modules/ai-dm/providers/mock-provider';
import type { RequestUser } from '../../src/common/user.types';
import type { AiDmTranscriptEvent } from '@campfire/schema';

/**
 * Issue #1497 — the core AI Driver turn loop had three defects:
 *   1. A throw before the step loop left `session.status = 'running'` forever.
 *   2. `session.scene` was never fed back into the system prompt.
 *   3. Conversation memory existed in `buildPromptHistory` but this integration was
 *      the place that actually had to use it.
 *
 * This is a service-level test: it drives `AiDriverService.runTurn` directly with a
 * mocked provider and transcript, so the exact failure modes (pre-loop throw,
 * history replay, scene injection) are exercised without an HTTP layer or real model.
 */

describe('AI Driver agent loop (#1497)', () => {
  const CAMPAIGN_ID = 1;

  let driver: AiDriverService;
  let mockProvider: MockAiProvider;
  let resolveForExecutionCalls: number;
  let listForPromptCalls: number;
  let transcriptEventsForPrompt: AiDmTranscriptEvent[];
  let recordSeq: number;

  function user(id: string, name: string = id): RequestUser {
    return { id, name, serverRole: 'user' } as RequestUser;
  }

  beforeEach(() => {
    resolveForExecutionCalls = 0;
    listForPromptCalls = 0;
    recordSeq = 0;
    transcriptEventsForPrompt = [];

    mockProvider = new MockAiProvider({
      responses: [
        { text: 'The innkeeper is Elsi.', finishReason: 'stop' },
        { text: 'Elsi.', finishReason: 'stop' },
      ],
    });

    const resolver = {
      resolveForExecution: jest.fn().mockImplementation(async () => {
        resolveForExecutionCalls += 1;
        if (resolveForExecutionCalls === 1) {
          throw new BadRequestException('resolved model is not on the allowlist');
        }
        return { provider: mockProvider, model: 'mock-model' };
      }),
    };

    const transcript = {
      record: jest.fn().mockImplementation(() => {
        recordSeq += 1;
        return recordSeq;
      }),
      listForPrompt: jest.fn().mockImplementation(() => {
        listForPromptCalls += 1;
        return listForPromptCalls === 1 ? [] : transcriptEventsForPrompt;
      }),
      promptHistoryDepth: jest.fn().mockReturnValue(0),
    };

    const SEAT_OK = { tokenBudget: 1000, tokensUsed: 0, budgetRemaining: 1000, actionQueueDepth: 5 };

    const aiDm = {
      assertRunnable: jest.fn<any>().mockResolvedValue(SEAT_OK),
      assertWithinServerTokenCap: jest.fn<any>().mockResolvedValue(undefined),
      withSpendLock: jest.fn<any>().mockImplementation(async (_id: any, fn: any) => fn()),
      getSeat: jest.fn<any>().mockResolvedValue(SEAT_OK),
      reserveTokenBudget: jest.fn<any>().mockResolvedValue({ tokensReserved: 1000 }),
      markReservationUsageUnknown: jest.fn<any>().mockResolvedValue({ seat: SEAT_OK, budgetRemaining: 900 }),
      meterTurn: jest.fn<any>().mockResolvedValue({
        seat: { tokenBudget: 1000, tokensUsed: 100, budgetRemaining: 900 },
        tokensUsed: 100,
        budgetRemaining: 900,
      }),
      isExperimentalEnabled: jest.fn<any>().mockResolvedValue(true),
      registerDriverSessionTeardown: jest.fn(),
    };

    const mcpTools = {
      buildToolset: jest.fn().mockReturnValue({
        tools: [],
        get: jest.fn(),
        call: jest.fn(),
      }),
    };

    const audit = { log: jest.fn() };
    const stream = { emit: jest.fn(), streamFor: jest.fn() };
    const notifications = {};
    const supportPreferences = { listForPublicAiNarration: jest.fn<any>().mockResolvedValue([]) };
    const campaigns = {
      getOrThrow: jest.fn<any>().mockResolvedValue({
        id: CAMPAIGN_ID,
        ruleSystem: 'dnd5e',
        narrationLanguage: 'en',
      }),
    };
    const rules = {};
    const encounters = {
      listForCampaign: jest.fn<any>().mockResolvedValue([]),
    };
    const members = { listForCampaign: jest.fn<any>().mockResolvedValue([]) };
    const characters = { getOrThrow: jest.fn() };

    driver = new AiDriverService(
      aiDm as any,
      mcpTools as any,
      audit as any,
      stream as any,
      notifications as any,
      supportPreferences as any,
      resolver as any,
      campaigns as any,
      rules as any,
      encounters as any,
      members as any,
      characters as any,
      transcript as any,
      { correctionsForPrompt: async () => [] } as any,
    );
  });

  it('pre-loop throw releases the running slot, and the next turn carries history and scene', async () => {
    // ── Turn 1: a provider-resolution throw must NOT brick the seat.
    await expect(
      driver.runTurn(CAMPAIGN_ID, user('player-1'), 'We meet at the inn.', {}),
    ).rejects.toThrow(/resolved model is not on the allowlist/);

    const session = (driver as any).sessions.get(CAMPAIGN_ID);
    expect(session.status).toBe('idle');

    // ── Turn 2: a DM sets the scene and gets a clean, complete turn.
    const dmOpts = { callerRole: 'dm' as const, scene: 'A rainy evening at the Tipsy Troll' };
    const turn2 = await driver.runTurn(CAMPAIGN_ID, user('dm', 'DM'), 'Set the scene at the Tipsy Troll.', dmOpts);
    expect(turn2.stopReason).toBe('complete');
    expect(turn2.narration).toBe('The innkeeper is Elsi.');
    expect(session.status).toBe('idle');
    expect(session.scene).toBe('A rainy evening at the Tipsy Troll');

    // The scene set on turn 2 appears in the prompt for turn 3, not on the turn that set it.
    expect(mockProvider.received).toHaveLength(1);
    const turn2Req = mockProvider.received[0];
    expect(turn2Req.system).not.toContain('## Current scene');
    expect(turn2Req.messages).toHaveLength(1);

    // ── Turn 3: the player asks a follow-up. The prompt must replay turn 2 and the scene.
    transcriptEventsForPrompt = [
      {
        eventId: 'e1',
        seq: 1,
        campaignId: CAMPAIGN_ID,
        kind: 'player.action',
        actorUserId: null,
        actorName: 'DM',
        clientRef: null,
        turnId: null,
        payload: { text: 'Set the scene at the Tipsy Troll.' },
        at: '2026-07-27T10:00:00.000Z',
      } as AiDmTranscriptEvent,
      {
        eventId: 'e2',
        seq: 2,
        campaignId: CAMPAIGN_ID,
        kind: 'narration',
        actorUserId: null,
        actorName: null,
        clientRef: null,
        turnId: null,
        payload: { text: 'The innkeeper is Elsi.' },
        at: '2026-07-27T10:00:01.000Z',
      } as AiDmTranscriptEvent,
    ];

    const turn3 = await driver.runTurn(CAMPAIGN_ID, user('player-1'), 'What was her name again?', {});
    expect(turn3.stopReason).toBe('complete');
    expect(turn3.narration).toBe('Elsi.');
    expect(session.status).toBe('idle');

    expect(mockProvider.received).toHaveLength(2);
    const turn3Req = mockProvider.received[1];

    // Conversation memory: the third turn's provider request carries the second turn's
    // player message and the model's reply, then the new player message.
    expect(turn3Req.messages).toHaveLength(3);
    expect(turn3Req.messages[0].role).toBe('user');
    expect(turn3Req.messages[0].content).toContain('Set the scene at the Tipsy Troll.');
    expect(turn3Req.messages[1].role).toBe('assistant');
    expect(turn3Req.messages[1].content).toContain('Elsi');
    expect(turn3Req.messages[2].role).toBe('user');
    expect(turn3Req.messages[2].content).toContain('What was her name again?');

    // Scene injection: the persisted scene appears in the system prompt.
    expect(turn3Req.system).toContain('## Current scene');
    expect(turn3Req.system).toContain('A rainy evening at the Tipsy Troll');
  });
});
