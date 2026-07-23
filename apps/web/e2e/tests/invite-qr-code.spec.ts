import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #822 — QR-code handoff for in-room phone/tablet onboarding.
 *
 * Tests cover:
 * - QR renders for active invites
 * - QR is not scannable for expired/exhausted invites
 * - Full-screen display toggle (Escape and button to exit)
 * - Copy-link functionality
 * - Accessibility (axe check, aria-label on QR image)
 * - Narrow-screen responsive behavior
 */

const INVITE_API = (campaignId: number) => `**/api/v1/campaigns/${campaignId}/invites`;

const ACTIVE_INVITE = {
  id: 1,
  campaignId: 1,
  code: 'ACTIVE822TEST',
  role: 'player' as const,
  createdByUserId: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
  maxUses: 10,
  useCount: 2,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

const EXPIRED_INVITE = {
  id: 2,
  campaignId: 1,
  code: 'EXPIRED822TEST',
  role: 'viewer' as const,
  createdByUserId: 1,
  expiresAt: '2020-01-01T00:00:00.000Z',
  maxUses: null,
  useCount: 5,
  createdAt: '2019-12-01T00:00:00.000Z',
  updatedAt: '2019-12-01T00:00:00.000Z',
};

const EXHAUSTED_INVITE = {
  id: 3,
  campaignId: 1,
  code: 'EXHAUSTED822TEST',
  role: 'player' as const,
  createdByUserId: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
  maxUses: 5,
  useCount: 5,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

interface MockInvite {
  id: number;
  campaignId: number;
  code: string;
  role: 'player' | 'viewer';
  createdByUserId: number;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

async function mockInvites(page: Page, campaignId: number, invites: MockInvite[]) {
  await page.route(INVITE_API(campaignId), (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, json: invites });
    }
    return route.continue();
  });
}

