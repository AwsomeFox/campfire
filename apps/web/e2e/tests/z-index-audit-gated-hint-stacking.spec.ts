/**
 * Live stacking proof for the `.cf-gated-hint` bypass Codex's review found in #2202
 * (originally filed under issue #2163).
 *
 * The base (non-escaped) `.cf-gated-hint` rule is not cockpit-only: `GatedControl` is also
 * used by `DiceTray`'s advantage/disadvantage toggle, which `SharedDiceLog` mounts on the
 * plain Dashboard (`DiceWidget`) and the character sheet — neither wrapped in `.cf-vtt` or
 * any other stacking-context-establishing ancestor. There the hint sits directly inside
 * `.cf-authed-shell`, the SAME local stacking context Layout's sticky mobile header (Tailwind
 * `z-30`) does. Before this fix the hint's own `z-index` was the literal `30` — an exact tie
 * with the header, decided only by DOM order (the hint always renders later), so it could
 * paint over chrome by coincidence rather than by the documented scale. The fix reuses the
 * existing `--cf-layer-immersive` token (already used by `.cf-gated-hint--escaped` for the
 * identical "must clear ordinary page chrome" reason) so the hint deterministically outranks
 * chrome instead of merely tying with it.
 *
 * `elementFromPoint` — the technique z-index-audit-toast-stacking.spec.ts uses — does NOT
 * work here: `.cf-gated-hint` is `pointer-events: none` (it's `role="presentation"
 * aria-hidden="true"`, decorative only), and per the CSSOM View spec `elementFromPoint` skips
 * `pointer-events: none` elements entirely, falling through to whatever is beneath them
 * regardless of paint order. Using it would silently prove nothing. Instead this test proves
 * the two conditions that make a bare z-index comparison meaningful in the first place —
 * measured live, not assumed:
 *
 *   1. The hint and the header share the same nearest stacking-context-establishing
 *      ancestor (`.cf-authed-shell`) — i.e. nothing between either of them and that ancestor
 *      is itself positioned+z-indexed, transformed, filtered, less-than-fully-opaque,
 *      isolated, or contained, per MDN's stacking-context trigger list. If that were false,
 *      comparing their z-index numbers would be exactly the trap this issue is about.
 *   2. Given (1) holds, the hint's computed z-index now genuinely exceeds the header's —
 *      not tied, not smaller — so the win is deterministic regardless of DOM order.
 */
import { expect, test } from '@playwright/test';
import { seed, stateFor } from './seed';

test.describe('z-index audit — gated hint vs. sticky header on the dashboard (issue #2163 review)', () => {
  test.use({ storageState: stateFor('dm'), viewport: { width: 320, height: 720 } });

  test('the dashboard dice tray’s advantage hint now outranks the sticky header, not just ties it', async ({
    page,
  }) => {
    const { campaignId } = seed();
    await page.goto(`/c/${campaignId}`);

    // Gate the Advantage toggle: `advAvailable` is true for an empty pool or a lone d20, so a
    // single d6 (neither) is enough to make the toggle disabled-with-reason.
    const addD6 = page.getByRole('button', { name: 'Add a d6' });
    await expect(addD6).toBeVisible();
    await addD6.click();

    // `exact: true` is load-bearing, not defensive: Playwright's default accessible-name
    // match is a substring match, and "Advantage" is a substring of "Disadvantage" — the
    // sibling GatedControl toggle right next to it. Without this the locator resolves to
    // both buttons and every assertion below throws a strict-mode violation before the
    // stacking-context measurement ever runs (caught by CI, not predicted).
    const advantage = page.getByRole('button', { name: 'Advantage', exact: true });
    await expect(advantage).toBeDisabled();
    await advantage.focus();
    const hint = page.getByTestId('gated-control-hint').first();
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('Advantage and disadvantage only apply to a single d20 roll.');

    const header = page.locator('header').first();
    await expect(header).toBeVisible();

    const result = await page.evaluate(() => {
      // MDN's stacking-context trigger list (also this issue's own definition): a positioned
      // element with a non-auto z-index, position:fixed/sticky, opacity<1, a transform,
      // filter/backdrop-filter, will-change naming one of those, isolation:isolate, or a
      // paint/layout/strict/content containment.
      function establishesStackingContext(node: Element): boolean {
        const cs = getComputedStyle(node);
        if (cs.position !== 'static' && cs.zIndex !== 'auto') return true;
        if (cs.position === 'fixed' || cs.position === 'sticky') return true;
        if (Number(cs.opacity) < 1) return true;
        if (cs.transform !== 'none') return true;
        if (cs.filter !== 'none') return true;
        if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
        if (cs.isolation === 'isolate') return true;
        if (cs.willChange && /transform|opacity|filter/.test(cs.willChange)) return true;
        if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return true;
        return false;
      }

      /** Nearest ancestor (inclusive of a starting non-context-establishing node's parents,
       * not the node itself) that establishes a stacking context, or null if none does before
       * the document root. */
      function nearestStackingContextAncestor(el: Element): Element | null {
        let node: Element | null = el.parentElement;
        while (node) {
          if (establishesStackingContext(node)) return node;
          node = node.parentElement;
        }
        return null;
      }

      const hintEl = document.querySelector('[data-testid="gated-control-hint"]');
      const headerEl = document.querySelector('header');
      if (!hintEl || !headerEl) return { ok: false as const, reason: 'missing hint or header' };

      const hintContext = nearestStackingContextAncestor(hintEl);
      const headerContext = nearestStackingContextAncestor(headerEl);

      return {
        ok: true as const,
        sameContext: hintContext !== null && hintContext === headerContext,
        contextClass: hintContext instanceof HTMLElement ? hintContext.className : null,
        hintZIndex: getComputedStyle(hintEl).zIndex,
        headerZIndex: getComputedStyle(headerEl).zIndex,
        hintPointerEvents: getComputedStyle(hintEl).pointerEvents,
      };
    });

    expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
    if (!result.ok) return;

    // Confirms this element really is pointer-events:none, i.e. that elementFromPoint would
    // NOT be a valid way to check this — see the module doc comment.
    expect(result.hintPointerEvents).toBe('none');

    // The comparison below is only meaningful if this holds — otherwise the hint and the
    // header could each be capped by a DIFFERENT ancestor context, and comparing their raw
    // numbers would be exactly the trap issue #2163 is about.
    expect(result.sameContext, `hint and header must share one stacking-context ancestor; found ${result.contextClass}`).toBe(true);
    expect(result.contextClass).toContain('cf-authed-shell');

    // The actual fix: no longer a 30/30 tie decided by DOM order — the hint's token-based
    // value genuinely exceeds the header's now.
    expect(result.headerZIndex).toBe('30');
    expect(Number(result.hintZIndex)).toBeGreaterThan(Number(result.headerZIndex));
  });
});
