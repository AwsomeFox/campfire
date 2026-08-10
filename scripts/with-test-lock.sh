#!/usr/bin/env sh
#
# Serialize local test runs across every agent session and git worktree on this
# machine, and bound what a single run may consume.
#
# Why: the test suites size themselves against the whole machine and know
# nothing about each other. `apps/server/jest.config.js` asks for 50% of the
# cores with a ~1GB-per-worker recycle threshold, the vitest component tier
# spawns its own pool, and the Playwright browser tier boots a Nest server plus
# Chromium on a fixed port. One run is fine. Four concurrent agent sessions
# running the same commands is tens of gigabytes of resident memory and, for the
# browser tier, two runs silently sharing one seeded backend
# (`reuseExistingServer` in apps/web/playwright.config.ts).
#
# Usage:  scripts/with-test-lock.sh <command> [args...]
#
# Environment:
#   CI                        set  -> pass straight through (single-tenant runner)
#   CAMPFIRE_TEST_LOCK_HELD   set  -> pass straight through (already inside a lock)
#   CAMPFIRE_TEST_LOCK        lock path            (default /tmp/campfire-test.lock)
#   CAMPFIRE_TEST_LOCK_WAIT   seconds to wait      (default 3600, then exit 75)
#   CAMPFIRE_TEST_HEAP_MB     per-process V8 heap  (default 2048)
#   JEST_MAX_WORKERS          jest workers         (default 4)
#   VITEST_MAX_WORKERS        vitest workers       (default 4)
#
set -eu

if [ "$#" -eq 0 ]; then
  echo "with-test-lock: no command given" >&2
  exit 64
fi

# CI runners are single-tenant and sized by the workflow. Never lock or re-cap
# there — the caps below are tuned for a developer machine hosting several agent
# sessions, not for a 2-core hosted runner.
if [ -n "${CI:-}" ] || [ -n "${CAMPFIRE_TEST_LOCK_HELD:-}" ]; then
  exec "$@"
fi

LOCK="${CAMPFIRE_TEST_LOCK:-/tmp/campfire-test.lock}"
WAIT="${CAMPFIRE_TEST_LOCK_WAIT:-3600}"
POLL=5

# Both acquire paths are atomic against concurrent callers and reclaim a lock
# whose holder died (SIGKILL, closed terminal, crashed agent). shlock — present
# on macOS as /usr/bin/shlock — does exactly this; the mkdir path is the POSIX
# fallback for hosts without it.
# Settable to '' to exercise the mkdir fallback on a host that does have shlock;
# otherwise the fallback is unreachable — and so untestable — on macOS.
SHLOCK="${CAMPFIRE_TEST_LOCK_SHLOCK-$(command -v shlock 2>/dev/null || true)}"

# The two paths leave different shapes on disk — shlock writes a padded pid into
# a regular file, the fallback writes one into $LOCK/pid — and a host can move
# between them (shlock installed, removed, or a lock left by an older run). Read
# whichever shape is actually there, or a wrapper that finds the other one waits
# out the full timeout on a lock it can neither read nor reclaim.
holder_pid() {
  if [ -d "$LOCK" ]; then
    pid=$(tr -d '[:space:]' <"$LOCK/pid" 2>/dev/null || true)
  elif [ -e "$LOCK" ]; then
    pid=$(tr -d '[:space:]' <"$LOCK" 2>/dev/null || true)
  else
    pid=''
  fi
  # Anything non-numeric is not a pid we may safely test with kill -0.
  case "$pid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  echo "$pid"
}

reclaim_if_stale() {
  stale_pid=$(holder_pid) || return 1
  if kill -0 "$stale_pid" 2>/dev/null; then return 1; fi
  rm -rf "$LOCK"
  return 0
}

acquire() {
  if [ -n "$SHLOCK" ]; then
    # shlock reclaims a stale lock of its own shape; a leftover directory is the
    # one case it cannot create over.
    if [ -d "$LOCK" ]; then reclaim_if_stale || true; fi
    if "$SHLOCK" -f "$LOCK" -p $$; then return 0; else return 1; fi
  fi
  if mkdir "$LOCK" 2>/dev/null; then
    echo $$ >"$LOCK/pid"
    return 0
  fi
  reclaim_if_stale || true
  return 1
}

release() {
  if [ -n "$SHLOCK" ]; then
    rm -f "$LOCK"
  else
    rm -rf "$LOCK"
  fi
}

waited=0
until acquire; do
  if [ "$waited" -ge "$WAIT" ]; then
    echo "with-test-lock: gave up after ${WAIT}s waiting for $LOCK" >&2
    exit 75
  fi
  if [ "$waited" -eq 0 ]; then
    echo "with-test-lock: another test run holds $LOCK — waiting..." >&2
  fi
  sleep "$POLL"
  waited=$((waited + POLL))
done

trap 'release' EXIT INT TERM HUP

# Inherited by everything below, including nested `npm run` hops, so an
# aggregate script (`test:all`) that calls wrapped leaf scripts does not
# deadlock against the lock it is already holding.
export CAMPFIRE_TEST_LOCK_HELD=1

# Backstops, not the primary defence: the lock is what keeps runs apart, but if
# one is ever bypassed these keep a single run from taking the machine down.
export JEST_MAX_WORKERS="${JEST_MAX_WORKERS:-4}"
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-4}"
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${CAMPFIRE_TEST_HEAP_MB:-2048}"

set +e
"$@"
status=$?
set -e
exit "$status"
