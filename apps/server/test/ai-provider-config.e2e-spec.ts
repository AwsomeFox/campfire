import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestApp, closeTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';
import { dbFilePath } from '../src/db/db.module';
import { AiProviderConfigService } from '../src/modules/ai-provider-config/ai-provider-config.service';
import { startFakeAiProvider, type FakeAiProvider } from './fake-ai-provider';

/**
 * Encrypted API-key & provider config storage (issue #310).
 *
 * Verifies: the API key is stored ENCRYPTED (never plaintext in the DB), reads are
 * masked (configured + keyLast4, never the key), the per-campaign override falls
 * back to the server default, the effective config decrypts round-trip server-side
 * (feeding #309's factory), rotation/clear, the admin model allowlist, and auth
 * gating (admin for the server default, DM for the per-campaign override).
 */
const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'aipc-dm' };
const player = { 'x-dev-role': 'player', 'x-dev-user': 'aipc-player' };

const SERVER_KEY = 'sk-server-SUPERSECRET-0001';
const CAMPAIGN_KEY = 'sk-campaign-SUPERSECRET-9999';

const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeAll(() => {
  // The ordinary provider tests must not depend on the machine running Jest.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(() => {
  restoreEnv('OPENAI_API_KEY', ORIGINAL_OPENAI_API_KEY);
  restoreEnv('ANTHROPIC_API_KEY', ORIGINAL_ANTHROPIC_API_KEY);
});

