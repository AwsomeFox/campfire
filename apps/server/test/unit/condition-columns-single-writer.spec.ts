import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

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
  'conditionWriteSetFromNames',
  'sheetConditionWriteSetFromNames',
  'conditionWriteSetFromInstances',
  'sheetConditionWriteSetFromInstances',
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
 * The object-literal argument of every `.set({...})` / `.values({...})` call in `source`.
 * Deliberately scoped to THESE two Drizzle write methods, not "any `{...}` in the file": the
 * word "conditions" is common outside this invariant entirely (a SQL WHERE-clause accumulator
 * `const conditions: SQL[] = [...]`, a rule importer's route-name map `{ conditions: 'condition' }`)
 * and an enclosing-brace walk with no call-site anchor false-positives on all of them. Anchoring
 * to the two write methods that actually touch `characters`/`combatants` rows is what makes this
 * check about the DATABASE COLUMN rather than the English word.
 *
 * This is AST-based rather than a parenthesis-counting string walk: strings, comments, and
 * templates can contain arbitrary `(`/`)` text without changing what the writer-call argument is.
 *
 * KNOWN LIMITATION, stated rather than hidden: `.set(someIdentifier)` / `.values(someIdentifier)`
 * where `someIdentifier` is built elsewhere (e.g. via `.map()` returning row objects, as
 * `encounters.service.ts`'s batch monster insert does) is NOT resolved back to its definition —
 * the scanner sees only the bare identifier text and finds nothing to check. Those shapes in this
 * codebase were verified safe by hand during #1666's sweep (fresh rows, no prior data to desync
 * from, or a paired object assembled before the write) and are out of this scanner's reach rather
 * than silently "passing" them. Every direct inline `.set({...})` / `.values({...})` write in this
 * codebase — including the one #1664 actually found — IS covered.
 */
function writerCallArgObjects(source: string): { sourceFile: ts.SourceFile; object: ts.ObjectLiteralExpression; span: string }[] {
  const sourceFile = ts.createSourceFile('condition-scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const objects: { sourceFile: ts.SourceFile; object: ts.ObjectLiteralExpression; span: string }[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'set' || node.expression.name.text === 'values') &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const object = node.arguments[0];
      objects.push({ sourceFile, object, span: object.getText(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return objects;
}

function conditionKeyFromName(name: ts.PropertyName): Violation['key'] | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    if (name.text === 'conditions' || name.text === 'conditionInstances') return name.text;
  }
  return null;
}

function helperNameFromSpread(prop: ts.SpreadAssignment): string | null {
  let expr: ts.Expression = prop.expression;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  return ts.isIdentifier(callee) ? callee.text : null;
}

/** Within one writer-call object literal, find WRITE-context conditions/conditionInstances keys. */
function writeKeyHitsIn(sourceFile: ts.SourceFile, object: ts.ObjectLiteralExpression): { key: Violation['key']; index: number }[] {
  const hits: { key: Violation['key']; index: number }[] = [];
  const objectStart = object.getStart(sourceFile);
  for (const prop of object.properties) {
    let key: Violation['key'] | null = null;
    if (ts.isPropertyAssignment(prop)) key = conditionKeyFromName(prop.name);
    else if (ts.isShorthandPropertyAssignment(prop)) key = prop.name.text === 'conditions' || prop.name.text === 'conditionInstances' ? prop.name.text : null;
    if (key) hits.push({ key, index: prop.getStart(sourceFile) - objectStart });
  }
  return hits;
}

function hasHelperSpread(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((prop) => ts.isSpreadAssignment(prop) && HELPER_MARKERS.includes(helperNameFromSpread(prop) ?? ''));
}

/**
 * The scanner. Returns one {@link Violation} per `.set()`/`.values()` call whose argument object
 * sets `conditions` or `conditionInstances` WITHOUT its sibling and without a helper spread — the
 * exact shape of #1664's `restParty` bug. See {@link writerCallArgObjects} for what this does and
 * does not see.
 */
export function findUnpairedConditionWrites(source: string): Violation[] {
  const violations: Violation[] = [];
  for (const { sourceFile, object, span } of writerCallArgObjects(source)) {
    const hits = writeKeyHitsIn(sourceFile, object);
    if (hits.length === 0) continue;
    const hasConditions = hits.some((h) => h.key === 'conditions');
    const hasInstances = hits.some((h) => h.key === 'conditionInstances');
    const hasHelper = hasHelperSpread(object);
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

  it('SYNTHETIC PROOF: shorthand condition properties are write hits', () => {
    const shorthand = `
      tx.update(characters).set({ conditions, updatedAt: at }).run();
    `;
    const violations = findUnpairedConditionWrites(shorthand);
    expect(violations).toHaveLength(1);
    expect(violations[0].key).toBe('conditions');
  });

  it('SYNTHETIC PROOF: helper names in comments or strings do not suppress violations', () => {
    const fakeHelperMentions = `
      tx.update(characters).set({
        conditions: encoded,
        note: "TODO: use conditionWriteSetFromNames(...)",
        // sheetConditionWriteSetFromInstances(instances) belongs in a spread, not a comment.
        updatedAt: at,
      }).run();
    `;
    expect(findUnpairedConditionWrites(fakeHelperMentions).map((v) => v.key)).toEqual(['conditions']);
  });

  it('SYNTHETIC PROOF: parentheses inside strings and comments do not truncate writer calls', () => {
    const parensInText = `
      tx.update(characters).set({
        note: ")",
        conditions: encoded,
        // An unmatched ( in a comment must not absorb later calls.
        updatedAt: at,
      }).run();
    `;
    expect(findUnpairedConditionWrites(parensInText).map((v) => v.key)).toEqual(['conditions']);
  });

  it('SYNTHETIC PROOF: copying from a short-named variable is still a write', () => {
    const shortAliasWrite = `
      tx.update(combatants).set({ conditions: w.conditions, updatedAt: at }).run();
    `;
    expect(findUnpairedConditionWrites(shortAliasWrite).map((v) => v.key)).toEqual(['conditions']);
  });

  it('SYNTHETIC CONTROL: a paired end-of-encounter-style inline write is scanned and accepted', () => {
    // The live end-of-encounter sync currently calls `.set(set)` with an identifier, which this
    // scanner deliberately documents as out of scope. This fixture keeps the intended safety
    // control meaningful by using the same paired `w.conditions` / `w.conditionInstances` payload
    // shape inline, then first proving the scanner inspected it before asserting no violation.
    const pairedSheetSync = `
      tx.update(characters)
        .set({
          hpCurrent: w.hpCurrent,
          deathSaveFailures: w.deathSaveFailures,
          conditions: w.conditions,
          conditionInstances: w.conditionInstances,
          updatedAt: at,
        })
        .where(eq(characters.id, w.characterId))
        .run();
    `;
    expect(writerCallArgObjects(pairedSheetSync)).toHaveLength(1);
    expect(findUnpairedConditionWrites(pairedSheetSync)).toEqual([]);
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
