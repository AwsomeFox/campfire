import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type * as client from 'openid-client';
import {
  EMPTY_STORED_OIDC,
  effectiveIssuer,
  effectiveRedirectUri,
  oidcEnvKeysSet,
  oidcSecretSet,
  resolveOidcConfig,
  type OidcResolvedConfig,
  type StoredOidcConfig,
} from './oidc.config';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import type { OidcSettings, OidcSettingsUpdate, OidcTestResult, User } from '@campfire/schema';

/** Settings-store key under which the in-app OIDC config blob is persisted. */
const OIDC_SETTINGS_KEY = 'oidcConfig';

/** How long to wait for the discovery document during a test-connection probe. */
const TEST_CONNECTION_TIMEOUT_MS = 5_000;

/** Minimal shape of the ID token / userinfo claims we care about. */
export interface OidcClaims {
  sub: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

/** Filesystem-safe, User.username-regex-safe slug: lowercase, [a-z0-9_.-], min length 2. */
export function slugifyUsername(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (slug.length >= 2) return slug;
  // Too short after stripping (e.g. a single CJK char that has no ASCII
  // mapping, or empty) — fall back to a stable placeholder + will get a
  // numeric suffix appended by the collision loop if taken.
  return `user-${slug || 'sso'}`;
}

function extractGroups(claims: OidcClaims, groupsClaim: string): string[] {
  const raw = claims[groupsClaim];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
}

/**
 * `openid-client` (and its dependency `oauth4webapi`) ship ESM-only. This
 * project's server build/runtime is CommonJS (NestJS default + ts-jest for
 * tests). A plain `import('openid-client')` would be the right tool, but
 * TypeScript with `module: commonjs` downlevels dynamic `import()` to
 * `require()` — which still fails on an ESM-only package. `new
 * Function('specifier', 'return import(specifier)')` builds the import call
 * at runtime so TS never sees (and can't rewrite) the `import` keyword; this
 * is the standard workaround for CJS packages consuming ESM-only deps under
 * Node. Cached at module scope so every OidcService instance shares one load.
 */
const dynamicImport: (specifier: string) => Promise<typeof client> = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<typeof client>;

// Cache on `process`, not module scope: under jest (--experimental-vm-modules),
// each test file gets a fresh module registry, so a module-scoped cache re-runs
// the dynamic import per suite — and an import() evaluated in one test file's vm
// context can resolve after that context is torn down ("Test environment has
// been torn down", consistently on CI's slower runners). `process` is shared
// across all test files in a worker, so the import truly happens once.
type ProcessWithEsmCache = NodeJS.Process & { __campfireOpenidClient?: Promise<typeof client> };
function loadClient(): Promise<typeof client> {
  const proc = process as ProcessWithEsmCache;
  if (!proc.__campfireOpenidClient) {
    proc.__campfireOpenidClient = dynamicImport('openid-client');
  }
  return proc.__campfireOpenidClient;
}

/**
 * Discovery is lazy + cached: the IdP may be down at boot, so we don't
 * attempt discovery until the first /oidc/login or /oidc/callback hit, and
 * we cache the resulting Configuration so subsequent requests don't
 * re-fetch. If discovery fails we log a warning and retry on the *next*
 * request rather than crashing the server or caching the failure.
 */
@Injectable()
export class OidcService {
  private configPromise: Promise<client.Configuration> | null = null;
  private cachedConfig: client.Configuration | null = null;

  constructor(
    private readonly usersService: UsersService,
    private readonly settings: SettingsService,
  ) {}

  /** Loads the persisted (admin-editable) OIDC config blob from the settings store. */
  private async loadStored(): Promise<StoredOidcConfig> {
    const stored = await this.settings.getJson<Partial<StoredOidcConfig>>(OIDC_SETTINGS_KEY);
    return { ...EMPTY_STORED_OIDC, ...(stored ?? {}) };
  }

  /** The runtime config: env vars merged (as overrides) over the stored config. Null when not fully configured. */
  async getEffectiveConfig(): Promise<OidcResolvedConfig | null> {
    return resolveOidcConfig(await this.loadStored());
  }

  /** True when OIDC is fully configured (issuer + clientId + clientSecret all resolve). */
  async isEnabled(): Promise<boolean> {
    return (await this.getEffectiveConfig()) !== null;
  }

