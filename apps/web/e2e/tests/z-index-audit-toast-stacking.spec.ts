/**
 * Live stacking proof for issue #2163's "plausible real drift" candidate
 * `.cf-death-save-spectator-toast` (`z-index: 40`, the same literal value as
 * `--cf-layer-tabbar`).
 *
 * z-index-audit.unit.spec.ts explains, from the source, why this is not actually a scale
 * bypass: the toast only ever renders as a child of `.cf-vtt`, and `.cf-vtt` is itself
 * `position: fixed` with an explicit z-index (`var(--cf-layer-immersive)`, 41) — a stacking
 * context. Per the CSS painting model a stacking context's whole subtree paints as ONE
 * atomic unit against its context's siblings; a descendant's own z-index is compared only
 * against its co-descendants, never against something outside the context. So `.cf-vtt`
 * (41) already outranks `.cf-tabbar` (40) before the toast's local "40" enters the picture
 * at all.
 *
 * That is a claim about actual rendering, not source text, so it is proved here by
 * measurement rather than by re-reading the CSS (see AGENTS.md and this issue's own
 * caution against reasoning-only conclusions on this codebase). Triggering the toast for
 * real requires a live cross-session death-save roll with a spectator viewer, which is out
 * of proportion to a CSS stacking question — instead a synthetic element carrying the
 * toast's REAL class name (so it picks up the real compiled `.cf-death-save-spectator-toast`
 * rule, not a hand-rolled one) is appended as a REAL child of the REAL, live `.cf-vtt` node
 * on an actually-rendered encounter page — matching the DOM position
 * encounter-cockpit-layout.unit.spec.ts already pins (RunSessionPage's only root is
 * `<EncounterVttShell>`, whose `{children}` render inside `.cf-vtt` — see
 * EncounterVttShell.tsx). `elementFromPoint` then tells us what actually paints on top,
 * exactly like dialog-layering.spec.ts does for ConfirmDialog vs. this same tab bar.
 */
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('z-index audit — death-save spectator toast vs. tab bar (issue #2163)', () => {
  test.use({ storageState: stateFor('dm'), viewport: { width: 320, height: 720 } });

  test('the toast’s local z-index:40 never has to beat the tab bar’s — .cf-vtt already does', async ({ page }) => {
    const { campaignId } = seed();
    const created = await page.request.post(`/api/v1/campaigns/${campaignId}/encounters`, {
      data: { name: '2163 toast-stacking drill', hidden: false },
    });
    expect(created.ok()).toBe(true);
    const id = ((await created.json()) as { id: number }).id;

    try {
      await page.goto(`/c/${campaignId}/encounters/${id}`);
      await expect(page.getByTestId('encounter-vtt-canvas')).toBeVisible();
      await expect(page.locator('.cf-tabbar')).toBeVisible();

      const result = await page.evaluate(() => {
        const vtt = document.querySelector('.cf-vtt') as HTMLElement | null;
        const tabbar = document.querySelector('.cf-tabbar') as HTMLElement | null;
        if (!vtt || !tabbar) return { ok: false as const, reason: 'missing .cf-vtt or .cf-tabbar' };

        const tabRect = tabbar.getBoundingClientRect();
        const point = {
          x: Math.round(tabRect.left + tabRect.width / 2),
          y: Math.round(tabRect.top + tabRect.height / 2),
        };

        // Sanity: without the toast, the point really is the tab bar today (otherwise this
        // test would prove nothing about the toast specifically).
        const beforeHit = document.elementFromPoint(point.x, point.y);
        const tabBarWinsAlready = Boolean(beforeHit?.closest('.cf-tabbar'));

        // The real toast class, appended as a real child of the real .cf-vtt node — same DOM
        // position the source has it in (see this file's module doc comment) — directly over
        // the tab bar's own hit point.
        const toast = document.createElement('div');
        toast.className = 'cf-death-save-spectator-toast';
        toast.setAttribute('data-testid', 'zaudit-2163-injected-toast');
        toast.style.position = 'fixed';
        toast.style.left = `${tabRect.left}px`;
        toast.style.top = `${tabRect.top}px`;
        toast.style.width = `${tabRect.width}px`;
        toast.style.height = `${tabRect.height}px`;
        // The real rule also sets `transform: translateX(-50%)` (it's normally centered) and
        // a mount animation that drives `transform`/`opacity` for its first 0.3s — CSS
        // animations override even inline styles for the properties they animate, so both
        // would fight the exact rect set above. Neither affects z-index/stacking (the only
        // thing under test), so switch them off to pin the rect precisely.
        toast.style.transform = 'none';
        toast.style.animation = 'none';
        vtt.appendChild(toast);
        const toastZIndex = getComputedStyle(toast).zIndex;

        const withRealZIndexHit = document.elementFromPoint(point.x, point.y);
        const wonWithRealZIndex = withRealZIndexHit === toast;

        // Now strip the toast down to a z-index far BELOW the tab bar's (still non-auto, so
        // it still forms its own tiny local stacking context) — if the toast still wins, the
        // win cannot be coming from its own number at all; it can only be .cf-vtt's ancestor
        // dominance (41 > 40) carrying the whole subtree, which is the actual claim under
        // test.
        toast.style.zIndex = '1';
        const lowZIndexHit = document.elementFromPoint(point.x, point.y);
        const wonWithLowZIndex = lowZIndexHit === toast;

        toast.remove();
        const afterHit = document.elementFromPoint(point.x, point.y);
        const tabBarRestored = Boolean(afterHit?.closest('.cf-tabbar'));

        return {
          ok: true as const,
          tabBarWinsAlready,
          toastZIndex,
          wonWithRealZIndex,
          wonWithLowZIndex,
          tabBarRestored,
          vttZIndex: getComputedStyle(vtt).zIndex,
          tabbarZIndex: getComputedStyle(tabbar).zIndex,
        };
      });

      expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
      if (!result.ok) return;

      // Baseline: the tab bar really is on top of that point before the toast exists.
      expect(result.tabBarWinsAlready).toBe(true);
      // The documented tiers really are 40 (tabbar) vs 41 (immersive) here, not something
      // that drifted since the source was last read.
      expect(result.tabbarZIndex).toBe('40');
      expect(result.vttZIndex).toBe('41');
      expect(result.toastZIndex).toBe('40');

      // The actual claim: the toast wins at its real z-index...
      expect(result.wonWithRealZIndex, 'toast should paint above the tab bar at its real z-index:40').toBe(true);
      // ...and STILL wins even crippled to z-index:1 — proving the win is .cf-vtt's own
      // ancestor stacking context (41 > 40), not any property of the toast's local number.
      expect(result.wonWithLowZIndex, 'toast should still paint above the tab bar even at z-index:1, because .cf-vtt already dominates .cf-tabbar').toBe(true);
      // Cleanup left the page as it found it.
      expect(result.tabBarRestored).toBe(true);
    } finally {
      await page.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
    }
  });
});
