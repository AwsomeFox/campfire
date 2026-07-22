import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  NPC_DISPOSITION_SEMANTICS,
  QUEST_STATUS_SEMANTICS,
  npcDispositionPresentation,
  npcDispositionVariant,
  questStatusPresentation,
  questStatusVariant,
} from '../../src/components/entitySemantics';
import { seed, stateFor } from './seed';

const QUEST_EXPECTATIONS = {
  available: { label: 'Available', variant: 'available' },
  active: { label: 'Active', variant: 'active' },
  completed: { label: 'Completed', variant: 'completed' },
  failed: { label: 'Failed', variant: 'failed' },
} as const;

const NPC_EXPECTATIONS = {
  friendly: { label: 'Friendly', variant: 'completed' },
  neutral: { label: 'Neutral', variant: 'neutral' },
  hostile: { label: 'Hostile', variant: 'failed' },
} as const;

function semantic(page: Page, kind: 'quest-status' | 'npc-disposition', value: string): Locator {
  return page.locator(`[data-semantic="${kind}"][data-semantic-value="${value}"]`);
}

async function expectSemanticBadge(locator: Locator, label: string, variant: string) {
  await expect(locator).toBeVisible();
  await expect(locator).toHaveText(label);
  await expect(locator).toHaveAttribute('data-semantic-variant', variant);
  await expect(locator.locator('svg')).toHaveCount(1);
  await expect(locator.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(locator.locator('xpath=..')).toHaveClass(new RegExp(`cf-chip-${variant}`));
}

async function visualSignature(locator: Locator): Promise<string> {
  return locator.locator('xpath=..').evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.color}|${style.backgroundColor}`;
  });
}

test.describe('typed semantic mappings', () => {
  test('are exhaustive for canonical values and exact-match unknown values to neutral', () => {
    expect(Object.keys(QUEST_STATUS_SEMANTICS)).toEqual(Object.keys(QUEST_EXPECTATIONS));
    expect(Object.keys(NPC_DISPOSITION_SEMANTICS)).toEqual(Object.keys(NPC_EXPECTATIONS));

    for (const [status, expected] of Object.entries(QUEST_EXPECTATIONS)) {
      expect(questStatusVariant(status)).toBe(expected.variant);
      expect(questStatusPresentation(status).label).toBe(expected.label);
    }
    for (const [disposition, expected] of Object.entries(NPC_EXPECTATIONS)) {
      expect(npcDispositionVariant(disposition)).toBe(expected.variant);
      expect(npcDispositionPresentation(disposition).label).toBe(expected.label);
    }

    expect(questStatusVariant('active-ish')).toBe('neutral');
    expect(questStatusPresentation('active-ish')).toMatchObject({ variant: 'neutral', label: 'active-ish' });
    expect(npcDispositionVariant('trusted ally')).toBe('neutral');
    expect(npcDispositionPresentation('trusted ally')).toMatchObject({ variant: 'neutral', label: 'trusted ally' });
    expect(npcDispositionPresentation('  trusted ally  ')).toMatchObject({ variant: 'neutral', label: 'trusted ally' });
    expect(npcDispositionVariant('Friendly')).toBe('neutral');
    expect(npcDispositionVariant('')).toBe('neutral');
    expect(npcDispositionPresentation('').label).toBe('Neutral');
  });
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
] as const) {
  test.describe(`${viewport.name} semantic status surfaces`, () => {
    test.use({
      storageState: stateFor('dm'),
      viewport: { width: viewport.width, height: viewport.height },
    });

    test(`renders every quest status with text, icon, color treatment, axe, and visual coverage`, async ({ page }) => {
      const { semantic: fixture } = seed();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/c/${fixture.campaignId}/quests`);

      const signatures = new Set<string>();
      for (const [status, expected] of Object.entries(QUEST_EXPECTATIONS)) {
        const badge = semantic(page, 'quest-status', status);
        await expect(badge).toHaveCount(1);
        await expectSemanticBadge(badge, expected.label, expected.variant);
        signatures.add(await visualSignature(badge));
      }
      expect(signatures.size).toBe(Object.keys(QUEST_EXPECTATIONS).length);

      const surface = page.getByTestId('quest-list-surface');
      const accessibilityScan = await new AxeBuilder({ page }).include('[data-testid="quest-list-surface"]').analyze();
      expect(accessibilityScan.violations).toEqual([]);
      await test.info().attach(`quest-statuses-${viewport.name}`, {
        body: await surface.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      });
    });

    test(`renders every NPC disposition plus a neutral custom fallback with axe and visual coverage`, async ({ page }) => {
      const { semantic: fixture } = seed();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/c/${fixture.campaignId}/npcs`);

      const signatures = new Set<string>();
      for (const [disposition, expected] of Object.entries(NPC_EXPECTATIONS)) {
        const badge = semantic(page, 'npc-disposition', disposition);
        await expect(badge).toHaveCount(1);
        await expectSemanticBadge(badge, expected.label, expected.variant);
        signatures.add(await visualSignature(badge));
      }
      const custom = semantic(page, 'npc-disposition', 'trusted ally');
      await expect(custom).toHaveCount(1);
      await expectSemanticBadge(custom, 'trusted ally', 'neutral');
      expect(await visualSignature(custom)).toBe(await visualSignature(semantic(page, 'npc-disposition', 'neutral')));
      expect(signatures.size).toBe(Object.keys(NPC_EXPECTATIONS).length);

      const surface = page.getByTestId('npc-list-surface');
      const accessibilityScan = await new AxeBuilder({ page }).include('[data-testid="npc-list-surface"]').analyze();
      expect(accessibilityScan.violations).toEqual([]);
      await test.info().attach(`npc-dispositions-${viewport.name}`, {
        body: await surface.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      });
    });
  });
}

test.describe('semantic consistency across representative shipped surfaces', () => {
  test.use({ storageState: stateFor('dm') });

  test('reuses quest semantics on dashboard, detail controls, related cards, and cast display', async ({ page }) => {
    const { semantic: fixture } = seed();

    await page.goto(`/c/${fixture.campaignId}`);
    for (const [status, expected] of Object.entries(QUEST_EXPECTATIONS)) {
      await expectSemanticBadge(semantic(page, 'quest-status', status), expected.label, expected.variant);
    }

    await page.goto(`/c/${fixture.campaignId}/npcs/${fixture.npcs.friendly.id}`);
    for (const [status, expected] of Object.entries(QUEST_EXPECTATIONS)) {
      await expectSemanticBadge(semantic(page, 'quest-status', status), expected.label, expected.variant);
    }

    await page.goto(`/c/${fixture.campaignId}/locations/${fixture.locationId}`);
    for (const [status, expected] of Object.entries(QUEST_EXPECTATIONS)) {
      await expectSemanticBadge(semantic(page, 'quest-status', status), expected.label, expected.variant);
    }

    await page.goto(`/c/${fixture.campaignId}/quests/${fixture.quests.active.id}`);
    await expect(semantic(page, 'quest-status', 'active')).toHaveCount(2); // header + facts
    await page.getByRole('button', { name: 'Status ▾' }).click();
    for (const [status, expected] of Object.entries(QUEST_EXPECTATIONS)) {
      const menuBadge = page.getByRole('button').filter({ has: semantic(page, 'quest-status', status) });
      await expect(menuBadge).toHaveCount(1);
      await expectSemanticBadge(menuBadge.locator('[data-semantic="quest-status"]'), expected.label, expected.variant);
    }

    await page.goto(`/c/${fixture.campaignId}/screen`);
    for (const status of ['available', 'active'] as const) {
      const expected = QUEST_EXPECTATIONS[status];
      await expectSemanticBadge(semantic(page, 'quest-status', status), expected.label, expected.variant);
    }
  });

  test('reuses disposition semantics on dashboard, detail facts, and cast display', async ({ page }) => {
    const { semantic: fixture } = seed();

    for (const route of [`/c/${fixture.campaignId}`, `/c/${fixture.campaignId}/screen`]) {
      await page.goto(route);
      for (const [disposition, expected] of Object.entries(NPC_EXPECTATIONS)) {
        await expectSemanticBadge(semantic(page, 'npc-disposition', disposition), expected.label, expected.variant);
      }
      await expectSemanticBadge(semantic(page, 'npc-disposition', 'trusted ally'), 'trusted ally', 'neutral');
    }

    await page.goto(`/c/${fixture.campaignId}/npcs/${fixture.npcs.hostile.id}`);
    await expect(semantic(page, 'npc-disposition', 'hostile')).toHaveCount(2); // header + facts
    for (const badge of await semantic(page, 'npc-disposition', 'hostile').all()) {
      await expectSemanticBadge(badge, 'Hostile', 'failed');
    }
  });
});
