import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type * as client from 'openid-client';
import { pkceS256Challenge } from '../../common/crypto';
import {
  EMPTY_STORED_OIDC,
  effectiveRedirectUri,
  oidcEnvKeysSet,
  oidcSecretSet,
  resolveDiagnosticCandidate,
  resolveOidcConfig,
  type OidcDiagnosticDraft,
  type OidcDiagnosticResolved,
  type OidcResolvedConfig,
  type StoredOidcConfig,
} from './oidc.config';
import {
  canonicalIssuer,
  checkFail,
  checkPass,
  checkSkip,
  evaluateGroupPolicy,
  groupsFromClaims,
  isAbsoluteHttpUrl,
  issuersMatch,
  oidcConfigFingerprint,
} from './oidc-diagnostics';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import type {
  OidcLastE2eTest,
  OidcSettings,
  OidcSettingsUpdate,
  OidcTestLoginStart,
  OidcTestRequest,
  OidcTestResult,
  User,
} from '@campfire/schema';
import { OidcTestResult as OidcTestResultSchema } from '@campfire/schema';
import { OidcRecoveryFailure } from './oidc-recovery';
import {
  getLatestOidcTestResult,
  hashFlowToken,
  peekOidcTestPending,
  putOidcTestPending,
  setLatestOidcTestResult,
  takeOidcTestPending,
  type OidcTestPending,
} from './oidc-test-pending';

/** Settings-store key under which the in-app OIDC config blob is persisted. */
const OIDC_SETTINGS_KEY = 'oidcConfig';
/** Persisted last admin end-to-end diagnostic summary (non-secret). */
const OIDC_LAST_E2E_KEY = 'oidcLastE2eTest';

/** How long to wait for the discovery document during a test-connection probe. */
const TEST_CONNECTION_TIMEOUT_MS = 5_000;
/** Pending diagnostic login expires after this (matches the test-flow cookie). */
const TEST_LOGIN_PENDING_MAX_AGE_MS = 5 * 60 * 1000;

