/**
 * Turning a cost basis into something a human should read (issue #1065).
 *
 * Every dollar figure in the product goes through here, for two reasons.
 *
 * ── 1. Precision we do not have must not be displayed ────────────────────────────────────
 * `estimateUsdRange` can hand back 0.19999999999999998. Rendering that, or even
 * `toFixed(2)`-ing it into "$0.20", implies a confidence the underlying number does not have:
 * it is a token estimate multiplied by a price an admin typed in, against a split nobody knows
 * in advance. {@link formatApproxUsd} rounds to a couple of significant figures and prefixes
 * "≈" so the figure reads as the order of magnitude it actually is.
 *
 * The existing per-turn line used `toFixed(4)` — five decimal places of implied accuracy on a
 * best-effort estimate. That is the shape of the problem this issue is about, just smaller.
 *
 * ── 2. "We cannot tell you" is a first-class answer ──────────────────────────────────────
 * There is no formatter here that takes a bare number. Both entry points take an
 * {@link AiCostBasis} and return `null` when it is `unknown`, so a caller cannot accidentally
 * render money for an unpriced model — the disclosure is what they get instead, and it is the
 * default rather than the fallback.
 */
import { estimateUsdRange, type AiCostBasis, type AiCostUnknownReason } from '@campfire/schema';

/**
 * Format a USD amount with DELIBERATELY limited precision.
 *
 * The bands widen as the number grows, because absolute precision matters less the larger the
 * figure: nobody budgeting $47 cares about the cents, but $0.0041 per turn genuinely needs its
 * significant digits to be readable at all. Always prefixed "≈" — there is no path here that
 * produces an exact-looking number, because there is no exact number to produce.
 */
import { formatNumber } from '../../lib/format';

export function formatApproxUsd(usd: number): string {
  const v = Math.max(0, usd);
  if (v === 0) return '≈$0.00';
  if (v >= 10) return `≈$${formatNumber(Math.round(v))}`;
  if (v >= 1) return `≈$${v.toFixed(1)}`;
  if (v >= 0.01) return `≈$${v.toFixed(2)}`;
  // Below a cent, two significant figures — `toFixed(2)` alone would render "$0.00".
  //
  // Derived as a decimal-place count rather than via `toPrecision(2)`, which switches to
  // exponential notation once the exponent drops past -7: a reachable per-turn figure like
  // 0.00000015 came out as "≈$1.5e-7". Scientific notation in a price is not a price anyone
  // can read, and keeping money legible is the entire job of this function.
  const decimals = Math.min(100, 1 - Math.floor(Math.log10(v)));
  return `≈$${v.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/**
 * A dollar RANGE for a token count, or null when the basis is unpriced.
 *
 * Returns a range rather than a point because the real cost of a token budget depends on how
 * it splits between input and output, which nobody knows in advance and which differ by
 * several times on most providers. The top of the range is the number a DM should budget
 * against, so hiding it behind an average would understate the thing they are here to learn.
 *
 * Collapses to a single figure when both ends round to the same string — "≈$0.20–≈$0.20" is
 * noise, not honesty.
 */
export function formatUsdRange(tokens: number, basis: AiCostBasis): string | null {
  return formatUsdRangeValue(estimateUsdRange(tokens, basis));
}

/**
 * The same rendering for a range the SERVER already computed (readiness `estimatedUsdRange`).
 *
 * Split out so the client-derived budget figure and the server-derived per-turn figure format
 * identically — one place decides how a money span reads, and `null` in still means the
 * disclosure out.
 */
export function formatUsdRangeValue(range: { low: number; high: number } | null): string | null {
  if (!range) return null;
  const low = formatApproxUsd(range.low);
  const high = formatApproxUsd(range.high);
  return low === high ? low : `${low}–${high.replace('≈', '')}`;
}

/**
 * i18n key for the sentence explaining why there is no figure.
 *
 * Each reason gets its OWN sentence because each has a different fix, and "we cannot estimate"
 * with no follow-up is a dead end for someone who could resolve it in thirty seconds. An
 * unrecognised reason from a newer server falls back to the generic disclosure rather than
 * blanking the line (#629's forward-compatibility rule).
 */
export function costUnknownReasonKey(reason: AiCostUnknownReason | string): string {
  const known: Record<string, string> = {
    no_pricing_configured: 'aiOnboarding.cost.unknown.noPricingConfigured',
    model_not_priced: 'aiOnboarding.cost.unknown.modelNotPriced',
    custom_endpoint_not_priced: 'aiOnboarding.cost.unknown.customEndpointNotPriced',
    no_provider: 'aiOnboarding.cost.unknown.noProvider',
    provider_unresolved: 'aiOnboarding.cost.unknown.providerUnresolved',
  };
  return known[reason] ?? 'aiOnboarding.cost.unknown.generic';
}
