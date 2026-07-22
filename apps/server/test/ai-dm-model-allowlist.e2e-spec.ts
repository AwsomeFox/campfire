import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestApp, createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';
import { AiProviderConfigService } from '../src/modules/ai-provider-config/ai-provider-config.service';

/**
 * Issue #564 — AI model policy: prevent legacy `seat.model` from bypassing the admin
 * allowlist.
 *
 * Root cause being closed: the driver passed the legacy `seat.model` to the provider IN
 * PREFERENCE to the approved provider config, while the allowlist was validated only when
 * the provider config was WRITTEN. So a DM could set `seat.model: 'gpt-4-internal'` (or
 * any arbitrary string) and have it sent, bypassing the admin's `allowedModels`. The fix
 * makes the executable model derive ONLY from the effective provider config and revalidates
 * the allowlist at EXECUTION time (so tightening the allowlist later still takes effect).
 *
 * Coverage:
 *   - BEHAVIORAL regression (audit-based): a driver turn / takeTurn with a legacy
 *     `seat.model` set to a disallowed string must send the RESOLVED provider-config model,
 *     not the legacy label. These assertions read only the audit log + HTTP responses, so
 *     they FAIL at runtime under the old code (which audited `model=${seat.model}`).
 *   - EXECUTION-TIME allowlist revalidation: tightening the admin allowlist after a seat
 *     was configured rejects subsequent execution at the resolution choke point.
 *   - Both provider families (OpenAI-compatible AND Anthropic) flow through the SAME
 *     `AiProviderConfig` / `resolveExecutionModel` choke point, so both are covered.
 *
 * Test strategy:
 *   - For the ALLOWLIST-REJECTION tests we configure `openai`/`anthropic` providers; the
 *     rejection happens at model RESOLUTION, before any network fetch, so no real vendor
 *     call is made.
 *   - For the AUDIT-shows-the-model tests we configure the `mock` provider (no network) so
 *     a turn completes and the audit records the resolved model.
 */

const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'aml-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'aml-player' };

/** A legacy `seat.model` value that is NOT on any allowlist — the bypass vector. */
const LEGACY_BYPASS_MODEL = 'gpt-4-internal-bypass';