describe('ai-provider-config (e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'AI Provider Campaign' });
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /** Read every stored value straight from the SQLite file (bypasses the API). */
  function rawRows(): Array<Record<string, unknown>> {
    const sqlite = new Database(dbFilePath(ctx.dataDir), { readonly: true });
    try {
      return sqlite.prepare('SELECT * FROM ai_provider_configs').all() as Array<Record<string, unknown>>;
    } finally {
      sqlite.close();
    }
  }

  it('GET server default is null before anything is configured', async () => {
    const res = await request(server).get('/api/v1/settings/ai-provider').set(dm);
    expect(res.status).toBe(200);
    // null serializes to an empty body over HTTP — "unset" means no config fields.
    expect(res.body.scope).toBeUndefined();
    expect(res.body.configured).toBeUndefined();
  });

  it('admin sets the server default with an API key — response is masked, never the key', async () => {
    const res = await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'openai', model: 'gpt-4o-mini', apiKey: SERVER_KEY, params: { temperature: 0.5 } });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('server');
    expect(res.body.providerType).toBe('openai');
    expect(res.body.model).toBe('gpt-4o-mini');
    expect(res.body.configured).toBe(true);
    expect(res.body.keyLast4).toBe('0001');
    // The key is NEVER present in any response field.
    expect(res.body).not.toHaveProperty('apiKey');
    expect(JSON.stringify(res.body)).not.toContain(SERVER_KEY);
  });

  it('the key is stored ENCRYPTED at rest — plaintext never touches the DB', () => {
    const rows = rawRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.scope).toBe('server');
    // No column holds the plaintext key.
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(value).not.toContain(SERVER_KEY);
    }
    // The ciphertext is the versioned aes-256-gcm envelope; last4 is the only leak.
    expect(String(row.encrypted_api_key)).toMatch(/^gcm\.v1\./);
    expect(row.key_last4).toBe('0001');
  });

  it('GET server default returns the masked view (no key)', async () => {
    const res = await request(server).get('/api/v1/settings/ai-provider').set(dm);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.keyLast4).toBe('0001');
    expect(JSON.stringify(res.body)).not.toContain(SERVER_KEY);
  });

  it('effective config decrypts round-trip server-side and feeds the factory shape', async () => {
    const svc = ctx.app.get(AiProviderConfigService);
    const eff = await svc.resolveEffectiveConfig(campaignId);
    expect(eff).not.toBeNull();
    // No campaign override yet — the effective config IS the server default,
    // including the DECRYPTED key (server-side only; never serialized to a client).
    expect(eff!.providerType).toBe('openai');
    expect(eff!.model).toBe('gpt-4o-mini');
    expect(eff!.apiKey).toBe(SERVER_KEY);
  });

  it('per-campaign override falls back to the server key when it supplies none', async () => {
    // DM sets an override that changes the model but provides NO key of its own.
    const put = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'openai', model: 'gpt-4o' });
    expect(put.status).toBe(200);
    expect(put.body.scope).toBe('campaign');
    expect(put.body.configured).toBe(false); // no key of its own
    expect(put.body.keyLast4).toBeNull();

    const svc = ctx.app.get(AiProviderConfigService);
    const eff = await svc.resolveEffectiveConfig(campaignId);
    expect(eff!.model).toBe('gpt-4o'); // override wins for the model
    expect(eff!.apiKey).toBe(SERVER_KEY); // falls back to the server default key
  });

  it('per-campaign override can carry its own key (masked in reads, encrypted at rest)', async () => {
    const put = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'anthropic', model: 'claude-3-5-sonnet', apiKey: CAMPAIGN_KEY });
    expect(put.status).toBe(200);
    expect(put.body.configured).toBe(true);
    expect(put.body.keyLast4).toBe('9999');
    expect(JSON.stringify(put.body)).not.toContain(CAMPAIGN_KEY);

    // Encrypted at rest — no plaintext anywhere in the campaign row.
    const campRow = rawRows().find((r) => r.scope === 'campaign')!;
    for (const value of Object.values(campRow)) {
      if (typeof value === 'string') expect(value).not.toContain(CAMPAIGN_KEY);
    }
    expect(String(campRow.encrypted_api_key)).toMatch(/^gcm\.v1\./);

    const svc = ctx.app.get(AiProviderConfigService);
    const eff = await svc.resolveEffectiveConfig(campaignId);
    expect(eff!.providerType).toBe('anthropic');
    expect(eff!.apiKey).toBe(CAMPAIGN_KEY); // its own key now takes precedence
  });

  it('key rotation and clear are reflected in keyLast4 / configured', async () => {
    const rotate = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'anthropic', model: 'claude-3-5-sonnet', apiKey: 'sk-rotated-key-abcd' });
    expect(rotate.body.keyLast4).toBe('abcd');

    // Omitting apiKey keeps the stored key.
    const keep = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'anthropic', model: 'claude-3-5-haiku' });
    expect(keep.body.configured).toBe(true);
    expect(keep.body.keyLast4).toBe('abcd');

    // Empty string clears it.
    const clear = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'anthropic', model: 'claude-3-5-haiku', apiKey: '' });
    expect(clear.body.configured).toBe(false);
    expect(clear.body.keyLast4).toBeNull();
  });

  it('test-connection through a mock provider succeeds and never echoes a credential', async () => {
    // Point the server default at the mock provider (no network, no key needed).
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-model' });
    const res = await request(server)
      .post('/api/v1/settings/ai-provider/test')
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-model', apiKey: '' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.scope).toBe('server');
    expect(res.body.model).toBe('mock-model');
  });

  it('enforces the server admin model allowlist for campaign overrides', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-model', allowedModels: ['mock-model', 'gpt-4o'] });

    const denied = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'mock', model: 'disallowed-model' });
    expect(denied.status).toBe(400);

    const allowed = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'mock', model: 'gpt-4o' });
    expect(allowed.status).toBe(200);
  });

  it('DELETE removes each scope', async () => {
    const delCamp = await request(server).delete(`/api/v1/campaigns/${campaignId}/ai-provider`).set(dm);
    expect(delCamp.status).toBe(204);
    const getCamp = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider`).set(dm);
    expect(getCamp.body.scope).toBeUndefined();

    const delServer = await request(server).delete('/api/v1/settings/ai-provider').set(dm);
    expect(delServer.status).toBe(204);
    const getServer = await request(server).get('/api/v1/settings/ai-provider').set(dm);
    expect(getServer.body.scope).toBeUndefined();
  });

  it('the plaintext key never appears in the audit log', async () => {
    // Reconfigure so there is a fresh audit trail, then scan the campaign audit.
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'openai', model: 'gpt-4o', apiKey: SERVER_KEY });
    const audit = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).not.toContain(SERVER_KEY);
  });

  it('a campaign player (non-DM) cannot read or write the campaign override', async () => {
    const read = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider`).set(player);
    expect(read.status).toBe(403);
    const write = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(player)
      .send({ providerType: 'openai', model: 'gpt-4o' });
    expect(write.status).toBe(403);
    const clear = await request(server)
      .delete(`/api/v1/campaigns/${campaignId}/ai-provider/key`)
      .set(player);
    expect(clear.status).toBe(403);
    const test = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-provider/test`)
      .set(player)
      .send({ providerType: 'mock', model: 'mock-model', apiKey: '' });
    expect(test.status).toBe(403);
  });
});

/**
 * Issue #852: draft tests run through the real Nest app + real SQLite database and
 * an in-process fake OpenAI-compatible provider. This proves the wire target and
 * credential choice without touching a live vendor or persisting the candidate.
 */
describe('ai-provider-config visible draft connection tests (issue #852, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;
  let fake: FakeAiProvider;

  beforeAll(async () => {
    fake = await startFakeAiProvider();
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Draft Test Campaign' });
    campaignId = camp.body.id;
  });

  beforeEach(async () => {
    fake.calls.length = 0;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await request(server).delete(`/api/v1/campaigns/${campaignId}/ai-provider`).set(dm);
    await request(server).delete('/api/v1/settings/ai-provider').set(dm);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    await fake.close();
  });

  function persistedRows(): Array<Record<string, unknown>> {
    const sqlite = new Database(dbFilePath(ctx.dataDir), { readonly: true });
    try {
      return sqlite.prepare('SELECT * FROM ai_provider_configs ORDER BY id').all() as Array<Record<string, unknown>>;
    } finally {
      sqlite.close();
    }
  }

  it('tests a first-time server draft and candidate key without persisting or echoing it', async () => {
    const candidateKey = 'sk-first-time-candidate-never-return-8521';
    const res = await request(server)
      .post('/api/v1/settings/ai-provider/test')
      .set(dm)
      .send({
        providerType: 'openai',
        model: 'unsaved-first-model',
        baseUrl: fake.baseUrl,
        apiKey: candidateKey,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      scope: 'server',
      testedTarget: 'server-default',
      providerType: 'openai',
      model: 'unsaved-first-model',
      baseUrl: fake.baseUrl,
      credentialSource: 'candidate',
      error: null,
    });
    expect(Date.parse(res.body.testedAt)).not.toBeNaN();
    expect(JSON.stringify(res.body)).not.toContain(candidateKey);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      url: '/v1/chat/completions',
      authorization: `Bearer ${candidateKey}`,
      body: { model: 'unsaved-first-model' },
    });
    expect(persistedRows()).toHaveLength(0);
  });

  it('rejects unknown fields and unsafe/incomplete candidates through the strict DTO', async () => {
    const unknown = await request(server)
      .post('/api/v1/settings/ai-provider/test')
      .set(dm)
      .send({ providerType: 'mock', model: 'mock-model', apiKey: '', surprise: true });
    expect(unknown.status).toBe(400);

    const unsafe = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-provider/test`)
      .set(dm)
      .send({ providerType: 'openai', model: 'draft-model', baseUrl: 'https://user:pass@attacker.example' });
    expect(unsafe.status).toBe(400);

    const missingModel = await request(server)
      .post('/api/v1/settings/ai-provider/test')
      .set(dm)
      .send({ providerType: 'mock', apiKey: '' });
    expect(missingModel.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    expect(persistedRows()).toHaveLength(0);
  });

  it('tests unsaved server edits, candidate key rotation, then blank-key stored reuse while preserving the row', async () => {
    const storedKey = 'sk-stored-server-8522';
    const rotatedCandidate = 'sk-unsaved-rotation-8523';
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'openai', model: 'persisted-model', baseUrl: fake.baseUrl, apiKey: storedKey });

    const rotated = await request(server)
      .post('/api/v1/settings/ai-provider/test')
      .set(dm)
      .send({ providerType: 'openai', model: 'unsaved-rotated-model', baseUrl: fake.baseUrl, apiKey: rotatedCandidate });
    expect(rotated.body).toMatchObject({
      ok: true,
      model: 'unsaved-rotated-model',
      credentialSource: 'candidate',
    });
    expect(fake.calls[0].authorization).toBe(`Bearer ${rotatedCandidate}`);

    const reused = await request(server)
      .post('/api/v1/settings/ai-provider/test')
      .set(dm)
      .send({ providerType: 'openai', model: 'unsaved-blank-key-model', baseUrl: fake.baseUrl, apiKey: '' });
    expect(reused.body).toMatchObject({
      ok: true,
      model: 'unsaved-blank-key-model',
      credentialSource: 'stored',
    });
    expect(fake.calls[1].authorization).toBe(`Bearer ${storedKey}`);

    const persisted = await request(server).get('/api/v1/settings/ai-provider').set(dm);
    expect(persisted.body).toMatchObject({ model: 'persisted-model', keyLast4: '8522' });
    expect(persistedRows()).toHaveLength(1);
    expect(JSON.stringify(persisted.body)).not.toContain(rotatedCandidate);
  });

  it('distinguishes a campaign candidate key from blank-key inherited server targeting', async () => {
    const serverKey = 'sk-inherited-server-8524';
    const campaignCandidateKey = 'sk-campaign-candidate-8525';
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'openai', model: 'server-model', baseUrl: fake.baseUrl, apiKey: serverKey });

    const own = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-provider/test`)
      .set(dm)
      .send({
        providerType: 'openai',
        model: 'campaign-own-draft',
        baseUrl: fake.baseUrl,
        apiKey: campaignCandidateKey,
      });
    expect(own.body).toMatchObject({
      ok: true,
      scope: 'campaign',
      testedTarget: 'campaign-override',
      providerType: 'openai',
      model: 'campaign-own-draft',
      baseUrl: fake.baseUrl,
      credentialSource: 'candidate',
    });
    expect(fake.calls[0].authorization).toBe(`Bearer ${campaignCandidateKey}`);

    const inherited = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-provider/test`)
      .set(dm)
      .send({
        providerType: 'anthropic',
        model: 'campaign-inherited-draft',
        baseUrl: 'https://campaign-controlled.example',
        apiKey: '',
      });
    expect(inherited.body).toMatchObject({
      ok: true,
      scope: 'campaign',
      testedTarget: 'inherited-server-default',
      providerType: 'openai',
      model: 'campaign-inherited-draft',
      baseUrl: fake.baseUrl,
      credentialSource: 'server',
    });
    expect(inherited.body.baseUrl).not.toBe('https://campaign-controlled.example');
    expect(fake.calls[1].authorization).toBe(`Bearer ${serverKey}`);
    expect(fake.calls[1].body.model).toBe('campaign-inherited-draft');
    expect(persistedRows()).toHaveLength(1); // server row only; neither campaign draft persisted
  });

  it('labels a stored server key as inherited when probing a campaign without a draft body', async () => {
    const serverKey = 'sk-inherited-stored-health-8528';
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'openai', model: 'server-health-model', baseUrl: fake.baseUrl, apiKey: serverKey });

    // The admin health sweep exercises the stored/effective path directly rather
    // than the draft-only HTTP DTO. From a campaign scope, a server-owned key
    // must be described as inherited instead of stored locally.
    const inherited = await ctx.app.get(AiProviderConfigService).testConnection(campaignId);

    expect(inherited).toMatchObject({
      ok: true,
      scope: 'campaign',
      testedTarget: 'inherited-server-default',
      credentialSource: 'server',
      providerType: 'openai',
      model: 'server-health-model',
      baseUrl: fake.baseUrl,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].authorization).toBe(`Bearer ${serverKey}`);
    expect(persistedRows()).toHaveLength(1);
  });

  it('reuses a campaign-stored key for a blank draft and redacts provider text that echoes a candidate key', async () => {
    const storedCampaignKey = 'sk-campaign-stored-8526';
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'openai', model: 'saved-campaign-model', baseUrl: fake.baseUrl, apiKey: storedCampaignKey });

    const reused = await request(server)
      .post(`/api/v1/campaigns/${campaignId}/ai-provider/test`)
      .set(dm)
      .send({ providerType: 'openai', model: 'unsaved-campaign-model', baseUrl: fake.baseUrl, apiKey: '' });
    expect(reused.body).toMatchObject({
      ok: true,
      testedTarget: 'campaign-override',
      credentialSource: 'stored',
      model: 'unsaved-campaign-model',
    });
    expect(fake.calls[0].authorization).toBe(`Bearer ${storedCampaignKey}`);

    const echoedCandidate = 'sk-provider-echo-must-redact-8527';
    fake.failNext(401, JSON.stringify({ error: `bad credential ${echoedCandidate}` }));
    const failed = await request(server)
      .post('/api/v1/settings/ai-provider/test')
      .set(dm)
      .send({ providerType: 'openai', model: 'failing-draft', baseUrl: fake.baseUrl, apiKey: echoedCandidate });
    expect(failed.status).toBe(201);
    expect(failed.body.ok).toBe(false);
    expect(failed.body.error).toContain('[REDACTED]');
    expect(JSON.stringify(failed.body)).not.toContain(echoedCandidate);
    expect(JSON.stringify(failed.body)).not.toContain(storedCampaignKey);
  });
});

