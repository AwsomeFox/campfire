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

Prereqs: Node ≥ 22 and [just](https://github.com/casey/just).

```bash
just setup     # install all workspaces
just dev       # API on :8080 + web on :5173, hot reload
just test      # server suite (unit + API e2e)
just build     # production build of everything
```

The **schema package is the contract** — API validation, OpenAPI shapes, and MCP tool
schemas all derive from the Zod definitions in `packages/schema`. Don't redefine
domain types elsewhere.

## Testing — the regression safety net

Four layers run together so a change that breaks combat turn order, leaks a DM
secret, or regresses a permission check fails CI before it merges — not at
someone's table.

| Layer | Where | Run it | Guards |
|---|---|---|---|
| **Server unit** | `apps/server/test/unit/*.spec.ts` | `just test` | Pure logic — dice parsing, `redactSecrets`, token scope-capping, combatant sort / turn math, ability & initiative derivation. No app bootstrap. |
| **API e2e** | `apps/server/test/*.e2e-spec.ts` | `just test` | Full-app HTTP against a fresh temp SQLite per suite (`test/test-app.ts`) — auth, roles, every route. |
| **Integration** | `apps/server/test/integration/*` | `just test` | Real-DB concerns — migration idempotency, delete cascades (no orphan rows), concurrent HP writes / WAL, shutdown checkpoint. |
| **Browser E2E** | `apps/web/e2e/` | `just test-e2e` | Playwright across roles (admin / DM / player / viewer) against the real server serving the built SPA — combat tracker, dmSecret visibility, role gating. |

```bash
just test          # server: unit + API e2e + integration (Jest, one config)
just e2e-install   # one-time: fetch the Playwright chromium browser
just test-e2e      # browser E2E (builds the app, seeds a per-role backend)
just test-all      # the whole net: lint + server + web build + Playwright
```

`just test-e2e` / `just test-all` need a Chromium browser — run `just e2e-install`
once first (CI installs it per run). Everything else is pure Node.

**CI** (`.github/workflows/ci.yml`) enforces all of it on every PR: a `lint` job,
a `build-test` job (`npm run build` + the full server suite), a `coverage` job
(re-runs with instrumentation and uploads an lcov/HTML artifact), and an
`e2e-web` Playwright job. Add tests alongside behaviour changes — the safety net
only holds if it grows with the code.

## What's most wanted

See the [roadmap](roadmap.md) for the honest list of what's missing and half-built.
The account-lifecycle features (invites, self-signup), between-session engagement
(notifications, share links), and multi-system rule packs are the highest-leverage
areas.
