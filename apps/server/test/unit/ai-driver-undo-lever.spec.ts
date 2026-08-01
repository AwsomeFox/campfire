import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  AiDriverService,
  recordDriverUndoableCommit,
} from '../../src/modules/ai-driver/ai-driver.service';
import { pendingConfirmationKey } from '../../src/modules/ai-driver/driver-tool-policy';
import { ActionResolverService } from '../../src/modules/encounters/action-resolver.service';
import type { RequestUser } from '../../src/common/user.types';

/**
 * DM undo of the AI seat's last committed action — the catch-block classification (#1501 review).
 *
 * `undoLastSeatAction` drives `ActionResolverService.undo`, which can fail for three qualitatively
 * different reasons, and the lever (`session.lastUndoableCommit`, which is the ONLY thing that
 * keeps the DM's undo button on screen) must react differently to each:
 *
 *  - STALE — the chain was already undone (the model called undo_action itself, a prior DM undo
 *    raced this one and won the conditional claim), no longer exists, or belongs to another
 *    encounter. The lever is dead: clear it and answer 404 "nothing left to undo".
 *  - GONE — `ActionResolverService.undo` throws a NotFoundException when the encounter the AI acted
 *    in (or its actor combatant) was deleted, so the action can no longer be reversed. The lever is
 *    dead here too: clear it and answer 404, or the cached session keeps the lever and the header
 *    button stays on screen as a silent no-op (#1501 review).
 *  - RETRYABLE — a busy database or an `assertTargetAllowed` target guard. The chain is STILL
 *    undoable, so the lever must STAY ARMED (the DM can try again) and the concrete error must be
 *    rethrown.
 *
 * This is a hand-constructed-service unit spec (the pattern of ai-driver-player-modeling.spec.ts)
 * rather than the e2e human-control spec, because the invariant under test is exactly how the
 * catch block classifies a controlled `resolver.undo` failure — something the real resolver only
 * produces through contrived, brittle setup. `db` is left unset so persistence is a no-op and the
 * session lives in memory; `ensureSession` degrades to a fresh session when `db` is absent.
 */

type Ctor = ConstructorParameters<typeof AiDriverService>;

const dm: RequestUser = { id: '9', name: 'DM One', serverRole: 'user' };
const campaignId = 1;

/** The subset of the resolver this lever actually calls — typed, not a blind cast (AGENTS.md). */
type ResolverDouble = Pick<ActionResolverService, 'undo'>;
type UndoMethod = ActionResolverService['undo'];

function makeDriver(resolverDouble: ResolverDouble): {
  driver: AiDriverService;
  audit: { log: jest.Mock };
  stream: { emit: jest.Mock };
  resolver: ResolverDouble;
} {
  const audit = { log: jest.fn(async () => undefined) };
  const stream = { emit: jest.fn() };
  const driver = new AiDriverService(
    { registerDriverSessionTeardown: jest.fn() } as unknown as Ctor[0],
    {} as unknown as Ctor[1],
    audit as unknown as Ctor[2],
    stream as unknown as Ctor[3],
    {} as unknown as Ctor[4],
    {} as unknown as Ctor[5],
    {} as unknown as Ctor[6],
    {} as unknown as Ctor[7],
    {} as unknown as Ctor[8],
    {} as unknown as Ctor[9],
    {} as unknown as Ctor[10],
    {} as unknown as Ctor[11],
    {} as unknown as Ctor[12],
    { correctionsForPrompt: async () => [] } as unknown as Ctor[13],
    undefined as unknown as Ctor[14], // db absent → persistence no-ops, in-memory session
    undefined as unknown as Ctor[15], // safety optional
    resolverDouble as unknown as Ctor[16],
  );
  return { driver, audit, stream, resolver: resolverDouble };
}

/** Arm the seat's undo lever exactly as a real apply_action result would. */
function arm(driver: AiDriverService): { encounterId: number; chainId: string } {
  const encounterId = 42;
  const actorCombatantId = 7;
  const chainId = 'chain-abc';
  // ensureSession is private; reach the canonical in-memory session the service itself uses.
  const session = (driver as unknown as { ensureSession: (id: number) => import('../../src/modules/ai-driver/ai-driver.service').AiDmSessionState }).ensureSession(campaignId);
  recordDriverUndoableCommit(session, encounterId, actorCombatantId, chainId, 'Practice Strike');
  expect(session.lastUndoableCommit).toMatchObject({ encounterId, chainId });
  return { encounterId, chainId };
}