describe('ai-dm model allowlist — legacy seat.model cannot bypass admin policy (issue #564, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    // Turn the server-wide experimental flag on (every AI-DM write is gated on it).
    await request(server).patch('/api/v1/settings').set(dm).send({ experimentalAiDm: true });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /**
   * Configure a server default + campaign override for `providerType`, both using `model`,
   * with the server allowlist set to `allow`. Then set a driver seat whose LEGACY
   * `seat.model` is a disallowed bypass string. Returns the campaign id.
   */
  async function setupWithLegacySeatModel(
    providerType: 'openai' | 'anthropic' | 'mock',
    model: string,
    allow: string[],
    apiKey = 'sk-allowlist-test-key-0001',
  ): Promise<number> {
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: `AML ${providerType}-${model}` });
    const campaignId = camp.body.id as number;

    const serverPut = await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType, model, apiKey, allowedModels: allow });
    expect(serverPut.status).toBe(200);

    const campPut = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType, model });
    expect(campPut.status).toBe(200);

    // The legacy `model` field is set to a DISALLOWED string — exactly the bypass vector.
    // It is stored (informational) but, after the fix, never drives execution.
    const seat = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .set(dm)
      .send({ mode: 'driver', enabled: true, tokenBudget: 100_000, model: LEGACY_BYPASS_MODEL });
    expect(seat.status).toBe(200);
    expect(seat.body.model).toBe(LEGACY_BYPASS_MODEL);

    return campaignId;
  }

  // ── BEHAVIORAL: the driver runtime sends the RESOLVED model, not legacy seat.model ──
  it('#564 driver runtime: the audit records the resolved provider-config model, NEVER the legacy seat.model', async () => {
    // mock provider = no network, so a driver turn completes and meters/audits for real.
    const campaignId = await setupWithLegacySeatModel('mock', 'mock-allowed', ['mock-allowed']);

    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/message`).set(player).send({ input: 'go' });
    expect(res.status).toBe(201);

    const audit = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    const driverTurns = audit.body.filter((e: { action: string }) => e.action === 'ai-dm.driver.turn');
    expect(driverTurns.length).toBeGreaterThan(0);
    const detail = driverTurns[0].detail as string;
    // Acceptance criterion: audit shows the EXACT model sent (resolved + allowlisted).
    expect(detail).toContain('model=mock-allowed');
    // The legacy bypass label must NOT have been sent. Under the old code this audited
    // `model=${seat.model}`, so this assertion is the behavioral regression guard.
    expect(detail).not.toContain(LEGACY_BYPASS_MODEL);
  });

  it('#564 legacy takeTurn path (POST /ai-dm/turn): audit records the resolved model, not legacy seat.model', async () => {
    const campaignId = await setupWithLegacySeatModel('mock', 'mock-allowed-2', ['mock-allowed-2']);
    const res = await request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`).set(dm).send({ prompt: 'narrate the scene' });
    expect(res.status).toBe(201);

    const audit = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    const turn = audit.body.find((e: { action: string }) => e.action === 'ai-dm.turn');
    expect(turn).toBeDefined();
    expect((turn.detail as string).toLowerCase()).toContain('model=mock-allowed-2');
    expect(turn.detail as string).not.toContain(LEGACY_BYPASS_MODEL);
  });

  // ── Execution-time resolution derives from provider config (both families) ─────
  it('#564 OpenAI-compatible: resolveExecutionModel returns the allowlisted provider-config model, not seat.model', async () => {
    const campaignId = await setupWithLegacySeatModel('openai', 'gpt-4o-mini', ['gpt-4o-mini']);
    const svc = ctx.app.get(AiProviderConfigService);
    const resolved = await svc.resolveExecutionModel(campaignId);
    expect(resolved!.model).toBe('gpt-4o-mini');
    expect(resolved!.model).not.toBe(LEGACY_BYPASS_MODEL);
  });

  it('#564 Anthropic: resolveExecutionModel returns the allowlisted model (parity — same choke point)', async () => {
    const campaignId = await setupWithLegacySeatModel('anthropic', 'claude-3-5-sonnet', ['claude-3-5-sonnet']);
    const svc = ctx.app.get(AiProviderConfigService);
    const resolved = await svc.resolveExecutionModel(campaignId);
    expect(resolved!.model).toBe('claude-3-5-sonnet');
    expect(resolved!.model).not.toBe(LEGACY_BYPASS_MODEL);
  });

  // ── Execution-time revalidation after the admin tightens the allowlist ─────────
  it('#564 OpenAI: tightening the allowlist after a seat was configured rejects execution at resolution time', async () => {
    const campaignId = await setupWithLegacySeatModel('openai', 'gpt-4o', ['gpt-4o', 'gpt-4o-mini'], 'sk-allowlist-test-key-0002');
    const svc = ctx.app.get(AiProviderConfigService);
    expect((await svc.resolveExecutionModel(campaignId))!.model).toBe('gpt-4o'); // legal at config time

    // Admin removes 'gpt-4o' from the allowlist — a policy change AFTER the seat was set.
    const tightened = await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'openai', model: 'gpt-4o', apiKey: 'sk-allowlist-test-key-0003', allowedModels: ['gpt-4o-mini'] });
    expect(tightened.status).toBe(200);

    // The execution-time choke point now throws (before any fetch). This is the core of
    // #564: a once-legal config cannot keep running after the admin tightens policy.
    await expect(svc.resolveExecutionModel(campaignId)).rejects.toThrow(/allowlist/);
  });

  it('#564 Anthropic: tightening the allowlist rejects execution (parity with OpenAI)', async () => {
    const campaignId = await setupWithLegacySeatModel('anthropic', 'claude-3-5-sonnet', ['claude-3-5-sonnet'], 'sk-allowlist-test-key-0004');
    const svc = ctx.app.get(AiProviderConfigService);
    expect((await svc.resolveExecutionModel(campaignId))!.model).toBe('claude-3-5-sonnet');

    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'anthropic', model: 'claude-3-5-sonnet', apiKey: 'sk-allowlist-test-key-0005', allowedModels: ['claude-3-haiku'] });

    await expect(svc.resolveExecutionModel(campaignId)).rejects.toThrow(/allowlist/);
  });

  // ── A disallowed model cannot even be WRITTEN as a campaign override ───────────
  it('#564 a campaign override model outside the allowlist is rejected at write time (existing guard still holds)', async () => {
    const campaignId = await setupWithLegacySeatModel('mock', 'mock-allowed-3', ['mock-allowed-3']);
    const denied = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'mock', model: 'not-allowlisted' });
    expect(denied.status).toBe(400);
    expect(denied.text).toContain('allowlist');
  });
});

