import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

/**
 * Issue #884 — disclosure controls must expose a standardized contract:
 *   - the trigger carries `aria-expanded` and `aria-controls` pointing at a
 *     stable region id,
 *   - the controlled region is absent from the DOM (and therefore the
 *     accessibility/focus tree) while collapsed,
 *   - focus moves intentionally on open and returns to the trigger on close,
 *   - keyboard (Enter/Space) toggles, and the pattern repeats correctly when
 *     several disclosures share a page.
 *
 * These specs pin the acceptance scenarios against two representative
 * surfaces driven by the shared `useDisclosure` hook:
 *   1. RevisionHistoryPanel — focus management ON (focus enters the region on
 *      open, returns to the trigger on close).
 *   2. CombatantStatblock — focus management OFF (the textbook inline
 *      disclosure: focus stays on the trigger), and the "repeated disclosure"
 *      case because a fight can list several statblock toggles at once.
 */

// React's useId() emits ids like ":r0:" which are valid HTML ids (and resolve
// fine via getElementById / aria-controls) but choke Playwright's `#id` CSS
// shortcut. Resolve them with the attribute selector instead.
const byId = (id: string) => `[id="${id}"]`;

test.describe('disclosure controls (issue #884)', () => {
  test.describe('RevisionHistoryPanel — focus-management disclosure', () => {
    test.use({ storageState: stateFor('dm') });

    test('exposes aria-expanded/aria-controls, moves focus on open, restores on close', async ({ page }) => {
      const { campaignId, npcId } = seed();
      await page.goto(`/c/${campaignId}/npcs/${npcId}`);

      const trigger = page.getByRole('button', { name: /^Edit history$/ });
      await expect(trigger).toBeVisible();
      // Collapsed: aria-expanded is false and there is no controlled region yet
      // (the region is unmounted, so it's absent from the a11y/focus tree).
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      const collapsedControls = await trigger.getAttribute('aria-controls');
      expect(collapsedControls).toBeFalsy();

      await trigger.focus();
      await page.keyboard.press('Enter');

      // Expanded: aria-controls now resolves to a present, labelled region.
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      const regionId = await trigger.getAttribute('aria-controls');
      expect(regionId).toBeTruthy();
      const region = page.locator(byId(regionId!));
      await expect(region).toBeVisible();
      await expect(region).toHaveRole('region');
      await expect(region).toHaveAccessibleName(/versions/);

      // Focus moved intentionally into the region (onto a focusable child or
      // the region itself when it has none).
      const focusLandedInside = await page.evaluate(
        (rid) => {
          const el = document.activeElement;
          const regionEl = document.getElementById(rid);
          return !!el && !!regionEl && (regionEl === el || regionEl.contains(el));
        },
        regionId!,
      );
      expect(focusLandedInside).toBe(true);

      // Closing returns focus to the trigger and drops the region from the tree.
      // Focus is now inside the region, so we close by activating the trigger
      // again (the same path a mouse user takes) rather than sending Enter to
      // whichever child currently holds focus.
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
      await expect(region).toHaveCount(0);
    });

    test('expanded region is free of axe violations', async ({ page }) => {
      const { campaignId, npcId } = seed();
      await page.goto(`/c/${campaignId}/npcs/${npcId}`);
      const trigger = page.getByRole('button', { name: /^Edit history$/ });
      await trigger.click();
      const regionId = await trigger.getAttribute('aria-controls');
      expect(regionId).toBeTruthy();
      // color-contrast is a palette-wide concern tracked separately from the
      // disclosure semantics under test here (the "No earlier versions yet"
      // helper uses text-slate-600 regardless of disclosure state).
      const expanded = await new AxeBuilder({ page })
        .include(byId(regionId!))
        .disableRules(['color-contrast'])
        .analyze();
      expect(expanded.violations).toEqual([]);
    });
  });

  test.describe('CombatantStatblock — inline (no focus move), repeated disclosure', () => {
    test.use({ storageState: stateFor('dm') });

    test('keeps focus on the trigger and toggles the region from the keyboard', async ({ page }) => {
      const fixture = seed();
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.statblockEncounterId}`);
      await expect(page.getByRole('heading', { name: 'E2E — Complete Statblock' })).toBeVisible();

      const toggle = page.getByRole('button', { name: /Statblock/ }).first();
      await toggle.focus();
      await page.keyboard.press('Enter');

      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const regionId = await toggle.getAttribute('aria-controls');
      expect(regionId).toBeTruthy();
      const region = page.locator(byId(regionId!));
      await expect(region).toBeVisible();

      // Focus management is OFF for this inline disclosure: the trigger keeps focus.
      await expect(toggle).toBeFocused();

      // The inner StatBlock region is still the labelled landmark callers rely on.
      await expect(page.getByRole('region', { name: 'Creature statblock' })).toBeVisible();

      // Collapse from the keyboard; region leaves the a11y tree.
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toBeFocused();
      await expect(region).toHaveCount(0);
    });

    test('Space also toggles (native button semantics)', async ({ page }) => {
      const fixture = seed();
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.statblockEncounterId}`);
      const toggle = page.getByRole('button', { name: /Statblock/ }).first();
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    test('two statblock disclosures on one encounter stay independent', async ({ page }) => {
      const fixture = seed();
      // statblockEncounterId seeds two compendium-linked monsters so both rows
      // render a "Statblock" toggle — the repeated-disclosure contract: each
      // toggle controls only its own region.
      await page.goto(`/c/${fixture.campaignId}/encounters/${fixture.statblockEncounterId}`);

      const toggles = page.getByRole('button', { name: /Statblock/ });
      await expect(toggles.nth(0)).toBeVisible();
      await expect(toggles.nth(1)).toBeVisible();

      const first = toggles.nth(0);
      const second = toggles.nth(1);

      // Open the first; the second stays collapsed (aria-controls is absent
      // while collapsed, by design — the region is unmounted).
      await first.click();
      await expect(first).toHaveAttribute('aria-expanded', 'true');
      await expect(second).toHaveAttribute('aria-expanded', 'false');

      // Open the second too; both regions must be present and controlled by
      // DIFFERENT ids (stable per instance — useId() uniqueness contract).
      await second.click();
      await expect(first).toHaveAttribute('aria-expanded', 'true');
      await expect(second).toHaveAttribute('aria-expanded', 'true');
      const firstRegion = await first.getAttribute('aria-controls');
      const secondRegion = await second.getAttribute('aria-controls');
      expect(firstRegion).toBeTruthy();
      expect(secondRegion).toBeTruthy();
      expect(firstRegion).not.toBe(secondRegion);
      await expect(page.locator(byId(firstRegion!))).toBeVisible();
      await expect(page.locator(byId(secondRegion!))).toBeVisible();

      // Collapse the first; the second remains open (independent state).
      await first.click();
      await expect(first).toHaveAttribute('aria-expanded', 'false');
      await expect(second).toHaveAttribute('aria-expanded', 'true');
    });
  });
});
