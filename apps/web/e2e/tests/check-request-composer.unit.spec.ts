import { expect, test } from '@playwright/test';
import { CHECK_REQUEST_MAX_TARGETS as SCHEMA_CHECK_REQUEST_MAX_TARGETS } from '@campfire/schema';
import type { Character, CharacterStatus, RollCheckDefinition } from '@campfire/schema';
import {
  CHECK_REQUEST_MAX_TARGETS,
  commonChecks,
  commonChecksFromQueries,
  exceedsCheckRequestCap,
  syncCatalogErrorDisplay,
  wholePartyTargetIds,
  type CheckCatalogQueryState,
} from '../../src/features/encounters/checkRequestComposer';

test.describe('CHECK_REQUEST_MAX_TARGETS — single declaration, not a duplicated constant (issue #1943 review)', () => {
  test('the web composer re-exports the SAME constant CheckRequestCreate.characterIds is capped at — not a second copy of it', () => {
    // The guarantee this asserts is structural, not behavioral: `checkRequestComposer.ts`
    // imports `CHECK_REQUEST_MAX_TARGETS` from `@campfire/schema` and re-exports it rather than
    // declaring its own `= 20`. This test can only observe that both names resolve to the same
    // value at import time — it cannot prove there is only one declaration (a second hardcoded
    // `20` that happened to match would pass this too). The actual guarantee is the single
    // `export const CHECK_REQUEST_MAX_TARGETS` in packages/schema/src/index.ts and the absence
    // of any other declaration — verified by reading the source, not by this assertion alone.
    expect(CHECK_REQUEST_MAX_TARGETS).toBe(SCHEMA_CHECK_REQUEST_MAX_TARGETS);
  });
});

/** Minimal RollCheckDefinition fixture — only `id`/`label` vary per call in these tests. */
function mkCheckDef(id: string, overrides: Partial<RollCheckDefinition> = {}): RollCheckDefinition {
  return {
    id,
    label: id,
    category: 'skill',
    ability: null,
    proficiency: null,
    favorite: false,
    modifier: 0,
    breakdown: [],
    die: 20,
    supportsAdvantage: false,
    supportsDegrees: false,
    ...overrides,
  };
}

test.describe('commonChecks — group-check composer catalog intersection (issue #1943 review #7)', () => {
  test('a single selected character\'s catalog passes through unfiltered (single-target unaffected)', () => {
    const solo = [mkCheckDef('save:DEX'), mkCheckDef('skill:Climbing')];
    expect(commonChecks([solo]).map((d) => d.id)).toEqual(['save:DEX', 'skill:Climbing']);
  });

  test('intersects two GENUINELY DIFFERENT non-5e (OSR-shaped) catalogs — only the shared check remains', () => {
    // Two OSR characters. neutralCheckCatalog derives skill:* ids from each character's OWN
    // `skills` keys, so a Fighter and a Thief genuinely have different catalogs beyond the
    // shared ability saves — exactly the case a single "representative" catalog would miss.
    const fighterChecks = [mkCheckDef('save:DEX'), mkCheckDef('save:STR'), mkCheckDef('skill:Climbing')];
    const thiefChecks = [mkCheckDef('save:DEX'), mkCheckDef('skill:PickLocks'), mkCheckDef('skill:MoveSilently')];

    const common = commonChecks([fighterChecks, thiefChecks]);
    expect(common.map((d) => d.id)).toEqual(['save:DEX']);
    // Neither character-specific skill leaks through — a check only the Fighter can roll must
    // never be offered when the Thief is also targeted, and vice versa.
    expect(common.some((d) => d.id === 'skill:Climbing')).toBe(false);
    expect(common.some((d) => d.id === 'skill:PickLocks')).toBe(false);
  });

  test('keeps the FIRST list\'s definitions (label/order) for the ids that survive the intersection', () => {
    const first = [mkCheckDef('save:DEX', { label: 'DEX Save (Fighter)' }), mkCheckDef('skill:Climbing')];
    const second = [mkCheckDef('save:DEX', { label: 'Reflex (Thief)' }), mkCheckDef('skill:PickLocks')];
    const common = commonChecks([first, second]);
    expect(common).toHaveLength(1);
    expect(common[0].label).toBe('DEX Save (Fighter)'); // first list's definition, not second's
  });

  test('returns [] — not a guess — when the selected characters share NO check at all', () => {
    const fighterChecks = [mkCheckDef('skill:Climbing')];
    const wizardChecks = [mkCheckDef('spell:MagicMissile')];
    expect(commonChecks([fighterChecks, wizardChecks])).toEqual([]);
  });

  test('three-way intersection: a check must be present in EVERY selected character\'s catalog, not just a majority', () => {
    const a = [mkCheckDef('save:DEX'), mkCheckDef('skill:Shared')];
    const b = [mkCheckDef('save:DEX'), mkCheckDef('skill:Shared')];
    const c = [mkCheckDef('save:DEX')]; // lacks skill:Shared
    expect(commonChecks([a, b, c]).map((d) => d.id)).toEqual(['save:DEX']);
  });

  test('empty selection returns []', () => {
    expect(commonChecks([])).toEqual([]);
  });
});

