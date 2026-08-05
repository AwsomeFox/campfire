import request from 'supertest';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #851 — shared-instance governance, exercised through the real HTTP routes
 * (not just the service layer — see test/unit/campaign-governance.spec.ts for the
 * exhaustive policy/limit unit coverage). This proves: route registration order
 * ('allowance'/'creation-requests' resolve before the generic ':id' campaign
 * routes), @ServerRoles('admin') gates the admin-only endpoints, and the full
 * request -> approve -> create round trip works end to end.
 */
describe('shared-instance governance (issue #851, e2e)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    adminAgent = request.agent(ctx.app.getHttpServer());
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'admin', password: 'admin-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function createUser(username: string): Promise<ReturnType<typeof request.agent>> {
    await adminAgent.post('/api/v1/users').send({ username, password: `${username}-password-1`, serverRole: 'user' });
    const agent = request.agent(ctx.app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ username, password: `${username}-password-1` });
    expect(login.status).toBe(201);
    return agent;
  }

  afterEach(async () => {
    // Reset governance settings between tests so they don't leak into each other.
    await adminAgent.patch('/api/v1/settings').send({
      campaignCreationPolicy: 'everyone',
      maxActiveCampaignsPerUser: null,
      maxTotalCampaignsPerUser: null,
      maxActiveCampaignsServerWide: null,
      maxTotalCampaignsServerWide: null,
      defaultCampaignStorageQuotaBytes: null,
    });
  });

  it('GET /campaigns/allowance resolves before the generic :id route (route-ordering)', async () => {
    const user = await createUser('routecheck1');
    const res = await user.get('/api/v1/campaigns/allowance');
    expect(res.status).toBe(200);
    expect(res.body.policy).toBe('everyone');
    expect(res.body.canCreate).toBe(true);
  });

  it('applies the operator default storage quota atomically to a newly created campaign', async () => {
    await adminAgent.patch('/api/v1/settings').send({ defaultCampaignStorageQuotaBytes: 5_000_000 });
    const user = await createUser('quotauser1');
    const created = await user.post('/api/v1/campaigns').send({ name: 'Quota Campaign' });
    expect(created.status).toBe(201);
    expect(created.body.storageQuotaBytes).toBe(5_000_000);
  });

  it("admins_only policy: 403 for an ordinary user's POST /campaigns, 201 for a real admin", async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'admins_only' });
    const user = await createUser('blockeduser1');

    const blocked = await user.post('/api/v1/campaigns').send({ name: 'Should be blocked' });
    expect(blocked.status).toBe(403);

    const allowed = await adminAgent.post('/api/v1/campaigns').send({ name: 'Admin campaign' });
    expect(allowed.status).toBe(201);
  });

  it('GET/POST creation-requests admin routes 403 for a non-admin', async () => {
    const user = await createUser('nonadmin1');
    const list = await user.get('/api/v1/campaigns/creation-requests');
    expect(list.status).toBe(403);

    const approve = await user.post('/api/v1/campaigns/creation-requests/1/approve');
    expect(approve.status).toBe(403);
  });

  it('the full request -> approve round trip: approved_organizers policy blocks, then a request + approval unblocks', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'approved_organizers' });
    const user = await createUser('organizer1');

    const blocked = await user.post('/api/v1/campaigns').send({ name: 'Not yet' });
    expect(blocked.status).toBe(403);

    const filed = await user.post('/api/v1/campaigns/creation-requests').send({ note: 'please let me DM' });
    expect(filed.status).toBe(201);
    expect(filed.body.status).toBe('pending');

    // A second request while one is pending is rejected.
    const duplicate = await user.post('/api/v1/campaigns/creation-requests');
    expect(duplicate.status).toBe(409);

    const allowance = await user.get('/api/v1/campaigns/allowance');
    expect(allowance.body.hasPendingRequest).toBe(true);

    const pending = await adminAgent.get('/api/v1/campaigns/creation-requests');
    expect(pending.status).toBe(200);
    const row = pending.body.find((r: { id: number }) => r.id === filed.body.id);
    expect(row).toBeDefined();
    expect(row.username).toBe('organizer1');

    const approved = await adminAgent.post(`/api/v1/campaigns/creation-requests/${filed.body.id}/approve`);
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('approved');

    const nowAllowed = await user.post('/api/v1/campaigns').send({ name: 'Now allowed' });
    expect(nowAllowed.status).toBe(201);
  });

  it('a denied request leaves the user blocked', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'approved_organizers' });
    const user = await createUser('deniedorganizer1');

    const filed = await user.post('/api/v1/campaigns/creation-requests');
    expect(filed.status).toBe(201);

    const denied = await adminAgent.post(`/api/v1/campaigns/creation-requests/${filed.body.id}/deny`);
    expect(denied.status).toBe(201);
    expect(denied.body.status).toBe('denied');

    const stillBlocked = await user.post('/api/v1/campaigns').send({ name: 'Still blocked' });
    expect(stillBlocked.status).toBe(403);
  });

  it('per-user active campaign limit: the (limit+1)th POST /campaigns is rejected over real HTTP', async () => {
    await adminAgent.patch('/api/v1/settings').send({ maxActiveCampaignsPerUser: 1 });
    const user = await createUser('limithttp1');

    const first = await user.post('/api/v1/campaigns').send({ name: 'First' });
    expect(first.status).toBe(201);

    const second = await user.post('/api/v1/campaigns').send({ name: 'Second' });
    expect(second.status).toBe(403);

    const allowance = await user.get('/api/v1/campaigns/allowance');
    expect(allowance.body.canCreate).toBe(false);
    expect(allowance.body.reason).toBe('limit_active_per_user');
  });

  it('applies consistently to the JSON import path (POST /campaigns/import)', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'admins_only' });
    const user = await createUser('jsonimporter1');

    const blocked = await user.post('/api/v1/campaigns/import').send({ campaign: { name: 'Imported' } });
    expect(blocked.status).toBe(403);

    const allowed = await adminAgent.post('/api/v1/campaigns/import').send({ campaign: { name: 'Imported' } });
    expect(allowed.status).toBe(201);
  });

  it('applies consistently to the ZIP import path (POST /campaigns/import/archive)', async () => {
    await adminAgent.patch('/api/v1/settings').send({ campaignCreationPolicy: 'admins_only' });
    const user = await createUser('zipimporter1');

    // A minimal well-formed Campfire mdzip export (campaign.json only, no attachments)
    // is enough to reach the governance gate — malformed archives never get that far.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('campaign.json', JSON.stringify({ campaign: { name: 'Zip import' } }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const blocked = await user
      .post('/api/v1/campaigns/import/archive')
      .attach('file', buffer, { filename: 'export.zip', contentType: 'application/zip' });
    expect(blocked.status).toBe(403);

    const allowed = await adminAgent
      .post('/api/v1/campaigns/import/archive')
      .attach('file', buffer, { filename: 'export.zip', contentType: 'application/zip' });
    expect(allowed.status).toBe(201);
  });
});
