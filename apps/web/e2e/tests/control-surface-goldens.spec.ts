import { expect, test } from '@playwright/test';
import type { Campaign } from '@campfire/schema';
import { measureBox } from '../lib/computedStyle';
import { restoreSeedEncounter, seed, stateFor } from './seed';

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Character-sheet tabs at a phone width, matching login-responsive.spec.ts's HANDSETS. */
const NARROW_VIEWPORT = { width: 390, height: 844 };

/**
 * Golden-screenshot coverage of interactive control surfaces (issue #1694).
 *
 * Before this file, the repo had 7 golden PNGs total: 5 of the signed-out login page
 * (login-responsive.spec.ts) and 2 of print layouts (print-layout.spec.ts) — and print CSS
 * hides every control (`button, input, textarea, select, [role="button"] { display: none
 * !important }`), so that suite structurally cannot catch a control/button/density change.
 * #1683 touched 8 primitives across 61 files and both suites came back clean — not because
 * nothing moved, but because neither one renders an authenticated, in-app control.
 *
 * Four surfaces were chosen deliberately, not to duplicate what login already covers:
 *
 * - `home-campaign-grid` — a card grid (Card + Chip composition), the dashboard's first
 *   authenticated screen and the most common "did card geometry drift" surface.
 * - `turn-workspace` — a dense combat toolbar (TurnWorkspace), the exact surface #1695
 *   fixed (`.btn`'s WCAG floor silently zeroed by `!min-h-0`) with no golden watching it.
 * - `Quick capture` dialog — the Dialog primitive, opened via its real keyboard shortcut,
 *   and (like turn-workspace) a surface #1695 directly touched.
 * - `character-sheet-tabs` — the character sheet's control column (`.seg-opt`, the exact
 *   class #1693 gave a WCAG floor to), captured at both desktop and a phone viewport since
 *   density problems show up first where space is tight.
 *
 * Only one theme is captured: Campfire ships a single dark theme (see index.css's `@media
 * print` comment — "the app is intentionally optimized for an interactive dark UI") with no
 * light-theme toggle to also render.
 *
 * Stability: every screenshot targets a Locator (not the full page), disables animations,
 * hides the caret, and — where the surface has any async data — waits for the specific
 * content that data produces before snapshotting, so there is no arbitrary sleep standing in
 * for a real readiness signal. Run repeatedly (`--repeat-each`) before trusting a new
 * baseline; see the PR description for the stability run this suite was proposed with.
 */
