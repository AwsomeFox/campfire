/**
 * Pure helpers for OIDC admin diagnostics (issue #848).
 *
 * Kept free of Nest/openid-client so unit tests can cover issuer equality,
 * endpoint URL checks, fingerprints, and group-policy evaluation without
 * booting the app.
 */
import { createHash } from 'node:crypto';
import type { OidcCheckResult, OidcConfigValueSource } from '@campfire/schema';

export type OidcDiagnosticField =
  | 'issuer'
  | 'clientId'
  | 'clientSecret'
  | 'redirectUri'
  | 'adminGroup'
  | 'allowedGroup'
  | 'groupsClaim'
  | 'scope';

export type OidcFieldSources = Record<OidcDiagnosticField, OidcConfigValueSource>;

/** Candidate values resolved for a diagnostic probe (may be incomplete). */
export interface OidcDiagnosticCandidate {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  adminGroup: string;
  allowedGroup: string;
  groupsClaim: string;
  scope: string;
  fieldSources: OidcFieldSources;
}

/** Strip trailing slashes for canonical issuer comparison (OIDC issuer equality). */
export function canonicalIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

/** True when two issuer strings are equal under OIDC canonicalization. */
export function issuersMatch(configured: string, discovered: string): boolean {
  return canonicalIssuer(configured) === canonicalIssuer(discovered);
}

/** Absolute http(s) URL check for authorization/token endpoints. */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Non-secret fingerprint of a diagnostic candidate. Includes whether a client
 * secret is present, never the secret value itself.
 */
export function oidcConfigFingerprint(candidate: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  adminGroup: string;
  allowedGroup: string;
  groupsClaim: string;
  scope: string;
}): string {
  const material = [
    canonicalIssuer(candidate.issuer),
    candidate.clientId.trim(),
    candidate.clientSecret.trim() ? 'secret:set' : 'secret:absent',
    candidate.redirectUri.trim(),
    candidate.adminGroup.trim(),
    candidate.allowedGroup.trim(),
    (candidate.groupsClaim.trim() || 'groups'),
    (candidate.scope.trim() || 'openid profile email'),
  ].join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function checkPass(message: string): OidcCheckResult {
  return { status: 'pass', message };
}

export function checkFail(message: string): OidcCheckResult {
  return { status: 'fail', message };
}

export function checkSkip(message: string): OidcCheckResult {
  return { status: 'skip', message };
}

/**
 * Evaluates allowed/admin group policy against claim groups without provisioning.
 * When no allowed group is configured, any authenticated subject is accepted.
 */
export function evaluateGroupPolicy(
  groups: string[],
  adminGroup: string | null,
  allowedGroup: string | null,
): OidcCheckResult {
  if (allowedGroup === null) {
    return checkPass(
      adminGroup
        ? `No allowed-group restriction; admin group "${adminGroup}" would grant server-admin when present.`
        : 'No allowed-group or admin-group restriction configured.',
    );
  }
  const isAdmin = adminGroup !== null && groups.includes(adminGroup);
  const isAllowed = groups.includes(allowedGroup);
  if (isAllowed || isAdmin) {
    return checkPass(
      isAdmin
        ? `Subject is in the admin group (allowed via admin bypass of "${allowedGroup}").`
        : `Subject is in the allowed group "${allowedGroup}".`,
    );
  }
  return checkFail(
    `Subject is not in the allowed group "${allowedGroup}"` +
      (adminGroup ? ` or admin group "${adminGroup}"` : '') +
      '.',
  );
}

/** Extract string groups from an ID-token claims object. */
export function groupsFromClaims(claims: Record<string, unknown>, groupsClaim: string): string[] {
  const raw = claims[groupsClaim];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
}
