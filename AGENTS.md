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

Prerequisites are Node 22.14 or newer and npm workspaces. The floor is 22.14
rather than 22.0 because better-sqlite3's bundled binary targets Node-API 10,
which Node added in 22.14.0 — on 22.0–22.13 the install succeeds and the server
then fails when it imports the addon. `build-test (22.x)` pins that exact
version so the declared floor is tested rather than asserted.

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
  `npm run check:i18n`

Run the smallest relevant checks while iterating. Run all checks affected by the
final diff before handoff. GitHub's aggregate required check is named `ci`.
Non-required browser jobs still matter when the branch caused their failure.

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
