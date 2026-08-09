[![CI](https://github.com/AwsomeFox/campfire/actions/workflows/ci.yml/badge.svg)](https://github.com/AwsomeFox/campfire/actions/workflows/ci.yml)

# 🔥 Campfire

**Self-hosted, AI-operable campaign tracker for tabletop RPGs.**

Campfire is the party's shared memory: quests with objectives and subquests, NPCs, locations on a pin map, session recaps, character sheets with at-table HP tracking — plus **per-user private notes** and a zero-friction "leave a note" inbox that a DM (or an AI scribe) sweeps into canon.

Design goals:

- **Single Docker image, single volume** — SQLite, no external services
- **Login via any OIDC provider** (built for [Authentik](https://goauthentik.io)); IdP groups can gate sign-in or grant server-admin access, while campaign roles are assigned in Campfire
- **AI-operable from day 1** — the same service layer is exposed as a REST API (OpenAPI) and an MCP server (266 tools), so an AI assistant can maintain — or run — the campaign; AI writes can be routed through a DM-approved proposal queue
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
> server with **266 tools**, so any MCP-capable client (e.g. Claude, via `claude mcp
> add`) can read and write — or fully drive — a campaign directly. See
> [`design/`](design/) for the original approved mockups the UI was built from.

## Project layout

```
apps/server      NestJS API — REST /api/v1, OpenAPI, SQLite via Drizzle, MCP server
apps/web         React (Vite) frontend — full app (see Status above)
packages/schema  @campfire/schema — Zod domain contract (single source of truth)
design/          Approved HTML design mockups + design tokens
```

## Autonomous backlog agents

This repository includes one end-to-end backlog workflow for five agent
runtimes. They may run simultaneously: each must win a 90-minute lease in the
issue's single `## Agent Workpad` comment before it creates implementation
state. `agent: claimed` plus one of `agent: codex`, `agent: claude`,
`agent: zcode`, `agent: kimi`, or `agent: copilot` makes ownership visible; the
comment lease is the actual lock. Leases renew every 30 minutes, deterministic
comment ordering settles races, and a second short lease on closed coordination
issue [#1732](https://github.com/AwsomeFox/campfire/issues/1732) serializes
merges across all runtimes.

| Runtime | Coordinator and workers | Start it |
|---|---|---|
| Codex | GPT-5.6 Sol coordinator; four GPT-5.6 Terra workers | Open this repository in Codex and paste: `$gh-deliver-backlog Deliver the entire current backlog in priority order. Continue until every in-scope item is merged or externally blocked.` |
| Claude Code | Opus 5 coordinator; four Sonnet 5 worktree workers | Start a new Claude Code session in Auto mode and paste: `/gh-deliver-backlog Deliver the entire current backlog in priority order. Continue until every in-scope item is merged or externally blocked.` |
| ZCode | GLM-5.2 coordinator and up to four `general-purpose` workers | Open the repository in ZCode, select GLM-5.2 with Max thought level, enable Goal mode and Full Access (or Auto Edit), refresh/enable the project skill if needed, then paste: `$gh-deliver-backlog Deliver the entire current backlog in priority order. Continue until every in-scope item is merged or externally blocked.` |
| Kimi Code | K3 coordinator and four project `issue-worker` subagents | Run `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=4 kimi --auto -m k3`, choose max effort, then paste: `/skill:gh-deliver-backlog Deliver the entire current backlog in priority order. Continue until every in-scope item is merged or externally blocked.` |
| VS Code Copilot + GLM | GLM-5.2 coordinator and four `GLM Issue Worker` subagents | Use VS Code 1.116+, install `yijiazhen-qi.glm-for-github-copilot-chat`, run **GLM: Set API Key**, open the repository root, select **GLM Backlog Coordinator**, set GLM-5.2 thinking to Max and the session permission to Autopilot, then paste: `/glm-deliver-backlog` |

Authenticate `gh` before starting any runtime. Kimi Code also needs `kimi login`
once. The project configuration lives in `.codex/`, `.claude/`, `.zcode/`,
`.kimi-code/`, and `.github/`; all five workflows share
`.agents/references/agent-claim-protocol.md` and the repository rules in
`AGENTS.md`. Existing branches, worktrees, and legacy Codex or Claude workpads
are treated as reservations, so upgrading an in-progress run is safe.

## Dev setup

Prereqs: **Node 22.14+, 23.6+, or 24+**, **[just](https://github.com/casey/just)**
(`brew install just`).

That version list is the real requirement, not a rounded-up minimum:
better-sqlite3 ships a Node-API 10 binary, and Node added Node-API 10 in 22.14.0
and 23.6.0. On an older Node the install still succeeds and `npm` only warns,
then the server dies with a bare segfault the first time it opens the database.
`node -p process.versions.napi` should print `10` or higher.

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

Role semantics: `dm` = full write incl. `dmSecret` fields · `player` = read canon, tick objectives, own character + own notes · `viewer` = read-only (private notes and dice only; comments, shared/whispered notes and DM-inbox posts need the separate DM-granted **interactive guest** capability — issue #597). Under real auth, campaign role is per-campaign membership (`GET/POST/PATCH/DELETE /campaigns/:id/members`), not a global header.

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
| `PUBLIC_BASE` | `/` | **Build-time** reverse-proxy subpath (issue #798). Set to the path prefix the app is served under, e.g. `/campfire` when the public URL is `https://host/campfire/...`. Baked into the image: the Docker build stamps it into the web bundle (asset URLs, PWA manifest scope/start_url, service-worker patterns, router basename, and the in-app API client) and re-declares it at runtime so the server can prefix its browser-facing OIDC redirects. **Re-build the image to change it.** See **Reverse-proxy subpath** below |
| `VAPID_PUBLIC_KEY` | *(unset)* | URL-safe public VAPID key for browser Web Push. Browser notifications stay disabled unless all three `VAPID_*` values are set |
| `VAPID_PRIVATE_KEY` | *(unset)* | Matching private VAPID key. Treat it as a server secret; it is never returned by the API or stored in SQLite |
| `VAPID_SUBJECT` | *(unset)* | Web Push contact URI, such as `mailto:admin@example.com` or `https://campfire.example.com/contact` |
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
| `BACKUP_KEEP_COUNT` | `14` | Scheduled-backup retention: keep this many newest verified archives (`0` disables count pruning) |
| `BACKUP_KEEP_DAYS` | `30` | Scheduled-backup retention: prune verified archives older than this many days (`0` disables age pruning) |
| `BACKUP_MAX_TOTAL_BYTES` | *(unset)* | Optional scheduled-backup retention cap across archives in `BACKUP_DIR`; oldest verified, unprotected archives are pruned first |
| `BACKUP_MIN_FREE_BYTES` | `536870912` | Free-space reserve for scheduled backups. If free space minus the next archive estimate would fall below this, the run is skipped and alerted |
| `BACKUP_PROTECT_LAST_GOOD` | `true` | Protect the most recent verified scheduled archive from retention pruning |

`WEB_DIST` and `NODE_ENV` are already baked into the image (`NODE_ENV=production`,
`WEB_DIST=/app/web-dist`) — you shouldn't need to set either.

### Browser push notifications

Browser/OS notifications are opt-in per browser and require HTTPS (localhost is
the browser-supported development exception). Generate one VAPID key pair for
the Campfire installation and keep using that pair; rotating it invalidates
existing browser subscriptions:

```bash
npm exec --workspace apps/server web-push -- generate-vapid-keys --json
```

Set the printed values as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, set
`VAPID_SUBJECT` to an operator contact URI, and restart Campfire. Users can then
enable **Preferences → Notifications → Also notify this browser**. The alert
contains only the notification title, a short excerpt, and a Campfire link. That
encrypted payload still travels through the browser vendor's push service
(Google, Mozilla, Apple, or Microsoft); in-app notifications continue to work
when Web Push is unset or unavailable.

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

Archive creation and restore use streaming and disk staging: the server serializes archive work so only one archive
operation runs at a time, streams downloads rather than holding the finished ZIP in process memory, and stages a
restore on disk before replacing live data. The default safety limits are a 1 GiB compressed archive, 512 MiB per
entry, 4 GiB total uncompressed content, and 100,000 entries. These are fixed limits (not environment settings).
Plan temporary space for both the incoming archive and its extracted staging contents; a failed or cancelled request
leaves live data intact and the server cleans its staging area. Cancelling a browser request sends an `AbortSignal`,
but cannot promise that a server-side operation already underway has stopped.

The admin UI uses the File System Access API to stream the archive directly to a selected file when the browser
supports it. Browsers without that API must buffer the completed archive in browser memory; Campfire bounds that
fallback at 512 MiB and tells the operator when it is used. Use `curl` or a File System Access-capable browser for
larger downloads. Cancelling a direct-to-file download asks the browser to discard its partial file; verify the
destination if the browser reports a cancellation or write error.

**Scheduled backups** are opt-in and off by default. Set `BACKUP_SCHEDULE_ENABLED=1` to
have the server write a fresh archive to `BACKUP_DIR` (default `$DATA_DIR/backups`) every
`BACKUP_INTERVAL_HOURS` (default 24). These are the same archives the download endpoint
produces — copy them off-box for real disaster recovery.

Scheduled archives are retained by a verified-only policy: by default Campfire keeps the
newest 14 verified archives and prunes verified archives older than 30 days. You can also
set `BACKUP_MAX_TOTAL_BYTES` to enforce a directory size cap. Retention never deletes an
archive that fails manifest/reconciliation verification, the most recent last-known-good
archive (unless `BACKUP_PROTECT_LAST_GOOD=0`), or an operator-marked archive with a
sidecar marker next to the zip (`.pin` / `.keep` for local pinning, `.offsite` for an
off-box protected copy). Pruning runs only after a new scheduled archive has been written
and verified.

Before writing a scheduled archive, Campfire estimates the next archive size from the last
successful backup (or current DB/uploads size on first run) and checks the backup volume
with `statfs`. If `free - estimate < BACKUP_MIN_FREE_BYTES`, the run is skipped before any
archive is written, the cadence row records `lastError`, and the next attempt uses
exponential backoff. The server-admin backup card surfaces disk free/reserve, retention
policy/metrics, and alerts.

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

### Reverse-proxy subpath (issue #798)

Campfire ships at the origin root by default. To host it under a path prefix
(`https://host/campfire/...` on a shared domain with other apps), set
**`PUBLIC_BASE`** at **image-build time** and configure the reverse proxy to
**strip the prefix before forwarding**. Everything browser-facing — asset
URLs, the PWA manifest's scope/start_url, the service worker, the router
basename, and the in-app API client — is stamped from this single setting.

**The proxy contract is "strip prefix, then forward":**

```
Browser:  https://host/campfire/assets/index-abc.js
                     └────────┘ └──────────────────┘
                  Proxy strips   Server receives /assets/index-abc.js
                  /campfire,     (server routing is UNCHANGED — never
                  forwards       sees the prefix for its own routes)
```

This keeps the server's routing exactly as it is — ServeStaticModule still
serves `index.html` for `/login`, NestJS still handles `/api/v1/...`, the
healthcheck still probes `/readyz`. Only the browser-facing surface knows
about the prefix.

**Build the image with the prefix:**

```bash
docker build --build-arg PUBLIC_BASE=/campfire -t campfire:subpath .
# or, in compose:
#   build: { args: { PUBLIC_BASE: /campfire } }
```

**Traefik strip-prefix labels (PathPrefix + StripPrefix):**

```yaml
labels:
  - traefik.http.routers.campfire.rule=PathPrefix(`/campfire`)
  - traefik.http.routers.campfire.middlewares=campfire-strip
  - traefik.http.middlewares.campfire-strip.stripprefix.prefixes=/campfire
```

**Caddy (handle_path auto-strips):**

```caddyfile
example.com {
  handle_path /campfire/* {
    reverse_proxy campfire:8080
  }
}
```

**Nginx (`rewrite` / `location` with trailing slash):**

```nginx
location /campfire/ {
    rewrite ^/campfire/(.*)$ /$1 break;
    proxy_pass http://campfire:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
# Also handle the bare prefix so https://host/campfire redirects cleanly:
location = /campfire {
    return 301 /campfire/;
}
```

**Important notes:**

- `PUBLIC_BASE` is a PATH, not an origin. Passing a full URL like
  `https://host/campfire` is accepted (the host portion is dropped) for
  operator convenience, but only the path component is used.
- Re-building the image is required to change the prefix — it is a build-time
  constant by design (the browser cannot be told at runtime which path to
  fetch assets from). Operators who need to switch prefixes must build two
  images or use a per-deployment tag.
- **OIDC SSO under a subpath:** set `OIDC_REDIRECT_URI` to the full
  externally-visible callback URL including the prefix, e.g.
  `https://host/campfire/api/v1/auth/oidc/callback`. The server prefixes its
  own post-SSO redirect (`/campfire/`) and scopes the OIDC flow cookie to
  the prefixed path automatically — no extra proxy configuration needed.
- **Trailing slash** in `PUBLIC_BASE` is optional (`/campfire` and
  `/campfire/` normalize to the same value internally).
- Root deployment (the default, `PUBLIC_BASE=/`) is identical to pre-#798
  behavior — no proxy rewrites, no prefix anywhere.

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

Shipped: entities + notes + OpenAPI, OIDC/roles, MCP server (266 tools), media & maps
(attachments) with fog of war, real rule systems from open sources (5e / PF2e / Open
Legend live), encounter/combat tracker, the full game-icons.net icon set, a DM-approval
proposal queue, the **AI Dungeon Master** (co-DM + driver) and a **scheduled AI scribe**
that drafts recaps. Ahead: D&D Beyond sync, more first-party rule-system data sources,
and deeper co-DM authoring. Full plan lives in the repo wiki.

## License

MIT
