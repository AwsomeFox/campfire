import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Issue #1745 — generalizes the reflective dmSecret-redaction guard that #1489
 * shipped for `CharactersService` across every other service owning a
 * dmSecret-bearing entity: locations, quests, npcs, factions, timeline, sessions.
 *
 * Opt-in `redactSecret`/`redactSecrets` had already failed six times in
 * `CharactersService` alone (#1489): a method returned the raw `toDomain(row)`
 * instead of `redactSecret(toDomain(row), role)`, so a non-DM caller got the
 * DM's private `dmSecret` back verbatim. The exact same pattern exists in every
 * service here, and none of them had a guard — so the same one-line omission in
 * any future method (or any current one) would ship a seventh leak with no test
 * catching it.
 *
 * This is a REFLECTIVE coverage test, not a per-endpoint behavioral one. It parses
 * each service's own source with the TypeScript compiler, enumerates every public
 * method whose declared return type carries a dmSecret-bearing domain type
 * (directly, as an array, or wrapped in a `{ items }` / `{ quests }` page shape),
 * and asserts that every `return` statement belonging directly to that method
 * (never descending into a nested callback/arrow, e.g. a `db.transaction(...)`
 * closure) only ever returns data that has already been redacted. Concretely a
 * return is compliant when it is one of:
 *   - a call to `redactSecret(...)` / `redactSecrets(...)` (the canonical fix), or
 *   - a delegating call to another `this.<method>(...)` that is itself one of the
 *     enumerated, redaction-covered methods (e.g. `getWithMembersOrThrow`
 *     delegates to `getOrThrow`; `listForCampaignByStatus` delegates to
 *     `listForCampaign`), or
 *   - a value derived ONLY from already-safe locals (a local assigned from any of
 *     the above), via a small set of recognized transforms: bare local reference,
 *     `.filter()/.map()/.slice()` chains, a spread into a wrapper object/array
 *     literal, a ternary whose both arms are safe, an empty `[]`, or a call to a
 *     known page-builder helper (`buildCursorListPage`) whose element-source
 *     argument is itself safe.
 *
 * A future method that returns a bare `toDomain(row)` — the exact shape of this
 * bug — fails this test immediately, because that raw row is never an already-safe
 * local. If a genuinely new dmSecret-bearing method is added, the enumeration
 * picks it up automatically; the developer only needs to make its return statement
 * redact (or delegate, or build from an already-redacted local), not update a list
 * here. The pinned known-set assertions below fail loudly if the enumeration itself
 * drifts (a rename/removal/addition), forcing a deliberate review instead of a
 * silent miss.
 */

interface ServiceSpec {
  /** Display name used in describe/it titles. */
  name: string;
  /** Absolute path to the service source file. */
  servicePath: string;
  /** Class name to locate inside the file. */
  className: string;
  /**
   * The dmSecret-bearing domain type names this service returns, in ANY shape:
   * bare (`Location`), array (`Location[]`), or as the element of a wrapper
   * (`{ items: Location[] }`, `{ quests: Quest[] }`). A method's declared return
   * type matches if it contains any of these names as a whole word.
   */
  domainTypes: string[];
  /**
   * The complete known set of public method names whose return type carries one
   * of `domainTypes`. Pinned so a parser regression (or an unreviewed add/remove)
   * fails loudly instead of silently matching nothing/too much. When a new
   * dmSecret-returning method is added, this list MUST be updated alongside its
   * redacting return — that update IS the review gate.
   */
  knownMethods: string[];
}

const SERVICES_DIR = path.join(__dirname, '../../src/modules');

const SERVICES: ServiceSpec[] = [
  {
    name: 'LocationsService',
    servicePath: path.join(SERVICES_DIR, 'locations/locations.service.ts'),
    className: 'LocationsService',
    domainTypes: ['Location'],
    knownMethods: ['listForCampaign', 'getOrThrow', 'create', 'update', 'restore', 'discover'],
  },
  {
    name: 'QuestsService',
    servicePath: path.join(SERVICES_DIR, 'quests/quests.service.ts'),
    className: 'QuestsService',
    // Quest (bare/array) and QuestListItem (Quest.extend — still carries dmSecret).
    // changesSince returns `{ quests: Quest[] }` and is matched by the Quest name.
    domainTypes: ['Quest', 'QuestListItem'],
    knownMethods: [
      'listForCampaign',
      'listForCampaignByStatus',
      'listForCampaignByStatusWithProgress',
      'changesSince',
      'getOrThrow',
      'create',
      'update',
      'restore',
      'setStatus',
    ],
  },
  {
    name: 'NpcsService',
    servicePath: path.join(SERVICES_DIR, 'npcs/npcs.service.ts'),
    className: 'NpcsService',
    domainTypes: ['Npc'],
    knownMethods: ['listForCampaign', 'listForFaction', 'getOrThrow', 'create', 'update', 'restore'],
  },
  {
    name: 'FactionsService',
    servicePath: path.join(SERVICES_DIR, 'factions/factions.service.ts'),
    className: 'FactionsService',
    // Faction (bare/array) and FactionWithMembers (Faction.extend — carries dmSecret).
    domainTypes: ['Faction', 'FactionWithMembers'],
    knownMethods: [
      'listForCampaign',
      'getOrThrow',
      'getWithMembersOrThrow',
      'create',
      'update',
      'adjustReputation',
      'restore',
    ],
  },
  {
    name: 'TimelineService',
    servicePath: path.join(SERVICES_DIR, 'timeline/timeline.service.ts'),
    className: 'TimelineService',
    // TimelineEvent (bare/array) and TimelineListPage ({ items: TimelineEvent[] }).
    domainTypes: ['TimelineEvent', 'TimelineListPage'],
    knownMethods: [
      'listEventsPage',
      'listEvents',
      'getEventOrThrow',
      'createEvent',
      'updateEvent',
      'restoreEvent',
    ],
  },
  {
    name: 'SessionsService',
    servicePath: path.join(SERVICES_DIR, 'sessions/sessions.service.ts'),
    className: 'SessionsService',
    // Session (bare/array), SessionListItem (Session-derived, carries dmSecret),
    // SessionListPage ({ items: SessionListItem[] }), SessionSearchEntry (local
    // type with an explicit dmSecret field).
    domainTypes: ['Session', 'SessionListItem', 'SessionListPage', 'SessionSearchEntry'],
    knownMethods: [
      'listForCampaign',
      'listPageForCampaign',
      'listRecapsForCampaign',
      'searchForCampaign',
      'getOrThrow',
      'create',
      'update',
      'restore',
    ],
  },
];

interface ReturnInfo {
  text: string;
  safe: boolean;
  reason: string | null;
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

function isRedactingCall(expr: ts.Node): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  // `redactSecret(...)` / `redactSecrets(...)` — either bare imports or `this.`/namespaced.
  if (ts.isIdentifier(callee)) return callee.text === 'redactSecret' || callee.text === 'redactSecrets';
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === 'redactSecret' || callee.name.text === 'redactSecrets';
  }
  return false;
}