/**
 * Effective-provider indicator (issue #399): a DM-safe, NON-secret read that tells the
 * campaign AI settings which provider is in effect and whether it's the server default or
 * a campaign override. It must never carry key material, and must be DM-gated.
 */
describe('ai-provider-config effective indicator (issue #399, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Effective Indicator Campaign' });
    campaignId = campRes.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('reports configured:false when neither scope is set', async () => {
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider/effective`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: false,
      providerType: null,
      model: null,
      source: null,
      credentialSource: 'none',
      ready: false,
    });
  });

  it('reports the SERVER default as the source when only the server default is set', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'openai', model: 'gpt-4o-mini', apiKey: SERVER_KEY });
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider/effective`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: true,
      providerType: 'openai',
      model: 'gpt-4o-mini',
      source: 'server',
      credentialSource: 'stored',
      ready: true,
    });
    // NEVER any key material.
    expect(JSON.stringify(res.body)).not.toContain(SERVER_KEY);
    expect(res.body).not.toHaveProperty('keyLast4');
    expect(res.body).not.toHaveProperty('apiKey');
  });

  it('reports a CAMPAIGN override as the source once one exists (no key needed)', async () => {
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'anthropic', model: 'claude-3-5-sonnet' });
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider/effective`).set(dm);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: true,
      // The keyless campaign override borrows the credential-owning server
      // provider + endpoint (issue #373), while retaining its model choice.
      providerType: 'openai',
      model: 'claude-3-5-sonnet',
      source: 'campaign',
      credentialSource: 'server',
      ready: true,
    });
  });

  it('is DM-gated — a campaign player (non-DM) is 403', async () => {
    const res = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider/effective`).set(player);
    expect(res.status).toBe(403);
  });
});

