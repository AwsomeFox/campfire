/**
 * z-index bypass audit (issue #2163).
 *
 * #2163 asked which `z-index` sites in `index.css` ACTUALLY bypass the documented overlay
 * stacking scale (`--cf-layer-*`, issue #791) — not which ones merely look raw in a text
 * grep. A raw literal only "bypasses" the scale if it is compared against the scale's own
 * elements in the SAME stacking context; an element nested inside something that already
 * establishes its own stacking context (`position` + non-auto `z-index`, `transform`,
 * `opacity < 1`, …) has its z-index scoped to that ancestor and can never leak out to
 * compete with a sibling of the ancestor, no matter how large the number is.
 *
 * PR #2202 review (Codex): the first version of this audit whitelisted `.cf-gated-hint`
 * (base, non-escaped) as local on the strength of an incomplete render-site enumeration — it
 * traced `GatedControl` only through the encounter cockpit and `DeathSaveTracker`, and missed
 * that `DiceTray`'s advantage/disadvantage toggle also uses `GatedControl`, and that
 * `SharedDiceLog` mounts `DiceTray` on the plain Dashboard (`DiceWidget`) and the character
 * sheet — neither wrapped in `.cf-vtt` or any other stacking-context-establishing ancestor.
 * There the hint sits directly in `.cf-authed-shell`, the SAME local context Layout's sticky
 * mobile header (Tailwind `z-30`) does, and the hint's old literal `30` was an exact TIE with
 * it — decided only by DOM order (the hint always renders later), so it really could paint
 * over chrome by coincidence. That was a genuine bypass, now fixed in index.css by reusing
 * the existing `--cf-layer-immersive` token (already used by `.cf-gated-hint--escaped` for
 * the identical "must clear ordinary page chrome" reason) on the base rule too — see
 * `z-index-audit-gated-hint-stacking.spec.ts` for the live proof, which does NOT use
 * `elementFromPoint` (the hint is `pointer-events: none`, so hit-testing would silently skip
 * it) and instead measures that the hint and header share one stacking-context ancestor
 * before comparing their z-index numbers.
 *
 * Re-measured on the current tree (not the `c44baf05a` snapshot the issue cites, nor the
 * pre-fix count from this file's own first version), index.css has 25 `z-index`
 * declarations:
 *
 *   - 10 already consume a `--cf-layer-*` token (or `calc()` over one) — never audited here.
 *   - 2 are resets (`0`, `auto`) that are not stacking-tier decisions.
 *   - 13 are raw literals, enumerated and classified below. Every one of the remaining 13
 *     turned out to be genuinely LOCAL once its containing stacking context was traced —
 *     including `.cf-death-save-spectator-toast`, the other site #2163 flagged as "plausible
 *     real drift" (see its note below and the live measurement in
 *     `z-index-audit-toast-stacking.spec.ts`, which proves the containment rather than just
 *     reading it off the source).
 *
 * This is the "guard test scoped to whatever the audit concludes" #2163 asked for. It is
 * deliberately narrower than "no raw z-index outside the documented scale" — that blanket
 * rule would incorrectly flag the VTT cockpit's own legitimate local nesting order (issue's
 * own words). Instead it pins the EXACT audited set: a new raw z-index declaration, or a
 * changed value on an existing one, fails this test and forces a conscious reclassification
 * rather than silently landing outside the audit.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_CSS = resolve(__dirname, '../../src/index.css');

/** One `selector { … z-index: value; … }` rule's immediate selector and z-index value. */
interface Declaration {
  selector: string;
  value: string;
}

/** Every `z-index` declaration in `index.css`, in source order, with its rule's selector. */
function allZIndexDeclarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css))) {
    const [, rawSelector, body] = m;
    const selector = rawSelector.trim().split('\n').pop()!.trim();
    for (const zm of body.matchAll(/z-index:\s*([^;]+);/g)) {
      out.push({ selector, value: zm[1].trim() });
    }
  }
  return out;
}

