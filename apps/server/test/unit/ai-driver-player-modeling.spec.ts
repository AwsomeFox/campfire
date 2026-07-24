import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { AiDriverService, setDriverStreamIdleTimeoutMsForTests } from '../../src/modules/ai-driver/ai-driver.service';
import { ConflictException } from '@nestjs/common';
import type { RequestUser } from '../../src/common/user.types';
import type { AiDmSeat } from '@campfire/schema';

describe('ai-driver-player-modeling', () => {
  let aiDm: any;
  let mcpTools: any;
  let audit: any;
  let stream: any;
  let notifications: any;
  let supportPreferences: any;
  let resolver: any;
  let campaigns: any;
  let rules: any;
  let encounters: any;
  let members: any;
  let characters: any;
  let driver: AiDriverService;

  beforeEach(() => {
    aiDm = {
      assertRunnable: jest.fn<any>().mockResolvedValue({ tokenBudget: 1000, tokensUsed: 0, actionQueueDepth: 2 } as AiDmSeat),
      assertWithinServerTokenCap: jest.fn<any>().mockResolvedValue(undefined),
      withSpendLock: jest.fn<any>().mockImplementation(async (id: any, fn: any) => fn()),
      getSeat: jest.fn<any>().mockResolvedValue({ tokenBudget: 1000, tokensUsed: 0, actionQueueDepth: 2 } as AiDmSeat),
      meterTurn: jest.fn<any>().mockResolvedValue({ seat: { tokenBudget: 1000, tokensUsed: 100 }, budgetRemaining: 900 }),
      registerDriverSessionTeardown: jest.fn(),
    };
    mcpTools = {
      buildToolset: jest.fn().mockReturnValue({
        tools: [],
        get: jest.fn(),
        call: jest.fn(),
      }),
    };
    audit = { log: jest.fn() };
    stream = { emit: jest.fn(), streamFor: jest.fn() };
    notifications = {};
    supportPreferences = { listForPublicAiNarration: jest.fn<any>().mockResolvedValue([]) };
    resolver = { resolveEffectiveConfig: jest.fn() };
    campaigns = {};
    rules = {};
    encounters = {};
    members = {
      listForCampaign: jest.fn<any>().mockResolvedValue([]),
    };
    characters = {
      getOrThrow: jest.fn(),
    };
    driver = new AiDriverService(
      aiDm, mcpTools, audit, stream, notifications, supportPreferences, resolver, campaigns, rules, encounters, members, characters
    );
    // Mock resolveProviderForExecution inside ai-driver.service by spying? No, we can just mock resolver
    // Wait, resolveProviderForExecution is not a class method, it's imported. So we need to mock it.
    // Instead of doing actual integration tests, we can just test the behavior.
  });

  it('System prompt contains ## Players at the table', async () => {
    // Check assembleSystemPrompt
    members.listForCampaign.mockResolvedValue([
      { role: 'dm', username: 'the_dm' },
      { role: 'player', username: 'player1', characterId: 101 },
      { role: 'player', username: 'player2' }, // no char
    ]);
    characters.getOrThrow.mockResolvedValueOnce({ name: 'Thor', level: 5, className: 'Fighter', hpCurrent: 30, hpMax: 30 });

    const seat = { tokenBudget: 100, tokensUsed: 0, instructions: '' } as AiDmSeat;
    const prompt = await (driver as any).assembleSystemPrompt(1, seat);
    expect(prompt).toContain('## Players at the table');
    expect(prompt).toContain('- **DM**: the_dm');
    expect(prompt).toContain('- **Thor** (played by player1) — Level 5 Fighter, HP 30/30');
    expect(prompt).toContain('- **player2** (no character assigned)');
  });

  it('Action queue depth configurable from seat settings', async () => {
    const depth = await (driver as any).getActionQueueDepth(1);
    expect(depth).toBe(2);
  });

});