/**
 * Issue #445: key revocation is a dedicated operation, not a replay of the full
 * provider form. It must preserve every non-secret setting, produce a secret-free
 * audit entry, and immediately expose standard vendor environment fallback.
 */
describe('ai-provider-config explicit stored-key clear (issue #445, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const camp = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Credential Fallback Campaign' });
    campaignId = camp.body.id;
  });

  afterAll(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await closeTestApp(ctx);
  });

  it('stores then clears an OpenAI-compatible key, retaining config and falling back to OPENAI_API_KEY', async () => {
    const storedKey = 'sk-openai-stored-never-return-4451';
    const environmentKey = 'sk-openai-environment-never-return-4452';
    process.env.OPENAI_API_KEY = environmentKey;

    const put = await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({
        providerType: 'openai',
        model: 'gpt-4.1-mini',
        baseUrl: 'https://openai-compatible.example/v1',
        params: { temperature: 0.35, maxTokens: 4321 },
        allowedModels: ['gpt-4.1-mini'],
        apiKey: storedKey,
      });
    expect(put.status).toBe(200);
    expect(put.body.credentialSource).toBe('stored');
    expect(put.body.ready).toBe(true);

    const cleared = await request(server).delete('/api/v1/settings/ai-provider/key').set(dm);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      providerType: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://openai-compatible.example/v1',
      params: { temperature: 0.35, maxTokens: 4321 },
      allowedModels: ['gpt-4.1-mini'],
      configured: false,
      keyLast4: null,
      credentialSource: 'environment',
      ready: true,
    });
    expect(JSON.stringify(cleared.body)).not.toContain(storedKey);
    expect(JSON.stringify(cleared.body)).not.toContain(environmentKey);

    const sqlite = new Database(dbFilePath(ctx.dataDir), { readonly: true });
    const row = sqlite.prepare("SELECT * FROM ai_provider_configs WHERE scope = 'server'").get() as Record<string, unknown>;
    sqlite.close();
    expect(row.encrypted_api_key).toBeNull();
    expect(row.key_last4).toBeNull();
    expect(row.model).toBe('gpt-4.1-mini');
    expect(row.base_url).toBe('https://openai-compatible.example/v1');
    expect(row.params).toBe(JSON.stringify({ temperature: 0.35, maxTokens: 4321 }));

    const effective = await ctx.app.get(AiProviderConfigService).resolveEffectiveConfig(campaignId);
    expect(effective).toMatchObject({
      providerType: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: environmentKey,
      baseUrl: 'https://openai-compatible.example/v1',
      params: { temperature: 0.35, maxTokens: 4321 },
    });

    const audit = await request(server).get('/api/v1/admin/audit').set(dm);
    const clearEntry = audit.body.find((entry: { action: string }) => entry.action === 'ai-provider.key-clear');
    expect(clearEntry).toMatchObject({ entityType: 'ai-provider', detail: 'server' });
    expect(JSON.stringify(clearEntry)).not.toContain(storedKey);
    expect(JSON.stringify(clearEntry)).not.toContain('4451');
    delete process.env.OPENAI_API_KEY;
  });

  it('stores then clears an Anthropic key and falls back to ANTHROPIC_API_KEY', async () => {
    const storedKey = 'sk-ant-stored-never-return-4453';
    const environmentKey = 'sk-ant-environment-never-return-4454';
    process.env.ANTHROPIC_API_KEY = environmentKey;

    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({
        providerType: 'anthropic',
        model: 'claude-sonnet-4-5',
        baseUrl: 'https://anthropic-compatible.example',
        params: { temperature: 0.2, maxTokens: 2048 },
        apiKey: storedKey,
      });
    const cleared = await request(server).delete('/api/v1/settings/ai-provider/key').set(dm);

    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      providerType: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://anthropic-compatible.example',
      params: { temperature: 0.2, maxTokens: 2048 },
      configured: false,
      keyLast4: null,
      credentialSource: 'environment',
      ready: true,
    });
    const effective = await ctx.app.get(AiProviderConfigService).resolveEffectiveConfig(campaignId);
    expect(effective?.apiKey).toBe(environmentKey);
    expect(effective?.providerType).toBe('anthropic');
    expect(JSON.stringify(cleared.body)).not.toContain(storedKey);
    expect(JSON.stringify(cleared.body)).not.toContain(environmentKey);
    delete process.env.ANTHROPIC_API_KEY;

    const unavailable = await request(server).get('/api/v1/settings/ai-provider').set(dm);
    expect(unavailable.body).toMatchObject({
      configured: false,
      credentialSource: 'none',
      ready: false,
    });
  });

  it('clears a campaign key without changing the override and inherits the environment-backed server credential', async () => {
    process.env.OPENAI_API_KEY = 'sk-server-env-campaign-fallback-4455';
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({
        providerType: 'openai',
        model: 'gpt-4.1-mini',
        baseUrl: 'https://server.example/v1',
        apiKey: '',
        allowedModels: [],
      });
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({
        providerType: 'anthropic',
        model: 'campaign-model',
        baseUrl: 'https://campaign.example',
        params: { temperature: 0.7, maxTokens: 3000 },
        apiKey: 'sk-campaign-stored-4456',
      });

    const cleared = await request(server)
      .delete(`/api/v1/campaigns/${campaignId}/ai-provider/key`)
      .set(dm);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      providerType: 'anthropic',
      model: 'campaign-model',
      baseUrl: 'https://campaign.example',
      params: { temperature: 0.7, maxTokens: 3000 },
      configured: false,
      credentialSource: 'environment',
      ready: true,
    });

    const effective = await ctx.app.get(AiProviderConfigService).resolveEffectiveConfig(campaignId);
    expect(effective).toMatchObject({
      providerType: 'openai',
      model: 'campaign-model',
      apiKey: 'sk-server-env-campaign-fallback-4455',
      baseUrl: 'https://server.example/v1',
      params: { temperature: 0.7, maxTokens: 3000 },
    });
    const audit = await request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    expect(audit.body.some((entry: { action: string; detail: string }) =>
      entry.action === 'ai-provider.key-clear' && entry.detail === 'campaign')).toBe(true);
    expect(JSON.stringify(audit.body)).not.toContain('sk-campaign-stored-4456');
    expect(JSON.stringify(audit.body)).not.toContain('4456');
    delete process.env.OPENAI_API_KEY;
  });
});

