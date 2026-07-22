import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { parseMonsterStatblock } from '../../src/components/StatBlock';
import { seed, stateFor } from './seed';

test.describe('complete monster statblock parsing', () => {
  test('keeps every action category and tolerates legacy snake_case data', () => {
    const block = parseMonsterStatblock({
      armor_class: 14,
      special_abilities: [{ name: 'Keen Senses', description: 'The creature has advantage on sight checks.' }],
      actions: [{ name: 'Bite', desc: 'A close attack.', attack_bonus: 5 }],
      reactions: [{ name: 'Parry', desc: 'The creature adds 2 to its armor class.' }],
      legendary_actions: [{ name: 'Move', desc: 'The creature moves up to half its speed.' }],
    });

    expect(block).not.toBeNull();
    expect(block?.armorClass).toBe('14');
    expect(block?.specialAbilities[0]).toMatchObject({ name: 'Keen Senses', desc: expect.stringContaining('advantage') });
    expect(block?.actions[0]).toMatchObject({ name: 'Bite', attackBonus: '+5' });
    expect(block?.reactions[0].name).toBe('Parry');
    expect(block?.legendaryActions[0].name).toBe('Move');
  });

  test('degrades gracefully for old, sparse, and malformed imports', () => {
    expect(parseMonsterStatblock('{not json')).toBeNull();
    expect(parseMonsterStatblock({ hitPoints: 7 })).toMatchObject({ hitPoints: '7', actions: [], reactions: [] });
    expect(parseMonsterStatblock({ actions: 'not-an-array' })).toBeNull();
  });
});

test.describe('complete monster statblock surfaces', () => {
  test.use({ storageState: stateFor('dm') });

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 320, height: 740 },
  ] as const) {
    test(`${viewport.name} compendium reader shows all sections with accessible, wrapping rules text`, async ({ page }) => {
      const fixture = seed();
      await page.setViewportSize(viewport);
      await page.goto(`/c/${fixture.campaignId}/compendium/${fixture.statblockEntryId}`);

      const statblock = page.getByRole('region', { name: 'Creature statblock' });
      await expect(statblock).toBeVisible();
      for (const heading of ['Traits', 'Actions', 'Reactions', 'Legendary Actions']) {
        await expect(statblock.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      }
      await expect(statblock.locator('dt').filter({ hasText: 'Multiattack' })).toBeVisible();
      await expect(statblock.getByText('The sentinel makes two arc blade attacks.')).toBeVisible();
      await expect(statblock.getByText('Attack +8')).toBeVisible();
      await expect(statblock.getByText('Damage 2d10 + 5 lightning')).toBeVisible();
      await expect(statblock.getByText('Recharge 5\u20136')).toBeVisible();
      await expect(statblock.locator('dt').filter({ hasText: 'Deflect' })).toBeVisible();
      await expect(statblock.locator('dt').filter({ hasText: 'Sweep' })).toBeVisible();
      await expect(statblock.getByText('Costs 2 legendary actions')).toBeVisible();

      const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(horizontalOverflow).toBeLessThanOrEqual(1);
      const axe = await new AxeBuilder({ page }).include('[aria-label="Creature statblock"]').analyze();
      expect(axe.violations).toEqual([]);
    });
  }

  test('encounter statblock expands from the keyboard and uses the same action sections', async ({ page }) => {
    const fixture = seed();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.statblockEncounterId}`);
    await expect(page.getByRole('heading', { name: 'E2E — Complete Statblock' })).toBeVisible();

    const toggle = page.getByRole('button', { name: /Statblock/ });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const statblock = page.getByRole('region', { name: 'Creature statblock' });
    await expect(statblock.getByRole('heading', { name: 'Actions', exact: true })).toBeVisible();
    await expect(statblock.getByRole('heading', { name: 'Reactions', exact: true })).toBeVisible();
    await expect(statblock.getByRole('heading', { name: 'Legendary Actions', exact: true })).toBeVisible();
    await expect(statblock.getByText('The sentinel makes two arc blade attacks.')).toBeVisible();
    await expect(statblock.getByText('Recharge 5\u20136')).toBeVisible();

    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
    const axe = await new AxeBuilder({ page }).include('[aria-label="Creature statblock"]').analyze();
    expect(axe.violations).toEqual([]);
  });
});
