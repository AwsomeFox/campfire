import { validateAiProviderOutboundUrl } from '../../src/common/ai-provider-outbound';

describe('validateAiProviderOutboundUrl undefined baseUrl', () => {
  it('treats undefined/null/empty as permitted (provider default endpoint)', async () => {
    expect((await validateAiProviderOutboundUrl(undefined)).ok).toBe(true);
    expect((await validateAiProviderOutboundUrl(null)).ok).toBe(true);
    expect((await validateAiProviderOutboundUrl('')).ok).toBe(true);
    expect((await validateAiProviderOutboundUrl('   ')).ok).toBe(true);
  });
});
