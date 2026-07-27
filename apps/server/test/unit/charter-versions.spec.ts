import type { CharterAcknowledgmentState, SessionZeroCharterVersion } from '@campfire/schema';
import {
  EMPTY_CHARTER,
  charterUnchanged,
  diffCharters,
  isFullyAcknowledged,
  isMaterialCharterChange,
  outstandingAcknowledgers,
  resolveEffectiveVersion,
  type CharterFields,
} from '../../src/modules/session-zero/charter-versions';

/**
 * Issue #600 — the two rules the consent gate rests on.
 *
 * These are the tests that make "material change" a definition rather than a word in a
 * docblock. If the policy is ever revised, it must be revised here first.
 */
describe('#600 charter versioning', () => {
  const charter = (over: Partial<CharterFields> = {}): CharterFields => ({ ...EMPTY_CHARTER, ...over });

  describe('material change = a protection was withdrawn', () => {
    it('is material when a line is removed', () => {
      const before = charter({ lines: ['Harm to children', 'Sexual violence'] });
      const after = charter({ lines: ['Harm to children'] });
      expect(isMaterialCharterChange(before, after)).toBe(true);
    });

    it('is material when a veil is removed', () => {
      expect(
        isMaterialCharterChange(charter({ veils: ['On-screen torture'] }), charter({ veils: [] })),
      ).toBe(true);
    });

    it('is material when a safety tool is removed', () => {
      expect(
        isMaterialCharterChange(
          charter({ safetyTools: ['X-Card', 'Open Door'] }),
          charter({ safetyTools: ['X-Card'] }),
        ),
      ).toBe(true);
    });

    it('is NOT material when a line is added — the new version is strictly more protective', () => {
      const before = charter({ lines: ['Harm to children'] });
      const after = charter({ lines: ['Harm to children', 'Animal cruelty'] });
      expect(isMaterialCharterChange(before, after)).toBe(false);
    });

    it('is NOT material when only house rules or tone change', () => {
      const before = charter({ lines: ['Harm to children'], houseRules: 'Inspiration resets nightly.' });
      const after = charter({ lines: ['Harm to children'], houseRules: 'Inspiration resets weekly.' });
      expect(isMaterialCharterChange(before, after)).toBe(false);
      expect(
        isMaterialCharterChange(charter({ toneAndExpectations: 'Gritty' }), charter({ toneAndExpectations: 'Heroic' })),
      ).toBe(false);
      // …but the change is still visible to the reader.
      expect(diffCharters(before, after, 1, 2).houseRulesChanged).toBe(true);
    });

    it('treats an EDIT as material, because a tidy-up and a loosening look identical', () => {
      // The realistic bad case: this reads like a clarification and is actually a
      // narrowing of the protection.
      const before = charter({ lines: ['No on-screen violence'] });
      const after = charter({ lines: ['No graphic on-screen violence'] });
      expect(isMaterialCharterChange(before, after)).toBe(true);
    });

    it('does NOT fire on a pure re-casing or re-spacing — a typo fix is not a withdrawal', () => {
      const before = charter({ lines: ['Harm to  Children'] });
      const after = charter({ lines: ['harm to children'] });
      expect(isMaterialCharterChange(before, after)).toBe(false);
      expect(charterUnchanged(before, after)).toBe(true);
    });

    it('ignores blank entries on both sides', () => {
      expect(isMaterialCharterChange(charter({ lines: ['A', '   '] }), charter({ lines: ['A'] }))).toBe(false);
    });

    it('treats the first publish from nothing as non-material', () => {
      // Nobody had agreed to anything, so nothing has been withdrawn. The first version
      // still needs acknowledging to become effective — that is the gate's job, not this
      // function's.
      expect(isMaterialCharterChange(EMPTY_CHARTER, charter({ lines: ['Harm to children'] }))).toBe(false);
    });
  });

  describe('diff', () => {
    it('reports adds and removes per field, in their original casing', () => {
      const before = charter({ lines: ['Harm to children', 'Torture'], safetyTools: ['X-Card'] });
      const after = charter({ lines: ['Harm to children', 'Body horror'], safetyTools: ['X-Card', 'Open Door'] });
      const d = diffCharters(before, after, 2, 3);
      expect(d).toMatchObject({
        fromVersion: 2,
        toVersion: 3,
        material: true,
        addedLines: ['Body horror'],
        removedLines: ['Torture'],
        addedSafetyTools: ['Open Door'],
        removedSafetyTools: [],
      });
    });

    it('reports an unchanged charter as empty', () => {
      const c = charter({ lines: ['A'], veils: ['B'], safetyTools: ['C'], houseRules: 'x', toneAndExpectations: 'y' });
      expect(charterUnchanged(c, { ...c })).toBe(true);
    });
  });

  describe('effective version resolution', () => {
    const version = (id: number, v: number, material: boolean): SessionZeroCharterVersion => ({
      id,
      campaignId: 1,
      version: v,
      lines: [],
      veils: [],
      safetyTools: [],
      houseRules: '',
      toneAndExpectations: '',
      material,
      changeSummary: '',
      publishedBy: 'dm',
      publishedAt: '2026-01-01T00:00:00.000Z',
    });

    /** Build an ack lookup from { versionId: { userId: state } }. */
    const lookup = (table: Record<number, Record<string, CharterAcknowledgmentState>>) => (versionId: number) =>
      new Map(Object.entries(table[versionId] ?? {}));

    const required = ['u1', 'u2'];

    it('is null before anyone acknowledges the first version, even when it is non-material', () => {
      const v1 = version(10, 1, false);
      expect(resolveEffectiveVersion([v1], required, lookup({}))).toBeNull();
    });

    it('is null before anyone acknowledges the first material version', () => {
      const v1 = version(10, 1, true);
      expect(resolveEffectiveVersion([v1], required, lookup({}))).toBeNull();
    });

    it('advances to a non-material follow-up version without any acknowledgment once v1 is agreed', () => {
      // Additions are free: a table that keeps adding lines never has to stop and
      // re-consent — but only after the opening charter is acknowledged.
      const v1 = version(10, 1, false);
      const v2 = version(11, 2, false);
      const acked = lookup({ 10: { u1: 'acknowledged', u2: 'acknowledged' } });
      expect(resolveEffectiveVersion([v1, v2], required, acked)?.version).toBe(2);
    });

    it('stops at a material version until EVERY required participant acknowledges', () => {
      const v1 = version(10, 1, false);
      const v2 = version(11, 2, true);
      const v1Acked = lookup({ 10: { u1: 'acknowledged', u2: 'acknowledged' } });
      const partial = lookup({ 10: { u1: 'acknowledged', u2: 'acknowledged' }, 11: { u1: 'acknowledged' } });
      expect(resolveEffectiveVersion([v1, v2], required, partial)?.version).toBe(1);

      const complete = lookup({
        10: { u1: 'acknowledged', u2: 'acknowledged' },
        11: { u1: 'acknowledged', u2: 'acknowledged' },
      });
      expect(resolveEffectiveVersion([v1, v2], required, complete)?.version).toBe(2);
      expect(resolveEffectiveVersion([v1, v2], required, v1Acked)?.version).toBe(1);
    });

    it('treats discuss and declined as NOT clearing the gate', () => {
      const v1 = version(10, 1, false);
      const v2 = version(11, 2, true);
      for (const state of ['discuss', 'declined'] as CharterAcknowledgmentState[]) {
        const acks = lookup({
          10: { u1: 'acknowledged', u2: 'acknowledged' },
          11: { u1: 'acknowledged', u2: state },
        });
        expect(resolveEffectiveVersion([v1, v2], required, acks)?.version).toBe(1);
      }
    });

    it('does NOT let a cosmetic follow-up publish launder an unacknowledged withdrawal', () => {
      // THE transitivity case. v2 removed a line and nobody re-acknowledged. v3's own
      // diff is innocuous — but v3 still contains v2's removal, so the table must stay
      // on v1 once v1 is agreed. A naive "was the NEWEST version material?" check would
      // wrongly return v3.
      const v1 = version(10, 1, false);
      const v2 = version(11, 2, true);
      const v3 = version(12, 3, false);
      const v1Acked = lookup({ 10: { u1: 'acknowledged', u2: 'acknowledged' } });
      expect(resolveEffectiveVersion([v1, v2, v3], required, v1Acked)?.version).toBe(1);

      // Once v2 is acknowledged, v3 rides along on its own non-material status.
      const acked = lookup({
        10: { u1: 'acknowledged', u2: 'acknowledged' },
        11: { u1: 'acknowledged', u2: 'acknowledged' },
      });
      expect(resolveEffectiveVersion([v1, v2, v3], required, acked)?.version).toBe(3);
    });

    it('is order-independent — versions may arrive from SQL in any order', () => {
      const v1 = version(10, 1, false);
      const v2 = version(11, 2, true);
      const v3 = version(12, 3, false);
      const acked = lookup({
        10: { u1: 'acknowledged', u2: 'acknowledged' },
        11: { u1: 'acknowledged', u2: 'acknowledged' },
      });
      expect(resolveEffectiveVersion([v3, v1, v2], required, acked)?.version).toBe(3);
    });

    it('clears the gate vacuously when nobody is required (a solo table)', () => {
      const v1 = version(10, 1, true);
      expect(resolveEffectiveVersion([v1], [], lookup({}))?.version).toBe(1);
      expect(isFullyAcknowledged(10, [], lookup({}))).toBe(true);
    });

    it('lists exactly who is holding the gate, and what they said', () => {
      const acks = lookup({ 11: { u1: 'acknowledged', u2: 'discuss' } });
      expect(outstandingAcknowledgers(11, ['u1', 'u2', 'u3'], acks)).toEqual([
        { userId: 'u2', state: 'discuss' },
        { userId: 'u3', state: null },
      ]);
    });
  });
});
