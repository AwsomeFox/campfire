/**
 * Pure helpers for the AI-DM readiness model (issue #519).
 *
 * Kept out of {@link ./AiSetupChecklist.tsx} so the two rules that decide what a DM is told
 * about their AI can be exercised directly (e2e/tests/ai-setup-checklist.unit.spec.ts)
 * rather than only through a rendered page.
 */
import type { AiDmReadiness } from '@campfire/schema';

/** The slice of readiness the "all set" rule reads. */
type SetupState = Pick<AiDmReadiness, 'ok' | 'driverOk' | 'mode'>;

/**
 * Is the AI DM actually ready to do something for this table?
 *
 * The mode is part of the answer, not a detail: a campaign can have the server flag,
 * a provider, a model and a budget and still have the seat switched OFF, in which case
 * the AI does nothing. Reporting "ready" there — and then telling the DM the AI is
 * co-DMing — is a lie the previous formula (`driverOk || (ok && mode === 'co_dm')`) told
 * whenever `driverOk` was computed from configuration alone.
 *
 * So each mode must own its own readiness:
 *   - `driver` — every driver-required check passes AND the seat is armed in driver mode
 *     (`driverOk` mirrors `AiDmService.assertRunnable`).
 *   - `co_dm`  — every blocking check passes (`ok`), which now includes the mode check.
 *   - `off`    — never ready; the mode step is the remaining work.
 */
export function isAiDmSetupComplete(readiness: SetupState): boolean {
  if (readiness.mode === 'driver') return readiness.driverOk;
  if (readiness.mode === 'co_dm') return readiness.ok;
  return false;
}

/**
 * Render a check's server-supplied interpolation values for display. Numbers arrive raw so
 * the *client* groups them for the active locale (the server would otherwise bake in its
 * own); strings (model ids, provider names) pass through untouched.
 */
export function localizeDetailParams(
  params: Record<string, string | number> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] = typeof value === 'number' ? value.toLocaleString() : value;
  }
  return out;
}
