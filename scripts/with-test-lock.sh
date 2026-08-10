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
# The gate is held for a few milliseconds, so a reclaimer killed inside it is
# unlikely — but it would otherwise wedge every future reclaim until someone
# cleared the directory by hand. Recover it only when the owner is gone AND the
# gate has sat for over a minute, which no live critical section ever does.
gate_is_abandoned() {
  gate_pid=$(tr -d '[:space:]' <"$REAPER/pid" 2>/dev/null || true)
  case "$gate_pid" in
    '' | *[!0-9]*) gate_pid='' ;;
  esac
  if [ -n "$gate_pid" ] && kill -0 "$gate_pid" 2>/dev/null; then return 1; fi
  [ -n "$(find "$REAPER" -maxdepth 0 -mmin +1 2>/dev/null)" ] || return 1
  rm -rf "$REAPER"
}

enter_gate() {
  if mkdir "$REAPER" 2>/dev/null; then
    echo $$ >"$REAPER/pid"
    return 0
  fi
  gate_is_abandoned || return 1
  if mkdir "$REAPER" 2>/dev/null; then
    echo $$ >"$REAPER/pid"
    return 0
  fi
  return 1
}

reclaim_if_stale() {
  stale_pid=$(holder_pid) || return 1
  if kill -0 "$stale_pid" 2>/dev/null; then return 1; fi
  enter_gate || return 1
  current_pid=$(holder_pid) || current_pid=''
  if [ "$current_pid" = "$stale_pid" ] && ! kill -0 "$stale_pid" 2>/dev/null; then
    rm -rf "$LOCK"
  fi
  rm -rf "$REAPER"
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

# Only ever delete a lock this process actually owns. Releasing unconditionally
# would let a late or repeated release (the signal path below releases, then the
# EXIT trap runs too) delete a lock another wrapper has since acquired.
release() {
  owner=$(holder_pid) || return 0
  [ "$owner" = "$$" ] || return 0
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

trap 'release' EXIT

# Inherited by everything below, including nested `npm run` hops, so an
# aggregate script (`test:all`) that calls wrapped leaf scripts does not
# deadlock against the lock it is already holding.
export CAMPFIRE_TEST_LOCK_HELD=1

# Backstops, not the primary defence: the lock is what keeps runs apart, but if
# one is ever bypassed these keep a single run from taking the machine down.
export JEST_MAX_WORKERS="${JEST_MAX_WORKERS:-4}"
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-4}"
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${CAMPFIRE_TEST_HEAP_MB:-2048}"

# Run the command as a job this shell can still address after a signal. With the
# child in the foreground, sh defers trap handling until it exits, so a TERM
# aimed at the wrapper alone would neither stop the test nor release the lock,
# and the wrapper would then report the finished child's status as if the
# cancelled run had succeeded. Job control puts the child in its own process
# group so the signal reaches its workers too.
set -m 2>/dev/null || true
"$@" &
child=$!

# Always forward as TERM: a background child in a non-interactive shell has INT
# set to ignore, so re-sending INT would not stop it. Signal the child's process
# group when job control gave it one, falling back to the child alone.
stop_child() {
  kill -TERM "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  release
  # Re-raise so the caller sees the wrapper die of the signal, not of a status.
  trap - "$1"
  kill -"$1" $$
}
trap 'stop_child TERM' TERM
trap 'stop_child INT' INT
trap 'stop_child HUP' HUP

set +e
wait "$child"
status=$?
set -e
exit "$status"
