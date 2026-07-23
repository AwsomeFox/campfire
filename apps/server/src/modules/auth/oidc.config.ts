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
  providerName: string;
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
  providerName: string | null;
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
  providerName: '',
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
  providerName: 'OIDC_PROVIDER_NAME',
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
  // Admin updates are schema-capped at 80 chars. Apply the same cap to env
  // input before it reaches the unauthenticated auth-status response.
  const providerName = pick('providerName', stored).slice(0, 80) || null;
  const adminGroup = pick('adminGroup', stored) || null;
  const allowedGroup = pick('allowedGroup', stored) || null;
  const groupsClaim = pick('groupsClaim', stored) || 'groups';
  const scope = pick('scope', stored) || 'openid profile email';

  return { providerName, issuer, clientId, clientSecret, redirectUri, adminGroup, allowedGroup, groupsClaim, scope };
}

/** Draft override fields accepted by diagnostic probes (issue #848). */
export interface OidcDiagnosticDraft {
  issuer?: string;
  clientId?: string;
  /** Write-only: undefined/'' means reuse env-or-stored secret. */
  clientSecret?: string;
  redirectUri?: string;
  adminGroup?: string;
  allowedGroup?: string;
  groupsClaim?: string;
  scope?: string;
}

export type OidcConfigValueSource = 'draft' | 'stored' | 'environment' | 'default';

export interface OidcDiagnosticResolved {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  adminGroup: string;
  allowedGroup: string;
  groupsClaim: string;
  scope: string;
  fieldSources: {
    issuer: OidcConfigValueSource;
    clientId: OidcConfigValueSource;
    clientSecret: OidcConfigValueSource;
    redirectUri: OidcConfigValueSource;
    adminGroup: OidcConfigValueSource;
    allowedGroup: OidcConfigValueSource;
    groupsClaim: OidcConfigValueSource;
    scope: OidcConfigValueSource;
  };
}

function sourceFor(
  field: keyof StoredOidcConfig,
  stored: StoredOidcConfig,
  draftValue: string | undefined,
  opts: { treatBlankDraftAsReuse?: boolean } = {},
): { value: string; source: OidcConfigValueSource } {
  // Env always wins over draft/stored — admins cannot probe past an env pin.
  const fromEnv = envValue(field);
  if (fromEnv !== undefined) return { value: fromEnv, source: 'environment' };

  if (draftValue !== undefined) {
    const trimmed = draftValue.trim();
    if (opts.treatBlankDraftAsReuse && trimmed === '') {
      const storedVal = stored[field]?.trim() || '';
      return { value: storedVal, source: storedVal ? 'stored' : 'default' };
    }
    return { value: trimmed, source: 'draft' };
  }

  const storedVal = stored[field]?.trim() || '';
  return { value: storedVal, source: storedVal ? 'stored' : 'default' };
}

/**
 * Resolve a diagnostic candidate from optional draft fields over env-over-stored
 * config. Never returns secrets in `fieldSources` — only the origin label.
 * Env pins always override draft values (same precedence as runtime config).
 */
export function resolveDiagnosticCandidate(
  stored: StoredOidcConfig,
  draft: OidcDiagnosticDraft = {},
): OidcDiagnosticResolved {
  const issuer = sourceFor('issuer', stored, draft.issuer);
  const clientId = sourceFor('clientId', stored, draft.clientId);
  // Blank/omitted draft secret reuses env-or-stored (write-only semantics).
  const clientSecret = sourceFor('clientSecret', stored, draft.clientSecret, {
    treatBlankDraftAsReuse: true,
  });
  const redirect = sourceFor('redirectUri', stored, draft.redirectUri);
  const redirectUri =
    redirect.value || `${appUrl()}/api/v1/auth/oidc/callback`;
  const redirectSource: OidcConfigValueSource = redirect.value
    ? redirect.source
    : 'default';

  const adminGroup = sourceFor('adminGroup', stored, draft.adminGroup);
  const allowedGroup = sourceFor('allowedGroup', stored, draft.allowedGroup);
  const groupsClaimRaw = sourceFor('groupsClaim', stored, draft.groupsClaim);
  const scopeRaw = sourceFor('scope', stored, draft.scope);

  const groupsClaim = groupsClaimRaw.value || 'groups';
  const groupsClaimSource: OidcConfigValueSource = groupsClaimRaw.value
    ? groupsClaimRaw.source
    : 'default';
  const scope = scopeRaw.value || 'openid profile email';
  const scopeSource: OidcConfigValueSource = scopeRaw.value ? scopeRaw.source : 'default';

  return {
    issuer: issuer.value.replace(/\/+$/, ''),
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    redirectUri,
    adminGroup: adminGroup.value,
    allowedGroup: allowedGroup.value,
    groupsClaim,
    scope,
    fieldSources: {
      issuer: issuer.source,
      clientId: clientId.source,
      clientSecret: clientSecret.source,
      redirectUri: redirectSource,
      adminGroup: adminGroup.value ? adminGroup.source : adminGroup.source === 'draft' ? 'draft' : 'default',
      allowedGroup: allowedGroup.value ? allowedGroup.source : allowedGroup.source === 'draft' ? 'draft' : 'default',
      groupsClaim: groupsClaimSource,
      scope: scopeSource,
    },
  };
}
