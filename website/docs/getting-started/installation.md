# Installation

Campfire ships as a single multi-arch Docker image. You need Docker (or any
OCI runtime) and one persistent volume. That's it — SQLite and uploaded files
both live under one data directory.

## Quick start (Docker)

```bash
docker run -d --name campfire \
  -p 8080:8080 \
  -v campfire-data:/data \
  -e TZ=America/New_York \
  ghcr.io/awsomefox/campfire:latest
```

Open `http://localhost:8080`. The first visit shows **“Light the fire”** —
create the initial administrator account, and you're in.

!!! tip "That first account"
    The first user you create is the **server admin**. They can immediately run
    a campaign, or hand campaigns off to others — being the admin does not force
    you to be anyone's DM. See [Roles & who does what](roles.md).

## Docker Compose

```yaml
services:
  campfire:
    image: ghcr.io/awsomefox/campfire:latest
    container_name: campfire
    restart: unless-stopped
    init: true                       # graceful shutdown (PID 1 signal handling)
    environment:
      - TZ=America/New_York
      - NODE_ENV=production
      - PORT=8080
      - DATA_DIR=/data
    volumes:
      - /srv/campfire/data:/data     # SQLite db + uploads — back up this one path
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Behind a reverse proxy (Traefik + SSO)

The SPA and API are served **same-origin**, so no CORS configuration is needed.
Put Campfire behind Traefik (or any proxy) for TLS, and optionally in front of an
identity provider. A homelab-style stack with Traefik labels and Authentik OIDC is
documented in [Authentication](../administration/authentication.md).

## Configuration

**Core**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `/data` | SQLite db + uploads (the one volume to back up) |
| `TZ` | `UTC` | Timezone for timestamps |
| `ORIGIN` | *(unset)* | Only needed if you split the SPA onto a different origin; leave unset for the single-image deployment |
| `API_DOCS` | *(unset)* | API docs (`/api/docs`, `/api/openapi.json`) are off in production by default; set `1` to enable them (or `0` to force them off) |

**Reverse proxy & rate limiting**

| Variable | Default | Purpose |
|---|---|---|
| `TRUST_PROXY` | `1` (trust one hop) | Express `trust proxy` setting. Pass a hop count if you sit behind more than one proxy, or `false` to disable. Needed so per-IP rate limiting and `req.ip`/`req.secure` see the real client IP behind a reverse proxy (Traefik in the reference deployment) rather than bucketing every request under the proxy's own address |
| `THROTTLE_DISABLED` | *(unset)* | Set to `1` to fully disable the built-in per-IP rate limiter. Intended for tests; leave unset in production |

**OIDC / SSO** — see [Authentication](../administration/authentication.md) for the full table.

| Variable | Default | Purpose |
|---|---|---|
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | *(unset)* | Enable SSO — all three must be set for OIDC to be considered enabled |
| `OIDC_REDIRECT_URI` | *(derived from `APP_URL`)* | OIDC callback URL, e.g. `https://campfire.example.com/api/v1/auth/oidc/callback` |
| `OIDC_ADMIN_GROUP` | *(unset)* | Members of this IdP group become **server admins** (synced on every login) |
| `OIDC_ALLOWED_GROUP` | *(unset)* | Restrict sign-in to members of this IdP group; others get a 403 and no account is provisioned |
| `OIDC_GROUPS_CLAIM` | `groups` | ID-token claim holding the user's group list |
| `OIDC_SCOPE` | `openid profile email` | Requested OAuth scopes |
| `OIDC_ALLOW_INSECURE` | *(unset)* | Allow OIDC over plain HTTP — dev/testing only, never in production |
| `APP_URL` | `http://localhost:8080` | Only used to build the default `OIDC_REDIRECT_URI` |

**Backups** — see [Backups & upgrades](../administration/operations.md).

| Variable | Default | Purpose |
|---|---|---|
| `BACKUP_SCHEDULE_ENABLED` | *(unset)* | Set to `1` to enable periodic on-disk backups. Off by default |
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between scheduled backups (only when scheduling is enabled) |
| `BACKUP_DIR` | `$DATA_DIR/backups` | Where scheduled backup archives are written (only when scheduling is enabled) |

Local username/password auth works out of the box; OIDC is entirely optional and
layered on when those variables are set.

## Upgrading

Pull a newer image tag and recreate the container. Schema migrations run
automatically on boot and are idempotent. Your `/data` volume carries everything
across the upgrade. See [Backups & upgrades](../administration/operations.md).
