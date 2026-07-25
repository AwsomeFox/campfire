import { formatRequestLog, redactLogSecrets } from '../../src/common/request-log';

describe('request-log (#684)', () => {
  it('redacts bearer tokens and PAT-shaped secrets without stray offset digits', () => {
    const raw = 'path=/api/v1/tokens Authorization: Bearer cf_pat_abcdef0123456789abcdef0123456789abcdef0123456789';
    const redacted = redactLogSecrets(raw);
    expect(redacted).not.toContain('cf_pat_');
    expect(redacted).toContain('<redacted>');
    expect(redacted).not.toMatch(/\d<redacted>/);
  });

  it('redacts OIDC callback query params from request paths', () => {
    const raw =
      'path=/api/v1/auth/oidc/callback?state=abc&error=access_denied&error_description=PROVIDER_PRIVATE_CANCELLATION_DETAIL&code=secret-code';
    const redacted = redactLogSecrets(raw);
    expect(redacted).not.toContain('PROVIDER_PRIVATE_CANCELLATION_DETAIL');
    expect(redacted).not.toContain('secret-code');
    expect(redacted).toContain('error_description=<redacted>');
    expect(redacted).toContain('code=<redacted>');
  });

  it('emits structured JSON with actor/campaign/tool/latency/result', () => {
    const line = formatRequestLog({
      requestId: 'corr-123',
      transport: 'mcp',
      result: 'ok',
      latencyMs: 42,
      actor: 'dev-user',
      campaignId: 3,
      tool: 'list_quests',
      status: 200,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      type: 'request',
      requestId: 'corr-123',
      transport: 'mcp',
      result: 'ok',
      latencyMs: 42,
      actor: 'dev-user',
      campaignId: 3,
      tool: 'list_quests',
      status: 200,
    });
  });
});
