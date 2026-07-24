# Backups & upgrades

## The one thing to back up

Everything Campfire stores — the SQLite database (`DATA_DIR/campfire.db`) **and**
uploaded images (portraits, maps) — lives under the **data volume** (`DATA_DIR`,
default `/data`). Back up that one path and you have the whole server.

!!! warning "Back up consistently"
    SQLite runs in WAL mode, so a naive `cp` of a **live** database can catch a torn
    write — and can miss data entirely: recent writes live in the `campfire.db-wal`
    sidecar until they're checkpointed into the main file, so copying `campfire.db`
    on its own can hand you a near-empty database. The built-in backup archive (or
    `sqlite3 <db> ".backup <dest>"`) is the recommended path — both are WAL-safe on a
    running server. If you'd rather copy files directly, **stop the container first**:
    Campfire checkpoints the WAL into `campfire.db` and closes the database on
    graceful shutdown (`docker stop`/SIGTERM), so a plain copy of the stopped data
    volume — `campfire.db` included — is complete and restorable.

## Whole-server backup & restore

Campfire has a built-in, **server-admin-only** backup for the entire server. It's
exposed over the REST API (use `curl`, the API docs, or your own script with a
server-admin session or API token):

- **`GET /api/v1/backup`** — downloads a single `.zip` containing a **WAL-safe hot
  snapshot** of the database (taken with SQLite `VACUUM INTO`, so it never blocks
  writers and never ships a torn WAL) plus every uploaded file, with a
  `manifest.json`. Safe to run against a live server.
- **`POST /api/v1/backup/download`** — same archive as the GET endpoint, but accepts
  an optional `keyPassphrase` in the JSON body (≥12 characters) so the auto-generated
  `ai-config.key` can be wrapped in an encrypted envelope for credential-portable
  restores. Passphrases must not be sent in query strings.
- **`POST /api/v1/backup/restore`** — multipart upload with the archive as field
  `file` and a field `confirm` set to `RESTORE`. When the archive includes an AI
  keyfile envelope, also pass `keyPassphrase` with the passphrase used when the
  backup was created. **Destructive**: it validates the archive, then replaces the
  live database and uploads and re-opens the DB in place.
  A malformed or foreign archive is rejected (`400`) with the running server left
  untouched, and the whole thing is gated behind server-admin plus the explicit
  `confirm` token so it can't fire by accident.

- **`POST /api/v1/backup/inspect`** — multipart upload with the archive as field
  `file`. **Non-destructive**: parses `manifest.json` and lists upload paths so
  you can verify app version, schema revision, format version, creation time, and
  contents before restoring.

### Backup manifest compatibility

Each archive includes a `manifest.json` with:

| Field | Meaning |
| --- | --- |
| `version` | **Format version** — how the zip is laid out and how fields are interpreted (integer, bumped only when the archive shape changes). |
| `appVersion` | Campfire app semver that produced the backup. |
| `schemaVersion` | Number of recorded DB migrations at backup time (a coarse schema revision). |
| `createdAt` | ISO timestamp when the archive was built. |

**Restore policy:**

- The server accepts any format version it knows how to **migrate** forward to the
  current layout (today: format `1` for plain archives, format `2` for archives that
  include a passphrase-encrypted AI keyfile envelope via
  `POST /api/v1/backup/download` or `BACKUP_KEY_PASSPHRASE`, and legacy archives with
  no `version` field treated as format `0` and migrated).
- If `version` is **newer** than this server understands, restore fails with `400`
  **before** the live database or uploads are touched. When the archive includes
  `minCampfireVersion`, the error tells you the minimum Campfire release required.
  Older Campfire releases that only understand format `1` will reject format-`2`
  envelope archives rather than silently restoring the DB without its credential key.
- Format version is independent of DB schema migrations: upgrading Campfire still runs
  in-place migrations on boot after a restore, but you cannot restore a backup whose
  manifest format is from a newer Campfire build until you upgrade the app.

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

## Per-campaign export & import

Any DM can export their campaign from **Campaign settings → Export** as **JSON**
(complete, machine-readable) or a **Markdown zip** (human-readable). Good for
archiving a finished campaign or moving it — but it is per-campaign, not a
whole-server backup.

The **JSON** export round-trips: any authenticated user can **import** it
(`POST /api/v1/campaigns/import`, or from the campaign hub) to recreate the campaign
with fresh ids and every internal reference remapped, becoming its DM. Imported player
characters come in unowned, and members, audit history and proposals are not carried
over. This is how you move a campaign between servers.

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