/**
 * If `expr` is a `this.<method>(...)` or `this.<service>.<method>(...)` call, returns the
 * method name; otherwise null. The first form is an intra-service delegation (e.g. quests'
 * `listForCampaignByStatus` → `listForCampaign`); the second is a cross-service delegation to
 * an injected dependency (e.g. factions' `getWithMembersOrThrow` → `this.npcs.listForFaction`).
 * Both are safe when the named method is in a covered-method set — see `collectSafeLocals`.
 */
function delegatingMethodName(expr: ts.Node): string | null {
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  // `this.foo(...)` — callee.expression is `this`.
  if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) return callee.name.text;
  // `this.svc.foo(...)` — callee.expression is `this.svc` (a PropertyAccessExpression on `this`).
  if (
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return callee.name.text;
  }
  return null;
}

/**
 * Known page-builder / wrapper helpers that PRESERVE the redaction state of their
 * element-source argument (their first argument). `buildCursorListPage` packages
 * an already-redacted `items` array into a `{ items, total, hasMore, nextCursor }`
 * page without re-reading any raw row, so its result is as safe as the `items` it
 * was handed. Listing them explicitly keeps the guard from false-positive-ing on
 * these correct wrapper returns while still requiring the source array to be safe.
 */
const REDACTION_PRESERVING_WRAPPERS = new Set(['buildCursorListPage']);

