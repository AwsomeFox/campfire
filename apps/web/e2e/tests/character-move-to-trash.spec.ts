import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #716 — "Move to Trash" for characters in the sheet header and the roster row.
 * Covers: owner trashes + undo (roster), DM trashes (sheet, keyboard path), an
 * unrelated viewer is denied the action, the open sheet redirects to the roster
 * when the undo snackbar expires, and an encounter referencing the character keeps
 * its combatant record after the trash. Each role gets its own describe block
 * (storageState is set via test.use, which is only valid at the describe/module
 * level) and its own freshly-created fixture character. Cleanup restores every
 * fixture so the one shared backend stays pristine for the rest of the serial suite.
 */

const CREDS = {
  dm: { username: 'dm', password: 'campfire-dm-pw-1' },
  player: { username: 'player', password: 'campfire-player-pw-1' },
} as const;

async function login(ctx: APIRequestContext, baseURL: string, who: keyof typeof CREDS) {
  await ctx.post(`${baseURL}/api/v1/auth/login`, { data: CREDS[who] });
}

async function createCharacter(baseURL: string, who: keyof typeof CREDS, name: string): Promise<number> {
  const { campaignId } = seed();
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL, who);
  const res = await ctx.post(`/api/v1/campaigns/${campaignId}/characters`, { data: { name, className: 'Fighter', level: 1 } });
  if (!res.ok()) throw new Error(`create character as ${who} -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  await ctx.dispose();
  return body.id as number;
}

async function restore(baseURL: string, id: number) {
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL, 'dm');
  const res = await ctx.post(`/api/v1/characters/${id}/restore`);
  await ctx.dispose();
  // Restore is idempotent — ignore 404 (already purged) gracefully.
  if (!res.ok() && res.status() !== 404) throw new Error(`restore ${id} -> ${res.status()}: ${await res.text()}`);
}

/** Link a character as a combatant to an encounter and return the combatant id. */
async function addCharacterCombatant(baseURL: string, encounterId: number, characterId: number): Promise<number> {
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL, 'dm');
  const res = await ctx.post(`/api/v1/encounters/${encounterId}/combatants`, { data: { kind: 'character', characterId } });
  if (!res.ok()) {
    const text = await res.text();
    await ctx.dispose();
    throw new Error(`add combatant -> ${res.status()}: ${text}`);
  }
  const body = await res.json();
  await ctx.dispose();
  return body.id as number;
}

test.describe('Character Move to Trash — owner (issue #716)', () => {
  test.use({ storageState: stateFor('player') });

  const name = `716 Owner PC ${Date.now()}`;
  let characterId = 0;

  test.beforeAll(async ({ baseURL }) => {
    characterId = await createCharacter(baseURL!, 'player', name);
  });
  test.afterAll(async ({ baseURL }) => {
    if (characterId) await restore(baseURL!, characterId);
  });

  test('owner sees the action, trashes from the roster, and undoes in place', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/party`);

    const card = page.locator('.cf-card', { hasText: name });
    const trigger = card.getByRole('button', { name: `Actions for ${name} (roster card)` });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const item = page.getByRole('menuitem', { name: 'Move to Trash…' });
    await expect(item).toBeVisible();
    await item.click();

    const dialog = page.getByRole('dialog', { name: `Move ${name} to the Trash?` });
    await expect(dialog).toBeVisible();
    // Effects are explained: encounter records kept, ownership stays with campaign.
    await expect(dialog).toContainText('Encounters referencing');
    await expect(dialog).toContainText('stays with the campaign');

    const [deleteRequest] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith(`/api/v1/characters/${characterId}`) && res.request().method() === 'DELETE'),
      dialog.getByRole('button', { name: 'Move to Trash' }).click(),
    ]);
    expect(deleteRequest.status()).toBe(200);

    // Card is gone from the roster; the undo snackbar appears.
    await expect(card).toBeHidden();
    const snackbar = page.locator('[role="status"]', { hasText: `${name} moved to the Trash.` });
    await expect(snackbar).toBeVisible();

    const [restoreRequest] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith(`/api/v1/characters/${characterId}/restore`) && res.request().method() === 'POST'),
      snackbar.getByRole('button', { name: 'Undo' }).click(),
    ]);
    expect(restoreRequest.status()).toBe(201);

    // Restored: the card reappears.
    await expect(page.locator('.cf-card', { hasText: name })).toBeVisible();
  });
});

