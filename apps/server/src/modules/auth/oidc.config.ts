/**
 * OIDC configuration resolution.
 *
 * OIDC can be configured two ways, which are merged per-field with a fixed
 * precedence: an `OIDC_*` environment variable, when set (non-empty), OVERRIDES
 * the in-app stored value for that field; otherwise the stored (admin-editable)
 * value is used; otherwise a built-in default. This lets existing env-var
 * deployments keep working unchanged while admins can also configure OIDC from
 * the settings UI.
 *
 * `resolveOidcConfig()` returns null (OIDC "disabled") unless the three core
 * fields — issuer, clientId, clientSecret — all resolve to non-empty values.
 * That single predicate drives AuthStatus.oidcEnabled, whether the OIDC
 * controller's routes function (vs 503), and whether OidcService attempts
 * discovery at all.
 */

/** The stored, admin-editable OIDC config (persisted in the settings store). All strings; '' means unset. Includes the secret (server-side only — never serialized to clients). */
export interface StoredOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  adminGroup: string;
  allowedGroup: string;
  groupsClaim: string;
  scope: string;
}

/** The fully-resolved config actually used at runtime (env merged over stored, defaults applied). */
export interface OidcResolvedConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  adminGroup: string | null;
  allowedGroup: string | null;
  groupsClaim: string;
  scope: string;
}

export const EMPTY_STORED_OIDC: StoredOidcConfig = {
  issuer: '',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  adminGroup: '',
  allowedGroup: '',
  groupsClaim: '',
  scope: '',
};

/** Env var backing each stored field. */
const ENV_KEYS: Record<keyof StoredOidcConfig, string> = {
  issuer: 'OIDC_ISSUER',
  clientId: 'OIDC_CLIENT_ID',
  clientSecret: 'OIDC_CLIENT_SECRET',
  redirectUri: 'OIDC_REDIRECT_URI',
  adminGroup: 'OIDC_ADMIN_GROUP',
  allowedGroup: 'OIDC_ALLOWED_GROUP',
  groupsClaim: 'OIDC_GROUPS_CLAIM',
  scope: 'OIDC_SCOPE',
};

function appUrl(): string {
  return process.env.APP_URL || 'http://localhost:8080';
}

function envValue(field: keyof StoredOidcConfig): string | undefined {
  const v = process.env[ENV_KEYS[field]]?.trim();
  return v ? v : undefined;
}

/** Env (override) wins; otherwise the stored value; otherwise '' (caller applies field defaults). */
function pick(field: keyof StoredOidcConfig, stored: StoredOidcConfig): string {
  return envValue(field) ?? (stored[field]?.trim() || '');
}

/** Names of the OIDC_* env vars currently set — these override the in-app stored values and are surfaced read-only in the admin UI. */
export function oidcEnvKeysSet(): string[] {
  return (Object.keys(ENV_KEYS) as (keyof StoredOidcConfig)[])
    .filter((f) => envValue(f) !== undefined)
    .map((f) => ENV_KEYS[f]);
}

/** True when the client secret is provided by either the stored config or an env var. */
export function oidcSecretSet(stored: StoredOidcConfig): boolean {
  return pick('clientSecret', stored) !== '';
}

/** The callback URL the flow will actually use, even when the config is otherwise incomplete (for display in the admin UI). */
export function effectiveRedirectUri(stored: StoredOidcConfig): string {
  return pick('redirectUri', stored) || `${appUrl()}/api/v1/auth/oidc/callback`;
}

/** The effective issuer (env override, then stored) even when the full config is incomplete — used by the test-connection action. */
export function effectiveIssuer(stored: StoredOidcConfig): string {
  return pick('issuer', stored);
}

/**
 * Merge env (override) over stored (base) and apply defaults. Returns null
 * unless issuer + clientId + clientSecret all resolve non-empty (i.e. OIDC is
 * not fully configured and must be treated as disabled).
 */
export function resolveOidcConfig(stored: StoredOidcConfig): OidcResolvedConfig | null {
  const issuer = pick('issuer', stored);
  const clientId = pick('clientId', stored);
  const clientSecret = pick('clientSecret', stored);
  if (!issuer || !clientId || !clientSecret) return null;

  const redirectUri = pick('redirectUri', stored) || `${appUrl()}/api/v1/auth/oidc/callback`;
  const adminGroup = pick('adminGroup', stored) || null;
  const allowedGroup = pick('allowedGroup', stored) || null;
  const groupsClaim = pick('groupsClaim', stored) || 'groups';
  const scope = pick('scope', stored) || 'openid profile email';

  return { issuer, clientId, clientSecret, redirectUri, adminGroup, allowedGroup, groupsClaim, scope };
}
