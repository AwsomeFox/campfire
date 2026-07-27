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

### Streaming, space, and cancellation

Campfire serializes archive creation and restore work: if another archive operation is busy,
wait and retry rather than starting a competing in-memory export. Downloads are streamed from
the server, and restores are staged on disk before the live database and uploads are replaced.
The current fixed safety limits are **1 GiB compressed archive**, **512 MiB per entry**,
**4 GiB total uncompressed data**, and **100,000 entries**. These limits cannot be changed
with environment variables.

Leave temporary disk capacity for the received ZIP and its extracted staging directory in
addition to the live data. Validation failures and cancellation clean up staging/partial server
artifacts and leave the live install unchanged. Cancelling from the admin UI aborts the browser
request; it does not guarantee that work the server has already begun can be interrupted.

For downloads, the admin UI streams directly to the chosen file with the browser File System
Access API when available, showing bytes received and total size when supplied. Browsers that
lack it have to buffer the finished archive in browser memory; that fallback is explicitly
limited to **512 MiB** and reported in the UI. Use `curl` or a File System Access-capable browser
for larger archives. When cancelling a direct-to-file export, the UI asks the browser writable
stream to discard its partial file; confirm the destination is clean if the browser reports an
interrupted write.

### Which export profiles stream

Whole-server backups and campaign downloads under the **backup** profile preflight-stage
immutable attachment copies on temporary disk before emitting any ZIP entries. The archive then
reads those filesystem paths, keeping attachment bytes out of the server heap. Size server
temporary disk for the staged copies. Campaign downloads stream the ZIP to the browser or other
archive destination without retaining that final archive on server disk, so that destination needs
the final-archive capacity; scheduled whole-server backups instead retain the final archive in
`BACKUP_DIR`, which needs that capacity in addition to staging space.

The **handoff** and **publish** profiles must strip embedded metadata (EXIF/XMP) before an
attachment may travel, and bytes cannot be sanitized without being read. Each attachment is
therefore read, sanitized, and written straight into the export's staging directory, so only
one attachment is held in memory at a time rather than all of them. Peak heap for those
profiles is bounded by the largest single attachment, not by the size of the campaign.

### Restore is stricter than it used to be

Restore now validates each archive against its manifest before touching live data: every
upload's recorded size and SHA-256 must match the bytes in the archive, `uploadCount` must
equal the number of attachment entries, and every attachment named in the manifest must be
present. Archives that have been hand-edited, truncated by an interrupted transfer, or
assembled by hand may therefore be rejected with a `400` where an older Campfire accepted
them. This is deliberate — silently restoring an incomplete archive is worse than refusing
it — but it means **you should verify existing archives now, not during a recovery**. Run
`Inspect (dry-run)` against your most recent archives after upgrading; inspection uses the
same validation as restore and changes nothing.

Cancelling a restore is honoured up to the moment the live database and uploads are
replaced; a cancellation observed before that boundary tears down staging and leaves the
install untouched.

### Temporary disk capacity

A backup's peak temporary usage is the database snapshot **plus a full staged copy of the
uploads tree** plus the archive being written — not just the size of the finished archive.
Hosts with a small or `tmpfs`-backed `/tmp` should size accordingly, or point `TMPDIR` at a
larger volume.

When `BACKUP_DIR` and the staging directory are on the **same filesystem**, both allocations
are live at once, so the scheduled-backup preflight reserves their combined peak rather than
checking each independently. `BACKUP_MIN_FREE_BYTES` is the free space that must remain
*after* that peak. If the two are on different filesystems each is checked against its own
budget.

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

Scheduled backups now have retention and free-space protection:

- `BACKUP_KEEP_COUNT` (default `14`) keeps the newest verified archives; set `0` to
  disable count pruning.
- `BACKUP_KEEP_DAYS` (default `30`) prunes verified archives older than that age; set
  `0` to disable age pruning.
- `BACKUP_MAX_TOTAL_BYTES` (unset by default) caps total scheduled-backup bytes by
  pruning oldest verified, unprotected archives first.
- `BACKUP_MIN_FREE_BYTES` (default `536870912`, 512 MiB) reserves disk space. Before
  writing, Campfire estimates the next archive from the last successful backup (or
  current DB/uploads size on first run). If the estimate would breach the reserve, the
  run is skipped, `backup.cadence.lastError` is stamped, and the next attempt backs off.
- `BACKUP_PROTECT_LAST_GOOD` (default `true`) prevents retention from deleting the most
  recent manifest-verified scheduled archive.

Retention only deletes archives that pass zip/manifest parsing and clean reconciliation.
Malformed or partial archives stay on disk for operator review. To protect a specific
archive from local pruning, place a sidecar marker next to the zip: `.pin` or `.keep` for
a local pin, or `.offsite` after you have copied it to protected off-box storage.
Server admins can see disk free/reserve, retention policy/metrics, and low-disk/prune
alerts in the backup card.

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

### Behaviour change: AI scribe member consent

Installs running the **AI scribe against an external AI provider** will see a change after
upgrading to the release that adds member consent controls.

Every campaign gains an AI content policy defaulting to `member_consent`, and every
existing membership gains a per-member consent flag defaulting to **off** — the
fail-closed default, since nobody can retroactively consent on a player's behalf.

**What you will observe**

- With an **external AI provider configured**, scribe recaps stop including
  member-authored inbox notes until each author opts in. A run whose material was
  entirely withheld records `no_material` and reports *"N notes withheld pending author
  consent"* rather than failing silently — visible in the scribe panel and in the run's
  job history.
- With **no provider configured** — the default self-hosted install, using the shipped
  no-op provider — **nothing changes** for scribe recaps. Consent gates external use only,
  and that path sends nothing off the server.
- **Connected MCP agents are always treated as external.** The `draft_session_recap` tool
  hands raw note bodies to whatever agent called it, and Campfire cannot see what that
  agent is, so it applies the consent gate unconditionally. A DM using a local MCP client
  will get an empty inbox in that tool's source material until members opt in; the tool's
  `consent` block reports what was withheld and why.
- Members no longer see each other's consent state on the roster. The DM still sees
  everyone's (needed to explain a withheld recap), and each member still sees their own.
- **The first scribe run after upgrading re-drafts rather than skipping.** The assembled
  source material changed shape, so its idempotency hash differs from the one recorded
  before the upgrade and a run over otherwise-unchanged material will not report
  *"identical source already drafted"*. This is one-time; subsequent runs skip as usual.

**What members and DMs need to do**

1. Each member opens **Members** in their campaign and ticks *"Allow external AI use of my
   authored source notes"*. This is self-service by design: a DM cannot set it for
   someone else.
2. A DM who wants no member notes sent at all can set the campaign policy to `disabled`
   in campaign settings.
3. If your configured provider is a model running on your own box and you want generations
   through it treated as local rather than external, set `AI_PROVIDER_ENDPOINT_IS_LOCAL=1`
   (defaults to off).

See [Member consent for external AI use](../ai/capabilities.md#member-consent-for-external-ai-use)
for the full model.

## Health

Campfire exposes two unauthenticated health endpoints:

- `GET /healthz` — **liveness**: always 200 while the process is up; never touches
  the database. It reports `{ ok: true, version }`.
- `GET /readyz` — **readiness**: runs a real `SELECT 1` against SQLite and answers
  503 (`{ ok: false, version, error }`) when the database is locked, corrupted, or
  its volume is unavailable. The provided Docker `HEALTHCHECK` and compose setup
  target this endpoint, so a broken DB marks the container unhealthy.
