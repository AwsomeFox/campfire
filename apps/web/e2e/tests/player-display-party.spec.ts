import { expect, test, request, type APIRequestContext, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #824 — Cast / Player Display Party scene hides inactive, retired, and
 * dead PCs by default; the DM producer can opt alumni back in with explicit
 * Dead/Retired/Inactive labels; status changes while Cast is open land via poll.
 */

const DM = { username: 'dm', password: 'campfire-dm-pw-1' };

/** Controls auto-hide after idle — nudge the pointer so the producer toggle is hittable. */
async function revealControls(page: Page) {
  await page.mouse.move(24, 24);
  await expect(page.getByRole('checkbox', { name: /Include alumni \/ inactive/i })).toBeVisible();
}

async function login(ctx: APIRequestContext) {
  await ctx.post('/api/v1/auth/login', { data: DM });
}

async function createCharacter(baseURL: string, campaignId: number, name: string): Promise<number> {
  const ctx = await request.newContext({ baseURL });
  await login(ctx);
  const res = await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, {
    data: { name, className: 'Rogue', level: 2, status: 'active' },
  });
  if (!res.ok()) throw new Error(`create character -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  await ctx.dispose();
  return body.id as number;
}

async function patchStatus(baseURL: string, id: number, status: 'active' | 'retired' | 'dead' | 'inactive') {
  const ctx = await request.newContext({ baseURL });
  await login(ctx);
  const res = await ctx.patch(`/api/v1/characters/${id}`, { data: { status } });
  if (!res.ok()) throw new Error(`patch status -> ${res.status()}: ${await res.text()}`);
  await ctx.dispose();
}

async function trashCharacter(baseURL: string, id: number) {
  const ctx = await request.newContext({ baseURL });
  await login(ctx);
  const res = await ctx.delete(`/api/v1/characters/${id}`);
  await ctx.dispose();
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`trash ${id} -> ${res.status()}`);
  }
}

test.describe('Player Display party filter (issue #824)', () => {
  test.use({ storageState: stateFor('dm') });

  test('hides alumni by default and labels them when the producer includes them', async ({ page }) => {
    const { campaignId, xpRecipients } = seed();
    await page.goto(`/c/${campaignId}/screen`);
    await expect(page.getByRole('heading', { name: 'E2E — Cinderhaven' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Party' })).toBeVisible();

    // Seeded mixed-status XP fixtures must not pollute the live Party scene.
    await expect(page.getByText(xpRecipients.active.name, { exact: true })).toBeVisible();
    await expect(page.getByText(xpRecipients.retired.name, { exact: true })).toHaveCount(0);
    await expect(page.getByText(xpRecipients.dead.name, { exact: true })).toHaveCount(0);
    await expect(page.getByText(xpRecipients.inactive.name, { exact: true })).toHaveCount(0);

    await revealControls(page);
    const alumniToggle = page.getByRole('checkbox', { name: /Include alumni \/ inactive/i });
    await expect(alumniToggle).not.toBeChecked();
    await alumniToggle.check();

    const retiredCard = page
      .locator('.cf-party-card[data-character-status="retired"]')
      .filter({ hasText: xpRecipients.retired.name });
    const deadCard = page
      .locator('.cf-party-card[data-character-status="dead"]')
      .filter({ hasText: xpRecipients.dead.name });
    const inactiveCard = page
      .locator('.cf-party-card[data-character-status="inactive"]')
      .filter({ hasText: xpRecipients.inactive.name });
    await expect(retiredCard).toBeVisible();
    await expect(retiredCard).toContainText('Retired');
    await expect(deadCard).toBeVisible();
    await expect(deadCard).toContainText('Dead');
    await expect(inactiveCard).toBeVisible();
    await expect(inactiveCard).toContainText('Inactive');

    await alumniToggle.uncheck();
    await expect(page.getByText(xpRecipients.retired.name, { exact: true })).toHaveCount(0);
    await expect(page.getByText(xpRecipients.dead.name, { exact: true })).toHaveCount(0);
    await expect(page.getByText(xpRecipients.inactive.name, { exact: true })).toHaveCount(0);
  });

  test('drops a PC from Party promptly after retirement while Cast stays open', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const name = `Cast Retire ${Date.now()}`;
    const id = await createCharacter(baseURL!, campaignId, name);
    try {
      await page.goto(`/c/${campaignId}/screen`);
      await expect(page.getByRole('heading', { name: 'Party' })).toBeVisible();
      await expect(page.getByText(name, { exact: true })).toBeVisible();

      await patchStatus(baseURL!, id, 'retired');

      // Cast polls every 5s while visible — wait for the next tick to hide the PC.
      await expect(page.getByText(name, { exact: true })).toHaveCount(0, { timeout: 12_000 });

      await revealControls(page);
      await page.getByRole('checkbox', { name: /Include alumni \/ inactive/i }).check();
      const card = page.locator('.cf-party-card[data-character-status="retired"]').filter({ hasText: name });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Retired');
    } finally {
      await trashCharacter(baseURL!, id);
    }
  });

  test('drops a PC from Party promptly after death while Cast stays open', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const name = `Cast Death ${Date.now()}`;
    const id = await createCharacter(baseURL!, campaignId, name);
    try {
      await page.goto(`/c/${campaignId}/screen`);
      await expect(page.getByText(name, { exact: true })).toBeVisible();

      await patchStatus(baseURL!, id, 'dead');
      await expect(page.getByText(name, { exact: true })).toHaveCount(0, { timeout: 12_000 });

      await revealControls(page);
      await page.getByRole('checkbox', { name: /Include alumni \/ inactive/i }).check();
      const card = page.locator('.cf-party-card[data-character-status="dead"]').filter({ hasText: name });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Dead');
    } finally {
      await trashCharacter(baseURL!, id);
    }
  });
});
