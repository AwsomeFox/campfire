import request from 'supertest';
import Database from 'better-sqlite3';
import { Logger } from '@nestjs/common';
import { createTestApp, closeTestApp, createTestAppNoDevAuth, type TestAppContext } from './test-app';
import { dbFilePath } from '../src/db/db.module';
import { AiProviderConfigService } from '../src/modules/ai-provider-config/ai-provider-config.service';
import {
  AI_PROVIDER_RESOLVER,
  resolveFallbackForExecution,
  type AiProviderResolver,
} from '../src/modules/ai-driver/ai-provider-resolver';

/**
 * #1052 — the OPTIONAL fallback provider slot.
 *
 * The fallback is a SECOND, fully independent provider config at the same scope, stored as its
 * own row keyed on (scope, role). The properties worth pinning are the ones a shared-row or
 * shared-key design would have broken:
 *
 *   - configuring a fallback must not disturb the primary (they are separate rows, and the
 *     pre-#1052 partial uniques allowed only one row per scope);
 *   - deleting the primary takes the fallback WITH it, so no stored credential outlives the
 *     action an admin performs to destroy it — while deleting the fallback leaves the primary
 *     alone, because the dependency runs one way (#1052 review);
 *   - a fallback carries its OWN key and endpoint, because #373's invariant is that whoever
 *     owns the key owns the destination;
 *   - the admin model allowlist applies to the fallback, so "configure a fallback" is not a
 *     way to route around it;
 *   - the key is as write-only here as anywhere else.
 */

const admin = { 'x-dev-role': 'dm', 'x-dev-user': 'fallback-admin' };

