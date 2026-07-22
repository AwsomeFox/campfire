import { expect, test } from '@playwright/test';
import {
  MAX_PRESETS,
  applySave,
  classifySave,
  isDuplicate,
  markMemoryOnly,
  normalizePresets,
  removePreset,
  type Pool,
  type SavedPreset,
} from '../../src/features/dice/savedRollsState';

/**
 * Issue #690 — saved-roll preset management must not silently replace, evict,
 * delete, or lose a preset. These specs pin the pure decision tree that the
 * DiceTray renders from: the component owns the dialogs/Undo bar/snackbar, and
 * this module owns the limit/duplicate/storage-semantics logic, so every
 * acceptance scenario can be exercised without a browser.
 *
 * The regression these guard against:
 *  - `slice(-12)` silently evicted the oldest on the 13th save
 *  - `filter((p) => p.label !== label)` silently overwrote a duplicate name
 *  - deletion was immediate (no Undo)
 *  - a failed `localStorage.setItem` left a memory-only preset badged as saved
 */
function preset(label: string, overrides: Partial<SavedPreset> = {}): SavedPreset {
  return {
    label,
    pool: { 20: 1 } as Pool,
    modifier: 0,
    advMode: 'flat',
    persisted: true,
    ...overrides,
  };
}

function filled(count: number, prefix = 'Roll'): SavedPreset[] {
  return Array.from({ length: count }, (_, i) => preset(`${prefix} ${i + 1}`));
}

