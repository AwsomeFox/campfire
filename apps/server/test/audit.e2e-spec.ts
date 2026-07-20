import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { DB, type DrizzleDb } from '../src/db/db.module';
import { auditLog } from '../src/db/schema';
import { AuditService } from '../src/modules/audit/audit.service';

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'dm-1' };

/**
 * Covers #23 (server-wide admin audit) + #74 (audit-log growth: HP-tick
 * coarsening, retention prune, composite index).
 */
describe('audit log (e2e)', () => {
  let ctx: TestAppContext;
  let campaignId: number;
  let encounterId: number;
  let combatantId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer();

    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Audit Campaign' });
    campaignId = campRes.body.id;

    const encRes = await request(server).post(`/api/v1/campaigns/${campaignId}/encounters`).set(dm).send({ name: 'Brawl' });
    expect(encRes.status).toBe(201);
    encounterId = encRes.body.id;

    const combRes = await request(server)
      .post(`/api/v1/encounters/${encounterId}/combatants`)
      .set(dm)
      .send({ kind: 'monster', name: 'Ogre', hpMax: 30 });
    expect(combRes.status).toBe(201);
    combatantId = combRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  // -------- #74: HP-tick coarsening --------

  describe('#74 — HP ticks are not audited', () => {
    async function campaignAudit() {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
      expect(res.status).toBe(200);
      return res.body as Array<{ action: string; detail: string }>;
    }

    it('a pure HP delta does NOT write an audit row', async () => {
      const before = await campaignAudit();
      const beforeUpdates = before.filter((e) => e.action === 'encounter.combatant.update').length;

      // Simulate a combat-heavy sequence of ±HP ticks.
      for (let i = 0; i < 10; i++) {
        const res = await request(ctx.app.getHttpServer())
          .patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`)
          .set(dm)
          .send({ hpDelta: -1 });
        expect(res.status).toBe(200);
      }

      const after = await campaignAudit();
      const afterUpdates = after.filter((e) => e.action === 'encounter.combatant.update').length;
      expect(afterUpdates).toBe(beforeUpdates); // zero new rows from 10 HP ticks
    });

    it('an hpSet-only change also does NOT write an audit row', async () => {
      const before = (await campaignAudit()).filter((e) => e.action === 'encounter.combatant.update').length;
      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`)
        .set(dm)
        .send({ hpSet: 12 });
      expect(res.status).toBe(200);
      const after = (await campaignAudit()).filter((e) => e.action === 'encounter.combatant.update').length;
      expect(after).toBe(before);
    });

    it('a condition change IS still audited (even alongside an HP change)', async () => {
      const before = (await campaignAudit()).filter((e) => e.action === 'encounter.combatant.update').length;
      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`)
        .set(dm)
        .send({ hpDelta: -2, addConditions: ['poisoned'] });
      expect(res.status).toBe(200);
      const after = (await campaignAudit()).filter((e) => e.action === 'encounter.combatant.update').length;
      expect(after).toBe(before + 1);
    });

    it('an initiative change IS still audited', async () => {
      const before = (await campaignAudit()).filter((e) => e.action === 'encounter.combatant.update').length;
      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/encounters/${encounterId}/combatants/${combatantId}`)
        .set(dm)
        .send({ initiative: 15 });
      expect(res.status).toBe(200);
      const after = (await campaignAudit()).filter((e) => e.action === 'encounter.combatant.update').length;
      expect(after).toBe(before + 1);
    });
  });

  // -------- #74: composite index --------

  it('#74 — the composite (campaign_id, id DESC) index exists on audit_log', async () => {
    const db = ctx.app.get<DrizzleDb>(DB);
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toContain('idx_audit_campaign_id_desc');
    expect(names).toContain('idx_audit_created_at');
  });

  // -------- #74: retention prune --------

  it('#74 — pruneExpired deletes rows older than the retention window, keeps recent ones', async () => {
    const db = ctx.app.get<DrizzleDb>(DB);
    const audit = ctx.app.get(AuditService);

    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    await db.insert(auditLog).values({
      campaignId,
      actor: 'dev:dm-1',
      actorRole: 'dm',
      action: 'test.stale',
      detail: 'ancient',
      createdAt: old,
    });
    await db.insert(auditLog).values({
      campaignId,
      actor: 'dev:dm-1',
      actorRole: 'dm',
      action: 'test.fresh',
      detail: 'new',
      createdAt: recent,
    });

    const removed = await audit.pruneExpired(365);
    expect(removed).toBeGreaterThanOrEqual(1);

    const remaining = db.all<{ action: string }>(sql`SELECT action FROM audit_log`);
    const actions = remaining.map((r) => r.action);
    expect(actions).not.toContain('test.stale');
    expect(actions).toContain('test.fresh');
  });

  it('#74 — pruneExpired with retention <= 0 is a no-op (retention disabled)', async () => {
    const audit = ctx.app.get(AuditService);
    expect(await audit.pruneExpired(0)).toBe(0);
    expect(await audit.pruneExpired(-5)).toBe(0);
  });

  // -------- #23: server-wide admin trail --------

  describe('#23 — server-admin actions are logged with campaignId null', () => {
    it('creating a user writes a user.create row visible in GET /admin/audit', async () => {
      const server = ctx.app.getHttpServer();
      const res = await request(server)
        .post('/api/v1/users')
        .set(dm)
        .send({ username: 'audit-target', password: 'password-1234', serverRole: 'user' });
      expect(res.status).toBe(201);

      const listRes = await request(server).get('/api/v1/admin/audit').set(dm);
      expect(listRes.status).toBe(200);
      const entry = (listRes.body as Array<{ action: string; campaignId: number | null; entityId: number; detail: string }>).find(
        (e) => e.action === 'user.create' && e.entityId === res.body.id,
      );
      expect(entry).toBeDefined();
      expect(entry!.campaignId).toBeNull();
      expect(entry!.detail).toContain('audit-target');
    });

    it('disabling a user writes a user.update row', async () => {
      const server = ctx.app.getHttpServer();
      const createRes = await request(server)
        .post('/api/v1/users')
        .set(dm)
        .send({ username: 'to-disable', password: 'password-1234', serverRole: 'user' });
      const userId = createRes.body.id;

      const patchRes = await request(server).patch(`/api/v1/users/${userId}`).set(dm).send({ disabled: true });
      expect(patchRes.status).toBe(200);

      const listRes = await request(server).get('/api/v1/admin/audit').set(dm);
      const entry = (listRes.body as Array<{ action: string; entityId: number; detail: string }>).find(
        (e) => e.action === 'user.update' && e.entityId === userId,
      );
      expect(entry).toBeDefined();
      expect(entry!.detail).toContain('disabled');
    });

    it('deleting a user writes a user.delete row', async () => {
      const server = ctx.app.getHttpServer();
      const createRes = await request(server)
        .post('/api/v1/users')
        .set(dm)
        .send({ username: 'to-delete', password: 'password-1234', serverRole: 'user' });
      const userId = createRes.body.id;

      const delRes = await request(server).delete(`/api/v1/users/${userId}`).set(dm);
      expect(delRes.status).toBe(204);

      const listRes = await request(server).get('/api/v1/admin/audit').set(dm);
      const entry = (listRes.body as Array<{ action: string; entityId: number; detail: string }>).find(
        (e) => e.action === 'user.delete' && e.entityId === userId,
      );
      expect(entry).toBeDefined();
      expect(entry!.detail).toContain('to-delete');
    });

    it('updating server settings writes a settings.update row', async () => {
      const server = ctx.app.getHttpServer();
      const patchRes = await request(server).patch('/api/v1/settings').set(dm).send({ allowSignup: true });
      expect(patchRes.status).toBe(200);

      const listRes = await request(server).get('/api/v1/admin/audit').set(dm);
      const entry = (listRes.body as Array<{ action: string; detail: string }>).find((e) => e.action === 'settings.update');
      expect(entry).toBeDefined();
      expect(entry!.detail).toContain('allowSignup');
    });

    it('GET /admin/audit only returns campaign-null rows (per-campaign noise excluded)', async () => {
      const server = ctx.app.getHttpServer();
      const listRes = await request(server).get('/api/v1/admin/audit').set(dm);
      expect(listRes.status).toBe(200);
      for (const e of listRes.body as Array<{ campaignId: number | null }>) {
        expect(e.campaignId).toBeNull();
      }
    });
  });
});

/**
 * #23 — GET /admin/audit is server-admin gated. DEV_AUTH makes every header user
 * an admin, so the 403 path needs real cookie sessions (a non-admin user).
 */
describe('audit log — server-admin gating (e2e, real cookie sessions)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'audit-admin', password: 'admin-password-1' });

    await adminAgent.post('/api/v1/users').send({ username: 'audit-user', password: 'user-password-1', serverRole: 'user' });
    userAgent = request.agent(server);
    await userAgent.post('/api/v1/auth/login').send({ username: 'audit-user', password: 'user-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a server admin can read GET /admin/audit', async () => {
    const res = await adminAgent.get('/api/v1/admin/audit');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // The setup + user-create above should have produced at least a user.create row.
    expect((res.body as Array<{ action: string }>).some((e) => e.action === 'user.create')).toBe(true);
  });

  it('a non-admin user is forbidden (403)', async () => {
    const res = await userAgent.get('/api/v1/admin/audit');
    expect(res.status).toBe(403);
  });
});
