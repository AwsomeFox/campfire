/**
 * Semantic-warning color token migration (issue #2161).
 *
 * #1533's PR defined `--color-warning: #d97706` but left every raw `amber-*`
 * Tailwind utility that actually renders semantic warning state (a caution
 * banner, a "shown once" disclosure, a disabled-feature notice, …) untouched.
 * This suite pins the SOURCE at each migrated site so a future edit cannot
 * silently drop it back onto a raw `amber-*` class. It is deliberately a
 * cheap, fast smoke check, **necessary but not sufficient** — a source string
 * can be byte-identical between a working migration and a completely inert
 * one whenever the element renders through a component (`<Card>`, `cf-inset`,
 * `.btn`) carrying an unlayered `background`/`border` shorthand, since
 * `index.css`/`nocturne.css` are imported unlayered and always beat a layered
 * Tailwind utility (including an arbitrary-value one) regardless of
 * specificity or source order. `warning-token-cascade.spec.ts`
 * (browser-backed, real `getComputedStyle`) is the check that actually proves
 * a site paints the right color; run it, don't just read this one, before
 * trusting a "migrated" claim on this codebase's design-system classes.
 *
 * That trap caught 4 of this PR's original 16 candidate sites
 * (`CampaignAuditPage.tsx:294` via `<Card>`'s `cf-card`, `MembersPage.tsx:483`
 * and `InboxPage.tsx:700` via `cf-inset`, `SpellbookPanel.tsx:484` via
 * `.btn`'s `background: 0 0` reset) — all four were reverted rather than
 * shipped as source that claims `--color-warning` while painting
 * `--color-divider`/`--cf-card`/transparent. Filed as a follow-up issue
 * (warning-semantic variants for `.cf-card`/`.cf-inset`/`.btn`) rather than
 * fixed here with an `!important` escape or a new unlayered modifier class —
 * both are real design decisions, not mechanical fixes, and out of scope for
 * a color migration. The 12 sites below are confirmed, by that same
 * computed-style measurement, to actually paint `--color-warning`.
 *
 * This spec asserts source presence at each of the 12, with an exact
 * PER-FILE occurrence COUNT for files with more than one migrated
 * declaration (`VisibleToPlayersBar.tsx`: 2, `RunSessionPage.tsx`: 3) —
 * matching only "at least one" would let one of several sites silently
 * regress back to raw amber while the others keep the test green.
 *
 * Scope (see the PR description for the full audit): `--color-warning` is a
 * single flat hex, unlike `--color-danger`'s multi-role family
 * (`--color-danger`, `--color-danger-solid*`, `--color-danger-border`,
 * `--color-danger-focus`, `--color-danger-ghost-*`, `--color-danger-disabled-*`).
 * Only the non-text roles (border and background tint) were migrated.
 * Readable warning TEXT color, dark "muted surface" tints (`amber-950/*`), and
 * decorative/selection uses of amber are deliberately left alone — see the
 * PR description for the full excluded population and why. This guard
 * therefore only covers the sites actually migrated, not every `amber-*` in
 * the app: raw amber remains a legitimate decorative or not-yet-staged
 * choice everywhere else.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../src');
const READ = (relPath: string) => readFileSync(resolve(ROOT, relPath), 'utf8');

interface MigratedSite {
  file: string;
  /** Raw amber-* declarations that must never reappear at this site. */
  bannedPatterns: RegExp[];
  /**
   * var(--color-warning) usages that must be present, each with the EXACT number of
   * occurrences expected in the file. A plain `toMatch` (at-least-one) check would pass
   * for a file with N migrated call sites even if all but one regressed back to raw
   * amber — VisibleToPlayersBar.tsx (2 sites) and RunSessionPage.tsx (3 sites) are
   * exactly that shape today, and more will be as this migration continues. Counting
   * exact occurrences catches a partial regression a presence-only check cannot.
   */
  requiredPatterns: Array<{ pattern: RegExp; count: number }>;
}

const MIGRATED_SITES: MigratedSite[] = [
  {
    file: 'features/encounters/SpellbookPanel.tsx',
    // Only the modal border (:463) is migrated. The confirm button's bg-amber-600
    // (:484) was reverted (#2203 review) — it renders through `.btn`, whose unlayered
    // `background: 0 0` (nocturne.css) made bg-[var(--color-warning)] a no-op there;
    // see the file header and the follow-up issue tracking a proper fix.
    bannedPatterns: [/border-amber-500\/50/],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/50/g, count: 1 }],
  },
  {
    file: 'components/AudienceField.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/10/],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/10/g, count: 1 }],
  },
  {
    file: 'components/EntityRevealDialog.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/10/],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/10/g, count: 1 }],
  },
  {
    file: 'features/dashboard/HandoutsCard.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/10/],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/10/g, count: 1 }],
  },
  {
    file: 'components/VisibleToPlayersBar.tsx',
    // 2 migrated sites (:95 hidden-from-players, :113 visible-to-players).
    bannedPatterns: [/border-amber-500\/35 bg-amber-500\/10/g],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/35 bg-\[var\(--color-warning\)\]\/10/g, count: 2 }],
  },
  {
    file: 'features/encounters/RunSessionPage.tsx',
    // 3 migrated sites (:4496 reconcile banner, :4520/:4551 sync-override prompts).
    bannedPatterns: [/border-amber-500\/40 bg-amber-500\/10/g],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/40 bg-\[var\(--color-warning\)\]\/10/g, count: 3 }],
  },
  {
    file: 'features/encounters/EncounterWhisperComposer.tsx',
    // Border only — the form also carries text-amber-300 (title) and
    // focus:ring-amber-400 (textarea), deliberately left raw; see PR
    // description ("no text-safe --color-warning role").
    bannedPatterns: [/rounded-lg border border-amber-500\/30 bg-neutral-900\/90/],
    requiredPatterns: [{ pattern: /rounded-lg border border-\[var\(--color-warning\)\]\/30 bg-neutral-900\/90/g, count: 1 }],
  },
  {
    file: 'features/admin/AuditLogCard.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/5/],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/5/g, count: 1 }],
  },
  {
    file: 'features/admin/ResetRequestsCard.tsx',
    // Border only — the heading directly below stays text-amber-500 (raw);
    // same "no text-safe role" reasoning as EncounterWhisperComposer above.
    bannedPatterns: [/"border border-amber-500\/30 rounded p-2\.5 space-y-1"/],
    requiredPatterns: [{ pattern: /"border border-\[var\(--color-warning\)\]\/30 rounded p-2\.5 space-y-1"/g, count: 1 }],
  },
];

test.describe('Semantic-warning token migration (#2161)', () => {
  for (const site of MIGRATED_SITES) {
    test(`${site.file} uses --color-warning, not raw amber, at its migrated site(s)`, () => {
      const text = READ(site.file);
      for (const pattern of site.bannedPatterns) {
        expect(text, `${site.file} must not reintroduce ${pattern}`).not.toMatch(pattern);
      }
      for (const { pattern, count } of site.requiredPatterns) {
        const matches = text.match(pattern);
        const actual = matches ? matches.length : 0;
        expect(
          actual,
          `${site.file} must reference --color-warning via ${pattern} exactly ${count} time(s), found ${actual} — ` +
            'a partial regression (some sites migrated, others reverted to raw amber) must fail here, not pass on "at least one"',
        ).toBe(count);
      }
    });
  }

  test('--color-warning token itself stays defined', () => {
    const css = READ('index.css');
    expect(css).toMatch(/--color-warning:\s*#d97706/);
  });
});