/**
 * Collect, for one method body, the set of local-variable names that hold
 * already-redacted data. A local is "safe" when its initializer is:
 *   - a `redactSecret(...)` / `redactSecrets(...)` call, or
 *   - a delegating call to a covered `this.<method>(...)`, or
 *   - a call to a redaction-preserving wrapper whose first arg is itself safe
 *     (`const items = buildCursorListPage(redacted, ...)`), or
 *   - a simple derivation from another safe local: `.filter()`, `.map()`,
 *     `.slice()`, or a ternary whose both arms are safe, or another safe local.
 *
 * This is a deliberately small, conservative flow: it walks declarations in source
 * order and re-scans until it reaches a fixpoint, so `a`-safe-then-`b`-from-`a`
 * composes. It does NOT track reassignment branches, mutation, or cross-method
 * state — exactly the surface these services use, and enough to recognize the
 * wrapper/filter/map patterns without ever marking a raw `toDomain(row)` safe.
 */
function collectSafeLocals(
  root: ts.MethodDeclaration,
  methodNames: Set<string>,
  safeLocals: Set<string>,
): void {
  if (!root.body) return;
  let changed = true;
  while (changed) {
    changed = false;
    function visit(node: ts.Node): void {
      if (isFunctionLike(node)) return;
      // `const x = <init>` / `let x = <init>` — only the initializer counts; a later
      // reassignment is intentionally NOT picked up (we never want to call a variable
      // safe if it was overwritten with a raw row).
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
          const name = decl.name.text;
          if (safeLocals.has(name)) continue;
          if (isSafeExpression(decl.initializer, safeLocals, methodNames)) {
            safeLocals.add(name);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(root.body, (child) => {
      if (isFunctionLike(child)) return;
      visit(child);
    });
  }
}

/** Identifier names that can never carry a dmSecret-bearing row (helpers, primitives). */
const NON_ENTITY_NAMES = new Set([
  'undefined',
  'null',
  'true',
  'false',
  'limit',
  'offset',
  'total',
  'since',
  'hasMore',
]);

function isSafeExpression(
  expr: ts.Node,
  safeLocals: Set<string>,
  methodNames: Set<string>,
): boolean {
  // Unwrap `await` — `const all = await this.listForCampaign(...)` is a covered delegation
  // even though the initializer is an AwaitExpression wrapping the call.
  if (ts.isAwaitExpression(expr)) return isSafeExpression(expr.expression, safeLocals, methodNames);

  // Direct redaction or covered delegation — the canonical safe sources.
  if (isRedactingCall(expr)) return true;
  const delegated = delegatingMethodName(expr);
  if (delegated !== null && methodNames.has(delegated)) return true;

  // Safe local reference.
  if (ts.isIdentifier(expr)) {
    return safeLocals.has(expr.text) || NON_ENTITY_NAMES.has(expr.text);
  }

  // Numeric/string/boolean literals — primitives, never entity data.
  if (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }

  // Empty array literal — no entity data at all.
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) return true;

  // Binary expressions (`offset + redacted.length < total`): safe iff both operands are.
  // The `.length` property access on a safe local is itself safe via the PropertyAccess
  // rule below.
  if (ts.isBinaryExpression(expr)) {
    return (
      isSafeExpression(expr.left, safeLocals, methodNames) &&
      isSafeExpression(expr.right, safeLocals, methodNames)
    );
  }

  // Property access on a safe source (`redacted.length`, `opts?.limit`) — safe iff the
  // receiver is safe. The property NAME is never itself an entity reference.
  if (ts.isPropertyAccessExpression(expr)) {
    return isSafeExpression(expr.expression, safeLocals, methodNames);
  }

  // Ternary: both arms must be safe (`status ? all.filter(...) : all`).
  if (ts.isConditionalExpression(expr)) {
    return (
      isSafeExpression(expr.whenTrue, safeLocals, methodNames) &&
      isSafeExpression(expr.whenFalse, safeLocals, methodNames)
    );
  }

  // `.filter(...)`, `.map(...)`, `.slice(...)`, `.flatMap(...)` chains on a safe source.
  // These produce a new array whose elements are a subset/transform of the safe source's,
  // so the result inherits the source's redaction state. We require the receiver itself to
  // be safe — `.map(toDomain)` on a raw row would correctly NOT be recognized (the row is
  // unsafe), and crucially the callback's return is NOT trusted: it can only re-shape the
  // already-redacted element, never re-read a raw row's dmSecret.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ['filter', 'map', 'slice', 'flatMap'].includes(expr.expression.name.text)
  ) {
    return isSafeExpression(expr.expression.expression, safeLocals, methodNames);
  }

  // Redaction-preserving wrapper (e.g. `buildCursorListPage(items, ...)`): safe iff its
  // first argument is safe, since it only repackages that already-redacted array.
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    REDACTION_PRESERVING_WRAPPERS.has(expr.expression.text) &&
    expr.arguments.length > 0
  ) {
    return isSafeExpression(expr.arguments[0], safeLocals, methodNames);
  }

  return false;
}

