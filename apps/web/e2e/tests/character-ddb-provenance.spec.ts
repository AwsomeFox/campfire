import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #720 — D&D Beyond provenance copy on the character sheet.
 *
 * The schema persists `ddbId` for characters imported once from a public DDB
 * sheet (issue #18), but the sheet previously always said "Not linked — soon"
 * regardless. That was misleading for imported characters (they ARE linked) and
 * vague for manual ones. These specs cover the three honest states the sheet now
 * reflects:
 *
 *   1. Imported (ddbId present) → "Imported from D&D Beyond" + "One-time import
 *      — not synced" + a copyable id / source link. No live-sync overclaim.
 *   2. Manual (no ddbId) → "Created manually", never "soon".
 *   3. Copy-id affordance → the owner can copy the source id to the clipboard.
 *
 * Each fixture is restored in afterAll so the one shared backend stays pristine.
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

/** Stamp a character with a DDB source id by PATCHing ddbId (the importer's persistence path). */
async function setDdbId(baseURL: string, characterId: number, ddbId: string) {
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL, 'dm');
  const res = await ctx.patch(`/api/v1/characters/${characterId}`, { data: { ddbId } });
  await ctx.dispose();
  if (!res.ok()) throw new Error(`set ddbId on ${characterId} -> ${res.status()}: ${await res.text()}`);
}

async function restore(baseURL: string, id: number) {
  const ctx = await request.newContext({ baseURL });
  await login(ctx, baseURL, 'dm');
  const res = await ctx.post(`/api/v1/characters/${id}/restore`);
  await ctx.dispose();
  if (!res.ok() && res.status() !== 404) throw new Error(`restore ${id} -> ${res.status()}: ${await res.text()}`);
}

test.describe('Character D&D Beyond provenance (issue #720)', () => {
  test.use({ storageState: stateFor('dm') });

  test('imported character (ddbId present) shows honest provenance, not "soon"', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const name = `720 Imported PC ${Date.now()}`;
    const characterId = await createCharacter(baseURL!, 'dm', name);
    const ddbId = '12345678';
    await setDdbId(baseURL!, characterId, ddbId);
    try {
      await page.goto(`/c/${campaignId}/characters/${characterId}`);

      // The misleading "Not linked — soon" copy is gone...
      await expect(page.getByText('Not linked — soon')).toHaveCount(0);
      // ...replaced by honest provenance.
      await expect(page.getByText('Imported from D&D Beyond')).toBeVisible();
      // Explicit that this was a one-time import, not live sync.
      await expect(page.getByText('One-time import — not synced.')).toBeVisible();
      // A safe source link to the public DDB sheet is offered (bare numeric id).
      const sourceLink = page.getByRole('link', { name: 'Source sheet ↗' });
      await expect(sourceLink).toBeVisible();
      await expect(sourceLink).toHaveAttribute('href', `https://www.dndbeyond.com/characters/${ddbId}`);
    } finally {
      await restore(baseURL!, characterId);
    }
  });

  test('manual character (no ddbId) says "Created manually", never "soon"', async ({ page, baseURL }) => {
    const { campaignId } = seed();
    const name = `720 Manual PC ${Date.now()}`;
    const characterId = await createCharacter(baseURL!, 'dm', name);
    try {
      await page.goto(`/c/${campaignId}/characters/${characterId}`);

      await expect(page.getByText('Not linked — soon')).toHaveCount(0);
      await expect(page.getByText('Created manually')).toBeVisible();
      // The DM sees accurate import guidance pointing to the real flow.
      await expect(page.getByText('Import from a public sheet on the party page.')).toBeVisible();
    } finally {
      await restore(baseURL!, characterId);
    }
  });

  test('the copy-id affordance copies the DDB character id to the clipboard', async ({ page, context, baseURL }) => {
    const { campaignId } = seed();
    const name = `720 Copy PC ${Date.now()}`;
    const characterId = await createCharacter(baseURL!, 'dm', name);
    const ddbId = '87654321';
    await setDdbId(baseURL!, characterId, ddbId);
    try {
      await page.goto(`/c/${campaignId}/characters/${characterId}`);

      // Grant clipboard permissions so writeText resolves (headless otherwise denies).
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);

      const copyBtn = page.getByRole('button', { name: 'Copy id' });
      await expect(copyBtn).toBeVisible();
      await copyBtn.click();

      // The button flips to a confirmation, and the id is on the clipboard.
      await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(clip).toBe(ddbId);
    } finally {
      await restore(baseURL!, characterId);
    }
  });
});
