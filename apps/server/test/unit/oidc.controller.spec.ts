import { OidcController } from '../../src/modules/auth/oidc.controller';
import type { OidcService } from '../../src/modules/auth/oidc.service';
import type { AuthService } from '../../src/modules/auth/auth.service';
import type { Request, Response } from 'express';
import {
  OIDC_FLOW_COOKIE_NAME,
  OIDC_RETURN_COOKIE_NAME,
  OIDC_TEST_FLOW_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/modules/auth/auth.constants';

function mockRes() {
  const res = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  };
  return res as unknown as Response & {
    cookie: jest.Mock;
    clearCookie: jest.Mock;
    redirect: jest.Mock;
  };
}

describe('OidcController callback diagnostic routing (issue #848)', () => {
  let oidc: {
    matchesActiveTestLogin: jest.Mock;
    completeTestLogin: jest.Mock;
    isEnabled: jest.Mock;
    getEffectiveConfig: jest.Mock;
    handleCallback: jest.Mock;
    provisionOrUpdateUser: jest.Mock;
    buildAuthorizationRequest: jest.Mock;
  };
  let auth: { issueSessionFor: jest.Mock };
  let controller: OidcController;

  beforeEach(() => {
    oidc = {
      matchesActiveTestLogin: jest.fn(),
      completeTestLogin: jest.fn(),
      isEnabled: jest.fn(),
      getEffectiveConfig: jest.fn(),
      handleCallback: jest.fn(),
      provisionOrUpdateUser: jest.fn(),
      buildAuthorizationRequest: jest.fn(),
    };
    auth = { issueSessionFor: jest.fn() };
    controller = new OidcController(oidc as unknown as OidcService, auth as unknown as AuthService);
  });

  it('routes to diagnostics only when pending state matches callback state', async () => {
    oidc.matchesActiveTestLogin.mockResolvedValue(true);
    oidc.completeTestLogin.mockResolvedValue({ ok: true });
    const res = mockRes();
    const req = {
      cookies: { [OIDC_TEST_FLOW_COOKIE_NAME]: 'test-token' },
      query: { state: 'diag-state', code: 'abc' },
    } as unknown as Request;

    await controller.callback(req, res);

    expect(oidc.matchesActiveTestLogin).toHaveBeenCalledWith('test-token', 'diag-state');
    expect(oidc.completeTestLogin).toHaveBeenCalledWith('test-token', req.query);
    expect(res.clearCookie).toHaveBeenCalledWith(OIDC_TEST_FLOW_COOKIE_NAME, {
      path: '/api/v1/auth/oidc',
    });
    expect(res.redirect).toHaveBeenCalledWith(302, '/admin/auth?oidcDiag=1');
    expect(auth.issueSessionFor).not.toHaveBeenCalled();
  });

  it('does not hijack normal SSO when test cookie state does not match', async () => {
    oidc.matchesActiveTestLogin.mockResolvedValue(false);
    oidc.isEnabled.mockResolvedValue(true);
    oidc.getEffectiveConfig.mockResolvedValue({
      redirectUri: 'https://app.example.com/api/v1/auth/oidc/callback',
    });
    oidc.handleCallback.mockResolvedValue({ sub: 'u1' });
    oidc.provisionOrUpdateUser.mockResolvedValue({ id: 9, disabled: false });
    auth.issueSessionFor.mockResolvedValue({ token: 'session-token' });

    const state = 'normal-state';
    const res = mockRes();
    const req = {
      cookies: {
        [OIDC_TEST_FLOW_COOKIE_NAME]: 'stale-test-token',
        [OIDC_FLOW_COOKIE_NAME]: `${state}:verifier`,
        [OIDC_RETURN_COOKIE_NAME]: '/join/abc',
      },
      query: { state, code: 'abc' },
    } as unknown as Request;

    await controller.callback(req, res);

    expect(oidc.completeTestLogin).not.toHaveBeenCalled();
    expect(oidc.handleCallback).toHaveBeenCalled();
    expect(auth.issueSessionFor).toHaveBeenCalledWith(9);
    expect(res.cookie).toHaveBeenCalledWith(
      SESSION_COOKIE_NAME,
      'session-token',
      expect.any(Object),
    );
    expect(res.redirect).toHaveBeenCalledWith('/join/abc');
  });
});
