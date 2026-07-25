import { formatRequestLog, redactLogSecrets } from '../../src/common/request-log';

describe('request-log (#684)', () => {
  it('redacts bearer tokens and PAT-shaped secrets', () => {
    const raw = 'path=/api/v1/tokens Authorization: Bearer cf_pat_abcdef0123456789abcdef0123456789abcdef0123456789';
    expect(redactLogSecrets(raw)).not.toContain('cf_pat_');
    expect(redactLogSecrets(raw)).toContain('<redacted>');
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
