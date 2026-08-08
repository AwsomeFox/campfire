/**
 * Issue #1992 (round 7, Devin): an unsaved statblock edit could be PATCHed to the WRONG
 * encounter on navigation — see `combatantPatchUrl.ts`'s module doc comment for the full
 * mechanism (a route change re-renders `RunSessionPage` with the new `encounterId` before
 * unmounting the OLD encounter's `CombatantRow`s, and `useMutation`'s shared observer
 * resolves whichever `mutationFn` the LATEST render set, regardless of which render's
 * closure actually calls `mutateAsync`).
 *
 * These tests deliberately do more than assert "a flush happened on unmount" (that alone
 * passes against the bug — the flush fires either way, only the URL it hits differs).
 * `combatantPatchUrlTest` actually EXECUTES `combatantPatchUrl` and demonstrates, by
 * direct comparison, that a stale closure over a mutated outer variable resolves the
 * WRONG id while an explicit-argument closure resolves the RIGHT one — modeling the exact
 * mechanism, not just checking that some function was called. The remaining tests pin the
 * two integration points (`CombatantRow`'s own call, and `RunSessionPage`'s wiring) by
 * source, since no component-render harness exists yet in this repo (see
 * combatant-statblock-draft.unit.spec.ts's TODO(#2033) for the same caveat).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { combatantPatchUrl } from '../../src/features/encounters/combat/combatantPatchUrl';

const ROW = resolve(__dirname, '../../src/features/encounters/combat/CombatantRow.tsx');
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

test.describe('combatantPatchUrl — issue #1992 round 7 (wrong-encounter-on-navigation)', () => {
  test('is a pure function of its own arguments: a stale closure over outer state mutated AFTER capture resolves the WRONG id, while an explicit-argument closure resolves the RIGHT one', () => {
    const API_BASE = 'https://example.test/api/v1';

    // Models `useMutation`'s shared observer options being overwritten in place across
    // RunSessionPage's own re-renders (only its children — CombatantRow instances — ever
    // unmount on a route change, not the page itself).
    let currentEncounterId = 1;

    // The BUGGY pattern this issue reports: resolving the target encounter from outer,
    // mutable state at CALL time rather than from an argument fixed at CAPTURE time.
    const buggyUrlForCombatant = (combatantId: number) => combatantPatchUrl(API_BASE, currentEncounterId, combatantId);
    // The FIXED pattern this codebase actually uses: `CombatantRow`'s own `encounterId`
    // prop, read normally like any other prop, threaded through as an explicit argument.
    const rowsOwnEncounterId = currentEncounterId; // captured while this row belongs to encounter 1
    const fixedUrlForCombatant = (encounterIdAtCaptureTime: number, combatantId: number) =>
      combatantPatchUrl(API_BASE, encounterIdAtCaptureTime, combatantId);

    // Both closures are captured NOW, while `currentEncounterId` is still 1 — mirroring a
    // CombatantRow whose last real render happened while viewing encounter 1.
    const staleBuggyClosure = () => buggyUrlForCombatant(99);
    const staleFixedClosure = () => fixedUrlForCombatant(rowsOwnEncounterId, 99);

    // Navigation to a DIFFERENT encounter: the shared state the buggy closure depends on
    // is mutated — exactly like the observer's options being updated on a later render.
    currentEncounterId = 2;

    // The buggy pattern silently resolves the NEW encounter even though this call was
    // captured while the combatant belonged to the OLD one — the reported defect,
    // reproduced directly rather than merely described.
    expect(staleBuggyClosure()).toBe(combatantPatchUrl(API_BASE, 2, 99));
    expect(staleBuggyClosure()).not.toBe(combatantPatchUrl(API_BASE, 1, 99));

    // The fixed pattern still resolves the encounter the combatant actually belongs to,
    // immune to the later mutation — because nothing about it depends on outer state.
    expect(staleFixedClosure()).toBe(combatantPatchUrl(API_BASE, 1, 99));
  });

  test('combatantPatchUrl builds the URL from its own encounterId/combatantId parameters only', () => {
    expect(combatantPatchUrl('https://x', 5, 10)).toBe('https://x/encounters/5/combatants/10');
    expect(combatantPatchUrl('https://x', 6, 10)).toBe('https://x/encounters/6/combatants/10');
  });

  test("CombatantRow's commitStatblock passes THIS ROW's OWN encounterId prop to onPatchCombatant, not an outer/ambient value", () => {
    const src = readFileSync(ROW, 'utf8');
    // The prop type itself requires the caller to supply it explicitly.
    expect(src).toMatch(/onPatchCombatant\?: \([\s\S]*?encounterId: number[\s\S]*?\) =>[\s\S]*?Promise<\{ ok: boolean \}>/);
    // commitStatblock's own call site passes `encounterId` — this row's own destructured
    // prop (see the component's parameter list), not any other identifier.
    expect(src).toMatch(
      /const result = onPatchCombatant\?\.\(\{ statblock: patch\.statblock, expectedStatblock: patch\.expectedStatblock \}, encounterId\);/,
    );
  });

  test("RunSessionPage's onPatchCombatant wiring forwards the CALLER-supplied encounterId to patchCombatant, not the page's own `eid`", () => {
    const src = readFileSync(RUN_SESSION_PAGE, 'utf8');
    // The wiring must use the SECOND argument CombatantRow passes (the row's own
    // encounterId) as patchCombatant's target — never falling back to `eid` here, which
    // is exactly the value that can have already changed by the time this fires from an
    // unmount cleanup.
    expect(src).toMatch(/onPatchCombatant=\{\(patch, targetEncounterId\) => patchCombatant\(targetEncounterId, c\.id, patch\)\}/);
    expect(src).not.toMatch(/onPatchCombatant=\{\(patch\) => patchCombatant\(c\.id, patch\)\}/);
  });

  test("RunSessionPage's combatantPatch mutation builds its URL via combatantPatchUrl from the per-call encounterId variable, not the outer `eid` closure", () => {
    const src = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(src).toMatch(
      /mutationFn: \(\{ combatantId, encounterId, patch \}: \{ combatantId: number; encounterId: number; patch: Record<string, unknown> \}\) =>\s*\n\s*api\.patch<Combatant>\(combatantPatchUrl\(API, encounterId, combatantId\), patch\),/,
    );
    // The old, vulnerable shape (URL built with a template literal reading `eid` directly)
    // must not be present.
    expect(src).not.toMatch(/api\.patch<Combatant>\(`\$\{API\}\/encounters\/\$\{eid\}\/combatants\/\$\{combatantId\}`/);
  });
});
