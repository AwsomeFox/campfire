# Campfire agent guide

## Product and scope

Campfire is a self-hosted, AI-operable tabletop RPG campaign tracker. Preserve
its core product constraints:

- one Docker image, one SQLite-backed volume, and no required external services;
- server-enforced authorization and secrecy rather than client-side hiding;
- the same domain behavior through REST and MCP;
- AI world changes routed through the proposal flow unless the caller has direct
  authority;
- small, maintainable features that solve documented user needs.

Do not add speculative features, generic frameworks, extension points, or
configuration for hypothetical future requirements. File separate issues for
useful out-of-scope work instead of expanding the current change.

## Repository map

- `packages/schema`: Zod domain contracts and inferred types. Treat this as the
  source of truth for shared shapes.
- `apps/server`: NestJS REST API, MCP surface, SQLite/Drizzle persistence,
  authorization, secrecy, audit, and proposal enforcement.
- `apps/web`: React/Vite UI and Playwright tests.
- `design`: approved design references.
- `scripts`: generated-surface and repository consistency checks.

Read the nearest README and any more-specific `AGENTS.md` before editing a
subtree.

## Architectural invariants

- Do not redefine shared domain shapes in the server or web app; update
  `@campfire/schema`.
- Keep REST and MCP behavior aligned when changing a shared capability.
- Enforce campaign membership, role caps, hidden entities, unexplored locations,
  private notes, and `dmSecret` redaction on the server.
- Server-admin status does not imply campaign membership. PAT scope and
  `adminEnabled` caps remain authoritative.
- Preserve the propose-then-approve path and archived-campaign write protection.
- Audit every domain write with the real actor or token identity.
- Add database changes through the established migration/bootstrap mechanisms
  and preserve upgrade compatibility.
- Keep public APIs and module boundaries as narrow as practical.

## Commands

Prerequisites are npm workspaces and a Node that reports
`process.versions.napi >= 10` — Node 22.14+, 23.6+, or 24+. The real constraint
is the Node-API level, not a single floor, which is why `engines.node` is the
disjoint `^22.14 || >=23.6`: Node added Node-API 10 to the 22 line in 22.14.0
but to the 23 line only in 23.6.0, so a plain `>=22.14` would wave 23.0–23.5
through with the same broken behaviour.

Below that level the failure is silent, not a clean error: better-sqlite3 13.x
ships prebuilt Node-API 10 binaries and has no install script, so `npm ci`
succeeds, and on Node 22.13.1 `require('better-sqlite3')` also succeeds — the
process then dies with SIGSEGV (exit 139, no exception, no message) on the first
`new Database()`.

`build-test (22.x)` pins exactly 22.14.0 so the floor is tested rather than
asserted, and runs `npm run check:native-addons` there. That check exists
because building proves nothing here: `npm run build` is `tsc` plus a Vite
bundle and loads no native binding, so it stays green on a runtime where the
addons segfault. Bump the pin and `engines.node` together whenever a native
dependency raises the real minimum.

- Install: `npm ci`
- Build: `npm run build`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Server tests: `npm run test -w apps/server`
- Server coverage: `npm run test:cov`
- Web unit tests: `npm run test:unit:web`
- Browser E2E: `npm run test:e2e`
- Full local regression: `npm run test:all`
- Consistency checks:
  `npm run check:version`, `npm run check:mcp-catalog`,
  `npm run check:i18n`, `npm run check:native-addons`

Run the smallest relevant checks while iterating. Run all checks affected by the
final diff before handoff. GitHub's aggregate required check is named `ci`.
Non-required browser jobs still matter when the branch caused their failure.

Every test tier above is wrapped in `scripts/with-test-lock.sh`, which holds a
machine-wide lock (`/tmp/campfire-test.lock`) for the duration of the run. Each
tier sizes its worker pool against the whole machine — jest asks for 50% of the
cores at a ~1GB-per-worker recycle threshold, vitest spawns its own pool, and
the browser tier boots a Nest server plus Chromium on the fixed port 8123 with
`reuseExistingServer`. Several agent sessions in separate worktrees running
tests at once therefore exhaust host memory, and two concurrent browser runs
silently share one seeded backend. The lock makes those runs queue instead; it
waits up to an hour and is a no-op when `CI` is set. It is an `flock(2)` held by
the test process itself, so the kernel releases it the moment that process exits
and a crashed or killed run leaves nothing to clean up. The one gap, documented
at the top of the script, is that jest and Playwright workers do not inherit the
descriptor, so a worker that outlives an abnormally killed runner no longer
holds the lock. Invoke tests through the npm scripts, not by calling `jest`, `vitest`,
or `playwright` directly — a direct call bypasses the lock. `test:watch` and
`test:e2e:ui` stay unlocked deliberately, because a long-lived interactive
session would hold the lock indefinitely and starve every other session; UI mode
therefore serves its own backend on port 8125 rather than sharing 8123 with a
locked `test:e2e` run. `JEST_MAX_WORKERS`,
`VITEST_MAX_WORKERS`, and `CAMPFIRE_TEST_HEAP_MB` override the per-run caps;
`CAMPFIRE_TEST_LOCK_HELD=1` skips locking entirely.

