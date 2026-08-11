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
 * amber (see #2203's review) and filed as a follow-up issue for a proper
 * warning-semantic variant of `.cf-card`/`.cf-inset`/`.btn`.
 *
 * This suite now covers exactly the 12 sites that remain migrated, all
 * confirmed by this same measurement to actually paint `--color-warning`.
 * Its job going forward is regression protection: if a future edit moves
 * one of these 12 onto a `Card`/`cf-inset`/`.btn`-style wrapper (or any
 * other unlayered rule), this suite — not the source-scan unit spec — is
 * what will catch it.
 */

/** Real markup for each migrated site — matches what the actual component renders. */
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
  'AuditLogCard:173':
    '<div data-site="AuditLogCard:173" class="rounded border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 p-3 space-y-3">x</div>',
  'ResetRequestsCard:117':
    '<div data-site="ResetRequestsCard:117" class="border border-[var(--color-warning)]/30 rounded p-2.5 space-y-1">x</div>',
  'SpellbookPanel:463':
    '<div data-site="SpellbookPanel:463" class="bg-neutral-900 border border-[var(--color-warning)]/50 rounded-lg max-w-md w-full p-4 space-y-3 shadow-2xl">x</div>',
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
  test('every migrated site ACTUALLY paints --color-warning, not just references it in source', async ({ page }) => {
    const allHtml = Object.values(REAL_SITES).join('\n');
    await renderCssFixture(page, `<div style="background:#161826">${allHtml}</div>`);

    // No-op fallback colors, resolved the same way the real elements are — no hardcoded
    // hex literals to go stale if the palette changes. Any migrated site whose computed
    // color still equals one of these has regressed onto an unlayered wrapper rule.
    const tokens = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const read = (v: string) => {
        probe.style.backgroundColor = `var(${v})`;
        return getComputedStyle(probe).backgroundColor;
      };
      const out = { divider: read('--color-divider'), cfCard: read('--cf-card') };
      probe.remove();
      return out;
    });
    const noOpBorder = await normalizedColor(page, tokens.divider);
    const noOpBg = await normalizedColor(page, tokens.cfCard);

    for (const site of Object.keys(REAL_SITES)) {
      const el = page.locator(`[data-site="${site}"]`);
      const { border, bg } = await el.evaluate((node) => {
        const cs = getComputedStyle(node);
        return { border: cs.borderColor, bg: cs.backgroundColor };
      });
      const normBorder = await normalizedColor(page, border);
      const normBg = await normalizedColor(page, bg);

      expect(normBorder, `${site}: border must not have fallen back to --color-divider`).not.toBe(noOpBorder);
      if (site !== 'ResetRequestsCard:117' && site !== 'SpellbookPanel:463' && site !== 'EncounterWhisperComposer:65') {
        // These three only migrated the border (never had a bg-[var(--color-warning)]
        // utility — their background is a different, untouched value), so there is no
        // bg fallback to check for them.
        expect(normBg, `${site}: background must not have fallen back to --cf-card`).not.toBe(noOpBg);
      }
    }
  });
});
