import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { Combatant, DiceRoll, EncounterWithCombatants } from '@campfire/schema';
import { RequestUser } from '../../src/common/user.types';
import { encounterOpFingerprint } from '../../src/modules/encounters/encounter-idempotency';
import { NotFoundException } from '@nestjs/common';

describe('EncountersService — rollCombatantInitiative replay visibility hardening (issue #1962)', () => {
  const playerUser: RequestUser = {
    id: 'user-player-1',
    name: 'Player 1',
    serverRole: 'user',
  };

  it('re-derives combatant projection on role-match idempotent replay', async () => {
    const staleCombatant: Combatant = {
      id: 42,
      encounterId: 10,
      name: 'Stale Hero Name',
      kind: 'character',
      initiative: 10,
      hpCurrent: 20,
      hpMax: 20,
      hpTemp: 0,
      ac: 14,
      conditions: [],
      hidden: false,
      sortOrder: 0,
    } as any;

    const freshCombatant: Combatant = {
      id: 42,
      encounterId: 10,
      name: 'Fresh Hero Name (Updated)',
      kind: 'character',
      initiative: 15,
      hpCurrent: 20,
      hpMax: 20,
      hpTemp: 0,
      ac: 14,
      conditions: [],
      hidden: false,
      sortOrder: 0,
    } as any;

    const freshSnapshot: EncounterWithCombatants = {
      id: 10,
      campaignId: 1,
      name: 'Test Encounter',
      status: 'active',
      round: 1,
      turnIndex: 0,
      combatants: [freshCombatant],
      fog: null,
      mapAttachmentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    const mockRoll: DiceRoll = {
      id: 99,
      campaignId: 1,
      rollerUserId: 'user-player-1',
      rollerName: 'Player 1',
      expression: '1d20+2',
      total: 15,
      pureTotal: 15,
      breakdown: '1d20 (13) + 2',
      createdAt: new Date().toISOString(),
    } as any;

    const mockPriorResponse = {
      combatant: staleCombatant,
      roll: mockRoll,
    };

    const mockGetRowOrThrow = jest.fn().mockResolvedValue({
      id: 10,
      campaignId: 1,
      hidden: false,
    });

    const mockGetWithCombatantsOrThrow = jest.fn().mockResolvedValue(freshSnapshot);

    const mockTx = {
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          run: jest.fn(),
        }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              all: jest.fn().mockReturnValue([
                {
                  actorId: 'user-player-1',
                  operation: 'combatant.roll_initiative',
                  key: 'idem-key-1',
                  encounterId: 10,
                  campaignId: 1,
                  fingerprint: encounterOpFingerprint({ combatantId: 42, overwrite: true }),
                  responseRole: 'player',
                  responseJson: JSON.stringify(mockPriorResponse),
                  expiresAt: Date.now() + 100000,
                },
              ]),
            }),
          }),
        }),
      }),
    };

    const mockTransaction = jest.fn().mockImplementation((cb: (tx: any) => void) => {
      return cb(mockTx);
    });

    const mockDb = {
      transaction: mockTransaction,
      select: mockTx.select,
    };

    const rollsDouble: Pick<RollsService, 'redactRollForRole'> = {
      redactRollForRole: jest.fn().mockImplementation(async (roll) => roll),
    };

    const serviceTarget = new EncountersService(
      mockDb as any,
      {} as any,
      {} as any,
      rollsDouble as unknown as RollsService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      null as any,
    );

    jest.spyOn(serviceTarget, 'getRowOrThrow').mockImplementation(mockGetRowOrThrow);
    jest.spyOn(serviceTarget, 'getWithCombatantsOrThrow').mockImplementation(mockGetWithCombatantsOrThrow);

    const result = await serviceTarget.rollCombatantInitiative(
      10,
      42,
      'idem-key-1',
      true,
      playerUser,
      'player',
    );

    expect(mockGetWithCombatantsOrThrow).toHaveBeenCalledWith(10, 'player', 'user-player-1', true);
    expect(result).not.toBeNull();
    expect(result!.combatant.name).toBe('Fresh Hero Name (Updated)');
    expect(result!.combatant.initiative).toBe(15);
  });

  it('falls back to stored redacted response when combatant is hard-deleted after roll', async () => {
    const deletedCombatant: Combatant = {
      id: 42,
      encounterId: 10,
      name: 'Deleted Hero Name',
      kind: 'character',
      initiative: 10,
    } as any;

    const emptySnapshot: EncounterWithCombatants = {
      id: 10,
      campaignId: 1,
      name: 'Test Encounter',
      status: 'active',
      round: 1,
      turnIndex: 0,
      combatants: [],
      fog: null,
      mapAttachmentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    const mockPriorResponse = {
      combatant: deletedCombatant,
      roll: null,
    };

    const mockTxDeleted = {
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          run: jest.fn(),
        }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              all: jest.fn().mockReturnValue([
                {
                  actorId: 'user-player-1',
                  operation: 'combatant.roll_initiative',
                  key: 'idem-key-deleted',
                  encounterId: 10,
                  campaignId: 1,
                  fingerprint: encounterOpFingerprint({ combatantId: 42, overwrite: true }),
                  responseRole: 'player',
                  responseJson: JSON.stringify(mockPriorResponse),
                  expiresAt: Date.now() + 100000,
                },
              ]),
            }),
          }),
        }),
      }),
    };

    const mockDb = {
      transaction: jest.fn().mockImplementation((cb: (tx: any) => void) => cb(mockTxDeleted)),
      select: mockTxDeleted.select,
    };

    const rollsDouble: Pick<RollsService, 'redactRollForRole'> = {
      redactRollForRole: jest.fn().mockImplementation(async (roll) => roll),
    };

    const serviceTarget = new EncountersService(
      mockDb as any,
      {} as any,
      {} as any,
      rollsDouble as unknown as RollsService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      null as any,
    );

    jest.spyOn(serviceTarget, 'getRowOrThrow').mockResolvedValue({ id: 10, campaignId: 1, hidden: false } as any);
    jest.spyOn(serviceTarget, 'getWithCombatantsOrThrow').mockResolvedValue(emptySnapshot);

    const result = await serviceTarget.rollCombatantInitiative(
      10,
      42,
      'idem-key-deleted',
      true,
      playerUser,
      'player',
    );

    expect(result).not.toBeNull();
    expect(result!.combatant.id).toBe(42);
    expect(result!.combatant.name).toBe('Deleted Hero Name');
  });
  it('re-applies fog redaction to stored response when combatant is hard-deleted and fog is enabled', async () => {
    const deletedTokenCombatant: Combatant = {
      id: 42,
      encounterId: 10,
      name: 'Deleted Token',
      kind: 'character',
      initiative: 10,
      tokenX: 100,
      tokenY: 200,
    } as any;

    const emptySnapshot: EncounterWithCombatants = {
      id: 10,
      campaignId: 1,
      name: 'Test Encounter',
      status: 'active',
      round: 1,
      turnIndex: 0,
      combatants: [],
      fog: JSON.stringify({ enabled: true, revealed: [] }),
      mapAttachmentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    const mockPriorResponse = {
      combatant: deletedTokenCombatant,
      roll: null,
    };

    const mockTxDeleted = {
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          run: jest.fn(),
        }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              all: jest.fn().mockReturnValue([
                {
                  actorId: 'user-player-1',
                  operation: 'combatant.roll_initiative',
                  key: 'idem-key-deleted-fog',
                  encounterId: 10,
                  campaignId: 1,
                  fingerprint: encounterOpFingerprint({ combatantId: 42, overwrite: true }),
                  responseRole: 'player',
                  responseJson: JSON.stringify(mockPriorResponse),
                  expiresAt: Date.now() + 100000,
                },
              ]),
            }),
          }),
        }),
      }),
    };

    const mockDb = {
      transaction: jest.fn().mockImplementation((cb: (tx: any) => void) => cb(mockTxDeleted)),
      select: mockTxDeleted.select,
    };

    const rollsDouble: Pick<RollsService, 'redactRollForRole'> = {
      redactRollForRole: jest.fn().mockImplementation(async (roll) => roll),
    };

    const attachmentsServiceDouble: Pick<AttachmentsService, 'isFogProtectedEncounterMap'> = {
      isFogProtectedEncounterMap: jest.fn().mockResolvedValue(false),
    };

    const serviceTarget = new EncountersService(
      mockDb as any,
      {} as any,
      {} as any,
      rollsDouble as unknown as RollsService,
      {} as any,
      attachmentsServiceDouble as unknown as AttachmentsService,
      {} as any,
      {} as any,
      null as any,
    );

    jest.spyOn(serviceTarget, 'getRowOrThrow').mockResolvedValue({ id: 10, campaignId: 1, hidden: false, fog: JSON.stringify({ enabled: true, revealed: [] }), mapAttachmentId: null } as any);
    jest.spyOn(serviceTarget, 'getWithCombatantsOrThrow').mockResolvedValue(emptySnapshot);

    const result = await serviceTarget.rollCombatantInitiative(
      10,
      42,
      'idem-key-deleted-fog',
      true,
      playerUser,
      'player',
    );

    expect(result).not.toBeNull();
    expect(result!.combatant.id).toBe(42);
    // Token coordinates must be redacted in fog for player
    expect(result!.combatant.tokenX).toBeNull();
    expect(result!.combatant.tokenY).toBeNull();
  });

  it('does not replay a stored player projection if the encounter becomes hidden during the fresh read', async () => {
    const storedCombatant: Combatant = {
      id: 42,
      encounterId: 10,
      name: 'Stored Hero',
      kind: 'character',
      initiative: 10,
      tokenX: 100,
      tokenY: 200,
    } as any;

    const mockTx = {
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ run: jest.fn() }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              all: jest.fn().mockReturnValue([
                {
                  actorId: 'user-player-1',
                  operation: 'combatant.roll_initiative',
                  key: 'idem-key-hidden-race',
                  encounterId: 10,
                  campaignId: 1,
                  fingerprint: encounterOpFingerprint({ combatantId: 42, overwrite: true }),
                  responseRole: 'player',
                  responseJson: JSON.stringify({ combatant: storedCombatant, roll: null }),
                  expiresAt: Date.now() + 100000,
                },
              ]),
            }),
          }),
        }),
      }),
    };
    const mockDb = {
      transaction: jest.fn().mockImplementation((cb: (tx: any) => void) => cb(mockTx)),
      select: mockTx.select,
    };
    const rollsDouble: Pick<RollsService, 'redactRollForRole'> = {
      redactRollForRole: jest.fn().mockImplementation(async (roll) => roll),
    };
    const serviceTarget = new EncountersService(
      mockDb as any,
      {} as any,
      {} as any,
      rollsDouble as unknown as RollsService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      null as any,
    );

    jest
      .spyOn(serviceTarget, 'getRowOrThrow')
      .mockResolvedValueOnce({ id: 10, campaignId: 1, hidden: false } as any)
      .mockResolvedValueOnce({ id: 10, campaignId: 1, hidden: true, fog: null, mapAttachmentId: null } as any);
    jest
      .spyOn(serviceTarget, 'getWithCombatantsOrThrow')
      .mockRejectedValue(new NotFoundException('Encounter 10 not found'));

    await expect(
      serviceTarget.rollCombatantInitiative(
        10,
        42,
        'idem-key-hidden-race',
        true,
        playerUser,
        'player',
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