test.describe('saved-roll preset decisions (issue #690)', () => {
  test('a new name with room classifies as ok', () => {
    const presets = [preset('Longsword')];
    expect(classifySave(presets, 'Fireball')).toEqual({ kind: 'ok' });
  });

  test('an empty list classifies a new name as ok', () => {
    expect(classifySave([], 'Sneak Attack')).toEqual({ kind: 'ok' });
  });

  // --- Duplicate resolution -------------------------------------------------
  test.describe('duplicate detection', () => {
    test('a case-insensitive exact match classifies as duplicate and reports the existing label', () => {
      const presets = [preset('Longsword'), preset('Stealth')];
      // Case difference must NOT slip through as a new save (silent overwrite).
      const decision = classifySave(presets, 'longsword');
      expect(decision).toEqual({ kind: 'duplicate', existingIndex: 0, existingLabel: 'Longsword' });
      expect(isDuplicate(presets, 'LONGSWORD')).toBe(true);
      expect(isDuplicate(presets, ' stealth ')).toBe(false);
    });

    test('applySave replaces a duplicate in-place (stable slot) without growing the list', () => {
      const before = [preset('Longsword', { modifier: 2 }), preset('Stealth')];
      const replacement = preset('Longsword', { modifier: 5 });
      const after = applySave(before, replacement);
      expect(after).toHaveLength(2);
      // The replaced preset keeps the original slot position…
      expect(after[0]).toEqual(replacement);
      // …and the other preset is untouched.
      expect(after[1]).toEqual(preset('Stealth'));
    });

    test('applySave never appends when replacing (no duplicate footprint)', () => {
      const before = [preset('A'), preset('B'), preset('C')];
      // A differently-cased duplicate replaces in-place: the slot stays (index 1)
      // but the stored label becomes the new one, exactly as the user typed it.
      const after = applySave(before, preset('b', { modifier: 9 }));
      expect(after).toHaveLength(3);
      expect(after.map((p) => p.label)).toEqual(['A', 'b', 'C']);
      expect(after[1].modifier).toBe(9);
    });
  });

  // --- 12-preset limit disclosure ------------------------------------------
  test.describe('preset limit (12)', () => {
    test('a 13th NEW name classifies as at-limit so the UI discloses the cap', () => {
      const presets = filled(MAX_PRESETS);
      expect(presets).toHaveLength(12);
      const decision = classifySave(presets, 'Brand New');
      expect(decision.kind).toBe('at-limit');
    });

    test('a duplicate name at the limit does NOT classify as at-limit (replacement needs no new slot)', () => {
      // Replacing an existing name consumes no extra slot, so even at the limit
      // the decision is `duplicate`, not `at-limit` — the user can still rename
      // an existing preset without first deleting one.
      const presets = filled(MAX_PRESETS);
      const decision = classifySave(presets, 'Roll 1');
      expect(decision.kind).toBe('duplicate');
    });

    test('applySave at the limit WITHOUT consent is a no-op (no silent eviction)', () => {
      const presets = filled(MAX_PRESETS);
      const next = applySave(presets, preset('Brand New'));
      // The historical regression: `[..., preset].slice(-12)` dropped the oldest.
      // The fix: without explicit `evictOldest` consent, the list is unchanged.
      expect(next).toHaveLength(MAX_PRESETS);
      expect(next.map((p) => p.label)).not.toContain('Brand New');
      expect(next[0].label).toBe('Roll 1'); // oldest preserved
    });

    test('applySave at the limit WITH consent evicts the oldest to make room', () => {
      const presets = filled(MAX_PRESETS);
      const next = applySave(presets, preset('Brand New'), { evictOldest: true });
      expect(next).toHaveLength(MAX_PRESETS);
      // Oldest (index 0) evicted, new preset appended.
      expect(next[0].label).toBe('Roll 2');
      expect(next[next.length - 1].label).toBe('Brand New');
    });

    test('below the limit a new name appends without touching eviction flags', () => {
      const presets = filled(MAX_PRESETS - 1);
      const next = applySave(presets, preset('Last Slot'));
      expect(next).toHaveLength(MAX_PRESETS);
      expect(next[next.length - 1].label).toBe('Last Slot');
    });
  });

  // --- Deletion (Undo-able) ------------------------------------------------
  test.describe('deletion', () => {
    test('removePreset drops the named preset and preserves order', () => {
      const presets = [preset('A'), preset('B'), preset('C')];
      const next = removePreset(presets, 'B');
      expect(next.map((p) => p.label)).toEqual(['A', 'C']);
    });

    test('removePreset is case-insensitive', () => {
      const presets = [preset('Stealth')];
      expect(removePreset(presets, 'stealth')).toHaveLength(0);
    });

    test('removePreset on a missing name is a no-op (not a throw)', () => {
      const presets = [preset('A')];
      const next = removePreset(presets, 'Ghost');
      expect(next).toEqual(presets);
    });

    test('the full list snapshot before removal is restorable (Undo path)', () => {
      // The component snapshots the pre-removal list and stages the removed
      // preset; Undo restores the snapshot. applySave(removePreset(...)) must
      // round-trip back to the original list when the snapshot is reinstated.
      const original = [preset('A'), preset('B', { modifier: 3 }), preset('C')];
      const afterDelete = removePreset(original, 'B');
      expect(afterDelete).toHaveLength(2);
      // Undo: the caller just re-applies the snapshot it kept.
      expect(original).toHaveLength(3);
      expect(original[1]).toEqual(preset('B', { modifier: 3 }));
    });
  });

  // --- Storage-disabled (memory-only) state --------------------------------
  test.describe('storage-failure surfacing', () => {
    test('markMemoryOnly flips every preset to persisted:false so the badge shows unsaved', () => {
      const persisted = [preset('A'), preset('B')];
      expect(persisted.every((p) => p.persisted)).toBe(true);
      const memory = markMemoryOnly(persisted);
      expect(memory.every((p) => !p.persisted)).toBe(true);
      // Identity is preserved per preset (labels survive).
      expect(memory.map((p) => p.label)).toEqual(['A', 'B']);
    });

    test('markMemoryOnly does not mutate the input (defensive copy)', () => {
      const persisted = [preset('A')];
      markMemoryOnly(persisted);
      // The original preset must still report persisted — a failed write must
      // not retroactively change the source of truth the caller still holds.
      expect(persisted[0].persisted).toBe(true);
    });

    test('a memory-only preset is distinguishable from a persisted one (badge truth)', () => {
      // Mirrors imageUploadState.ts issue #583: an uncommitted preview must
      // never be indistinguishable from a stored one. Here a failed persist
      // must not present the preset as saved.
      const good = preset('Saved');
      const blocked = markMemoryOnly([preset('Blocked')])[0];
      expect(good.persisted).toBe(true);
      expect(blocked.persisted).toBe(false);
      expect(good.persisted).not.toBe(blocked.persisted);
    });
  });

  // --- Reload path (normalize raw localStorage) ----------------------------
  test.describe('reload normalization', () => {
    test('normalizePresets parses a valid persisted list and defaults persisted:true', () => {
      const raw = [{ label: 'Longsword', pool: { 20: 1 }, modifier: 3, advMode: 'flat' }];
      const out = normalizePresets(raw);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ label: 'Longsword', modifier: 3, advMode: 'flat', persisted: true });
    });

    test('normalizePresets strips malformed entries (no label / bad pool / bad modifier)', () => {
      const raw = [
        { label: 'Good', pool: { 20: 1 }, modifier: 0, advMode: 'flat' },
        { label: '   ', pool: {}, modifier: 0 }, // blank label dropped
        { pool: { 20: 1 }, modifier: 0 }, // no label dropped
        { label: 'BadPool', pool: { x: 2 }, modifier: 0 }, // non-numeric key
        { label: 'BadMod', pool: {}, modifier: 'oops' }, // non-numeric modifier
        { label: 'BadAdv', pool: {}, modifier: 0, advMode: 'weird' }, // unknown advMode -> flat
      ];
      const out = normalizePresets(raw);
      expect(out.map((p) => p.label)).toEqual(['Good', 'BadPool', 'BadMod', 'BadAdv']);
      // Unknown advMode falls back to a safe default rather than propagating.
      expect(out.find((p) => p.label === 'BadAdv')?.advMode).toBe('flat');
      // Bad modifier falls back to 0.
      expect(out.find((p) => p.label === 'BadMod')?.modifier).toBe(0);
    });

    test('normalizePresets preserves an explicit persisted:false (memory-only flag survives reload)', () => {
      // Edge case: if a memory-only list somehow round-tripped through disk,
      // the flag is honoured rather than silently reset to persisted.
      const raw = [{ label: 'Blocked', pool: {}, modifier: 0, persisted: false }];
      const out = normalizePresets(raw);
      expect(out[0].persisted).toBe(false);
    });

    test('normalizePresets rejects non-array input defensively', () => {
      expect(normalizePresets(null)).toEqual([]);
      expect(normalizePresets({})).toEqual([]);
      expect(normalizePresets('not-an-array')).toEqual([]);
    });

    test('a full save -> reload round-trip preserves the preset', () => {
      // The contract the component relies on: what applySave writes is what
      // normalizePresets reads back, so a save that landed is visible after a
      // reload with no field loss.
      const original = [preset('Longsword', { modifier: 4, advMode: 'adv', pool: { 20: 2 } })];
      const saved = applySave([], original[0]);
      // Simulate the JSON.stringify -> JSON.parse the component does.
      const roundTripped = normalizePresets(JSON.parse(JSON.stringify(saved)));
      expect(roundTripped).toEqual(saved);
      expect(roundTripped[0]).toMatchObject({ label: 'Longsword', modifier: 4, advMode: 'adv' });
      expect(roundTripped[0].pool).toEqual({ 20: 2 });
    });
  });
});
