import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq, lt } from 'drizzle-orm';
import { Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { oauthClients, oauthAuthCodes, oauthAccessTokens, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import {
  generateAuthorizationCode,
  generateOAuthAccessToken,
  generateOAuthClientId,
  generateOAuthClientSecret,
  generateOAuthRefreshToken,
  hashOpaqueToken,
  pkceS256Challenge,
} from '../../common/crypto';
import type { RequestUser, TokenContext } from '../../common/user.types';

/** Authorization code lifetime — short, per OAuth 2.1 (single-use, redeemed seconds later). */
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
/** Access-token lifetime. Kept modest; connectors refresh transparently via the refresh token. */
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Refresh-token lifetime — long-lived so a connector stays linked without re-consent. */
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const OAUTH_SCOPES_SUPPORTED = ['mcp', 'dm', 'player', 'viewer'] as const;

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string | null;
  clientIdIssuedAt: number;
}

export interface ClientRow {
  clientId: string;
  secretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string | null;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface IssueCodeInput {
  clientId: string;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  resource: string | null;
  roleScope: Role;
  campaignId: number | null;
}

export interface ResolvedOAuthToken {
  user: RequestUser;
  tokenContext: TokenContext;
}

/**
 * Minimal OAuth 2.1 authorization server (issue #37) letting Campfire's `/mcp`
 * endpoint be added as a Claude connector without a hand-copied PAT.
 *
 * Campfire is BOTH the authorization server and the resource server here. The
 * flow is standard AuthZ-code + PKCE (S256), with Dynamic Client Registration
 * (RFC 7591) so a client like Claude can self-register. The actual human
 * authentication happens on GET/POST /oauth/authorize, which reuses Campfire's
 * own login (a session cookie — from local OR OIDC login — or a local
 * username/password check). The issued access token maps onto the SAME
 * RequestUser + TokenContext model as a PAT, so every effective-role cap
 * (min(scope, membership), single-campaign binding) is enforced downstream with
 * zero new authorization logic — see resolveAccessToken().
 */
@Injectable()
export class OAuthService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  // ---------- Dynamic Client Registration (RFC 7591) ----------

  async registerClient(input: {
    redirectUris: string[];
    clientName?: string;
    grantTypes?: string[];
    responseTypes?: string[];
    tokenEndpointAuthMethod?: string;
    scope?: string;
  }): Promise<RegisteredClient> {
    if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
      throw new BadRequestException({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    }
    for (const uri of input.redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new BadRequestException({ error: 'invalid_redirect_uri', error_description: `Invalid redirect_uri: ${uri}` });
      }
      if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:') {
        throw new BadRequestException({ error: 'invalid_redirect_uri', error_description: 'Disallowed redirect_uri scheme' });
      }
    }

    const authMethod = input.tokenEndpointAuthMethod ?? 'none';
    const grantTypes = input.grantTypes && input.grantTypes.length > 0 ? input.grantTypes : ['authorization_code', 'refresh_token'];
    const responseTypes = input.responseTypes && input.responseTypes.length > 0 ? input.responseTypes : ['code'];

    // Only confidential clients get a secret; public (PKCE) clients — like Claude — do not.
    const clientId = generateOAuthClientId();
    let clientSecret: string | undefined;
    let secretHash: string | null = null;
    if (authMethod !== 'none') {
      clientSecret = generateOAuthClientSecret();
      secretHash = hashOpaqueToken(clientSecret);
    }

    const ts = nowIso();
    await this.db.insert(oauthClients).values({
      clientId,
      secretHash,
      clientName: input.clientName ?? '',
      redirectUris: JSON.stringify(input.redirectUris),
      grantTypes: JSON.stringify(grantTypes),
      responseTypes: JSON.stringify(responseTypes),
      tokenEndpointAuthMethod: authMethod,
      scope: input.scope ?? null,
      createdAt: ts,
    });

    return {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      clientName: input.clientName ?? '',
      redirectUris: input.redirectUris,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod: authMethod,
      scope: input.scope ?? null,
      clientIdIssuedAt: Math.floor(Date.parse(ts) / 1000),
    };
  }

  async getClient(clientId: string): Promise<ClientRow | null> {
    const [row] = await this.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
    if (!row) return null;
    return {
      clientId: row.clientId,
      secretHash: row.secretHash,
      clientName: row.clientName,
      redirectUris: JSON.parse(row.redirectUris) as string[],
      grantTypes: JSON.parse(row.grantTypes) as string[],
      responseTypes: JSON.parse(row.responseTypes) as string[],
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
      scope: row.scope,
    };
  }

  // ---------- Authorization endpoint ----------

  /** Issues a single-use authorization code bound to the consenting user + PKCE challenge. Returns the raw code. */
  async issueAuthorizationCode(input: IssueCodeInput): Promise<string> {
    const code = generateAuthorizationCode();
    const ts = nowIso();
    await this.db.insert(oauthAuthCodes).values({
      codeHash: hashOpaqueToken(code),
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      scope: input.scope,
      resource: input.resource,
      roleScope: input.roleScope,
      campaignId: input.campaignId,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
      createdAt: ts,
    });
    return code;
  }

  // ---------- Token endpoint ----------

  /**
   * grant_type=authorization_code. Validates the code (unexpired, matching
   * client + redirect_uri), enforces PKCE (S256 or plain), then issues an
   * access + refresh token pair. The code is single-use — deleted on redemption.
   */
  async exchangeAuthorizationCode(input: {
    client: ClientRow;
    code: string;
    codeVerifier?: string;
    redirectUri?: string;
    resource?: string;
  }): Promise<OAuthTokenResponse> {
    const [row] = await this.db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.codeHash, hashOpaqueToken(input.code))).limit(1);
    if (!row) {
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'Authorization code not found' });
    }
    // Single-use: consume it up front so a replay can never redeem twice, even on a later validation failure.
    await this.db.delete(oauthAuthCodes).where(eq(oauthAuthCodes.id, row.id));

    if (row.clientId !== input.client.clientId) {
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'Authorization code was issued to a different client' });
    }
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'Authorization code expired' });
    }
    if (input.redirectUri !== undefined && input.redirectUri !== row.redirectUri) {
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // PKCE (RFC 7636): mandatory — every code captured a challenge.
    if (!input.codeVerifier) {
      throw new BadRequestException({ error: 'invalid_request', error_description: 'code_verifier required' });
    }
    const expected = row.codeChallengeMethod === 'plain' ? input.codeVerifier : pkceS256Challenge(input.codeVerifier);
    if (expected !== row.codeChallenge) {
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    return this.issueTokenPair({
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
      resource: input.resource ?? row.resource,
      roleScope: this.parseRole(row.roleScope),
      campaignId: row.campaignId,
    });
  }

  /**
   * grant_type=refresh_token. Rotates the refresh token (the old one is
   * invalidated by deleting the whole prior access-token row) and issues a fresh
   * pair carrying the same user/role/campaign caps.
   */
  async exchangeRefreshToken(input: {
    client: ClientRow;
    refreshToken: string;
    scope?: string;
    resource?: string;
  }): Promise<OAuthTokenResponse> {
    const [row] = await this.db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.refreshHash, hashOpaqueToken(input.refreshToken))).limit(1);
    if (!row || !row.refreshExpiresAt) {
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'Refresh token not found' });
    }
    if (row.clientId !== input.client.clientId) {
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'Refresh token was issued to a different client' });
    }
    if (new Date(row.refreshExpiresAt).getTime() < Date.now()) {
      await this.db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.id, row.id));
      throw new BadRequestException({ error: 'invalid_grant', error_description: 'Refresh token expired' });
    }
    // Rotation: drop the old pair, mint a new one.
    await this.db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.id, row.id));

    return this.issueTokenPair({
      clientId: row.clientId,
      userId: row.userId,
      scope: input.scope ?? row.scope,
      resource: input.resource ?? row.resource,
      roleScope: this.parseRole(row.roleScope),
      campaignId: row.campaignId,
    });
  }

  private async issueTokenPair(input: {
    clientId: string;
    userId: number;
    scope: string | null;
    resource: string | null;
    roleScope: Role;
    campaignId: number | null;
  }): Promise<OAuthTokenResponse> {
    const accessToken = generateOAuthAccessToken();
    const refreshToken = generateOAuthRefreshToken();
    const ts = nowIso();
    await this.db.insert(oauthAccessTokens).values({
      tokenHash: hashOpaqueToken(accessToken),
      refreshHash: hashOpaqueToken(refreshToken),
      clientId: input.clientId,
      userId: input.userId,
      scope: input.scope,
      resource: input.resource,
      roleScope: input.roleScope,
      campaignId: input.campaignId,
      expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
      createdAt: ts,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      ...(input.scope ? { scope: input.scope } : {}),
    };
  }

  /** RFC 7009 token revocation — accepts an access OR refresh token; no error if unknown. */
  async revokeToken(rawToken: string): Promise<void> {
    const hash = hashOpaqueToken(rawToken);
    await this.db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, hash));
    await this.db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.refreshHash, hash));
  }

  /**
   * Called from SessionAuthGuard for `Authorization: Bearer cf_mcp_...`. Resolves
   * a live (unexpired) access token to the owning user + a TokenContext capturing
   * its role/campaign caps — the SAME shape a PAT produces, so downstream role
   * resolution is identical. OAuth tokens never carry server-admin power.
   */
  async resolveAccessToken(rawToken: string): Promise<ResolvedOAuthToken | null> {
    const [row] = await this.db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, hashOpaqueToken(rawToken))).limit(1);
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      // Expired access token: leave the row (refresh may still be valid) — just reject the access use.
      return null;
    }

    const [owner] = await this.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!owner || owner.disabled) return null;

    const user: RequestUser = {
      id: String(owner.id),
      name: owner.displayName || owner.username,
      serverRole: owner.serverRole as RequestUser['serverRole'],
    };
    const tokenContext: TokenContext = {
      tokenId: row.id,
      name: `oauth:${row.clientId}`,
      scope: this.parseRole(row.roleScope),
      campaignId: row.campaignId,
      adminEnabled: false, // OAuth connector tokens never carry server-admin power
    };
    return { user, tokenContext };
  }

  /** Best-effort GC of expired codes/tokens; safe to call opportunistically. */
  async purgeExpired(): Promise<void> {
    const now = nowIso();
    await this.db.delete(oauthAuthCodes).where(lt(oauthAuthCodes.expiresAt, now));
  }

  private parseRole(value: string): Role {
    const parsed = Role.safeParse(value);
    return parsed.success ? parsed.data : 'viewer';
  }

  /**
   * Validates a token-endpoint client authentication. Public clients (auth
   * method "none") authenticate solely via PKCE and need no secret; confidential
   * clients must present the matching secret. Throws 401 on mismatch.
   */
  assertClientAuth(client: ClientRow, presentedSecret: string | undefined): void {
    if (client.secretHash === null) return; // public client
    if (!presentedSecret || hashOpaqueToken(presentedSecret) !== client.secretHash) {
      throw new UnauthorizedException({ error: 'invalid_client', error_description: 'Client authentication failed' });
    }
  }

  /** Helper: is `redirectUri` one this client registered? (exact match, per OAuth 2.1) */
  clientAllowsRedirect(client: ClientRow, redirectUri: string): boolean {
    return client.redirectUris.includes(redirectUri);
  }
}
