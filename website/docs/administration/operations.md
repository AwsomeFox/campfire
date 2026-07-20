# Backups & upgrades

## The one thing to back up

Everything Campfire stores — the SQLite database (`DATA_DIR/campfire.db`) **and**
uploaded images (portraits, maps) — lives under the **data volume** (`DATA_DIR`,
default `/data`). Back up that one path and you have the whole server.

!!! warning "Back up consistently"
    SQLite runs in WAL mode, so a naive `cp` of a live database can catch a torn
    write. Use one of the consistent methods below (the built-in backup archive,
    or `sqlite3 <db> ".backup <dest>"`), or stop the container before copying.

## Whole-server backup & restore

Campfire has a built-in, **server-admin-only** backup for the entire server. It's
exposed over the REST API (use `curl`, the API docs, or your own script with a
server-admin session or API token):

- **`GET /api/v1/backup`** — downloads a single `.zip` containing a **WAL-safe hot
  snapshot** of the database (taken with SQLite `VACUUM INTO`, so it never blocks
  writers and never ships a torn WAL) plus every uploaded file, with a
  `manifest.json`. Safe to run against a live server.
- **`POST /api/v1/backup/restore`** — multipart upload with the archive as field
  `file` and a field `confirm` set to `RESTORE`. **Destructive**: it validates the
  archive, then replaces the live database and uploads and re-opens the DB in place.
  A malformed or foreign archive is rejected (`400`) with the running server left
  untouched, and the whole thing is gated behind server-admin plus the explicit
  `confirm` token so it can't fire by accident.

Example — download an archive with an API token:

```bash
curl -fSL -H "Authorization: Bearer $CAMPFIRE_TOKEN" \
  https://campfire.example.com/api/v1/backup -o campfire-backup.zip
```

### Scheduled backups

Off by default. Set `BACKUP_SCHEDULE_ENABLED=1` and Campfire writes a fresh archive
(the same format as the download endpoint) to `BACKUP_DIR` (default
`$DATA_DIR/backups`) every `BACKUP_INTERVAL_HOURS` (default `24`). Because these land
on the same volume, copy them off-box for real disaster recovery.

## Per-campaign export

Any DM can export their campaign from **Campaign settings → Export** as **JSON**
(complete, machine-readable) or a **Markdown zip** (human-readable). Good for
archiving a finished campaign or moving it — but it is per-campaign, not a
whole-server backup.

## Upgrading

1. **Take a backup first** (see below).
2. Pull a newer image tag.
3. Recreate the container against the same data volume.

Schema migrations run **automatically on boot** and are idempotent — the server
applies any pending in-place migrations (the `migrate*` steps in
`db/db.module.ts`) before it starts serving, and your data carries across untouched.
There's no separate migration command to run.

!!! warning "Back up before every upgrade"
    Migrations run automatically and aren't gated behind a healthy backup, so a bad
    migration against an un-backed-up volume is the one genuinely unrecoverable
    scenario. Always snapshot the database **before** you start a new image:

    1. Pull the whole-server archive with `GET /api/v1/backup` (WAL-safe, works on a
       running server) and store it off-box, **or** stop the container and copy the
       `DATA_DIR` volume (including `campfire.db`) aside.
    2. Then pull the new image and recreate the container.
    3. If the new version fails to boot or a migration misbehaves, roll back by
       restoring the archive (`POST /api/v1/backup/restore`) or by putting the copied
       volume back and starting the previous image tag.

    Migrations only ever move the schema **forward**, so a downgrade after a
    successful migration is not supported — the pre-upgrade snapshot is your rollback
    path.

## Health

Campfire exposes two unauthenticated health endpoints:

- `GET /healthz` — **liveness**: always 200 while the process is up; never touches
  the database. It reports `{ ok: true, version }`.
- `GET /readyz` — **readiness**: runs a real `SELECT 1` against SQLite and answers
  503 (`{ ok: false, version, error }`) when the database is locked, corrupted, or
  its volume is unavailable. The provided Docker `HEALTHCHECK` and compose setup
  target this endpoint, so a broken DB marks the container unhealthy.
