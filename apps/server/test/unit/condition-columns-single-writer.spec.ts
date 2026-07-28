import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Mechanical enforcement of the single-writer invariant (issue #1666, generalising #1664).
 *
 * `apps/server/src/common/conditions.ts` documents that it is the ONLY module allowed to write
 * the `conditions` (bare names) and `conditionInstances` (structured, carries `stacks` — e.g. 5e
 * exhaustion's level, #1073/#1047) columns on `characters` and `combatants`, because the two
 * store the same fact twice and must never disagree. That file has carried an audit grep in its
 * own doc comment since #1575 — but a grep nobody runs is a convention, not enforcement. #1664
 * found a violator (`CharactersService.restParty`, fixed in PR #1665) BY ACCIDENT, while working
 * on an unrelated issue. This test is what should have caught it on the PR that introduced it.
 *
 * WHAT THIS CHECKS — deliberately narrower than "no raw column name outside conditions.ts".
 * A blanket ban would false-positive on every legitimate site that sets BOTH columns from the
 * same source in one write (e.g. a fresh combatant INSERT seeded from a character sheet, or the
 * end-of-encounter sheet sync, which builds `{ conditions, conditionInstances }` via the shared
 * helpers and spreads both into one `.set()`/`.values()` call) — those are correct, and forcing
 * them through `common/conditions.ts` itself is a refactor, not this issue's job (see #1666's
 * scope note: additive only). The actual invariant is narrower and checkable without touching a
 * single call site: inside one `.set(` / `.values(` write, `conditions` and `conditionInstances`
 * must be either BOTH present as literal keys, or covered by a spread of one of the shared
 * pairing helpers ({@link HELPER_MARKERS}). A write that sets exactly one of the two, with
 * neither the other key nor a helper spread present in the same object, is the #1664 shape.
 *
 * PROVEN TO CATCH #1664: see the synthetic-fixture test below, which feeds the scanner
 * `restParty`'s exact pre-fix snippet (reconstructed from PR #1665's diff) and asserts it is
 * flagged. The live sweep test additionally runs the same scanner over the real source tree and
 * requires every hit to be justified in {@link KNOWN_EXCEPTIONS} — so a NEW unpaired write fails
 * CI even if it doesn't match the exact restParty shape.
 */

const SRC_ROOT = join(__dirname, '..', '..', 'src');

/** Files the scanner does not apply to: the writer itself, and the column DEFINITIONS. */
const EXCLUDED_FILES = new Set([join(SRC_ROOT, 'common', 'conditions.ts'), join(SRC_ROOT, 'db', 'schema.ts')]);

/** Spreading one of these into a `.set()`/`.values()` object writes both columns correctly. */
const HELPER_MARKERS = [
  'conditionWriteSetFromNames(',
  'sheetConditionWriteSetFromNames(',
  'conditionWriteSetFromInstances(',
  'sheetConditionWriteSetFromInstances(',
];

/** RHS shapes that READ a column rather than WRITE it — excluded before pairing is checked. */
const READ_RHS_PATTERNS = [
  /^\s*(combatants|characters)\.conditions\b/,
  /^\s*(combatants|characters)\.conditionInstances\b/,
  /^\s*fromJsonText[<(]/,
  /^\s*parseConditionInstances\(/,
  /^\s*readConditionInstances\(/,
  // A `.select({ conditionInstances: ... })` projection can alias through a row/candidate
  // variable too (`r.conditionInstances`, `candidate.conditions`) — still a read, not a write,
  // but only when paired with the SAME base identifier for both keys is it unambiguous; the
  // narrower table-name check above is the safe default and this widens it for the common
  // `row`/`candidate`/`r`/`w` aliases used in this codebase's `.select()` call sites.
  /^\s*(row|candidate|r|w)\.conditions\b/,
  /^\s*(row|candidate|r|w)\.conditionInstances\b/,
  // A TS interface/type member ends in `;` immediately, never a runtime write.
  /^\s*(string|number|boolean)\s*[;,]/,
];

export interface Violation {
  index: number;
  key: 'conditions' | 'conditionInstances';
  /** Truncated, whitespace-collapsed text for a human-readable failure message. */
  snippet: string;
  /** The FULL writer-call argument span — what KNOWN_EXCEPTIONS matching searches, untruncated. */
  fullSpan: string;
}

/**
 * The argument span of every `.set(...)` / `.values(...)` call in `source` — found by locating
 * the call, then counting parens from the `(` that opens its argument list to the matching `)`.
 * Deliberately scoped to THESE two Drizzle write methods, not "any `{...}` in the file": the
 * word "conditions" is common outside this invariant entirely (a SQL WHERE-clause accumulator
 * `const conditions: SQL[] = [...]`, a rule importer's route-name map `{ conditions: 'condition' }`)
 * and an enclosing-brace walk with no call-site anchor false-positives on all of them. Anchoring
 * to the two write methods that actually touch `characters`/`combatants` rows is what makes this
 * check about the DATABASE COLUMN rather than the English word.
 *
 * KNOWN LIMITATION, stated rather than hidden: `.values(someIdentifier)` where `someIdentifier`
 * is built elsewhere (e.g. via `.map()` returning row objects, as `encounters.service.ts`'s
 * batch monster insert does) is NOT resolved back to its definition — the scanner sees only the
 * bare identifier text and finds nothing to check. That one shape in this codebase was verified
 * safe by hand during #1666's sweep (fresh rows, no prior data to desync from) and is out of
 * this scanner's reach rather than silently "passing" it. Every direct inline `.set({...})` /
 * `.values({...})` write in this codebase — which is every UPDATE and most INSERTs, including
 * the one #1664 actually found — IS covered.
 */
function writerCallArgSpans(source: string): string[] {
  const spans: string[] = [];
  const callRe = /\.(?:set|values)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    const argStart = m.index + m[0].length;
    let depth = 1;
    let i = argStart;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    if (depth === 0) spans.push(source.slice(argStart, i - 1));
  }
  return spans;
}

/** Within one writer-call argument span, find WRITE-context `conditions:`/`conditionInstances:` keys. */
function writeKeyHitsIn(span: string): { key: Violation['key']; index: number }[] {
  const hits: { key: Violation['key']; index: number }[] = [];
  const re = /\b(conditionInstances|conditions)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(span))) {
    const key = m[1] as Violation['key'];
    const matchStart = m.index;
    const lineStart = span.lastIndexOf('\n', matchStart) + 1;
    if (span.slice(lineStart, matchStart).trimStart().startsWith('//')) continue;
    const rhs = span.slice(m.index + m[0].length, m.index + m[0].length + 80);
    if (READ_RHS_PATTERNS.some((p) => p.test(rhs))) continue;
    hits.push({ key, index: matchStart });
  }
  return hits;
}

/**
 * The scanner. Returns one {@link Violation} per `.set()`/`.values()` call whose argument object
 * sets `conditions` or `conditionInstances` WITHOUT its sibling and without a helper spread — the
 * exact shape of #1664's `restParty` bug. See {@link writerCallArgSpans} for what this does and
 * does not see.
 */
export function findUnpairedConditionWrites(source: string): Violation[] {
  const violations: Violation[] = [];
  for (const span of writerCallArgSpans(source)) {
    const hits = writeKeyHitsIn(span);
    if (hits.length === 0) continue;
    const hasConditions = hits.some((h) => h.key === 'conditions');
    const hasInstances = hits.some((h) => h.key === 'conditionInstances');
    const hasHelper = HELPER_MARKERS.some((h) => span.includes(h));
    if (hasHelper) continue; // paired via the shared helper
    if (hasConditions && hasInstances) continue; // both literal keys present — paired by hand
    for (const hit of hits) {
      violations.push({
        index: hit.index,
        key: hit.key,
        snippet: span.slice(0, 200).replace(/\s+/g, ' '),
        fullSpan: span,
      });
    }
  }
  return violations;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Known, human-verified exceptions the scanner would otherwise flag, because the enclosing
 * object literal it finds does not (or does not yet, pending a merge) contain the pairing it's
 * looking for — each entry states WHY it is safe. Adding an entry here is a deliberate, reviewed
 * act, unlike a silently-passing grep nobody runs (the failure mode #1666 exists to fix): a PR
 * that introduces a new unpaired write fails this test until its author either fixes the write
 * or adds a justified entry here, which a reviewer then sees in the diff.
 */
const KNOWN_EXCEPTIONS: { file: string; snippetContains: string; reason: string }[] = [
  {
    file: 'modules/characters/characters.service.ts',
    snippetContains: 'conditions: toJsonText(p.conditionsAfter)',
    reason:
      "Issue #1664's restParty violation — fixed in PR #1665 (unmerged at #1666's branch time). " +
      'Remove this entry once #1665 merges; at that point the site spreads ' +
      'sheetConditionWriteSetFromInstances(...) and this scanner will stop matching it anyway.',
  },
  {
    file: 'modules/campaigns/campaigns.service.ts',
    snippetContains: "conditions: '[]',",
    reason:
      "Campaign clone(): combatants for the COPIED encounter are seeded empty (encounter status " +
      "reset to 'preparing', round 0) — a deliberate fresh-start reset, not a desync. See #1666 sweep.",
  },
  {
    file: 'modules/campaigns/campaigns.service.ts',
    snippetContains: 'conditions: jsonCol(c.conditions',
    reason:
      'importCampaign(): character AND combatant inserts set `conditions` from the import ' +
      'payload but never `conditionInstances` — tracked separately (see #1666 sweep report: ' +
      'export-profiles.ts never includes conditionInstances in ANY character export policy, and ' +
      'the combatant import drops it even when the payload has it). Not fixed here — riding along ' +
      'in this PR would conflate a completeness/data-loss bug with the enforcement mechanism this ' +
      'issue is actually for; flagged to the coordinator for its own issue.',
  },
];

describe('single-writer invariant for conditions/conditionInstances (issue #1666)', () => {
  it('SYNTHETIC PROOF: the scanner flags #1664\'s exact restParty shape', () => {
    // Reconstructed from PR #1665's diff — the pre-fix `.set()` call this issue exists to have
    // caught. If this assertion ever fails, the scanner itself has regressed, independent of
    // whatever the live source tree currently contains.
    const restPartyPreFix = `
      tx.update(characters)
        .set({
          hpCurrent: p.hpAfter,
          hpTemp: p.hpTempAfter,
          deathState: p.deathStateAfter,
          deathSaveSuccesses: p.deathSaveSuccessesAfter,
          deathSaveFailures: p.deathSaveFailuresAfter,
          conditions: toJsonText(p.conditionsAfter),
          spellSlots: toJsonText(p.spellSlotsAfter),
          resources: toJsonText(p.resourcesAfter),
          updatedAt: at,
        })
        .where(eq(characters.id, p.characterId))
        .run();
    `;
    const violations = findUnpairedConditionWrites(restPartyPreFix);
    expect(violations).toHaveLength(1);
    expect(violations[0].key).toBe('conditions');
  });

  it('SYNTHETIC CONTROL: a paired write (both keys) is NOT flagged', () => {
    const paired = `
      tx.update(characters).set({ conditions: w.conditions, conditionInstances: w.conditionInstances }).run();
    `;
    expect(findUnpairedConditionWrites(paired)).toEqual([]);
  });

  it('SYNTHETIC CONTROL: a helper spread is NOT flagged', () => {
    const helperSpread = `
      tx.update(characters).set({ ...sheetConditionWriteSetFromNames(names, prior), updatedAt: at }).run();
    `;
    expect(findUnpairedConditionWrites(helperSpread)).toEqual([]);
  });

  it("does NOT flag encounters.service.ts's end-of-encounter sheet sync (issue #1666 review note)", () => {
    // Called out explicitly during review: this site builds { conditions, conditionInstances }
    // via `...sheetConditionWriteSetFromInstances(readConditionInstances(...))` spread into an
    // INTERMEDIATE accumulator object (characterWrites.push({...})) — a different object literal
    // than the one that reaches `.set()` — and only later, in a separate statement, copies both
    // resulting properties across as literal `conditions: w.conditions, conditionInstances:
    // w.conditionInstances` keys into the actual `.set({...})` call. A scanner that only
    // recognised the direct-helper-spread-inside-.set() shape would false-positive here (only
    // ONE literal key visible at the helper site, and no helper marker text at the .set() site) —
    // exactly the kind of "right about the known violation, wrong about a legitimate site" defect
    // that makes a guardrail worth disabling. This scanner survives it because the .set() call
    // itself carries BOTH literal keys side by side, which the "hasConditions && hasInstances"
    // branch accepts without needing to see the helper.
    const syncSource = readFileSync(join(SRC_ROOT, 'modules', 'encounters', 'encounters.service.ts'), 'utf8');
    const violations = findUnpairedConditionWrites(syncSource);
    const syncViolations = violations.filter((v) => v.fullSpan.includes('deathSaveFailures: w.deathSaveFailures'));
    expect(syncViolations).toEqual([]);
  });

  it('LIVE SWEEP: every unpaired write in apps/server/src is a known, justified exception', () => {
    const files = listTsFiles(SRC_ROOT).filter((f) => !EXCLUDED_FILES.has(f));
    const unjustified: string[] = [];
    const usedExceptions = new Set<number>();

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const violations = findUnpairedConditionWrites(source);
      if (violations.length === 0) continue;
      const relFile = relative(SRC_ROOT, file);
      for (const v of violations) {
        const exceptionIdx = KNOWN_EXCEPTIONS.findIndex(
          (ex) => ex.file === relFile && v.fullSpan.includes(ex.snippetContains),
        );
        if (exceptionIdx === -1) {
          unjustified.push(`${relFile} (key: ${v.key}): ${v.snippet}`);
        } else {
          usedExceptions.add(exceptionIdx);
        }
      }
    }

    if (unjustified.length > 0) {
      throw new Error(
        `Found ${unjustified.length} write(s) to 'conditions'/'conditionInstances' that set only ` +
          `one of the two columns without a helper spread — the #1664 shape. Either write both ` +
          `columns (prefer the helpers in common/conditions.ts) or, if this write is provably safe ` +
          `(e.g. a fresh row with nothing to desync from), add a justified entry to KNOWN_EXCEPTIONS ` +
          `in this file:\n\n${unjustified.join('\n')}`,
      );
    }

    // A stale exception (file/snippet no longer matches anything) is a smell: either the code
    // moved and the exception should follow it, or the underlying write was fixed and the entry
    // should be deleted (see the restParty entry's own note about #1665 merging).
    const stale = KNOWN_EXCEPTIONS.filter((_, i) => !usedExceptions.has(i));
    if (stale.length > 0) {
      throw new Error(
        `KNOWN_EXCEPTIONS entries no longer match any live violation — delete or update them:\n` +
          stale.map((e) => `${e.file}: "${e.snippetContains}"`).join('\n'),
      );
    }
  });
});
