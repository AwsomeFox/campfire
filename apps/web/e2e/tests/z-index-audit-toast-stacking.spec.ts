/**
 * Live stacking proof for issue #2163's "plausible real drift" candidate
 * `.cf-death-save-spectator-toast` (`z-index: 40`, the same literal value as
 * `--cf-layer-tabbar`).
 *
 * z-index-audit.unit.spec.ts explains, from the source, why this is not actually a scale
 * bypass: the toast only ever renders as a child of `.cf-vtt`, and `.cf-vtt` is itself
 * `position: fixed; inset: 0` with an explicit z-index (`var(--cf-layer-immersive)`, 41) — a
 * stacking context that covers the FULL viewport. Per the CSS painting model a stacking
 * context's whole subtree paints as ONE atomic unit against its context's siblings; a
 * descendant's own z-index is compared only against its co-descendants, never against
 * something outside the context. So `.cf-vtt` (41) already outranks `.cf-tabbar` (40)
 * EVERYWHERE in the viewport, including at the tab bar's own coordinates, before the toast's
 * local "40" enters the picture at all — the tab bar is never hit-testable anywhere under an
 * open cockpit, toast or no toast.
 *
 * CI caught exactly this on the first version of this spec: it asserted a "before" baseline
 * of "the tab bar wins at that point without the toast", which is false ON THIS PAGE — the
 * cockpit already covers it regardless. That was a harness defect (a false premise about
 * where the control should live), not a wrong claim about the CSS: `control:` below moves the
 * "the tab bar really does win over ordinary content" check to an ordinary, non-cockpit page
 * where it is actually true (proving the measurement technique and the tab bar's real
 * dominance are both genuine), and the encounter-page test then measures the real claim
 * directly — .cf-vtt beats .cf-tabbar with no injection required — before using the same real
 * toast class as further, more specific confirmation.
 *
 * Triggering the toast for real requires a live cross-session death-save roll with a
 * spectator viewer, which is out of proportion to a CSS stacking question — instead a
 * synthetic element carrying the toast's REAL class name (so it picks up the real compiled
 * `.cf-death-save-spectator-toast` rule, not a hand-rolled one) is appended as a REAL child of
 * the REAL, live `.cf-vtt` node on an actually-rendered encounter page — matching the DOM
 * position encounter-cockpit-layout.unit.spec.ts already pins (RunSessionPage's only root is
 * `<EncounterVttShell>`, whose `{children}` render inside `.cf-vtt` — see
 * EncounterVttShell.tsx). `elementFromPoint` then tells us what actually paints on top,
 * exactly like dialog-layering.spec.ts does for ConfirmDialog vs. this same tab bar.
 */
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('z-index audit — death-save spectator toast vs. tab bar (issue #2163)', () => {
  test.use({ storageState: stateFor('dm'), viewport: { width: 320, height: 720 } });

  test('control: the tab bar really does win over ordinary page content at 320px', async ({ page }) => {
    // No cockpit on this route — proves the elementFromPoint technique below is meaningful,
    // not vacuously true because nothing else was ever in the running.
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}/party`);
    await expect(page.locator('.cf-tabbar')).toBeVisible();

    const hit = await page.evaluate(() => {
      const tabbar = document.querySelector('.cf-tabbar') as HTMLElement | null;
      if (!tabbar) return { ok: false as const, reason: 'missing .cf-tabbar' };
      const r = tabbar.getBoundingClientRect();
      const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return {
        ok: true as const,
        inTabbar: Boolean(el?.closest('.cf-tabbar')),
        tag: el?.tagName ?? null,
        className: el instanceof HTMLElement ? el.className : null,
      };
    });

    expect(hit.ok, hit.ok ? undefined : hit.reason).toBe(true);
    if (!hit.ok) return;
    expect(hit, JSON.stringify(hit)).toMatchObject({ inTabbar: true });
  });

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
        const describe = (el: Element | null) => ({
          inVtt: Boolean(el?.closest('.cf-vtt')),
          inTabbar: Boolean(el?.closest('.cf-tabbar')),
          tag: el?.tagName ?? null,
          className: el instanceof HTMLElement ? el.className : null,
        });

        const vtt = document.querySelector('.cf-vtt') as HTMLElement | null;
        const tabbar = document.querySelector('.cf-tabbar') as HTMLElement | null;
        if (!vtt || !tabbar) return { ok: false as const, reason: 'missing .cf-vtt or .cf-tabbar' };

        const tabRect = tabbar.getBoundingClientRect();
        const point = {
          x: Math.round(tabRect.left + tabRect.width / 2),
          y: Math.round(tabRect.top + tabRect.height / 2),
        };

        // The actual claim, measured directly with no injection: the cockpit itself — not
        // any particular descendant's z-index — already wins at the tab bar's own point,
        // because .cf-vtt (41) dominates .cf-tabbar (40) as a whole atomic subtree.
        const beforeHit = describe(document.elementFromPoint(point.x, point.y));

        // Further, more specific confirmation: the real toast class, appended as a real
        // child of the real .cf-vtt node — same DOM position the source has it in (see this
        // file's module doc comment) — directly over the tab bar's own hit point, paints
        // correctly there too.
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
        // dominance carrying the whole subtree, which is the actual claim under test.
        toast.style.zIndex = '1';
        const lowZIndexHit = document.elementFromPoint(point.x, point.y);
        const wonWithLowZIndex = lowZIndexHit === toast;

        toast.remove();
        const afterHit = describe(document.elementFromPoint(point.x, point.y));

        return {
          ok: true as const,
          beforeHit,
          toastZIndex,
          wonWithRealZIndex,
          wonWithLowZIndex,
          afterHit,
          vttZIndex: getComputedStyle(vtt).zIndex,
          tabbarZIndex: getComputedStyle(tabbar).zIndex,
        };
      });

      expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
      if (!result.ok) return;

      // The documented tiers really are 40 (tabbar) vs 41 (immersive) here, not something
      // that drifted since the source was last read.
      expect(result.tabbarZIndex).toBe('40');
      expect(result.vttZIndex).toBe('41');
      expect(result.toastZIndex).toBe('40');

      // The core claim, measured with no injection at all: .cf-vtt already wins at the tab
      // bar's own point, everywhere, because it's a full-viewport stacking context that
      // outranks .cf-tabbar's. The tab bar is genuinely never hit-testable under an open
      // cockpit — matching the CSS comment's "above the tab bar ... it replaces".
      expect(result.beforeHit, JSON.stringify(result.beforeHit)).toMatchObject({ inVtt: true, inTabbar: false });

      // Further confirmation: the toast specifically — not just some other .cf-vtt
      // descendant — paints there too, at its real z-index...
      expect(result.wonWithRealZIndex, 'toast should paint above the tab bar at its real z-index:40').toBe(true);
      // ...and STILL wins even crippled to z-index:1 — proving the toast's own local number
      // is not load-bearing for it to be visible; whatever wins at that point inside .cf-vtt
      // does so because it's inside .cf-vtt; ancestor dominance, not local value.
      expect(result.wonWithLowZIndex, 'toast should still paint above the tab bar even at z-index:1').toBe(true);
      // Cleanup left the page as it found it — still .cf-vtt, never the tab bar.
      expect(result.afterHit, JSON.stringify(result.afterHit)).toMatchObject({ inVtt: true, inTabbar: false });
    } finally {
      await page.request.delete(`/api/v1/encounters/${id}`).catch(() => undefined);
    }
  });
});
