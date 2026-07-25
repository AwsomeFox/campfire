import dns from 'node:dns/promises';
import http from 'node:http';
import {
  createAiProviderGuardedFetch,
  validateAiProviderOutboundUrl,
} from '../../src/common/ai-provider-outbound';
import type { AiProviderBaseUrlPolicy } from '../../src/common/ai-provider-baseurl';
import { AiProviderError } from '../../src/modules/ai-dm/providers/errors';
import { postJson } from '../../src/modules/ai-dm/providers/http';

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
    expect(decision.hostClass).toBe('private');
    expect(decision.resolvedAddresses).toEqual(['192.168.1.42']);
  });
});

describe('createAiProviderGuardedFetch (issue #570)', () => {
  const originalLookup = dns.lookup;

  afterEach(() => {
    dns.lookup = originalLookup;
  });

  it('refuses HTTP redirects instead of following them', async () => {
    dns.lookup = jest.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected bound port');
    const url = `http://127.0.0.1:${addr.port}/v1/chat/completions`;

    const fetchImpl = createAiProviderGuardedFetch({
      allowPrivateHosts: true,
      allowHosts: [],
      allowCidrs: [],
      denyHosts: [],
    });

    try {
      await expect(
        fetchImpl(url, {
          method: 'POST',
          headers: {},
        }),
      ).rejects.toThrow(/redirects are not permitted/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('does not retry blocked outbound URLs through postJson', async () => {
    dns.lookup = jest.fn().mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const fetchImpl = createAiProviderGuardedFetch({
      allowPrivateHosts: false,
      allowHosts: [],
      allowCidrs: [],
      denyHosts: [],
    });
    let attempts = 0;
    const countingFetch = async (...args: Parameters<typeof fetchImpl>) => {
      attempts += 1;
      return fetchImpl(...args);
    };

    await expect(
      postJson(
        countingFetch,
        'https://evil-metadata.example/v1/chat/completions',
        {},
        {},
        { provider: 'openai', timeoutMs: 1000, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 } },
      ),
    ).rejects.toMatchObject({ retryable: false } satisfies Partial<AiProviderError>);

    expect(attempts).toBe(1);
  });
});
