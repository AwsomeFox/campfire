import { expect, test } from '@playwright/test';
import { renderCssFixture } from '../lib/computedStyle';

/**
 * Computed-cascade verification for the semantic-warning token migration (#2161).
 *
 * `warning-token-migration.unit.spec.ts` proves the SOURCE references
 * `var(--color-warning)` at each migrated site. It cannot prove the browser
 * actually PAINTS that color — this codebase's `index.css`/`nocturne.css` are
 * imported unlayered, while every Tailwind utility (including arbitrary-value
 * ones like `border-[var(--color-warning)]/30`) lives inside `@layer
 * utilities`, and an unlayered `background`/`border` shorthand always wins
 * over a layered declaration regardless of specificity or source order. A
 * source-string scan is byte-identical for a working migration and a no-op
 * one, so it cannot see this at all — the exact trap `.hr`, nocturne's
 * `.btn` padding, and the duplicate `--space-*` definitions already caught
 * elsewhere in this codebase.
 *
 * Real re-measurement (Chromium via `renderCssFixture` against the actual
 * compiled `dist` CSS, not source inspection) found FOUR of this PR's
 * original sixteen candidate sites were exactly this trap — all inert,
 * still painting their pre-migration fallback color despite correct source:
 * `CampaignAuditPage.tsx:294` (renders through `<Card>`, whose `cf-card`
 * class carries an unlayered `background`/`border` shorthand),
 * `MembersPage.tsx:483` / `InboxPage.tsx:700` (both carry `cf-inset`, same
 * unlayered shorthand), and `SpellbookPanel.tsx:484` (carries `.btn`, whose
 * unlayered `background: 0 0` resets it to transparent before
 * `.btn-primary` applies anything). Rather than paper over that with an
 * `!important` escape or a new unlayered modifier class — both real design
 * decisions, not mechanical fixes — those four sites were REVERTED to raw
 * amber (see #2203's review) and filed as follow-up issue #2208 for a
 * proper warning-semantic variant of `.cf-card`/`.cf-inset`/`.btn`.
 *
 * ## Why this asserts EQUALITY, not "not the fallback color" (review round 2)
 *
 * The first version of this suite asserted only `computed !== --color-divider`
 * / `computed !== --cf-card` — the two known no-op fallback colors found
 * above. Codex correctly flagged that as the SAME structural flaw one level
 * up: excluding two known-bad values is not the same as confirming the right
 * one. If a future Tailwind version stopped emitting
 * `border-[var(--color-warning)]/35` (a config change, a build regression,
 * anything), the element would fall back to the CSS default `currentColor`
 * for border and `transparent` for background — NEITHER of which equals
 * `--color-divider` or `--cf-card` — so the old assertion would still pass
 * while zero sites actually painted warning. Verified this exact failure
 * mode directly: rendering a site's markup with a nonexistent utility class
 * in place of the real one resolves to `currentColor` (`rgb(233,233,237)`
 * here), which the OLD `!== --color-divider` check does not catch but the
 * new equality check below does.
 *
 * The fix computes the EXPECTED color independently of whether Tailwind's
 * utility class is even present: `color-mix(in oklab, var(--color-warning)
 * N%, transparent)`, built directly from the live `--color-warning` custom
 * property (never hardcoded as a literal rgb/hex — if the token value ever
 * changes, this recomputes against the new value automatically) and the
 * browser's own `color-mix()`. This is exactly the CSS Tailwind v4 compiles
 * `bg-[var(--color-warning)]/N` / `border-[...]/N` down to (verified by
 * reading the compiled `dist` CSS directly) — but critically, this
 * expression is evaluated independently, on an element that never carries
 * the Tailwind utility class at all, so it does not depend on Tailwind
 * having emitted anything. Real and expected are then compared for EXACT
 * equality (canvas-normalized RGBA, zero tolerance): verified empirically
 * across every opacity step used below (5/10/30/35/40/50%) that the
 * independently-constructed expression and Tailwind's own compiled utility
 * resolve to byte-identical RGBA — both go through the same browser
 * `color-mix()` primitive with the same inputs, so there is no rounding
 * drift to tolerate. A loose tolerance would risk admitting exactly the
 * `currentColor`/`transparent` fallback this check exists to catch, so none
 * is used.
 */

interface MigratedSite {
  /** Real markup for the site — matches what the actual component renders. */
  html: string;
  /** border-[var(--color-warning)]/N opacity, if this site migrated the border. */
  borderPct?: number;
  /** bg-[var(--color-warning)]/N opacity, if this site migrated the background. */
  bgPct?: number;
}