`npm run typecheck` covers `apps/server/test/**` and the `apps/web` Playwright
tree, and the `lint` job runs it — a broken service constructor/method
signature fails there in under two minutes, not ~20 minutes later in
`coverage` (issue #1527/#1535). Before that landed, `apps/server`'s typecheck
covered `src/**` only, so a test-only compile error surfaced solely in
`coverage`, reported as `N suites failed, 0 tests failed` — easy to misread as
a flaky or threshold-miss failure rather than a compile error. If you ever see
that shape locally with an out-of-date checkout, rerun `npm run typecheck`
first.

When hand-rolling a test double for a service dependency, type it against
`Pick<RealService, 'methodsActuallyUsed'>` instead of a blind
`{...} as unknown as RealService`, which performs no shape-checking at all.
Two strengths of this, in increasing order of guarantee — pick based on how
the dependency is consumed:

- **Double-side only** (the consumer still declares the dependency as the
  concrete class, so a cast to it is unavoidable): the double is checked
  against the `Pick` type, then cast — e.g.
  `const x: Pick<AuditService, 'log'> = {...}; return x as unknown as
  AuditService;`. This catches a double that is missing or misspells one of
  the *listed* methods. It does **not** catch production code starting to
  call an *additional* method the double never had — the `Pick` list itself
  isn't forced to grow, and the final cast lets an incomplete double through
  regardless (this is the #1426 case in its full generality: the review
  discussion on issue #1527 traced through why the double-side pattern alone
  doesn't close it).
- **Consumer-side narrowing** (stronger, when the consumer's own declared
  dependency type can be narrowed): change the *constructor parameter* (or
  plain function parameter) from the concrete class to
  `Pick<RealService, 'methodsActuallyUsed'>` directly. Because a `Pick` is a
  plain structural type, not a class with a private-field brand, a double
  satisfying it can be assigned with **no cast at all**, checked both ways —
  a double missing a listed method fails where it's declared, AND a new
  method call inside the consumer that falls outside the `Pick` list fails to
  compile in the consumer's own source, forcing the list to widen (which then
  breaks every double until it supplies the new method too). For a NestJS
  constructor parameter this needs an explicit `@Inject(RealService)` beside
  the narrowed type, since the erased `Pick<...>` carries no
  `design:paramtypes` metadata for Nest to resolve the token from — see
  `export.controller.ts`'s constructor and its double in
  `export-controller-streaming.spec.ts`. For a plain (non-DI) function, no
  `@Inject` is needed — see `audit-best-effort.ts` and
  `audit-best-effort.spec.ts`.

Prefer consumer-side narrowing when the cost is small (one constructor, or a
plain function like `auditBestEffort`); fall back to double-side-only typing
when narrowing the consumer isn't practical. Either way, type the double with
an annotation (`const x: Pick<...> = {...}`) — a type *assertion*
(`{...} as Pick<...>`) skips the excess/missing-property check the pattern
exists for. This is a per-double convention, not a lint rule: most existing
doubles in `apps/server/test/**` have not been converted.

## Change and review discipline

- Keep one coherent issue per PR and use `Fixes #<issue>` when the merge should
  close it.
- Prefer the smallest correct patch over adjacent cleanup or redesign.
- Add regression tests for defects and tests for new behavior at the layer that
  owns the invariant.
- Review the complete final diff for accidental scope, authorization leaks,
  secrecy regressions, API/MCP drift, migration risk, and dead code.
- Do not weaken tests or required checks to obtain a green result.
- Reply to every substantive review comment. Resolve a thread only after the
  response is posted and the corresponding change is pushed or the concern is
  conclusively answered.
- Never merge with a pending required check, unresolved requested changes, or a
  stale review of an older head commit.

## Autonomous backlog delivery

Before any autonomous backlog run, read
`.agents/references/agent-claim-protocol.md` completely. Every coordinator must
win the shared GitHub comment lease before it creates a branch or worktree,
edits code, pushes, or dispatches a worker. The `agent: claimed` and
tool-specific labels are visibility aids, not locks. Skip work with a live claim
from Codex, Claude Code, ZCode, Kimi Code, or VS Code Copilot. Every merge also
requires the repository-wide lease on closed coordination issue #1732.

Use the tool's project skill for multi-PR or multi-issue unattended delivery:

- Codex: `$gh-deliver-backlog`
- Claude Code: `/gh-deliver-backlog`
- ZCode: `$gh-deliver-backlog`
- Kimi Code: `/skill:gh-deliver-backlog`
- VS Code Copilot with GLM: `/glm-deliver-backlog`

Each skill owns queue ordering, a four-worker maximum, CI/review loops, and
serialized landing. Workers use separate branches and worktrees and never
revert or overwrite another agent's changes.
