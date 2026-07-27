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
 *   - deleting the primary must not delete the fallback, and vice versa — those deletes were
 *     scope-only predicates before this change and would have taken both;
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

  it('deleting the PRIMARY leaves the fallback in place (and vice versa)', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', apiKey: 'sk-primary-0001' });
    await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'openai', model: 'fallback-model', apiKey: 'sk-fallback-0002' });

    // Both deletes were scope-only predicates before #1052 — this would have wiped the
    // operator's configured backup, key and all, from a button that says "delete the provider".
    await request(server).delete('/api/v1/settings/ai-provider').set(admin).expect(204);
    const remaining = rows().filter((r) => r.scope === 'server');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].role).toBe('fallback');
    const survivor = await request(server).get('/api/v1/settings/ai-provider/fallback').set(admin);
    expect(survivor.body.model).toBe('fallback-model');

    await request(server).delete('/api/v1/settings/ai-provider/fallback').set(admin).expect(204);
    expect(rows().filter((r) => r.scope === 'server')).toHaveLength(0);
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
 * #1052 review — A CAMPAIGN THAT NEEDS NO CREDENTIAL MUST NOT INHERIT ONE.
 *
 * Choosing `mock` is how someone says "no external calls": local development, a
 * privacy-sensitive table, or testing without spending tokens. The credential-inheritance
 * branches existed to answer "the DM configured an override but stored no key" — a question
 * that only arises when the DM's chosen provider NEEDS a key. `mock` needs none, so there was
 * nothing to inherit, and inheriting anyway swapped the provider, the endpoint and the key.
 *
 * The two layers already disagreed, and the VIEW was the one that was right:
 * `campaignCredentialSource` returns 'not-required' for a keyless provider BEFORE it ever
 * consults the server row, so the GET reported "mock, not-required" while resolution handed
 * back a credentialed external provider. That contradiction is what these tests assert —
 * the observable disagreement, not the branch that caused it.
 *
 * Asserted for BOTH ROLES on purpose. The inheritance lives in one role-agnostic function
 * (`resolveEffectiveConfigWithEndpointScope`), so a fix aimed only at the fallback slot would
 * leave the identical hole on the primary — and the primary half is not even new to #1052.
 */
describe('a keyless campaign provider never inherits a server credential (#1052 review)', () => {
  let ctx: TestAppContext;
  let server: ReturnType<TestAppContext['app']['getHttpServer']>;
  let configs: AiProviderConfigService;
  let campaignId: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer();
    configs = ctx.app.get(AiProviderConfigService);
    const camp = await request(server).post('/api/v1/campaigns').set(admin).send({ name: 'Keyless Inherit Guard' });
    campaignId = camp.body.id;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const SERVER_KEY = 'sk-server-should-never-be-inherited-9001';
  const SERVER_URL = 'https://server-owned.example/v1';

  it('FALLBACK: a mock campaign fallback is not replaced by the credentialed server fallback', async () => {
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', apiKey: 'sk-primary-0001' });
    // A credentialed SERVER fallback pointing at a real external endpoint...
    await request(server)
      .put('/api/v1/settings/ai-provider/fallback')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', baseUrl: SERVER_URL, apiKey: SERVER_KEY });
    // ...and a campaign that deliberately chose the offline mock for its fallback.
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider/fallback`)
      .set(admin)
      .send({ providerType: 'mock', model: 'primary-model' });

    const effective = await configs.resolveEffectiveConfig(campaignId, 'fallback');

    // The table's stated configuration is where its content actually goes. Before the fix this
    // came back as openai + the server URL + the server key, so a failed turn contacted an
    // external provider the DM had explicitly configured away from — on the failover path,
    // which is the path nobody watches.
    expect(effective?.providerType).toBe('mock');
    expect(effective?.apiKey).toBeUndefined();
    expect(effective?.baseUrl).not.toBe(SERVER_URL);
    expect(JSON.stringify(effective)).not.toContain(SERVER_KEY);

    // ...and the GET must agree with what resolution just did. This is the half that makes it a
    // TRUST defect rather than a config nicety: the view already said 'not-required'.
    const view = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider/fallback`).set(admin);
    expect(view.status).toBe(200);
    expect(view.body.providerType).toBe('mock');
    expect(view.body.credentialSource).toBe('not-required');
  });

  it('PRIMARY: the same inheritance path has the same hole one slot over', async () => {
    // Not introduced by #1052 — the branch is role-agnostic and predates the fallback slot.
    // Pinned here because a fix aimed only at the reported (fallback) symptom would leave it.
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', baseUrl: SERVER_URL, apiKey: SERVER_KEY });
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(admin)
      .send({ providerType: 'mock', model: 'primary-model' });

    const effective = await configs.resolveEffectiveConfig(campaignId);
    expect(effective?.providerType).toBe('mock');
    expect(effective?.apiKey).toBeUndefined();
    expect(effective?.baseUrl).not.toBe(SERVER_URL);
    expect(JSON.stringify(effective)).not.toContain(SERVER_KEY);

    const view = await request(server).get(`/api/v1/campaigns/${campaignId}/ai-provider`).set(admin);
    expect(view.status).toBe(200);
    expect(view.body.providerType).toBe('mock');
    expect(view.body.credentialSource).toBe('not-required');
  });

  it('a KEY-REQUIRING campaign override still inherits the server credential', async () => {
    // The guard must be narrow. Inheritance is the whole point of a keyless override for a
    // provider that DOES need a key — removing that would break the #373 design rather than
    // fix it. Only "needs no credential" short-circuits.
    await request(server)
      .put('/api/v1/settings/ai-provider')
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model', baseUrl: SERVER_URL, apiKey: SERVER_KEY });
    await request(server)
      .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
      .set(admin)
      .send({ providerType: 'openai', model: 'primary-model' });

    const effective = await configs.resolveEffectiveConfig(campaignId);
    expect(effective?.providerType).toBe('openai');
    expect(effective?.apiKey).toBe(SERVER_KEY);
    // ...and with the key comes the SERVER's endpoint, never the campaign's (#373).
    expect(effective?.baseUrl).toBe(SERVER_URL);
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
