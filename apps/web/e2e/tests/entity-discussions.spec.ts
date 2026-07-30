import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';

const SURFACE_KEYS = [
  'quest',
  'npc',
  'faction',
  'location',
  'character',
  'session',
  'encounter',
  'campaign',
] as const;

type SurfaceKey = (typeof SURFACE_KEYS)[number];

function surfacePath(key: SurfaceKey): string {
  const { campaignId: c, navigation: n } = seed();
  switch (key) {
    case 'quest':
      return `/c/${c}/quests/${n.questId}`;
    case 'npc':
      return `/c/${c}/npcs/${n.npcId}`;
    case 'faction':
      return `/c/${c}/factions/${n.factionId}`;
    case 'location':
      return `/c/${c}/locations/${n.locationId}`;
    case 'character':
      return `/c/${c}/characters/${n.characterId}`;
    case 'session':
      return `/c/${c}/sessions?session=${n.sessionId}`;
    case 'encounter':
      return `/c/${c}/encounters/${n.encounterId}`;
    case 'campaign':
      return `/c/${c}`;
  }
}

test.describe('entity discussions (issue #439)', () => {
  test.use({ storageState: stateFor('player') });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('dm') });
    const page = await context.newPage();
    await restoreSeedEncounter(page);
    await context.close();
  });

  for (const label of SURFACE_KEYS) {
    test(`mounts Discussion on ${label}`, async ({ page }) => {
      await page.goto(surfacePath(label));
      const discussion = page.getByRole('region', { name: 'Discussion' });
      await expect(discussion).toBeVisible();
      await expect(discussionCompose(discussion)).toBeVisible();
    });
  }

  test('posts on a quest and deep-links to the comment', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const body = `Quest thread ${Date.now()}`;
    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);
    const discussion = page.getByRole('region', { name: 'Discussion' });
    await discussionCompose(discussion).fill(body);
    await discussion.getByRole('button', { name: 'Post' }).last().click();
    await expect(discussion.getByText(body)).toBeVisible();

    let postedId: number | undefined;
    try {
      const thread = await page.request.get(
        `/api/v1/campaigns/${campaignId}/comments?entityType=quest&entityId=${navigation.questId}`,
      );
      expect(thread.ok()).toBe(true);
      const pageJson = (await thread.json()) as {
        items: Array<{ root: { id: number; body: string }; replies: Array<{ id: number; body: string }> }>;
      };
      const posted = pageJson.items
        .flatMap((item) => [item.root, ...item.replies])
        .find((comment) => comment.body === body);
      expect(posted).toBeTruthy();
      postedId = posted!.id;

      await page.goto(
        `/c/${campaignId}/quests/${navigation.questId}?comment=${postedId}#entity-comment-${postedId}`,
      );
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`entity-comment-${postedId}`);
      await expect(page.getByText(body)).toBeVisible();
    } finally {
      if (postedId) {
        await page.request.delete(`/api/v1/comments/${postedId}`).catch(() => undefined);
      }
    }
  });

  test('discussion is mobile-safe and axe-clean on a quest', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);
    const discussion = page.getByRole('region', { name: 'Discussion' });
    await expect(discussion).toBeVisible();
    const horizontalOverflow = await discussion.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(horizontalOverflow).toBe(false);
    const results = await new AxeBuilder({ page })
      .include(`#discussion-quest-${navigation.questId}`)
      .disableRules(['color-contrast'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

function discussionCompose(discussion: import('@playwright/test').Locator) {
  return discussion.getByPlaceholder('Add to the discussion…');
}
