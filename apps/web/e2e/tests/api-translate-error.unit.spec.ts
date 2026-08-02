/**
 * Unit spec for translateApiError i18n helper.
 */

import { expect, test } from '@playwright/test';
import { ApiError, translateApiError } from '../../src/lib/api';

test.describe('translateApiError', () => {
  // Mock translation function mimicking i18next behavior
  const mockTranslations: Record<string, string> = {
    'errors.bad_request': "That request wasn't valid.",
    'errors.not_found': 'Not found.',
    'errors.TURN_ALREADY_ADVANCED': 'Someone else already advanced the turn — resyncing.',
    'errors.STALE_WRITE': 'Someone else saved changes since you loaded — reload and try again.',
  };

  const t = (key: string, opts?: { defaultValue?: string }): string => {
    if (key in mockTranslations) return mockTranslations[key];
    return opts?.defaultValue ?? key;
  };

  test('prefers err.message over generic HTTP category translation (e.g. bad_request)', () => {
    const err = new ApiError(
      400,
      'All combatants must have initiative rolled before starting the encounter',
      [],
      'bad_request',
    );
    const result = translateApiError(err, t);
    expect(result).toBe('All combatants must have initiative rolled before starting the encounter');
  });

  test('uses translation catalog for domain-specific error codes (e.g. TURN_ALREADY_ADVANCED)', () => {
    const err = new ApiError(409, 'Turn already advanced on server', [], 'TURN_ALREADY_ADVANCED');
    const result = translateApiError(err, t);
    expect(result).toBe('Someone else already advanced the turn — resyncing.');
  });

  test('falls back to err.message when domain code has no translation key', () => {
    const err = new ApiError(400, 'Custom domain constraint failed', [], 'UNKNOWN_DOMAIN_CODE');
    const result = translateApiError(err, t);
    expect(result).toBe('Custom domain constraint failed');
  });

  test('handles non-ApiError instances', () => {
    const err = new Error('Network request failed');
    const result = translateApiError(err, t);
    expect(result).toBe('Network request failed');
  });
});
