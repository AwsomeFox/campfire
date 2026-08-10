# Decision record: does retokening `--space-*` remap the density ramp, or accept the growth? (issue #2168)

**Status:** recommendation — the core factual question is settled by measurement below;
the residual choice is a product-feel call, escalated to the coordinator rather than
decided unilaterally (see "Escalation" at the end). **Date:** 2026-08-10.
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

## Recommendation

**The factual part is settled**: option 1 ("accept the growth") is not what its own
description promises. It is uniform and low-risk for card/dialog padding, but for control
(button) padding — the app's highest-traffic primitive — it is an uneven, partial change
that measurably compresses the `compact`/`default` density distinction, as a side effect
of which specific declarations happen to reference `--space-*` today rather than a
deliberate choice about how dense `compact` controls should feel relative to `default`
after retokening.

Given that, whichever option is picked must be picked **with this specific effect in
view**, not by defaulting into option 1 on the strength of its (correct, but only
partial) claim to uniformity. My recommendation, with the caveat in "Escalation" below:

**Prefer option 2 (remap) for the control-padding declarations specifically —
`--cf-density-{xs,compact}-control-padding-{y,x}` and the two `calc()` expressions that
derive from them.** These are a small, already-fully-cataloged set (4 declarations —
`index.css:486,487` for padding-y, `:490,491` for the padding-x `calc()` pair, all in one
`:root` block), so the "more engineering" cost the issue
warns option 2 carries is modest and well-scoped here specifically — not the sprawling,
whole-file remap a naive reading of "remap the density ramp" might suggest. Repointing
just these four at literal px values equal to today's rendered numbers (7.84px, 10.08px,
2.8px, 5.6px) delivers exactly zero visible change for controls at zero risk to the WCAG
floor (unaffected either way) and zero risk to card/dialog padding (already safe under
option 1, so leave those `--space-*`-derived and let them grow — no reason to also remap
what is already proven uniform).

This is a hybrid of the issue's two named options, applied per-primitive rather than
ramp-wide, because the evidence above shows the ramp's own primitives do not currently
behave uniformly under retokening — treating "the density ramp" as one lever when it is
measurably two (a fully `--space-*`-derived card/dialog half, and a half-`--space-*`,
half-literal control half) is itself informative and worth recording even if a different
final call is made.

## Strongest argument against this recommendation

Remapping even four declarations means the app's spacing story is no longer "everything
traces to `--space-*`" — it becomes "everything traces to `--space-*`, except these four,
which are deliberately pinned to pre-retokening values for density-ramp reasons." That is
a permanent, documented exception, not a one-time migration cost — every future reader of
the density ramp has to know this carve-out exists. The simplicity #1688 valued in
choosing "retoken, don't bridge" in the first place (a single scale, one clean lever) is
partially undone by carving an exception back out of it immediately after. If the product
genuinely wants `compact` controls to grow closer to `default`'s density as part of this
migration — a legitimate design decision, not obviously wrong — accepting the growth
everywhere, including controls, is simpler and arguably more honest about what's
happening than remapping four values to simulate that nothing changed.

## Escalation

The desync finding above is a fact, verified by measurement, and should be treated as
settled: whoever executes #2169 must not let the control-padding growth happen as an
unexamined side effect. But the actual choice this leaves — remap those four control
values to hold `compact` exactly where it is today (this doc's recommendation), or accept
that `compact` buttons will render measurably closer to `default`'s density post-retoken
as a deliberate, named product decision (a valid "third option" in the issue's own terms,
just applied narrowly rather than ramp-wide) — is a product-feel call about how dense
`compact` controls should look, not something the measurements above can resolve further.
Per the coordinator's own instruction not to manufacture false certainty on a taste
question: **this specific sub-choice is escalated to the coordinator for sign-off**,
citing the two options and the compact/default ratio numbers above (58.3%→83.3% under
accept, 58.3%→58.3% under remap) as the concrete thing being decided between.

Card/dialog padding needs no such escalation — the evidence above shows accepting the
growth there is safe, uniform, and matches the issue's own description of option 1
exactly.

## Follow-ups this decision does not resolve

Named here for the coordinator to file or fold into #2169 as wanted — not filed
automatically, since this issue's scope was the decision itself:

- Re-verify card padding at 320px against a real dashboard card before #2169 merges (the
  one empirical check this investigation could not complete — see above).
- Re-verify the VTT cockpit header's documented "max 2 visible rows, not a scroller"
  contract at narrow widths against #2169's actual diff, not just this decision's
  measured +7.1% height delta on today's code.
- The coordinator's sign-off on the compact/default control-padding sub-choice above,
  before #2169 is implemented.