describe('ai-driver undo lever — catch-block error classification (#1501)', () => {
  let resolver: ResolverDouble;

  beforeEach(() => {
    resolver = { undo: jest.fn<UndoMethod>() };
  });

  it('throws ServiceUnavailableException when the resolver is absent (undo is impossible)', async () => {
    const { driver } = makeDriver({ undo: jest.fn<UndoMethod>() });
    // Simulate the optional resolver never having been wired in.
    (driver as unknown as { actionResolver?: unknown }).actionResolver = undefined;
    arm(driver);
    await expect(driver.undoLastSeatAction(campaignId, dm)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws NotFoundException and leaves NO lever when nothing is armed', async () => {
    const { driver } = makeDriver(resolver);
    await expect(driver.undoLastSeatAction(campaignId, dm)).rejects.toBeInstanceOf(NotFoundException);
    expect(resolver.undo).not.toHaveBeenCalled();
  });

  describe('STALE reference — lever is cleared and the DM sees 404', () => {
    const staleMessages = [
      'This action was already undone.',
      'This action was never applied on this server (unknown chain).',
      'This chain belongs to a different encounter.',
      'Undo token is for a different encounter.',
      'Undo token has no chain id.',
    ];
    for (const message of staleMessages) {
      it(`clears the lever for stale message: "${message}"`, async () => {
        const { driver, audit } = makeDriver(resolver);
        arm(driver);
        (resolver.undo as jest.Mock).mockImplementation(() => {
          throw new BadRequestException(message);
        });

        await expect(driver.undoLastSeatAction(campaignId, dm)).rejects.toBeInstanceOf(NotFoundException);

        const session = (driver as unknown as { ensureSession: (id: number) => import('../../src/modules/ai-driver/ai-driver.service').AiDmSessionState }).ensureSession(campaignId);
        expect(session.lastUndoableCommit).toBeNull();
        // A stale undo is "nothing to undo", not a successful reversal — never audit it as one.
        expect(audit.log).not.toHaveBeenCalled();
      });
    }
  });

  describe('GONE reference — lever is cleared when the encounter/actor was deleted (#1501 review)', () => {
    it('clears the lever (and answers 404) when the resolver throws NotFoundException', async () => {
      const { driver, audit } = makeDriver(resolver);
      arm(driver);
      // `ActionResolverService.undo` throws this from `encounterRowOrThrow` when the fight the AI
      // acted in (or its actor combatant) was deleted. The action can no longer be reversed, so
      // keeping the lever armed would leave a header button that 404s on the client and never
      // surfaces an error (the refetched session would still carry the lever). Clear it instead.
      (resolver.undo as jest.Mock).mockImplementation(() => {
        throw new NotFoundException('Encounter 42 not found.');
      });

      await expect(driver.undoLastSeatAction(campaignId, dm)).rejects.toBeInstanceOf(NotFoundException);

      const session = (driver as unknown as { ensureSession: (id: number) => import('../../src/modules/ai-driver/ai-driver.service').AiDmSessionState }).ensureSession(campaignId);
      // The undo button is driven by the presence of this field — a deleted encounter means there
      // is nothing left to reverse, so it must be gone (not a permanently-armed dead button).
      expect(session.lastUndoableCommit).toBeNull();
      // "Nothing left to undo" is not a successful reversal — never audit it as one.
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('RETRYABLE failure — lever stays ARMED and the concrete error is rethrown', () => {
    it('keeps the lever armed for a target-guard BadRequestException (assertTargetAllowed)', async () => {
      const { driver, audit } = makeDriver(resolver);
      const { chainId } = arm(driver);
      // The exact message shape assertTargetAllowed throws — NOT a stale classification.
      const guard = new BadRequestException('"Practice Strike" may only target enemies.');
      (resolver.undo as jest.Mock).mockImplementation(() => {
        throw guard;
      });

      await expect(driver.undoLastSeatAction(campaignId, dm)).rejects.toBe(guard);

      const session = (driver as unknown as { ensureSession: (id: number) => import('../../src/modules/ai-driver/ai-driver.service').AiDmSessionState }).ensureSession(campaignId);
      // The undo button is driven by the presence of this field — it must still be there.
      expect(session.lastUndoableCommit).toMatchObject({ chainId });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('keeps the lever armed for a transient non-NotFound error (e.g. a busy database)', async () => {
      const { driver } = makeDriver(resolver);
      const { chainId } = arm(driver);
      // A transient failure that is NOT a missing reference (here a busy database surfaced as a
      // ServiceUnavailableException) is retryable: the chain is still undoable on the next attempt,
      // so the lever must stay armed and the concrete error must be rethrown unchanged. (A missing
      // encounter/actor is a NotFoundException — that is a GONE reference, covered above, and
      // clears the lever.)
      const retryable = new ServiceUnavailableException('The database is busy.');
      (resolver.undo as jest.Mock).mockImplementation(() => {
        throw retryable;
      });

      await expect(driver.undoLastSeatAction(campaignId, dm)).rejects.toBe(retryable);

      const session = (driver as unknown as { ensureSession: (id: number) => import('../../src/modules/ai-driver/ai-driver.service').AiDmSessionState }).ensureSession(campaignId);
      expect(session.lastUndoableCommit).toMatchObject({ chainId });
    });

    it('a retryable failure after a stale one still finds the lever armed (DM can recover)', async () => {
      // Arms the recovery path: a transient retryable failure must not strand the lever, so a
      // later successful undo still reverses the action and clears the reference.
      const { driver, audit, stream } = makeDriver(resolver);
      const { encounterId, chainId } = arm(driver);

      // First attempt: a retryable target guard rejection — lever stays armed.
      const guard = new BadRequestException('"Practice Strike" cannot target the actor.');
      (resolver.undo as jest.Mock).mockImplementationOnce(() => {
        throw guard;
      });
      await expect(driver.undoLastSeatAction(campaignId, dm)).rejects.toBe(guard);

      // Second attempt: the (now-cleared) guard passes and the undo succeeds.
      (resolver.undo as jest.Mock).mockImplementationOnce(() => ({ ok: true }));
      const result = await driver.undoLastSeatAction(campaignId, dm);
      expect(result).toMatchObject({ encounterId, chainId, actionName: 'Practice Strike' });

      const session = (driver as unknown as { ensureSession: (id: number) => import('../../src/modules/ai-driver/ai-driver.service').AiDmSessionState }).ensureSession(campaignId);
      expect(session.lastUndoableCommit).toBeNull();
      // Only the successful reversal is audited, exactly once, with the real human actor.
      expect(audit.log).toHaveBeenCalledTimes(1);
      const entry = audit.log.mock.calls[0][0] as { action: string; actorRole: string };
      expect(entry).toMatchObject({ action: 'ai-dm.driver.undo', actorRole: 'dm' });
      expect(stream.emit).toHaveBeenCalled();
    });
  });
});

describe('ai-driver undo lever — armed on a DM-APPROVED action (collaborative handoff, #1501)', () => {
  /**
   * Collaborative handoff (#1051) promotes resolve_action/apply_action from `auto` to `confirm`,
   * so on those tables EVERY mechanical commit reaches `resolveToolConfirmation` rather than
   * executeToolCalls. The lever must arm on that approval path too, or the DM "undo the AI's last
   * action" control never appears on the very tables it matters most for. The seat-toolset double
   * returns an apply_action result carrying an undoToken, exactly as the real resolver would.
   */
  type Ctor = ConstructorParameters<typeof AiDriverService>;
  const confirmationId = 'conf-1';
  const toolCallId = 'call-1';
  const encounterId = 42;

  function makeDriverForConfirmation(
    callImpl: () => Promise<{ text: string; isError: boolean }>,
  ): { driver: AiDriverService; mcpCall: jest.Mock; audit: { log: jest.Mock }; stream: { emit: jest.Mock } } {
    const audit = { log: jest.fn(async () => undefined) };
    const stream = { emit: jest.fn() };
    const mcpCall = jest.fn(callImpl);
    const mcpTools = { buildToolset: () => ({ call: mcpCall }) };
    const encounters = {
      listForCampaign: jest.fn(async () => []),
      appendActiveEncounterNote: jest.fn(async () => undefined),
    };
    const driver = new AiDriverService(
      { registerDriverSessionTeardown: jest.fn() } as unknown as Ctor[0],
      mcpTools as unknown as Ctor[1],
      audit as unknown as Ctor[2],
      stream as unknown as Ctor[3],
      {} as unknown as Ctor[4],
      {} as unknown as Ctor[5],
      {} as unknown as Ctor[6],
      {} as unknown as Ctor[7],
      {} as unknown as Ctor[8],
      encounters as unknown as Ctor[9],
      {} as unknown as Ctor[10],
      {} as unknown as Ctor[11],
      {} as unknown as Ctor[12],
      { correctionsForPrompt: async () => [] } as unknown as Ctor[13],
      undefined as unknown as Ctor[14], // db absent → in-memory session, persistence no-op
      undefined as unknown as Ctor[15],
      {} as unknown as Ctor[16], // actionResolver unused on the approval path
    );
    return { driver, mcpCall, audit, stream };
  }

  function queueApplyActionConfirmation(driver: AiDriverService): void {
    const session = (
      driver as unknown as { ensureSession: (id: number) => import('../../src/modules/ai-driver/ai-driver.service').AiDmSessionState }
    ).ensureSession(campaignId);
    session.pendingToolConfirmations = {
      [pendingConfirmationKey('apply_action', toolCallId)]: {
        id: confirmationId,
        tool: 'apply_action',
        toolCallId,
        args: { encounterId, chainId: 'chain-in' },
        profile: 'live',
        policy: 'confirm',
        requestedAt: '2026-07-31T00:00:00.000Z',
        actor: 'ai-dm-seat:1',
        triggeredBy: 'player-1',
        turnNumber: 1,
      },
    };
  }

  function sessionOf(driver: AiDriverService) {
    return (
      driver as unknown as { ensureSession: (id: number) => import('../../src/modules/ai-driver/ai-driver.service').AiDmSessionState }
    ).ensureSession(campaignId);
  }

  it('arms the lever from the result undoToken when a DM approves an apply_action', async () => {
    const { driver, mcpCall } = makeDriverForConfirmation(async () => ({
      text: JSON.stringify({
        undoToken: { chainId: 'chain-approved', actionName: 'Practice Strike', actorCombatantId: 7 },
      }),
      isError: false,
    }));
    queueApplyActionConfirmation(driver);

    const outcome = await driver.resolveToolConfirmation(campaignId, dm, confirmationId, 'approve');

    // The approved action actually ran under the seat principal.
    expect(mcpCall).toHaveBeenCalledWith('apply_action', expect.objectContaining({ encounterId, chainId: 'chain-in' }));
    expect(outcome.result?.isError).toBe(false);
    // The lever armed from the RESULT's undoToken — exactly what executeToolCalls does for an
    // autonomous apply_action — so the DM undo control appears on a collaborative table too.
    expect(sessionOf(driver).lastUndoableCommit).toMatchObject({
      encounterId,
      actorCombatantId: 7,
      chainId: 'chain-approved',
      actionName: 'Practice Strike',
    });
  });

  it('leaves the lever clear when a DM rejects the confirmation (tool never runs)', async () => {
    const { driver, mcpCall } = makeDriverForConfirmation(async () => ({
      text: JSON.stringify({ undoToken: { chainId: 'chain-approved' } }),
      isError: false,
    }));
    queueApplyActionConfirmation(driver);

    await driver.resolveToolConfirmation(campaignId, dm, confirmationId, 'reject');

    expect(mcpCall).not.toHaveBeenCalled();
    // A fresh in-memory session leaves the lever unset (undefined) until a commit arms it.
    expect(sessionOf(driver).lastUndoableCommit).toBeFalsy();
  });

  it('leaves the lever clear when the approved action errors (no usable undoToken)', async () => {
    const { driver } = makeDriverForConfirmation(async () => ({
      text: JSON.stringify({ error: 'encounter not found' }),
      isError: true,
    }));
    queueApplyActionConfirmation(driver);

    await driver.resolveToolConfirmation(campaignId, dm, confirmationId, 'approve');

    expect(sessionOf(driver).lastUndoableCommit).toBeFalsy();
  });
});
