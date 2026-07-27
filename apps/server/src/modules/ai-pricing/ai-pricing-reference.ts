/**
 * Campfire's REFERENCE price list (issue #1065).
 *
 * ── What this is, and just as importantly what it is not ─────────────────────────────────
 * This is a DATA-ENTRY AID, not a source of estimates. Nothing in the product reads this
 * table to compute a dollar figure. It exists so an admin opening the pricing screen can
 * press "prefill" instead of typing twelve numbers by hand — and the numbers only become
 * live pricing once that admin has looked at them and saved them.
 *
 * That indirection is the whole design, and it is worth stating why, because the obvious
 * alternative (resolve estimates against a shipped table automatically) is what this
 * deliberately avoids:
 *
 *   1. A shipped table goes stale the moment a vendor changes a price, and it goes stale
 *      SILENTLY — the build does not know, the operator does not know, and the DM sees a
 *      confident figure with no indication it is a year old. Campfire ships on its own
 *      cadence and vendors do not consult it.
 *   2. Automatic resolution would mean two kinds of live pricing — "estimated from a table
 *      we shipped" and "computed from pricing you configured" — which the UI would then have
 *      to explain the difference between, every time, forever. Making the table a prefill
 *      source collapses that to ONE kind: configured. There is no second provenance to
 *      disambiguate because there is no second provenance.
 *   3. Pressing prefill is a deliberate act by the person best placed to judge, at the exact
 *      moment they are looking at the actual numbers. That is a far better consent signal
 *      than a per-campaign opt-in toggle buried in a settings page, and it needs no storage.
 *
 * A saved entry records `source: 'reference'` and the {@link PRICING_REFERENCE_AS_OF} date it
 * came from, so the pricing screen can later say "these came from the reference list as of
 * X — prices change, re-check with your provider" rather than pretending the admin typed them.
 *
 * ── Maintaining this ─────────────────────────────────────────────────────────────────────
 * Update {@link PRICING_REFERENCE_AS_OF} whenever any figure below changes. Do NOT update the
 * figures without moving the date: the date is the only honesty signal this file has, and a
 * stale date on fresh numbers is a lie in the direction that matters least, while a fresh
 * date on stale numbers is a lie in the direction that matters most.
 *
 * Figures are USD per MILLION tokens, standard (non-batch, non-cached) rates, for the
 * provider's OWN endpoint only. Deliberately a short list of widely-used models rather than an
 * exhaustive catalogue — an incomplete list falls back to the disclosure, which is correct,
 * whereas a long list is a larger stale surface for no gain.
 */

/**
 * The date the figures below were last verified against vendor pricing pages.
 *
 * Surfaced in the admin UI at the moment of prefill and stored on every entry it creates.
 */
export const PRICING_REFERENCE_AS_OF = '2026-07-27';

/** One reference entry. Mirrors the stored `AiModelPrice` minus the bookkeeping fields. */
export interface ReferencePrice {
  providerType: string;
  model: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/**
 * The list itself. Applies ONLY to each provider's own endpoint — a custom `baseUrl` is
 * excluded by construction, because a model name behind a proxy or gateway says nothing about
 * what that proxy charges (see the `baseUrl` key component on `AiModelPrice`).
 */
export const PRICING_REFERENCE: readonly ReferencePrice[] = [
  // OpenAI
  { providerType: 'openai', model: 'gpt-4o', inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 },
  { providerType: 'openai', model: 'gpt-4o-mini', inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  { providerType: 'openai', model: 'gpt-4.1', inputUsdPerMTok: 2, outputUsdPerMTok: 8 },
  { providerType: 'openai', model: 'gpt-4.1-mini', inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.6 },
  { providerType: 'openai', model: 'o4-mini', inputUsdPerMTok: 1.1, outputUsdPerMTok: 4.4 },

  // Anthropic
  { providerType: 'anthropic', model: 'claude-sonnet-4-5', inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  { providerType: 'anthropic', model: 'claude-haiku-4-5', inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  { providerType: 'anthropic', model: 'claude-opus-4-1', inputUsdPerMTok: 15, outputUsdPerMTok: 75 },

  // Google
  { providerType: 'gemini', model: 'gemini-2.5-pro', inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
  { providerType: 'gemini', model: 'gemini-2.5-flash', inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
];

/**
 * Reference entries for a provider type, or [] when Campfire ships no figures for it.
 *
 * An empty result is a normal, expected answer — a self-hosted or unknown provider has no
 * public price list to reference — and the caller shows "no reference figures for this
 * provider; enter them from your provider's billing page" rather than an error.
 */
export function referencePricesFor(providerType: string): readonly ReferencePrice[] {
  return PRICING_REFERENCE.filter((p) => p.providerType === providerType);
}