/** Minimal character fixture — only `id`/`status` matter to these functions. */
function mkChar(id: number, status: CharacterStatus): Pick<Character, 'id' | 'status'> {
  return { id, status };
}

test.describe('wholePartyTargetIds / exceedsCheckRequestCap — "Whole party" preset (issue #1943 review finding #6)', () => {
  test('selects only active characters — retired, dead, draft, and inactive sheets are excluded', () => {
    const roster = [
      mkChar(1, 'active'),
      mkChar(2, 'retired'),
      mkChar(3, 'dead'),
      mkChar(4, 'draft'),
      mkChar(5, 'inactive'),
      mkChar(6, 'active'),
    ];
    expect(wholePartyTargetIds(roster)).toEqual([1, 6]);
  });

  test('an all-retired/dead roster (everyone has moved on) selects nothing', () => {
    const roster = [mkChar(1, 'retired'), mkChar(2, 'dead')];
    expect(wholePartyTargetIds(roster)).toEqual([]);
  });

  test('exceedsCheckRequestCap is false at and under the server cap, true just past it', () => {
    const atCap = Array.from({ length: CHECK_REQUEST_MAX_TARGETS }, (_, i) => i + 1);
    const overCap = Array.from({ length: CHECK_REQUEST_MAX_TARGETS + 1 }, (_, i) => i + 1);
    expect(exceedsCheckRequestCap(atCap)).toBe(false);
    expect(exceedsCheckRequestCap(overCap)).toBe(true);
    expect(exceedsCheckRequestCap([])).toBe(false);
  });

  test('a long-running campaign with more than 20 ACTIVE characters would overflow the preset — the exact case a silent 400 previously hit', () => {
    const roster = Array.from({ length: CHECK_REQUEST_MAX_TARGETS + 5 }, (_, i) => mkChar(i + 1, 'active'));
    const ids = wholePartyTargetIds(roster);
    expect(ids).toHaveLength(CHECK_REQUEST_MAX_TARGETS + 5);
    expect(exceedsCheckRequestCap(ids)).toBe(true);
  });
});

/** A query in a given state — mirrors the three shapes a TanStack Query result actually takes. */
function loadingQuery(): CheckCatalogQueryState {
  return { data: undefined, isSuccess: false, isError: false };
}
function errorQuery(): CheckCatalogQueryState {
  // The real bug (issue #1943 review): an errored query has isLoading: false AND data:
  // undefined — indistinguishable from a legitimately-empty catalog by `data ?? []` alone.
  return { data: undefined, isSuccess: false, isError: true };
}
function loadedQuery(checks: readonly RollCheckDefinition[]): CheckCatalogQueryState {
  return { data: checks, isSuccess: true, isError: false };
}

