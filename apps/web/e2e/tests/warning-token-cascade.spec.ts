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
 * elsewhere in this codebase (see AGENTS.md/this repo's own review history).
 *
 * Real re-measurement (Chromium via `renderCssFixture` against the actual
 * compiled `dist` CSS, not source inspection) found FOUR of the sixteen
 * migrated declarations are exactly this trap — completely inert, still
 * painting their pre-migration fallback color:
 *
 *   - `CampaignAuditPage.tsx:294` — renders through `<Card>`, whose `cf-card`
 *     class carries an unlayered `background: var(--cf-card); border: 1px
 *     solid var(--color-divider);` (index.css). Both win over the arbitrary
 *     utility outright.
 *   - `MembersPage.tsx:483` / `InboxPage.tsx:700` — both carry `cf-inset`,
 *     whose unlayered `background: var(--cf-surface); border: 1px solid
 *     var(--color-divider);` (index.css) does the same.
 *   - `SpellbookPanel.tsx:484` — the button carries `.btn`, and nocturne.css's
 *     unlayered `.btn { background: 0 0; border: 1px solid #0000; }` resets
 *     the background to fully transparent before `.btn-primary` (also
 *     unlayered) ever applies its own `border-color`. The base state paints
 *     transparent (showing the modal's `bg-neutral-900` through it), and
 *     `:hover`/`:active` paint an accent-tinted `color-mix()` overlay — never
 *     amber, never `--color-warning`, before or after this migration. This
 *     also means the contrast numbers reported for this button in the PR
 *     description's first pass (white text on a solid amber/warning fill)
 *     were measuring a background that was never actually painted.
 *
 * Tracked in the PR thread pending a design decision (a `!` important
 * escape hatch mirroring the existing `MembersPage.tsx:1617` precedent, an
 * unlayered semantic modifier class, or something else) — NOT fixed
 * silently here. Until that lands, this suite documents the current,
 * measured reality (12 sites effective, 4 known inert) so CI stays an
 * honest, passing description of what the browser paints today rather than
 * a red suite blocking unrelated work OR a green suite that certifies a
 * no-op as done. `KNOWN_INERT` below is the complete list; any site not in
 * it is asserted EFFECTIVE, and dropping a site from `KNOWN_INERT` without
 * an accompanying code fix will fail loudly here.
 */

const KNOWN_INERT = new Set([
  'CampaignAuditPage:294',
  'MembersPage:483',
  'InboxPage:700',
  'SpellbookPanel:484',
]);

/** Real markup for each migrated site — matches what the actual component renders,
 *  including the wrapper classes (`card cf-card ...`, `cf-inset`, `.btn.btn-primary`)
 *  that decide whether the utility actually wins the cascade. */
const REAL_SITES: Record<string, string> = {
  'AudienceField:61':
    '<p data-site="AudienceField:61" class="text-xs text-amber-400/90 border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 rounded px-2.5 py-2">x</p>',
  'EntityRevealDialog:64':
    '<p data-site="EntityRevealDialog:64" class="m-0 text-xs text-amber-300/90 border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 rounded px-2.5 py-2">x</p>',
  'HandoutsCard:295':
    '<p data-site="HandoutsCard:295" class="m-0 text-xs text-amber-300/90 border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 rounded px-2.5 py-2">x</p>',
  'VisibleToPlayersBar:95':
    '<div data-site="VisibleToPlayersBar:95" role="status" class="flex items-center gap-3 flex-wrap rounded border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-amber-100">x</div>',
  'VisibleToPlayersBar:113':
    '<div data-site="VisibleToPlayersBar:113" role="status" class="flex items-center gap-3 flex-wrap rounded border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-amber-100">x</div>',
  'RunSessionPage:4496':
    '<div data-site="RunSessionPage:4496" role="status" class="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm">x</div>',
  'RunSessionPage:4520':
    '<div data-site="RunSessionPage:4520" role="status" class="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm flex items-center gap-2 flex-wrap">x</div>',
  'RunSessionPage:4551':
    '<div data-site="RunSessionPage:4551" role="status" class="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm flex items-center gap-2 flex-wrap">x</div>',
  'EncounterWhisperComposer:65':
    '<form data-site="EncounterWhisperComposer:65" class="mt-2 rounded-lg border border-[var(--color-warning)]/30 bg-neutral-900/90 p-3 space-y-2 text-xs">x</form>',
  'CampaignAuditPage:294':
    '<section data-site="CampaignAuditPage:294" class="card cf-card cf-density-comfortable space-y-1 border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5">x</section>',
  'AuditLogCard:173':
    '<div data-site="AuditLogCard:173" class="rounded border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 p-3 space-y-3">x</div>',
  'ResetRequestsCard:117':
    '<div data-site="ResetRequestsCard:117" class="border border-[var(--color-warning)]/30 rounded p-2.5 space-y-1">x</div>',
  'SpellbookPanel:463':
    '<div data-site="SpellbookPanel:463" class="bg-neutral-900 border border-[var(--color-warning)]/50 rounded-lg max-w-md w-full p-4 space-y-3 shadow-2xl">x</div>',
  'SpellbookPanel:484':
    '<button data-site="SpellbookPanel:484" type="button" class="btn btn-primary text-xs min-h-[44px] cf-target-44 bg-[var(--color-warning)] hover:bg-amber-500 text-white">Replace Concentration &amp; Cast</button>',
  'MembersPage:483':
    '<div data-site="MembersPage:483" data-testid="invites-suspended-banner" class="cf-inset border-[var(--color-warning)]/40 rounded px-3 py-2.5 space-y-1.5">x</div>',
  'InboxPage:700':
    '<div data-site="InboxPage:700" class="cf-inset p-3 space-y-1.5 border-[var(--color-warning)]/40">x</div>',
};

/** A bare reference element carrying ONLY the color-affecting utility classes for the
 *  same site, with no `Card`/`cf-inset`/`.btn` wrapper class to compete with it. If the
 *  utility genuinely wins the cascade, the real site's computed color equals this
 *  reference's. Proves the utility class itself is correct even for sites where the
 *  real markup is currently overridden (diagnostic value, not just a pass/fail). */
const REFERENCE_SITES: Record<string, string> = {
  'CampaignAuditPage:294':
    '<div data-site="ref:CampaignAuditPage:294" class="border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5">x</div>',
  'MembersPage:483': '<div data-site="ref:MembersPage:483" class="border-[var(--color-warning)]/40">x</div>',
  'InboxPage:700': '<div data-site="ref:InboxPage:700" class="border-[var(--color-warning)]/40">x</div>',
  'SpellbookPanel:484': '<button data-site="ref:SpellbookPanel:484" class="bg-[var(--color-warning)]">x</button>',
};

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

test.describe('warning-token migration: computed cascade (#2161)', () => {
  test('measures every migrated site\'s ACTUAL painted color, not just its source class', async ({ page }) => {
    const allHtml = [...Object.values(REAL_SITES), ...Object.values(REFERENCE_SITES)].join('\n');
    await renderCssFixture(page, `<div style="background:#161826">${allHtml}</div>`);

    // Reference token/fallback colors, resolved the same way the real elements are —
    // no hardcoded hex literals to go stale if the palette changes.
    const tokens = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const read = (v: string) => {
        probe.style.backgroundColor = `var(${v})`;
        return getComputedStyle(probe).backgroundColor;
      };
      const out = { divider: read('--color-divider'), cfCard: read('--cf-card'), cfSurface: read('--cf-surface') };
      probe.remove();
      return out;
    });
    const noOpBorder = await normalizedColor(page, tokens.divider);
    const noOpBg = await normalizedColor(page, tokens.cfCard);
    // --cf-card and --cf-surface are the same value today (both alias --color-surface);
    // assert that rather than assume it, since the no-op detection below depends on it.
    expect(await normalizedColor(page, tokens.cfSurface)).toBe(noOpBg);

    for (const [site, html] of Object.entries(REAL_SITES)) {
      void html;
      const el = page.locator(`[data-site="${site}"]`);
      const { border, bg } = await el.evaluate((node) => {
        const cs = getComputedStyle(node);
        return { border: cs.borderColor, bg: cs.backgroundColor };
      });
      const normBorder = await normalizedColor(page, border);
      const normBg = await normalizedColor(page, bg);

      if (KNOWN_INERT.has(site)) {
        // Documents the CURRENT bug precisely rather than hiding it. If this assertion
        // starts failing, it means the site's color-effectiveness changed — update
        // KNOWN_INERT (and this comment) as part of whatever change caused it, don't
        // just delete the assertion.
        const reference = REFERENCE_SITES[site];
        expect(reference, `${site} is in KNOWN_INERT but has no reference fixture`).toBeTruthy();
        const refEl = page.locator(`[data-site="ref:${site}"]`);
        const refStyle = await refEl.evaluate((n) => {
          const cs = getComputedStyle(n);
          return { border: cs.borderColor, bg: cs.backgroundColor };
        });
        const refBorder = await normalizedColor(page, refStyle.border);
        const refBg = await normalizedColor(page, refStyle.bg);
        if (site === 'SpellbookPanel:484') {
          // The button's background is fully transparent (unlayered `.btn { background:
          // 0 0 }`), not the cf-card/cf-inset divider/surface fallback the other three
          // KNOWN_INERT sites paint — different unlayered rule, same root cause. Only the
          // background was migrated here (no border utility was touched), so only the
          // reference's background is meaningful to check.
          expect(normBg, `${site}: expected still-transparent (see file header)`).toBe(await normalizedColor(page, 'rgba(0,0,0,0)'));
          expect(refBg, `${site}: the bare bg-[var(--color-warning)] utility must still resolve to the token`).not.toBe(noOpBg);
          continue;
        } else if (site === 'MembersPage:483' || site === 'InboxPage:700') {
          // Border-only migration (cf-inset never carried a bg-* utility here) — only the
          // border comparison is meaningful; the reference element has no bg-* class at
          // all, so its (always-transparent) background proves nothing about this bug.
          expect(normBorder, `${site}: expected still on --color-divider (see file header)`).toBe(noOpBorder);
          expect(refBorder, `${site}: the bare border-[var(--color-warning)] utility must still resolve to the token`).not.toBe(
            noOpBorder,
          );
          continue;
        } else {
          // Only CampaignAuditPage:294 reaches here — migrated both border and background.
          expect(normBorder, `${site}: expected still on --color-divider (see file header)`).toBe(noOpBorder);
          expect(normBg, `${site}: expected still on --cf-card/--cf-surface (see file header)`).toBe(noOpBg);
          // The bare utility classes DO resolve to the token — confirms the bug is the
          // unlayered wrapper rule (cf-card), not the utility classes themselves.
          expect(refBorder, `${site}: the bare utility classes must still resolve to --color-warning`).not.toBe(noOpBorder);
          expect(refBg, `${site}: the bare utility classes must still resolve to --color-warning`).not.toBe(noOpBg);
        }
      } else {
        expect(normBorder, `${site}: border must not have fallen back to --color-divider`).not.toBe(noOpBorder);
        if (site !== 'ResetRequestsCard:117') {
          // ResetRequestsCard:117 only migrated the border; it never had a background
          // utility (transparent before and after), so there is no bg fallback to check.
          expect(normBg, `${site}: background must not have fallen back to --cf-card/--cf-surface`).not.toBe(noOpBg);
        }
      }
    }
  });
});