/**
 * Whether a return expression is safe. Wrappers (`{ items: redacted }`, `{ ...faction, members }`,
 * `{ since, quests: changed }`) are safe when every VALUE they carry is itself a safe
 * expression — so a wrapper built from any raw row fails (`{ ...rawRow }`), while one built
 * entirely from already-redacted locals and primitives passes.
 */
function isSafeReturn(
  expr: ts.Expression | undefined,
  safeLocals: Set<string>,
  methodNames: Set<string>,
): boolean {
  if (!expr) return true; // bare `return;`
  if (isSafeExpression(expr, safeLocals, methodNames)) return true;

  // Object literal: every property value (and every spread source) must be safe.
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.every((prop) => {
      if (ts.isSpreadAssignment(prop)) {
        return isSafeExpression(prop.expression, safeLocals, methodNames);
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        return isSafeExpression(prop.name, safeLocals, methodNames);
      }
      if (ts.isPropertyAssignment(prop)) {
        return isSafeExpression(prop.initializer, safeLocals, methodNames);
      }
      return false; // method/getter/setter in a returned literal — not a recognized safe shape
    });
  }

  // Array literal: every element must be safe.
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.every((el) => isSafeExpression(el, safeLocals, methodNames));
  }

  return false;
}

/**
 * Whether a declared return-type string "carries" any of the tracked dmSecret
 * domain types. Matches the type as a whole word so `Quest` does not match
 * `QuestObjective` or `QuestListObjective`. Covers bare, array, and the page/wrapper
 * shapes these services use (`{ items: X[] }`, `{ quests: Quest[] }`).
 */
function returnTypeCarries(typeText: string, domainTypes: string[]): boolean {
  for (const dt of domainTypes) {
    const re = new RegExp(`\\b${dt}\\b`);
    if (re.test(typeText)) return true;
  }
  return false;
}

/**
 * Union of every redaction-covered method name across ALL audited services. A cross-service
 * delegation (e.g. `this.npcs.listForFaction(...)`) is recognized as a safe source when its
 * method name appears here — i.e. it is a method that THIS guard has already proven redacts
 * in its own service. This keeps the guard honest: only delegations to proven-redacting
 * methods count, never an arbitrary `this.x.y(...)`.
 */
