/**
 * Semantic-warning color token migration (issue #2161).
 *
 * #1533's PR defined `--color-warning: #d97706` but left every raw `amber-*`
 * Tailwind utility that actually renders semantic warning state (a caution
 * banner, a "shown once" disclosure, a disabled-feature notice, …) untouched.
 * This suite pins the migrated sites so a future edit cannot silently drop
 * them back onto a raw `amber-*` class.
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
 * is a small, deliberate, contrast-checked color move, not a no-op formalization
 * (white-on-button contrast: 3.20:1 -> 3.19:1, both already below the 4.5:1 AA
 * text threshold before this PR — pre-existing, not introduced or worsened here).
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
  /** var(--color-warning) usages that must be present. */
  requiredPatterns: RegExp[];
}

const MIGRATED_SITES: MigratedSite[] = [
  {
    file: 'features/encounters/SpellbookPanel.tsx',
    bannedPatterns: [/border-amber-500\/50/, /bg-amber-600\b/],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/50/, /bg-\[var\(--color-warning\)\]/],
  },
  {
    file: 'features/admin/MembersPage.tsx',
    bannedPatterns: [/border-amber-600\/40/],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/40/],
  },
  {
    file: 'features/notes/InboxPage.tsx',
    bannedPatterns: [/border-amber-600\/40/],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/40/],
  },
  {
    file: 'components/AudienceField.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/10/],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/10/],
  },
  {
    file: 'components/EntityRevealDialog.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/10/],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/10/],
  },
  {
    file: 'features/dashboard/HandoutsCard.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/10/],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/10/],
  },
  {
    file: 'components/VisibleToPlayersBar.tsx',
    bannedPatterns: [/border-amber-500\/35 bg-amber-500\/10/g],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/35 bg-\[var\(--color-warning\)\]\/10/g],
  },
  {
    file: 'features/encounters/RunSessionPage.tsx',
    bannedPatterns: [/border-amber-500\/40 bg-amber-500\/10/g],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/40 bg-\[var\(--color-warning\)\]\/10/g],
  },
  {
    file: 'features/encounters/EncounterWhisperComposer.tsx',
    // Border only — the form also carries text-amber-300 (title) and
    // focus:ring-amber-400 (textarea), deliberately left raw; see PR
    // description ("no text-safe --color-warning role").
    bannedPatterns: [/rounded-lg border border-amber-500\/30 bg-neutral-900\/90/],
    requiredPatterns: [/rounded-lg border border-\[var\(--color-warning\)\]\/30 bg-neutral-900\/90/],
  },
  {
    file: 'features/admin/CampaignAuditPage.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/5/],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/5/],
  },
  {
    file: 'features/admin/AuditLogCard.tsx',
    bannedPatterns: [/border-amber-500\/30 bg-amber-500\/5/],
    requiredPatterns: [/border-\[var\(--color-warning\)\]\/30 bg-\[var\(--color-warning\)\]\/5/],
  },
  {
    file: 'features/admin/ResetRequestsCard.tsx',
    // Border only — the heading directly below stays text-amber-500 (raw);
    // same "no text-safe role" reasoning as EncounterWhisperComposer above.
    bannedPatterns: [/"border border-amber-500\/30 rounded p-2\.5 space-y-1"/],
    requiredPatterns: [/"border border-\[var\(--color-warning\)\]\/30 rounded p-2\.5 space-y-1"/],
  },
];

test.describe('Semantic-warning token migration (#2161)', () => {
  for (const site of MIGRATED_SITES) {
    test(`${site.file} uses --color-warning, not raw amber, at its migrated site(s)`, () => {
      const text = READ(site.file);
      for (const pattern of site.bannedPatterns) {
        expect(text, `${site.file} must not reintroduce ${pattern}`).not.toMatch(pattern);
      }
      for (const pattern of site.requiredPatterns) {
        expect(text, `${site.file} must reference --color-warning via ${pattern}`).toMatch(pattern);
      }
    });
  }

  test('--color-warning token itself stays defined', () => {
    const css = READ('index.css');
    expect(css).toMatch(/--color-warning:\s*#d97706/);
  });
});