describe('AI provider fallback slot (#1052)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  /** Raw rows, read through a plain handle so drizzle's own predicates cannot mask a bug. */
  function rows(): Array<Record<string, unknown>> {
    const db = new Database(dbFilePath(ctx.dataDir), { readonly: true });
    try {
      return db.prepare('SELECT * FROM ai_provider_configs ORDER BY id').all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  }

  async function reset(): Promise<void> {
    await request(server).delete('/api/v1/settings/ai-provider/fallback').set(admin);
    await request(server).delete('/api/v1/settings/ai-provider').set(admin);
  }

  beforeEach(reset);

  it('defaults to no fallback — failover is opt-in', async () => {
    const res = await request(server).get('/api/v1/settings/ai-provider/fallback').set(admin);
    expect(res.status).toBe(200);
    expect(res.body?.model).toBeUndefined();
    expect(rows()).toHaveLength(0);
  });

  it('stores the fallback as a SEPARATE row and leaves the primary untouched', async () => {
    const primary = await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', apiKey: 'sk-primary-0001' });
    expect(primary.status).toBe(200);

    const fallback = await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'anthropic', model: 'fallback-model', apiKey: 'sk-fallback-0002' });
    expect(fallback.status).toBe(200);
    expect(fallback.body.model).toBe('fallback-model');
    expect(fallback.body.providerType).toBe('anthropic');

    // Two rows at the server scope. Before #1052 the partial unique on `scope` made this
    // impossible; the index is now keyed on (scope, role).
    const stored = rows().filter((r) => r.scope === 'server');
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.role).sort()).toEqual(['fallback', 'primary']);

    // Independent credentials + endpoints. A fallback sharing the primary's key would send
    // that key wherever the fallback row points, which is exactly the #373 exfiltration.
    const [a, b] = stored;
    expect(a.encrypted_api_key).not.toEqual(b.encrypted_api_key);

    // The primary is exactly as it was.
    const readback = await request(server).get('/api/v1/settings/ai-provider').set(admin);
    expect(readback.body).toMatchObject({ model: 'primary-model', providerType: 'openai' });
  });

  it('never returns the fallback API key, only the masked indicator', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'openai', model: 'm', apiKey: 'sk-secret-value-9999' });

    const res = await request(server).get('/api/v1/settings/ai-provider/fallback').set(admin);
    expect(JSON.stringify(res.body)).not.toContain('sk-secret-value-9999');
    expect(res.body.configured).toBe(true);
    expect(res.body.keyLast4).toBe('9999');
  });

  /**
   * #1052 review — DELETING A PROVIDER DESTROYS ITS FALLBACK'S CREDENTIAL TOO.
   *
   * This asserted the OPPOSITE first ("deleting the PRIMARY leaves the fallback in place"), on
   * the reasoning that a delete should not silently wipe a configured backup. Reversed
   * deliberately: the CONTRACT changed, not just the assertion.
   *
   * A fallback with no primary is not a backup — resolution reads the primary first and gives up
   * when there is none, so the survivor serves no turn and answers no health probe. It preserves
   * no capability. What it does preserve is a stored, encrypted API key that outlived the one
   * action an admin takes in order to destroy it: invisibly, since this release ships no fallback
   * UI, and re-armed the moment anyone re-creates a primary.
   */
  it('deleting the PRIMARY also deletes the fallback, so no credential outlives the delete', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', apiKey: 'sk-primary-0001' });
    await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'openai', model: 'fallback-model', apiKey: 'sk-fallback-0002' });

    await request(server).delete('/api/v1/settings/ai-provider').set(admin).expect(204);

    // No row of either role survives, and with it no stored key. Asserted on the DURABLE rows
    // rather than only through the GET: a read that merely stopped reporting the fallback would
    // leave the ciphertext in the database for a backup or an export to carry off later.
    expect(rows().filter((r) => r.scope === 'server')).toHaveLength(0);
    expect(rows().some((r) => r.encryptedApiKey)).toBe(false);
  });

  it('deleting the FALLBACK leaves the primary alone — the dependency runs one way', async () => {
    // The asymmetry is the point. A fallback depends on a primary for its meaning; a primary
    // does not depend on a fallback, so removing the backup must never disarm the table.
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', apiKey: 'sk-primary-0001' });
    await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'openai', model: 'fallback-model', apiKey: 'sk-fallback-0002' });

    await request(server).delete('/api/v1/settings/ai-provider/fallback').set(admin).expect(204);

    const remaining = rows().filter((r) => r.scope === 'server');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].role).toBe('primary');
    const survivor = await request(server).get('/api/v1/settings/ai-provider').set(admin);
    expect(survivor.body.model).toBe('primary-model');
  });

  it('enforces the admin model allowlist on the fallback', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'allowed-1', apiKey: 'sk-primary-0001', allowedModels: ['allowed-1'] });

    // A fallback serves real turns, so exempting it would make "configure a fallback" a
    // one-step route around the allowlist AND the base-URL host policy.
    const rejected = await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'openai', model: 'not-on-the-list', apiKey: 'sk-fallback-0002' });
    expect(rejected.status).toBe(400);

    const accepted = await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'openai', model: 'allowed-1', apiKey: 'sk-fallback-0002' });
    expect(accepted.status).toBe(200);
  });

  it('a fallback row does not change which provider the PRIMARY resolution picks', async () => {
    // `serverRow()`/`campaignRow()` are `.limit(1)` with no ORDER BY, so a missing role filter
    // would return an arbitrary one of the two rows and silently swap the table's provider on
    // some fraction of turns. Asserted through the public effective-config read.
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', apiKey: 'sk-primary-0001' });
    await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'anthropic', model: 'fallback-model', apiKey: 'sk-fallback-0002' });

    for (let i = 0; i < 5; i++) {
      const res = await request(server).get('/api/v1/settings/ai-provider').set(admin);
      expect(res.body.model).toBe('primary-model');
      expect(res.body.providerType).toBe('openai');
    }
  });

  /**
   * #1052 review — an UNUSABLE fallback resolves to NO fallback, and says so.
   *
   * The reported concern was that a keyless fallback for a key-requiring provider costs every
   * failing turn one doomed extra attempt. It does not, and the reason is worth pinning so a
   * later refactor cannot make it true: `createAiProvider` calls `requireKey` at CONSTRUCTION,
   * so the failure lands while the turn is still deciding whether it has a fallback at all —
   * before any provider object exists, and therefore before any request could be sent. No
   * socket is opened and no timeout is waited out.
   *
   * What this pins is the OUTCOME (`null`, i.e. "no fallback"), not the mechanism, so it holds
   * whether the key check stays in the factory or moves earlier. The `logs` half is separate
   * and is the actual fix: resolving to null must not be SILENT, because a fallback appears
   * nowhere in the admin `testAll` readout (which probes role='primary' only), leaving the log
   * as the operator's only signal that the fallback they configured is not in play.
   */
  it('a KEYLESS fallback for a key-requiring provider resolves to NO fallback, and warns', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', apiKey: 'sk-primary-0001' });
    // A fallback row naming a key-requiring provider but carrying no credential. There is no
    // server fallback row to inherit from, and inheriting the server PRIMARY's key is exactly
    // what #373 forbids — so nothing can supply one.
    await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'anthropic', model: 'fallback-model' });

    const resolver = ctx.app.get<AiProviderResolver>(AI_PROVIDER_RESOLVER);
    const logs: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((msg: unknown) => void logs.push(String(msg)));
    let resolved: unknown;
    try {
      resolved = await resolveFallbackForExecution(resolver, 0);
    } finally {
      spy.mockRestore();
    }

    // No fallback — so the retry loop never schedules an attempt against it, and a turn that
    // exhausts the primary fails with the PRIMARY's error rather than a spurious auth error
    // from a provider the table was never really configured to use.
    expect(resolved).toBeNull();
    // ...and the operator can find out. A bare `catch { return null }` swallowed this, under a
    // comment claiming the service below had already logged — true for a blocked host or a
    // disallowed model, and NOT true for a missing key, whose throw comes from the factory,
    // outside that service's try/catch.
    expect(logs.some((l) => /fallback/i.test(l))).toBe(true);
  });
});

