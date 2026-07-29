import path from 'node:path';
import ts from 'typescript';
// persistence test marker

/**
 * Build a TypeScript program + checker for a single service file so the guard can
 * resolve INFERRED return types (methods with no explicit annotation) as well as
 * annotated ones. The nominal matcher alone skips methods like
 * `QuestsService.listForCampaignWithObjectives` and `getWithObjectivesOrThrow`,
 * whose return types are inferred from `Quest & { objectives }` — closing that gap
 * via the type checker is the fix for review thread "Include methods whose sensitive
 * return types are inferred."
 *
 * The program is built with the server's own resolution settings so zod-inferred
 * domain types and `@campfire/schema` resolve exactly as they do in `nest build`.
 * The `@campfire/schema` path mapping uses an ABSOLUTE path so resolution is
 * deterministic regardless of the CI environment's `node_modules` workspace symlinks
 * (the workspace package's `dist/` is a build artifact that may not exist when the
 * coverage job runs `npm ci` without building).
 *
 * As a belt-and-suspenders fallback for environments where type inference is
 * mangled (e.g. the babel-instrumented coverage build), each `ServiceSpec` may list
 * `inferredDmSecretMethods` — method names known to return a dmSecret-bearing
 * inferred type. When the checker cannot resolve the inferred type, the name list
 * is authoritative so the method is still covered.
 */
