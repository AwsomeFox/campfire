# 🔥 Campfire

**Self-hosted, AI-operable campaign tracker for tabletop RPGs.**

Campfire is the party's shared memory: quests with objectives and subquests, NPCs, locations on a pin map, session recaps, character sheets with at-table HP tracking — plus **per-user private notes** and a zero-friction "leave a note" inbox that a DM (or an AI scribe) sweeps into canon.

Design goals:

- **Single Docker image, single volume** — SQLite, no external services
- **Login via any OIDC provider** (built for [Authentik](https://goauthentik.io); roles map from groups: `dm` / `player` / `viewer`)
- **AI-operable from day 1** — the same service layer is exposed as a REST API (OpenAPI) and an MCP server, so an AI assistant can maintain the campaign; AI writes can be routed through a DM-approved proposal queue
- **Server-enforced secrecy** — DM-only fields and private notes are stripped in the API layer, never hidden client-side

> **Status: functional full-stack app**, still evolving. Both the API and the web
> frontend are implemented end to end: local auth (setup/login/logout) plus
> OIDC/SSO, campaigns with per-campaign membership roles (`dm`/`player`/`viewer`),
> quests with objectives and subquests, NPCs, locations, characters, session
> recaps, notes + the inbox, an encounter/combat tracker with initiative and dice
> rolling, a compendium (rule packs imported from Open5e, searchable), a DM-approval
> proposal queue for AI-suggested writes, and campaign export (JSON/Markdown zip).
> The same service layer is exposed as a REST API (OpenAPI/Swagger) **and** an MCP
> server with 36 tools, so any MCP-capable client (e.g. Claude, via `claude mcp add`)
> can read and write a campaign directly — that's the "AI scribe" today: it works
> through any MCP client already, there's no separate built-in automation/scheduler
> yet. See [`design/`](design/) for the original approved mockups the UI was built from.

## Project layout

```
apps/server      NestJS API — REST /api/v1, OpenAPI, SQLite via Drizzle, MCP server
apps/web         React (Vite) frontend — full app (see Status above)
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

Real auth (local username/password, and optionally OIDC/SSO) is fully wired —
see `apps/server/README.md`'s "Authentication & authorization" section. For quick
local API poking without going through `/auth/setup`/`/auth/login`, the server
also accepts two headers, but **only when the server is started with `DEV_AUTH=1`
in its environment** (unset/`0` by default in `just dev`, and never set in a
production deployment):

```bash
DEV_AUTH=1 npm run dev -w apps/server   # or: DEV_AUTH=1 just dev-server
curl -H 'x-dev-role: player' -H 'x-dev-user: alice' localhost:8080/api/v1/campaigns
```

Without `DEV_AUTH=1` set on the server process, those headers are ignored and an
unauthenticated request gets a normal 401 — this is also how every e2e test
boots the app (`test/test-app.ts`'s `createTestApp()` sets it before `AppModule`
compiles).

Role semantics: `dm` = full write incl. `dmSecret` fields · `player` = read canon, tick objectives, own character + own notes · `viewer` = read-only + inbox quick-capture. Under real auth, campaign role is per-campaign membership (`GET/POST/PATCH/DELETE /campaigns/:id/members`), not a global header.

## Architecture notes

- **`@campfire/schema` is the contract.** All DTO validation and OpenAPI shapes derive from these Zod schemas. Don't redefine domain types in server or web.
- SQLite file lives at `apps/server/data/campfire.db` (env `DATA_DIR`); migrations run automatically on boot.
- Every write is audit-logged with actor + role.

## Deployment

Campfire ships as a **single Docker image** — the API and the built web SPA are served
by one Node process on one port, backed by one SQLite file on one volume. No reverse
proxy, database, or object store required (though you can put a reverse proxy in front
for TLS/auth — see the Traefik/Authentik note below).

```bash
docker run -d \
  --name campfire \
  -p 8080:8080 \
  -v campfire-data:/data \
  ghcr.io/awsomefox/campfire:latest
```

Or build locally: `just docker-build` (tags `campfire:local`) then `just docker-run`
(serves on host port **8081**, so it doesn't collide with a `just dev` stack already
running on 8080 — maps to the container's internal 8080).

### Image

- `ghcr.io/awsomefox/campfire:latest` and `:<version>` — built for `linux/amd64` and
  `linux/arm64` on every tagged release (`v*`) by `.github/workflows/ci.yml`'s
  `release` job.
- Single stateful volume: `/data` — the SQLite database (`campfire.db`) and uploaded
  attachments both live under here. Back up this volume; that's the entire app state.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port the server listens on inside the container |
| `DATA_DIR` | `/data` | SQLite DB + attachment uploads live here (the volume mount point) |
| `ORIGIN` | *(unset)* | Comma-separated allowed CORS origin(s). Leave unset for same-origin deployments (the default — SPA + API on one origin) |
| `TRUST_PROXY` | `1` (trust one hop) | Express `trust proxy` setting — pass a hop count or `false`. Needed for rate limiting and `req.ip` to see the real client IP behind a reverse proxy (Traefik in the reference deployment) |
| `OIDC_ISSUER` | *(unset)* | OIDC provider issuer URL (enables SSO login when set, alongside local auth) |
| `OIDC_CLIENT_ID` | *(unset)* | OIDC client ID |
| `OIDC_CLIENT_SECRET` | *(unset)* | OIDC client secret |
| `OIDC_REDIRECT_URI` | *(unset)* | OIDC callback URL, e.g. `https://campfire.example.com/api/v1/auth/oidc/callback` |
| `OIDC_SCOPE` | `openid profile email` | OIDC scopes requested |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim in the ID token holding the user's group memberships |
| `OIDC_ADMIN_GROUP` | *(unset)* | Group name that grants the Campfire **server admin** role (campaign roles dm/player/viewer are per-campaign memberships managed in-app) |
| `OIDC_ALLOW_INSECURE` | *(unset)* | Set to allow OIDC over plain HTTP — dev/testing only, never in production |
| `TZ` | *(unset, UTC)* | Container timezone, e.g. `America/Denver` — affects displayed session/log timestamps |
| `BACKUP_SCHEDULE_ENABLED` | *(unset)* | Set to `1` to enable periodic on-disk backups (see **Backup & restore** below). Off by default |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between scheduled backups (only when `BACKUP_SCHEDULE_ENABLED=1`) |
| `BACKUP_DIR` | `$DATA_DIR/backups` | Where scheduled backup archives are written (only when `BACKUP_SCHEDULE_ENABLED=1`) |

`WEB_DIST` and `NODE_ENV` are already baked into the image (`NODE_ENV=production`,
`WEB_DIST=/app/web-dist`) — you shouldn't need to set either.

### Backup & restore

The whole of the app's state is the `/data` volume (SQLite DB + uploaded attachments),
so copying that volume is still the simplest backup. On top of that, Campfire exposes a
**server-admin-only** in-app backup/restore for the entire server:

- **`GET /api/v1/backup`** — downloads a single `.zip` containing a WAL-safe hot snapshot
  of the database (taken with SQLite `VACUUM INTO`, so it never blocks writers or ships a
  torn WAL) plus every uploaded file, with a `manifest.json`.
- **`POST /api/v1/backup/restore`** (multipart: `file` = the archive, `confirm` = `RESTORE`)
  — **destructive**: validates the archive, then replaces the live database and uploads
  and re-opens the DB in place. Gated hard behind server-admin *and* the explicit
  `confirm` token; a malformed/foreign archive is rejected (400) with the server left
  untouched (the running DB is never closed until the archive passes validation).

**Scheduled backups** are opt-in and off by default. Set `BACKUP_SCHEDULE_ENABLED=1` to
have the server write a fresh archive to `BACKUP_DIR` (default `$DATA_DIR/backups`) every
`BACKUP_INTERVAL_HOURS` (default 24). These are the same archives the download endpoint
produces — copy them off-box for real disaster recovery.

### Compose example

No secrets are inlined below — `${VAR:?}` fails the compose run with a clear error if
you forget to export it, instead of silently booting with an empty value.

```yaml
services:
  campfire:
    image: ghcr.io/awsomefox/campfire:latest
    restart: unless-stopped
    volumes:
      - campfire-data:/data
    environment:
      OIDC_ISSUER: ${OIDC_ISSUER:?}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:?}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:?}
      OIDC_REDIRECT_URI: ${OIDC_REDIRECT_URI:?}
      OIDC_ADMIN_GROUP: ${OIDC_ADMIN_GROUP:?}
      TZ: ${TZ:-UTC}
    # No `ports:` published here — reverse-proxied, see below. For a standalone
    # host without a proxy, add: ports: ["8080:8080"]

volumes:
  campfire-data:
```

(or an `.env` file next to the compose file — keep that file out of git).

### Reverse proxy + SSO (Traefik / Authentik)

The common self-hosted pattern: **Traefik** terminates TLS and routes
`campfire.example.com` to the container on its internal port 8080 (via Docker labels
or a dynamic config file), while **Authentik** is the OIDC provider — create an
OAuth2/OIDC provider + application in Authentik, point `OIDC_ISSUER` at it, and map
an Authentik group (e.g. `campfire-dm`) to `OIDC_ADMIN_GROUP` so its members land in
Campfire with the `dm` role. Campfire itself never needs a public port in this setup
— only Traefik does; Campfire and Traefik talk over the Docker network.

## Roadmap

Shipped: entities + notes + OpenAPI, OIDC/roles, MCP server (36 tools), media & maps (attachments), SRD rules search (compendium), encounter/combat tracker, AI scribe via any MCP client with a DM-approval proposal queue. Ahead: D&D Beyond sync, built-in scheduled/automated AI scribe runs (today it's client-driven — connect an MCP client and ask it to act), AI co-DM. Full plan lives in the repo wiki.

## License

MIT
