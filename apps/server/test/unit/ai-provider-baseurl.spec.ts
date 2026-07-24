import {
  AI_PROVIDER_PROBE_GENERIC_ERROR,
  classifyAiProviderHostname,
  evaluateAiProviderBaseUrl,
  resolveAiProviderBaseUrlPolicy,
  type AiProviderBaseUrlPolicy,
} from '../../src/common/ai-provider-baseurl';

/**
 * SSRF host policy for AI provider baseUrl (issue #1064).
 * Pure helpers — no Nest bootstrap.
 */
describe('classifyAiProviderHostname (issue #1064)', () => {
  it('classifies public hosts', () => {
    expect(classifyAiProviderHostname('api.openai.com')).toBe('public');
    expect(classifyAiProviderHostname('openrouter.ai')).toBe('public');
    expect(classifyAiProviderHostname('8.8.8.8')).toBe('public');
  });

  it('classifies loopback / localhost', () => {
    expect(classifyAiProviderHostname('127.0.0.1')).toBe('loopback');
    expect(classifyAiProviderHostname('localhost')).toBe('loopback');
    expect(classifyAiProviderHostname('foo.localhost')).toBe('loopback');
    expect(classifyAiProviderHostname('::1')).toBe('loopback');
  });

  it('classifies private RFC1918 / ULA ranges', () => {
    expect(classifyAiProviderHostname('10.0.0.5')).toBe('private');
    expect(classifyAiProviderHostname('172.16.1.2')).toBe('private');
    expect(classifyAiProviderHostname('192.168.1.10')).toBe('private');
    expect(classifyAiProviderHostname('fd12:3456:789a::1')).toBe('private');
  });

  it('classifies link-local and cloud metadata as blocked classes', () => {
    expect(classifyAiProviderHostname('169.254.169.254')).toBe('metadata');
    expect(classifyAiProviderHostname('169.254.1.1')).toBe('link-local');
    expect(classifyAiProviderHostname('metadata.google.internal')).toBe('metadata');
    expect(classifyAiProviderHostname('100.100.100.200')).toBe('metadata');
    expect(classifyAiProviderHostname('fe80::1')).toBe('link-local');
  });

  it('normalizes IPv4-mapped IPv6 loopback', () => {
    expect(classifyAiProviderHostname('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyAiProviderHostname('::ffff:7f00:1')).toBe('loopback');
  });
});

describe('evaluateAiProviderBaseUrl (issue #1064)', () => {
  const locked: AiProviderBaseUrlPolicy = {
    allowPrivateHosts: false,
    allowHosts: [],
    denyHosts: [],
  };
  const privateOk: AiProviderBaseUrlPolicy = {
    allowPrivateHosts: true,
    allowHosts: [],
    denyHosts: [],
  };

  it('allows omitted / empty baseUrl (provider default endpoint)', () => {
    expect(evaluateAiProviderBaseUrl(undefined, locked).ok).toBe(true);
    expect(evaluateAiProviderBaseUrl('', locked).ok).toBe(true);
    expect(evaluateAiProviderBaseUrl('   ', locked).ok).toBe(true);
  });

  it('allows a public https host by default', () => {
    const d = evaluateAiProviderBaseUrl('https://api.openai.com/v1', locked);
    expect(d.ok).toBe(true);
    expect(d.hostClass).toBe('public');
    expect(d.hostname).toBe('api.openai.com');
  });

  it('blocks cloud metadata IP even when private hosts are opted in', () => {
    const d = evaluateAiProviderBaseUrl('http://169.254.169.254/latest/meta-data/', privateOk);
    expect(d.ok).toBe(false);
    expect(d.hostClass).toBe('metadata');
  });

  it('blocks private ranges by default and allows them when opted in', () => {
    expect(evaluateAiProviderBaseUrl('http://192.168.1.50:11434', locked).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('http://10.0.0.2/v1', locked).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('http://127.0.0.1:11434/v1', locked).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('http://localhost:11434/v1', locked).ok).toBe(false);

    expect(evaluateAiProviderBaseUrl('http://192.168.1.50:11434', privateOk).ok).toBe(true);
    expect(evaluateAiProviderBaseUrl('http://127.0.0.1:11434/v1', privateOk).ok).toBe(true);
    expect(evaluateAiProviderBaseUrl('http://localhost:11434/v1', privateOk).ok).toBe(true);
  });

  it('never allows link-local even with private opt-in', () => {
    expect(evaluateAiProviderBaseUrl('http://169.254.1.1/', privateOk).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('http://[fe80::1]/', privateOk).ok).toBe(false);
  });

  it('honors operator deny list', () => {
    const policy: AiProviderBaseUrlPolicy = {
      allowPrivateHosts: false,
      allowHosts: [],
      denyHosts: ['evil.example', 'api.openai.com'],
    };
    expect(evaluateAiProviderBaseUrl('https://evil.example/v1', policy).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('https://api.openai.com/v1', policy).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('https://openrouter.ai/api/v1', policy).ok).toBe(true);
  });

  it('honors operator allow list (precise exception without blanket private opt-in)', () => {
    const policy: AiProviderBaseUrlPolicy = {
      allowPrivateHosts: false,
      allowHosts: ['localhost', 'ollama.home.arpa'],
      denyHosts: [],
    };
    expect(evaluateAiProviderBaseUrl('http://localhost:11434/v1', policy).ok).toBe(true);
    expect(evaluateAiProviderBaseUrl('http://ollama.home.arpa/v1', policy).ok).toBe(true);
    expect(evaluateAiProviderBaseUrl('https://api.openai.com/v1', policy).ok).toBe(false);
    // Metadata remains blocked even if listed.
    const metaListed: AiProviderBaseUrlPolicy = {
      allowPrivateHosts: true,
      allowHosts: ['169.254.169.254', 'metadata.google.internal'],
      denyHosts: [],
    };
    expect(evaluateAiProviderBaseUrl('http://169.254.169.254/', metaListed).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('http://metadata.google.internal/', metaListed).ok).toBe(false);
  });

  it('rejects Node-normalized loopback tricks when private hosts are locked', () => {
    // URL parser collapses these to 127.0.0.1 before classification.
    expect(evaluateAiProviderBaseUrl('http://2130706433/', locked).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('http://127.1/', locked).ok).toBe(false);
    expect(evaluateAiProviderBaseUrl('http://0x7f000001/', locked).ok).toBe(false);
  });
});

describe('resolveAiProviderBaseUrlPolicy env parsing', () => {
  it('parses allow/deny lists and the private opt-in flag', () => {
    const policy = resolveAiProviderBaseUrlPolicy({
      AI_PROVIDER_ALLOW_PRIVATE_HOSTS: 'true',
      AI_PROVIDER_BASEURL_ALLOW_HOSTS: ' Localhost , ollama.home.arpa ',
      AI_PROVIDER_BASEURL_DENY_HOSTS: 'evil.example',
    } as NodeJS.ProcessEnv);
    expect(policy.allowPrivateHosts).toBe(true);
    expect(policy.allowHosts).toEqual(['localhost', 'ollama.home.arpa']);
    expect(policy.denyHosts).toEqual(['evil.example']);
  });

  it('exports a stable generic probe error constant', () => {
    expect(AI_PROVIDER_PROBE_GENERIC_ERROR).toBe('Provider connection failed.');
  });
});
