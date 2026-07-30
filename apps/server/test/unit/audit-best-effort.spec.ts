import { describe, expect, it, jest } from '@jest/globals';
import { auditBestEffort } from '../../src/modules/audit/audit-best-effort';
import type { AuditService } from '../../src/modules/audit/audit.service';

/**
 * Issue #1581 — the "swallow, log, annotate" best-effort audit pattern, consolidated
 * from three independent hand-rolled copies in admin-catalog.service.ts onto this one
 * helper. Pins the behaviour every caller needs: never rethrow (a committed operation
 * must not be relabelled a failure), always log loudly at error level with the stack,
 * and hand back a short note the caller MAY attach to an operator-facing result.
 */
// Issue #1527: `auditBestEffort` itself takes `Pick<AuditService, 'log'>`, not the
// concrete class (see audit-best-effort.ts) — a plain structural type, not a class with
// a private-field brand, so no unsafe cast is needed here at all. This is stronger than
// typing only the double: if `auditBestEffort` starts calling a second `AuditService`
// method, that call fails to compile in audit-best-effort.ts itself, forcing the Pick
// list to widen — and once widened, this double (and every other caller) fails to
// compile until it supplies the new method too. A double typed against a `Pick` on the
// double's OWN declaration, with the concrete class cast still applied at the call
// site, only catches renames/typos on the methods already listed — not a new method the
// consumer starts requiring (see export-controller-streaming.spec.ts for that case,
// where the consumer's constructor parameter type is narrowed instead).
type AuditServiceDouble = Pick<AuditService, 'log'>;

function fakeAudit(log: AuditServiceDouble['log']): AuditServiceDouble {
  return { log };
}

describe('auditBestEffort (#1581)', () => {
  function fakeLogger() {
    return { error: jest.fn() } as unknown as import('@nestjs/common').Logger;
  }

  it('returns null and never logs when the audit write succeeds', async () => {
    const audit = fakeAudit(jest.fn(async () => undefined));
    const logger = fakeLogger();

    const note = await auditBestEffort(
      audit,
      logger,
      { actor: 'dev:dm-1', actorRole: 'dm', action: 'test.ok', detail: '' },
      () => 'should never be called',
    );

    expect(note).toBeNull();
    expect((logger.error as jest.Mock).mock.calls.length).toBe(0);
  });

  it('never rethrows: a failing audit write does not propagate to the caller', async () => {
    const audit = fakeAudit(jest.fn(async () => { throw new Error('audit table is unavailable'); }));
    const logger = fakeLogger();

    await expect(
      auditBestEffort(audit, logger, { actor: 'dev:dm-1', actorRole: 'dm', action: 'test.fail', detail: '' }, () => 'context message'),
    ).resolves.not.toThrow();
  });

  it('logs at error level with the caller-supplied message and the error stack', async () => {
    const boom = new Error('audit table is unavailable');
    const audit = fakeAudit(jest.fn(async () => { throw boom; }));
    const logger = fakeLogger();

    await auditBestEffort(
      audit,
      logger,
      { actor: 'dev:dm-1', actorRole: 'dm', action: 'test.fail', detail: '' },
      (err) => `operation X applied but its audit row failed to write (${err instanceof Error ? err.message : err})`,
    );

    expect(logger.error).toHaveBeenCalledWith(
      'operation X applied but its audit row failed to write (audit table is unavailable)',
      boom.stack,
    );
  });

  it('returns a non-null note on failure, for callers that attach it to a result', async () => {
    const audit = fakeAudit(jest.fn(async () => { throw new Error('nope'); }));
    const logger = fakeLogger();

    const note = await auditBestEffort(audit, logger, { actor: 'a', actorRole: 'dm', action: 'x', detail: '' }, () => 'msg');
    expect(note).not.toBeNull();
    expect(typeof note).toBe('string');
  });

  it('attempts each of several independent writes rather than short-circuiting on the first failure', async () => {
    // Mirrors decideExportRequest's two mirrors (#1546/#1581): one failing must not
    // suppress the other, since a partial trail beats no trail.
    const audit = fakeAudit(
      jest
        .fn<AuditServiceDouble['log']>()
        .mockImplementationOnce(async () => {
          throw new Error('first mirror down');
        })
        .mockImplementationOnce(async () => undefined),
    );
    const logger = fakeLogger();

    const notes = await Promise.all([
      auditBestEffort(audit, logger, { actor: 'a', actorRole: 'dm', action: 'mirror.one', detail: '' }, () => 'mirror one failed'),
      auditBestEffort(audit, logger, { actor: 'a', actorRole: 'dm', action: 'mirror.two', detail: '' }, () => 'mirror two failed'),
    ]);

    expect(notes[0]).not.toBeNull();
    expect(notes[1]).toBeNull();
    expect((audit.log as jest.Mock).mock.calls.length).toBe(2);
  });
});
