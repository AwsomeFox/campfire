import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #22 — Admin observability dashboard.
 *
 * GET /admin/metrics is server-admin only (@ServerRoles('admin')) and returns a
 * cheap operational snapshot: entity counts, on-disk DB size, uptime, version,
 * and a recent-activity strip. These tests pin the gating (admin vs non-admin
 * vs a scope-capped PAT) and the metric shape, including that counts reflect
 * real data created through the API.
 */
describe('Issue #22: admin observability metrics (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    // First user via setup -> the server admin.
    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'obs-admin', password: 'admin-password-1' });

    // An ordinary (non-admin) user.
    await adminAgent.post('/api/v1/users').send({ username: 'obs-user', password: 'user-password-1', serverRole: 'user' });
    userAgent = request.agent(server);
    await userAgent.post('/api/v1/auth/login').send({ username: 'obs-user', password: 'user-password-1' });

    // Give the counts something to report: the admin owns a campaign with an NPC.
    const campRes = await adminAgent.post('/api/v1/campaigns').send({ name: 'Observability Test Table' });
    expect(campRes.status).toBe(201);
    await adminAgent.post(`/api/v1/campaigns/${campRes.body.id}/npcs`).send({ name: 'Metric Merchant' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  describe('gating', () => {
    it('unauthenticated -> 401', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/admin/metrics');
      expect(res.status).toBe(401);
    });

    it('non-admin user -> 403', async () => {
      const res = await userAgent.get('/api/v1/admin/metrics');
      expect(res.status).toBe(403);
    });

    it('server admin -> 200', async () => {
      const res = await adminAgent.get('/api/v1/admin/metrics');
      expect(res.status).toBe(200);
    });

    it('a scope-capped (non-adminEnabled) PAT -> 403; an adminEnabled PAT -> 200', async () => {
      const server = ctx.app.getHttpServer();

      const cappedMint = await adminAgent.post('/api/v1/tokens').send({ name: 'capped', scope: 'dm' });
      expect(cappedMint.status).toBe(201);
      expect(cappedMint.body.apiToken.adminEnabled).toBe(false);
      const cappedRes = await request(server)
        .get('/api/v1/admin/metrics')
        .set('Authorization', `Bearer ${cappedMint.body.token}`);
      expect(cappedRes.status).toBe(403);

      const adminMint = await adminAgent.post('/api/v1/tokens').send({ name: 'admin-enabled', scope: 'dm', adminEnabled: true });
      expect(adminMint.status).toBe(201);
      expect(adminMint.body.apiToken.adminEnabled).toBe(true);
      const adminRes = await request(server)
        .get('/api/v1/admin/metrics')
        .set('Authorization', `Bearer ${adminMint.body.token}`);
      expect(adminRes.status).toBe(200);
    });
  });

  describe('shape', () => {
    it('returns version, uptime, timestamps, counts, database size, and recent activity', async () => {
      const res = await adminAgent.get('/api/v1/admin/metrics');
      expect(res.status).toBe(200);
      const body = res.body;

      expect(typeof body.version).toBe('string');
      expect(body.version.length).toBeGreaterThan(0);
      expect(typeof body.now).toBe('string');
      expect(typeof body.startedAt).toBe('string');
      expect(typeof body.uptimeSeconds).toBe('number');
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(typeof body.activeSessions).toBe('number');

      // Counts — every expected key present and non-negative.
      for (const key of [
        'users', 'campaigns', 'characters', 'npcs', 'locations', 'quests',
        'sessions', 'notes', 'encounters', 'attachments', 'apiTokens', 'rulePacks', 'ruleEntries',
      ]) {
        expect(typeof body.counts[key]).toBe('number');
        expect(body.counts[key]).toBeGreaterThanOrEqual(0);
      }

      // Counts reflect real data created in setup.
      expect(body.counts.users).toBeGreaterThanOrEqual(2); // admin + user
      expect(body.counts.campaigns).toBeGreaterThanOrEqual(1);
      expect(body.counts.npcs).toBeGreaterThanOrEqual(1);

      // DB size derived from PRAGMA page_count/page_size — all positive on a live DB.
      expect(body.database.pageCount).toBeGreaterThan(0);
      expect(body.database.pageSize).toBeGreaterThan(0);
      expect(body.database.sizeBytes).toBe(body.database.pageCount * body.database.pageSize);

      // Recent activity is a (possibly empty) newest-first array of audit-shaped rows.
      expect(Array.isArray(body.recentActivity)).toBe(true);
      for (const entry of body.recentActivity) {
        expect(typeof entry.id).toBe('number');
        expect(typeof entry.action).toBe('string');
        expect(typeof entry.actor).toBe('string');
        expect(typeof entry.createdAt).toBe('string');
      }
    });
  });
});
