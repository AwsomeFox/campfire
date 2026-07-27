import { describe, expect, it } from '@jest/globals';
import { provenanceEndpointBaseUrl } from '../../src/common/ai-provenance-endpoint';

/**
 * Issue #501 review — durable provenance must not disclose the admin-managed SERVER
 * endpoint to campaign DMs.
 *
 * `getEffectiveView` deliberately withholds the server row's `baseUrl` from a campaign DM,
 * but generation provenance is persisted on scribe jobs and filed proposals, both of which
 * DMs can read. This helper is the single write-time gate shared by the scribe and co-DM
 * paths, so it is pinned directly as well as end-to-end.
 */
describe('provenance endpoint baseUrl disclosure (#501)', () => {
  it('keeps a campaign-scope baseUrl — the DM configured it and can already read it', () => {
    expect(provenanceEndpointBaseUrl('campaign', 'https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  it('drops a server-scope baseUrl — the admin endpoint is hidden from campaign DMs', () => {
    expect(provenanceEndpointBaseUrl('server', 'http://internal-gateway.example.com/v1')).toBeNull();
  });

  it('drops the baseUrl for the no-send seams too, where it is meaningless', () => {
    expect(provenanceEndpointBaseUrl('injected', 'http://whatever')).toBeNull();
    expect(provenanceEndpointBaseUrl('none', 'http://whatever')).toBeNull();
  });

  it('normalizes an absent campaign baseUrl to null rather than undefined', () => {
    expect(provenanceEndpointBaseUrl('campaign', undefined)).toBeNull();
    expect(provenanceEndpointBaseUrl('campaign', null)).toBeNull();
  });

  it('fails closed for any scope that is not explicitly campaign', () => {
    // A future endpoint scope must default to NOT disclosing the URL.
    expect(provenanceEndpointBaseUrl('some_future_scope' as never, 'http://secret.internal')).toBeNull();
  });
});
