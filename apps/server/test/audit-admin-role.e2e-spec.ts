import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #526 regression tests — admin audit attribution.
 *
 * Before the fix every server-scoped admin write path hardcoded
 * `actorRole: 'dm'`, so an incident reviewer could not tell a privileged
 * server-admin action (user/settings/rule-pack/ai-provider writes) from an
 * ordinary campaign-DM's. After the fix the actor's TRUE role is recorded:
 * `'admin'` for a server admin exercising real server-admin power, `'dm'` for
 * an ordinary campaign-scoped action.
 *
 * The admin test MUST fail without the fix (when the callsites still hardcode
 * `'dm'`) — see "Confirmation regression test fails without fix" in the report.
 */
describe('Issue #526: server-admin actions record actorRole "admin" (e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let dmAgent: ReturnType<typeof request.agent>;
  let dmCampaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();

    // First user via setup -> the server admin.
    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'audit-admin', password: 'admin-password-1' });

    // An ordinary user (serverRole 'user') who DMs their own campaign.
    await adminAgent.post('/api/v1/users').send({ username: 'audit-dm', password: 'dm-password-1', serverRole: 'user' });
    dmAgent = request.agent(server);
    await dmAgent.post('/api/v1/auth/login').send({ username: 'audit-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'DM table' });
    expect(campRes.status).toBe(201);
    dmCampaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /**
   * Helper: the most recent server-scoped audit row (campaignId null). The
   * admin audit endpoint returns newest-first.
   */
  async function latestServerAuditRow(): Promise<{ actorRole: string; action: string; actor: string }> {
    const res = await adminAgent.get('/api/v1/admin/audit?limit=20');
    expect(res.status).toBe(200);
    return res.body[0];
  }

  it('a server-admin user-create records actorRole "admin" (not "dm")', async () => {
    const res = await adminAgent.post('/api/v1/users').send({ username: 'created-by-admin', password: 'pw-12345678', serverRole: 'user' });
    expect(res.status).toBe(201);

    const row = await latestServerAuditRow();
    expect(row.action).toBe('user.create');
    expect(row.actorRole).toBe('admin');
  });

  it('a server-admin settings update records actorRole "admin"', async () => {
    // allowLocalLogin is a safe, deterministic toggle to flip.
    const res = await adminAgent.patch('/api/v1/settings').send({ allowLocalLogin: true });
    expect(res.status).toBe(200);

    const row = await latestServerAuditRow();
    expect(row.action).toBe('settings.update');
    expect(row.actorRole).toBe('admin');
  });

  it('a server-admin password reset records actorRole "admin"', async () => {
    // Reset the user created above.
    const usersRes = await adminAgent.get('/api/v1/users');
    const target = usersRes.body.find((u: { username: string }) => u.username === 'created-by-admin');
    expect(target).toBeDefined();

    const res = await adminAgent.post(`/api/v1/users/${target.id}/password`).send({ newPassword: 'new-pw-12345678' });
    expect(res.status).toBe(204);

    const row = await latestServerAuditRow();
    expect(row.action).toBe('user.password_reset');
    expect(row.actorRole).toBe('admin');
  });

  it('an ordinary campaign-DM action still records actorRole "dm" (unchanged semantics)', async () => {
    // A non-admin DM creating a quest in their own campaign — this is a
    // campaign-scoped action, NOT a server-admin one, so it must stay 'dm'.
    const res = await dmAgent.post(`/api/v1/campaigns/${dmCampaignId}/quests`).send({ title: 'DM quest' });
    expect(res.status).toBe(201);

    // The campaign audit endpoint is DM-scoped; newest-first.
    const auditRes = await dmAgent.get(`/api/v1/campaigns/${dmCampaignId}/audit?limit=10`);
    expect(auditRes.status).toBe(200);
    const row = auditRes.body.find((r: { action: string }) => r.action === 'quest.create');
    expect(row).toBeDefined();
    expect(row.actorRole).toBe('dm');
  });
});