const GLOBAL_COVERED_METHODS = new Set(SERVICES.flatMap((s) => s.knownMethods));

function loadRedactionMethods(spec: ServiceSpec): MethodInfo[] {
  const src = fs.readFileSync(spec.servicePath, 'utf8');
  const sourceFile = ts.createSourceFile(spec.servicePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const results: MethodInfo[] = [];
  function visitClass(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name?.text === spec.className) {
      // First pass: collect method names whose return type carries a dmSecret domain
      // type — these are the "covered" methods that an intra-service delegation can target.
      const coveredMethodNames = new Set<string>();
      const candidates: Array<{ member: ts.MethodDeclaration; typeText: string }> = [];
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.type || !member.name) continue;
        const isPrivate = member.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
        );
        if (isPrivate) continue;
        const typeText = member.type.getText(sourceFile);
        if (returnTypeCarries(typeText, spec.domainTypes)) {
          coveredMethodNames.add(member.name.getText(sourceFile));
          candidates.push({ member, typeText });
        }
      }
      // Delegations are recognized against BOTH this service's covered methods AND every
      // other audited service's covered methods (for cross-service calls like
      // `this.npcs.listForFaction(...)`).
      const delegationTargets = new Set<string>([...coveredMethodNames, ...GLOBAL_COVERED_METHODS]);

      for (const { member, typeText } of candidates) {
        const name = member.name.getText(sourceFile);
        // Safe-locals analysis for THIS method, seeded with the covered-method set so
        // `const all = this.listForCampaign(...)` is recognized as a safe source.
        const safeLocals = new Set<string>();
        collectSafeLocals(member, delegationTargets, safeLocals);

        const returnStatements = collectOwnReturns(member);
        const returns = returnStatements.map((r) => {
          const safe = isSafeReturn(r.expression, safeLocals, delegationTargets);
          return {
            text: r.expression ? r.expression.getText(sourceFile) : '<empty return>',
            safe,
            reason: safe ? null : 'neither redacts, delegates, nor is built from a safe local',
          };
        });
        results.push({ name, typeText, returns });
      }
    }
    ts.forEachChild(node, visitClass);
  }
  visitClass(sourceFile);
  return results;
}

describe('dmSecret redaction coverage across all dmSecret-bearing services (issue #1745)', () => {
  for (const spec of SERVICES) {
    describe(`${spec.className} — every dmSecret-bearing return redacts or delegates`, () => {
      const methods = loadRedactionMethods(spec);
      const methodNames = new Set(methods.map((m) => m.name));

      it('found the full known set of dmSecret-bearing methods (fails if the enumeration drifts)', () => {
        // Pinned so a change here is a deliberate, reviewed decision (rename, removal,
        // or a genuinely new method) rather than the parser silently matching nothing
        // (or matching too much). If this fails because a new method was ADDED, that
        // is the point: come add its return statement to the redacting/delegating
        // pattern below, add its name to `knownMethods`, and both this assertion and
        // the per-method one below will pass again.
        expect([...methodNames].sort()).toEqual([...spec.knownMethods].sort());
      });

      it.each(methods.map((m) => [m.name, m] as const))(
        '%s: every return redacts, delegates, or is built from an already-redacted local',
        (_name, method) => {
          expect(method.returns.length).toBeGreaterThan(0);
          for (const ret of method.returns) {
            if (!ret.safe) {
              throw new Error(
                `${spec.className}.${method.name} has a return statement that ${ret.reason}: ` +
                  `\`return ${ret.text}\`. Wrap it in redactSecret(...)/redactSecrets(...) ` +
                  '(or build it from an already-redacted local / delegate to a covered method) ' +
                  '— see issues #1489 and #1745.',
              );
            }
          }
        },
      );
    });
  }
});
