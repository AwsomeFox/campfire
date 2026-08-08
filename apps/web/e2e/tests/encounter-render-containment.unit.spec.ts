import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Source-assertion guard (issue #1917, pattern: optimistic-hp-rollback.unit.spec.ts:36-44) —
// no browser, no seeded backend. Confirms the five memo boundaries stage 1 requires stay in
// place, rather than reasoning about render behavior it cannot actually observe: this spec
// only proves the *wrapper* is still there, never that a given prop is stable — the browser
// probes in encounter-render-containment.spec.ts carry that proof.
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');
const GRID_OVERLAY = resolve(__dirname, '../../src/features/encounters/map/GridOverlay.tsx');
const COMBATANT_ROW = resolve(__dirname, '../../src/features/encounters/combat/CombatantRow.tsx');
const COMBATANT_STATBLOCK = resolve(__dirname, '../../src/features/encounters/combat/CombatantStatblock.tsx');

test.describe('encounter cockpit memo boundaries (issue #1917 stage 1)', () => {
  test('BattleMap and ApplyDamageBar stay React.memo-wrapped', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toContain('export const BattleMap = memo(function BattleMap(');
    expect(source).toContain('export const ApplyDamageBar = memo(function ApplyDamageBar(');
  });

  test('CombatantRow stays React.memo-wrapped', () => {
    const source = readFileSync(COMBATANT_ROW, 'utf8');
    expect(source).toContain('export const CombatantRow = memo(function CombatantRow(');
  });

  test('CombatantStatblock stays React.memo-wrapped', () => {
    const source = readFileSync(COMBATANT_STATBLOCK, 'utf8');
    expect(source).toContain('export const CombatantStatblock = memo(function CombatantStatblock(');
  });

  test('InitiativeStrip stays React.memo-wrapped', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toContain('const InitiativeStrip = memo(function InitiativeStrip(');
  });

  test('BattleMap renders the grid overlay through the extracted, memoized GridOverlay component (issue #1917 stage 2)', () => {
    const battleMapSource = readFileSync(BATTLE_MAP, 'utf8');
    // The inline <svg data-testid="battle-map-grid"> pattern/hex block must be gone from
    // BattleMap itself — it now lives only in GridOverlay.
    expect(battleMapSource).not.toContain('data-testid="battle-map-grid"');
    expect(battleMapSource).toContain("import { GridOverlay } from './GridOverlay';");
    // Match the actual JSX usage — the opening tag followed by a real prop — not just the
    // string "<GridOverlay", which would also match this file's own doc-comments referencing
    // `` `<GridOverlay>` ``; those survive even if the JSX usage is reverted to the old inline
    // block, so the bare-substring version of this assertion passed under exactly the mutation
    // it exists to catch.
    //
    // Whitespace-tolerant on purpose: pinning the literal indentation (`'<GridOverlay\n' +
    // 18 spaces + 'gridOn={gridOn}'`) made the guard fail on a Prettier reflow that changes
    // nothing it cares about. `\s+` still requires `gridOn={gridOn}` to be the FIRST thing
    // after the tag, so a doc-comment mention cannot satisfy it.
    expect(battleMapSource).toMatch(/<GridOverlay\s+gridOn=\{gridOn\}/);

    const gridOverlaySource = readFileSync(GRID_OVERLAY, 'utf8');
    expect(gridOverlaySource).toContain('export const GridOverlay = memo(function GridOverlay(');
    expect(gridOverlaySource).toContain('data-testid="battle-map-grid"');
    // Stage 2's acceptance criterion: GridOverlay's props are geometry inputs only.
    expect(gridOverlaySource).toContain('gridType: GridType');
    expect(gridOverlaySource).toContain('mapRect: Rect | null');
    expect(gridOverlaySource).toContain('calibrationPx: GridCalibrationPx | null');
    expect(gridOverlaySource).toContain('hexOrientation: HexOrientation');
    expect(gridOverlaySource).toContain('opacity: number');
    // Must not accept the whole `encounter` object — that would reintroduce the exact
    // identity churn (issue #1917) this extraction exists to remove.
    expect(gridOverlaySource).not.toContain('EncounterWithCombatants');
    // The existing hexCells useMemo in BattleMap must still be the one source of the hex
    // point-string geometry — GridOverlay must not recompute it.
    expect(battleMapSource).toContain('const hexCells = useMemo(');
    expect(gridOverlaySource).not.toContain('hexPolygons(');
  });

  test('BattleMap call site stabilizes the props stage 1 flags as churn sources (issue #1917)', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    // pendingFogForEncounter(pendingFog, eid) must be hoisted into a useMemo, not called
    // inline at the BattleMap JSX call site every render.
    expect(source).toContain('const battleMapPendingFog = useMemo(() => pendingFogForEncounter(pendingFog, eid)');
    expect(source).toContain('pendingFog={battleMapPendingFog}');
    // onImportMap must be a stable useCallback, not a fresh arrow built in JSX.
    expect(source).toContain('const handleImportMap = useCallback(');
    expect(source).toContain('onImportMap={canEditEncounter ? handleImportMap : undefined}');
    // rowRef must come from a per-combatant-id cache, not a fresh arrow per render.
    expect(source).toContain('const getCombatantRowRef = useCallback(');
    expect(source).toContain('rowRef={getCombatantRowRef(c.id)}');
    expect(source).not.toContain('rowRef={(el) => setCombatantRowRef(c.id, el)}');
  });
});
