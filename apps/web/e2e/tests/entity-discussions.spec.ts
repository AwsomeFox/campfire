import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor, restoreSeedEncounter } from './seed';

test.describe('entity discussions (issue #439)', () => {
  test.use({ storageState: stateFor('player') });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFor('dm') });
    const page = await context.newPage();
    await restoreSeedEncounter(page);
    await context.close();
  });

  const surfaces = () => {
    const { campaignId: c, navigation: n } = seed();
    return [
      { label: 'quest', path: `/c/${c}/quests/${n.questId}` },
      { label: 'npc', path: `/c/${c}/npcs/${n.npcId}` },
      { label: 'faction', path: `/c/${c}/factions/${n.factionId}` },
      { label: 'location', path: `/c/${c}/locations/${n.locationId}` },
      { label: 'character', path: `/c/${c}/characters/${n.characterId}` },
      { label: 'session', path: `/c/${c}/sessions?session=${n.sessionId}` },
      { label: 'encounter', path: `/c/${c}/encounters/${n.encounterId}` },
      { label: 'campaign', path: `/c/${c}` },
    ] as const;
  };

  for (const { label, path } of surfaces()) {
    test(`mounts Discussion on ${label}`, async ({ page }) => {
      await page.goto(path);
      const discussion = page.getByRole('region', { name: 'Discussion' });
      await expect(discussion).toBeVisible();
      await expect(discussion.getByPlaceholder(/discussion/i)).toBeVisible();
    });
  }

  test('posts on a quest and deep-links to the comment', async ({ page }) => {
    const { campaignId, navigation } = seed();
    const body = `Quest thread ${Date.now()}`;
    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);
    const discussion = page.getByRole('region', { name: 'Discussion' });
    await discussion.getByPlaceholder('Add to the discussion…').fill(body);
    await discussion.getByRole('button', { name: 'Post' }).last().click();
    await expect(discussion.getByText(body)).toBeVisible();

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

    await page.goto(
      `/c/${campaignId}/quests/${navigation.questId}?comment=${posted!.id}#entity-comment-${posted!.id}`,
    );
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`entity-comment-${posted!.id}`);
    await expect(page.getByText(body)).toBeVisible();
    await page.request.delete(`/api/v1/comments/${posted!.id}`);
  });

  test('discussion is mobile-safe and axe-clean on a quest', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/c/${campaignId}/quests/${navigation.questId}`);
    const discussion = page.getByRole('region', { name: 'Discussion' });
    await expect(discussion).toBeVisible();
    const horizontalOverflow = await discussion.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(horizontalOverflow).toBe(false);
    const results = await new AxeBuilder({ page }).include(`#discussion-quest-${navigation.questId}`).analyze();
    expect(results.violations).toEqual([]);
  });
});
