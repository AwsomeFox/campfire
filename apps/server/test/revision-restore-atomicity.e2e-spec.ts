import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { DB_HOLDER, type DbHolder } from '../src/db/db.module';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

/**
 * Issue #513 — revision restore must commit pre-restore snapshot, entity prose
 * update, new revision tip, and audit in one better-sqlite3 transaction. This
 * suite injects a RAISE(ABORT) at each write boundary and asserts content +
 * history + audit are unchanged, then verifies the existing expectedUpdatedAt
 * version guard returns 409 on concurrent edit.
 */
describe('revision restore atomicity (e2e) — #513', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let nextSessionNumber = 1;

  beforeAll(async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).post('/api/v1/campaigns').set(dm).send({ name: 'Restore Tx' });
    campaignId = res.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  function rawDb() {
    return ctx.app.get<DbHolder>(DB_HOLDER).raw;
  }

  async function seedSession(): Promise<{ sessionId: number; revisionId: number; updatedAt: string; revCount: number }> {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: nextSessionNumber++, recap: 'v1-original' });
    expect(created.status).toBe(201);
    const sessionId = created.body.id as number;

    const edited = await request(server).patch(`/api/v1/sessions/${sessionId}`).set(dm).send({ recap: 'v2-current' });
    expect(edited.status).toBe(200);

    const revs = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(dm);
    expect(revs.status).toBe(200);
    expect(revs.body).toHaveLength(1);
    expect(revs.body[0].snapshot.recap).toBe('v1-original');

    return {
      sessionId,
      revisionId: revs.body[0].id as number,
      updatedAt: edited.body.updatedAt as string,
      revCount: revs.body.length as number,
    };
  }

  async function snapshotState(sessionId: number) {
    const server = ctx.app.getHttpServer();
    const session = await request(server).get(`/api/v1/sessions/${sessionId}`).set(dm);
    const revs = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(dm);
    const auditRows = rawDb()
      .prepare(
        "SELECT count(*) AS n FROM audit_log WHERE entity_type = 'session' AND entity_id = ? AND action = 'session.revision.restore'",
      )
      .get(sessionId) as { n: number };
    const revRows = rawDb()
      .prepare('SELECT count(*) AS n FROM entity_revisions WHERE entity_type = ? AND entity_id = ?')
      .get('session', sessionId) as { n: number };
    return {
      recap: session.body.recap as string,
      updatedAt: session.body.updatedAt as string,
      listedRevisions: revs.body as Array<{ id: number; snapshot: { recap?: string } }>,
      restoreAuditCount: auditRows.n,
      revisionRowCount: revRows.n,
    };
  }

  it.each([
    {
      name: 'closing the live tip (entity_revisions UPDATE)',
      sql: `
        CREATE TEMP TRIGGER fail_restore_tip_close
        BEFORE UPDATE OF replaced_at ON entity_revisions
        WHEN NEW.replaced_at IS NOT NULL AND OLD.replaced_at IS NULL
          AND OLD.entity_type = 'session' AND OLD.entity_id = $SESSION_ID
        BEGIN
          SELECT RAISE(ABORT, 'injected restore tip-close failure');
        END;
      `,
      drop: 'DROP TRIGGER fail_restore_tip_close',
    },
    {
      name: 'opening the restored tip (entity_revisions INSERT)',
      sql: `
        CREATE TEMP TRIGGER fail_restore_tip_insert
        BEFORE INSERT ON entity_revisions
        WHEN NEW.entity_type = 'session' AND NEW.entity_id = $SESSION_ID
          AND NEW.restored_from_revision_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'injected restore tip-insert failure');
        END;
      `,
      drop: 'DROP TRIGGER fail_restore_tip_insert',
    },
    {
      name: 'entity prose update (sessions UPDATE)',
      sql: `
        CREATE TEMP TRIGGER fail_restore_prose_update
        BEFORE UPDATE OF recap ON sessions
        WHEN NEW.id = $SESSION_ID
        BEGIN
          SELECT RAISE(ABORT, 'injected restore prose failure');
        END;
      `,
      drop: 'DROP TRIGGER fail_restore_prose_update',
    },
    {
      name: 'audit insert (audit_log INSERT)',
      sql: `
        CREATE TEMP TRIGGER fail_restore_audit
        BEFORE INSERT ON audit_log
        WHEN NEW.action = 'session.revision.restore' AND NEW.entity_id = $SESSION_ID
        BEGIN
          SELECT RAISE(ABORT, 'injected restore audit failure');
        END;
      `,
      drop: 'DROP TRIGGER fail_restore_audit',
    },
  ])('rolls back all restore writes when $name fails', async ({ sql, drop }) => {
    const { sessionId, revisionId } = await seedSession();
    const before = await snapshotState(sessionId);

    const sessionIdLiteral = Number(sessionId);
    expect(Number.isInteger(sessionIdLiteral)).toBe(true);
    rawDb().exec(sql.replaceAll('$SESSION_ID', String(sessionIdLiteral)));

    try {
      const failed = await request(ctx.app.getHttpServer())
        .post(`/api/v1/revisions/session/${sessionId}/${revisionId}/restore`)
        .set(dm);
      expect(failed.status).toBe(500);
    } finally {
      rawDb().exec(drop);
    }

    const after = await snapshotState(sessionId);
    expect(after.recap).toBe(before.recap);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.listedRevisions).toEqual(before.listedRevisions);
    expect(after.restoreAuditCount).toBe(before.restoreAuditCount);
    expect(after.revisionRowCount).toBe(before.revisionRowCount);

    // After the trigger is gone, the same restore must succeed — proves the failure
    // was the injected boundary, not a durable data problem.
    const ok = await request(ctx.app.getHttpServer())
      .post(`/api/v1/revisions/session/${sessionId}/${revisionId}/restore`)
      .set(dm);
    expect(ok.status).toBe(201);

    const restored = await snapshotState(sessionId);
    expect(restored.recap).toBe('v1-original');
    expect(restored.listedRevisions).toHaveLength(before.listedRevisions.length + 1);
    expect(restored.listedRevisions[0].snapshot.recap).toBe('v2-current');
    expect(restored.restoreAuditCount).toBe(before.restoreAuditCount + 1);
  });

  it('a stale expectedUpdatedAt on restore returns 409 and leaves content/history unchanged', async () => {
    const { sessionId, revisionId } = await seedSession();
    const before = await snapshotState(sessionId);

    const conflict = await request(ctx.app.getHttpServer())
      .post(`/api/v1/revisions/session/${sessionId}/${revisionId}/restore`)
      .query({ expectedUpdatedAt: '2000-01-01T00:00:00.000Z' })
      .set(dm);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('STALE_WRITE');

    const after = await snapshotState(sessionId);
    expect(after.recap).toBe(before.recap);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.listedRevisions).toEqual(before.listedRevisions);
    expect(after.restoreAuditCount).toBe(before.restoreAuditCount);
    expect(after.revisionRowCount).toBe(before.revisionRowCount);
  });

  it('concurrent edit then restore with the pre-edit updatedAt returns 409', async () => {
    const { sessionId, revisionId, updatedAt } = await seedSession();
    const before = await snapshotState(sessionId);

    // Another tab saves while the restore dialog still holds the older updatedAt.
    const raced = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/sessions/${sessionId}`)
      .set(dm)
      .send({ recap: 'v3-concurrent', expectedUpdatedAt: updatedAt });
    expect(raced.status).toBe(200);

    const mid = await snapshotState(sessionId);
    expect(mid.recap).toBe('v3-concurrent');

    const conflict = await request(ctx.app.getHttpServer())
      .post(`/api/v1/revisions/session/${sessionId}/${revisionId}/restore`)
      .query({ expectedUpdatedAt: updatedAt })
      .set(dm);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('STALE_WRITE');

    const after = await snapshotState(sessionId);
    expect(after.recap).toBe('v3-concurrent');
    expect(after.updatedAt).toBe(mid.updatedAt);
    expect(after.listedRevisions).toEqual(mid.listedRevisions);
    expect(after.restoreAuditCount).toBe(before.restoreAuditCount);
  });

  it('matching expectedUpdatedAt restore succeeds atomically', async () => {
    const { sessionId, revisionId, updatedAt } = await seedSession();
    const before = await snapshotState(sessionId);

    const ok = await request(ctx.app.getHttpServer())
      .post(`/api/v1/revisions/session/${sessionId}/${revisionId}/restore`)
      .query({ expectedUpdatedAt: updatedAt })
      .set(dm);
    expect(ok.status).toBe(201);
    expect(ok.body.updatedAt).toBeTruthy();

    const after = await snapshotState(sessionId);
    expect(after.recap).toBe('v1-original');
    expect(after.listedRevisions).toHaveLength(before.listedRevisions.length + 1);
    expect(after.listedRevisions[0].snapshot.recap).toBe('v2-current');
    expect(after.restoreAuditCount).toBe(before.restoreAuditCount + 1);
  });

  it('concurrent restores leave exactly one open tip and prose matching one outcome', async () => {
    const server = ctx.app.getHttpServer();
    const created = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/sessions`)
      .set(dm)
      .send({ number: nextSessionNumber++, recap: 'v1-original' });
    expect(created.status).toBe(201);
    const sessionId = created.body.id as number;

    expect((await request(server).patch(`/api/v1/sessions/${sessionId}`).set(dm).send({ recap: 'v2-mid' })).status).toBe(
      200,
    );
    const v3 = await request(server).patch(`/api/v1/sessions/${sessionId}`).set(dm).send({ recap: 'v3-current' });
    expect(v3.status).toBe(200);

    const revs = await request(server).get(`/api/v1/revisions/session/${sessionId}`).set(dm);
    expect(revs.status).toBe(200);
    expect(revs.body).toHaveLength(2);
    const byRecap = new Map(
      (revs.body as Array<{ id: number; snapshot: { recap?: string } }>).map((r) => [r.snapshot.recap, r.id]),
    );
    const restoreV1 = byRecap.get('v1-original');
    const restoreV2 = byRecap.get('v2-mid');
    expect(restoreV1).toBeDefined();
    expect(restoreV2).toBeDefined();

    // Fire both restores together — better-sqlite3 serializes the transactions; the
    // invariant under test is that tip close/open cannot leave two open tips.
    const [a, b] = await Promise.all([
      request(server).post(`/api/v1/revisions/session/${sessionId}/${restoreV1}/restore`).set(dm),
      request(server).post(`/api/v1/revisions/session/${sessionId}/${restoreV2}/restore`).set(dm),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);

    const openTips = rawDb()
      .prepare(
        `SELECT count(*) AS n FROM entity_revisions
         WHERE entity_type = 'session' AND entity_id = ? AND replaced_at IS NULL`,
      )
      .get(sessionId) as { n: number };
    expect(openTips.n).toBe(1);

    const session = await request(server).get(`/api/v1/sessions/${sessionId}`).set(dm);
    expect(session.status).toBe(200);
    expect(['v1-original', 'v2-mid']).toContain(session.body.recap);
  });
});
