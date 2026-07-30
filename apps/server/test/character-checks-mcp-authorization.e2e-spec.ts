import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #1479 — MCP parity half. `roll_check` and `saving_throw` each independently
 * re-derived the REST controller's gate (`requireMember(..., { write: true })`), which
 * only asserts the CAMPAIGN accepts writes, not that the CALLER has write authority over
 * the TARGET character. Any campaign member — including a viewer, or a player who does
 * not own the character — could roll (and, via `roll_check`, attach arbitrary
 * `consequence` text) as any character in the campaign. Both tools now go through the
 * same `CharactersService.assertCharacterWritable` seam the REST controller uses, so
 * fixing the authority decision once fixes every caller.
 *
 * These tests drive the real MCP transport (PAT bearer tokens, not dev-auth headers,
 * since MCP has no dev-auth path) with real per-role users, mirroring
 * character-checks.e2e-spec.ts's REST coverage of the same four cases.
 */
interface TextContent {
  type: 'text';
  text: string;
}

function parseResult(result: unknown): unknown {
  const content = (result as { content: TextContent[] }).content;
  return JSON.parse(content[0].text);
}

describe('Issue #1479: roll_check / saving_throw MCP tools enforce dm-or-owner (e2e)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let characterId: number;
  let dmUserId: number;

  let dmToken: string;
  let ownerToken: string;
  let otherPlayerToken: string;
  let viewerToken: string;
  const clients: Client[] = [];

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'campfire-1479-e2e', version: '0.0.1' });
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
    const dmSetup = await dmAgent.post('/api/v1/auth/setup').send({ username: 'issue1479-dm', password: 'dm-password-1' });
    dmUserId = dmSetup.body.user.id as number;

    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'Issue 1479 Campaign' });
    campaignId = campRes.body.id;

    // The owning player.
    const createOwner = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'issue1479-owner', password: 'owner-password-1', serverRole: 'user' });
    const ownerId = createOwner.body.id as number;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: ownerId, role: 'player' });

    // A second, unrelated player — same campaign, does NOT own the target character.
    const createOther = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'issue1479-other', password: 'other-password-1', serverRole: 'user' });
    const otherId = createOther.body.id as number;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: otherId, role: 'player' });

    // A read-only viewer.
    const createViewer = await dmAgent
      .post('/api/v1/users')
      .send({ username: 'issue1479-viewer', password: 'viewer-password-1', serverRole: 'user' });
    const viewerId = createViewer.body.id as number;
    await dmAgent.post(`/api/v1/campaigns/${campaignId}/members`).send({ userId: viewerId, role: 'viewer' });

    const charRes = await dmAgent.post(`/api/v1/campaigns/${campaignId}/characters`).send({
      name: 'Mira',
      level: 3,
      hpMax: 22,
      hpCurrent: 22,
      stats: { STR: 12, DEX: 14, CON: 13, INT: 10, WIS: 11, CHA: 8 },
      saveProficiencies: ['DEX'],
      ownerUserId: String(ownerId),
    });
    expect(charRes.status).toBe(201);
    characterId = charRes.body.id;

    const dmMint = await dmAgent.post('/api/v1/tokens').send({ name: 'issue1479-dm-token', scope: 'dm', writeScope: 'direct' });
    dmToken = dmMint.body.token;

    const ownerAgent = request.agent(ctx.app.getHttpServer());
    await ownerAgent.post('/api/v1/auth/login').send({ username: 'issue1479-owner', password: 'owner-password-1' });
    const ownerMint = await ownerAgent
      .post('/api/v1/tokens')
      .send({ name: 'issue1479-owner-token', scope: 'player', writeScope: 'direct', campaignId });
    ownerToken = ownerMint.body.token;

    const otherAgent = request.agent(ctx.app.getHttpServer());
    await otherAgent.post('/api/v1/auth/login').send({ username: 'issue1479-other', password: 'other-password-1' });
    const otherMint = await otherAgent
      .post('/api/v1/tokens')
      .send({ name: 'issue1479-other-token', scope: 'player', writeScope: 'direct', campaignId });
    otherPlayerToken = otherMint.body.token;

    const viewerAgent = request.agent(ctx.app.getHttpServer());
    await viewerAgent.post('/api/v1/auth/login').send({ username: 'issue1479-viewer', password: 'viewer-password-1' });
    const viewerMint = await viewerAgent
      .post('/api/v1/tokens')
      .send({ name: 'issue1479-viewer-token', scope: 'viewer', writeScope: 'direct', campaignId });
    viewerToken = viewerMint.body.token;
  });

  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await closeTestApp(ctx);
  });

  async function rollCount(): Promise<number> {
    const res = await dmAgent.get(`/api/v1/campaigns/${campaignId}/rolls?limit=100`);
    return res.body.length as number;
  }

  describe('roll_check', () => {
    it('a viewer may not roll a check for a character — isError, nothing persisted', async () => {
      const before = await rollCount();
      const client = await mcpClient(viewerToken);
      const res = await client.callTool({ name: 'roll_check', arguments: { characterId, checkId: 'skill:Stealth' } });
      expect(res.isError).toBe(true);
      expect(await rollCount()).toBe(before);
    });

    it('a player who does not own the character may not roll a check for it — isError, nothing persisted', async () => {
      const before = await rollCount();
      const client = await mcpClient(otherPlayerToken);
      const res = await client.callTool({ name: 'roll_check', arguments: { characterId, checkId: 'skill:Stealth' } });
      expect(res.isError).toBe(true);
      expect(await rollCount()).toBe(before);
    });

    it('the owning player may roll their own character — regression guard', async () => {
      const client = await mcpClient(ownerToken);
      const res = await client.callTool({ name: 'roll_check', arguments: { characterId, checkId: 'skill:Stealth' } });
      expect(res.isError).toBeFalsy();
      const parsed = parseResult(res) as { roll: { rollerUserId: string } };
      expect(parsed.roll.rollerUserId).toBeTruthy();
    });

    it('the dm may roll a check for any character, including one they do not own', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'roll_check', arguments: { characterId, checkId: 'skill:Stealth' } });
      expect(res.isError).toBeFalsy();
    });

    // Consequence text is attributed to the acting user, not silently under the
    // character's name (issue #1479's second half): the persisted roll's
    // rollerUserId/rollerName always identify the real caller (dm-or-owner, now that
    // authorization is enforced), distinct from the character the roll is made "as".
    it('consequence text rides on the label but the roll is attributed to the real acting user, not the character', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({
        name: 'roll_check',
        arguments: { characterId, checkId: 'skill:Stealth', consequence: 'Something stirs in the dark.' },
      });
      expect(res.isError).toBeFalsy();
      const parsed = parseResult(res) as { roll: { label: string; rollerUserId: string; rollerName: string } };
      expect(parsed.roll.label).toContain('Mira · Stealth');
      expect(parsed.roll.label).toContain('Something stirs in the dark.');
      expect(parsed.roll.rollerName).not.toBe('Mira');
      expect(parsed.roll.rollerUserId).toBe(String(dmUserId));
    });
  });

  describe('sheet-derived read tools', () => {
    it.each(['viewer', 'non-owner player'])('%s cannot list a teammate\'s checks or resource vocabulary', async (label) => {
      // Tokens are minted in beforeAll, so resolve them inside the test rather than
      // capturing undefined values while Jest registers this parameterized case.
      const token = label === 'viewer' ? viewerToken : otherPlayerToken;
      // MCP closes an unauthorized stream after the first tool error, so each denial
      // uses its own authenticated transport to exercise both tool boundaries.
      const checks = await (await mcpClient(token)).callTool({ name: 'list_checks', arguments: { characterId } });
      const resources = await (await mcpClient(token)).callTool({ name: 'list_character_resources', arguments: { characterId } });
      expect(checks.isError).toBe(true);
      expect(resources.isError).toBe(true);
    });

    it('the owning player and dm retain access to their allowed sheet-derived reads', async () => {
      const ownerClient = await mcpClient(ownerToken);
      const dmClient = await mcpClient(dmToken);
      const [checks, resources] = await Promise.all([
        ownerClient.callTool({ name: 'list_checks', arguments: { characterId } }),
        dmClient.callTool({ name: 'list_character_resources', arguments: { characterId } }),
      ]);
      expect(checks.isError).toBeFalsy();
      expect(resources.isError).toBeFalsy();
    });
  });

  describe('saving_throw', () => {
    it('a viewer may not roll a save for a character — isError, nothing persisted', async () => {
      const before = await rollCount();
      const client = await mcpClient(viewerToken);
      const res = await client.callTool({ name: 'saving_throw', arguments: { characterId, ability: 'DEX', dc: 12 } });
      expect(res.isError).toBe(true);
      expect(await rollCount()).toBe(before);
    });

    it('a player who does not own the character may not roll a save for it — isError, nothing persisted', async () => {
      const before = await rollCount();
      const client = await mcpClient(otherPlayerToken);
      const res = await client.callTool({ name: 'saving_throw', arguments: { characterId, ability: 'DEX', dc: 12 } });
      expect(res.isError).toBe(true);
      expect(await rollCount()).toBe(before);
    });

    it('the owning player may roll a save for their own character — regression guard', async () => {
      const client = await mcpClient(ownerToken);
      const res = await client.callTool({ name: 'saving_throw', arguments: { characterId, ability: 'DEX', dc: 12 } });
      expect(res.isError).toBeFalsy();
      const parsed = parseResult(res) as { characterId: number };
      expect(parsed.characterId).toBe(characterId);
    });

    it('the dm may roll a save for any character, including one they do not own', async () => {
      const client = await mcpClient(dmToken);
      const res = await client.callTool({ name: 'saving_throw', arguments: { characterId, ability: 'DEX', dc: 12 } });
      expect(res.isError).toBeFalsy();
    });
  });
});
