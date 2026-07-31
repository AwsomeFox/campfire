/**
 * Presentation helpers for the AI-DM readiness model (issue #519).
 *
 * The readiness RULES themselves (`aiDmSetupComplete`, `aiDmReadinessProgress`,
 * `aiDmReadinessCheckBlocks`) live beside the `AiDmReadiness` schema in `@campfire/schema`,
 * so the client cannot re-derive "ready" differently from the server that computed it — and
 * so the invariant tying the ready banner to the progress tally is covered by a suite CI
 * actually runs. Only what is genuinely about RENDERING lives here.
 */

/**
 * Render a check's server-supplied interpolation values for display. Numbers arrive raw so
 * the *client* groups them for the active locale (the server would otherwise bake in its
 * own); strings (model ids, provider names) pass through untouched.
 */
import { formatNumber } from '../../lib/format';

export function localizeDetailParams(
  params: Record<string, string | number> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] = typeof value === 'number' ? formatNumber(value) : value;
  }
  return out;
}
