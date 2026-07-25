/**
 * Shared recap invalid-link accessibility contracts (issue #482).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHARED_RECAP_PAGE = resolve(__dirname, '../../src/features/sessions/SharedRecapPage.tsx');

test.describe('shared recap invalid link (issue #482)', () => {
  test('unavailable branch exposes h1, alert semantics, and recovery navigation', () => {
    const page = readFileSync(SHARED_RECAP_PAGE, 'utf8');
    expect(page).toMatch(/role="alert"/);
    expect(page).toMatch(/<h1/);
    expect(page).toMatch(/shareInactiveTitle/);
    expect(page).toMatch(/shareInactiveHome/);
    expect(page).toMatch(/shareInactiveSignIn/);
    expect(page).toMatch(/loginHrefWithReturn/);
    expect(page).toMatch(/role="status"/);
    expect(page).toMatch(/aria-live="polite"/);
    expect(page).toMatch(/data-testid="shared-recap-unavailable"/);
  });
});
