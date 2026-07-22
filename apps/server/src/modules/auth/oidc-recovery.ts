import type { OidcRecoveryCategory } from '@campfire/schema';

export type OidcRecoveryStage = 'start' | 'callback';

export interface OidcRecoveryClassification {
  category: OidcRecoveryCategory;
  /** Fixed, server-authored code safe to include in redacted diagnostics. */
  diagnosticCode: string;
  /** Coarse allowlisted type; never an exception message or provider value. */
  errorType: string;
}

/**
 * Expected application-level OIDC failure. `diagnosticCode` must be a fixed
 * server-authored literal; `cause` is retained for stack context only and is
 * never serialized into redirects or diagnostics.
 */
export class OidcRecoveryFailure extends Error {
  constructor(
    readonly category: OidcRecoveryCategory,
    readonly diagnosticCode: string,
    options?: { cause?: unknown },
  ) {
    super('OIDC sign-in could not be completed', options);
    this.name = 'OidcRecoveryFailure';
  }
}

function field(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function safeErrorType(error: unknown): string {
  if (error instanceof OidcRecoveryFailure) return 'OidcRecoveryFailure';
  if (error instanceof TypeError) return 'TypeError';
  if (!(error instanceof Error)) return 'NonError';

  // These are library/framework class names, not provider-controlled payloads.
  const allowlist = new Set([
    'AuthorizationResponseError',
    'ClientError',
    'ForbiddenException',
    'ResponseBodyError',
    'ServiceUnavailableException',
    'WWWAuthenticateChallengeError',
  ]);
  return allowlist.has(error.name) ? error.name : 'Error';
}

/**
 * Collapses library/network failures into the public eight-category contract.
 * Classification may inspect protocol codes, but only fixed diagnostic codes
 * leave this function; provider descriptions/bodies and exception messages do
 * not.
 */
export function classifyOidcRecovery(
  error: unknown,
  stage: OidcRecoveryStage,
): OidcRecoveryClassification {
  const errorType = safeErrorType(error);
  if (error instanceof OidcRecoveryFailure) {
    return {
      category: error.category,
      diagnosticCode: error.diagnosticCode,
      errorType,
    };
  }

  const name = field(error, 'name');
  const oauthError = field(error, 'error');
  const code = field(error, 'code');
  const status = field(error, 'status');

  if (name === 'AuthorizationResponseError') {
    if (oauthError === 'access_denied') {
      return { category: 'cancelled', diagnosticCode: 'authorization_cancelled', errorType };
    }
    if (oauthError === 'temporarily_unavailable' || oauthError === 'server_error') {
      return { category: 'provider_unavailable', diagnosticCode: 'authorization_provider_unavailable', errorType };
    }
    return { category: 'client_token_failure', diagnosticCode: 'authorization_response_rejected', errorType };
  }

  if (name === 'ResponseBodyError') {
    if (oauthError === 'invalid_grant') {
      return { category: 'state_pkce_mismatch', diagnosticCode: 'token_invalid_grant', errorType };
    }
    if (
      oauthError === 'temporarily_unavailable'
      || oauthError === 'server_error'
      || (typeof status === 'number' && status >= 500)
    ) {
      return { category: 'provider_unavailable', diagnosticCode: 'token_provider_unavailable', errorType };
    }
    return { category: 'client_token_failure', diagnosticCode: 'token_endpoint_rejected', errorType };
  }

  if (
    name === 'WWWAuthenticateChallengeError'
    || name === 'ClientError'
    || code === 'OAUTH_INVALID_RESPONSE'
  ) {
    if (code === 'OAUTH_TIMEOUT' || code === 'OAUTH_ABORT') {
      return { category: 'provider_unavailable', diagnosticCode: 'provider_request_interrupted', errorType };
    }
    return { category: 'client_token_failure', diagnosticCode: 'oidc_client_validation_failed', errorType };
  }

  if (error instanceof TypeError || name === 'ServiceUnavailableException') {
    return { category: 'provider_unavailable', diagnosticCode: 'provider_request_failed', errorType };
  }

  return {
    category: 'client_token_failure',
    diagnosticCode: stage === 'start' ? 'authorization_start_failed' : 'callback_processing_failed',
    errorType,
  };
}