/**
 * MCP driver-tool path: the `ai_dm_narrate` MCP tool (the MCP equivalent of POST
 * /ai-dm/turn) must not let a legacy `seat.model` bypass the admin allowlist either.
 * The tool is a thin pass-through to AiDmService.takeTurn, so this is the same fix point
 * — but we drive it through the real MCP client (OAuth token + StreamableHTTP transport)
 * to satisfy the issue's "MCP test" acceptance criterion end to end.
 */
describe('ai-dm model allowlist — MCP ai_dm_narrate tool cannot bypass policy (issue #564, e2e)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let dmAgent: ReturnType<typeof request.agent>;
  let dmToken: string;
  const clients: Client[] = [];

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'aml-mcp-e2e', version: '0.0.1' });
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
    await dmAgent.post('/api/v1/auth/setup').send({ username: 'aml-mcp-dm', password: 'dm-password-1' });
    // The setup user is the server admin — turn the experimental flag on.
    await dmAgent.patch('/api/v1/settings').send({ experimentalAiDm: true });

    // writeScope: 'direct' explicit (issue #575 default is 'propose') — this
    // token drives ai_dm_narrate, which writes an ai-dm.turn audit row directly.
    const tokenRes = await dmAgent.post('/api/v1/tokens').send({ name: 'aml-mcp-dm-token', scope: 'dm', writeScope: 'direct' });
    expect(tokenRes.status).toBe(201);
    dmToken = tokenRes.body.token;
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await closeTestApp(ctx);
  });

  it('#564 MCP ai_dm_narrate: a legacy seat.model is NOT sent — the audit shows the resolved model', async () => {
    const campRes = await dmAgent.post('/api/v1/campaigns').send({ name: 'AML MCP Campaign' });
    const campaignId = campRes.body.id as number;

    // Server default: mock provider, allowlist of one. Campaign override uses that model.
    await dmAgent
      .put('/api/v1/settings/ai-provider')
      .send({ providerType: 'mock', model: 'mock-mcp', apiKey: 'sk-mcp-allowlist-0001', allowedModels: ['mock-mcp'] });
    await dmAgent.put(`/api/v1/campaigns/${campaignId}/ai-provider`).send({ providerType: 'mock', model: 'mock-mcp' });

    // The legacy `seat.model` is the bypass string — informational only after the fix.
    const seat = await dmAgent
      .put(`/api/v1/campaigns/${campaignId}/ai-dm`)
      .send({ mode: 'driver', enabled: true, tokenBudget: 100_000, model: LEGACY_BYPASS_MODEL });
    expect(seat.status).toBe(200);
    expect(seat.body.model).toBe(LEGACY_BYPASS_MODEL);

    // Drive a turn through the MCP ai_dm_narrate tool.
    const client = await mcpClient(dmToken);
    await client.callTool({ name: 'ai_dm_narrate', arguments: { campaignId, prompt: 'narrate the scene' } });

    // The audit for the MCP-driven turn (same ai-dm.turn action) records the RESOLVED model.
    const audit = await dmAgent.get(`/api/v1/campaigns/${campaignId}/audit`);
    const turn = audit.body.find((e: { action: string }) => e.action === 'ai-dm.turn');
    expect(turn).toBeDefined();
    expect(turn.detail as string).toContain('model=mock-mcp');
    expect(turn.detail as string).not.toContain(LEGACY_BYPASS_MODEL);
  });
});
