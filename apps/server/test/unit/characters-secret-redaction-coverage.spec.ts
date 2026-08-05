import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Issue #1489 — patchXp, levelUp, and patchSpellSlots each returned the raw
 * `toDomain(row)` instead of `redactSecret(toDomain(row), role)`, so a player
 * spending a spell slot (or gaining XP, or levelling up) got the DM's private
 * `dmSecret` back verbatim. All three sit right next to sibling methods that
 * DO redact — the bug is exactly "a method returns Character without going
 * through redactSecret/redactSecrets", and it had already happened three
 * times in this one file before this test existed.
 *
 * This is a REFLECTIVE coverage test, not a per-endpoint behavioral one (those
 * live in characters.e2e-spec.ts for the three endpoints the issue names).
 * It parses CharactersService's own source with the TypeScript compiler,
 * enumerates every public method whose declared return type is
 * `Promise<Character>` / `Promise<Character[]>`, and asserts that every
 * `return` statement belonging directly to that method (not one nested
 * inside a callback, e.g. a `db.transaction(...)` closure) is either:
 *   - a call to `redactSecret(...)` / `redactSecrets(...)`, or
 *   - a delegating call to another `this.<method>(...)` that is itself one
 *     of the enumerated, redaction-covered methods.
 *
 * `importFromDdb` (issue #1903) returns `Promise<DdbImportResult>` — an
 * envelope of `{ character, summary }`, not a bare `Character` — so this
 * enumeration no longer picks it up directly. It still can't leak `dmSecret`:
 * the `character` it embeds comes from `this.create(...)`, which IS one of
 * the enumerated, redaction-covered methods below.
 *
 * A future method that returns a bare `toDomain(row)` — the exact shape of
 * this bug — fails this test immediately, without needing to be added to any
 * hand-maintained list. If a genuinely new Character-returning method is
 * added, this test enumerates it automatically; the developer only needs to
 * make its return statement redact (or delegate), not update a list here.
 */

const SERVICE_PATH = path.join(__dirname, '../../src/modules/characters/characters.service.ts');
const CLASS_NAME = 'CharactersService';

interface ReturnInfo {
  text: string;
  redacts: boolean;
  delegatesTo: string | null;
}

interface MethodInfo {
  name: string;
  typeText: string;
  returns: ReturnInfo[];
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/** Return statements belonging directly to `root` — never descending into a nested function/arrow/method. */
function collectOwnReturns(root: ts.MethodDeclaration): ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  function visit(node: ts.Node): void {
    if (ts.isReturnStatement(node)) {
      returns.push(node);
      return;
    }
    ts.forEachChild(node, (child) => {
      if (isFunctionLike(child)) return;
      visit(child);
    });
  }
  if (root.body) {
    ts.forEachChild(root.body, (child) => {
      if (isFunctionLike(child)) return;
      visit(child);
    });
  }
  return returns;
}

function isRedactingCall(expr: ts.Expression | undefined, sourceFile: ts.SourceFile): boolean {
  if (!expr || !ts.isCallExpression(expr)) return false;
  const calleeText = expr.expression.getText(sourceFile);
  return calleeText === 'redactSecret' || calleeText === 'redactSecrets';
}

/** If `expr` is `this.someMethod(...)`, returns `'someMethod'`; otherwise null. */
function delegatingMethodName(expr: ts.Expression | undefined, sourceFile: ts.SourceFile): string | null {
  if (!expr || !ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return callee.name.getText(sourceFile);
  }
  return null;
}

function loadCharacterReturningMethods(): MethodInfo[] {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  const sourceFile = ts.createSourceFile(SERVICE_PATH, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const results: MethodInfo[] = [];
  function visitClass(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name?.text === CLASS_NAME) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.type || !member.name) continue;
        // Public only (no explicit modifier, or an explicit `public`) — private helpers
        // are not reachable from a controller/MCP tool and are out of scope.
        const isPrivate = member.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
        );
        if (isPrivate) continue;

        const typeText = member.type.getText(sourceFile);
        // Matches `Promise<Character>` and `Promise<Character[]>` — the two shapes every
        // Character-returning method in this service uses. `listForExport`'s
        // `Promise<Array<Character & {...}>>` is a deliberately different, wider shape
        // (adds conditionInstances for the export payload) and is out of scope here.
        if (!/^Promise<\s*Character(\[\])?\s*>$/.test(typeText)) continue;

        const name = member.name.getText(sourceFile);
        const returnStatements = collectOwnReturns(member);
        const returns = returnStatements.map((r) => ({
          text: r.expression ? r.expression.getText(sourceFile) : '<empty return>',
          redacts: isRedactingCall(r.expression, sourceFile),
          delegatesTo: delegatingMethodName(r.expression, sourceFile),
        }));
        results.push({ name, typeText, returns });
      }
    }
    ts.forEachChild(node, visitClass);
  }
  visitClass(sourceFile);
  return results;
}

describe('CharactersService — every Character-returning method redacts dmSecret (issue #1489)', () => {
  const methods = loadCharacterReturningMethods();
  const methodNames = new Set(methods.map((m) => m.name));

  it('found the full known set of Character-returning methods (fails if the enumeration itself breaks)', () => {
    // Pinned so a change here is a deliberate, reviewed decision (rename, removal, or a
    // genuinely new method) rather than the parser silently matching nothing. If this
    // fails because a new method was ADDED, that is the point: come add its return
    // statement to the redacting/delegating pattern below and this line will pass again.
    expect([...methodNames].sort()).toEqual(
      [
        'listForCampaign',
        'getOrThrow',
        'create',
        'update',
        'restore',
        'patchHp',
        'rest',
        'patchXp',
        'awardXp',
        'levelUp',
        'patchConditions',
        'adjustConditionLevel',
        'patchSpellSlots',
        'adjustResource',
        'restCharacter',
      ].sort(),
    );
  });

  it.each(methods.map((m) => [m.name, m] as const))(
    '%s: every return of the Character(s) it produces redacts, or delegates to a method that does',
    (_name, method) => {
      expect(method.returns.length).toBeGreaterThan(0);
      for (const ret of method.returns) {
        const compliant =
          ret.redacts || (ret.delegatesTo !== null && methodNames.has(ret.delegatesTo));
        if (!compliant) {
          throw new Error(
            `${method.name} has a return statement that neither redacts nor delegates to a ` +
              `covered method: \`return ${ret.text}\`. Wrap it in redactSecret(...)/redactSecrets(...) ` +
              '— see issue #1489.',
          );
        }
      }
    },
  );
});
