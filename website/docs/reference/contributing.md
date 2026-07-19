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
just test      # the API test suite
just build     # production build of everything
```

The **schema package is the contract** — API validation, OpenAPI shapes, and MCP tool
schemas all derive from the Zod definitions in `packages/schema`. Don't redefine
domain types elsewhere.

## What's most wanted

See the [roadmap](roadmap.md) for the honest list of what's missing and half-built.
The account-lifecycle features (invites, self-signup), between-session engagement
(notifications, share links), and multi-system rule packs are the highest-leverage
areas.
