/**
 * Env-gated OIDC configuration. `oidcEnabled()` is true only when all three
 * core vars are set — this single predicate drives AuthStatus.oidcEnabled,
 * whether the OIDC controller's routes function or 404-equivalent (503), and
 * whether OidcService attempts discovery at all.
 */
export interface OidcEnvConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  adminGroup: string | null;
  groupsClaim: string;
  scope: string;
}

function appUrl(): string {
  return process.env.APP_URL || 'http://localhost:8080';
}

export function readOidcEnvConfig(): OidcEnvConfig | null {
  const issuer = process.env.OIDC_ISSUER?.trim();
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;

  const redirectUri = process.env.OIDC_REDIRECT_URI?.trim() || `${appUrl()}/api/v1/auth/oidc/callback`;
  const adminGroup = process.env.OIDC_ADMIN_GROUP?.trim() || null;
  const groupsClaim = process.env.OIDC_GROUPS_CLAIM?.trim() || 'groups';
  const scope = process.env.OIDC_SCOPE?.trim() || 'openid profile email';

  return { issuer, clientId, clientSecret, redirectUri, adminGroup, groupsClaim, scope };
}

export function oidcEnabled(): boolean {
  return readOidcEnvConfig() !== null;
}
