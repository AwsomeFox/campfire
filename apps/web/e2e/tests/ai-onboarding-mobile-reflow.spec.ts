import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { Campaign } from '@campfire/schema';
import { stateFor } from './seed';

/**
 * Issue #675 — the collapsed AI-DM onboarding hint (`AiDmDashboardOnboarding`)
 * used to keep its icon, copy, and the two action buttons in one `flex-wrap`
 * row. Because the copy block carries `min-w-0` it shrank to an unreadable
 * ~73px-wide column at 390px while the buttons held ~199px. The fix stacks the
 * action row UNDER the icon + copy on mobile (`flex-col ... sm:flex-row`) and
 * makes the buttons share the full row width, so the copy never collapses.
 *
 * This spec pins that reflow: at 320px and 390px the copy keeps a readable
 * width, the buttons sit below the copy (not beside it) at full row width, the
 * card never overflows the viewport, and the card stays axe-clean. Above the
 * `sm` breakpoint the inline row is preserved.
 */

const VIEWPORTS = [
  { name: '320px', width: 320, height: 720 },
  { name: '390px', width: 390, height: 844 },
];

async function json<T>(response: APIResponse, operation: string): Promise<T> {
  if (!response.ok()) throw new Error(`${operation} -> ${response.status()}: ${await response.text()}`);
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function createCampaignWithSeatOff(request: APIRequestContext): Promise<Campaign> {
  // A brand-new campaign defaults to an off AI-DM seat, but PUT it explicitly
  // so the assertion is robust against any future seed/default drift.
  const campaign = await json<Campaign>(
    await request.post('/api/v1/campaigns', { data: { name: `E2E675 Onboarding ${Date.now()}` } }),
    'create E2E675 onboarding campaign',
  );
  await json<unknown>(
    await request.put(`/api/v1/campaigns/${campaign.id}/ai-dm`, { data: { mode: 'off' } }),
    'force E2E675 seat off',
  );
  return campaign;
}

test.describe('AI-DM onboarding hint mobile reflow (#675)', () => {
  test.use({ storageState: stateFor('dm') });

  for (const viewport of VIEWPORTS) {
    test(`stacks actions under the copy and keeps it readable at ${viewport.name}`, async ({ page, request }) => {
      // Clear any per-campaign dismissal so the hint is guaranteed to render.
      await page.addInitScript(() => {
        try {
          for (let i = localStorage.length - 1; i >= 0; i -= 1) {
            const key = localStorage.key(i);
            if (key && key.startsWith('cf.aiOnboarding.dismissed.')) localStorage.removeItem(key);
          }
        } catch {
          /* localStorage unavailable — non-fatal */
        }
      });

      const campaign = await createCampaignWithSeatOff(request);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/c/${campaign.id}`);

      const card = page.locator('section.cf-card', {
        has: page.getByText('Try the AI Dungeon Master', { exact: true }),
      });
      await expect(card).toBeVisible();
      await expect(card.getByRole('button', { name: 'Set it up' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Not now' })).toBeVisible();

      // The hint body is the copy that used to collapse to ~73px. It must now
      // have a comfortably readable width — well above that failure floor.
      const copy = card.getByText('This campaign can run an AI co-DM', { exact: false });
      const copyBox = await copy.boundingBox();
      expect(copyBox).not.toBeNull();
      expect(copyBox!.width, 'copy must stay readable, not collapse to a narrow column').toBeGreaterThanOrEqual(220);

      // The buttons must sit BELOW the copy (stacked), not beside it. The top
      // edge of every action button must begin at or below the bottom edge of
      // the copy block.
      const setUpButton = card.getByRole('button', { name: 'Set it up' });
      const hideButton = card.getByRole('button', { name: 'Not now' });
      const setUpBox = await setUpButton.boundingBox();
      const hideBox = await hideButton.boundingBox();
      expect(setUpBox).not.toBeNull();
      expect(hideBox).not.toBeNull();
      expect(setUpBox!.y, 'actions must stack below the copy on mobile').toBeGreaterThanOrEqual(copyBox!.y + copyBox!.height - 1);
      expect(hideBox!.y).toBeGreaterThanOrEqual(copyBox!.y + copyBox!.height - 1);

      // The two buttons share the row width and together span it — neither is
      // crammed into the copy's column. Each must be at least a third of the
      // viewport so a finger finds them, and their row must be wider than the
      // old collapsed single-column copy.
      expect(setUpBox!.width, 'buttons must take a meaningful share of the row').toBeGreaterThanOrEqual(viewport.width / 3);
      expect(hideBox!.width).toBeGreaterThanOrEqual(viewport.width / 3);
      expect(setUpBox!.y).toBeCloseTo(hideBox!.y, 0);

      // The card must never cause horizontal overflow at this mobile width.
      const metrics = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
      }));
      expect(metrics.documentWidth, 'card must not overflow the viewport').toBeLessThanOrEqual(metrics.viewportWidth);

      // Every control stays inside the viewport.
      for (const box of [setUpBox, hideBox, copyBox]) {
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
      }

      // Scope the scan to the onboarding card via its in-DOM id. AxeBuilder's
      // `.include()` takes a CSS selector string (not a Playwright Locator).
      await card.evaluate((node) => {
        node.id = 'e2e-675-onboarding-card';
      });
      const accessibilityScan = await new AxeBuilder({ page }).include('#e2e-675-onboarding-card').analyze();
      expect(accessibilityScan.violations).toEqual([]);
    });
  }

  test('keeps the inline icon + copy + actions row above the sm breakpoint', async ({ page, request }) => {
    await page.addInitScript(() => {
      try {
        for (let i = localStorage.length - 1; i >= 0; i -= 1) {
          const key = localStorage.key(i);
          if (key && key.startsWith('cf.aiOnboarding.dismissed.')) localStorage.removeItem(key);
        }
      } catch {
        /* localStorage unavailable — non-fatal */
      }
    });

    const campaign = await createCampaignWithSeatOff(request);
    // sm breakpoint is 640px. Just above it the row reverts to inline:
    // icon + copy + actions share one flex row, and the buttons are sized to
    // their content (sm:flex-none) rather than stretching across the row.
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`/c/${campaign.id}`);

    const card = page.locator('section.cf-card', {
      has: page.getByText('Try the AI Dungeon Master', { exact: true }),
    });
    await expect(card).toBeVisible();

    const copy = card.getByText('This campaign can run an AI co-DM', { exact: false });
    const setUpButton = card.getByRole('button', { name: 'Set it up' });
    await expect(copy).toBeVisible();
    await expect(setUpButton).toBeVisible();

    // Above `sm` the buttons do NOT stretch to fill the row (they are
    // `sm:flex-none`, content-sized). Their width must stay well under half
    // the viewport — the opposite of the mobile full-width split.
    const setUpBox = await setUpButton.boundingBox();
    expect(setUpBox).not.toBeNull();
    expect(setUpBox!.width, 'buttons stay content-sized above sm, not full-width').toBeLessThan(768 / 2);

    // And the card never overflows the viewport on desktop either.
    const metrics = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await card.evaluate((node) => {
      node.id = 'e2e-675-onboarding-card';
    });
    const accessibilityScan = await new AxeBuilder({ page }).include('#e2e-675-onboarding-card').analyze();
    expect(accessibilityScan.violations).toEqual([]);
  });
});
