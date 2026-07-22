import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeTestApp, createTestAppNoDevAuth, type TestAppContext } from '../test-app';

interface TextContent { type: 'text'; text: string }

function mcpStatus(result: unknown): number {
  const toolResult = result as { isError?: boolean; content: TextContent[] };
  if (!toolResult.isError) return 200;
  return (JSON.parse(toolResult.content[0].text) as { error: { status: number } }).error.status;
}

/** #654 + #849: every route that can consume usable DM authority serializes in SQLite. */
describe('membership usable-DM concurrency (real SQLite, REST + MCP)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let adminAgent: ReturnType<typeof request.agent>;
  let dmAAgent: ReturnType<typeof request.agent>;
  let dmBAgent: ReturnType<typeof request.agent>;
  let dmAId: number;
  let dmBId: number;
  let dmAToken: string;
  let dmBToken: string;
  let dmAClient: Client;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function createTwoDmCampaign(name: string) {
    const campaign = await dmAAgent.post('/api/v1/campaigns').send({ name });
    expect(campaign.status).toBe(201);
    const campaignId = campaign.body.id as number;
    expect(
      (await dmAAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: dmBId, role: 'dm' })).status,
    ).toBe(201);
    const roster = await dmAAgent.get(`/api/v1/campaigns/${campaignId}/members`);
    return {
      campaignId,
      dmAMemberId: roster.body.find((member: { userId: number }) => member.userId === dmAId).id as number,
      dmBMemberId: roster.body.find((member: { userId: number }) => member.userId === dmBId).id as number,
    };
  }

  async function expectExactlyOneUsableDm(campaignId: number): Promise<void> {
    const diagnostics = await adminAgent.get('/api/v1/admin/membership-integrity');
    const row = diagnostics.body.campaigns.find((campaign: { campaignId: number }) => campaign.campaignId === campaignId);
    if (row) expect(row.usableDmCount).toBe(1);
    else {
      // Healthy campaigns with no disabled/history row are intentionally omitted.
      const roster = await request(baseUrl)
        .get(`/api/v1/campaigns/${campaignId}/members`)
        .set(bearer(dmAToken));
      expect(roster.body.filter((member: { role: string; disabled: boolean }) => member.role === 'dm' && !member.disabled)).toHaveLength(1);
    }
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    baseUrl = await ctx.app.getUrl();

    adminAgent = request.agent(baseUrl);
    expect(
      (await adminAgent.post('/api/v1/auth/setup').send({ username: 'race-admin', password: 'race-admin-password' })).status,
    ).toBe(201);
    const createA = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'race-dm-a', password: 'race-dm-a-password', serverRole: 'user' });
    const createB = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'race-dm-b', password: 'race-dm-b-password', serverRole: 'user' });
    dmAId = createA.body.id;
    dmBId = createB.body.id;

    dmAAgent = request.agent(baseUrl);
    dmBAgent = request.agent(baseUrl);
    expect((await dmAAgent.post('/api/v1/auth/login').send({ username: 'race-dm-a', password: 'race-dm-a-password' })).status).toBe(201);
    expect((await dmBAgent.post('/api/v1/auth/login').send({ username: 'race-dm-b', password: 'race-dm-b-password' })).status).toBe(201);

    await createTwoDmCampaign('PAT bootstrap campaign');
    const tokenA = await dmAAgent.post('/api/v1/tokens').send({ name: 'race-a', scope: 'dm', writeScope: 'direct' });
    const tokenB = await dmBAgent.post('/api/v1/tokens').send({ name: 'race-b', scope: 'dm', writeScope: 'direct' });
    dmAToken = tokenA.body.token;
    dmBToken = tokenB.body.token;
    dmAClient = new Client({ name: 'campfire-membership-race-e2e', version: '0.0.1' });
    await dmAClient.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: bearer(dmAToken) },
      }),
    );
  });

  afterAll(async () => {
    await dmAClient?.close().catch(() => undefined);
    await closeTestApp(ctx);
  });

  it('allows exactly one of two simultaneous REST demotions', async () => {
    const { campaignId, dmAMemberId, dmBMemberId } = await createTwoDmCampaign('Concurrent demotions');
    const results = await Promise.all([
      request(baseUrl)
        .patch(`/api/v1/campaigns/${campaignId}/members/${dmAMemberId}`)
        .set(bearer(dmAToken))
        .send({ role: 'player' }),
      request(baseUrl)
        .patch(`/api/v1/campaigns/${campaignId}/members/${dmBMemberId}`)
        .set(bearer(dmBToken))
        .send({ role: 'player' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body.message).toBe('Cannot demote the last dm of this campaign');
    await expectExactlyOneUsableDm(campaignId);
  });

  it('allows exactly one mixed REST removal / MCP demotion', async () => {
    const { campaignId, dmAMemberId, dmBMemberId } = await createTwoDmCampaign('Concurrent remove and demote');
    const [removeResult, demoteResult] = await Promise.all([
      request(baseUrl).delete(`/api/v1/campaigns/${campaignId}/members/${dmBMemberId}`).set(bearer(dmBToken)),
      dmAClient.callTool({
        name: 'update_member',
        arguments: { campaignId, memberId: dmAMemberId, role: 'player' },
      }),
    ]);
    const statuses = [removeResult.status, mcpStatus(demoteResult)];
    expect(statuses.filter((status) => status >= 200 && status < 300)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    await expectExactlyOneUsableDm(campaignId);
  });

  it('allows exactly one of two simultaneous account disables', async () => {
    const createC = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'race-disable-c', password: 'race-disable-c-password', serverRole: 'user' });
    const createD = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'race-disable-d', password: 'race-disable-d-password', serverRole: 'user' });
    const dmC = request.agent(baseUrl);
    expect((await dmC.post('/api/v1/auth/login').send({ username: 'race-disable-c', password: 'race-disable-c-password' })).status).toBe(201);
    const campaign = await dmC.post('/api/v1/campaigns').send({ name: 'Concurrent account disables' });
    const campaignId = campaign.body.id as number;
    expect(
      (await dmC.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: createD.body.id, role: 'dm' })).status,
    ).toBe(201);
    const results = await Promise.all([
      adminAgent.patch(`/api/v1/users/${createC.body.id}`).send({ disabled: true }),
      adminAgent.patch(`/api/v1/users/${createD.body.id}`).send({ disabled: true }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    await expectExactlyOneUsableDm(campaignId);
  });
});
