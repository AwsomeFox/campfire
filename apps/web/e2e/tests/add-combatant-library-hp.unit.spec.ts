/**
 * Unit tests for the library-monster HP round trip (issue #2080).
 *
 * `AddCombatantPanel` is a full data-fetching component (campaign/encounter
 * context, `api` calls) with no render harness in the pure-logic `test:unit:web`
 * lane (see `combatantStatblockDraft`'s tests for the established pattern this
 * follows: source-scan the exact wiring rather than re-implementing it as a
 * hand-rolled copy). The real value-flow assertions — a saved HP actually
 * reaching the re-added combatant's hpMax, and a legacy no-HP entry still
 * loading/adding — are executable, non-source-scan tests at the server layer
 * that owns the invariant: apps/server/test/integration/encounter-library-monster-hp.spec.ts
 * and apps/server/test/unit/combatant-statblock.spec.ts. These tests instead
 * pin the CLIENT half of the fix: the literal `: 10` fallback this issue reports
 * is gone, and the DM-typed HP is actually threaded into the save-to-library
 * payload — both directly reproducible from #2080's reported source lines.
 *
 * Review regression on PR #2086 (caught after this file first landed): removing
 * the `: 10` fallback made `addFromLibrary` send NO `hpMax` at all for a legacy
 * entry, and the Library tab had no way for a DM to supply one — the only HP
 * input was the Manual tab's, `hidden` while Library is active. A source-scan
 * test cannot see whether a rendered input actually exists and is wired up; the
 * behavioral proof for that lives in a real component render at
 * apps/web/test/component/AddCombatantPanelLibraryHp.spec.tsx, which mounts
 * `AddCombatantPanel`, drives its Library tab's real inline HP input, and
 * asserts on the actual POST payload. This file's tests below only pin the
 * priority-order wiring the render logic depends on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const PANEL = resolve(__dirname, '../../src/features/encounters/combat/AddCombatantPanel.tsx');
const EDITOR = resolve(__dirname, '../../src/features/encounters/CombatantStatblockEditor.tsx');

/** A balanced `{ ... }` block starting at the first `{` at or after `fromIndex`. */
function extractBalancedBlock(src: string, fromIndex: number): string {
  const openIdx = src.indexOf('{', fromIndex);
  if (openIdx === -1) throw new Error(`no opening brace found at or after index ${fromIndex}`);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(fromIndex, i + 1);
    }
  }
  throw new Error('unbalanced braces: reached end of file before depth returned to 0');
}

function extractFunctionSource(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`could not find ${JSON.stringify(signature)} in source`);
  return extractBalancedBlock(src, start);
}

test.describe('AddCombatantPanel library HP wiring — issue #2080', () => {
  test('addFromLibrary no longer hardcodes a 10 HP fallback when no HP is resolvable', () => {
    const src = readFileSync(PANEL, 'utf8');
    const fn = extractFunctionSource(src, 'async function addFromLibrary(entry: CampaignLibraryMonster, hpOverride?: number) {');

    // The literal defect this issue reports (verified against main at e8c3493c6):
    // `hpMax.trim() && Number.isFinite(Number(hpMax)) ? Math.max(1, Number(hpMax)) : 10`.
    // This exact shape — falling back to the digit 10 — must never reappear here.
    expect(fn).not.toMatch(/:\s*10\s*;/);

    // hpMax is sent only when a resolved override exists — never unconditionally — so
    // a library entry with real stored HP is not clobbered by a stale/blank field, and
    // one with none surfaces the server's real error (or the Library tab's own inline
    // HP input, see the render-block test below) instead of a silently invented number.
    expect(fn).toMatch(/resolvedOverride\s*!==\s*undefined\s*\?\s*\{\s*hpMax:\s*resolvedOverride\s*\}\s*:\s*\{\}/);
  });

  test('addFromLibrary resolves hpMax in priority order: per-entry override, then the Manual tab field, then nothing', () => {
    const src = readFileSync(PANEL, 'utf8');
    const fn = extractFunctionSource(src, 'async function addFromLibrary(entry: CampaignLibraryMonster, hpOverride?: number) {');

    // PR #2086 review regression: removing the `: 10` fallback left legacy library
    // entries (no stored `statblock.hp`) with no way to supply an hpMax at all, because
    // the Manual tab's shared field is hidden while the Library tab is active. The fix
    // adds a second, per-entry override sourced from the Library tab's own inline input
    // (see the render-block test below) and gives it top priority over the Manual tab's
    // shared field.
    expect(fn).toMatch(/const\s+resolvedOverride\s*=\s*hpOverride\s*\?\?\s*manualOverride\s*;/);
  });

  test('saveManualToLibrary threads the DM-typed HP into the persisted statblock, never dropping it', () => {
    const src = readFileSync(PANEL, 'utf8');
    const fn = extractFunctionSource(src, 'async function saveManualToLibrary() {');

    // The old defect (verified against main at e8c3493c6): `statblock: manualStatblock`
    // posted as-is, with no hp key at all on the statblock type — so whatever the DM
    // typed into the "HP" field never reached the library payload. The fix computes an
    // explicit hp and merges it in.
    expect(fn).toMatch(/hp:\s*hpToSave/);
    expect(fn).toMatch(/statblock:\s*\{\s*\.\.\.manualStatblock,\s*hp:\s*hpToSave\s*\}/);
    // Bare `statblock: manualStatblock` (no hp merge) must not reappear — that was the bug.
    expect(fn).not.toMatch(/statblock:\s*manualStatblock,?\s*\}/);
  });

  test('CombatantStatblockEditor surfaces hp next to ac (required shape) and treats a cleared field as null, not a revert', () => {
    const src = readFileSync(EDITOR, 'utf8');

    expect(src).toMatch(/COMBATANT_STATBLOCK_HELP\.hp/);
    expect(src).toMatch(/const \[hpDraft, setHpDraft\] = useState<string>/);
    // Clearing the field commits `hp: null` — distinct from acDraft's onChange, which
    // never patches on an unparseable value and instead waits for onBlur to decide
    // whether to revert. An empty HP field is a valid, real "unknown" state, not junk
    // input to be discarded back to whatever hp used to be.
    expect(src).toMatch(/patch\(\{\s*hp:\s*null\s*\}\)/);
  });
});