  /** Clears the cached discovery result so the next login re-discovers against the new config. Call after any config change. */
  private resetDiscoveryCache(): void {
    this.cachedConfig = null;
    this.configPromise = null;
  }

  /** Admin-facing view of the stored config — never includes the client secret; adds server-computed status fields. */
  async getAdminView(): Promise<OidcSettings> {
    const stored = await this.loadStored();
    const resolved = resolveOidcConfig(stored);
    return {
      issuer: stored.issuer,
      clientId: stored.clientId,
      redirectUri: stored.redirectUri,
      adminGroup: stored.adminGroup,
      allowedGroup: stored.allowedGroup,
      groupsClaim: stored.groupsClaim,
      scope: stored.scope,
      clientSecretSet: oidcSecretSet(stored),
      enabled: resolved !== null,
      envKeys: oidcEnvKeysSet(),
      effectiveRedirectUri: effectiveRedirectUri(stored),
    };
  }

  /**
   * Applies an admin update to the stored config and persists it. clientSecret
   * is write-only: `undefined` keeps the current secret, '' clears it, any
   * other value replaces it. Resets the discovery cache so the change takes
   * effect on the next login.
   */
  async updateStoredConfig(update: OidcSettingsUpdate): Promise<OidcSettings> {
    const stored = await this.loadStored();
    const next: StoredOidcConfig = { ...stored };
    const textFields: (keyof StoredOidcConfig)[] = [
      'issuer',
      'clientId',
      'redirectUri',
      'adminGroup',
      'allowedGroup',
      'groupsClaim',
      'scope',
    ];
    for (const field of textFields) {
      const value = update[field];
      if (value !== undefined) next[field] = value.trim();
    }
    // Write-only secret: only touch it when the caller explicitly sent the field.
    if (update.clientSecret !== undefined) next.clientSecret = update.clientSecret;

    await this.settings.setJson(OIDC_SETTINGS_KEY, next);
    this.resetDiscoveryCache();
    return this.getAdminView();
  }

