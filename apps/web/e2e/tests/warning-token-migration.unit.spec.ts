/**
 * Semantic-warning color token migration (issue #2161).
 *
 * #1533's PR defined `--color-warning: #d97706` but left every raw `amber-*`
 * Tailwind utility that actually renders semantic warning state (a caution
 * banner, a "shown once" disclosure, a disabled-feature notice, …) untouched.
 * This suite pins the SOURCE at each migrated site so a future edit cannot
 * silently drop it back onto a raw `amber-*` class. It is deliberately a
 * cheap, fast smoke check, not the authoritative correctness check —
 * `warning-token-cascade.spec.ts` (browser-backed) is that: this codebase's
 * `index.css`/`nocturne.css` are imported unlayered, which always beats a
 * layered Tailwind utility (including an arbitrary-value one) regardless of
 * specificity or source order, so a source string can be byte-identical
 * between a working migration and a completely inert one. Real measurement
 * found FOUR of the sixteen sites below are exactly that trap — see
 * `warning-token-cascade.spec.ts`'s file header for the full mechanism and
 * the `KNOWN_INERT` list. This spec still asserts the source presence at
 * every one of the 16 (necessary, not sufficient), and additionally asserts
 * an exact PER-FILE occurrence COUNT for files with more than one migrated
 * declaration (`VisibleToPlayersBar.tsx`: 2, `RunSessionPage.tsx`: 3) —
 * matching only "at least one" would let one of several sites silently
 * regress back to raw amber while the others keep the test green.
 *
 * Scope (see the PR description for the full audit): `--color-warning` is a
 * single flat hex, unlike `--color-danger`'s multi-role family
 * (`--color-danger`, `--color-danger-solid*`, `--color-danger-border`,
 * `--color-danger-focus`, `--color-danger-ghost-*`, `--color-danger-disabled-*`).
 * Only the non-text roles (border, background tint, and one solid-fill site
 * where source-level `amber-600` was already the closest Tailwind step to
 * `--color-warning`) were migrated. Measured in a real Chromium canvas
 * against this app's actual compiled theme (Tailwind v4 ships its palette as
 * oklch, not hex) rather than assumed: `amber-600` resolves to rgb(225,113,0),
 * `--color-warning` to rgb(217,119,6) — close but NOT byte-identical, so this
 * is a small, deliberate, contrast-checked color move, not a no-op formalization.
 * (The white-on-button contrast number reported for `SpellbookPanel.tsx:484`
 * against this pairing was later found to describe a background that is
 * never actually painted there — see `warning-token-cascade.spec.ts`.)
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
    bannedPatterns: [/border-amber-500\/50/, /bg-amber-600\b/],
    requiredPatterns: [
      { pattern: /border-\[var\(--color-warning\)\]\/50/g, count: 1 },
      { pattern: /bg-\[var\(--color-warning\)\]/g, count: 1 },
    ],
  },
  {
    file: 'features/admin/MembersPage.tsx',
    bannedPatterns: [/border-amber-600\/40/],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/40/g, count: 1 }],
  },
  {
    file: 'features/notes/InboxPage.tsx',
    bannedPatterns: [/border-amber-600\/40/],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/40/g, count: 1 }],
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
    file: 'features/admin/CampaignAuditPage.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/5/],
    requiredPatterns: [{ pattern: /border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/5/g, count: 1 }],
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
