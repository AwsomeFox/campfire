/**
 * Server-wide AI model pricing (issue #1065).
 *
 * A token budget is not a spending limit. This service is the one place that can turn tokens
 * into money, and it is built so that the answer "we cannot tell you" is the default rather
 * than a case someone remembered to handle — see {@link AiCostBasis}, whose `unknown` variant
 * is the only state reachable without an actual matched price.
 *
 * ── Storage ──────────────────────────────────────────────────────────────────────────────
 * One JSON blob under a single settings key. Pricing is a SERVER fact keyed by
 * `(providerType, model, baseUrl)`, not a campaign fact: a model costs the same whoever calls
 * it, so per-campaign rows would mean every DM looking up the same numbers, drifting apart on
 * one server, and an N-row edit whenever a vendor changes a price.
 *
 * It does NOT live on `ai_provider_configs` even though that table already has the
 * server/campaign inheritance this would otherwise want, because its server row holds exactly
 * one `providerType` while a campaign may override the provider entirely — a campaign on
 * Anthropic under an OpenAI server default would have nowhere to look. Pricing is orthogonal
 * to which provider any given scope selected, so it belongs in the generic settings k/v
 * alongside the other admin-managed blobs. That also means this feature adds no migration.
 *
 * ── Not on the hot path ──────────────────────────────────────────────────────────────────
 * `SettingsService.getJson` is an uncached SELECT per call, so this is read ONLY when
 * rendering a budget/readiness surface — never from `meterTurn`, `reserveTokenBudget`, or the
 * turn loop. Estimates are `tokens × price`, and both sides are known at render time.
 * Callers that price many campaigns at once (the AI console overview) must call
 * {@link loadTable} once and pass the table to {@link resolveBasisFrom}, rather than calling
 * {@link resolveBasis} per campaign and turning one query into N.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  AiPricingTable,
  AI_COST_BASIS_UNKNOWN,
  type AiCostBasis,
  type AiModelPrice,
} from '@campfire/schema';
import { SettingsService } from '../settings/settings.service';

/** The settings key holding {@link AiPricingTable}. Admin-written only. */
export const AI_PRICING_SETTINGS_KEY = 'aiModelPricing';

/** What identifies a priceable target. `baseUrl` '' means the provider's own endpoint. */
export interface PricingTarget {
  providerType: string | null | undefined;
  model: string | null | undefined;
  baseUrl?: string | null | undefined;
}

const EMPTY_TABLE: AiPricingTable = { version: 1, entries: [], updatedAt: null, updatedBy: '' };

@Injectable()
export class AiPricingService {
  private readonly logger = new Logger(AiPricingService.name);

  constructor(private readonly settings: SettingsService) {}

  /**
   * The stored table, or an empty one. Never throws: a malformed blob degrades to "no pricing
   * configured", which shows the disclosure — the safe direction. Throwing here would take
   * down the readiness endpoint over a cosmetic field.
   */
  async loadTable(): Promise<AiPricingTable> {
    const raw = await this.settings.getJson<unknown>(AI_PRICING_SETTINGS_KEY);
    if (raw === null) return EMPTY_TABLE;
    const parsed = AiPricingTable.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        `Stored AI pricing table is malformed; treating this server as having no pricing configured. ${parsed.error.message}`,
      );
      return EMPTY_TABLE;
    }
    return parsed.data;
  }

  /** Replace the table wholesale. Admin-only at the controller. */
  async saveTable(entries: AiModelPrice[], updatedBy: string): Promise<AiPricingTable> {
    const next: AiPricingTable = {
      version: 1,
      entries,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    await this.settings.setJson(AI_PRICING_SETTINGS_KEY, next);
    return next;
  }

  /** Convenience for single-campaign callers. Prefer {@link resolveBasisFrom} in loops. */
  async resolveBasis(target: PricingTarget): Promise<AiCostBasis> {
    return resolveBasisFrom(await this.loadTable(), target);
  }
}

/**
 * Resolve a target to a cost basis against an already-loaded table.
 *
 * The matching rules, in the order they matter:
 *
 *   1. NO PROVIDER OR MODEL → `no_provider`. Nothing to price yet; this is the state during
 *      first-run setup, and it must not read as "your provider is free".
 *
 *   2. A CUSTOM `baseUrl` REQUIRES A PRICE ENTERED FOR THAT ENDPOINT. This is the rule that
 *      earns its keep. A model NAME behind a proxy, gateway, or self-hosted endpoint does not
 *      imply the vendor's pricing — and someone who has pointed Campfire at a custom endpoint
 *      is MORE likely to be on a negotiated or self-hosted rate, not less. Falling back to
 *      the vendor's public price for "gpt-4o" served by an arbitrary host would be the
 *      confident-wrong-number failure in its purest form, so a custom endpoint never inherits
 *      the default-endpoint price. It falls to `custom_endpoint_not_priced`, which tells the
 *      admin exactly what to enter.
 *
 *   3. EXACT `(providerType, model)` MATCH on the default endpoint, case-insensitively on the
 *      model id. No prefix or fuzzy matching: "gpt-4o" and "gpt-4o-mini" differ by ~16x, so a
 *      near-miss is not a small error. A model nobody priced falls to `model_not_priced`.
 *
 * Every path that is not a match returns `unknown` with a reason, and the reason is what the
 * UI turns into a sentence. There is no path that returns a number without a matched entry.
 */
export function resolveBasisFrom(table: AiPricingTable, target: PricingTarget): AiCostBasis {
  const providerType = (target.providerType ?? '').trim();
  const model = (target.model ?? '').trim();
  if (!providerType || !model) return { kind: 'unknown', reason: 'no_provider' };

  if (table.entries.length === 0) return AI_COST_BASIS_UNKNOWN;

  const baseUrl = (target.baseUrl ?? '').trim();
  const match = table.entries.find(
    (e) =>
      e.providerType.trim().toLowerCase() === providerType.toLowerCase() &&
      e.model.trim().toLowerCase() === model.toLowerCase() &&
      (e.baseUrl ?? '').trim().toLowerCase() === baseUrl.toLowerCase(),
  );
  if (!match) {
    // Distinguish "you are on a custom endpoint and have not priced it" from "this model is
    // not in your table", because the fix is different and the first is easy to overlook.
    return {
      kind: 'unknown',
      reason: baseUrl ? 'custom_endpoint_not_priced' : 'model_not_priced',
    };
  }

  return {
    kind: 'priced',
    inputUsdPerMTok: match.inputUsdPerMTok,
    outputUsdPerMTok: match.outputUsdPerMTok,
    source: match.source,
    asOf: match.asOf,
    providerType: match.providerType,
    model: match.model,
  };
}
