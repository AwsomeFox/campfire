import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  AiDriverService,
  recordDriverUndoableCommit,
} from '../../src/modules/ai-driver/ai-driver.service';
import { ActionResolverService } from '../../src/modules/encounters/action-resolver.service';
import type { RequestUser } from '../../src/common/user.types';

/**
 * DM undo of the AI seat's last committed action — the catch-block classification (#1501 review).
 *
 * `undoLastSeatAction` drives `ActionResolverService.undo`, which can fail for two qualitatively
 * different reasons, and the lever (`session.lastUndoableCommit`, which is the ONLY thing that
 * keeps the DM's undo button on screen) must react differently to each:
 *
 *  - STALE — the chain was already undone (the model called undo_action itself, a prior DM undo
 *    raced this one and won the conditional claim), no longer exists, or belongs to another
 *    encounter. The lever is dead: clear it and answer 404 "nothing left to undo".
 *  - RETRYABLE — a busy database, an `assertTargetAllowed` target guard, or a missing encounter
 *    row from the resolver's transaction-local read. The chain is STILL undoable, so the lever
 *    must STAY ARMED (the DM can try again) and the concrete error must be rethrown.
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

    it('keeps the lever armed for a non-BadRequest error (e.g. a busy database / missing encounter)', async () => {
      const { driver } = makeDriver(resolver);
      const { chainId } = arm(driver);
      // A NotFoundException from the resolver transaction-local encounter read, or any other
      // non-stale throwable, is retryable: the chain may still be undoable on the next attempt.
      const retryable = new NotFoundException('Encounter 42 not found.');
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
