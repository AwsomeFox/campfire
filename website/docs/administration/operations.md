# Backups & upgrades

## The one thing to back up

Everything Campfire stores — the SQLite database **and** uploaded images (portraits,
maps) — lives under the **data volume** (`DATA_DIR`, default `/data`). Back up that
one path and you have the whole server.

!!! warning "Back up consistently"
    SQLite runs in WAL mode, so a naive copy of a live database can catch a torn
    write. For a consistent backup, either stop the container first, or use
    `sqlite3 <db> ".backup <dest>"` to snapshot it safely.

_(An in-app backup button, scheduling, and a whole-server restore/import flow are on
the [roadmap](../reference/roadmap.md); today backup is a volume copy, and
per-campaign JSON/Markdown export is available from Campaign settings.)_

## Per-campaign export

Any DM can export their campaign from **Campaign settings → Export** as **JSON**
(complete, machine-readable) or a **Markdown zip** (human-readable). Good for
archiving a finished campaign or moving it.

## Upgrading

1. Pull a newer image tag.
2. Recreate the container against the same data volume.

Schema migrations run automatically on boot and are idempotent — your data carries
across untouched. There's no separate migration step to run.

## Health

Campfire exposes `GET /healthz` for your orchestrator's health checks (the provided
Docker/compose setup already wires it). It reports `{ ok: true, version }`.