const TOKEN_RE = /var\(--cf-layer-/;

/**
 * The 13 raw (non-token, non-reset) z-index literals as re-measured on the current tree,
 * each with why it is genuinely local rather than a scale bypass. Order matches source order.
 *
 * `.cf-gated-hint` is deliberately NOT here — it was in the first version of this list
 * (whitelisted as local) and that was wrong; see the module doc comment. It now consumes
 * --cf-layer-immersive and is covered by the ".cf-gated-hint--escaped" test below instead.
 */
const AUDITED_RAW_LITERALS: Array<Declaration & { note: string }> = [
  {
    selector: '.cf-authed-shell',
    value: '1',
    note: 'Lifts the whole app shell just above the decorative .cf-ember-layer (z:0) background. This IS the ancestor stacking context every documented tier (chrome, tabbar, immersive, …) nests inside — infrastructure, not a scale participant.',
  },
  {
    selector: '.cf-campaign-cover__content',
    value: '1',
    note: 'Lifts cover text above its own texture/overlay decorative layers within the same small card. No documented tier is anywhere nearby.',
  },
  {
    selector: '.cf-death-save-spectator-toast',
    value: '40',
    note: 'Renders only as a child passed to EncounterVttShell (RunSessionPage’s sole root, see encounter-cockpit-layout.unit.spec.ts), i.e. inside .cf-vtt, which is itself position:fixed with an explicit z-index (var(--cf-layer-immersive), 41) — a stacking context. The toast’s local "40" is compared only against its .cf-vtt siblings, never against --cf-layer-tabbar’s "40": the whole .cf-vtt subtree already paints atomically above the tab bar (41 > 40). The numeric coincidence with the tabbar tier is a documentation smell, not a functional bypass — verified live in z-index-audit-toast-stacking.spec.ts.',
  },
  {
    selector: '.cf-hp-feedback',
    value: '20',
    note: 'Transient floating HP delta over one combatant row (issue #1907). Below the lowest documented tier (chrome, 30) regardless of context, so it can never compete with the scale even in the worst case.',
  },
  {
    selector: '.cf-vtt-header',
    value: '20',
    note: 'A grid item ordered among .cf-vtt’s own header/banners/body/children siblings, entirely inside .cf-vtt’s own local stacking context (41). Never compared to anything outside it.',
  },
  { selector: '.cf-vtt-panel-reopen', value: '12', note: 'VTT cockpit local nesting order (issue #2163 body) — the side-panel reopen tab.' },
  { selector: '.cf-vtt-strip', value: '9', note: 'VTT cockpit local nesting order (issue #2163 body) — the mobile turn strip.' },
  { selector: '.cf-vtt-strip-toggle', value: '2', note: 'VTT cockpit local nesting order (issue #2163 body) — must sit above the strip it opens.' },
  { selector: '.cf-vtt-fab', value: '14', note: 'VTT cockpit local nesting order (issue #2163 body) — the floating roll button.' },
  { selector: '.cf-vtt-tray', value: '13', note: 'VTT cockpit local nesting order (issue #2163 body) — the dice tray.' },
  { selector: '.cf-vtt-map .cf-vtt-rail', value: '10', note: 'VTT cockpit local nesting order (issue #2163 body) — the map tool rail.' },
  {
    selector: '.cf-vtt-map .cf-vtt-map-tray',
    value: '8',
    note: 'VTT cockpit local nesting order (issue #2163 body) — this z-index:8 rule is actually a combined selector, `.cf-vtt-map .cf-vtt-map-aside, .cf-vtt-map .cf-vtt-map-tray { … }`; it governs BOTH the grid/fog aside panel and the floating token tray, not just the tray (review finding, PR #2202). Recorded under the tray\'s name only because allZIndexDeclarations keys off the last selector line of a rule — the aside shares this exact declaration and needs no entry of its own.',
  },
  { selector: ".cf-vtt-map [data-testid='map-viewport-toolbar']", value: '9', note: 'VTT cockpit local nesting order (issue #2163 body) — the viewport toolbar.' },
];

/** The 2 declarations that reset stacking rather than choose a tier — not stacking decisions. */
const AUDITED_RESETS: Declaration[] = [
  { selector: '.cf-ember-layer', value: '0' },
  { selector: '.cf-vtt', value: 'auto' }, // print-media override; the live rule is the tokenized one below.
];

test.describe('z-index bypass audit (issue #2163)', () => {
  test('every raw z-index literal in index.css is one of the 13 audited local-context sites', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    const declarations = allZIndexDeclarations(css);

    const tokenized = declarations.filter((d) => TOKEN_RE.test(d.value));
    const resets = declarations.filter((d) => !TOKEN_RE.test(d.value) && (d.value === '0' || d.value === 'auto'));
    const raw = declarations.filter((d) => !TOKEN_RE.test(d.value) && d.value !== '0' && d.value !== 'auto');

    // Re-measured counts (see the module doc comment) — a change here means the inventory
    // itself moved and needs re-auditing, not that this test's numbers should just follow.
    expect(declarations, 'total z-index declarations in index.css').toHaveLength(25);
    expect(tokenized, 'declarations already consuming a --cf-layer-* token').toHaveLength(10);
    expect(resets, 'z-index:0 / z-index:auto resets').toHaveLength(2);
    expect(raw, 'raw literal z-index declarations').toHaveLength(AUDITED_RAW_LITERALS.length);

    for (const reset of AUDITED_RESETS) {
      expect(resets, `expected reset ${reset.selector} { z-index: ${reset.value} }`).toContainEqual(reset);
    }

    // Every raw literal must be exactly one of the audited (selector, value) pairs. A new
    // raw z-index — or a changed value on an existing one — fails here rather than silently
    // landing outside the audit.
    const audited = new Set(AUDITED_RAW_LITERALS.map((d) => `${d.selector} :: ${d.value}`));
    for (const d of raw) {
      expect(audited.has(`${d.selector} :: ${d.value}`), `unaudited raw z-index: ${d.selector} { z-index: ${d.value} } — classify it (see this file's module doc comment) and add it to AUDITED_RAW_LITERALS, or migrate it onto the matching --cf-layer-* token if it actually competes with the documented scale`).toBe(true);
    }
    // And the reverse: every audited site must still exist with its audited value, so a
    // literal that quietly migrates onto a token (good!) also has to update this list.
    for (const d of AUDITED_RAW_LITERALS) {
      expect(raw, `expected still-local site ${d.selector} { z-index: ${d.value} }`).toContainEqual({ selector: d.selector, value: d.value });
    }
  });

  test('.cf-vtt is a real stacking context, not just position:fixed', () => {
    // encounter-cockpit-layout.unit.spec.ts already pins position:fixed + inset:0 on this
    // block; this pins the other half of what makes it a stacking context (a non-auto
    // z-index), which is the mechanism every "local literal nested in .cf-vtt" note above
    // depends on.
    //
    // Reuses allZIndexDeclarations's regex-based rule parser rather than an indexOf/slice
    // window (review finding, PR #2202): that parser tolerates formatting the way brittle
    // substring bounds do not (e.g. `.cf-vtt\n{`), and a genuinely missing `.cf-vtt` z-index
    // fails with "expected true" against a concrete declaration list, not a silent -1 slice.
    const css = readFileSync(INDEX_CSS, 'utf8');
    const declarations = allZIndexDeclarations(css);
    expect(declarations, JSON.stringify(declarations)).toContainEqual({
      selector: '.cf-vtt',
      value: 'var(--cf-layer-immersive)',
    });
  });

  test('.cf-gated-hint and .cf-gated-hint--escaped both consume the immersive token (issue #2163 review fix)', () => {
    const gatedControl = readFileSync(
      resolve(__dirname, '../../src/components/GatedControl.tsx'),
      'utf8',
    );
    expect(gatedControl).toMatch(/createPortal\(hintNode, document\.body\)/);

    const css = readFileSync(INDEX_CSS, 'utf8');
    // The base rule: was the literal 30 (a tie with the chrome tier's Tailwind z-30 wherever
    // GatedControl renders outside .cf-vtt — see z-index-audit-gated-hint-stacking.spec.ts
    // for why that was a real bypass, not a theoretical one) — now the same token formula the
    // escaped variant already used.
    expect(css).toMatch(
      /\.cf-gated-hint\s*\{[^}]*z-index:\s*calc\(var\(--cf-layer-immersive,\s*41\)\s*\+\s*1\);/,
    );
    // The escaped variant: unchanged, still needs its own tier once it leaves the trigger's
    // context entirely (portaled to <body>, competing with top-level contexts directly).
    expect(css).toMatch(
      /\.cf-gated-hint--escaped\s*\{\s*z-index:\s*calc\(var\(--cf-layer-immersive,\s*41\)\s*\+\s*1\);/,
    );
  });
});