/** Minimal shape of the ID token / userinfo claims we care about. */
export interface OidcClaims {
  sub: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

function emptyFieldSources(): OidcTestResult['fieldSources'] {
  return {
    issuer: 'default',
    clientId: 'default',
    clientSecret: 'default',
    redirectUri: 'default',
    adminGroup: 'default',
    allowedGroup: 'default',
    groupsClaim: 'default',
    scope: 'default',
  };
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

  /** Public login metadata. Deliberately excludes issuer, client, group, and secret configuration. */
  async getPublicStatus(): Promise<{ enabled: boolean; providerName: string | null }> {
    const resolved = await this.getEffectiveConfig();
    return {
      enabled: resolved !== null,
      providerName: resolved?.providerName ?? null,
    };
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
    const effective = resolveDiagnosticCandidate(stored);
    const lastE2e = (await this.settings.getJson<OidcLastE2eTest>(OIDC_LAST_E2E_KEY)) ?? null;
    return {
      providerName: stored.providerName,
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
      configFingerprint: oidcConfigFingerprint(effective),
      lastE2eTest: lastE2e,
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
      'providerName',
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
   * Discovery + static client/redirect probe (issue #848). Never throws —
   * always resolves to a structured result. Labels a successful discovery as
   * "Discovery reachable." (not "Connection OK"). Token exchange, claims, and
   * group policy are skipped here — use {@link startTestLogin} for those.
   */
  async testConnection(draft: OidcTestRequest = {}): Promise<OidcTestResult> {
    const stored = await this.loadStored();
    const candidate = resolveDiagnosticCandidate(stored, draft as OidcDiagnosticDraft);
    const testedAt = new Date().toISOString();
    const fingerprint = oidcConfigFingerprint(candidate);
    const base = {
      kind: 'discovery' as const,
      issuer: candidate.issuer,
      testedAt,
      fingerprint,
      fieldSources: candidate.fieldSources,
    };

    if (!candidate.issuer) {
      return OidcTestResultSchema.parse({
        ...base,
        ok: false,
        message: 'No issuer configured to test.',
        authorizationEndpoint: null,
        tokenEndpoint: null,
        checks: {
          discovery: checkFail('No issuer configured.'),
          redirectClient: checkSkip('Skipped — discovery did not succeed.'),
          tokenExchange: checkSkip('Requires end-to-end test login.'),
          requiredClaims: checkSkip('Requires end-to-end test login.'),
          groupPolicy: checkSkip('Requires end-to-end test login.'),
        },
      });
    }

    let discoveryUrl: string;
    try {
      discoveryUrl = new URL('.well-known/openid-configuration', `${candidate.issuer}/`).toString();
    } catch {
      return OidcTestResultSchema.parse({
        ...base,
        ok: false,
        message: 'Issuer must be an absolute URL (e.g. https://idp.example.com).',
        authorizationEndpoint: null,
        tokenEndpoint: null,
        checks: {
          discovery: checkFail('Issuer must be an absolute URL.'),
          redirectClient: checkSkip('Skipped — discovery did not succeed.'),
          tokenExchange: checkSkip('Requires end-to-end test login.'),
          requiredClaims: checkSkip('Requires end-to-end test login.'),
          groupPolicy: checkSkip('Requires end-to-end test login.'),
        },
      });
    }

    let authorizationEndpoint: string | null = null;
    let tokenEndpoint: string | null = null;
    let discoveredIssuer: string | null = null;

    try {
      const res = await fetch(discoveryUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (!res.ok) {
        return OidcTestResultSchema.parse({
          ...base,
          ok: false,
          message: `Discovery endpoint returned HTTP ${res.status}.`,
          authorizationEndpoint: null,
          tokenEndpoint: null,
          checks: {
            discovery: checkFail(`Discovery endpoint returned HTTP ${res.status}.`),
            redirectClient: checkSkip('Skipped — discovery did not succeed.'),
            tokenExchange: checkSkip('Requires end-to-end test login.'),
            requiredClaims: checkSkip('Requires end-to-end test login.'),
            groupPolicy: checkSkip('Requires end-to-end test login.'),
          },
        });
      }
      const doc = (await res.json()) as Record<string, unknown>;
      discoveredIssuer = typeof doc.issuer === 'string' ? doc.issuer : null;
      authorizationEndpoint = typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : null;
      tokenEndpoint = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : null;

      if (!discoveredIssuer || !authorizationEndpoint || !tokenEndpoint) {
        return OidcTestResultSchema.parse({
          ...base,
          ok: false,
          message: 'Discovery document is missing required fields (issuer, authorization_endpoint, token_endpoint).',
          authorizationEndpoint,
          tokenEndpoint,
          checks: {
            discovery: checkFail('Discovery document is missing required fields.'),
            redirectClient: checkSkip('Skipped — discovery did not succeed.'),
            tokenExchange: checkSkip('Requires end-to-end test login.'),
            requiredClaims: checkSkip('Requires end-to-end test login.'),
            groupPolicy: checkSkip('Requires end-to-end test login.'),
          },
        });
      }

      if (!issuersMatch(candidate.issuer, discoveredIssuer)) {
        return OidcTestResultSchema.parse({
          ...base,
          ok: false,
          message: `Issuer mismatch: configured "${canonicalIssuer(candidate.issuer)}" ≠ discovery "${canonicalIssuer(discoveredIssuer)}".`,
          authorizationEndpoint,
          tokenEndpoint,
          checks: {
            discovery: checkFail(
              `Canonical issuer mismatch (configured "${canonicalIssuer(candidate.issuer)}" vs discovery "${canonicalIssuer(discoveredIssuer)}").`,
            ),
            redirectClient: checkSkip('Skipped — discovery issuer mismatch.'),
            tokenExchange: checkSkip('Requires end-to-end test login.'),
            requiredClaims: checkSkip('Requires end-to-end test login.'),
            groupPolicy: checkSkip('Requires end-to-end test login.'),
          },
        });
      }

      if (!isAbsoluteHttpUrl(authorizationEndpoint) || !isAbsoluteHttpUrl(tokenEndpoint)) {
        return OidcTestResultSchema.parse({
          ...base,
          ok: false,
          message: 'Discovery endpoints must be absolute http(s) URLs.',
          authorizationEndpoint,
          tokenEndpoint,
          checks: {
            discovery: checkFail('authorization_endpoint or token_endpoint is not an absolute http(s) URL.'),
            redirectClient: checkSkip('Skipped — discovery endpoints invalid.'),
            tokenExchange: checkSkip('Requires end-to-end test login.'),
            requiredClaims: checkSkip('Requires end-to-end test login.'),
            groupPolicy: checkSkip('Requires end-to-end test login.'),
          },
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const timedOut = /aborted|timeout|TimeoutError/i.test(reason);
      return OidcTestResultSchema.parse({
        ...base,
        ok: false,
        message: timedOut
          ? `Discovery timed out after ${TEST_CONNECTION_TIMEOUT_MS}ms.`
          : `Could not reach the discovery endpoint: ${reason}`,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        checks: {
          discovery: checkFail(
            timedOut
              ? `Timed out after ${TEST_CONNECTION_TIMEOUT_MS}ms.`
              : `Could not reach discovery: ${reason}`,
          ),
          redirectClient: checkSkip('Skipped — discovery did not succeed.'),
          tokenExchange: checkSkip('Requires end-to-end test login.'),
          requiredClaims: checkSkip('Requires end-to-end test login.'),
          groupPolicy: checkSkip('Requires end-to-end test login.'),
        },
      });
    }

    // When client credentials are absent, skip the redirect/client probe rather
    // than failing discovery — admins often validate the issuer URL first.
    let redirectClient: OidcTestResult['checks']['redirectClient'];
    if (!candidate.clientId || !candidate.clientSecret) {
      redirectClient = checkSkip('Provide client ID and secret (draft or stored) to probe redirect/client configuration.');
    } else {
      redirectClient = await this.probeRedirectAndClient(
        candidate,
        authorizationEndpoint!,
        tokenEndpoint!,
      );
    }

    // Discovery-kind `ok` means the issuer is reachable and validated — not that
    // login works. Redirect/client failures are reported in `checks` separately.
    return OidcTestResultSchema.parse({
      ...base,
      ok: true,
      message: 'Discovery reachable.',
      authorizationEndpoint,
      tokenEndpoint,
      checks: {
        discovery: checkPass('Discovery reachable; issuer and endpoint URLs validated.'),
        redirectClient,
        tokenExchange: checkSkip('Requires end-to-end test login.'),
        requiredClaims: checkSkip('Requires end-to-end test login.'),
        groupPolicy: checkSkip('Requires end-to-end test login.'),
      },
    });
  }

  /**
   * Static redirect URI format + client credential probe against the token
   * endpoint (invalid code → invalid_grant means client auth worked;
   * invalid_client means bad id/secret). Does not perform a user login.
   */
  private async probeRedirectAndClient(
    candidate: OidcDiagnosticResolved,
    authorizationEndpoint: string,
    tokenEndpoint: string,
  ): Promise<OidcTestResult['checks']['redirectClient']> {
    if (!candidate.redirectUri || !isAbsoluteHttpUrl(candidate.redirectUri)) {
      return checkFail('Redirect URI must be an absolute http(s) URL.');
    }
    if (!candidate.clientId) {
      return checkFail('Client ID is required to validate client configuration.');
    }
    if (!candidate.clientSecret) {
      return checkFail('Client secret is required to validate client configuration.');
    }

    // Confirm the authorization endpoint accepts our redirect_uri (unregistered
    // URIs typically error without completing a login). Mirror real SSO / test
    // login: same resolved scope + S256 PKCE so IdPs that require either do not
    // fail this probe while end-to-end login would succeed.
    try {
      const codeVerifier = randomBytes(32).toString('base64url');
      const authorizeUrl = new URL(authorizationEndpoint);
      authorizeUrl.searchParams.set('client_id', candidate.clientId);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('redirect_uri', candidate.redirectUri);
      authorizeUrl.searchParams.set('scope', candidate.scope.trim() || 'openid profile email');
      authorizeUrl.searchParams.set('state', 'campfire-diag');
      authorizeUrl.searchParams.set('code_challenge', pkceS256Challenge(codeVerifier));
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      const authRes = await fetch(authorizeUrl.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      // 3xx to our redirect_uri (or IdP login) is fine; 4xx usually means bad client/redirect.
      if (authRes.status >= 400) {
        return checkFail(
          `Authorization endpoint rejected the client/redirect configuration (HTTP ${authRes.status}).`,
        );
      }
      const location = authRes.headers.get('location');
      if (location) {
        try {
          const loc = new URL(location, authorizationEndpoint);
          if (loc.searchParams.get('error') === 'invalid_request' || loc.searchParams.get('error') === 'unauthorized_client') {
            return checkFail(
              `Authorization endpoint reported ${loc.searchParams.get('error')} for this client/redirect.`,
            );
          }
        } catch {
          // Non-URL Location headers are IdP-specific; ignore.
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return checkFail(`Could not probe authorization endpoint: ${reason}`);
    }

    // Probe client authentication with an intentionally invalid code.
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'campfire-diagnostic-invalid-code',
        redirect_uri: candidate.redirectUri,
        client_id: candidate.clientId,
        client_secret: candidate.clientSecret,
      });
      const tokenRes = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      let errorCode = '';
      try {
        const json = (await tokenRes.json()) as { error?: string };
        errorCode = typeof json.error === 'string' ? json.error : '';
      } catch {
        // Non-JSON error bodies still carry useful HTTP status.
      }
      if (errorCode === 'invalid_client' || tokenRes.status === 401) {
        return checkFail('Token endpoint rejected the client ID or client secret.');
      }
      // invalid_grant / invalid_request with a fake code means client auth succeeded.
      if (
        errorCode === 'invalid_grant' ||
        errorCode === 'invalid_request' ||
        tokenRes.status === 400 ||
        tokenRes.ok
      ) {
        return checkPass('Redirect URI format OK; client credentials accepted by the token endpoint.');
      }
      return checkFail(
        `Unexpected token-endpoint response while probing client credentials (HTTP ${tokenRes.status}${errorCode ? `, ${errorCode}` : ''}).`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return checkFail(`Could not probe token endpoint: ${reason}`);
    }
  }

  /**
   * Starts an admin-only end-to-end test login (issue #848). Returns an
   * authorization URL; the browser round-trip completes via the normal OIDC
   * callback path when the test-flow cookie is present — without replacing the
   * admin session or provisioning a user.
   */
  async startTestLogin(draft: OidcTestRequest = {}): Promise<OidcTestLoginStart & { flowToken: string }> {
    const stored = await this.loadStored();
    const candidate = resolveDiagnosticCandidate(stored, draft as OidcDiagnosticDraft);
    if (!candidate.issuer || !candidate.clientId || !candidate.clientSecret) {
      throw new BadRequestException(
        'End-to-end test login requires issuer, client ID, and client secret (draft, stored, or environment).',
      );
    }
    if (!isAbsoluteHttpUrl(candidate.redirectUri)) {
      throw new BadRequestException('Redirect URI must be an absolute http(s) URL.');
    }

    const oidc = await loadClient();
    const options: Parameters<typeof oidc.discovery>[4] =
      process.env.NODE_ENV === 'test' || process.env.OIDC_ALLOW_INSECURE === '1'
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined;
    let config: client.Configuration;
    try {
      config = await oidc.discovery(
        new URL(candidate.issuer),
        candidate.clientId,
        candidate.clientSecret,
        undefined,
        options,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`OIDC discovery failed: ${reason}`);
    }

    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: candidate.redirectUri,
      scope: candidate.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    const flowToken = randomBytes(16).toString('hex');
    const fingerprint = oidcConfigFingerprint(candidate);
    const pending: OidcTestPending = {
      flowTokenHash: hashFlowToken(flowToken),
      state,
      codeVerifier,
      candidate,
      fingerprint,
      expiresAt: Date.now() + TEST_LOGIN_PENDING_MAX_AGE_MS,
    };
    // In-memory only (includes client secret) — keyed by flow token so concurrent
    // admin diagnostics do not overwrite each other.
    putOidcTestPending(pending);
    // Clear any stale poll result so the UI doesn't show a previous run.
    setLatestOidcTestResult(null);

    return {
      authorizationUrl: url.toString(),
      fingerprint,
      fieldSources: candidate.fieldSources,
      flowToken,
    };
  }

  /** True when a non-expired diagnostic pending state exists for this flow token. */
  async hasActiveTestLogin(flowToken: string | undefined): Promise<boolean> {
    return peekOidcTestPending(flowToken) !== null;
  }

  /**
   * True when the diagnostic flow cookie matches a pending test login whose
   * OIDC `state` equals the IdP callback state. Used so a leftover test cookie
   * cannot hijack a normal SSO callback (issue #848).
   */
  async matchesActiveTestLogin(
    flowToken: string | undefined,
    callbackState: string | undefined,
  ): Promise<boolean> {
    if (!flowToken || !callbackState) return false;
    const pending = peekOidcTestPending(flowToken);
    return pending !== null && pending.state === callbackState;
  }

  /**
   * Completes an admin diagnostic login at the OIDC callback. Validates token
   * exchange, required claims, and group policy; never provisions a user or
   * issues a session. Persists the structured result for the admin UI.
   *
   * `callbackQuery` is the inbound request's query string; the callback URL is
   * reconstructed from the pending candidate's redirect URI (which may be a
   * draft value distinct from the effective stored redirect).
   */
  async completeTestLogin(
    flowToken: string,
    callbackQuery: Record<string, unknown>,
  ): Promise<OidcTestResult> {
    // Atomically take pending for this token so overlapping callbacks cannot
    // clear a successful run's slot and overwrite lastE2e with a stale failure.
    const pending = takeOidcTestPending(flowToken);

    const testedAt = new Date().toISOString();
    if (!pending) {
      // Do not update oidcLastE2eTest — a late/refreshed callback must not
      // clobber a previously successful verification with an empty fingerprint.
      const expired = OidcTestResultSchema.parse({
        ok: false,
        kind: 'e2e',
        issuer: '',
        message: 'Diagnostic login flow expired or was missing.',
        authorizationEndpoint: null,
        tokenEndpoint: null,
        testedAt,
        fingerprint: '',
        fieldSources: emptyFieldSources(),
        checks: {
          discovery: checkSkip('Flow expired before completion.'),
          redirectClient: checkSkip('Flow expired before completion.'),
          tokenExchange: checkFail('Diagnostic login flow expired or was missing.'),
          requiredClaims: checkSkip('Skipped — token exchange did not succeed.'),
          groupPolicy: checkSkip('Skipped — token exchange did not succeed.'),
        },
      });
      setLatestOidcTestResult(expired);
      return expired;
    }

    const callbackState = typeof callbackQuery.state === 'string' ? callbackQuery.state : undefined;
    if (!callbackState || pending.state !== callbackState) {
      return this.persistE2eResult(
        OidcTestResultSchema.parse({
          ok: false,
          kind: 'e2e',
          issuer: pending.candidate.issuer,
          message: 'Diagnostic login state mismatch.',
          authorizationEndpoint: null,
          tokenEndpoint: null,
          testedAt,
          fingerprint: pending.fingerprint,
          fieldSources: pending.candidate.fieldSources,
          checks: {
            discovery: checkSkip('Not re-checked during callback.'),
            redirectClient: checkFail('State or flow-token mismatch.'),
            tokenExchange: checkFail('State or flow-token mismatch.'),
            requiredClaims: checkSkip('Skipped — token exchange did not succeed.'),
            groupPolicy: checkSkip('Skipped — token exchange did not succeed.'),
          },
        }),
      );
    }

    const candidate = pending.candidate;
    const currentUrl = new URL(candidate.redirectUri);
    for (const [key, value] of Object.entries(callbackQuery)) {
      if (typeof value === 'string') currentUrl.searchParams.set(key, value);
    }

    const providerError = typeof callbackQuery.error === 'string' ? callbackQuery.error : '';
    if (providerError) {
      return this.persistE2eResult(
        OidcTestResultSchema.parse({
          ok: false,
          kind: 'e2e',
          issuer: candidate.issuer,
          message: `Provider returned error "${providerError}" during test login.`,
          authorizationEndpoint: null,
          tokenEndpoint: null,
          testedAt,
          fingerprint: pending.fingerprint,
          fieldSources: candidate.fieldSources,
          checks: {
            discovery: checkPass('Discovery succeeded during test login.'),
            redirectClient: checkFail(`Provider error: ${providerError}`),
            tokenExchange: checkFail(`Provider error: ${providerError}`),
            requiredClaims: checkSkip('Skipped — authorization did not succeed.'),
            groupPolicy: checkSkip('Skipped — authorization did not succeed.'),
          },
        }),
      );
    }

    const oidc = await loadClient();
    const options: Parameters<typeof oidc.discovery>[4] =
      process.env.NODE_ENV === 'test' || process.env.OIDC_ALLOW_INSECURE === '1'
        ? { execute: [oidc.allowInsecureRequests] }
        : undefined;

    let claims: Record<string, unknown>;
    try {
      const config = await oidc.discovery(
        new URL(candidate.issuer),
        candidate.clientId,
        candidate.clientSecret,
        undefined,
        options,
      );
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        expectedState: pending.state,
        pkceCodeVerifier: pending.codeVerifier,
      });
      const rawClaims = tokens.claims();
      if (!rawClaims) {
        return this.persistE2eResult(
          OidcTestResultSchema.parse({
            ok: false,
            kind: 'e2e',
            issuer: candidate.issuer,
            message: 'Token exchange succeeded but ID token claims were missing.',
            authorizationEndpoint: null,
            tokenEndpoint: null,
            testedAt,
            fingerprint: pending.fingerprint,
            fieldSources: candidate.fieldSources,
            checks: {
              discovery: checkPass('Discovery succeeded during test login.'),
              redirectClient: checkPass('Redirect and client configuration accepted.'),
              tokenExchange: checkPass('Authorization code exchanged for tokens.'),
              requiredClaims: checkFail('ID token contained no claims.'),
              groupPolicy: checkSkip('Skipped — required claims missing.'),
            },
          }),
        );
      }
      claims = rawClaims as Record<string, unknown>;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.persistE2eResult(
        OidcTestResultSchema.parse({
          ok: false,
          kind: 'e2e',
          issuer: candidate.issuer,
          message: `Token exchange failed: ${reason}`,
          authorizationEndpoint: null,
          tokenEndpoint: null,
          testedAt,
          fingerprint: pending.fingerprint,
          fieldSources: candidate.fieldSources,
          checks: {
            discovery: checkPass('Discovery succeeded during test login.'),
            redirectClient: checkFail(`Client/redirect or token exchange failed: ${reason}`),
            tokenExchange: checkFail(reason),
            requiredClaims: checkSkip('Skipped — token exchange did not succeed.'),
            groupPolicy: checkSkip('Skipped — token exchange did not succeed.'),
          },
        }),
      );
    }

    const sub = typeof claims.sub === 'string' ? claims.sub : '';
    const requiredClaims =
      sub.length > 0
        ? checkPass('Required subject (sub) claim present.')
        : checkFail('Required subject (sub) claim is missing.');

    const groups = groupsFromClaims(claims, candidate.groupsClaim);
    const adminGroup = candidate.adminGroup || null;
    const allowedGroup = candidate.allowedGroup || null;
    const groupPolicy = evaluateGroupPolicy(groups, adminGroup, allowedGroup);

    const ok =
      requiredClaims.status === 'pass' &&
      (groupPolicy.status === 'pass' || groupPolicy.status === 'skip');

    return this.persistE2eResult(
      OidcTestResultSchema.parse({
        ok,
        kind: 'e2e',
        issuer: candidate.issuer,
        message: ok
          ? 'End-to-end test login succeeded (no session created, no user provisioned).'
          : `End-to-end test login failed: ${requiredClaims.status === 'fail' ? requiredClaims.message : groupPolicy.message}`,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        testedAt,
        fingerprint: pending.fingerprint,
        fieldSources: candidate.fieldSources,
        checks: {
          discovery: checkPass('Discovery succeeded during test login.'),
          redirectClient: checkPass('Redirect and client configuration accepted.'),
          tokenExchange: checkPass('Authorization code exchanged for tokens.'),
          requiredClaims,
          groupPolicy,
        },
      }),
    );
  }

  /**
   * Latest completed diagnostic result for the admin UI poll after redirect.
   * Ephemeral in-memory value (non-secret); the durable verification signal is
   * `lastE2eTest` on the settings GET response.
   */
  async getTestLoginResult(): Promise<OidcTestResult | null> {
    return getLatestOidcTestResult();
  }

  private async persistE2eResult(result: OidcTestResult): Promise<OidcTestResult> {
    setLatestOidcTestResult(result);
    const summary: OidcLastE2eTest = {
      testedAt: result.testedAt,
      fingerprint: result.fingerprint,
      ok: result.ok,
    };
    await this.settings.setJson(OIDC_LAST_E2E_KEY, summary);
    return result;
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
        throw new OidcRecoveryFailure('provider_unavailable', 'discovery_failed', { cause: err });
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
    if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new OidcRecoveryFailure('missing_claims', 'required_claims_missing');
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
   * account is provisioned and existing accounts are redirected to the safe
   * group-denied recovery page without a session. Checked on EVERY login, so
   * removing a user from the allowed group at
   * the IdP locks them out on their next login. Unset = any authenticated IdP
   * user may sign in (previous behavior).
   */
  async provisionOrUpdateUser(claims: OidcClaims): Promise<User> {
    const env = await this.getEffectiveConfig();
    if (!env) throw new ServiceUnavailableException('OIDC is not configured');
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new OidcRecoveryFailure('missing_claims', 'subject_claim_missing');
    }

    const groups = extractGroups(claims, env.groupsClaim);
    const isAdminByGroup = env.adminGroup !== null && groups.includes(env.adminGroup);
    const desiredRole: 'admin' | 'user' = isAdminByGroup ? 'admin' : 'user';

    if (env.allowedGroup !== null && !groups.includes(env.allowedGroup) && !isAdminByGroup) {
      throw new OidcRecoveryFailure('group_denied', 'required_group_missing');
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