/**
 * Regression: the server default's API key must NEVER be shipped to a campaign-controlled
 * destination (issue #373). A DM who creates a campaign can set a per-campaign override with
 * a foreign `baseUrl`/`providerType` and NO key of its own; the resolver must not pair the
 * server key with the campaign's endpoint/type. Key + endpoint + providerType are resolved as
 * one coherent unit from the scope that owns the key.
 */
describe('ai-provider-config key-exfiltration guard (issue #373, e2e)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let campaignId: number;

  const SERVER_BASE = 'https://api.openai.com/v1';
  const ATTACKER_BASE = 'https://attacker.example';

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    const campRes = await request(server).post('/api/v1/campaigns').set(dm).send({ name: 'Exfil Guard Campaign' });
    campaignId = campRes.body.id;
    // Server admin default: openai, own key, own trusted endpoint.
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(dm)
      .send({ providerType: 'openai', model: 'gpt-4o-mini', apiKey: SERVER_KEY, baseUrl: SERVER_BASE });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('a keyless campaign override with a foreign baseUrl does NOT get the server key sent there', async () => {
    // DM sets an override pointing at an attacker host, with NO key of its own.
    const put = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'openai', model: 'gpt-4o', baseUrl: ATTACKER_BASE });
    expect(put.status).toBe(200);
    expect(put.body.configured).toBe(false); // no key of its own

    const svc = ctx.app.get(AiProviderConfigService);
    const eff = await svc.resolveEffectiveConfig(campaignId);
    // The server key may still be reused (same-vendor model pick) — but ONLY with the
    // SERVER's endpoint. It must NEVER be paired with the campaign-controlled URL.
    expect(eff!.apiKey).toBe(SERVER_KEY);
    expect(eff!.baseUrl).toBe(SERVER_BASE);
    expect(eff!.baseUrl).not.toBe(ATTACKER_BASE);
    expect(eff!.model).toBe('gpt-4o'); // model override still honored (not a destination)
  });

  it('a keyless campaign override CANNOT redirect the server key to a different providerType/host', async () => {
    // Switch the override to anthropic (different auth header + host) with a foreign baseUrl, still no key.
    const put = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'anthropic', model: 'gpt-4o', baseUrl: ATTACKER_BASE });
    expect(put.status).toBe(200);

    const svc = ctx.app.get(AiProviderConfigService);
    const eff = await svc.resolveEffectiveConfig(campaignId);
    // providerType + baseUrl are bound to the SERVER (the key's owner), never the campaign row.
    expect(eff!.apiKey).toBe(SERVER_KEY);
    expect(eff!.providerType).toBe('openai');
    expect(eff!.baseUrl).toBe(SERVER_BASE);
    expect(eff!.baseUrl).not.toBe(ATTACKER_BASE);
  });

  it('a campaign override that brings its OWN key keeps its own endpoint (legitimate path still works)', async () => {
    const CAMP_KEY = 'sk-campaign-own-key-7777';
    const CAMP_BASE = 'https://campaign-own-proxy.example/v1';
    const put = await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(dm)
      .send({ providerType: 'openai', model: 'gpt-4o', apiKey: CAMP_KEY, baseUrl: CAMP_BASE });
    expect(put.status).toBe(200);
    expect(put.body.configured).toBe(true);

    const svc = ctx.app.get(AiProviderConfigService);
    const eff = await svc.resolveEffectiveConfig(campaignId);
    // Its OWN key with its OWN endpoint is coherent and allowed — the server key is not involved.
    expect(eff!.apiKey).toBe(CAMP_KEY);
    expect(eff!.apiKey).not.toBe(SERVER_KEY);
    expect(eff!.baseUrl).toBe(CAMP_BASE);
  });

  it('rejects a baseUrl with a non-http(s) scheme or embedded credentials (defense-in-depth)', async () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@attacker.example']) {
      const res = await request(server)
        .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
        .set(dm)
        .send({ providerType: 'openai', model: 'gpt-4o', baseUrl: bad });
      expect(res.status).toBe(400);
    }
  });
});

