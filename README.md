# 🔥 Campfire

**Self-hosted, AI-operable campaign tracker for tabletop RPGs.**

Campfire is the party's shared memory: quests with objectives and subquests, NPCs, locations on a pin map, session recaps, character sheets with at-table HP tracking — plus **per-user private notes** and a zero-friction "leave a note" inbox that a DM (or an AI scribe) sweeps into canon.

Design goals:

- **Single Docker image, single volume** — SQLite, no external services
- **Login via any OIDC provider** (built for [Authentik](https://goauthentik.io); roles map from groups: `dm` / `player` / `viewer`)
- **AI-operable from day 1** — the same service layer is exposed as a REST API (OpenAPI) and an MCP server, so an AI assistant can maintain the campaign; AI writes can be routed through a DM-approved proposal queue
- **Server-enforced secrecy** — DM-only fields and private notes are stripped in the API layer, never hidden client-side

> Status: **early development.** The API core is functional; the real UI is in design (see [`design/`](design/) for the approved mockups — the current web app is a placeholder).

## Project layout

```
apps/server      NestJS API — REST /api/v1, OpenAPI, SQLite via Drizzle
apps/web         React (Vite) frontend — placeholder until design lands
packages/schema  @campfire/schema — Zod domain contract (single source of truth)
design/          Approved HTML design mockups + design tokens
```

## Dev setup

Prereqs: **Node ≥ 22**, **[just](https://github.com/casey/just)** (`brew install just`).

```bash
git clone https://github.com/AwsomeFox/campfire && cd campfire
just setup     # npm install (all workspaces)
just dev       # backend :8080 + frontend :5173, hot reload
```

| Recipe | What it does |
|---|---|
| `just dev` | Run server + web together (`just dev-server` / `just dev-web` for one) |
| `just test` | API test suite (Jest + Supertest e2e) |
| `just build` | Type-check + production build of all workspaces |
| `just db-reset` | Delete the local SQLite db (recreated on next boot) |
| `just api-docs` | Open Swagger UI (server must be running) |
| `just design` | Serve the design mockups on :8378 |

### Everyday URLs

- Web: http://localhost:5173
- API: http://localhost:8080/api/v1
- Swagger UI: http://localhost:8080/api/docs · spec: http://localhost:8080/api/openapi.json
- Health: http://localhost:8080/healthz

### Dev auth

Real OIDC isn't wired yet. In development the server trusts two headers (defaults: `dm` / `dev-user`):

```bash
curl -H 'x-dev-role: player' -H 'x-dev-user: alice' localhost:8080/api/v1/campaigns
```

Role semantics: `dm` = full write incl. `dmSecret` fields · `player` = read canon, tick objectives, own character + own notes · `viewer` = read-only + inbox quick-capture.

## Architecture notes

- **`@campfire/schema` is the contract.** All DTO validation and OpenAPI shapes derive from these Zod schemas. Don't redefine domain types in server or web.
- SQLite file lives at `apps/server/data/campfire.db` (env `DATA_DIR`); migrations run automatically on boot.
- Every write is audit-logged with actor + role.

## Roadmap

MVP (now): entities + notes + OpenAPI → OIDC/roles → MCP server → media & maps → SRD rules search → D&D Beyond sync → AI scribe with proposal queue → AI co-DM. Full plan lives in the repo wiki.

## License

MIT