test.describe('Character Move to Trash — DM (issue #716)', () => {
  test.use({ storageState: stateFor('dm') });

  const name = `716 DM PC ${Date.now()}`;
  let characterId = 0;

  test.beforeAll(async ({ baseURL }) => {
    characterId = await createCharacter(baseURL!, 'dm', name);
  });
  test.afterAll(async ({ baseURL }) => {
    if (characterId) await restore(baseURL!, characterId);
  });

  test('DM trashes from the sheet via keyboard and the open sheet redirects to the roster on undo-expire', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/characters/${characterId}`);

    const trigger = page.getByRole('button', { name: `Actions for ${name}` });
    await expect(trigger).toBeVisible();
    // Full keyboard path: focus trigger -> open menu -> activate item -> confirm.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const item = page.getByRole('menuitem', { name: 'Move to Trash…' });
    await expect(item).toBeVisible();
    await item.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: `Move ${name} to the Trash?` });
    await expect(dialog).toBeVisible();
    // ConfirmDialog initially focuses Cancel (safe default). Tab to the confirm button.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    // Snackbar appears on the open sheet; after it expires the sheet redirects to the roster.
    const snackbar = page.locator('[role="status"]', { hasText: `${name} moved to the Trash.` });
    await expect(snackbar).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/c/${campaignId}/party$`));
  });
});

test.describe('Character Move to Trash — unrelated viewer denied (issue #716)', () => {
  test.use({ storageState: stateFor('viewer') });

  const name = `716 Denied PC ${Date.now()}`;
  let characterId = 0;

  test.beforeAll(async ({ baseURL }) => {
    // Created by the DM, so the viewer is neither owner nor DM.
    characterId = await createCharacter(baseURL!, 'dm', name);
  });
  test.afterAll(async ({ baseURL }) => {
    if (characterId) await restore(baseURL!, characterId);
  });

  test('a viewer sees no Move to Trash action on the sheet or roster', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/characters/${characterId}`);
    // No kebab trigger on a character the viewer cannot edit.
    await expect(page.getByRole('button', { name: `Actions for ${name}` })).toHaveCount(0);

    await page.goto(`/c/${campaignId}/party`);
    const card = page.locator('.cf-card', { hasText: name });
    await expect(card.getByRole('button', { name: `Actions for ${name} (roster card)` })).toHaveCount(0);
  });
});

test.describe('Character Move to Trash — encounter link preserved (issue #716)', () => {
  test.use({ storageState: stateFor('dm') });

  const name = `716 Linked PC ${Date.now()}`;
  let characterId = 0;
  let combatantId = 0;

  test.beforeAll(async ({ baseURL }) => {
    const { encounterId } = seed();
    characterId = await createCharacter(baseURL!, 'dm', name);
    combatantId = await addCharacterCombatant(baseURL!, encounterId, characterId);
  });
  test.afterAll(async ({ baseURL }) => {
    if (characterId) await restore(baseURL!, characterId);
  });

  test('trashing a character keeps its combatant record on the encounter', async ({ page, baseURL }) => {
    const { campaignId, encounterId } = seed();

    // Trash the character from the roster via the kebab menu.
    await page.goto(`/c/${campaignId}/party`);
    const card = page.locator('.cf-card', { hasText: name });
    await card.getByRole('button', { name: `Actions for ${name} (roster card)` }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash…' }).click();
    const dialog = page.getByRole('dialog', { name: `Move ${name} to the Trash?` });
    await expect(dialog).toContainText('Encounters referencing');
    await dialog.getByRole('button', { name: 'Move to Trash' }).click();
    await expect(card).toBeHidden();

    // The encounter's combatant list still carries the trashed character's row —
    // the soft-delete does not cascade into combatant records.
    const res = await page.request.get(`/api/v1/encounters/${encounterId}`);
    expect(res.ok()).toBe(true);
    const encounter = (await res.json()) as { combatants: Array<{ id: number }> };
    expect(encounter.combatants.map((c) => c.id)).toContain(combatantId);
  });
});
