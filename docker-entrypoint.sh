#!/bin/sh
set -e

# Self-healing privilege drop (issues #118 + the readonly-DB regression):
# the app must run as the unprivileged `node` user, but a /data volume created by a
# pre-non-root release is root-owned — which makes SQLite read-only and crash-loops boot
# ("attempt to write a readonly database"). When started as root, fix the volume's
# ownership and then drop to `node` so ONLY this tiny bootstrap is privileged; the Node
# process itself never runs as root. When already started as an unprivileged user
# (e.g. compose `user:` override), just exec through.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  exec gosu node:node "$@"
fi

exec "$@"
