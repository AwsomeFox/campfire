import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { startFakeOpen5e, type FakeOpen5e } from './fake-open5e';

interface TextContent {
  type: 'text';
  text: string;
}

function parseResult(result: unknown): unknown {
  const content = (result as { content: TextContent[] }).content;
  return JSON.parse(content[0].text);
}

const ALL_TOOLS = [
  // read
  'list_campaigns',
  'get_campaign_summary',
  'get_quest',
  'list_quests',
  'get_npc',
  'list_npcs',
  'get_location',
  'list_locations',
  'get_character',
  'get_party',
  'get_session_recaps',
  'read_inbox',
  'list_proposals',
  'lookup_rule',
  'get_encounter',
  // write
  'create_quest',
  'update_quest',
  'set_quest_status',
  'add_objective',
  'check_objective',
  'upsert_npc',
  'upsert_location',
  'add_session_recap',
  'update_character_hp',
  'add_note',
  'resolve_inbox_item',
  'update_campaign_status',
  'approve_proposal',
  'reject_proposal',
  'roll_dice',
  'create_encounter',
  'add_combatant',
  'roll_initiative',
  'begin_encounter',
  'next_turn',
  'end_encounter',
];

describe('mcp endpoint (e2e, real sessions + PATs)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let dmToken: string;
  let viewerToken: string;
  let fakeOpen5e: FakeOpen5e;
  const clients: Client[] = [];

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'campfire-e2e', version: '0.0.1' });
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

    dmAgent = request.agent(ctx.app.getHttpServer());
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'mcp-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'MCP Campaign' });
    campaignId = campRes.body.id;

    const dmTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-dm-token', scope: 'dm' });
    expect(dmTokenRes.status).toBe(201);
    dmToken = dmTokenRes.body.token;

    const viewerTokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'mcp-viewer-token', scope: 'viewer' });
    expect(viewerTokenRes.status).toBe(201);
    viewerToken = viewerTokenRes.body.token;

    // mcp-dm is the first user created via /auth/setup, so it's also the server admin —
    // install a rule pack from the fake Open5e server for the lookup_rule smoke test below.
    fakeOpen5e = await startFakeOpen5e();
    const installRes = await dmAgent.post('/api/v1/rules/packs/install').send({ source: 'open5e', url: fakeOpen5e.baseUrl });
    expect(installRes.status).toBe(201);
  });

  afterAll(async () => {
    for (const client of clients) {
      await client.close().catch(() => undefined);
    }
    await fakeOpen5e.close();
    await closeTestApp(ctx);
  });

  it('tools/list returns the full catalog', async () => {
    const client = await mcpClient(dmToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOLS].sort());
    expect(tools).toHaveLength(36);
  });

  it('get_campaign_summary works with a dm-scoped PAT', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(result.isError).toBeFalsy();
    const summary = parseResult(result) as { campaign: { id: number; name: string }; openInboxCount: number };
    expect(summary.campaign.id).toBe(campaignId);
    expect(summary.campaign.name).toBe('MCP Campaign');
    expect(summary.openInboxCount).toBe(0);
  });

  it('create_quest via dm PAT creates a quest (verified via REST) and audits token actor', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.callTool({
      name: 'create_quest',
      arguments: { campaignId, title: 'MCP-created quest', body: 'Written over MCP' },
    });
    expect(result.isError).toBeFalsy();
    const quest = parseResult(result) as { id: number; title: string };
    expect(quest.title).toBe('MCP-created quest');

    const restRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(restRes.status).toBe(200);
    expect(restRes.body.some((q: { id: number }) => q.id === quest.id)).toBe(true);

    // service-layer audit picked up the token context automatically
    const auditRes = await dmAgent.get(`/api/v1/campaigns/${campaignId}/audit`);
    const entry = auditRes.body.find(
      (a: { action: string; entityId: number }) => a.action === 'quest.create' && a.entityId === quest.id,
    );
    expect(entry.actor).toBe('token:mcp-dm-token');
  });

  it('viewer-scoped PAT: create_quest is a 403-equivalent isError, but add_note works', async () => {
    const client = await mcpClient(viewerToken);

    const denied = await client.callTool({
      name: 'create_quest',
      arguments: { campaignId, title: 'Should be denied' },
    });
    expect(denied.isError).toBe(true);
    const message = (denied.content as TextContent[])[0].text;
    expect(message).toContain('403');

    const note = await client.callTool({
      name: 'add_note',
      arguments: { campaignId, body: 'A viewer note over MCP', visibility: 'dm_shared' },
    });
    expect(note.isError).toBeFalsy();
    const created = parseResult(note) as { body: string; kind: string };
    expect(created.body).toBe('A viewer note over MCP');
    expect(created.kind).toBe('note');
  });

  it('lookup_rule finds an installed rule pack entry and includes body on the top match', async () => {
    const client = await mcpClient(viewerToken); // read tool — viewer scope is enough
    const result = await client.callTool({ name: 'lookup_rule', arguments: { query: 'fireball' } });
    expect(result.isError).toBeFalsy();
    const matches = parseResult(result) as Array<{ name: string; type: string; body?: string }>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toBe('Fireball');
    expect(matches[0].type).toBe('spell');
    expect(matches[0].body).toContain('bright streak');
  });

  it('lookup_rule respects the type filter', async () => {
    const client = await mcpClient(viewerToken);
    const result = await client.callTool({ name: 'lookup_rule', arguments: { query: 'goblin', type: 'monster' } });
    expect(result.isError).toBeFalsy();
    const matches = parseResult(result) as Array<{ name: string; type: string }>;
    expect(matches.some((m) => m.name === 'Goblin')).toBe(true);
    for (const m of matches) expect(m.type).toBe('monster');
  });

  it('propose:true returns a proposal; quest applied only after approve_proposal', async () => {
    const viewerClient = await mcpClient(viewerToken);
    const proposeResult = await viewerClient.callTool({
      name: 'create_quest',
      arguments: { campaignId, title: 'Proposed quest', propose: true },
    });
    expect(proposeResult.isError).toBeFalsy();
    const { proposal } = parseResult(proposeResult) as {
      proposal: { id: number; status: string; entityType: string; action: string };
    };
    expect(proposal.status).toBe('pending');
    expect(proposal.entityType).toBe('quest');
    expect(proposal.action).toBe('create');

    // not created yet
    const before = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(before.body.some((q: { title: string }) => q.title === 'Proposed quest')).toBe(false);

    // approve over MCP with the dm PAT
    const dmClient = await mcpClient(dmToken);
    const approveResult = await dmClient.callTool({
      name: 'approve_proposal',
      arguments: { proposalId: proposal.id, note: 'looks good' },
    });
    expect(approveResult.isError).toBeFalsy();
    const approved = parseResult(approveResult) as { status: string };
    expect(approved.status).toBe('approved');

    const after = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(after.body.some((q: { title: string }) => q.title === 'Proposed quest')).toBe(true);
  });

  it('create_encounter -> add_combatant -> roll_initiative -> begin_encounter -> next_turn -> end_encounter via dm PAT', async () => {
    const client = await mcpClient(dmToken);

    const createResult = await client.callTool({
      name: 'create_encounter',
      arguments: { campaignId, name: 'MCP Skirmish' },
    });
    expect(createResult.isError).toBeFalsy();
    const created = parseResult(createResult) as { id: number; status: string; combatants: unknown[] };
    expect(created.status).toBe('preparing');
    const encounterId = created.id;

    const addResult = await client.callTool({
      name: 'add_combatant',
      arguments: { encounterId, kind: 'monster', name: 'MCP Kobold', hpMax: 5 },
    });
    expect(addResult.isError).toBeFalsy();
    const combatant = parseResult(addResult) as { id: number; name: string };
    expect(combatant.name).toBe('MCP Kobold');

    const getResult = await client.callTool({ name: 'get_encounter', arguments: { encounterId } });
    expect(getResult.isError).toBeFalsy();
    const fetched = parseResult(getResult) as { combatants: unknown[] };
    expect(fetched.combatants.length).toBeGreaterThanOrEqual(1);

    const rollInitResult = await client.callTool({ name: 'roll_initiative', arguments: { encounterId } });
    expect(rollInitResult.isError).toBeFalsy();
    const afterRoll = parseResult(rollInitResult) as { combatants: Array<{ initiative: number | null }> };
    expect(afterRoll.combatants.every((c) => c.initiative !== null)).toBe(true);

    const beginResult = await client.callTool({ name: 'begin_encounter', arguments: { encounterId } });
    expect(beginResult.isError).toBeFalsy();
    const begun = parseResult(beginResult) as { status: string; round: number };
    expect(begun.status).toBe('running');
    expect(begun.round).toBe(1);

    const nextTurnResult = await client.callTool({ name: 'next_turn', arguments: { encounterId } });
    expect(nextTurnResult.isError).toBeFalsy();

    const endResult = await client.callTool({ name: 'end_encounter', arguments: { encounterId } });
    expect(endResult.isError).toBeFalsy();
    const ended = parseResult(endResult) as { status: string };
    expect(ended.status).toBe('ended');
  });

  it('roll_dice rolls within range via dm PAT', async () => {
    const client = await mcpClient(dmToken);
    const result = await client.callTool({ name: 'roll_dice', arguments: { campaignId, expr: '1d20+1' } });
    expect(result.isError).toBeFalsy();
    const rolled = parseResult(result) as { total: number; rolls: number[] };
    expect(rolled.rolls).toHaveLength(1);
    expect(rolled.total).toBeGreaterThanOrEqual(2);
    expect(rolled.total).toBeLessThanOrEqual(21);
  });

  it('request without Authorization gets 401; GET gets 405', async () => {
    const noAuth = await request(ctx.app.getHttpServer())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(noAuth.status).toBe(401);

    const get = await request(ctx.app.getHttpServer())
      .get('/mcp')
      .set('Authorization', `Bearer ${dmToken}`)
      .set('Accept', 'application/json, text/event-stream');
    expect(get.status).toBe(405);
    expect(get.body.error.message).toContain('POST');
  });
});
