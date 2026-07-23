/**
 * Issue #751 — AI settings budget section/input id split in the live DOM.
 *
 * Pins three browser contracts the unit suite cannot: (1) `#ai-dm-budget` appears
 * exactly once and is the hash-navigation target, (2) navigating with that hash
 * scrolls the section into view, (3) clicking the Token budget label focuses the
 * distinct number input.
 */
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

const SECTION_ID = 'ai-dm-budget';
const INPUT_ID = 'ai-dm-token-budget';

test.describe('AI DM budget DOM ids (issue #751)', () => {
  test.use({ storageState: stateFor('dm') });

  test('keeps section and input ids unique, honors hash navigation, and focuses via label', async ({
    page,
  }) => {
    const { campaignId } = seed();
    // Wait for the async AI card (budget section) before hash navigation — the
    // settings deep-link effect only runs when the campaign loads, so jumping
    // with a hash on first paint can miss a still-loading seat.
    await page.goto(`/c/${campaignId}/settings`);
    const card = page.locator('#ai-dm');
    await expect(card).toBeVisible();
    await expect(card.getByText('Budget & usage', { exact: true })).toBeVisible();

    const section = page.locator(`#${SECTION_ID}`);
    const input = page.locator(`#${INPUT_ID}`);
    await expect(section).toBeVisible();
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('type', 'number');

    // Duplicate-id coverage in the live tree (querySelectorAll('[id=…]'), not '#id',
    // because browsers collapse duplicate CSS id selectors to the first match).
    expect(await page.evaluate((id) => document.querySelectorAll(`[id="${id}"]`).length, SECTION_ID)).toBe(1);
    expect(await page.evaluate((id) => document.querySelectorAll(`[id="${id}"]`).length, INPUT_ID)).toBe(1);

    // Park at the top so a successful hash scroll is observable, then re-enter
    // with `#ai-dm-budget` (the deep-link contract used by gate/checklist links).
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.goto(`/c/${campaignId}/settings#${SECTION_ID}`);
    await expect(section).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const el = document.getElementById(id);
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.top < window.innerHeight && rect.bottom > 0;
        }, SECTION_ID),
      )
      .toBe(true);

    const label = card.locator('label', { hasText: /^Token budget$/ });
    await expect(label).toHaveAttribute('for', INPUT_ID);
    await label.click();
    await expect(input).toBeFocused();
  });
});
