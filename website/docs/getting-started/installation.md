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
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
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

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `/data` | SQLite db + uploads (the one volume to back up) |
| `TZ` | `UTC` | Timezone for timestamps |
| `ORIGIN` | *(unset)* | Only needed if you split the SPA onto a different origin; leave unset for the single-image deployment |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | *(unset)* | Enable SSO — see [Authentication](../administration/authentication.md) |
| `OIDC_ADMIN_GROUP` | *(unset)* | Members of this IdP group become server admins on login |

Local username/password auth works out of the box; OIDC is entirely optional and
layered on when those variables are set.

## Upgrading

Pull a newer image tag and recreate the container. Schema migrations run
automatically on boot and are idempotent. Your `/data` volume carries everything
across the upgrade. See [Backups & upgrades](../administration/operations.md).
