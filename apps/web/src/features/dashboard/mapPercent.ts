/** Pure map percent helpers (issue #807) — safe for Node/unit tests. */

/** Round and clamp a map coordinate percent to the integer 0–100 range. */
export function clampPercentInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
