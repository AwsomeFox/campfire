import { Logger } from '@nestjs/common';
import { warnCampaignSearchFtsUnavailable } from '../../src/db/campaign-search-fts-mode';

/**
 * Issue #1481 — a deployment whose SQLite lacks the FTS5 extension silently ran
 * search on the slower full-scan fallback with no signal. The boot path must emit
 * a single, explicit warning naming the mode and where to read it. A real test
 * database bundles fts5, so the unavailable branch is exercised directly here.
 */
describe('warnCampaignSearchFtsUnavailable (issue #1481)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('is silent when FTS5 is available', () => {
    warnCampaignSearchFtsUnavailable(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits one warning naming the fallback mode and the /me diagnostic when unavailable', () => {
    warnCampaignSearchFtsUnavailable(false, 'no such module: fts5');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('fallback');
    expect(message).toContain('FTS5');
    expect(message).toContain('/me');
    expect(message).toContain('no such module: fts5');
  });

  it('warns without a detail string when none is available', () => {
    warnCampaignSearchFtsUnavailable(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
