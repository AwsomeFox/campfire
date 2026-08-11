/**
 * Nocturne dead-rule guards (issue #2192).
 *
 * PR #2189 pinned several of nocturne.css's direct `--space-*` consumers against
 * the compiled stylesheet. While doing so it surfaced rules that ship in the
 * bundle but have no consumer in `apps/web/src`:
 *
 *   - `.table` / `.table th` / `.table td` / `.table thead tr` / `.table tbody tr`
 *     (nocturne.css) — zero JSX composers. Every real table in the app is a bare
 *     `<table className="w-full text-sm">` styled by `.cf-prose table`
 *     (index.css); nothing composes the `.table` class. Removed.
 *   - `.nav` / `.nav-brand` / `.nav a` (nocturne.css) — zero JSX composers. App
 *     chrome uses `.cf-nav-*` / `.settings-*-nav` / `.settings-nav`, never the
 *     bare `.nav` class. Removed.
 *   - `figcaption` (nocturne.css) — a bare element selector no JSX source
 *     emits, BUT DOMPurify's default allowlist passes it through from
 *     user-supplied Markdown (Markdown.tsx), so it renders at runtime.
 *     Retained (see the assertion below); only the consumerless class rules
 *     above were removed. `figure { margin: 0; }` is also retained as a
 *     generic UA reset.
 *
 * `.hr` was investigated and DELIBERATELY RETAINED (see the assertion below): it
 * is live at `Layout.tsx`'s sidebar divider (`<div className="hr my-1" />`), where
 * its `margin: var(--space-4) 0` beats Tailwind's layered `my-1` (nocturne.css
 * imports unlayered) — pinned at 11.2px by the live-page test in
 * control-surface-goldens.spec.ts. Its three other call sites override that margin
 * intentionally (LoginPage `0`, AddCombatantPanel `4px 0`, QuestPage `6px 0`), and
 * its gradient visual applies at all four. It is not dead code; this guard exists
 * so a future cleanup that re-reads #2192's "all three call sites" premise (which
 * #2189 already corrected — there is a fourth, non-overridden site) cannot remove
 * `.hr` by mistake.
 *
 * This is a pure unit test — it reads CSS source and never starts the backend —
 * so it runs under the same Playwright runner as the other `.unit.spec.ts` files
 * without needing the seeded server or a built `dist`.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(__dirname, '../..');
const NOCTURNE_CSS = resolve(WEB_ROOT, 'src', 'nocturne.css');

/** Strip block comments so selectors mentioned only in comments are ignored. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('issue #2192: the consumer-less nocturne rules stay removed', () => {
  const source = stripComments(readFileSync(NOCTURNE_CSS, 'utf8'));

  // `.table` — class selector, zero JSX composers (real tables use `.cf-prose table`).
  expect(
    source,
    '.table must stay removed — it has no JSX consumer (issue #2192)',
  ).not.toMatch(/\.table(?![\w-])/);
  // `.nav` — class selector family (.nav, .nav-brand, .nav a, …), zero composers.
  // App chrome uses .cf-nav-* / .settings-*-nav / .settings-nav, never the bare
  // class. The regex matches `.nav` followed by a selector-continuation char
  // (space, `-`, `:`, `,`, `{`) or end-of-line, so it catches every removed
  // variant (.nav, .nav-brand, .nav a) but not unrelated classes like .navigation.
  expect(
    source,
    '.nav family must stay removed — app chrome uses .cf-nav-*/.settings-*-nav, never .nav (issue #2192)',
  ).not.toMatch(/\.nav(?:[-\s,:{]|$)/);
});

test('issue #2192: .hr is retained (live at Layout.tsx, not dead)', () => {
  const source = stripComments(readFileSync(NOCTURNE_CSS, 'utf8'));

  // `.hr` is LIVE at Layout.tsx:973 (`className="hr my-1"`, no inline override):
  // its `--space-4` margin wins over Tailwind's layered `my-1`. The three other
  // call sites override its margin intentionally. See control-surface-goldens.spec.ts
  // for the live-page pin (11.2px). Do NOT remove `.hr`.
  expect(
    source,
    '.hr must stay — it is live at Layout.tsx sidebar divider; #2192 only removes consumerless rules',
  ).toMatch(/\.hr(?![\w-])/);
});

test('issue #2192: figcaption is retained (rendered by sanitized user Markdown)', () => {
  const source = stripComments(readFileSync(NOCTURNE_CSS, 'utf8'));

  // `figcaption` is a bare element selector — no JSX emits it — BUT
  // DOMPurify.sanitize(marked.parse(...)) in Markdown.tsx passes <figcaption>
  // through from user-supplied Markdown (quest bodies, notes, etc.), so it
  // renders at runtime. Removing the styling would silently strip caption
  // formatting from rendered Markdown. Do NOT remove `figcaption`.
  expect(
    source,
    'figcaption must stay — it is rendered by sanitized user Markdown (DOMPurify allows it); removing it strips caption styling',
  ).toMatch(/figcaption\s*\{/i);
});
