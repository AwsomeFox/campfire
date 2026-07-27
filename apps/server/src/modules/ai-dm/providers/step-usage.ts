import type { AiGenerateResult } from './ai-provider';

/**
 * Resolve billable tokens for a provider step (#560, #598).
 *
 * Three states, deliberately distinguished: a figure the provider REPORTED, an ESTIMATE from
 * output length, or UNKNOWN. The third exists because absence of a measurement is not a
 * measurement of zero — those are different claims and only one of them is honest. A caller
 * that metered the unknown case as zero would REFUND the reservation for a call the provider
 * still bills, so the budget gate would never advance no matter how many turns it took.
 *
 * Lives here, next to the provider result types it reads, rather than in a service: both the
 * AI Driver's turn loop and the Co-DM draft path settle reservations off it, and importing it
 * from either service into the other would close an import cycle (`ai-driver.service` already
 * imports `ai-dm.service`). Pure, so it stays free to import from anywhere.
 */
export function resolveProviderStepUsage(
  text: string,
  result: AiGenerateResult | undefined,
  /**
   * #598 — output the provider produced that this adapter deliberately did NOT return as
   * text, in characters. Today that is refusal prose, which is discarded so it can never be
   * broadcast; the length still has to reach the estimator or a refusal-only turn measures as
   * nothing. A number, never the text.
   */
  extraGeneratedChars = 0,
): { tokens: number; unknown: boolean } {
  const reported = result?.usage?.totalTokens ?? 0;
  if (reported > 0) return { tokens: reported, unknown: false };
  const outputText = text || result?.text || '';
  const toolCalls = result?.toolCalls ?? [];
  const generatedChars = outputText.length + Math.max(0, extraGeneratedChars);
  if (generatedChars > 0 || toolCalls.length > 0) {
    const outputChars = generatedChars + JSON.stringify(toolCalls).length;
    return { tokens: Math.max(1, Math.ceil(outputChars / 4)), unknown: false };
  }
  // NOTHING TO MEASURE. Not zero — unknown. The caller settles the reservation as unknown
  // spend rather than metering zero, which would refund a billable provider call.
  return { tokens: 0, unknown: true };
}
