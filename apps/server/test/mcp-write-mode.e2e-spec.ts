import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #393 — several MUTATING MCP tools were registered with `this.tool(...)` instead of
 * `this.writeTool(...)`, so they skipped the server-enforced write-mode guard (#158). A PAT
 * scoped `propose` or `none` (meant to be non-writing / proposal-only) could therefore call
 * them to WRITE DIRECTLY over MCP — archive/rename a campaign, uninstall a rule pack, withdraw a
 * proposal, whisper to a player, set attendance, delete a session/character — bypassing the
 * restriction the write-scope is supposed to enforce.
 *
 * These tests drive the real MCP transport with propose- and none-scoped tokens and assert every
 * formerly-leaky tool now refuses the DIRECT write:
 *  - direct-only tools (no proposal path) are 403'd for both propose and none tokens;
 *  - the proposal-capable deletes are COERCED to a pending proposal for a propose token (never a
 *    direct delete) and 403'd for a none token.
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

describe('Issue #393: mutating MCP tools honor token write-mode (e2e)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let sessionId: number;
  let characterId: number;

  // All three tokens carry DM READ scope — the point is that read authority (dm) and write
  // authority (direct/propose/none) are independent (#158): even a dm-read token that is
  // propose/none-scoped must not write these tools directly.
  let directToken: string;
  let proposeToken: string;
  let noneToken: string;
  const clients: Client[] = [];

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'campfire-393-e2e', version: '0.0.1' });
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
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'wm393-dm', password: 'dm-password-1' });

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Write-Mode 393 Campaign' });
    campaignId = campRes.body.id;

    const sessionRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/sessions`).send({ recap: 'The party met.' });
    sessionId = sessionRes.body.id;

    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({ name: 'Brawn the Fighter' });
    characterId = charRes.body.id;

    // Three dm-read-scoped tokens differing ONLY in write authority.
    const directMint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm393-direct', scope: 'dm', writeScope: 'direct' });
    directToken = directMint.body.token;
    const proposeMint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm393-propose', scope: 'dm', writeScope: 'propose' });
    proposeToken = proposeMint.body.token;
    const noneMint = await dmAgent.post('/api/v1/tokens').send({ name: 'wm393-none', scope: 'dm', writeScope: 'none' });
    noneToken = noneMint.body.token;
    expect(proposeMint.body.apiToken.writeScope).toBe('propose');
    expect(noneMint.body.apiToken.writeScope).toBe('none');
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await closeTestApp(ctx);
  });

  // The formerly-leaky DIRECT-ONLY writes (no proposal path). Each is now a writeTool, so its
  // handler runs assertDirectWriteAllowed FIRST — a propose/none token is 403'd before the write.
  // run_scribe (#522): files a pending proposal + spends the AI seat budget, so it was re-registered
  // via writeTool (was this.tool) — same defect class as the b3af808 sweep. It is direct-write gated
  // (no propose arg / no @Proposable path on the REST endpoint), so a propose token can't route it
  // through review either.
  const directOnlyCalls: { name: string; args: () => Record<string, unknown> }[] = [
    { name: 'update_campaign', args: () => ({ campaignId, name: 'Hijacked Name' }) },
    { name: 'uninstall_rule_pack', args: () => ({ packId: 999_999 }) },
    { name: 'withdraw_proposal', args: () => ({ proposalId: 999_999 }) },
    { name: 'whisper_to_player', args: () => ({ campaignId, recipientUserId: 'nobody', body: 'a secret' }) },
    { name: 'set_session_attendance', args: () => ({ sessionId, characterIds: [] }) },
    { name: 'run_scribe', args: () => ({ campaignId }) },
  ];

  describe('a propose-scoped token is refused a direct call to each formerly-leaky tool', () => {
    it.each(directOnlyCalls)('$name is 403 (no proposal path) for a propose token', async ({ name, args }) => {
      const client = await mcpClient(proposeToken);
      const result = await client.callTool({ name, arguments: args() });
      const err = errorOf(result);
      expect(err).not.toBeNull();
      expect(err!.status).toBe(403);
      // Distinctly the write-mode refusal (not a role/not-found error): it fires before any lookup.
      expect(err!.message).toMatch(/only submit proposals|read-only/i);
    });

    it('update_campaign did NOT rename the campaign (canon untouched)', async () => {
      const camp = await dmAgent.get(`/api/v1/campaigns/${campaignId}`);
      expect(camp.body.name).toBe('Write-Mode 393 Campaign');
    });

    it('delete_session is COERCED to a proposal, not a direct delete', async () => {
      const client = await mcpClient(proposeToken);
      const result = await client.callTool({ name: 'delete_session', arguments: { sessionId } });
      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as { proposal?: { status: string; action: string } };
      expect(body.proposal?.status).toBe('pending');
      expect(body.proposal?.action).toBe('delete');
      // The session still exists — nothing was deleted directly.
      const session = await dmAgent.get(`/api/v1/sessions/${sessionId}`);
      expect(session.status).toBe(200);
    });

    it('delete_character is COERCED to a proposal, not a direct delete', async () => {
      const client = await mcpClient(proposeToken);
      const result = await client.callTool({ name: 'delete_character', arguments: { characterId } });
      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as { proposal?: { status: string; action: string } };
      expect(body.proposal?.status).toBe('pending');
      const character = await dmAgent.get(`/api/v1/characters/${characterId}`);
      expect(character.status).toBe(200);
    });
  });

  describe('a none-scoped (read-only) token is refused EVERY formerly-leaky write', () => {
    const allWrites = [
      ...directOnlyCalls,
      { name: 'delete_session', args: () => ({ sessionId }) },
      { name: 'delete_character', args: () => ({ characterId }) },
    ];
    it.each(allWrites)('$name is 403 for a none token', async ({ name, args }) => {
      const client = await mcpClient(noneToken);
      const result = await client.callTool({ name, arguments: args() });
      const err = errorOf(result);
      expect(err).not.toBeNull();
      expect(err!.status).toBe(403);
      expect(err!.message).toMatch(/read-only|cannot perform writes/i);
    });
  });

  describe('a direct-scoped token still drives these tools (write authority intact)', () => {
    it('update_campaign renames the campaign directly', async () => {
      const client = await mcpClient(directToken);
      const result = await client.callTool({ name: 'update_campaign', arguments: { campaignId, name: 'Renamed Directly' } });
      expect(result.isError).toBeFalsy();
      const camp = await dmAgent.get(`/api/v1/campaigns/${campaignId}`);
      expect(camp.body.name).toBe('Renamed Directly');
    });
  });

  // Issue #522 — run_scribe was registered with this.tool(...) (the read path) instead of
  // writeTool(...), so a writeScope:'none' PAT could trigger it: the handler invoked
  // scribe.run(...), which writes a PENDING recap proposal AND meters tokens against the
  // campaign's AI-DM seat budget. Same defect class as the b3af808 sweep — run_scribe was
  // added afterward and missed it. Now a writeTool, so the wrapper runs
  // assertDirectWriteAllowed(user) + tags mutating:true. It has no `propose` arg and the REST
  // POST /campaigns/:id/scribe/run endpoint carries no @Proposable() path, so it is DIRECT-WRITE
  // gated: both 'none' and 'propose' tokens are refused (a propose token can't route an AI-budget
  // spend through review), exactly like update_campaign above.
  describe('Issue #522: run_scribe is write-gated (files a proposal + spends the AI budget)', () => {
    it('a none-scoped (read-only) token is refused run_scribe BEFORE the handler runs', async () => {
      const client = await mcpClient(noneToken);
      const result = await client.callTool({ name: 'run_scribe', arguments: { campaignId } });
      const err = errorOf(result);
      expect(err).not.toBeNull();
      expect(err!.status).toBe(403);
      expect(err!.message).toMatch(/read-only|cannot perform writes/i);
    });

    it('a propose-scoped token is refused run_scribe (no proposal path — direct-write tier)', async () => {
      const client = await mcpClient(proposeToken);
      const result = await client.callTool({ name: 'run_scribe', arguments: { campaignId } });
      const err = errorOf(result);
      expect(err).not.toBeNull();
      expect(err!.status).toBe(403);
      expect(err!.message).toMatch(/only submit proposals|cannot be performed directly/i);
    });

    it('a direct-scoped token passes the write-mode gate and reaches scribe.run (not a 403)', async () => {
      const client = await mcpClient(directToken);
      const result = await client.callTool({ name: 'run_scribe', arguments: { campaignId } });
      // The write-mode gate passed (no 403). scribe.run returns a normal result — the suite's
      // app has experimentalAiDm off, so the run is recorded as 'disabled' rather than spending
      // budget; what matters here is that the write-mode refusal did NOT fire for a direct token.
      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as { job?: { status: string } };
      expect(body.job).toBeDefined();
      expect(body.job!.status).toBe('disabled');
    });
  });
});
