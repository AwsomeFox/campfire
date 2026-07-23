import { BadRequestException, Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Role } from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { minRole, type RequestUser } from '../../common/user.types';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { RoleResolver } from '../membership/role-resolver.service';
import { OAuthService, OAUTH_SCOPES_SUPPORTED, narrowRoleToScope, roleScopeFromScope, type ClientRow } from './oauth.service';

/**
 * Absolute base URL of this server, used to build spec-required absolute
 * metadata URLs (issuer, endpoints, resource). Honors X-Forwarded-Proto/Host
 * (trust proxy is configured in main.ts) so it is correct behind Traefik, and
 * can be pinned explicitly via MCP_OAUTH_ISSUER for unusual deployments.
 */
function baseUrl(req: Request): string {
  const override = process.env.MCP_OAUTH_ISSUER?.trim();
  if (override) return override.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol;
  const host = req.get('host');
  return `${proto}://${host}`;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build a redirect back to the client with an OAuth error (used only for a valid, registered redirect_uri). */
function errorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

/**
 * RFC 9728 Protected Resource Metadata + RFC 8414 Authorization Server Metadata.
 * Served at the application root (outside the /api/v1 prefix — see the
 * setGlobalPrefix exclude list in main.ts / test-app.ts). MCP clients probe both
 * the bare well-known path and the `/mcp`-suffixed variant (RFC 9728 §3.1), so
 * we answer both.
 */
@ApiExcludeController()
@Controller()
export class OAuthMetadataController {
  @Public()
  @Get(['.well-known/oauth-protected-resource', '.well-known/oauth-protected-resource/mcp'])
  protectedResource(@Req() req: Request): Record<string, unknown> {
    const base = baseUrl(req);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
      bearer_methods_supported: ['header'],
      resource_name: 'Campfire MCP',
      resource_documentation: `${base}/api/docs`,
    };
  }

  @Public()
  @Get(['.well-known/oauth-authorization-server', '.well-known/oauth-authorization-server/mcp'])
  authorizationServer(@Req() req: Request): Record<string, unknown> {
    const base = baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256', 'plain'],
      scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
      service_documentation: `${base}/api/docs`,
    };
  }
}

interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

interface AuthorizeBody extends AuthorizeQuery {
  decision?: string;
  username?: string;
  password?: string;
  role?: string;
  campaign_id?: string;
}

interface TokenBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  resource?: string;
}

/**
 * OAuth 2.1 authorization-server endpoints for the MCP connector flow (issue
 * #37): Dynamic Client Registration, the human-facing authorize (login +
 * consent) page, the token endpoint (authorization_code + refresh_token grants,
 * PKCE-enforced) and revocation. All @Public and mounted at the root (see the
 * setGlobalPrefix exclude list). The PAT path on /mcp is unaffected.
 */