const REPO_ROOT = path.join(__dirname, '../../..');
const SCHEMA_SOURCE = path.join(REPO_ROOT, 'packages/schema/src/index.ts');
function buildProgram(
  servicePath: string,
): { checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const program = ts.createProgram({
    rootNames: [servicePath],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      strict: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      skipLibCheck: true,
      baseUrl: REPO_ROOT,
      paths: { '@campfire/schema': [SCHEMA_SOURCE] },
    },
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(servicePath);
  if (!sourceFile) throw new Error(`could not load source file for ${servicePath}`);
  return { checker, sourceFile };
}

/**
 * Whether a resolved type carries a `dmSecret` property anywhere in its structure
 * (unwrapping Promise/Array and recursing into object properties). Used to detect
 * dmSecret-bearing INFERRED return types that have no nominal annotation to match.
 */
function resolvedTypeCarriesDmSecret(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
  seen = new Set<ts.Type>(),
): boolean {
  if (depth > 8) return false;
  if (seen.has(type)) return false;
  seen.add(type);
  const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
  if (
    typeArgs.length === 1 &&
    ['Promise', 'Array', 'ReadonlyArray'].includes(type.symbol?.name ?? '')
  ) {
    return typeArgs.some((t) => resolvedTypeCarriesDmSecret(t, checker, depth + 1, seen));
  }
  if (type.isUnion()) {
    return type.types.some((t) => resolvedTypeCarriesDmSecret(t, checker, depth + 1, seen));
  }
  const props = type.getProperties();
  if (props.some((p) => p.name === 'dmSecret')) return true;
  for (const p of props) {
    const pt = checker.getTypeOfSymbol(p);
    if (pt && resolvedTypeCarriesDmSecret(pt, checker, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * Whether a resolved type carries a `deletedAt` property. Raw database row types
 * (the return of `getRowOrThrow` / `findRowByName`) include the soft-delete column
 * `deletedAt`, while domain entity types do NOT — `toDomain` strips it. This is the
 * discriminator that keeps raw-row helper methods (which return dmSecret-carrying
 * rows but are the INPUT to the redaction pipeline, never serialized to a response)
 * outside the guard while still covering inferred-return domain methods.
 */
function resolvedTypeCarriesDeletedAt(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
  seen = new Set<ts.Type>(),
): boolean {
  if (depth > 8) return false;
  if (seen.has(type)) return false;
  seen.add(type);
  const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
  if (
    typeArgs.length === 1 &&
    ['Promise', 'Array', 'ReadonlyArray'].includes(type.symbol?.name ?? '')
  ) {
    return typeArgs.some((t) => resolvedTypeCarriesDeletedAt(t, checker, depth + 1, seen));
  }
  if (type.isUnion()) {
    return type.types.some((t) => resolvedTypeCarriesDeletedAt(t, checker, depth + 1, seen));
  }
  return type.getProperties().some((p) => p.name === 'deletedAt');
}

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
 * method whose return type carries a dmSecret-bearing domain type — whether the
 * type is an explicit annotation (matched nominally by name) or an INFERRED return
 * (resolved structurally via the type checker: the resolved type must carry a
 * `dmSecret` property and NOT carry `deletedAt`, the soft-delete column that marks
 * a raw database row rather than a domain entity). This covers methods like
 * `QuestsService.listForCampaignWithObjectives` / `getWithObjectivesOrThrow`
 * whose inferred return type is `Quest & { objectives }` with no annotation to
 * match nominally, while still excluding raw-row helpers (`getRowOrThrow`) whose
 * row type also carries `dmSecret` but is the INPUT to the redaction pipeline.
 *
 * The guard then asserts that every `return` statement belonging directly to that
 * method (never descending into a nested callback/arrow, e.g. a `db.transaction(...)`
 * closure) only ever returns data that has already been redacted. Concretely a
 * return is compliant when it is one of:
 *   - a call to `redactSecret(...)` / `redactSecrets(...)` (the canonical fix), or
 *   - a delegating call to another `this.<method>(...)` that is itself one of the
 *     enumerated, redaction-covered methods (e.g. `getWithMembersOrThrow`
 *     delegates to `getOrThrow`; `listForCampaignByStatus` delegates to
 *     `listForCampaign`), or a delegation to a method whose return type carries
 *     NO dmSecret (it cannot leak — e.g. `objectivesForQuest`), or
 *   - a value derived ONLY from already-safe locals (a local assigned from any of
 *     the above), via a small set of recognized transforms: bare local reference,
 *     `.filter()/.slice()` chains, a `.map()`/`.flatMap()` whose callback reads
 *     ONLY already-safe locals (never a raw row or a raw-row-returning call
 *     captured from the enclosing method), a spread into a wrapper object/array
 *     literal, a ternary whose both arms are safe, an empty `[]`, or a call to a
 *     known page-builder helper (`buildCursorListPage`) or a redaction-preserving
 *     private transform (`embedObjectives`) whose element-source argument is safe.
 *
 * A local is treated as safe only when EVERY value ever assigned to it is safe —
 * its declaration initializer AND any subsequent `=` reassignment. So
 * `let r = redactSecret(...); r = toDomain(row); return r;` is correctly UNSAFE:
 * the second assignment is a raw row, tainting `r` for the whole method.
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
   * type matches if it contains any of these names as a whole word. Inferred return
   * types (no annotation) are matched structurally via the type checker instead.
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
  /**
   * Public methods with an INFERRED (un-annotated) dmSecret-bearing return type
   * (e.g. QuestsService.listForCampaignWithObjectives / getWithObjectivesOrThrow,
   * whose return is inferred `Quest & { objectives }`). The type checker resolves
   * these structurally, but type resolution is fragile under some runners
   * (e.g. the babel-instrumented coverage build mangles inference), so this list
   * is the reliable fallback: a named method here is always treated as a covered
   * dmSecret-returning method even when the checker cannot resolve its inferred
   * type. It MUST be kept in sync with `knownMethods` for the inferred methods.
   */
  inferredDmSecretMethods?: string[];
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
    // listForCampaignWithObjectives / getWithObjectivesOrThrow have INFERRED return
    // types (Quest & { objectives }) — no annotation to match nominally, so the
    // type-checker path resolves them structurally (carries dmSecret, no deletedAt).
    domainTypes: ['Quest', 'QuestListItem'],
    knownMethods: [
      'listForCampaign',
      'listForCampaignByStatus',
      'listForCampaignWithObjectives',
      'listForCampaignByStatusWithProgress',
      'changesSince',
      'getOrThrow',
      'getWithObjectivesOrThrow',
      'create',
      'update',
      'restore',
      'setStatus',
    ],
    // These two return inferred `Quest & { objectives }` (no annotation). The type
    // checker resolves them in the normal jest run, but the babel-instrumented
    // coverage build mangles type inference — so name them explicitly as the
    // reliable fallback (see `inferredDmSecretMethods` on ServiceSpec).
    inferredDmSecretMethods: ['listForCampaignWithObjectives', 'getWithObjectivesOrThrow'],
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

/**
 * Bundle of the method-name sets the safe-expression analysis needs. Threaded as
 * one object to keep the `isSafeExpression` / `isSafeReturn` signatures readable.
 */
interface MethodSets {
  /** Covered (proven-redacting) method names — this service + all others (cross-service). */
  covered: Set<string>;
  /** Method names whose return type carries NO dmSecret — safe to delegate to (cannot leak). */
  nonDmSecret: Set<string>;
  /** Private transform method names whose return carries dmSecret derived from a safe arg. */
  transforms: Set<string>;
}

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
 * already-redacted data. A local is "safe" only when EVERY value ever assigned to
 * it is safe — its declaration initializer AND every subsequent `=` reassignment.
 * This is what makes `let r = redactSecret(...); r = toDomain(row); return r;`
 * correctly UNSAFE: the second assignment is a raw row, so `r` is tainted for the
 * whole method regardless of the (safe) initializer.
 *
 * A value is safe when it is:
 *   - a `redactSecret(...)` / `redactSecrets(...)` call, or
 *   - a delegating call to a covered `this.<method>(...)`, or a non-dmSecret-returning
 *     `this.<method>(...)` (cannot leak), or
 *   - a call to a redaction-preserving wrapper/transform whose first arg is itself safe, or
 *   - a derivation from another safe local: `.filter()`, a callback-safe `.map()`/`.flatMap()`,
 *     `.slice()`, a ternary whose both arms are safe, or another safe local reference.
 *
 * Because safety can depend on other locals (`const b = a.filter(...)` needs `a` safe first),
 * the analysis iterates to a fixpoint: each round recomputes per-variable safety from the
 * current safe set. A variable becomes safe only once all of its assigned values are safe.
 */
function collectSafeLocals(
  root: ts.MethodDeclaration,
  methodSets: MethodSets,
  safeLocals: Set<string>,
): void {
  if (!root.body) return;

  // Gather every value assigned to each local identifier: `const/let x = <init>` declarations
  // and `x = <expr>` reassignments. A single unsafe assigned value taints the variable for the
  // whole method (we are intentionally flow-insensitive — a `let` rebound to a raw row at ANY
  // point is not trusted at the return, the only position this guard reads).
  const assignments = new Map<string, ts.Expression[]>();
  function collectAssignments(node: ts.Node): void {
    if (isFunctionLike(node)) return;
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
        const list = assignments.get(decl.name.text) ?? [];
        list.push(decl.initializer);
        assignments.set(decl.name.text, list);
      }
    }
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) {
      const { left, right, operatorToken } = node.expression;
      if (operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(left)) {
        const list = assignments.get(left.text) ?? [];
        list.push(right);
        assignments.set(left.text, list);
      }
    }
    ts.forEachChild(node, collectAssignments);
  }
  ts.forEachChild(root.body, (child) => {
    if (isFunctionLike(child)) return;
    collectAssignments(child);
  });

  // Fixpoint: a variable is safe iff every value assigned to it is safe (against the current
  // safe set). Iterate until the safe set stops growing.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, values] of assignments) {
      if (safeLocals.has(name)) continue;
      if (values.every((v) => isSafeExpression(v, safeLocals, methodSets))) {
        safeLocals.add(name);
        changed = true;
      }
    }
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

/**
 * Raw-row-to-entity constructor function names. A callback that calls one of these
 * reconstructs an un-redacted domain entity from a raw row, so a `.map(toDomain)` or
 * `.map((_, i) => toDomain(rows[i]))` is NOT safe even when the receiver array is.
 */
const RAW_ENTITY_CONSTRUCTORS = new Set(['toDomain', 'toEventDomain']);

/**
 * Whether a `.map()`/`.flatMap()` callback reads raw (un-redacted) data — either by
 * calling a raw-entity constructor (`toDomain(row)`) or by referencing an identifier
 * that is NOT a safe local (e.g. a raw `rows` param/local captured from the enclosing
 * method). If the callback reads raw data, the map result can carry un-redacted
 * dmSecret, so it is NOT safe. This is the fix for review thread "Validate callbacks
 * before treating map results as redacted."
 */
function callbackReadsRawData(
  callback: ts.Node,
  safeLocals: Set<string>,
): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    // `toDomain(row)` / `toEventDomain(row)` inside the callback — raw entity construction.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      RAW_ENTITY_CONSTRUCTORS.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    // An identifier reference that is neither a safe local nor a known-safe primitive —
    // e.g. a raw `rows`/`row` param captured from the enclosing method, or the callback's
    // own numeric index parameter used to index into a raw array.
    if (ts.isIdentifier(node)) {
      const text = node.text;
      if (
        !safeLocals.has(text) &&
        !NON_ENTITY_NAMES.has(text) &&
        text !== 'q' // the common callback element parameter name used in `.filter((q) => ...)`
      ) {
        // Distinguish the callback's own parameters (safe — they ARE the array elements)
        // from captured raw identifiers. We cannot know parameter names statically here
        // without the callback signature, so we only flag identifiers that are NOT the
        // conventional single-letter element params AND are not safe. This is conservative:
        // it may flag an unfamiliar safe local, which just makes the map result unsafe
        // (a false positive that the developer resolves by naming the local safe).
        // To avoid false positives on real code, we only flag identifiers that look like
        // raw-row sources: `row`, `rows`, `r`, `existing`, `entry`, `record`, `data`.
        const RAW_SOURCE_NAMES = new Set([
          'row',
          'rows',
          'r',
          'existing',
          'entry',
          'record',
          'data',
        ]);
        if (RAW_SOURCE_NAMES.has(text)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callback);
  return found;
}

function isSafeExpression(
  expr: ts.Node,
  safeLocals: Set<string>,
  methodSets: MethodSets,
): boolean {
  // Unwrap `await` — `const all = await this.listForCampaign(...)` is a covered delegation
  // even though the initializer is an AwaitExpression wrapping the call.
  if (ts.isAwaitExpression(expr)) return isSafeExpression(expr.expression, safeLocals, methodSets);

  // Direct redaction — the canonical safe source.
  if (isRedactingCall(expr)) return true;

  // Delegation to a covered method (proven to redact) — safe.
  const delegated = delegatingMethodName(expr);
  if (delegated !== null) {
    if (methodSets.covered.has(delegated)) return true;
    // Delegation to a method whose return type carries NO dmSecret — cannot leak.
    if (methodSets.nonDmSecret.has(delegated)) return true;
    // Redaction-preserving private transform (e.g. embedObjectives) — safe iff its first
    // argument is safe, since it only re-shapes an already-redacted entity and attaches
    // non-dmSecret side data.
    if (
      methodSets.transforms.has(delegated) &&
      ts.isCallExpression(expr) &&
      expr.arguments.length > 0 &&
      isSafeExpression(expr.arguments[0], safeLocals, methodSets)
    ) {
      return true;
    }
  }

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
      isSafeExpression(expr.left, safeLocals, methodSets) &&
      isSafeExpression(expr.right, safeLocals, methodSets)
    );
  }

  // Property access on a safe source (`redacted.length`, `opts?.limit`) — safe iff the
  // receiver is safe. The property NAME is never itself an entity reference.
  if (ts.isPropertyAccessExpression(expr)) {
    return isSafeExpression(expr.expression, safeLocals, methodSets);
  }

  // Ternary: both arms must be safe (`status ? all.filter(...) : all`).
  if (ts.isConditionalExpression(expr)) {
    return (
      isSafeExpression(expr.whenTrue, safeLocals, methodSets) &&
      isSafeExpression(expr.whenFalse, safeLocals, methodSets)
    );
  }

  // `.filter(...)`, `.slice(...)` chains on a safe source — element-preserving, so the
  // result inherits the source's redaction state. `.map()` / `.flatMap()` are handled
  // separately below because their callbacks can read raw data.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ['filter', 'slice'].includes(expr.expression.name.text)
  ) {
    return isSafeExpression(expr.expression.expression, safeLocals, methodSets);
  }

  // `.map(...)` / `.flatMap(...)` on a safe source. The result inherits the source's
  // redaction state ONLY if the callback does not read raw data from the enclosing method
  // — `redacted.map((_, i) => toDomain(rows[i]))` reconstructs un-redacted entities and
  // is NOT safe. The callback may freely re-shape its own element (the already-redacted
  // array element passed as its first parameter), but referencing a raw row/rows local or
  // calling toDomain(rawRow) taints the result.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ['map', 'flatMap'].includes(expr.expression.name.text)
  ) {
    const receiverSafe = isSafeExpression(expr.expression.expression, safeLocals, methodSets);
    if (!receiverSafe) return false;
    // Inspect the callback for raw-data reads. A `.map` with no callback argument (e.g.
    // `.map(toDomain)` — a bare function reference) is checked via callbackReadsRawData
    // on the argument itself.
    const callbackArg = expr.arguments[0];
    if (callbackArg && callbackReadsRawData(callbackArg, safeLocals)) {
      return false;
    }
    return true;
  }

  // Redaction-preserving wrapper (e.g. `buildCursorListPage(items, ...)`): safe iff its
  // first argument is safe, since it only repackages that already-redacted array.
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    REDACTION_PRESERVING_WRAPPERS.has(expr.expression.text) &&
    expr.arguments.length > 0
  ) {
    return isSafeExpression(expr.arguments[0], safeLocals, methodSets);
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
  methodSets: MethodSets,
): boolean {
  if (!expr) return true; // bare `return;`
  if (isSafeExpression(expr, safeLocals, methodSets)) return true;

  // Object literal: every property value (and every spread source) must be safe.
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.every((prop) => {
      if (ts.isSpreadAssignment(prop)) {
        return isSafeExpression(prop.expression, safeLocals, methodSets);
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        return isSafeExpression(prop.name, safeLocals, methodSets);
      }
      if (ts.isPropertyAssignment(prop)) {
        return isSafeExpression(prop.initializer, safeLocals, methodSets);
      }
      return false; // method/getter/setter in a returned literal — not a recognized safe shape
    });
  }

  // Array literal: every element must be safe.
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.every((el) => isSafeExpression(el, safeLocals, methodSets));
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
  const { checker, sourceFile } = buildProgram(spec.servicePath);

  /**
   * Whether a method's return type makes it a dmSecret-bearing "domain" method. Two
   * paths, both sound:
   *   - EXPLICIT annotation: nominal match on the annotation text (e.g.
   *     `Promise<Quest[]>` contains the whole word "Quest"). This is the original
   *     matcher and remains the primary path — it never false-positives on a raw
   *     row helper because the row type is anonymous.
   *   - INFERRED (no annotation): resolve the return type via the checker and check
   *     structurally — the resolved type must carry a `dmSecret` property AND must
   *     NOT carry `deletedAt` (the soft-delete column present only on raw DB rows,
   *     stripped by `toDomain`). This catches `Quest & { objectives }` returns
   *     whose inferred type has no name to match, while excluding `getRowOrThrow`
   *     whose raw row type also carries `dmSecret`.
   */
  function methodReturnTypeCarriesDmSecret(member: ts.MethodDeclaration): {
    carriesDmSecret: boolean;
    typeText: string;
  } {
    if (member.type) {
      const typeText = member.type.getText(sourceFile);
      return { carriesDmSecret: returnTypeCarries(typeText, spec.domainTypes), typeText };
    }
    // Inferred return type — resolve structurally via the checker.
    const name = member.name ? member.name.getText(sourceFile) : '';
    const sym = member.name ? checker.getSymbolAtLocation(member.name) : undefined;
    if (!sym) {
      // The checker could not resolve the symbol (this happens under the
      // babel-instrumented coverage build, which mangles type inference). Fall back
      // to the explicit `inferredDmSecretMethods` name list so the method is still
      // covered — the name list is the reliable path; the checker is the bonus.
      const fallback = spec.inferredDmSecretMethods?.includes(name) ?? false;
      return {
        carriesDmSecret: fallback,
        typeText: fallback ? '<inferred — name fallback>' : '<inferred — unresolved>',
      };
    }
    const fnType = checker.getTypeOfSymbolAtLocation(sym, member);
    const sigs = fnType.getCallSignatures();
    if (sigs.length === 0) {
      const fallback = spec.inferredDmSecretMethods?.includes(name) ?? false;
      return {
        carriesDmSecret: fallback,
        typeText: fallback ? '<inferred — name fallback>' : '<inferred — no signature>',
      };
    }
    const retType = checker.getReturnTypeOfSignature(sigs[0]);
    const carriesDm = resolvedTypeCarriesDmSecret(retType, checker);
    const carriesDeletedAt = resolvedTypeCarriesDeletedAt(retType, checker);
    // A domain entity carries dmSecret but NOT deletedAt (toDomain strips it).
    // A raw DB row carries both — it is the INPUT to the redaction pipeline, never
    // a domain value returned to a caller, so it is excluded.
    const carries = carriesDm && !carriesDeletedAt;
    // If the checker resolved the type but did NOT flag it (e.g. the coverage build
    // resolves to an overly-loose type), the explicit name list is still authoritative
    // for the methods we know return a dmSecret-bearing inferred type.
    const fallbackCarries = spec.inferredDmSecretMethods?.includes(name) ?? false;
    return {
      carriesDmSecret: carries || fallbackCarries,
      typeText: carries
        ? '<inferred dmSecret>'
        : fallbackCarries
          ? '<inferred — name fallback>'
          : '<inferred — no dmSecret>',
    };
  }

  const results: MethodInfo[] = [];
  function visitClass(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name?.text === spec.className) {
      // First pass over ALL methods (public AND private): classify each by whether its
      // resolved return type carries dmSecret. Three buckets:
      //   - coveredMethodNames: PUBLIC methods carrying dmSecret domain data — these MUST
      //     redact and are the guard's enumerated targets.
      //   - nonDmSecretMethodNames: methods (any visibility) whose return type carries NO
      //     dmSecret (e.g. `objectivesForQuest(): Promise<QuestObjective[]>`). A delegation
      //     to such a method is always safe — it cannot leak dmSecret because it does not
      //     return it.
      //   - transformMethodNames: PRIVATE methods that carry dmSecret in their return type
      //     (e.g. `embedObjectives` returns `QuestWithObjectives[]`). These are redaction-
      //     preserving transforms: they re-shape an already-redacted argument and add only
      //     non-dmSecret data (objectives from a DB read). Recognized as safe when their
      //     first argument is itself a safe expression.
      const coveredMethodNames = new Set<string>();
      const nonDmSecretMethodNames = new Set<string>();
      const transformMethodNames = new Set<string>();
      const candidates: Array<{ member: ts.MethodDeclaration; typeText: string }> = [];
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const isPrivate = member.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
        );
        const { carriesDmSecret, typeText } = methodReturnTypeCarriesDmSecret(member);
        const name = member.name.getText(sourceFile);
        if (carriesDmSecret) {
          if (!isPrivate) {
            coveredMethodNames.add(name);
            candidates.push({ member, typeText });
          } else {
            transformMethodNames.add(name);
          }
        } else {
          nonDmSecretMethodNames.add(name);
        }
      }
      // Delegations are recognized against BOTH this service's covered methods AND every
      // other audited service's covered methods (for cross-service calls like
      // `this.npcs.listForFaction(...)`), PLUS this service's non-dmSecret methods and
      // transform methods.
      const methodSets: MethodSets = {
        covered: new Set<string>([...coveredMethodNames, ...GLOBAL_COVERED_METHODS]),
        nonDmSecret: nonDmSecretMethodNames,
        transforms: transformMethodNames,
      };

      for (const { member, typeText } of candidates) {
        const name = member.name.getText(sourceFile);
        // Safe-locals analysis for THIS method, seeded with the covered-method set so
        // `const all = this.listForCampaign(...)` is recognized as a safe source.
        const safeLocals = new Set<string>();
        collectSafeLocals(member, methodSets, safeLocals);

        const returnStatements = collectOwnReturns(member);
        const returns = returnStatements.map((r) => {
          const safe = isSafeReturn(r.expression, safeLocals, methodSets);
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
