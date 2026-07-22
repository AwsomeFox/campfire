import Database from 'better-sqlite3';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dbFilePath } from '../src/db/db.module';
import { closeTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';

interface TextContent { type: 'text'; text: string }

function parseTool(result: unknown): unknown {
  return JSON.parse((result as { content: TextContent[] }).content[0].text);
}

function toolStatus(result: unknown): number {
  const parsed = parseTool(result) as { error?: { status: number } };
  return parsed.error?.status ?? 200;
}

describe('membership integrity (#849, real SQLite, REST + MCP)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let admin: ReturnType<typeof request.agent>;
  let primaryDm: ReturnType<typeof request.agent>;
  let primaryDmId: number;
  let enabledTargetId: number;
  let disabledTargetId: number;
  let dmClient: Client;
  let adminClient: Client;
  const clients: Client[] = [];

  async function createUser(username: string): Promise<number> {
    const response = await admin
      .post('/api/v1/users')
      .send({ username, password: `${username}-password`, serverRole: 'user' });
    expect(response.status).toBe(201);
    return response.body.id as number;
  }

  async function login(username: string): Promise<ReturnType<typeof request.agent>> {
    const agent = request.agent(baseUrl);
    const response = await agent.post('/api/v1/auth/login').send({ username, password: `${username}-password` });
    expect(response.status).toBe(201);
    return agent;
  }

  function insertOrphanCampaign(name: string): number {
    const sqlite = new Database(dbFilePath(ctx.dataDir));
    try {
      const now = new Date().toISOString();
      return Number(
        sqlite
          .prepare('INSERT INTO campaigns (name, created_at, updated_at) VALUES (?, ?, ?)')
          .run(name, now, now).lastInsertRowid,
      );
    } finally {
      sqlite.close();
    }
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    baseUrl = await ctx.app.getUrl();

    admin = request.agent(baseUrl);
    const setup = await admin
      .post('/api/v1/auth/setup')
      .send({ username: 'integrity-admin', password: 'integrity-admin-password' });
    expect(setup.status).toBe(201);

    primaryDmId = await createUser('integrity-primary');
    enabledTargetId = await createUser('integrity-recovery');
    disabledTargetId = await createUser('integrity-disabled');
    primaryDm = await login('integrity-primary');

    // Both MCP principals need real PATs. The DM token exercises ordinary
    // membership paths; the admin-enabled token exercises the narrow recovery
    // tools without granting its owner implicit access to any campaign.
    const dmBootstrap = await primaryDm.post('/api/v1/campaigns').send({ name: 'Integrity MCP bootstrap' });
    expect(dmBootstrap.status).toBe(201);
    const dmToken = await primaryDm.post('/api/v1/tokens').send({ name: 'integrity-dm', scope: 'dm' });
    expect(dmToken.status).toBe(201);

    const adminCampaign = await admin.post('/api/v1/campaigns').send({ name: 'Integrity admin token bootstrap' });
    expect(adminCampaign.status).toBe(201);
    const adminToken = await admin
      .post('/api/v1/tokens')
      .send({ name: 'integrity-admin', scope: 'viewer', adminEnabled: true });
    expect(adminToken.status).toBe(201);

    dmClient = new Client({ name: 'membership-integrity-dm', version: '0.0.1' });
    await dmClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${dmToken.body.token}` } },
      }),
    );
    clients.push(dmClient);

    adminClient = new Client({ name: 'membership-integrity-admin', version: '0.0.1' });
    await adminClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${adminToken.body.token}` } },
      }),
    );
    clients.push(adminClient);
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await closeTestApp(ctx);
  });

  it('rejects missing and disabled user ids through REST and MCP, and hides disabled lookup targets', async () => {
    const campaign = await primaryDm.post('/api/v1/campaigns').send({ name: 'Assignment validation' });
    const campaignId = campaign.body.id as number;

    const missingRest = await primaryDm
      .post(`/api/v1/campaigns/${campaignId}/members`)
      .send({ userId: 999999, role: 'player' });
    expect(missingRest.status).toBe(404);
    expect(missingRest.body.message).toBe('User 999999 not found');

    const disabled = await admin.patch(`/api/v1/users/${disabledTargetId}`).send({ disabled: true });
    expect(disabled.status).toBe(200);
    const disabledRest = await primaryDm
      .post(`/api/v1/campaigns/${campaignId}/members`)
      .send({ userId: disabledTargetId, role: 'player' });
    expect(disabledRest.status).toBe(400);

    const lookup = await primaryDm.get('/api/v1/users/lookup').query({ query: 'integrity-disabled' });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toEqual([]);

    const missingMcp = await dmClient.callTool({
      name: 'add_member',
      arguments: { campaignId, userId: 999998, role: 'viewer' },
    });
    expect(toolStatus(missingMcp)).toBe(404);
    const disabledMcp = await dmClient.callTool({
      name: 'add_member',
      arguments: { campaignId, userId: disabledTargetId, role: 'viewer' },
    });
    expect(toolStatus(disabledMcp)).toBe(400);
  });

  it('refuses promotion of an existing disabled member to DM and marks the roster row disabled', async () => {
    const userId = await createUser('integrity-existing-disabled');
    const campaign = await primaryDm.post('/api/v1/campaigns').send({ name: 'Disabled promotion' });
    const added = await primaryDm
      .post(`/api/v1/campaigns/${campaign.body.id}/members`)
      .send({ userId, role: 'player' });
    expect(added.status).toBe(201);
    expect((await admin.patch(`/api/v1/users/${userId}`).send({ disabled: true })).status).toBe(200);

    const promote = await primaryDm
      .patch(`/api/v1/campaigns/${campaign.body.id}/members/${added.body.id}`)
      .send({ role: 'dm' });
    expect(promote.status).toBe(400);

    const roster = await primaryDm.get(`/api/v1/campaigns/${campaign.body.id}/members`);
    expect(roster.body.find((member: { userId: number }) => member.userId === userId)).toMatchObject({
      role: 'player',
      disabled: true,
    });
  });

  it('refuses disabling or deleting an enabled account that is a campaign\'s sole usable DM', async () => {
    const disableId = await createUser('integrity-sole-disable');
    const disableDm = await login('integrity-sole-disable');
    const disableCampaign = await disableDm.post('/api/v1/campaigns').send({ name: 'Sole disable campaign' });
    expect(disableCampaign.status).toBe(201);
    const disable = await admin.patch(`/api/v1/users/${disableId}`).send({ disabled: true });
    expect(disable.status).toBe(409);
    expect(disable.body.message).toContain('Sole disable campaign');

    const deleteId = await createUser('integrity-sole-delete');
    const deleteDm = await login('integrity-sole-delete');
    const deleteCampaign = await deleteDm.post('/api/v1/campaigns').send({ name: 'Sole delete campaign' });
    expect(deleteCampaign.status).toBe(201);
    const remove = await admin.delete(`/api/v1/users/${deleteId}`);
    expect(remove.status).toBe(409);
    expect(remove.body.message).toContain('Sole delete campaign');
  });

  it('does not let a disabled or ghost co-DM authorize removal of the only real DM', async () => {
    const disabledCoId = await createUser('integrity-disabled-codm');
    const disabledCampaign = await primaryDm.post('/api/v1/campaigns').send({ name: 'Disabled co-DM' });
    const disabledCo = await primaryDm
      .post(`/api/v1/campaigns/${disabledCampaign.body.id}/members`)
      .send({ userId: disabledCoId, role: 'dm' });
    expect(disabledCo.status).toBe(201);
    expect((await admin.patch(`/api/v1/users/${disabledCoId}`).send({ disabled: true })).status).toBe(200);
    const disabledRoster = await primaryDm.get(`/api/v1/campaigns/${disabledCampaign.body.id}/members`);
    const primarySeat = disabledRoster.body.find((member: { userId: number }) => member.userId === primaryDmId);
    expect((await primaryDm.delete(`/api/v1/campaigns/${disabledCampaign.body.id}/members/${primarySeat.id}`)).status).toBe(409);

    const ghostCampaign = await primaryDm.post('/api/v1/campaigns').send({ name: 'Ghost co-DM' });
    const sqlite = new Database(dbFilePath(ctx.dataDir));
    try {
      sqlite.pragma('foreign_keys = OFF');
      const now = new Date().toISOString();
      sqlite
        .prepare("INSERT INTO campaign_members (campaign_id, user_id, role, created_at, updated_at) VALUES (?, 777777, 'dm', ?, ?)")
        .run(ghostCampaign.body.id, now, now);
    } finally {
      sqlite.close();
    }
    const ghostRoster = await primaryDm.get(`/api/v1/campaigns/${ghostCampaign.body.id}/members`);
    const realSeat = ghostRoster.body.find((member: { userId: number }) => member.userId === primaryDmId);
    expect((await primaryDm.delete(`/api/v1/campaigns/${ghostCampaign.body.id}/members/${realSeat.id}`)).status).toBe(409);
  });

  it('provides secret-free REST diagnostics and recovers an orphan without implicit admin campaign access', async () => {
    const campaignId = insertOrphanCampaign('REST recovery campaign');
    expect((await admin.get(`/api/v1/campaigns/${campaignId}`)).status).toBe(403);

    const report = await admin.get('/api/v1/admin/membership-integrity');
    expect(report.status).toBe(200);
    const issue = report.body.campaigns.find((campaign: { campaignId: number }) => campaign.campaignId === campaignId);
    expect(issue).toMatchObject({
      campaignName: 'REST recovery campaign',
      usableDmCount: 0,
      repairRequired: true,
    });
    expect(issue).not.toHaveProperty('description');
    expect(report.body).not.toHaveProperty('dmSecret');

    const repair = await admin
      .post('/api/v1/admin/membership-integrity/repair-dm')
      .send({ campaignId, userId: enabledTargetId });
    expect(repair.status).toBe(201);
    expect(repair.body).toMatchObject({ usableDmCount: 1, repairRequired: false });
    expect((await admin.get(`/api/v1/campaigns/${campaignId}`)).status).toBe(403);

    const recovered = await login('integrity-recovery');
    expect((await recovered.get(`/api/v1/campaigns/${campaignId}`)).status).toBe(200);
    expect(
      (await admin.post('/api/v1/admin/membership-integrity/repair-dm').send({ campaignId, userId: primaryDmId })).status,
    ).toBe(409);
  });

  it('enforces MCP adminEnabled authorization and supports the same secret-free recovery', async () => {
    const denied = await dmClient.callTool({ name: 'get_membership_integrity', arguments: {} });
    expect(toolStatus(denied)).toBe(403);

    const campaignId = insertOrphanCampaign('MCP recovery campaign');
    const reportResult = await adminClient.callTool({ name: 'get_membership_integrity', arguments: {} });
    expect(toolStatus(reportResult)).toBe(200);
    const report = parseTool(reportResult) as { campaigns: Array<{ campaignId: number; repairRequired: boolean }> };
    expect(report.campaigns).toContainEqual(expect.objectContaining({ campaignId, repairRequired: true }));

    const repair = await adminClient.callTool({
      name: 'repair_campaign_dm',
      arguments: { campaignId, userId: primaryDmId },
    });
    expect(toolStatus(repair)).toBe(200);
    expect(parseTool(repair)).toEqual(expect.objectContaining({ usableDmCount: 1, repairRequired: false }));
  });
});
