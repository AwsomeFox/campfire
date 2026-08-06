import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, type TestAppContext } from './test-app';

interface TextContent {
  type: 'text';
  text: string;
}

function parseResult(result: unknown): unknown {
  const content = (result as { content: TextContent[] }).content;
  return JSON.parse(content[0].text);
}

describe('Issue #2029: restore_campaign MCP tool restores trashed campaign (e2e)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let playerAgent: ReturnType<typeof request.agent>;
  let outsiderAgent: ReturnType<typeof request.agent>;

  let campaignId: number;

  let dmToken: string;
  let playerToken: string;
  let outsiderToken: string;
  const clients: Client[] = [];

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'campfire-2029-e2e', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    const address = ctx.app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;

    dmAgent = request.agent(baseUrl);
    playerAgent = request.agent(baseUrl);
    outsiderAgent = request.agent(baseUrl);

    // Setup DM user
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'dm2029', password: 'password123' });
    const dmMint = await dmAgent.post('/api/v1/tokens').send({ name: 'dm-token', scope: 'dm', writeScope: 'direct' });
    dmToken = dmMint.body.token;

    // Create campaign as DM
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Trashed Campaign 2029' });
    expect(campRes.status).toBe(201);
    campaignId = campRes.body.id;

    // Create Player user and add as member
    const createPlayer = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'player2029', password: 'password123', serverRole: 'user' });
    const playerId = createPlayer.body.id as number;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: playerId, role: 'player' });

    await playerAgent.post('/api/v1/auth/login').send({ username: 'player2029', password: 'password123' });
    const playerMint = await playerAgent
      .post('/api/v1/tokens')
      .send({ name: 'player-token', scope: 'player', writeScope: 'direct', campaignId });
    playerToken = playerMint.body.token;

    // Create Outsider user (not a member of campaign)
    await dmAgent
      .post('/api/v1/users')
      .send({ username: 'outsider2029', password: 'password123', serverRole: 'user' });
    await outsiderAgent.post('/api/v1/auth/login').send({ username: 'outsider2029', password: 'password123' });
    const outsiderMint = await outsiderAgent
      .post('/api/v1/tokens')
      .send({ name: 'outsider-token', scope: 'dm', writeScope: 'direct' });
    outsiderToken = outsiderMint.body.token;
  });

  afterAll(async () => {
    for (const client of clients) {
      await client.close().catch(() => undefined);
    }
    if (ctx) {
      await ctx.app.close();
    }
  });

  it('allows DM to restore a trashed campaign via MCP restore_campaign tool', async () => {
    // 1. DM trashes the campaign via REST
    const deleteRes = await dmAgent.delete(`/api/v1/campaigns/${campaignId}`);
    expect(deleteRes.status).toBe(200);

    // Verify REST GET /campaigns/:id returns 404 while trashed
    const getTrashed = await dmAgent.get(`/api/v1/campaigns/${campaignId}`);
    expect(getTrashed.status).toBe(404);

    // 2. Outsider (non-member) calling restore_campaign fails
    const outsiderClient = await mcpClient(outsiderToken);
    const outsiderResult = await outsiderClient.callTool({
      name: 'restore_campaign',
      arguments: { campaignId },
    });
    expect(outsiderResult.isError).toBe(true);

    // 3. Non-DM member (player) calling restore_campaign fails
    const playerClient = await mcpClient(playerToken);
    const playerResult = await playerClient.callTool({
      name: 'restore_campaign',
      arguments: { campaignId },
    });
    expect(playerResult.isError).toBe(true);

    // 4. DM calling restore_campaign succeeds
    const dmClient = await mcpClient(dmToken);
    const dmResult = await dmClient.callTool({
      name: 'restore_campaign',
      arguments: { campaignId },
    });
    expect(dmResult.isError).toBeUndefined();

    const restored = parseResult(dmResult) as { id: number; deletedAt: string | null };
    expect(restored.id).toBe(campaignId);
    expect(restored.deletedAt).toBeNull();

    // 5. Verify campaign is accessible via REST GET /campaigns/:id again
    const getRestored = await dmAgent.get(`/api/v1/campaigns/${campaignId}`);
    expect(getRestored.status).toBe(200);
    expect(getRestored.body.deletedAt).toBeNull();
  });
});
