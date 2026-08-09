import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';

interface TextContent { type: 'text'; text: string }
function bodyOf<T>(result: unknown): T {
  return JSON.parse((result as { content: TextContent[] }).content[0].text) as T;
}

describe('MCP vs browser shared-editor concurrency — #881', () => {
  let ctx: TestAppContext;
  let agent: ReturnType<typeof request.agent>;
  let client: Client;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    agent = request.agent(ctx.app.getHttpServer());
    await agent.post('/api/v1/auth/setup').send({ username: 'mcp-881-dm', password: 'dm-password-1' });
    campaignId = (await agent.post('/api/v1/campaigns').send({ name: 'MCP race' })).body.id;
    const token = (await agent.post('/api/v1/tokens').send({ name: 'mcp-881', scope: 'dm', writeScope: 'direct' })).body.token;
    client = new Client({ name: 'campfire-881-e2e', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${await ctx.app.getUrl()}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
  });

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await closeTestApp(ctx);
  });

  it('returns STALE_WRITE + current revision to an MCP writer racing a browser, then accepts a conflict retry', async () => {
    const event = await agent.post(`/api/v1/campaigns/${campaignId}/timeline`).send({ title: 'Shared canon', body: 'base' });
    const browser = await agent.patch(`/api/v1/timeline/${event.body.id}`).send({ body: 'browser edit', expectedUpdatedAt: event.body.updatedAt });

    const stale = await client.callTool({
      name: 'update_timeline_event',
      arguments: { eventId: event.body.id, body: 'agent draft', expectedUpdatedAt: event.body.updatedAt },
    });
    expect(stale.isError).toBe(true);
    expect(bodyOf<{ error: object }>(stale).error).toMatchObject({
      status: 409,
      code: 'STALE_WRITE',
      currentUpdatedAt: browser.body.updatedAt,
    });

    const retry = await client.callTool({
      name: 'update_timeline_event',
      arguments: { eventId: event.body.id, body: 'browser edit\n\nagent draft', expectedUpdatedAt: browser.body.updatedAt },
    });
    expect(retry.isError).toBeFalsy();
    expect(bodyOf<{ body: string }>(retry).body).toBe('browser edit\n\nagent draft');
  });

  it('advertises the same revision guard for every shared-editor MCP write tool', async () => {
    const listed = await client.listTools();
    for (const name of [
      'update_session_zero',
      'update_beat',
      'update_timeline_event',
      'set_calendar',
      'update_comment',
      'update_scheduled_session',
    ]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toHaveProperty('expectedUpdatedAt');
    }
  });

  it('updates Session Zero with a token and exposes/restores its structured revision history over MCP', async () => {
    const initial = bodyOf<{ updatedAt: string }>(await client.callTool({ name: 'get_session_zero', arguments: { campaignId } }));
    const first = bodyOf<{ updatedAt: string }>(await client.callTool({
      name: 'update_session_zero',
      arguments: { campaignId, lines: ['spiders'], expectedUpdatedAt: initial.updatedAt },
    }));
    const second = bodyOf<{ lines: string[] }>(await client.callTool({
      name: 'update_session_zero',
      arguments: { campaignId, lines: ['spiders', 'needles'], expectedUpdatedAt: first.updatedAt },
    }));
    expect(second.lines).toEqual(['spiders', 'needles']);

    const revisions = bodyOf<Array<{ id: number; snapshot: { lines: string[] } }>>(await client.callTool({
      name: 'list_revisions',
      arguments: { entityType: 'session_zero', entityId: campaignId },
    }));
    expect(revisions[0].snapshot.lines).toEqual(['spiders']);
    const restored = await client.callTool({
      name: 'restore_revision',
      arguments: { entityType: 'session_zero', entityId: campaignId, revisionId: revisions[0].id },
    });
    expect(restored.isError).toBeFalsy();
    expect(bodyOf<{ lines: string[] }>(await client.callTool({ name: 'get_session_zero', arguments: { campaignId } })).lines).toEqual(['spiders']);
  });

  it('advertises and restores story arc revisions over MCP', async () => {
    const listed = await client.listTools();
    const restoreTool = listed.tools.find((candidate) => candidate.name === 'restore_revision');
    const entityType = restoreTool?.inputSchema.properties?.entityType as
      | { description?: string; enum?: string[] }
      | undefined;
    expect(entityType?.enum).toContain('story_arc');
    expect(entityType?.description).toContain('story_arc');

    const arc = await agent
      .post(`/api/v1/campaigns/${campaignId}/arcs`)
      .send({ title: 'MCP revision arc', summary: 'The original arc summary.' });
    expect(arc.status).toBe(201);
    const updated = await agent
      .patch(`/api/v1/arcs/${arc.body.id}`)
      .send({ summary: 'The replacement arc summary.' });
    expect(updated.status).toBe(200);

    const revisions = bodyOf<Array<{ id: number; snapshot: { summary: string } }>>(await client.callTool({
      name: 'list_revisions',
      arguments: { entityType: 'story_arc', entityId: arc.body.id },
    }));
    expect(revisions[0]?.snapshot.summary).toBe('The original arc summary.');

    const restored = await client.callTool({
      name: 'restore_revision',
      arguments: { entityType: 'story_arc', entityId: arc.body.id, revisionId: revisions[0].id },
    });
    expect(restored.isError).toBeFalsy();
    const current = await agent.get(`/api/v1/arcs/${arc.body.id}`);
    expect(current.body.summary).toBe('The original arc summary.');
  });
});
