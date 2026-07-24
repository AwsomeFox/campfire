[![CI](https://github.com/AwsomeFox/campfire/actions/workflows/ci.yml/badge.svg)](https://github.com/AwsomeFox/campfire/actions/workflows/ci.yml)

# 🔥 Campfire

**Self-hosted, AI-operable campaign tracker for tabletop RPGs.**

Campfire is the party's shared memory: quests with objectives and subquests, NPCs, locations on a pin map, session recaps, character sheets with at-table HP tracking — plus **per-user private notes** and a zero-friction "leave a note" inbox that a DM (or an AI scribe) sweeps into canon.

Design goals:

- **Single Docker image, single volume** — SQLite, no external services
- **Login via any OIDC provider** (built for [Authentik](https://goauthentik.io)); IdP groups can gate sign-in or grant server-admin access, while campaign roles are assigned in Campfire
- **AI-operable from day 1** — the same service layer is exposed as a REST API (OpenAPI) and an MCP server (130+ tools), so an AI assistant can maintain — or run — the campaign; AI writes can be routed through a DM-approved proposal queue
- **An AI in the DM seat (optional, experimental)** — a per-campaign AI-DM seat runs as a **co-DM** (proposes only; every change lands in the DM's approval queue) or a full **driver** (holds the seat and runs the session), with token budgets, a kill switch, and player recovery levers
- **Server-enforced secrecy** — DM-only fields, hidden entities and private notes are stripped in the API layer, never hidden client-side

> **Status: functional full-stack app**, actively developed. The API and the web
> frontend are implemented end to end:
>
> - **Core:** local auth (setup/login/logout) + OIDC/SSO, campaigns with per-campaign
>   roles (`dm`/`player`/`viewer`), quests + objectives + subquests, NPCs, factions,
>   locations, a living timeline, character sheets with at-table HP, session prep +
>   auto-drafted recaps, per-user notes + the quick-capture inbox, and campaign export
>   (JSON / Markdown zip).
> - **At the table:** an encounter/combat tracker with initiative, dice rolling and
>   click-to-roll, battle maps with tokens + fog of war (monster HP and hidden NPCs
>   redacted to non-DMs), and a player-display screen.
> - **Rules:** a searchable compendium with real rule systems installed from open
>   sources — D&D 5e (Open5e), Pathfinder 2e (Archives of Nethys) and Open Legend live
>   one-click, with PF1e / Starfinder / 13th Age / OSR importable from a mirror URL.
> - **AI:** the DM-approval proposal queue, the full game-icons.net icon set, and the
>   experimental **AI Dungeon Master** (co-DM / driver — see below), plus a scheduled
>   **AI scribe** that drafts recaps into the proposal queue.
>
> The same service layer is exposed as a REST API (OpenAPI/Swagger) **and** an MCP
> server with **137 tools**, so any MCP-capable client (e.g. Claude, via `claude mcp
> add`) can read and write — or fully drive — a campaign directly. See
> [`design/`](design/) for the original approved mockups the UI was built from.

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
| `just test` | Server suite — unit (`test/unit`) + API e2e (Jest + Supertest) |
| `just test-e2e` | Browser E2E across roles (Playwright; run `just e2e-install` once) |
| `just test-all` | Whole regression safety net — lint + server + web build + Playwright |
| `just build` | Type-check + production build of all workspaces |
| `just db-reset` | Delete the local SQLite db (recreated on next boot) |
| `just api-docs` | Open Swagger UI (server must be running) |
| `just design` | Serve the design mockups on :8378 |

### Everyday URLs

- Web: http://localhost:5173
- API: http://localhost:8080/api/v1
- Swagger UI: http://localhost:8080/api/docs · spec: http://localhost:8080/api/openapi.json
- Health: http://localhost:8080/healthz (liveness) · http://localhost:8080/readyz (readiness, checks the DB)

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
| `TRUST_PROXY` | `1` (trust one hop) | Express `trust proxy` setting — pass a hop count (`1`, `2`, …), `false`, or an explicit IP/subnet allow-list. Needed for rate limiting and `req.ip` to see the real client IP behind a reverse proxy (Traefik in the reference deployment) |
| `API_DOCS` | *(unset)* | Swagger UI (`/api/docs`) + OpenAPI JSON (`/api/openapi.json`) exposure. Unset: enabled in dev, **disabled in production**. Set `1` to force-enable (e.g. agent self-discovery on a trusted network) or `0` to force-disable |
| `ALLOW_INSECURE_HTTP` | *(unset)* | Set to `1` for a no-TLS LAN/homelab deployment reached over plain HTTP (`http://192.168.1.x:8080`). Drops the HTTPS-assuming security headers (CSP `upgrade-insecure-requests`, HSTS) and issues the session cookie without `Secure` so login works. **Leave unset whenever you have TLS** |
| `OIDC_ISSUER` | *(unset)* | OIDC provider issuer URL (enables SSO login when set, alongside local auth) |
| `OIDC_CLIENT_ID` | *(unset)* | OIDC client ID |
| `OIDC_CLIENT_SECRET` | *(unset)* | OIDC client secret |
| `OIDC_REDIRECT_URI` | *(unset)* | OIDC callback URL, e.g. `https://campfire.example.com/api/v1/auth/oidc/callback` |
| `OIDC_PROVIDER_NAME` | *(unset)* | Optional identity-provider display name for the login button, e.g. `Keycloak`; unset uses neutral “Sign in with SSO” branding |
| `OIDC_SCOPE` | `openid profile email` | OIDC scopes requested |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim in the ID token holding the user's group memberships |
| `OIDC_ADMIN_GROUP` | *(unset)* | Group name that grants the Campfire **server admin** role (campaign roles dm/player/viewer are per-campaign memberships managed in-app) |
| `OIDC_ALLOWED_GROUP` | *(unset)* | Group name required to **sign in at all** — users outside it reach safe sign-in recovery and no account is provisioned. Unset = any authenticated IdP user may sign in. Members of `OIDC_ADMIN_GROUP` always have access |
| `OIDC_ALLOW_INSECURE` | *(unset)* | Set to allow OIDC over plain HTTP — dev/testing only, never in production |
| `OPENAI_API_KEY` | *(unset)* | Fallback credential for a configured `openai` / OpenAI-compatible server-default provider when no encrypted key is stored. The admin UI reports `Environment credential`; the value is never returned or logged |
| `ANTHROPIC_API_KEY` | *(unset)* | Fallback credential for a configured `anthropic` server-default provider when no encrypted key is stored. The admin UI reports `Environment credential`; the value is never returned or logged |
| `AI_PROVIDER_ALLOW_PRIVATE_HOSTS` | *(unset)* | Set to `1` to allow private/loopback AI provider `baseUrl` hosts (local Ollama / llama.cpp / LM Studio). Cloud metadata / link-local stay blocked. See docs for the safer per-host allowlist alternative |
| `AI_PROVIDER_BASEURL_ALLOW_HOSTS` | *(unset)* | Optional comma-separated hostname allowlist for provider `baseUrl` |
| `AI_PROVIDER_BASEURL_DENY_HOSTS` | *(unset)* | Optional comma-separated hostname denylist for provider `baseUrl` |
| `TZ` | *(unset, UTC)* | Container timezone, e.g. `America/Denver` — affects displayed session/log timestamps |
| `BACKUP_SCHEDULE_ENABLED` | *(unset)* | Set to `1` to enable periodic on-disk backups (see **Backup & restore** below). Off by default |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between scheduled backups (only when `BACKUP_SCHEDULE_ENABLED=1`) |
| `BACKUP_DIR` | `$DATA_DIR/backups` | Where scheduled backup archives are written (only when `BACKUP_SCHEDULE_ENABLED=1`) |
| `BACKUP_KEY_PASSPHRASE` | *(unset)* | When set (≥12 characters), scheduled backups wrap the auto-generated `ai-config.key` in an encrypted envelope inside the archive (#496). Interactive downloads use `POST /api/v1/backup/download` with the same passphrase in the JSON body. |

`WEB_DIST` and `NODE_ENV` are already baked into the image (`NODE_ENV=production`,
`WEB_DIST=/app/web-dist`) — you shouldn't need to set either.

### Backup & restore

The whole of the app's state is the `/data` volume (SQLite DB + uploaded attachments),
so copying that volume is still the simplest backup. On top of that, Campfire exposes a
**server-admin-only** in-app backup/restore for the entire server:

- **`GET /api/v1/backup`** — downloads a single `.zip` containing a WAL-safe hot snapshot
  of the database (taken with SQLite `VACUUM INTO`, so it never blocks writers or ships a
  torn WAL) plus every uploaded file, with a `manifest.json`.
- **`POST /api/v1/backup/download`** — same archive as the GET endpoint, but accepts an
  optional `keyPassphrase` in the JSON body (≥12 characters) to include an encrypted
  AI credential keyfile envelope (#496). Passphrases must not be sent in query strings.
- **`POST /api/v1/backup/restore`** (multipart: `file` = the archive, `confirm` = `RESTORE`)
  — **destructive**: validates the archive, then replaces the live database and uploads
  and re-opens the DB in place. Gated hard behind server-admin *and* the explicit
  `confirm` token; a malformed/foreign archive is rejected (400) with the server left
  untouched (the running DB is never closed until the archive passes validation).

**Scheduled backups** are opt-in and off by default. Set `BACKUP_SCHEDULE_ENABLED=1` to
have the server write a fresh archive to `BACKUP_DIR` (default `$DATA_DIR/backups`) every
`BACKUP_INTERVAL_HOURS` (default 24). These are the same archives the download endpoint
produces — copy them off-box for real disaster recovery.

`BACKUP_INTERVAL_HOURS` is strictly validated: an unset, empty, non-numeric, zero, negative,
or `NaN`/`Infinity` value falls back to the documented 24h default rather than silently
becoming 0/Infinity/negative, and the effective cadence is logged at boot so a misconfiguration
is visible. The value is clamped to a sane range (min one minute, max 30 days). At boot the
server also checks that `BACKUP_DIR` exists and is writable, and disables scheduling for that
boot (with a loud error log) if it isn't — so a misconfigured path fails immediately instead of
silently swallowing every scheduled write.

The scheduler remembers its cadence across restarts (issue #732): the last attempt, last
success, projected next run, archive size, and sha256 checksum are persisted under the
`backup.cadence` key in the `settings` table. On boot, if a scheduled run was missed while the
server was down (or the scheduler was just enabled), a catch-up backup runs immediately so a
frequently-restarted container can no longer go forever without a backup. Concurrent scheduled
runs are suppressed by an in-process overlap guard. A failed attempt records its error without
claiming a success, so an operator reading the `backup.cadence` row sees the real last-good time.

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
      OIDC_PROVIDER_NAME: ${OIDC_PROVIDER_NAME:-}
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
an Authentik group (e.g. `campfire-admins`) to `OIDC_ADMIN_GROUP` so its members become
Campfire server admins. Campaign access and `dm` / `player` / `viewer` roles are still
assigned inside Campfire. Campfire itself never needs a public port in this setup
— only Traefik does; Campfire and Traefik talk over the Docker network.

Expected SSO failures return to Campfire's accessible sign-in recovery page.
Users can start a fresh SSO flow and give an operator the displayed support
reference; provider payloads, authorization codes, state/PKCE values, tokens,
claims, and secrets are never placed in the recovery URL or UI.

## AI Dungeon Master (experimental)

Campfire can seat an AI at the table. It's **off by default** and gated two ways: a
server admin flips the server-wide switch in the in-app **AI console** (`/admin/ai`),
then a DM configures the seat per-campaign under **Settings → AI Dungeon Master**.

**Two modes:**

- **Co-DM** — the AI only *proposes*. Every change it makes lands in the DM's approval
  queue to accept or reject; the human still runs the table. Recommended.
- **Driver** — the AI holds the DM seat and runs the session (narration + tool calls).
  It requires a positive token budget and a configured provider, and even here every
  canon-writing tool is forced through the proposal path — it cannot silently overwrite
  your world.

**Bring your own model.** Campfire **never calls an LLM vendor from the server** — the
shipped provider is a no-op scaffold. You get real narration one of two ways:

1. **Over MCP** — connect any agent (e.g. Claude) with a **dm-scoped** personal access
   token; it drives the campaign through the same 137 MCP tools, or
2. **A per-campaign provider** — set a provider (OpenAI / Anthropic / a custom base URL)
   and a **write-only** API key in the seat config, with an optional model allowlist.

**Guardrails:** a per-campaign token budget + a server-wide cap, a one-click kill switch,
tool-scoping (the driver can only touch live-play tools; admin/destructive/other-campaign
writes are refused), player recovery levers (nudge, flag, table vote, request human
takeover), and — like everything else — every action is audit-logged with actor + role.

## Roadmap

Shipped: entities + notes + OpenAPI, OIDC/roles, MCP server (137 tools), media & maps
(attachments) with fog of war, real rule systems from open sources (5e / PF2e / Open
Legend live), encounter/combat tracker, the full game-icons.net icon set, a DM-approval
proposal queue, the **AI Dungeon Master** (co-DM + driver) and a **scheduled AI scribe**
that drafts recaps. Ahead: D&D Beyond sync, more first-party rule-system data sources,
and deeper co-DM authoring. Full plan lives in the repo wiki.

## License

MIT
