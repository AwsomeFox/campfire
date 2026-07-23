import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestAppNoDevAuth, closeTestApp, type TestAppContext } from './test-app';

/**
 * Issue #37 — MCP OAuth authorization flow (Campfire as a minimal OAuth 2.1 AS)
 * so /mcp can be added as a Claude connector. Exercises: the discovery metadata
 * (protected-resource + authorization-server), the WWW-Authenticate challenge,
 * Dynamic Client Registration, the full authorization_code + PKCE flow through a
 * login/consent page, using the issued bearer token on /mcp, refresh, revocation,
 * role/campaign caps, and that the static-PAT path is unaffected.
 */

interface TextContent {
  type: 'text';
  text: string;
}
function parseResult(result: unknown): unknown {
  return JSON.parse((result as { content: TextContent[] }).content[0].text);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

type PkceMethod = 'S256' | 'plain';

function pkceChallenge(verifier: string, method: PkceMethod): string {
  return method === 'S256' ? createHash('sha256').update(verifier).digest('base64url') : verifier;
}

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

describe('mcp oauth authorization flow (e2e)', () => {
  let ctx: TestAppContext;
  let baseUrl: string;
  let server: import('http').Server;
  let agent: ReturnType<typeof request.agent>;
  let campaignId: number;
  let patToken: string;
  const clients: Client[] = [];

  async function mcpClient(bearer: string): Promise<Client> {
    const client = new Client({ name: 'campfire-oauth-e2e', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  /** Register a public (PKCE) client via Dynamic Client Registration. */
  async function registerClient(): Promise<string> {
    const res = await request(server)
      .post('/oauth/register')
      .send({ client_name: 'Claude', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^cf_client_/);
    expect(res.body.client_secret).toBeUndefined(); // public client
    return res.body.client_id as string;
  }

  async function issueAuthorizationCode(clientId: string, challenge: string, method: PkceMethod): Promise<string> {
    const res = await agent.post('/oauth/authorize').type('form').send({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: method,
      decision: 'approve',
    });
    expect(res.status).toBe(302);
    const code = new URL(res.headers.location).searchParams.get('code');
    expect(code).toMatch(/^cf_oac_/);
    return code as string;
  }

  async function exchangeAuthorizationCode(clientId: string, code: string, verifier: string) {
    return request(server).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
  }

  /** Walk the authorize (consent) + token exchange, returning the token response. */
  async function runFlow(
    opts: { clientId: string; role?: string; campaignId?: string; scope?: string } = { clientId: '' },
  ): Promise<{
    access_token: string;
    refresh_token: string;
    verifier: string;
    clientId: string;
  }> {
    const clientId = opts.clientId;
    const { verifier, challenge } = pkce();
    const state = randomBytes(8).toString('hex');

    // GET the consent page (authenticated by the agent's session cookie).
    const getRes = await agent.get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: `${baseUrl}/mcp`,
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.text).toContain('Connect to Campfire');

    // POST approval.
    const postRes = await agent.post('/oauth/authorize').type('form').send({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: `${baseUrl}/mcp`,
      role: opts.role ?? 'dm',
      campaign_id: opts.campaignId ?? '',
      decision: 'approve',
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
    expect(postRes.status).toBe(302);
    const redirect = new URL(postRes.headers.location);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('state')).toBe(state);
    const code = redirect.searchParams.get('code');
    expect(code).toMatch(/^cf_oac_/);

    // Exchange the code for tokens.
    const tokenRes = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${baseUrl}/mcp`,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token_type).toBe('Bearer');
    expect(tokenRes.body.access_token).toMatch(/^cf_mcp_/);
    expect(tokenRes.body.refresh_token).toMatch(/^cf_ref_/);
    expect(tokenRes.body.expires_in).toBeGreaterThan(0);
    return { access_token: tokenRes.body.access_token, refresh_token: tokenRes.body.refresh_token, verifier, clientId };
  }

  beforeAll(async () => {
    ctx = await createTestAppNoDevAuth();
    await ctx.app.listen(0);
    server = ctx.app.getHttpServer();
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;

    agent = request.agent(server);
    // First user via setup -> server admin + session cookie on the agent.
    await agent.post('/api/v1/auth/setup').send({ username: 'oauth-dm', password: 'dm-password-1' });
    const campRes = await agent.post('/api/v1/campaigns').send({ name: 'OAuth Campaign' });
    campaignId = campRes.body.id;

    const patRes = await agent.post('/api/v1/tokens').send({ name: 'pat', scope: 'dm' });
    patToken = patRes.body.token;
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await closeTestApp(ctx);
  });

  // ---------- discovery metadata ----------

  it('serves RFC 9728 protected-resource metadata (bare + /mcp variant)', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await request(server).get(path);
      expect(res.status).toBe(200);
      expect(res.body.resource).toMatch(/\/mcp$/);
      expect(Array.isArray(res.body.authorization_servers)).toBe(true);
      expect(res.body.authorization_servers.length).toBe(1);
      expect(res.body.bearer_methods_supported).toContain('header');
      expect(res.body.scopes_supported).toEqual(expect.arrayContaining(['dm', 'player', 'viewer']));
    }
  });

  it('serves RFC 8414 authorization-server metadata (bare + /mcp variant)', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
      const res = await request(server).get(path);
      expect(res.status).toBe(200);
      expect(res.body.issuer).toBeTruthy();
      expect(res.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
      expect(res.body.token_endpoint).toMatch(/\/oauth\/token$/);
      expect(res.body.registration_endpoint).toMatch(/\/oauth\/register$/);
      expect(res.body.response_types_supported).toContain('code');
      expect(res.body.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
      expect(res.body.code_challenge_methods_supported).toContain('S256');
    }
  });

  it('unauthenticated /mcp returns 401 with a WWW-Authenticate challenge pointing at the metadata', async () => {
    const res = await request(server)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
  });

  // ---------- dynamic client registration ----------

  it('supports Dynamic Client Registration (RFC 7591) and rejects bad metadata', async () => {
    const clientId = await registerClient();
    expect(clientId).toMatch(/^cf_client_/);

    const bad = await request(server).post('/oauth/register').send({ client_name: 'x' }); // no redirect_uris
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_client_metadata');
  });

  // ---------- full authorization-code + PKCE flow ----------

  it('walks the full authorization_code + PKCE flow and the token works on /mcp', async () => {
    const clientId = await registerClient();
    const tokens = await runFlow({ clientId });

    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const result = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(result.isError).toBeFalsy();
    const summary = parseResult(result) as { campaign: { id: number } };
    expect(summary.campaign.id).toBe(campaignId);
  });

  describe.each(['S256', 'plain'] as const)('%s PKCE verification', (method) => {
    const pkceFailure = { error: 'invalid_grant', error_description: 'PKCE verification failed' };

    it('accepts a matching verifier', async () => {
      const clientId = await registerClient();
      const verifier = randomBytes(32).toString('base64url');
      const code = await issueAuthorizationCode(clientId, pkceChallenge(verifier, method), method);

      const res = await exchangeAuthorizationCode(clientId, code, verifier);

      expect(res.status).toBe(200);
      expect(res.body.access_token).toMatch(/^cf_mcp_/);
      expect(res.body.refresh_token).toMatch(/^cf_ref_/);
    });

    it('rejects an equal-length verifier mismatch with the OAuth error contract', async () => {
      const clientId = await registerClient();
      const verifier = randomBytes(32).toString('base64url');
      const code = await issueAuthorizationCode(clientId, pkceChallenge(verifier, method), method);
      const wrongVerifier = `${verifier[0] === 'A' ? 'B' : 'A'}${verifier.slice(1)}`;

      const res = await exchangeAuthorizationCode(clientId, code, wrongVerifier);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(pkceFailure);
    });

    it('rejects a byte-length mismatch without throwing or leaking comparison details', async () => {
      const clientId = await registerClient();
      const verifier = randomBytes(32).toString('base64url');
      const malformedChallenge = `${pkceChallenge(verifier, method)}x`;
      const code = await issueAuthorizationCode(clientId, malformedChallenge, method);

      const res = await exchangeAuthorizationCode(clientId, code, verifier);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(pkceFailure);
    });
  });

  it('an authorization code is single-use', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const post = await agent.post('/oauth/authorize').type('form').send({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      decision: 'approve',
    });
    const code = new URL(post.headers.location).searchParams.get('code');
    const first = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier,
    });
    expect(first.status).toBe(200);
    const second = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier,
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  // ---------- refresh ----------

  it('refresh_token grant rotates and issues a working access token', async () => {
    const clientId = await registerClient();
    const tokens = await runFlow({ clientId, campaignId: String(campaignId) });

    const refreshRes = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.access_token).toMatch(/^cf_mcp_/);
    expect(refreshRes.body.access_token).not.toBe(tokens.access_token);

    const client = await mcpClient(refreshRes.body.access_token);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    // Old refresh token is rotated out (no longer valid).
    const reuse = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body).toEqual({ error: 'invalid_grant', error_description: 'Refresh token not found' });

    // Reuse is treated as a compromised refresh family: the successful
    // successor is revoked too, and one token-free audit event is retained.
    const revokedDescendant = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${refreshRes.body.access_token}`)
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(revokedDescendant.status).toBe(401);

    const repeatedReplay = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId,
    });
    expect(repeatedReplay.status).toBe(400);
    expect(repeatedReplay.body).toEqual({ error: 'invalid_grant', error_description: 'Refresh token not found' });

    const audit = await agent.get(`/api/v1/campaigns/${campaignId}/audit?limit=200`);
    const replays = audit.body.filter((row: { action: string }) => row.action === 'oauth.refresh_replay');
    expect(replays).toHaveLength(1);
    expect(replays[0]).toMatchObject({
      actor: `oauth:${clientId}`,
      entityType: 'oauth_token',
      campaignId,
    });
    expect(replays[0].detail).not.toContain(tokens.refresh_token);
    expect(replays[0].detail).not.toContain(refreshRes.body.refresh_token);
  });

  it('a different client cannot claim a refresh token or prevent its rightful rotation', async () => {
    const clientId = await registerClient();
    const otherClientId = await registerClient();
    const tokens = await runFlow({ clientId });

    const wrongClient = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: otherClientId,
    });
    expect(wrongClient.status).toBe(400);
    expect(wrongClient.body).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token was issued to a different client',
    });

    const rightfulClient = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId,
    });
    expect(rightfulClient.status).toBe(200);
    expect(rightfulClient.body.refresh_token).toMatch(/^cf_ref_/);
  });

  // ---------- role / campaign caps ----------

  it('a viewer-scoped OAuth token caps writes (403) but allows reads', async () => {
    const clientId = await registerClient();
    const tokens = await runFlow({ clientId, role: 'viewer' });
    const client = await mcpClient(tokens.access_token);

    const read = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(read.isError).toBeFalsy();

    const write = await client.callTool({ name: 'create_quest', arguments: { campaignId, title: 'nope', body: 'nope' } });
    expect(write.isError).toBe(true);
    const err = parseResult(write) as { error: { status: number } };
    expect(err.error.status).toBe(403);
  });

  // ---------- OAuth scope enforces authority (#680) ----------
  //
  // The advertised scope (what the user consents to) must be the single source
  // of truth for the token's authority. The consent form's role selector may
  // only NARROW the requested scope further — never widen past it. Before #680
  // a request for scope=viewer with role=dm (the form default) yielded a token
  // that REPORTED viewer while carrying DM authority.

  it('the consent form role selector is capped by the requested scope (#680)', async () => {
    const clientId = await registerClient();
    const viewerPkce = pkce();
    const dmPkce = pkce();

    // Request viewer scope; the consent page must NOT offer dm/player.
    const page = await agent.get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: viewerPkce.challenge,
      code_challenge_method: 'S256',
      scope: 'viewer',
    });
    expect(page.status).toBe(200);
    expect(page.text).toContain('Role cap fixed at');
    expect(page.text).toContain('viewer');
    expect(page.text).not.toContain('value="dm"');
    expect(page.text).not.toContain('value="player"');

    // Request dm scope; the consent page must offer all three with dm selected.
    const dmPage = await agent.get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: dmPkce.challenge,
      code_challenge_method: 'S256',
      scope: 'dm',
    });
    expect(dmPage.status).toBe(200);
    expect(dmPage.text).toContain('<option value="dm" selected>');
    expect(dmPage.text).toContain('<option value="player">');
    expect(dmPage.text).toContain('<option value="viewer">');
  });

  it('scope=viewer caps authority even when the consent form posts role=dm (#680 regression)', async () => {
    const clientId = await registerClient();
    // The classic privilege mismatch: request viewer scope, post role=dm.
    // The resulting token MUST be viewer-capped, not DM-capped.
    const tokens = await runFlow({ clientId, scope: 'viewer', role: 'dm' });
    const client = await mcpClient(tokens.access_token);

    const read = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(read.isError).toBeFalsy();

    const write = await client.callTool({ name: 'create_quest', arguments: { campaignId, title: 'nope', body: 'nope' } });
    expect(write.isError).toBe(true);
    const err = parseResult(write) as { error: { status: number } };
    expect(err.error.status).toBe(403);
  });

  it('scope=player caps authority even when the consent form posts role=dm (#680)', async () => {
    const clientId = await registerClient();
    const tokens = await runFlow({ clientId, scope: 'player', role: 'dm' });
    const client = await mcpClient(tokens.access_token);

    // Player can read.
    const read = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(read.isError).toBeFalsy();

    // Player cannot do DM-only writes (create_quest is DM-only).
    const write = await client.callTool({ name: 'create_quest', arguments: { campaignId, title: 'nope', body: 'nope' } });
    expect(write.isError).toBe(true);
    const err = parseResult(write) as { error: { status: number } };
    expect(err.error.status).toBe(403);
  });

  it('scope=dm grants DM authority (the role selector and scope agree)', async () => {
    const clientId = await registerClient();
    const tokens = await runFlow({ clientId, scope: 'dm', role: 'dm' });
    const client = await mcpClient(tokens.access_token);

    // DM can write canon directly.
    const write = await client.callTool({ name: 'create_quest', arguments: { campaignId, title: '#680 dm quest', body: 'body' } });
    expect(write.isError).toBeFalsy();
  });

  it('mcp-only scope (no role scope) defaults to viewer authority, not DM (#680)', async () => {
    const clientId = await registerClient();
    // 'mcp' alone grants MCP access, not campaign authority — the token must
    // land at viewer, the least-privilege default. Previously the role-less
    // path fell through to the 'dm' form default and produced a DM token.
    const tokens = await runFlow({ clientId, scope: 'mcp' });
    const client = await mcpClient(tokens.access_token);

    const read = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(read.isError).toBeFalsy();

    const write = await client.callTool({ name: 'create_quest', arguments: { campaignId, title: 'nope', body: 'nope' } });
    expect(write.isError).toBe(true);
    const err = parseResult(write) as { error: { status: number } };
    expect(err.error.status).toBe(403);
  });

  it('the granted scope is echoed in the token response', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const state = randomBytes(8).toString('hex');
    const scope = 'mcp viewer';

    const postRes = await agent.post('/oauth/authorize').type('form').send({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope,
      decision: 'approve',
    });
    expect(postRes.status).toBe(302);
    const code = new URL(postRes.headers.location).searchParams.get('code');

    const tokenRes = await request(server).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.scope).toBe(scope);
  });

  it('binding a token to a campaign the user cannot access is rejected on the consent form', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await agent.post('/oauth/authorize').type('form').send({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      campaign_id: '99999',
      decision: 'approve',
    });
    expect(res.status).toBe(403);
    expect(res.text).toContain('do not have access');
  });

  // ---------- denial + invalid client / redirect ----------

  it('denial redirects back with error=access_denied', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const state = 'deny-state';
    const res = await agent.post('/oauth/authorize').type('form').send({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      decision: 'deny',
    });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe(state);
  });

  it('an unregistered redirect_uri is refused with an HTML error (no open redirect)', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await agent.get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://evil.example.com/steal',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('redirect_uri is not registered');
  });

  it('an unknown client_id is refused', async () => {
    const { challenge } = pkce();
    const res = await agent.get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'cf_client_deadbeef',
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Unknown client_id');
  });

  // ---------- revocation ----------

  it('revokes an access token so it no longer authenticates on /mcp', async () => {
    const clientId = await registerClient();
    const tokens = await runFlow({ clientId });

    // works first
    const ok = await mcpClient(tokens.access_token);
    expect((await ok.listTools()).tools.length).toBeGreaterThan(0);

    const rev = await request(server).post('/oauth/revoke').type('form').send({ token: tokens.access_token });
    expect(rev.status).toBe(200);

    const res = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
  });

  // ---------- PAT path unaffected ----------

  it('the static-PAT path still works on /mcp', async () => {
    const client = await mcpClient(patToken);
    const result = await client.callTool({ name: 'get_campaign_summary', arguments: { campaignId } });
    expect(result.isError).toBeFalsy();
  });
});