test.describe('issue #822 — invite QR code card', () => {
  test.use({ storageState: stateFor('dm') });

  test('renders a QR code canvas for an active invite with correct aria-label', async ({ page }) => {
    const { campaignId } = seed();
    await mockInvites(page, campaignId, [ACTIVE_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    const qrCard = page.getByTestId('invite-qr-card');
    await expect(qrCard).toBeVisible();

    // QR canvas with accessible role and label
    const qrCanvas = qrCard.locator('canvas[role="img"]');
    await expect(qrCanvas).toBeVisible();
    await expect(qrCanvas).toHaveAttribute('aria-label', 'QR code for invite link');

    // No inactive overlay
    await expect(qrCard.getByTestId('qr-inactive-overlay')).toHaveCount(0);

    // Metadata displayed
    await expect(qrCard.getByText('Player')).toBeVisible();
    await expect(qrCard.getByText(/remaining/)).toBeVisible();
    await expect(qrCard.getByText(/Expires in/)).toBeVisible();

    // Bearer-link warning
    await expect(qrCard.getByRole('note')).toContainText('Bearer link');

    // URL fallback visible
    const urlInput = qrCard.locator('input[aria-label="Invite link URL"]');
    await expect(urlInput).toBeVisible();
    await expect(urlInput).toHaveValue(/\/join\/ACTIVE822TEST$/);
  });

  test('shows inactive overlay for expired invite — QR not scannable', async ({ page }) => {
    const { campaignId } = seed();
    await mockInvites(page, campaignId, [EXPIRED_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    const qrCard = page.getByTestId('invite-qr-card');
    await expect(qrCard).toBeVisible();
    await expect(qrCard).toHaveAttribute('data-invite-active', 'false');

    // Inactive overlay present
    const overlay = qrCard.getByTestId('qr-inactive-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Expired');

    // Action buttons disabled for inactive
    await expect(qrCard.getByRole('button', { name: 'Show QR code full screen' })).toBeDisabled();
    await expect(qrCard.getByRole('button', { name: 'Download QR code as PNG' })).toBeDisabled();
    await expect(qrCard.getByRole('button', { name: 'Print QR code' })).toBeDisabled();

    // Copy link still works (URL is still valuable for reference)
    await expect(qrCard.getByRole('button', { name: 'Copy invite link' })).toBeEnabled();
  });

  test('shows Exhausted status for invite at max uses', async ({ page }) => {
    const { campaignId } = seed();
    await mockInvites(page, campaignId, [EXHAUSTED_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    const qrCard = page.getByTestId('invite-qr-card');
    await expect(qrCard).toHaveAttribute('data-invite-active', 'false');

    const overlay = qrCard.getByTestId('qr-inactive-overlay');
    await expect(overlay).toContainText('Exhausted');
  });

  test('full-screen display toggles on button click and closes with Escape', async ({ page }) => {
    const { campaignId } = seed();
    await mockInvites(page, campaignId, [ACTIVE_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    const qrCard = page.getByTestId('invite-qr-card');
    await expect(qrCard).toBeVisible();

    // Open full screen
    await qrCard.getByRole('button', { name: 'Show QR code full screen' }).click();

    const fullscreen = page.getByTestId('qr-fullscreen');
    await expect(fullscreen).toBeVisible();
    await expect(fullscreen).toHaveAttribute('role', 'dialog');
    await expect(fullscreen).toHaveAttribute('aria-modal', 'true');

    // Full-screen has a larger QR canvas
    const fsCanvas = fullscreen.locator('canvas[role="img"]');
    await expect(fsCanvas).toBeVisible();

    // Close button present
    const closeBtn = fullscreen.getByRole('button', { name: 'Exit full screen' });
    await expect(closeBtn).toBeVisible();

    // Close with Escape
    await page.keyboard.press('Escape');
    await expect(fullscreen).toHaveCount(0);
  });

  test('full-screen closes when clicking the Close button', async ({ page }) => {
    const { campaignId } = seed();
    await mockInvites(page, campaignId, [ACTIVE_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    const qrCard = page.getByTestId('invite-qr-card');
    await qrCard.getByRole('button', { name: 'Show QR code full screen' }).click();

    const fullscreen = page.getByTestId('qr-fullscreen');
    await expect(fullscreen).toBeVisible();

    await fullscreen.getByRole('button', { name: 'Exit full screen' }).click();
    await expect(fullscreen).toHaveCount(0);
  });

  test('copy link writes the invite URL to clipboard', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const { campaignId } = seed();
    await mockInvites(page, campaignId, [ACTIVE_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    const qrCard = page.getByTestId('invite-qr-card');
    await qrCard.getByRole('button', { name: 'Copy invite link' }).click();

    // Button shows 'Copied!' feedback
    await expect(qrCard.getByRole('button', { name: 'Copy invite link' })).toContainText('Copied!');

    // Verify clipboard content
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toMatch(/\/join\/ACTIVE822TEST$/);
  });

  test('accessibility: axe scan passes on the QR card', async ({ page }) => {
    const { campaignId } = seed();
    await mockInvites(page, campaignId, [ACTIVE_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    await expect(page.getByTestId('invite-qr-card')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-testid="invite-qr-card"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('accessibility: QR image is not exposed as visual modules to screen readers', async ({ page }) => {
    const { campaignId } = seed();
    await mockInvites(page, campaignId, [ACTIVE_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    const qrCanvas = page.getByTestId('invite-qr-card').locator('canvas[role="img"]');
    await expect(qrCanvas).toHaveAttribute('aria-label', 'QR code for invite link');
    // The canvas does NOT have individual cell descriptions — just a concise label
    await expect(qrCanvas).not.toHaveAttribute('aria-describedby');
  });

  test('responsive: QR card renders correctly on narrow (mobile) viewport', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: stateFor('dm'),
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const { campaignId } = seed();
    await mockInvites(page, campaignId, [ACTIVE_INVITE]);
    await page.goto(`/c/${campaignId}/members`);

    const qrCard = page.getByTestId('invite-qr-card');
    await expect(qrCard).toBeVisible();
    await expect(qrCard).toBeInViewport();

    // QR canvas visible
    const qrCanvas = qrCard.locator('canvas[role="img"]');
    await expect(qrCanvas).toBeVisible();
    await expect(qrCanvas).toBeInViewport();

    // Action buttons all visible
    await expect(qrCard.getByRole('button', { name: 'Show QR code full screen' })).toBeInViewport();
    await expect(qrCard.getByRole('button', { name: 'Copy invite link' })).toBeInViewport();

    // axe clean on narrow viewport
    const results = await new AxeBuilder({ page })
      .include('[data-testid="invite-qr-card"]')
      .analyze();
    expect(results.violations).toEqual([]);

    await context.close();
  });
});
