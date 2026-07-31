import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import {
  INBOX_SWEEP_CLASSIFIER,
  type InboxSweepCapture,
  type InboxSweepClassification,
  type InboxSweepClassifier,
  type InboxSweepContext,
} from '../src/modules/inbox-sweep/inbox-sweep-classifier';

/**
 * Issue #1645 — MCP parity for the inbox sweep (#1644).
 *
 * `sweep_inbox` must call the EXACT SAME `InboxSweepService.startInboxSweep()` orchestration
 * the REST `POST /campaigns/:id/inbox/sweep` route uses (see test/inbox-sweep.e2e-spec.ts for
 * the REST coverage of that shared path) — this suite only exercises the MCP-specific surface:
 * tool registration, DM-role gating, the archived-campaign read-only gate, and write-mode/
 * token-scope parity (propose/none writeScope tokens must be refused like the REST route).
 */
interface TextContent {
  type: 'text';
  text: string;
}

function parseResult(result: unknown): unknown {
  const content = (result as { content: TextContent[] }).content;
  return JSON.parse(content[0].text);
}

function errorOf(result: unknown): { status: number; code: string; message: string } | null {
  if (!(result as { isError?: boolean }).isError) return null;
  return (parseResult(result) as { error: { status: number; code: string; message: string } }).error;
}

class ScriptedClassifier implements InboxSweepClassifier {
  script = new Map<string, InboxSweepClassification>();
  calls: Array<{ capture: InboxSweepCapture; context: InboxSweepContext }> = [];
  beforeReturn: (() => Promise<void>) | null = null;

  async classify(capture: InboxSweepCapture, context: InboxSweepContext): Promise<InboxSweepClassification> {
    this.calls.push({ capture, context });
    if (this.beforeReturn) await this.beforeReturn();
    const scripted = this.script.get(capture.body);
    if (!scripted) throw new Error(`no scripted classification for: ${capture.body}`);
    return scripted;
  }
}

