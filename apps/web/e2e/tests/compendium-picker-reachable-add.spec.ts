/**
 * The compendium item picker's Add button must stay reachable.
 *
 * The picker card is `max-h-[85vh] overflow-hidden`, so anything that does not fit is
 * CLIPPED — not scrolled to. With a fully-specified item selected (a weapon carries a
 * dozen-plus facts) the owner/quantity/notes fields and the footer ran past that edge:
 * measured on an 800px-tall viewport, the footer's bottom sat 105px below the card, so
 * Cancel and Add were simply not there. Adding an item from the compendium was impossible.
 *
 * `toBeVisible()` does NOT catch this. A clipped element inside `overflow: hidden` still
 * has a non-empty box and is "visible" to Playwright; only its geometry against the card,
 * a hit test, and an actual click tell the two states apart. All three are asserted here.
 *
 * The viewport is deliberately short. At a roomy height the bug hides, which is how it
 * survived — the existing coverage for this picker was a source-text grep that only
 * checked the modal's testid was present.
 */
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { stateFor } from './seed';

/** A weapon with a full fact set — the shape that overflowed the card. */
const ITEM_FACTS = {
  itemCategory: 'Weapon',
  itemSubcategory: 'Base Weapons',
  rarity: 'Common',
  hands: 1,
  damage: '1d8 F',
  damageType: 'Fire',
  weaponCategory: 'Martial',
  weaponGroup: 'Sword',
  weaponType: 'Melee',
  upgrades: 1,
  price: '15 gp',
  bulk: 1,
  properties: ['Versatile', 'Finesse'],
};

/**
 * Rule packs are SERVER-WIDE, so this uploads its own under a unique slug and removes it
 * again rather than leaning on the shared seed (which carries no item-type entry at all).
 * Every spec that reads `/rules/packs` mocks the route, so a transient extra pack cannot
 * leak into their assertions.
 */
async function installItemPack(admin: APIRequestContext, slug: string, itemName: string) {
  const upload = await admin.post('/api/v1/rules/packs/upload', {
    data: {
      source: 'upload',
      pack: { slug, name: 'Picker overflow fixture', version: '1', license: 'CC0' },
      entries: [
        {
          slug: `${slug}-blade`,
          name: itemName,
          type: 'item',
          summary: 'Martial melee weapon · 1d8 fire',
          dataJson: JSON.stringify(ITEM_FACTS),
        },
      ],
    },
  });
  expect(upload.ok(), `upload rule pack: ${await upload.text()}`).toBe(true);
  const { id: jobId } = await upload.json();

  const deadline = Date.now() + 20_000;
  for (;;) {
    const job = await (await admin.get(`/api/v1/rules/packs/install-jobs/${jobId}`)).json();
    if (job.status === 'completed') return;
    if (job.status === 'failed') throw new Error(`fixture pack install failed: ${job.error ?? 'unknown'}`);
    if (Date.now() >= deadline) throw new Error('fixture pack install timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test.describe('compendium item picker — the Add button stays reachable', () => {
  test.use({ storageState: stateFor('dm') });

  test('a fact-heavy item keeps Add inside the card, hit-testable, and working on a short viewport', async ({
    page,
    baseURL,
  }) => {
    const suffix = Date.now();
    const slug = `picker-overflow-${suffix}`;
    const itemName = `Ember Blade ${suffix}`;
    const admin: APIRequestContext = await request.newContext({ baseURL, storageState: stateFor('admin') });
    let campaignId: number | null = null;

    try {
      await installItemPack(admin, slug, itemName);

      // The picker searches `rules/search?campaignId=…`, which scopes results to the
      // campaign's rule system — so this needs a campaign bound to the fixture pack
      // rather than the shared seed campaign (which is on `e2e-open5e-actions` and would
      // return nothing for this item).
      const created = await page.request.post('/api/v1/campaigns', {
        data: { name: `E2E — Picker overflow ${suffix}`, ruleSystem: slug },
      });
      expect(created.ok(), `create campaign: ${await created.text()}`).toBe(true);
      campaignId = (await created.json()).id as number;

      // Short enough that the card's 85vh cap actually binds. This is the whole point:
      // the defect is invisible on a tall window.
      const viewport = { width: 1024, height: 560 };
      await page.setViewportSize(viewport);
      await page.goto(`/c/${campaignId}/inventory`);

      await page.getByRole('button', { name: /from compendium/i }).click();
      const modal = page.getByTestId('compendium-item-picker-modal');
      await expect(modal).toBeVisible();

      await modal.getByRole('textbox').first().fill(itemName);
      const result = modal.getByRole('button', { name: new RegExp(itemName, 'i') }).first();
      await expect(result).toBeVisible({ timeout: 10_000 });
      await result.click();

      // The facts panel is what used to push everything else out.
      await expect(modal.getByTestId('compendium-picker-stats')).toBeVisible();

      const add = modal.getByRole('button', { name: /add to inventory/i });
      await expect(add).toBeVisible();

      const modalBox = await modal.boundingBox();
      const addBox = await add.boundingBox();
      expect(modalBox).not.toBeNull();
      expect(addBox).not.toBeNull();
      expect(
        Math.round(addBox!.y + addBox!.height),
        'the Add button must sit inside the card, not below its overflow-hidden edge',
      ).toBeLessThanOrEqual(Math.round(modalBox!.y + modalBox!.height) + 1);
      // `boundingBox()` is viewport-relative and does NOT carry the scroll offset (verified:
      // at scrollY 600 it returns the same y as `getBoundingClientRect()`, negative once the
      // element is above the fold), so comparing it against the viewport height is the right
      // test for "on screen". Read the height back from the viewport rather than repeating
      // the literal, so changing the size above cannot leave this checking a stale number.
      expect(addBox!.y + addBox!.height, 'the Add button must be on screen').toBeLessThanOrEqual(
        viewport.height,
      );

      // Not merely positioned — a real click at its centre must reach it. Clipping leaves
      // an element that measures fine and receives nothing.
      await add.click({ trial: true });

      const before = await (await page.request.get(`/api/v1/campaigns/${campaignId}/inventory`)).json();
      await add.click();
      await expect(modal).toHaveCount(0, { timeout: 10_000 });
      const after = await (await page.request.get(`/api/v1/campaigns/${campaignId}/inventory`)).json();
      expect(after.length, 'the item must actually be added').toBe(before.length + 1);
      expect(after.some((item: { name: string }) => item.name === itemName)).toBe(true);
    } finally {
      if (campaignId != null) await page.request.delete(`/api/v1/campaigns/${campaignId}`).catch(() => undefined);
      const packs = await (await admin.get('/api/v1/rules/packs')).json().catch(() => []);
      const mine = (Array.isArray(packs) ? packs : (packs.items ?? [])).find(
        (p: { slug?: string; id?: number }) => p.slug === slug,
      );
      if (mine?.id != null) await admin.delete(`/api/v1/rules/packs/${mine.id}`).catch(() => undefined);
      await admin.dispose();
    }
  });
});