test.describe('commonChecksFromQueries — loading/failed/loaded tri-state (issue #1943 review follow-up)', () => {
  test('LOADING: any query still pending — no intersection computed, no error, no "no common check" claim', () => {
    const result = commonChecksFromQueries([loadedQuery([mkCheckDef('save:DEX')]), loadingQuery()]);
    expect(result.checks).toEqual([]);
    expect(result.noCommonCheck).toBe(false);
    expect(result.anyError).toBe(false);
  });

  test('FAILED (the exact regression): one query errors while the other genuinely has no checks in common — must NOT report noCommonCheck', () => {
    // This is the dramatic case the bug conflated: character A's catalog fetch failed (network
    // hiccup), character B's catalog loaded fine with save:DEX. A naive `data ?? []` reads A as
    // "rolls nothing", so the intersection with B's [save:DEX] silently collapses to [] — visually
    // IDENTICAL to a genuine empty intersection, blocking the DM from sending anything and lying
    // about why.
    const result = commonChecksFromQueries([errorQuery(), loadedQuery([mkCheckDef('save:DEX')])]);
    expect(result.anyError).toBe(true);
    // The dramatic assertion: noCommonCheck must be false here — an error is not a disjoint
    // catalog, and the caller must not render the "no check in common" hint for it.
    expect(result.noCommonCheck).toBe(false);
    expect(result.checks).toEqual([]);
  });

  test('FAILED: an error alongside an ACTUALLY-empty-catalog character still reports anyError, not noCommonCheck', () => {
    const result = commonChecksFromQueries([errorQuery(), loadedQuery([])]);
    expect(result.anyError).toBe(true);
    expect(result.noCommonCheck).toBe(false);
  });

  test('LOADED, disjoint: every query succeeded and they share nothing — THIS is when noCommonCheck is genuinely true', () => {
    const result = commonChecksFromQueries([loadedQuery([mkCheckDef('skill:Climbing')]), loadedQuery([mkCheckDef('spell:MagicMissile')])]);
    expect(result.anyError).toBe(false);
    expect(result.noCommonCheck).toBe(true);
    expect(result.checks).toEqual([]);
  });

  test('LOADED, shared check: every query succeeded and the intersection is non-empty', () => {
    const result = commonChecksFromQueries([
      loadedQuery([mkCheckDef('save:DEX'), mkCheckDef('skill:Climbing')]),
      loadedQuery([mkCheckDef('save:DEX'), mkCheckDef('skill:PickLocks')]),
    ]);
    expect(result.anyError).toBe(false);
    expect(result.noCommonCheck).toBe(false);
    expect(result.checks.map((d) => d.id)).toEqual(['save:DEX']);
  });

  test('empty query list (nothing selected): no error, no false "no common check" claim', () => {
    const result = commonChecksFromQueries([]);
    expect(result.anyError).toBe(false);
    expect(result.noCommonCheck).toBe(false);
    expect(result.checks).toEqual([]);
  });
});

test.describe('syncCatalogErrorDisplay — never clears the shared parent slot (issue #1943 review, round 7)', () => {
  test('entering the error state writes the message to BOTH localError and the parent channel', () => {
    const result = syncCatalogErrorDisplay(true, 'Boom');
    expect(result).toEqual({ localError: 'Boom', parentError: 'Boom' });
  });

  test('recovery clears localError — the panel owns that outright, so its inline message must go', () => {
    const result = syncCatalogErrorDisplay(false, 'Boom');
    expect(result.localError).toBeNull();
  });

  test('recovery NEVER touches the parent slot, whatever is in it', () => {
    // The heart of rounds 4-7. `onError` is RunSessionPage's page-wide surfaceActionError,
    // written by many unrelated actions. Three progressively more careful attempts to clear it
    // "only when we own it" all failed the same way: an ownership flag cannot see writers that
    // never touch it, so any other action overwriting the banner left the flag still reading
    // "ours" and the next catalog recovery erased a newer, unrelated failure. `undefined` here
    // means the caller skips the onError call entirely — the only outcome that cannot erase
    // someone else's message, regardless of who wrote it or when.
    expect(syncCatalogErrorDisplay(false, 'Boom').parentError).toBeUndefined();
    expect(syncCatalogErrorDisplay(false, '').parentError).toBeUndefined();
  });

  test('mount touches the parent slot too — same call shape, same "leave alone" outcome', () => {
    // A fresh useEffect(..., [checksAnyError]) mount has checksAnyError === false, which is the
    // identical call to the recovery case above. Asserted separately because they are distinct
    // real-world triggers (opening the panel vs. a retry succeeding) that must both resolve to
    // "do not write the parent" — not because the function can distinguish them. It cannot.
    expect(syncCatalogErrorDisplay(false, '').parentError).toBeUndefined();
  });
});