describe('sweep_inbox MCP tool (e2e, issue #1645)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let classifier: ScriptedClassifier;
  const clients: Client[] = [];

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'campfire-1645-e2e', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  async function newCampaign(name: string): Promise<number> {
    const res = await dmAgent.post('/api/v1/campaigns').send({ name });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function submitInbox(campaignId: number, body: string): Promise<number> {
    const res = await dmAgent.post(`/api/v1/campaigns/${campaignId}/inbox`).send({ body });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function mintToken(writeScope: 'direct' | 'propose' | 'none'): Promise<string> {
    const res = await dmAgent.post('/api/v1/tokens').send({ name: `sweep-mcp-${writeScope}`, scope: 'dm', writeScope });
    expect(res.status).toBe(201);
    return res.body.token;
  }

  beforeAll(async () => {
    classifier = new ScriptedClassifier();
    ctx = await createTestAppNoDevAuth({ overrides: [{ token: INBOX_SWEEP_CLASSIFIER, useValue: classifier }] });
    await ctx.app.listen(0);
    const address = ctx.app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;

    dmAgent = request.agent(ctx.app.getHttpServer());
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'sweep-mcp-dm', password: 'dm-password-1' });
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await closeTestApp(ctx);
  });

  beforeEach(() => {
    classifier.script.clear();
    classifier.calls = [];
    classifier.beforeReturn = null;
  });

  it('is registered on the MCP catalog', async () => {
    const token = await mintToken('direct');
    const client = await mcpClient(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('sweep_inbox');
  });

  it('calls the same orchestration as REST: files a create proposal (never a direct write) and resolves the item', async () => {
    const campaignId = await newCampaign('MCP Sweep Create Flow');
    const noteId = await submitInbox(campaignId, 'The party wants a new quest about the sunken shrine.');
    classifier.script.set('The party wants a new quest about the sunken shrine.', {
      action: 'create',
      entityType: 'quest',
      targetId: null,
      fields: { title: 'The Sunken Shrine' },
      reason: 'players raised a new quest hook',
    });

    const token = await mintToken('direct');
    const client = await mcpClient(token);
    const result = await client.callTool({ name: 'sweep_inbox', arguments: { campaignId } });
    expect(result.isError).toBeFalsy();
    const body = parseResult(result) as {
      job: { itemsTotal: number; itemsProposed: number };
      items: Array<{ noteId: number; outcome: string; entityType: string | null; proposalId: number | null }>;
    };
    expect(body.job.itemsTotal).toBe(1);
    expect(body.job.itemsProposed).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ noteId, outcome: 'proposed', entityType: 'quest' });
    const proposalId = body.items[0].proposalId;
    expect(typeof proposalId).toBe('number');

    // Never a direct canon write — same guarantee as the REST route (shared service).
    const quests = await dmAgent.get(`/api/v1/campaigns/${campaignId}/quests`);
    expect(quests.body).toEqual([]);
    const proposals = await dmAgent.get(`/api/v1/campaigns/${campaignId}/proposals?status=pending`);
    const proposal = proposals.body.find((p: { id: number }) => p.id === proposalId);
    expect(proposal).toBeDefined();
    expect(proposal.action).toBe('create');
    expect(proposal.entityType).toBe('quest');

    const inbox = await dmAgent.get(`/api/v1/campaigns/${campaignId}/inbox?resolved=true`);
    const resolved = inbox.body.items.find((i: { id: number }) => i.id === noteId);
    expect(resolved.resolved).toBe(true);
  });

  it('is idempotent over MCP too: re-running the sweep does not re-classify or duplicate the proposal', async () => {
    const campaignId = await newCampaign('MCP Sweep Idempotency');
    await submitInbox(campaignId, 'Please add an NPC for the ferryman, Old Casimir.');
    classifier.script.set('Please add an NPC for the ferryman, Old Casimir.', {
      action: 'create',
      entityType: 'npc',
      targetId: null,
      fields: { name: 'Old Casimir' },
      reason: 'named NPC mentioned in play',
    });

    const token = await mintToken('direct');
    const client = await mcpClient(token);
    const first = await client.callTool({ name: 'sweep_inbox', arguments: { campaignId } });
    expect(first.isError).toBeFalsy();
    expect((parseResult(first) as { job: { itemsProposed: number } }).job.itemsProposed).toBe(1);
    expect(classifier.calls).toHaveLength(1);

    const second = await client.callTool({ name: 'sweep_inbox', arguments: { campaignId } });
    expect(second.isError).toBeFalsy();
    expect((parseResult(second) as { job: { itemsTotal: number } }).job.itemsTotal).toBe(0);
    expect(classifier.calls).toHaveLength(1);
  });

  it('403s a non-DM PAT (dm-secret-leakage guard is requireRole, not membership)', async () => {
    const campaignId = await newCampaign('MCP Sweep Auth Boundary 2');
    await submitInbox(campaignId, 'The party wants a new quest about the missing caravan.');

    const viewerTokenRes = await dmAgent
      .post('/api/v1/tokens')
      .send({ name: 'sweep-mcp-viewer-scope', scope: 'viewer', writeScope: 'direct' });
    expect(viewerTokenRes.status).toBe(201);
    const viewerToken = viewerTokenRes.body.token as string;

    const client = await mcpClient(viewerToken);
    const result = await client.callTool({ name: 'sweep_inbox', arguments: { campaignId } });
    const err = errorOf(result);
    expect(err).not.toBeNull();
    expect(err!.status).toBe(403);
    expect(classifier.calls).toHaveLength(0);
  });

  it('respects the archived-campaign read-only gate', async () => {
    const campaignId = await newCampaign('MCP Sweep Archived Gate');
    await submitInbox(campaignId, 'A rumor about the old mill.');
    const archive = await dmAgent.patch(`/api/v1/campaigns/${campaignId}`).send({ status: 'completed' });
    expect(archive.status).toBe(200);

    const token = await mintToken('direct');
    const client = await mcpClient(token);
    const result = await client.callTool({ name: 'sweep_inbox', arguments: { campaignId } });
    const err = errorOf(result);
    expect(err).not.toBeNull();
    expect(err!.status).toBe(403);
    expect(classifier.calls).toHaveLength(0);
  });

  it('403s a propose-writeScope DM token on both REST and MCP (sweep has auxiliary direct writes)', async () => {
    const campaignId = await newCampaign('MCP Sweep Propose Scope');
    await submitInbox(campaignId, 'Please add an NPC for the miller, Rosalind.');
    const proposeToken = await mintToken('propose');

    const rest = await request(ctx.app.getHttpServer())
      .post(`/api/v1/campaigns/${campaignId}/inbox/sweep`)
      .set('Authorization', `Bearer ${proposeToken}`);
    expect(rest.status).toBe(403);

    const client = await mcpClient(proposeToken);
    const result = await client.callTool({ name: 'sweep_inbox', arguments: { campaignId } });
    const err = errorOf(result);
    expect(err).not.toBeNull();
    expect(err!.status).toBe(403);
    expect(classifier.calls).toHaveLength(0);
  });

  it('403s a none-writeScope (read-only) DM token before the classifier ever runs', async () => {
    const campaignId = await newCampaign('MCP Sweep None Scope');
    await submitInbox(campaignId, 'A quest hook that must not be swept by a read-only token.');

    const noneToken = await mintToken('none');
    const client = await mcpClient(noneToken);
    const result = await client.callTool({ name: 'sweep_inbox', arguments: { campaignId } });
    const err = errorOf(result);
    expect(err).not.toBeNull();
    expect(err!.status).toBe(403);
    expect(classifier.calls).toHaveLength(0);
  });

  it('is registered on the MCP catalog (poll tool)', async () => {
    const token = await mintToken('direct');
    const client = await mcpClient(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('get_inbox_sweep_result');
  });

  it('exposes the background-sweep result over MCP with the same contract as REST (#1716)', async () => {
    const campaignId = await newCampaign('MCP Sweep Background');
    const noteId = await submitInbox(campaignId, 'The party wants a new quest about the cursed keep.');
    classifier.script.set('The party wants a new quest about the cursed keep.', {
      action: 'create',
      entityType: 'quest',
      targetId: null,
      fields: { title: 'The Cursed Keep' },
      reason: 'players raised a new quest hook',
    });

    // Ensure the fast-path race loses (8s timeout) so sweep_inbox returns a running job.
    classifier.beforeReturn = () => new Promise<void>((resolve) => setTimeout(resolve, 9500));

    const token = await mintToken('direct');
    const client = await mcpClient(token);
    const start = await client.callTool({ name: 'sweep_inbox', arguments: { campaignId } });
    expect(start.isError).toBeFalsy();
    const startBody = parseResult(start) as { job: { id: number; status: string } };
    expect(startBody.job.status).toBe('running');
    const jobId = startBody.job.id;

    // Poll get_inbox_sweep_result until the background work completes.
    let result = startBody;
    for (let i = 0; i < 40 && result.job.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const poll = await client.callTool({
        name: 'get_inbox_sweep_result',
        arguments: { campaignId, jobId },
      });
      expect(poll.isError).toBeFalsy();
      result = parseResult(poll) as { job: { id: number; status: string } };
    }

    expect(result.job.status).toBe('succeeded');
    const final = result as unknown as {
      job: { itemsProposed: number };
      items: Array<{ noteId: number; outcome: string; entityType: string | null; proposalId: number | null }>;
    };
    expect(final.job.itemsProposed).toBe(1);
    expect(final.items).toHaveLength(1);
    expect(final.items[0]).toMatchObject({ noteId, outcome: 'proposed', entityType: 'quest' });

    classifier.beforeReturn = null;
  });
});
