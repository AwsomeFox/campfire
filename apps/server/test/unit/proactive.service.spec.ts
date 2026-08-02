import { Test, TestingModule } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { ProactiveService } from '../../src/modules/ai-driver/proactive.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import type { CampaignEvent } from '@campfire/schema';
import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';
import { AiDmService } from '../../src/modules/ai-dm/ai-dm.service';

describe('ProactiveService', () => {
  let service: ProactiveService;
  let events: jest.Mocked<CampaignEventsService>;
  let driver: jest.Mocked<AiDriverService>;
  let aiDm: jest.Mocked<AiDmService>;
  let eventStream: Subject<CampaignEvent>;

  beforeEach(async () => {
    eventStream = new Subject<CampaignEvent>();
    events = {
      streamFor: jest.fn().mockReturnValue(eventStream),
    } as any;

    driver = {
      getSession: jest.fn().mockReturnValue({ status: 'idle' }),
      systemActor: jest.fn().mockReturnValue({ id: 'system:proactive' }),
      runTurn: jest.fn().mockResolvedValue({ tokensUsed: 100 }),
    } as any;

    aiDm = {
      registerProactiveSettingsCallback: jest.fn(),
      isExperimentalEnabled: jest.fn().mockResolvedValue(true),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProactiveService,
        { provide: CampaignEventsService, useValue: events },
        { provide: AiDriverService, useValue: driver },
        { provide: AiDmService, useValue: aiDm },
      ],
    }).compile();

    service = module.get<ProactiveService>(ProactiveService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('subscribes to events when startWatching is called with active triggers', () => {
    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: true, hpCritical: false, objectiveCompleted: false, npcTurn: false },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    });

    expect(events.streamFor).toHaveBeenCalledWith(1);
    expect(service.isWatching(1)).toBe(true);
  });

  it('does not subscribe if no triggers are enabled', () => {
    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: false, hpCritical: false, objectiveCompleted: false, npcTurn: false },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    });

    expect(events.streamFor).not.toHaveBeenCalled();
    expect(service.isWatching(1)).toBe(false);
  });

  it('triggers a proactive turn on matching event', async () => {
    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: true, hpCritical: false, objectiveCompleted: false, npcTurn: false },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    });

    eventStream.next({ type: 'encounter.ended' } as any);

    // wait for promises
    await new Promise(setImmediate);

    expect(driver.runTurn).toHaveBeenCalledWith(
      1,
      { id: 'system:proactive' },
      expect.stringContaining('encounter has just ended'),
      expect.objectContaining({ proactive: true })
    );
  });

  it('respects cooldown between triggers', async () => {
    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: true, hpCritical: false, objectiveCompleted: false, npcTurn: false },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    });

    eventStream.next({ type: 'encounter.ended' } as any);
    eventStream.next({ type: 'encounter.ended' } as any); // Should be ignored

    await new Promise(setImmediate);

    expect(driver.runTurn).toHaveBeenCalledTimes(1);
  });

  it('skips if session is busy', async () => {
    driver.getSession.mockReturnValue({ status: 'running', state: 'running' } as any);

    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: true, hpCritical: false, objectiveCompleted: false, npcTurn: false },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    });

    eventStream.next({ type: 'encounter.ended' } as any);

    await new Promise(setImmediate);

    expect(driver.runTurn).not.toHaveBeenCalled();
  });

  it('skips if session is frozen in human_control', async () => {
    driver.getSession.mockReturnValue({ status: 'idle', state: 'human_control' } as any);

    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: true, hpCritical: false, objectiveCompleted: false, npcTurn: false },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    });

    eventStream.next({ type: 'encounter.ended' } as any);

    await new Promise(setImmediate);

    expect(driver.runTurn).not.toHaveBeenCalled();
  });

  it('does not trigger hpCritical when HP data is missing', async () => {
    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: false, hpCritical: true, objectiveCompleted: false, npcTurn: false },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    });

    eventStream.next({ type: 'character.updated', data: { characterId: 1 } } as any);

    await new Promise(setImmediate);

    expect(driver.runTurn).not.toHaveBeenCalled();
  });

  it('rejects unknown manual trigger types without a custom prompt', async () => {
    await expect(service.manualTrigger(1, 'notARealTrigger')).rejects.toThrow('Unknown proactive trigger type');
  });

  it('respects hourly token budget', async () => {
    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: true, hpCritical: false, objectiveCompleted: false, npcTurn: false },
      cooldownSeconds: 0,
      maxProactiveTokensPerHour: 50, // budget is 50, turn takes 100
    });

    eventStream.next({ type: 'encounter.ended' } as any);
    await new Promise(setImmediate);
    expect(driver.runTurn).toHaveBeenCalledTimes(1); // First turn allowed (budget checked before turn)

    eventStream.next({ type: 'encounter.ended' } as any);
    await new Promise(setImmediate);
    expect(driver.runTurn).toHaveBeenCalledTimes(1); // Second turn blocked
  });

  it('triggers proactive turn on encounter.turn_changed for NPC combatant', async () => {
    service.startWatching(1, {
      enabled: true,
      triggers: { encounterEnded: false, hpCritical: false, objectiveCompleted: false, npcTurn: true },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    });

    eventStream.next({ type: 'encounter.turn_changed', combatantKind: 'npc' } as any);
    await new Promise(setImmediate);

    expect(driver.runTurn).toHaveBeenCalledWith(
      1,
      { id: 'system:proactive' },
      expect.stringContaining('NPC or monster turn'),
      expect.objectContaining({ proactive: true })
    );
  });

  it('manualTrigger executes immediately', async () => {
    await service.manualTrigger(1, 'encounterEnded', 'custom prompt');

    expect(driver.runTurn).toHaveBeenCalledWith(
      1,
      { id: 'system:proactive' },
      'custom prompt',
      expect.objectContaining({ proactive: true })
    );
  });
});