/**
 * #1052 review — THE VIEW MUST NAME THE CREDENTIAL THE TURN WILL ACTUALLY RUN ON.
 *
 * Reported as "a campaign fallback set to `mock` is replaced by the credentialed server
 * fallback". The replacement is real, and it is DELIBERATE: a keyless campaign override is a
 * model-only override (#373), whose providerType and baseUrl are discarded in favour of
 * whoever owns the key.
 *
 * Exempting keyless provider types from that was tried and reverted. It re-introduces the
 * DM-controlled `providerType` into the endpoint decision that #373 removed it from, and it
 * breaks the #501 provenance contract that `scribe` and `co-dm` assert independently:
 * `endpointScope` must report where the request REALLY went, and the exemption made it report
 * the configuration's scope instead of the execution's.
 *
 * So the defect was never that the turn runs on the server's provider. It was that the GET
 * said `not-required` while it did — `campaignCredentialSource` answered "needs no credential"
 * before it ever consulted the server row, showing the DM the reassuring half of a
 * disagreement. These tests pin the OBSERVABLE agreement between the two layers, which is the
 * property that was actually broken.
 *
 * Both roles, because the view helper serves both slots.
 */
describe('a keyless campaign override reports the credential it will really use (#1052 review)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let configs: AiProviderConfigService;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    configs = ctx.app.get(AiProviderConfigService);
    const camp = await request(server).post('/api/v1/campaigns').set(admin).send({ name: 'Keyless View Truth' });
    campaignId = camp.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const SERVER_KEY = 'sk-server-actually-used-9001';
  const SERVER_URL = 'https://server-owned.example/v1';

  it('PRIMARY: a mock override over a keyed server row reports `server`, not `not-required`', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', baseUrl: SERVER_URL, apiKey: SERVER_KEY });
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(admin)
      .send({ providerType: 'mock', model: 'primary-model' });

    // What actually runs: the server's provider, on the server's key and endpoint (#373).
    const effective = await configs.resolveEffectiveConfig(campaignId);
    expect(effective?.providerType).toBe('openai');
    expect(effective?.apiKey).toBe(SERVER_KEY);
    expect(effective?.baseUrl).toBe(SERVER_URL);

    // ...and the view must say so. `not-required` here was the lie: it told a DM who chose an
    // offline provider that nothing external was involved, while the turn went to a vendor.
    const view = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider`).set(admin);
    expect(view.status).toBe(200);
    expect(view.body.credentialSource).toBe('server');
    expect(view.body.credentialSource).not.toBe('not-required');
    // The key itself still never leaves the server.
    expect(JSON.stringify(view.body)).not.toContain(SERVER_KEY);
  });

  it('FALLBACK: the same agreement holds one slot over', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', baseUrl: SERVER_URL, apiKey: SERVER_KEY });
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider/fallback`)
      .set(admin)
      .send({ providerType: 'mock', model: 'primary-model' });

    const effective = await configs.resolveEffectiveConfig(campaignId, 'fallback');
    expect(effective?.apiKey).toBe(SERVER_KEY);

    const view = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider/fallback`).set(admin);
    expect(view.status).toBe(200);
    expect(view.body.credentialSource).toBe('server');
  });

  it('still reports `not-required` when there is genuinely nothing to inherit', async () => {
    // The guard must stay narrow: with no server row, the campaign's own keyless provider IS
    // what runs, and `not-required` is then the truthful answer rather than a reassuring one.
    await request(server).delete('/api/v1/settings/ai-provider/fallback').set(admin);
    await request(server).delete('/api/v1/settings/ai-provider').set(admin);
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(admin)
      .send({ providerType: 'mock', model: 'primary-model' });

    const effective = await configs.resolveEffectiveConfig(campaignId);
    expect(effective?.providerType).toBe('mock');
    expect(effective?.apiKey).toBeUndefined();

    const view = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider`).set(admin);
    expect(view.body.credentialSource).toBe('not-required');
  });
});

/**
 * Admin gating for the fallback routes, with REAL auth rather than the dev-auth header
 * shortcut — under dev auth every identity satisfies the server-role guard, so an ACL
 * assertion made there would pass no matter what the decorator said.
 */
describe('AI provider fallback slot is admin-gated (#1052, no dev auth)', () => {
  let ctx: TestAppContext;
  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    const server = ctx.app.getHttpServer();
    adminAgent = request.agent(server);
    await adminAgent.post('/api/v1/auth/setup').send({ username: 'fb-admin', password: 'admin-password-1' });
    await adminAgent
      .post('/api/v1/users')
      .send({ username: 'fb-user', password: 'user-password-1', serverRole: 'user' });
    userAgent = request.agent(server);
    await userAgent.post('/api/v1/auth/login').send({ username: 'fb-user', password: 'user-password-1' });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('an admin may configure the fallback; a non-admin user is 403 on every verb', async () => {
    const ok = await adminAgent
      .put('/api/v1/settings/ai-provider/fallback')
      .send({ providerType: 'mock', model: 'mock-model' });
    expect(ok.status).toBe(200);

    expect((await userAgent.get('/api/v1/settings/ai-provider/fallback')).status).toBe(403);
    expect(
      (await userAgent.put('/api/v1/settings/ai-provider/fallback').send({ providerType: 'mock', model: 'm' })).status,
    ).toBe(403);
    expect((await userAgent.delete('/api/v1/settings/ai-provider/fallback')).status).toBe(403);
  });
});