  /**
   * Fetches and validates the issuer's OIDC discovery document
   * (`/.well-known/openid-configuration`). Uses the provided issuer override if
   * given (so an admin can test before saving), else the effective issuer.
   * Never throws — always resolves to a structured ok/error result.
   */
  async testConnection(issuerOverride?: string): Promise<OidcTestResult> {
    const issuer = (issuerOverride?.trim() || effectiveIssuer(await this.loadStored())).replace(/\/+$/, '');
    if (!issuer) {
      return { ok: false, issuer: '', message: 'No issuer configured to test.', authorizationEndpoint: null, tokenEndpoint: null };
    }

    let discoveryUrl: string;
    try {
      discoveryUrl = new URL('.well-known/openid-configuration', `${issuer}/`).toString();
    } catch {
      return { ok: false, issuer, message: 'Issuer must be an absolute URL (e.g. https://idp.example.com).', authorizationEndpoint: null, tokenEndpoint: null };
    }

    try {
      const res = await fetch(discoveryUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false, issuer, message: `Discovery endpoint returned HTTP ${res.status}.`, authorizationEndpoint: null, tokenEndpoint: null };
      }
      const doc = (await res.json()) as Record<string, unknown>;
      const authorizationEndpoint = typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : null;
      const tokenEndpoint = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : null;
      if (typeof doc.issuer !== 'string' || !authorizationEndpoint || !tokenEndpoint) {
        return { ok: false, issuer, message: 'Discovery document is missing required fields (issuer, authorization_endpoint, token_endpoint).', authorizationEndpoint, tokenEndpoint };
      }
      return { ok: true, issuer, message: `Discovery succeeded — issuer "${doc.issuer}".`, authorizationEndpoint, tokenEndpoint };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, issuer, message: `Could not reach the discovery endpoint: ${reason}`, authorizationEndpoint: null, tokenEndpoint: null };
    }
  }

  /** Resolves the discovered client Configuration, discovering (once, cached) on first call. */
  async getClientConfig(): Promise<client.Configuration> {
    const env = await this.getEffectiveConfig();
    if (!env) {
      throw new ServiceUnavailableException('OIDC is not configured');
    }
    if (this.cachedConfig) return this.cachedConfig;

    if (!this.configPromise) {
      this.configPromise = this.discover(env).catch((err) => {
        // Allow retry on the next call — don't cache a rejected promise.
        this.configPromise = null;
        // eslint-disable-next-line no-console
        console.warn(`[oidc] discovery failed against issuer ${env.issuer}: ${(err as Error).message}`);
        throw new ServiceUnavailableException('OIDC identity provider is unavailable');
      });
    }
    const config = await this.configPromise;
    this.cachedConfig = config;
    return config;
  }

  private async discover(env: OidcResolvedConfig): Promise<client.Configuration> {
    const oidc = await loadClient();
    const options: Parameters<typeof oidc.discovery>[4] =
      process.env.NODE_ENV === 'test' || process.env.OIDC_ALLOW_INSECURE === '1'
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined;
    return oidc.discovery(new URL(env.issuer), env.clientId, env.clientSecret, undefined, options);
  }

  /** Builds the authorization redirect URL. Returns both the URL and the PKCE/state values the caller must persist. */
  async buildAuthorizationRequest(): Promise<{ url: URL; state: string; codeVerifier: string }> {
    const env = await this.getEffectiveConfig();
    if (!env) throw new ServiceUnavailableException('OIDC is not configured');
    const oidc = await loadClient();
    const config = await this.getClientConfig();

    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: env.redirectUri,
      scope: env.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    return { url, state, codeVerifier };
  }

  /** Exchanges the callback URL for tokens and returns the validated ID token claims. */
  async handleCallback(currentUrl: URL, expectedState: string, codeVerifier: string): Promise<OidcClaims> {
    const oidc = await loadClient();
    const config = await this.getClientConfig();
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      expectedState,
      pkceCodeVerifier: codeVerifier,
    });
    const claims = tokens.claims();
    if (!claims) {
      throw new ServiceUnavailableException('OIDC identity provider did not return an ID token');
    }
    return claims as OidcClaims;
  }

  /**
   * Maps claims to a username candidate. preferred_username wins over email
   * (stripping the domain part), slugified to satisfy User.username's regex.
   */
  private usernameCandidate(claims: OidcClaims): string {
    const raw = claims.preferred_username || claims.email?.split('@')[0] || claims.sub;
    return slugifyUsername(raw);
  }

  /** Finds a username not already taken, appending -2, -3, ... on collision. */
  private async uniqueUsername(candidate: string): Promise<string> {
    let username = candidate;
    let suffix = 2;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await this.usersService.getRowByUsername(username);
      if (!existing) return username;
      username = `${candidate}-${suffix}`;
      suffix += 1;
    }
  }

  /**
   * Auto-provisions on first login (matched by `sub`), else reuses the
   * existing user. Syncs serverRole from the admin-group claim on EVERY
   * login (up and down — but UsersService.syncOidcServerRole refuses to
   * demote the last enabled admin, logging a warn instead).
   *
   * When an allowed-group is configured (OIDC_ALLOWED_GROUP or the in-app
   * `allowedGroup`), membership in that group — or in the admin group, since
   * admins always retain access — is required to sign in at all: without it, no
   * account is provisioned and existing accounts are denied a session with a
   * 403. Checked on EVERY login, so removing a user from the allowed group at
   * the IdP locks them out on their next login. Unset = any authenticated IdP
   * user may sign in (previous behavior).
   */
  async provisionOrUpdateUser(claims: OidcClaims): Promise<User> {
    const env = await this.getEffectiveConfig();
    if (!env) throw new ServiceUnavailableException('OIDC is not configured');

    const groups = extractGroups(claims, env.groupsClaim);
    const isAdminByGroup = env.adminGroup !== null && groups.includes(env.adminGroup);
    const desiredRole: 'admin' | 'user' = isAdminByGroup ? 'admin' : 'user';

    if (env.allowedGroup !== null && !groups.includes(env.allowedGroup) && !isAdminByGroup) {
      throw new ForbiddenException('Your account is not allowed to sign in to Campfire');
    }

    const existingRow = await this.usersService.getRowByOidcSub(claims.sub);
    if (existingRow) {
      return this.usersService.syncOidcServerRole(existingRow.id, desiredRole);
    }

    const candidate = this.usernameCandidate(claims);
    const username = await this.uniqueUsername(candidate);
    const displayName = claims.name || claims.preferred_username || username;

    return this.usersService.createSso({
      username,
      displayName,
      oidcSub: claims.sub,
      serverRole: desiredRole,
    });
  }
}
