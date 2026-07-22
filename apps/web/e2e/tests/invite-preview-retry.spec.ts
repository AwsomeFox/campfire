import { expect, test, type Page } from '@playwright/test';

/**
 * Issue #709 - invite preview recovery.
 *
 * The join page used to be a one-shot request: a transient failure (network,
 * 5xx, 429) showed only "Go to sign in," abandoning the join link entirely.
 * Now transient failures surface a Retry that re-resolves the SAME code, and
 * only persistent failures (404 invalid/expired/used) show the definitive
 * error with no retry.
 *
 * The join page is public, so each test mocks `/me` to 401 (signed out) and
 * drives the preview endpoint (`GET /api/v1/invites/:code`) through the
 * transient -> retry -> success lifecycle, plus the 404 persistent case.
 */

const INVITE_CODE = 'TESTCODE709';
const INVITE_URL = `**/api/v1/invites/${INVITE_CODE}`;
const CAMPAIGN_NAME = 'Issue 709 Campaign';

const INVITE_PREVIEW_BODY = {
  campaignId: 709,
  campaignName: CAMPAIGN_NAME,
  role: 'player',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

/** Mock the signed-out auth state so JoinPage renders the preview-only view. */
async function mockSignedOut(page: Page): Promise<void> {
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({ status: 401, json: { message: 'Unauthorized' } }),
  );
}

test.describe('issue #709 - invite preview retry', () => {
  test('transient 503 -> Retry -> success, join link preserved', async ({ page }) => {
    await mockSignedOut(page);

    // First load: the server is briefly unavailable (503). Retry must re-fetch
    // the SAME code rather than bouncing the user to sign-in.
    let attempts = 0;
    await page.route(INVITE_URL, (route) => {
      attempts += 1;
      if (attempts === 1) {
        return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
      }
      return route.fulfill({ status: 200, json: INVITE_PREVIEW_BODY });
    });

    await page.goto(`/join/${INVITE_CODE}`);

    // The transient error is announced (role=alert) and a Retry is offered
    // alongside it. Match on the apostrophe-free tail of the message so the
    // assertion is robust to curly vs straight quote rendering. The Retry
    // button is a sibling of the alert (same card), so query at page scope.
    const alert = page.getByRole('alert').filter({ hasText: 'load this invite.' });
    await expect(alert).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();

    // Retry re-resolves the SAME code and the invite preview renders.
    await retry.click();
    await expect(page.getByRole('heading', { name: `You’re invited to ${CAMPAIGN_NAME}` })).toBeVisible();
    // The transient error is gone.
    await expect(page.getByRole('alert').filter({ hasText: 'load this invite.' })).toHaveCount(0);
  });

  test('network failure (fetch rejects) -> Retry -> success', async ({ page }) => {
    await mockSignedOut(page);

    // A network/DNS/offline failure surfaces as a fetch rejection (no HTTP
    // status). This must be treated as transient - there is no definitive
    // answer to honor.
    let attempts = 0;
    await page.route(INVITE_URL, (route) => {
      attempts += 1;
      if (attempts === 1) {
        return route.abort('internetdisconnected');
      }
      return route.fulfill({ status: 200, json: INVITE_PREVIEW_BODY });
    });

    await page.goto(`/join/${INVITE_CODE}`);

    const alert = page.getByRole('alert').filter({ hasText: 'load this invite.' });
    await expect(alert).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();

    await retry.click();
    await expect(page.getByRole('heading', { name: `You’re invited to ${CAMPAIGN_NAME}` })).toBeVisible();
  });

  test('persistent 404 -> definitive error, no Retry', async ({ page }) => {
    await mockSignedOut(page);

    // Unknown/expired/used codes all collapse to 404 per the controller. This
    // is a definitive answer - retrying won't revive the invite.
    await page.route(INVITE_URL, (route) =>
      route.fulfill({ status: 404, json: { message: 'Not found' } }),
    );

    await page.goto(`/join/${INVITE_CODE}`);

    // The persistent error names the real reason.
    const alert = page.getByRole('alert').filter({ hasText: 'invalid or no longer active' });
    await expect(alert).toBeVisible();
    // No Retry affordance - retrying a 404 is a dead end.
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    // Sign in is offered as the only path forward.
    await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
  });
});
