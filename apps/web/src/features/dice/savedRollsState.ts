/**
 * Saved-roll preset model (issue #690).
 *
 * The persona-audit finding: saved-roll management used a native `prompt()`,
 * silently overwrote duplicate names, silently evicted the oldest preset on the
 * 13th save, deleted presets immediately, and — when `localStorage.setItem`
 * threw (private mode / quota) — left a memory-only preset presented as saved.
 * Carefully configured rolls could vanish after reload with no explanation.
 *
 * This module is the pure, DOM-free half of the fix (mirrors the
 * `undoSnackbarState.ts` / `imageUploadState.ts` pattern): it owns the
 * preset-limit cap, the duplicate-resolution decision tree, and the
 * memory-only-vs-persisted flagging. The component owns the side-effectful
 * bits — the dialog markup, the real `localStorage` read/write, the Undo bar.
 *
 * Why pure: every acceptance scenario (duplicate-confirm, 12-limit disclosure,
 * storage-disabled memory-only state, deletion) can be pinned exhaustively in
 * a `.unit.spec.ts` without spinning up a browser or a server.
 */

/** Maximum number of user presets kept per campaign (issue #690). */
export const MAX_PRESETS = 12;

export type AdvMode = 'flat' | 'adv' | 'dis';

/** sides -> count, e.g. { 6: 2, 8: 1 } === "2d6 + 1d8". */
export type Pool = Record<number, number>;

export interface SavedPreset {
  label: string;
  pool: Pool;
  modifier: number;
  advMode: AdvMode;
  /**
   * Whether the preset was written to `localStorage`. `false` when the last
   * persist attempt threw (private mode / quota) — the preset is then
   * in-memory only and will NOT survive a reload. Surfaced to the user so a
   * "saved" roll is never indistinguishable from one that will vanish on
   * refresh, the same way `imageUploadState.ts` distinguishes an uncommitted
   * local preview from a stored attachment (issue #583).
   */
  persisted: boolean;
}

/**
 * Result of validating a candidate save against the current preset list. The
 * component renders the matching dialog/snackbar from this decision; the model
 * never opens UI.
 *
 * - `ok`          no conflict, no limit pressure — proceed to persist.
 * - `duplicate`   a preset with the same (case-insensitive) name exists — the
 *                 caller MUST confirm before replacing. Carries the index so
 *                 the UI can name the preset being replaced.
 * - `at-limit`    the list is already at `MAX_PRESETS` and the name is new —
 *                 the caller MUST disclose the limit and either block (the
 *                 user deletes one first) or get explicit consent to evict the
 *                 oldest before persisting.
 */
export type SaveDecision =
  | { kind: 'ok' }
  | { kind: 'duplicate'; existingIndex: number; existingLabel: string }
  | { kind: 'at-limit' };

/**
 * Classify a candidate save. Pure: given the current preset list and a trimmed
 * candidate label, decide whether the save can proceed, must confirm a
 * duplicate, or must disclose the 12-preset limit.
 *
 * Duplicate matching is case-insensitive and trims whitespace, matching the
 * historical `filter((p) => p.label !== label)` dedupe but WITHOUT the silent
 * overwrite — the caller confirms first.
 */
export function classifySave(
  presets: readonly SavedPreset[],
  candidateLabel: string,
): SaveDecision {
  const idx = presets.findIndex((p) => p.label.toLowerCase() === candidateLabel.toLowerCase());
  if (idx >= 0) {
    return { kind: 'duplicate', existingIndex: idx, existingLabel: presets[idx].label };
  }
  if (presets.length >= MAX_PRESETS) return { kind: 'at-limit' };
  return { kind: 'ok' };
}

/** True when `label` resolves to an existing preset (case-insensitive). */
export function isDuplicate(presets: readonly SavedPreset[], label: string): boolean {
  return presets.some((p) => p.label.toLowerCase() === label.toLowerCase());
}

/**
 * Insert (or replace) a preset, enforcing the cap. Pure: returns the next list
 * without mutating the input.
 *
 * - When replacing a duplicate, the new preset takes the replaced slot's
 *   position (stable order) instead of being appended.
 * - When at the limit with an explicit `evictOldest: true` consent, the oldest
 *   entry is dropped to make room. WITHOUT that consent the cap is enforced —
 *   this function never silently evicts (the regression at the heart of #690).
 *   The caller asks first via the `at-limit` decision.
 */
export function applySave(
  presets: readonly SavedPreset[],
  preset: SavedPreset,
  options: { evictOldest?: boolean } = {},
): SavedPreset[] {
  const { evictOldest = false } = options;
  const idx = presets.findIndex((p) => p.label.toLowerCase() === preset.label.toLowerCase());
  // Replace in-place: stable position, no extra slot consumed.
  if (idx >= 0) {
    const next = presets.slice();
    next[idx] = preset;
    return next;
  }
  // New name. Honour the cap unless the caller explicitly consented to evict.
  if (presets.length >= MAX_PRESETS) {
    if (!evictOldest) return presets.slice();
    // Drop the oldest (index 0) to make room — the historical `slice(-12)`
    // behaviour, but only after explicit user consent.
    return [...presets.slice(1), preset];
  }
  return [...presets, preset];
}

/**
 * Remove a preset by label. Pure: returns the next list. Deletion is NOT
 * permanent from the model's perspective — the component stages the removed
 * preset in an Undo window before committing; this helper just computes the
 * post-removal list so the undo path can restore the original snapshot.
 */
export function removePreset(presets: readonly SavedPreset[], label: string): SavedPreset[] {
  return presets.filter((p) => p.label.toLowerCase() !== label.toLowerCase());
}

/**
 * Mark every preset in a list as memory-only (`persisted: false`). Used when a
 * storage write fails so the UI can distinguish "saved" from "in-memory until
 * reload" — the preset stays usable for the session but is badged as unsaved
 * rather than presented as persisted.
 */
export function markMemoryOnly(presets: readonly SavedPreset[]): SavedPreset[] {
  return presets.map((p) => ({ ...p, persisted: false }));
}

/**
 * Normalize raw parsed JSON from `localStorage` into a clean preset list.
 * Defensively drops malformed entries and defaults `persisted: true` (a preset
 * that was read back from disk was, by definition, persisted). DOM-free so the
 * parse path is testable without a browser.
 */
export function normalizePresets(raw: unknown): SavedPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedPreset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!label) continue;
    const pool = isPool(e.pool) ? { ...e.pool } : {};
    const modifier = typeof e.modifier === 'number' && Number.isFinite(e.modifier) ? e.modifier : 0;
    const advMode: AdvMode = e.advMode === 'adv' || e.advMode === 'dis' ? e.advMode : 'flat';
    // Legacy presets persisted before issue #690 had no `persisted` flag; they
    // were read from disk, so they are persisted by definition.
    const persisted = e.persisted !== false;
    out.push({ label, pool, modifier, advMode, persisted });
  }
  return out;
}

function isPool(value: unknown): value is Pool {
  if (!value || typeof value !== 'object') return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) return false;
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}
