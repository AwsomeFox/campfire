import dns from 'node:dns/promises';
import {
  createAiProviderGuardedFetch,
  validateAiProviderOutboundUrl,
} from '../../src/common/ai-provider-outbound';
import type { AiProviderBaseUrlPolicy } from '../../src/common/ai-provider-baseurl';

/**
 * Request-time SSRF guard for AI provider outbound HTTP (issue #570).
 */
describe('validateAiProviderOutboundUrl (issue #570)', () => {
  const locked: AiProviderBaseUrlPolicy = {
    allowPrivateHosts: false,
    allowHosts: [],
    allowCidrs: [],
    denyHosts: [],
  };

  const originalLookup = dns.lookup;

  afterEach(() => {
    dns.lookup = originalLookup;
  });

  it('rejects hostnames that resolve to loopback (DNS rebinding defense)', async () => {
    dns.lookup = jest.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const decision = await validateAiProviderOutboundUrl('https://rebind.example/v1', locked);
    expect(decision.ok).toBe(false);
    expect(decision.hostClass).toBe('loopback');
  });

  it('rejects hostnames that resolve to cloud metadata', async () => {
    dns.lookup = jest.fn().mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const decision = await validateAiProviderOutboundUrl('https://evil-metadata.example/v1', locked);
    expect(decision.ok).toBe(false);
    expect(decision.hostClass).toBe('metadata');
  });

  it('allows hostnames that resolve to public addresses', async () => {
    dns.lookup = jest.fn().mockResolvedValue([{ address: '52.0.0.1', family: 4 }]);
    const decision = await validateAiProviderOutboundUrl('https://api.openai.com/v1', locked);
    expect(decision.ok).toBe(true);
  });

  it('allows private addresses when CIDR allowlist matches resolved IP', async () => {
    dns.lookup = jest.fn().mockResolvedValue([{ address: '192.168.1.42', family: 4 }]);
    const policy: AiProviderBaseUrlPolicy = {
      allowPrivateHosts: false,
      allowHosts: [],
      allowCidrs: ['192.168.1.0/24'],
      denyHosts: [],
    };
    const decision = await validateAiProviderOutboundUrl('http://ollama.lan:11434/v1', policy);
    expect(decision.ok).toBe(true);
  });
});

describe('createAiProviderGuardedFetch (issue #570)', () => {
  const originalFetch = globalThis.fetch;
  const originalLookup = dns.lookup;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    dns.lookup = originalLookup;
  });

  it('refuses HTTP redirects instead of following them', async () => {
    dns.lookup = jest.fn().mockResolvedValue([{ address: '52.0.0.1', family: 4 }]);
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: { get: (name: string) => (name === 'location' ? 'http://169.254.169.254/' : null) },
      text: async () => '',
      json: async () => ({}),
      body: null,
    }) as typeof fetch;

    const fetchImpl = createAiProviderGuardedFetch({
      allowPrivateHosts: false,
      allowHosts: [],
      allowCidrs: [],
      denyHosts: [],
    });

    await expect(
      fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {},
      }),
    ).rejects.toThrow(/redirects are not permitted/);
  });
});