test.describe('control surface goldens (#1694)', () => {
  test.use({ storageState: stateFor('dm') });

  test('dashboard campaign card grid', async ({ page }) => {
    // The serial e2e suite shares a single seeded backend; earlier specs may have
    // created additional active campaigns. Snapshot the grid as if the DM owns only
    // the seeded campaign by archiving any other active campaigns, then restore them.
    const seededId = seed().campaignId;
    const archived: Array<{ id: number; status: Campaign['status'] }> = [];

    try {
      const campaigns = (await (await page.request.get('/api/v1/campaigns')).json()) as Campaign[];
      for (const c of campaigns) {
        if (c.id !== seededId && c.status === 'active') {
          const resp = await page.request.patch(`/api/v1/campaigns/${c.id}`, { data: { status: 'completed' } });
          expect(resp.ok()).toBe(true);
          archived.push({ id: c.id, status: c.status });
        }
      }

      await page.goto('/');
      const grid = page.getByTestId('home-campaign-grid');
      await expect(grid).toBeVisible();
      // The seeded DM owns exactly one active campaign; anchor on its tile's Dashboard
      // link so the screenshot never fires before the campaign card itself has painted.
      await expect(grid.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible();
      await page.evaluate(() => (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ?? Promise.resolve());
      await expect(grid).toHaveScreenshot('home-campaign-grid.png', {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.005,
      });
    } finally {
      for (const c of archived) {
        await page.request.patch(`/api/v1/campaigns/${c.id}`, { data: { status: c.status } });
      }
    }
  });

  test('encounter runner turn workspace (dense combat toolbar)', async ({ page }) => {
    await restoreSeedEncounter();
    const { campaignId, encounterId } = seed();
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    const workspace = page.getByTestId('turn-workspace');
    await expect(workspace).toBeVisible();
    // restoreSeedEncounter() resets the boss to initiative 18 (highest) so it is
    // deterministically first up — wait for its name rather than a fixed delay.
    await expect(workspace.getByRole('heading', { level: 2 })).toBeVisible();
    await page.evaluate(() => (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ?? Promise.resolve());

    // Not asserting a 24px floor on this workspace's `.btn.btn-ghost` controls here:
    // as of this PR, #1695 (which fixes exactly that on this exact surface) is still an
    // open, unmerged PR, so main genuinely measures ~23.3px here today — asserting >=24
    // would make this new suite red until #1695 lands. Once it merges, add
    // `expect((await measureBox(workspace.locator('.btn.btn-ghost').first())).height)
    // .toBeGreaterThanOrEqual(24)` here; `measureBox` (e2e/lib/computedStyle.ts) is
    // already set up for it. The screenshot below still catches any visual drift on
    // this surface in the meantime.
    await expect(workspace.locator('> div').first()).toHaveScreenshot('turn-workspace.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.05,
    });
  });

  test('character sheet control column (desktop)', async ({ page }) => {
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const tabs = page.getByTestId('character-sheet-tabs');
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('tab').first()).toBeVisible();

    const firstTab = tabs.getByRole('tab').first();
    const box = await measureBox(firstTab);
    expect(box.height, '.seg-opt character-sheet tabs must clear the 24px floor (issue #1693)').toBeGreaterThanOrEqual(24);

    await page.evaluate(() => (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ?? Promise.resolve());
    await expect(tabs).toHaveScreenshot('character-sheet-tabs-desktop.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.005,
    });
  });

  test('character sheet control column (narrow viewport)', async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    const { campaignId, navigation } = seed();
    await page.goto(`/c/${campaignId}/characters/${navigation.characterId}`);

    const tabs = page.getByTestId('character-sheet-tabs');
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('tab').first()).toBeVisible();
    await page.evaluate(() => (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ?? Promise.resolve());
    await expect(tabs).toHaveScreenshot('character-sheet-tabs-narrow.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.005,
    });
  });
});

test.describe('control surface goldens (#1694) — quick capture dialog', () => {
  // The private/inbox destination toggle (the exact `!min-h-[24px]` buttons #1695 fixed)
  // only renders for non-DM members (`{!isDm && (...)}` in QuickCaptureDialog.tsx) — a
  // separate describe block so this test can use 'player' without affecting the DM-role
  // tests above.
  test.use({ storageState: stateFor('player') });

  test('quick capture dialog', async ({ page }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/quests`);
    await expect(page.locator('[aria-keyshortcuts]').first()).toBeAttached();

    const dialog = page.getByRole('dialog', { name: 'Quick capture' });
    await expect(async () => {
      await page.keyboard.press(`${MODIFIER}+Shift+KeyN`);
      await expect(dialog).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 5_000 });

    // Pin the real computed floor on the exact controls #1695 fixed in this dialog
    // (`btn btn-ghost !min-h-[24px] !py-1`).
    const privateNoteBtn = dialog.getByRole('button', { name: 'Private note' });
    const dmInboxBtn = dialog.getByRole('button', { name: 'To DM inbox' });
    await expect(privateNoteBtn).toBeVisible();
    await expect(dmInboxBtn).toBeVisible();

    for (const btn of [privateNoteBtn, dmInboxBtn]) {
      const box = await measureBox(btn);
      expect(box.height, 'quick-capture destination buttons must clear the 24px floor').toBeGreaterThanOrEqual(24);
      expect(box.minHeight, 'quick-capture destination buttons must declare a 24px min-height floor').toBe('24px');
    }

    await page.evaluate(() => (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ?? Promise.resolve());
    await expect(dialog).toHaveScreenshot('quick-capture-dialog.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.005,
    });

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
