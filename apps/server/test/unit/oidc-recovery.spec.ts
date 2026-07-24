import {
  classifyOidcRecovery,
  OidcRecoveryFailure,
} from '../../src/modules/auth/oidc-recovery';

describe('classifyOidcRecovery', () => {
  it('passes through OidcRecoveryFailure category and diagnostic code', () => {
    const err = new OidcRecoveryFailure('flow_expired', 'flow_cookie_missing_or_invalid');
    expect(classifyOidcRecovery(err, 'callback')).toEqual({
      category: 'flow_expired',
      diagnosticCode: 'flow_cookie_missing_or_invalid',
      errorType: 'OidcRecoveryFailure',
    });
  });

  it('maps AuthorizationResponseError access_denied to cancelled', () => {
    const err = Object.assign(new Error('denied'), {
      name: 'AuthorizationResponseError',
      error: 'access_denied',
    });
    expect(classifyOidcRecovery(err, 'callback').category).toBe('cancelled');
  });

  it('maps AuthorizationResponseError server_error to provider_unavailable', () => {
    const err = Object.assign(new Error('down'), {
      name: 'AuthorizationResponseError',
      error: 'server_error',
    });
    expect(classifyOidcRecovery(err, 'callback').category).toBe('provider_unavailable');
  });

  it('maps ResponseBodyError invalid_grant to state_pkce_mismatch', () => {
    const err = Object.assign(new Error('grant'), {
      name: 'ResponseBodyError',
      error: 'invalid_grant',
    });
    expect(classifyOidcRecovery(err, 'callback').category).toBe('state_pkce_mismatch');
  });

  it('maps ResponseBodyError 5xx to provider_unavailable', () => {
    const err = Object.assign(new Error('5xx'), {
      name: 'ResponseBodyError',
      error: 'other',
      status: 503,
    });
    expect(classifyOidcRecovery(err, 'callback').category).toBe('provider_unavailable');
  });

  it('maps ClientError / WWWAuthenticateChallengeError to client_token_failure', () => {
    const clientErr = Object.assign(new Error('client'), { name: 'ClientError' });
    expect(classifyOidcRecovery(clientErr, 'callback').category).toBe('client_token_failure');

    const challenge = Object.assign(new Error('challenge'), {
      name: 'WWWAuthenticateChallengeError',
    });
    expect(classifyOidcRecovery(challenge, 'callback').category).toBe('client_token_failure');
  });

  it('maps TypeError and ServiceUnavailableException to provider_unavailable', () => {
    expect(classifyOidcRecovery(new TypeError('fetch failed'), 'start').category).toBe(
      'provider_unavailable',
    );
    const unavailable = Object.assign(new Error('down'), {
      name: 'ServiceUnavailableException',
    });
    expect(classifyOidcRecovery(unavailable, 'callback').category).toBe('provider_unavailable');
  });

  it('uses stage-specific fallback diagnostic codes', () => {
    expect(classifyOidcRecovery(new Error('boom'), 'start').diagnosticCode).toBe(
      'authorization_start_failed',
    );
    expect(classifyOidcRecovery(new Error('boom'), 'callback').diagnosticCode).toBe(
      'callback_processing_failed',
    );
    expect(classifyOidcRecovery('string-error', 'callback').errorType).toBe('NonError');
  });
});