@ApiExcludeController()
@Controller('oauth')
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly auth: AuthService,
    private readonly roleResolver: RoleResolver,
  ) {}

  // ---------- RFC 7591 Dynamic Client Registration ----------

  @Public()
  @Post('register')
  async register(@Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.some((u) => typeof u !== 'string')) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris must be an array of strings' });
      return;
    }
    const registered = await this.oauth.registerClient({
      redirectUris: redirectUris as string[],
      clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
      grantTypes: Array.isArray(body.grant_types) ? (body.grant_types as string[]) : undefined,
      responseTypes: Array.isArray(body.response_types) ? (body.response_types as string[]) : undefined,
      tokenEndpointAuthMethod: typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : undefined,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
    });
    res.status(201).json({
      client_id: registered.clientId,
      ...(registered.clientSecret ? { client_secret: registered.clientSecret } : {}),
      client_id_issued_at: registered.clientIdIssuedAt,
      client_name: registered.clientName,
      redirect_uris: registered.redirectUris,
      grant_types: registered.grantTypes,
      response_types: registered.responseTypes,
      token_endpoint_auth_method: registered.tokenEndpointAuthMethod,
      ...(registered.scope ? { scope: registered.scope } : {}),
    });
  }

  // ---------- Authorization endpoint ----------

  @Public()
  @Get('authorize')
  async authorizeGet(@Query() query: AuthorizeQuery, @Req() req: Request, @Res() res: Response): Promise<void> {
    const validation = await this.validateAuthorizeParams(query);
    if (typeof validation === 'string') {
      res.status(400).type('html').send(this.errorPage(validation));
      return;
    }
    if ('redirectTo' in validation) {
      res.redirect(validation.redirectTo);
      return;
    }
    const { client } = validation;
    const sessionUser = await this.currentSessionUser(req);
    res.status(200).type('html').send(this.consentPage(query, client, sessionUser));
  }

  @Public()
  @Post('authorize')
  async authorizePost(@Body() body: AuthorizeBody, @Req() req: Request, @Res() res: Response): Promise<void> {
    const validation = await this.validateAuthorizeParams(body);
    if (typeof validation === 'string') {
      res.status(400).type('html').send(this.errorPage(validation));
      return;
    }
    if ('redirectTo' in validation) {
      res.redirect(validation.redirectTo);
      return;
    }
    const { client } = validation;
    const redirectUri = body.redirect_uri as string;
    const state = body.state;

    if (body.decision === 'deny') {
      res.redirect(errorRedirect(redirectUri, 'access_denied', 'The user denied the request', state));
      return;
    }

    // Resolve the acting user: an existing Campfire session (local OR OIDC login) first,
    // else a local username/password submitted on the consent form.
    let userId: number | null = null;
    let actingUser: RequestUser | null = await this.currentSessionUser(req);
    if (actingUser) {
      userId = Number(actingUser.id);
    } else if (body.username && body.password) {
      try {
        const row = await this.auth.verifyCredentials(body.username, body.password);
        userId = row.id;
        actingUser = { id: String(row.id), name: row.displayName || row.username, serverRole: row.serverRole as RequestUser['serverRole'] };
      } catch {
        res.status(401).type('html').send(this.consentPage(body, client, null, 'Invalid username or password.'));
        return;
      }
    }
    if (userId === null || actingUser === null) {
      res.status(401).type('html').send(this.consentPage(body, client, null, 'Please sign in to continue.'));
      return;
    }

    // Issue #680: the advertised scope enforces authority. The consent form's
    // role selector may only NARROW the requested scope further — never widen
    // past it. So scope=viewer with role=dm on the form yields a viewer-scoped
    // token, not a DM one. A request with no role scope ('mcp' only, or absent)
    // is capped at viewer (least privilege), matching the metadata contract.
    const role = narrowRoleToScope(this.parseRole(body.role), body.scope);
    let campaignId: number | null = null;
    if (body.campaign_id && body.campaign_id.trim() !== '') {
      const parsed = Number(body.campaign_id);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        res.status(400).type('html').send(this.consentPage(body, client, actingUser, 'Campaign id must be a positive integer.'));
        return;
      }
      // Verify the user actually has access to the campaign they want to bind the token to,
      // mirroring PAT minting (TokensService.create) — otherwise the binding is meaningless.
      const base = await this.roleResolver.baseEffectiveRole(actingUser, parsed);
      if (!base) {
        res.status(403).type('html').send(this.consentPage(body, client, actingUser, `You do not have access to campaign ${parsed}.`));
        return;
      }
      campaignId = parsed;
    }

    const code = await this.oauth.issueAuthorizationCode({
      clientId: client.clientId,
      userId,
      redirectUri,
      codeChallenge: body.code_challenge as string,
      codeChallengeMethod: (body.code_challenge_method as string) || 'S256',
      scope: body.scope ?? null,
      resource: body.resource ?? null,
      roleScope: role,
      campaignId,
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);
    res.redirect(redirect.toString());
  }

  // ---------- Token endpoint ----------

  @Public()
  @Post('token')
  async token(@Body() body: TokenBody, @Req() req: Request, @Res() res: Response): Promise<void> {
    const grantType = body.grant_type;
    // Client authentication: client_secret_basic (Authorization header) or client_secret_post (body).
    const basic = this.parseBasicAuth(req);
    const clientId = basic?.clientId ?? body.client_id;
    const clientSecret = basic?.clientSecret ?? body.client_secret;
    if (!clientId) {
      res.status(400).json({ error: 'invalid_request', error_description: 'client_id required' });
      return;
    }
    const client = await this.oauth.getClient(clientId);
    if (!client) {
      res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client' });
      return;
    }
    try {
      this.oauth.assertClientAuth(client, clientSecret);
    } catch {
      res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed' });
      return;
    }

    try {
      if (grantType === 'authorization_code') {
        if (!body.code) {
          res.status(400).json({ error: 'invalid_request', error_description: 'code required' });
          return;
        }
        const tokens = await this.oauth.exchangeAuthorizationCode({
          client,
          code: body.code,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri,
          resource: body.resource,
        });
        res.status(200).json(tokens);
        return;
      }
      if (grantType === 'refresh_token') {
        if (!body.refresh_token) {
          res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
          return;
        }
        const tokens = await this.oauth.exchangeRefreshToken({
          client,
          refreshToken: body.refresh_token,
          scope: body.scope,
          resource: body.resource,
        });
        res.status(200).json(tokens);
        return;
      }
      res.status(400).json({ error: 'unsupported_grant_type', error_description: `Unsupported grant_type: ${grantType}` });
    } catch (err) {
      const response = err instanceof BadRequestException ? err.getResponse() : { error: 'invalid_grant', error_description: 'Token request failed' };
      res.status(400).json(typeof response === 'object' ? response : { error: 'invalid_grant', error_description: String(response) });
    }
  }

  // ---------- RFC 7009 Revocation ----------

  @Public()
  @Post('revoke')
  async revoke(@Body() body: { token?: string }, @Res() res: Response): Promise<void> {
    if (body.token) {
      await this.oauth.revokeToken(body.token);
    }
    // RFC 7009: return 200 regardless of whether the token was recognized.
    res.status(200).json({});
  }

  // ---------- helpers ----------

  /**
   * Validates the shared authorize parameters. Returns:
   *  - a string  -> a hard error to render as an HTML page (redirect_uri/client
   *    are untrusted, so we MUST NOT redirect — OAuth 2.1 §4.1.2.1);
   *  - { redirectTo } -> a safe redirect back to the client carrying an OAuth error;
   *  - { client } -> validation passed, proceed.
   */
  private async validateAuthorizeParams(
    p: AuthorizeQuery,
  ): Promise<string | { redirectTo: string } | { client: ClientRow }> {
    if (!p.client_id) return 'Missing client_id.';
    const client = await this.oauth.getClient(p.client_id);
    if (!client) return 'Unknown client_id.';
    if (!p.redirect_uri) return 'Missing redirect_uri.';
    if (!this.oauth.clientAllowsRedirect(client, p.redirect_uri)) return 'redirect_uri is not registered for this client.';

    // From here the redirect_uri is trusted, so protocol errors go back to the client.
    if (p.response_type !== 'code') {
      return { redirectTo: errorRedirect(p.redirect_uri, 'unsupported_response_type', 'Only response_type=code is supported', p.state) };
    }
    if (!p.code_challenge) {
      return { redirectTo: errorRedirect(p.redirect_uri, 'invalid_request', 'code_challenge is required (PKCE)', p.state) };
    }
    const method = p.code_challenge_method || 'S256';
    if (method !== 'S256' && method !== 'plain') {
      return { redirectTo: errorRedirect(p.redirect_uri, 'invalid_request', 'Unsupported code_challenge_method', p.state) };
    }
    return { client };
  }

  private async currentSessionUser(req: Request): Promise<RequestUser | null> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const token = cookies?.[SESSION_COOKIE_NAME];
    if (!token) return null;
    const user = await this.auth.resolveSessionUser(token);
    // Only real, numeric-id users can be bound to a token (dev/header users never reach here).
    if (!user || !/^\d+$/.test(user.id)) return null;
    return user;
  }

  private parseRole(value: string | undefined): Role {
    const parsed = Role.safeParse(value);
    // Issue #680: least-privilege default. The advertised scope caps authority,
    // so an absent/invalid form value cannot fall through to 'dm' anymore —
    // it lands at viewer and can only be widened by an explicit scope request.
    return parsed.success ? parsed.data : 'viewer';
  }

  private parseBasicAuth(req: Request): { clientId: string; clientSecret: string } | null {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
    try {
      const decoded = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx < 0) return null;
      return {
        clientId: decodeURIComponent(decoded.slice(0, idx)),
        clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
      };
    } catch {
      return null;
    }
  }

  private errorPage(message: string): string {
    return this.htmlShell(
      'Authorization error',
      `<h1>Authorization error</h1><p class="err">${esc(message)}</p>
       <p class="muted">This request cannot be completed. You can close this window.</p>`,
    );
  }

  private consentPage(p: AuthorizeBody | AuthorizeQuery, client: ClientRow, sessionUser: RequestUser | null, error?: string): string {
    const clientName = client.clientName || client.clientId;
    const hidden = (name: keyof AuthorizeQuery) =>
      `<input type="hidden" name="${name}" value="${esc((p as Record<string, unknown>)[name] ?? '')}">`;
    const loginBlock = sessionUser
      ? `<p class="who">Signed in as <strong>${esc(sessionUser.name)}</strong>.</p>`
      : `<div class="field"><label>Username<input name="username" autocomplete="username" required></label></div>
         <div class="field"><label>Password<input name="password" type="password" autocomplete="current-password" required></label></div>`;
    const errBlock = error ? `<p class="err">${esc(error)}</p>` : '';
    // Issue #680: the advertised scope caps authority. The role selector offers
    // ONLY the roles at or below what the requested scope permits, defaulting
    // to that cap (the user may narrow further). A request with no role scope
    // ('mcp' only, or absent) lands at viewer — the form cannot widen past it.
    const scopeCap = roleScopeFromScope(p.scope);
    const roleOptions: Array<{ value: Role; label: string }> = [
      { value: 'dm', label: 'DM (full — capped by your membership)' },
      { value: 'player', label: 'Player' },
      { value: 'viewer', label: 'Viewer (read-only)' },
    ];
    const offered = roleOptions.filter((option) => minRole(option.value, scopeCap) === option.value);
    const roleBlock =
      offered.length > 1
        ? `<div class="field"><label>Role cap
           <select name="role">
             ${offered
               .map(
                 (option) =>
                   `<option value="${option.value}"${option.value === scopeCap ? ' selected' : ''}>${esc(option.label)}</option>`,
               )
               .join('')}
           </select></label>
           <p class="muted">The token can never exceed your own role in each campaign or the scope <code>${esc(p.scope || 'mcp')}</code> you granted; this only lowers it further.</p>
         </div>`
        : `<div class="field"><input type="hidden" name="role" value="${scopeCap}">
           <p class="muted">Role cap fixed at <strong>${esc(scopeCap)}</strong> by the requested scope <code>${esc(p.scope || 'mcp')}</code>. The token can never exceed your own role in each campaign.</p>
         </div>`;
    return this.htmlShell(
      'Connect to Campfire',
      `<h1>Connect to Campfire</h1>
       <p><strong>${esc(clientName)}</strong> is requesting access to your Campfire account over MCP.</p>
       ${errBlock}
       <form method="post" action="/oauth/authorize">
         ${hidden('response_type')}${hidden('client_id')}${hidden('redirect_uri')}${hidden('code_challenge')}
         ${hidden('code_challenge_method')}${hidden('state')}${hidden('scope')}${hidden('resource')}
         ${loginBlock}
         ${roleBlock}
         <div class="field"><label>Restrict to campaign id (optional)<input name="campaign_id" inputmode="numeric" placeholder="all campaigns"></label></div>
         <div class="actions">
           <button type="submit" name="decision" value="approve" class="primary">Approve</button>
           <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
         </div>
       </form>`,
    );
  }

  private htmlShell(title: string, inner: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1.2rem;line-height:1.5}
h1{font-size:1.3rem;margin:0 0 1rem}
.field{margin:.8rem 0}
label{display:block;font-weight:600;font-size:.9rem}
input,select{width:100%;padding:.5rem;margin-top:.3rem;font-size:1rem;box-sizing:border-box}
.muted{color:#888;font-size:.8rem;font-weight:400;margin:.3rem 0 0}
.who{background:#f3f3f3aa;padding:.6rem .8rem;border-radius:.4rem}
.err{color:#b00020;font-weight:600}
.actions{display:flex;gap:.6rem;margin-top:1.4rem}
button{padding:.6rem 1rem;font-size:1rem;border-radius:.4rem;border:1px solid #8884;cursor:pointer}
.primary{background:#b4531f;color:#fff;border-color:#b4531f}
.secondary{background:transparent}
</style></head><body>${inner}</body></html>`;
  }
}