/**
 * Server-default endpoints are server-admin gated. All dev-auth users are admin, so
 * the non-admin 403 needs a real cookie-session (no-dev-auth) non-admin user.
 */
describe('ai-provider-config server default is admin-gated (e2e, no dev auth)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'aipc-admin', password: 'admin-password-1' });
    await adminAgent.post('/api/v1/users').send({ username: 'aipc-user', password: 'user-password-1', serverRole: 'user' });
    userAgent = request.agent(server);
    await userAgent.post('/api/v1/auth/login').send({ username: 'aipc-user', password: 'user-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('admin can write the server default; a non-admin user is 403', async () => {
    const server = ctx.app.getHttpServer();
    const ok = await adminAgent
      .put('/api/v1/settings/ai-provider')
      .send({ providerType: 'mock', model: 'mock-model' });
    expect(ok.status).toBe(200);

    const denied = await userAgent
      .put('/api/v1/settings/ai-provider')
      .send({ providerType: 'mock', model: 'mock-model' });
    expect(denied.status).toBe(403);

    const deniedGet = await userAgent.get('/api/v1/settings/ai-provider');
    expect(deniedGet.status).toBe(403);

    const deniedClear = await userAgent.delete('/api/v1/settings/ai-provider/key');
    expect(deniedClear.status).toBe(403);

    const deniedTest = await userAgent
      .post('/api/v1/settings/ai-provider/test')
      .send({ providerType: 'mock', model: 'unsaved-model', apiKey: '' });
    expect(deniedTest.status).toBe(403);

    // Sanity: the endpoint is actually mounted for the admin.
    const adminGet = await request(server).get('/api/v1/settings/ai-provider').set({});
    expect([401, 403]).toContain(adminGet.status); // unauthenticated is rejected too
  });
});

function restoreEnv(name: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
