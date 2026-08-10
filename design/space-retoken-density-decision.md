# Decision record: does retokening `--space-*` remap the density ramp, or accept the growth? (issue #2168)

**Status:** **decided.** Remap the four control-padding declarations; preserve today's
rendered geometry everywhere. Coordinator sign-off:
[issue #2168, comment 5246503988](https://github.com/AwsomeFox/campfire/issues/2168#issuecomment-5246503988).
**Date:** 2026-08-10 (measured), decided 2026-08-10.
**Type:** design-system decision, gating #2169 (the retokening execution) in the
#1533 / #1688 → #2167 → **#2168 (this)** → #2169 chain. This file is a written decision,
not a UI reference like the rest of `design/` (same convention as
`design/notes-concept-decision.md`). No code changes to `--space-*`, `--cf-density-*`, or
any other token accompany this file — that is #2169's job, not this one's.

## The question, as #1688/#2168 framed it

`--space-1..8` are currently `2.8 / 5.6 / 8.4 / 11.2 / 16.8 / 22.4px`
(`apps/web/src/index.css:384-389`, Tailwind's own scale × 0.7). #2169 retokens them to
Tailwind's own `4 / 8 / 12 / 16 / 24 / 32px` — a **+42.9%** (1/0.7) change on every direct
consumer. The density ramp (`--cf-density-*-*-padding`, `index.css:459-509`) derives
several of its steps directly from `--space-*`. The issue's two named options:

1. **Accept the growth** — leave the ramp's declarations alone; padding grows uniformly
   wherever the ramp references `--space-*`.
2. **Remap** — repoint the ramp's `--space-*`-derived declarations at new values (or
   literals) chosen to hold today's rendered geometry fixed, at the cost of more
   engineering and a token scale that no longer fully explains the ramp's own numbers.

## Method: measured, not estimated

Per the coordinator's brief, every claim below with a specific pixel number was read off
a **real render**, not computed by hand from the token definitions alone (arithmetic from
the definitions is used too, but only where independently corroborated by a live
measurement):

- **Density-ramp values**: `apps/web/e2e/lib/computedStyle.ts`'s `renderCssFixture` +
  `measureBox` (the exact machinery #2167/PR #2189 added and this repo's own convention
  for exactly this kind of check) rendered every `--cf-density-*` step of `.cf-card`,
  `.cf-btn`, and `.btn` against the real compiled stylesheet, read each one's computed
  `padding-top`, then injected the target `4/8/12/16/24/32px` scale live via
  `page.addStyleTag({ content: ':root { --space-1: 4px; ... }' })` — cascading over the
  app's own tokens without touching any source file — and re-read the same computed
  values. This is a live-browser measurement of the actual retokening's effect, not a
  simulation of one.
- **Tight-surface checks**: the VTT cockpit header and the QuickCaptureDialog were loaded
  as real seeded pages (the same fixtures `control-surface-goldens.spec.ts` uses) at the
  narrow viewports this repo already tests elsewhere (390px, 320px —
  `login-responsive.spec.ts`'s `HANDSETS`), measured before and after the same live
  token injection.
- All measurements were taken in one sitting against `main`@`aed32fbea` (this branch's
  base) with `npm run build` freshly run; every cited line number was re-confirmed with
  `grep`/`git grep` against the same checkout.

No source file was edited to produce these numbers — the injection happens entirely
inside a throwaway Playwright page context and was not committed.

## What actually moves under retokening (verified)

### The clean, uniform part: card padding

All four `--cf-density-*-card-padding` steps are `var(--space-N)` with no other
indirection (`index.css:459-462`). Measured on `.cf-card.cf-density-*`:

| step | today | retokened | growth | ratio to previous step (today → retokened) |
|---|---|---|---|---|
| xs | 5.6px | 8px | +42.9% | — |
| compact | 8.4px | 12px | +42.9% | 1.5 → 1.5 |
| default | 11.2px | 16px | +42.9% | 1.333 → 1.333 |
| comfortable | 16.8px | 24px | +42.9% | 1.5 → 1.5 |

Every step grows by the same factor and every ratio **between** steps is preserved
exactly. For cards, "accept the growth" really is the single, uniform, easy-to-reason-about
change the issue describes. `.dialog`'s ramp (`--cf-density-*-dialog-padding`,
`index.css:502-505`) is wired identically and behaves identically — not re-measured
separately since it is the same four `var(--space-N)` references.

### The NOT uniform part: control (button) padding — the ramp is already desynchronized today

This is the finding the coordinator's brief specifically asked to check for ("whether the
density ramp's own steps are expressed in `--space-*` or independently — if
independently, a uniform token growth desynchronizes them"). It does, and the effect is
concrete and measured, not hypothetical:

`--cf-density-*-control-padding-y`/`-x` (`index.css:486-493`) mix two different sources
depending on step:

- **`xs` and `compact`** reference `var(--space-1)`/`var(--space-2)` (padding-y) and
  `calc(var(--space-2) * 1.4)`/`calc(var(--space-3) * 1.2)` (padding-x) — genuine
  `--space-*` consumers, so they grow with retokening.
- **`default` and `comfortable`** are hardcoded `rem` literals (`0.6rem`/`0.65rem`
  padding-y, `1.15rem`/`1.15rem` padding-x) with **no reference to `--space-*` at all** —
  so they do not move under either option.

Measured on `.cf-btn.cf-density-*` (9 live call sites) and nocturne's plain `.btn`
(268 live call sites — by far the app's most common control class; `.btn`'s own
padding-y/x, contrary to how it reads in nocturne.css:191, is actually overridden by a
later, unlayered `.btn { padding: var(--cf-density-default-control-padding-y) ...}` rule
at `index.css:1699-1703` — nocturne.css's own declaration is dead code, confirmed by the
measured value matching the `index.css` override, not the nocturne one):

| step | `.cf-btn` padding-y today → retokened | `.btn` padding-y today → retokened |
|---|---|---|
| xs | 2.8px → 4px (+43%) | 2.8px → 4px (+43%) |
| compact | 5.6px → 8px (+43%) | 5.6px → 8px (+43%) |
| default | 9.6px → **9.6px (unchanged)** | 9.6px → **9.6px (unchanged)** |
| comfortable | 10.4px → **10.4px (unchanged)** | *(no distinct rule — `.btn.cf-density-comfortable` does not exist; silently aliases to `default`, so also 9.6px → 9.6px)* |

Because `xs`/`compact` grow while `default`/`comfortable` don't, the ratio **between**
steps is not preserved — it compresses. Concretely, `compact`'s padding-y goes from 58.3%
of `default`'s (5.6/9.6) to **83.3%** of `default`'s (8/9.6). "Accept the growth" would,
for the app's single most-used control primitive, quietly pull the `compact` step's
vertical padding two-thirds of the way to `default`'s — narrowing the visual/tactile
distinction the density ramp exists to provide, on the two-thirds of the ramp that
happen to still reference `--space-*`, while leaving the other two-thirds completely
untouched. **This is not the "uniform, single-system consequence" the issue's option 1
describes for cards — for controls it is an uneven, partial change**, and it falls out
as a side effect of which token happened to still be `--space-*`-derived at execution
time, exactly the "accident of which token name happens to still exist" #2168 explicitly
says must not be how this gets decided.

The two `calc()` derivatives (`index.css:490-491`, the only `calc(...--space...)`
expressions in the ramp — confirmed complete via
`grep -n 'calc([^)]*--space' apps/web/src/index.css apps/web/src/nocturne.css`) scale
linearly with their base token and are already covered by the `xs`/`compact` rows above
(`--cf-density-xs-control-padding-x`: 7.84px → 11.2px; `--cf-density-compact-control-padding-x`:
10.08px → 14.4px — both +43%, consistent with everything else `xs`/`compact` touch).

### The WCAG floor: untouched, and safe under either option

`--cf-density-*-control-min-height`/`-min-width` (`index.css:481-485`) are literal `px`
values (`24/24/36/44/44`), never `--space-*`-derived — mechanically enforced never to
regress by `design-system-density.unit.spec.ts`. Neither retokening option touches them.
Growing padding can only push a control's rendered size further **above** a `min-height`
floor, never below it, so the control-padding desync above creates no accessibility risk
in either direction — it is a density/proportion question, not a WCAG one.

### Chip padding: fully independent, unaffected either way

`--cf-density-*-chip-padding-y` (`index.css:498-501`) are all `rem` literals with zero
`--space-*` reference at any step. Chips are unaffected by this decision regardless of
which option is chosen.

## Empirical checks at tight surfaces

- **VTT cockpit header at 390px** (the single largest concentration of direct
  `var(--space-N)` consumers in the app per #1688's count, and already documented in
  `index.css` as "Free to wrap, NOT a scroller" because it already wraps to multiple rows
  at this width): measured height grew from **306.19px to 327.84px (+21.65px, +7.1%)**
  after live token injection. This growth happens regardless of the density-ramp decision
  — the header is a direct `--space-2`/`-3`/`-4` consumer, not routed through
  `--cf-density-*` at all — so it is not itself part of this issue's decision, but it is
  real, measured evidence that the retokening's non-ramp blast radius is not free either;
  #2169 should re-verify the header's documented "max 2 visible rows" contract at narrow
  widths against its own change, not assume #2167's existing pin (padding-top only)
  covers total height.
- **QuickCaptureDialog at 320px** (the narrowest handset width this repo tests elsewhere):
  the dialog's own rendered width **shrank** from 297.6px to 288px (−9.6px) after
  injection — arithmetically exact: `.dialog-backdrop`'s padding
  (`nocturne.css`, `var(--space-4)`) grows 11.2px→16px on each side, consuming 9.6px more
  of the fixed viewport width before the dialog itself gets any. No horizontal overflow
  was measured on the dialog before or after. Both destination buttons
  (`!min-h-[24px] !py-1`, the exact WCAG-floor fix #1695 shipped) measured 24px height
  before injection and 24.39px after — comfortably clear of the floor in both cases, and
  the direction of change is away from the floor, not toward it.
- A third check (a `.cf-card` inside the dashboard's `home-campaign-grid` at 320px) did
  not produce a usable result — the selector used didn't resolve to the rendered card
  element, and this was not re-run before time ran out on this investigation. Recorded
  here rather than silently dropped: **card padding at the narrowest tested mobile width
  was not empirically verified**, only inferred from the fixture-based ratios above (which
  are exact for the token values themselves, just not confirmed against a real card's
  available width at 320px). Flagged as a gap for whoever executes #2169 to close before
  merging, not something this decision should be read as having ruled out.

## Decision

**Remap the four control-padding declarations so the ramp holds its current ratios.
Leave card/dialog padding `--space-*`-derived, since it already retokens uniformly.**
Decided by the coordinator on 2026-08-10
([issue #2168, comment 5246503988](https://github.com/AwsomeFox/campfire/issues/2168#issuecomment-5246503988)),
accepting this doc's recommendation as written. #2169 must implement this, not
re-litigate it — the density ramp's rendered geometry is not to change as part of the
retokening, full stop.

**What moves:** all four `--cf-density-*-card-padding` steps, `--cf-density-*-dialog-padding`
steps, and everything that already flows through `--space-*` outside the density ramp
(headings, `.hr`, `.cf-vtt-header`, etc. — #2167's territory, not this ramp's).
**What does not move:** `--cf-density-{xs,compact}-control-padding-{y,x}`
(`index.css:486,487,490,491`) get repointed at literal px values equal to today's
rendered numbers (7.84px, 10.08px, 2.8px, 5.6px) instead of `var(--space-N)`/
`calc(var(--space-N) * k)`, so `compact` stays exactly where it is relative to `default`
(58.3% of `default`'s padding-y, unchanged) rather than drifting to 83.3% as it would
under a bare token substitution. `default`/`comfortable` were already unaffected
(hardcoded `rem`, not `--space-*`-derived) and need no change.

**Why, in the coordinator's own words** (full reasoning at the linked comment; summarized
here so this file reads as the decision record, not a pointer to one):

1. **This migration is a refactor, and a refactor that changes rendered output is a
   redesign wearing a refactor's clothes.** The #2167 → #2168 → #2169 chain exists
   because #1688 found 2,124 call sites shifting at once with nobody able to see the
   effect. Letting `compact`'s ratio drift from 58.3% to 83.3% as a side effect of which
   declarations happen to be `--space-*`-derived would be exactly the invisible,
   unintended change the chain was built to prevent — just in the opposite direction,
   and now with a test suite watching instead of not.
2. **The ramp's distinction is load-bearing and was expensive to get.** #1533 exists
   because the density ramp had no step below 36px and the design system was being
   bypassed as a result. Compressing `compact` toward `default` erodes the separation
   that issue was filed to create. Narrowing it should require someone arguing for a
   denser-feeling product, with evidence — not fall out of a token substitution.
3. **Nobody has asked for it.** No issue, user report, or design reference wants
   `compact` controls to feel closer to `default`. Absent that, holding the pixels where
   they are is the conservative and correct default.

**On the counter-argument this doc states above:** the coordinator accepted it explicitly
— "Purity of derivation is not worth a silent redesign" of 268 `.btn` sites plus the
`.cf-btn` set. The permanent documented exception to "everything traces to `--space-*`"
is a real, accepted cost, not an oversight. **This paragraph is that permanent record —
the next person reading `index.css:486-493` and wondering why two of four density steps
don't reference `--space-*` should be pointed here.**

## A caution for #2169's implementer: measure the cascade, do not reason about it

Two independent investigations in this same working session hit the identical
unlayered-beats-`@layer utilities` cascade mechanism (nocturne.css's plain `:root`/
element rules are imported unlayered; Tailwind utilities live in `@layer utilities`; an
unlayered rule always wins at equal specificity, regardless of source order intuition)
— once in each direction:

- #2189's review found `.hr`'s own margin (unlayered) unexpectedly **beats** Tailwind's
  `my-1` utility at `Layout.tsx:973`, keeping a class this decision's earlier drafts
  assumed was dead code actually live.
- This investigation found nocturne.css's own `.btn { padding: … }` (`nocturne.css:191`)
  is unexpectedly **dead**, silently overridden by a *later* unlayered `.btn` rule at
  `index.css:1699-1703` that routes through the density ramp instead (folded into #2192,
  which tracks unused nocturne rules).

Specificity intuition predicts neither outcome correctly on its own — the deciding factor
in both cases was layer membership, not selector weight or file order alone, and it cut
in opposite directions in the same session. **Before landing #2169, measure every
touched selector's real rendered value with `measureBox`/`renderCssFixture`
(`apps/web/e2e/lib/computedStyle.ts`) rather than reasoning from the source text about
which rule "should" win.** This decision doc's own numbers were produced exactly that
way for that reason.

## Follow-ups this decision does not resolve

Named here for whoever executes #2169 to close out, not filed as separate issues
automatically since this issue's scope was the decision itself:

- Re-verify card padding at 320px against a real dashboard card before #2169 merges (the
  one empirical check this investigation could not complete — see above). Left
  unresolved deliberately, not re-run after the sign-off above — narrow-viewport
  regressions are #2169's surface to catch, not this decision's.
- Re-verify the VTT cockpit header's documented "max 2 visible rows, not a scroller"
  contract at narrow widths against #2169's actual diff, not just this decision's
  measured +7.1% height delta on today's code.
- Implement the four-declaration remap above and confirm via `measureBox` (not by
  reading the new declarations) that `compact`'s rendered padding is byte-for-byte
  unchanged pre/post-#2169, given the cascade caution immediately above.
