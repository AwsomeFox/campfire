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

# `mkdir` is the whole mutex: it either creates the directory or fails,
# atomically, against any number of concurrent callers. Deliberately not shlock,
# even though macOS ships it — its own stale-lock handling is the same
# check-then-unlink shown to race below, and it would leave a second on-disk
# shape (a padded pid in a regular file) for this script to interpret.
REAPER="$LOCK.reaper"

holder_pid() {
  if [ -d "$LOCK" ]; then
    pid=$(tr -d '[:space:]' <"$LOCK/pid" 2>/dev/null || true)
  elif [ -e "$LOCK" ]; then
    # A regular file at this path is a lock from an older revision of this
    # script, which wrote the pid there directly.
    pid=$(tr -d '[:space:]' <"$LOCK" 2>/dev/null || true)
  else
    pid=''
  fi
  # Anything non-numeric is not a pid we may safely test with kill -0, so the
  # lock is waited out rather than guessed at and stolen.
  case "$pid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  echo "$pid"
}

# Reclaiming a dead holder's lock has to be exclusive, not merely careful.
# Checking the pid and then deleting is two steps: two waiters can both see the
# same dead pid, the first deletes and acquires, and the second's delete then
# removes a lock the first now legitimately holds — handing the next waiter a
# lock while a test run is live, which is the exact overlap this script exists
# to prevent. Creating $REAPER is the atomic gate. While it is held nobody else
# can remove $LOCK, so the pid re-read below cannot be invalidated between the
# read and the rm.
reclaim_if_stale() {
  stale_pid=$(holder_pid) || return 1
  if kill -0 "$stale_pid" 2>/dev/null; then return 1; fi
  mkdir "$REAPER" 2>/dev/null || return 1
  current_pid=$(holder_pid) || current_pid=''
  if [ "$current_pid" = "$stale_pid" ] && ! kill -0 "$stale_pid" 2>/dev/null; then
    rm -rf "$LOCK"
  fi
  rmdir "$REAPER" 2>/dev/null || true
  return 0
}

acquire() {
  if mkdir "$LOCK" 2>/dev/null; then
    echo $$ >"$LOCK/pid"
    return 0
  fi
  reclaim_if_stale || true
  return 1
}

release() {
  rm -rf "$LOCK"
}

waited=0
until acquire; do
  if [ "$waited" -ge "$WAIT" ]; then
    echo "with-test-lock: gave up after ${WAIT}s waiting for $LOCK" >&2
    echo "with-test-lock: if no test run is actually active, remove $LOCK and $REAPER" >&2
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