const SITES: Record<string, MigratedSite> = {
  'AudienceField:61': {
    html: '<p data-site="AudienceField:61" class="text-xs text-amber-400/90 border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 rounded px-2.5 py-2">x</p>',
    borderPct: 30,
    bgPct: 10,
  },
  'EntityRevealDialog:64': {
    html: '<p data-site="EntityRevealDialog:64" class="m-0 text-xs text-amber-300/90 border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 rounded px-2.5 py-2">x</p>',
    borderPct: 30,
    bgPct: 10,
  },
  'HandoutsCard:295': {
    html: '<p data-site="HandoutsCard:295" class="m-0 text-xs text-amber-300/90 border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 rounded px-2.5 py-2">x</p>',
    borderPct: 30,
    bgPct: 10,
  },
  'VisibleToPlayersBar:95': {
    html: '<div data-site="VisibleToPlayersBar:95" role="status" class="flex items-center gap-3 flex-wrap rounded border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-amber-100">x</div>',
    borderPct: 35,
    bgPct: 10,
  },
  'VisibleToPlayersBar:113': {
    html: '<div data-site="VisibleToPlayersBar:113" role="status" class="flex items-center gap-3 flex-wrap rounded border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-amber-100">x</div>',
    borderPct: 35,
    bgPct: 10,
  },
  'RunSessionPage:4496': {
    html: '<div data-site="RunSessionPage:4496" role="status" class="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm">x</div>',
    borderPct: 40,
    bgPct: 10,
  },
  'RunSessionPage:4520': {
    html: '<div data-site="RunSessionPage:4520" role="status" class="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm flex items-center gap-2 flex-wrap">x</div>',
    borderPct: 40,
    bgPct: 10,
  },
  'RunSessionPage:4551': {
    html: '<div data-site="RunSessionPage:4551" role="status" class="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm flex items-center gap-2 flex-wrap">x</div>',
    borderPct: 40,
    bgPct: 10,
  },
  'EncounterWhisperComposer:65': {
    html: '<form data-site="EncounterWhisperComposer:65" class="mt-2 rounded-lg border border-[var(--color-warning)]/30 bg-neutral-900/90 p-3 space-y-2 text-xs">x</form>',
    borderPct: 30,
    // No bgPct — this form's background is bg-neutral-900/90, never migrated.
  },
  'AuditLogCard:173': {
    html: '<div data-site="AuditLogCard:173" class="rounded border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 p-3 space-y-3">x</div>',
    borderPct: 30,
    bgPct: 5,
  },
  'ResetRequestsCard:117': {
    html: '<div data-site="ResetRequestsCard:117" class="border border-[var(--color-warning)]/30 rounded p-2.5 space-y-1">x</div>',
    borderPct: 30,
    // No bgPct — this div never had a background utility.
  },
  'SpellbookPanel:463': {
    html: '<div data-site="SpellbookPanel:463" class="bg-neutral-900 border border-[var(--color-warning)]/50 rounded-lg max-w-md w-full p-4 space-y-3 shadow-2xl">x</div>',
    borderPct: 50,
    // No bgPct — this div's background is bg-neutral-900, never migrated.
  },
};

/** Canvas-normalize a CSS color string to a stable, comparable RGBA tuple string. Both
 *  "real" and "expected" values go through this, so the comparison is apples-to-apples
 *  regardless of whether the browser's `getComputedStyle` reports the color as `rgb()`,
 *  `rgba()`, `color(srgb ...)`, or `oklab(...)` — canvas fillStyle resolves all of them
 *  to the same underlying pixel. */
async function normalizedColor(page: import('@playwright/test').Page, cssColor: string): Promise<string> {
  return page.evaluate((c) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data).join(',');
  }, cssColor);
}

/** The expected color for an N% `--color-warning` utility, computed independently of
 *  whether any Tailwind utility class is present — built only from the live
 *  `--color-warning` custom property and the browser's own `color-mix()`. */
async function expectedWarningColor(page: import('@playwright/test').Page, pct: number): Promise<string> {
  const resolved = await page.evaluate((p) => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.backgroundColor = `color-mix(in oklab, var(--color-warning) ${p}%, transparent)`;
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, pct);
  return normalizedColor(page, resolved);
}

test.describe('warning-token migration: computed cascade (#2161)', () => {
  test('every migrated site paints the EXACT --color-warning composite, not just "not the old fallback"', async ({
    page,
  }) => {
    const allHtml = Object.values(SITES)
      .map((s) => s.html)
      .join('\n');
    await renderCssFixture(page, `<div style="background:#161826">${allHtml}</div>`);

    // Cache one expected value per distinct percentage instead of recomputing per site.
    const distinctPcts = new Set<number>();
    for (const site of Object.values(SITES)) {
      if (site.borderPct !== undefined) distinctPcts.add(site.borderPct);
      if (site.bgPct !== undefined) distinctPcts.add(site.bgPct);
    }
    const expectedByPct = new Map<number, string>();
    for (const pct of distinctPcts) {
      expectedByPct.set(pct, await expectedWarningColor(page, pct));
    }

    for (const [name, site] of Object.entries(SITES)) {
      const el = page.locator(`[data-site="${name}"]`);
      const { border, bg } = await el.evaluate((node) => {
        const cs = getComputedStyle(node);
        return { border: cs.borderColor, bg: cs.backgroundColor };
      });

      if (site.borderPct !== undefined) {
        const normBorder = await normalizedColor(page, border);
        const expected = expectedByPct.get(site.borderPct)!;
        expect(
          normBorder,
          `${name}: border must equal color-mix(--color-warning ${site.borderPct}%, transparent) exactly — ` +
            'got a different value, meaning this site is not actually painting the warning token ' +
            '(currentColor/transparent from a missing utility would also fail here, unlike a "not the old fallback" check)',
        ).toBe(expected);
      }
      if (site.bgPct !== undefined) {
        const normBg = await normalizedColor(page, bg);
        const expected = expectedByPct.get(site.bgPct)!;
        expect(
          normBg,
          `${name}: background must equal color-mix(--color-warning ${site.bgPct}%, transparent) exactly`,
        ).toBe(expected);
      }
    }
  });
});
