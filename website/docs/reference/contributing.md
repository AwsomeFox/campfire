# Contributing

Campfire is open source under the MIT license. Issues and pull requests are welcome
at [github.com/AwsomeFox/campfire](https://github.com/AwsomeFox/campfire).

## Repository layout

```
apps/server      NestJS API — REST + OpenAPI, SQLite via Drizzle, MCP server
apps/web         React (Vite) frontend
packages/schema  @campfire/schema — the Zod domain contract (single source of truth)
website/         This documentation + marketing site
```

## Local development

Prereqs: Node ≥ 22.14 and [just](https://github.com/casey/just).

Node 22.14 is a hard floor, not a suggestion: better-sqlite3 ships a Node-API 10
binary and Node added Node-API 10 in 22.14.0. On 22.0–22.13 the install still
succeeds and `npm` only warns, then the server dies with a bare segfault the
first time it opens the database. `npm run check:native-addons` confirms your
runtime can actually load the native dependencies.

```bash
just setup     # install all workspaces
just dev       # API on :8080 + web on :5173, hot reload
just test      # server suite (unit + API e2e)
just build     # production build of everything
```

The **schema package is the contract** — API validation, OpenAPI shapes, and MCP tool
schemas all derive from the Zod definitions in `packages/schema`. Don't redefine
domain types elsewhere.

**Mobile nav contract** (`apps/web/src/app/Layout.tsx`, issue #637): the bottom tab
bar shows five primary targets — Home, Quests, Party, Notes, and either **More** or a
temporary **Live** shortcut to the running encounter. Overflow destinations stay in the
More sheet (reachable from the role chip in the mobile top bar when Live occupies the
tab-bar slot). Do not add a sixth tab without condensing or replacing an existing one.

## Testing — the regression safety net

Five layers run together so a change that breaks combat turn order, leaks a DM
secret, or regresses a permission check fails CI before it merges — not at
someone's table.

| Layer | Where | Run it | Guards |
|---|---|---|---|
| **Server unit** | `apps/server/test/unit/*.spec.ts` | `just test` | Pure logic — dice parsing, `redactSecrets`, token scope-capping, combatant sort / turn math, ability & initiative derivation. No app bootstrap. |
| **API e2e** | `apps/server/test/*.e2e-spec.ts` | `just test` | Full-app HTTP against a fresh temp SQLite per suite (`test/test-app.ts`) — auth, roles, every route. |
| **Integration** | `apps/server/test/integration/*` | `just test` | Real-DB concerns — migration idempotency, delete cascades (no orphan rows), concurrent HP writes / WAL, shutdown checkpoint. |
| **Web unit** | `apps/web/e2e/tests/*.unit.spec.ts` | `just test-unit-web` | Pure front-end logic and source assertions — nav IA, i18n / locale / time formatting, CSS-token and design-system drift, storage helpers. Playwright's runner, but **no browser and no backend**. |
| **Browser E2E** | `apps/web/e2e/tests/*.spec.ts` | `just test-e2e` | Playwright across roles (admin / DM / player / viewer) against the real server serving the built SPA — combat tracker, dmSecret visibility, role gating. |

```bash
just test          # server: unit + API e2e + integration (Jest, one config)
just test-unit-web # web unit tier (no browser needed)
just e2e-install   # one-time: fetch the Playwright chromium browser
just test-e2e      # browser E2E (builds the app, seeds a per-role backend)
just test-all      # the whole net: lint + server + web unit + web build + Playwright
```

**Which config runs which web tier.** Both web tiers live under `apps/web/e2e/tests/`
and are told apart only by filename, so it matters which you are writing:

| File suffix | Config | CI job | Browser? |
|---|---|---|---|
| `*.unit.spec.ts` / `*.unit.spec.mts` | `apps/web/playwright.unit.config.ts` | `unit-web` (required) | No |
| any other `*.spec.ts` | `apps/web/playwright.config.ts` | `e2e-web` | Yes |

The default config `testIgnore`s `*.unit.spec.*` and the unit config `testMatch`es
only those, so every file belongs to exactly one tier. Name a new pure-logic spec
`*.unit.spec.ts` and both `just test-unit-web` and the required `unit-web` check
will run it. Type-checking is not enough on its own to know a spec runs — these
files compiled cleanly for a long time while no script or workflow executed them
(issue #1574).

`just test-e2e` / `just test-all` need a Chromium browser — run `just e2e-install`
once first (CI installs it per run). Everything else is pure Node.

**CI** (`.github/workflows/ci.yml`) enforces all of it on every PR: a `lint` job,
a `build-test` job (`npm run build` + the full server suite), a `coverage` job
(re-runs with instrumentation and uploads an lcov/HTML artifact), a `unit-web`
job (the web unit tier — browserless, so it is in the required set), and an
`e2e-web` Playwright job. The aggregate required check is `ci`; `e2e-web` and
`pwa-web` run for signal but are deliberately not required, because a browser
check in the required set would block every PR on a timing race. Add tests
alongside behaviour changes — the safety net only holds if it grows with the code.

## What's most wanted

See the [roadmap](roadmap.md) for the honest list of what's missing and half-built.
With account lifecycle, between-session engagement, and multi-system rule packs now
shipped, the highest-leverage areas are combat mechanical depth, smoother mobile
live-combat nav, published-adventure import, and hardening the still-experimental AI
Dungeon Master seat.
