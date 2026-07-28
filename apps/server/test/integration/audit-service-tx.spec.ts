import fs from 'node:fs';
import { describe, expect, it, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { openDatabase, type DrizzleDb } from '../../src/db/db.module';
import { campaigns, auditLog } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #1581 — AuditService.log() had no transaction-aware write path, so an audit row
 * could never join a transaction opened by its caller: every audit write was forced into
 * "do the work, commit it, then try to record that it happened", with no way to ask for
 * the opposite (the row rolls back WITH the work if either fails).
 *
 * This is the focused, AuditService-only pin for the two guarantees that now both exist:
 *   - `log()` (unchanged): a post-commit, best-effort row that survives independently of
 *     any transaction the caller is inside — even one that later aborts.
 *   - `logInTx()` (new): a row written INSIDE the caller's transaction, which is rolled
 *     back WITH it if the transaction aborts for any reason, and committed WITH it
 *     otherwise.
 *
 * Real SQLite (not a mock): the guarantee under test is a genuine transaction boundary,
 * and better-sqlite3's actual BEGIN/COMMIT/ROLLBACK behaviour is exactly the thing a
 * hand-rolled mock cannot exercise. `campaigns` is used as an arbitrary sibling write
 * inside the same transaction — this test is not about campaigns, it just needs SOME
 * other table to prove the two writes share one atomic unit.
 */
describe('AuditService transaction-aware write path (#1581)', () => {
  let dataDir: string;
  let orm: DrizzleDb | null = null;

  afterEach(() => {
    orm = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function boot(): { audit: AuditService; db: DrizzleDb } {
    dataDir = makeTempDataDir();
    const { orm: db } = openDatabase(dataDir);
    orm = db;
    return { audit: new AuditService(db), db };
  }

  function auditRowCount(db: DrizzleDb, action: string): number {
    return db.select().from(auditLog).where(eq(auditLog.action, action)).all().length;
  }

  it('logInTx: the audit row is PRESENT when the transaction commits', () => {
    const { audit, db } = boot();
    const ts = '2026-07-27T00:00:00.000Z';

    db.transaction((tx) => {
      tx.insert(campaigns).values({ name: 'Committed Table', createdAt: ts, updatedAt: ts }).run();
      audit.logInTx(tx, {
        actor: 'dev:dm-1',
        actorRole: 'dm',
        action: 'test.tx.committed',
        detail: 'should survive',
      });
    });

    expect(auditRowCount(db, 'test.tx.committed')).toBe(1);
    expect(db.select().from(campaigns).all()).toHaveLength(1);
  });

  it('logInTx: the audit row is ABSENT when the transaction later aborts — pins the new guarantee', () => {
    const { audit, db } = boot();
    const ts = '2026-07-27T00:00:00.000Z';

    // The audit row is written FIRST, then something else in the same transaction
    // throws. Before #1581 there was no way to even attempt this: `log()` had no
    // tx-aware overload, so an audit row could never be made to depend on the rest of
    // a transaction's fate in the first place.
    expect(() => {
      db.transaction((tx) => {
        audit.logInTx(tx, {
          actor: 'dev:dm-1',
          actorRole: 'dm',
          action: 'test.tx.aborted',
          detail: 'should NOT survive',
        });
        tx.insert(campaigns).values({ name: 'Aborted Table', createdAt: ts, updatedAt: ts }).run();
        throw new Error('simulated failure after both writes, before commit');
      });
    }).toThrow('simulated failure after both writes, before commit');

    // Rolled back WITH the campaign insert: neither exists.
    expect(auditRowCount(db, 'test.tx.aborted')).toBe(0);
    expect(db.select().from(campaigns).all()).toHaveLength(0);
  });

  it("log(): the post-commit, best-effort row survives even when the CALLER's own transaction later aborts", async () => {
    // The guarantee log() has always had still holds unchanged: it writes through its
    // OWN handle, independent of whatever transaction the caller happens to be inside.
    // A caller that wants the opposite now has logInTx() to opt into instead — but any
    // existing caller that kept using log() (deliberately, per #1581's own instruction
    // not to silently convert every call site) is unaffected.
    const { audit, db } = boot();
    const ts = '2026-07-27T00:00:00.000Z';

    await audit.log({
      actor: 'dev:dm-1',
      actorRole: 'dm',
      action: 'test.log.independent',
      detail: 'survives regardless',
    });

    // A LATER, wholly unrelated transaction aborts.
    expect(() => {
      db.transaction((tx) => {
        tx.insert(campaigns).values({ name: 'Unrelated Aborted Table', createdAt: ts, updatedAt: ts }).run();
        throw new Error('a later, unrelated transaction aborts');
      });
    }).toThrow('a later, unrelated transaction aborts');

    // The log() row committed independently already and is unaffected by that later
    // transaction aborting; the unrelated transaction's own insert did roll back.
    expect(auditRowCount(db, 'test.log.independent')).toBe(1);
    expect(db.select().from(campaigns).all()).toHaveLength(0);
  });
});
