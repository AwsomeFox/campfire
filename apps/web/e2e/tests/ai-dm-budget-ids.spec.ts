import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #751 — Budget & usage section anchor vs token-budget input.
 *
 * Runtime checks that complement the unit scan:
 *   (a) `#ai-dm-budget` is unique and resolves to the section (not the input),
 *   (b) hash navigation lands on that section,
 *   (c) clicking the "Token budget" label focuses the distinct input.
 */

test.describe('AI DM budget ids accessibility (#751)', () => {
  test.use({ storageState: stateFor('dm') });

  test('keeps section/input ids unique, hash-scrolls to the section, and label-focuses the input', async ({
    page,
  }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/settings#ai-dm-budget`);

    const section = page.locator('#ai-dm-budget');
    const input = page.locator('#ai-dm-budget-input');
    await expect(section).toBeVisible();
    await expect(input).toBeVisible();

    // Duplicate-ID coverage: each id appears exactly once in the document.
    expect(await page.locator('#ai-dm-budget').count()).toBe(1);
    expect(await page.locator('#ai-dm-budget-input').count()).toBe(1);
    const duplicateScan = await page.evaluate(() => {
      const counts = new Map<string, number>();
      Array.from(document.querySelectorAll<HTMLElement>('[id]')).forEach((el) => {
        counts.set(el.id, (counts.get(el.id) ?? 0) + 1);
      });
      return Array.from(counts.entries()).filter(([, n]) => n > 1).map(([id]) => id);
    });
    expect(duplicateScan).not.toContain('ai-dm-budget');
    expect(duplicateScan).not.toContain('ai-dm-budget-input');

    // Hash target is the section container, not the number input.
    await expect(section).toHaveAttribute('id', 'ai-dm-budget');
    await expect(input).toHaveAttribute('type', 'number');
    expect(await section.evaluate((el) => el.tagName.toLowerCase())).not.toBe('input');

    // CampaignSettingsPage scrolls the hash target into view once AiDmCard mounts
    // the section (may land slightly under the sticky header via scrollMarginTop).
    await expect
      .poll(async () =>
        section.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight;
        }),
      )
      .toBe(true);
    // Hash resolution must hit the section, not the input (document.getElementById uniqueness).
    expect(
      await page.evaluate(() => document.getElementById('ai-dm-budget')?.id),
    ).toBe('ai-dm-budget');
    expect(
      await page.evaluate(
        () => document.getElementById('ai-dm-budget') === document.querySelector('#ai-dm-budget-input'),
      ),
    ).toBe(false);

    // Label activation focuses the associated input (htmlFor → id).
    await page.locator('label[for="ai-dm-budget-input"]').click();
    await expect(input).toBeFocused();
  });
});
