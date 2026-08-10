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
# How: an exclusive flock(2) on $CAMPFIRE_TEST_LOCK, taken before the command
# runs. The kernel owns the lock, which is what makes this simple — it is
# released the moment the holder exits, including on SIGKILL, so there is no
# lockfile to go stale, no pid to publish, and no recovery path to get wrong.
# An earlier revision of this script hand-rolled a mkdir-based lock with pid
# files and stale reclamation; every interesting bug in review came from that
# machinery rather than from the locking itself.
#
# The lock is taken and then the command is exec'd *in place*, so the test
# process itself holds the lock: signals from the terminal or a supervisor reach
# it directly, its exit status is reported unchanged, and there is no wrapper
# process left in the middle to forward either.
#
# Known limit: processes *forked* by the command inherit the open file
# description and extend the lock, but Node's child_process closes descriptors
# it was not told to pass, so jest and Playwright workers do not hold it. If the
# top-level runner dies abnormally and a worker outlives it, the lock frees
# while that worker is still running. Closing that would need a supervisor
# waiting on the whole process tree: a supervisor waiting only on its immediate
# child does not help (it releases at the same moment), and process-group
# tracking is not portable — dash gives a background child no group of its own —
# while reintroducing the signal-forwarding gap this exec exists to avoid. In
# normal operation a runner does not exit before its workers, so this needs an
# abnormal death plus a surviving orphan.
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
#
# CAMPFIRE_TEST_LOCK_HELD is what keeps an aggregate script (`test:all`) that
# calls wrapped leaf scripts from deadlocking: flock is per open file
# description, so a nested wrapper would block on a lock its own parent holds.
if [ -n "${CI:-}" ] || [ -n "${CAMPFIRE_TEST_LOCK_HELD:-}" ]; then
  exec "$@"
fi

LOCK="${CAMPFIRE_TEST_LOCK:-/tmp/campfire-test.lock}"
WAIT="${CAMPFIRE_TEST_LOCK_WAIT:-3600}"

# A malformed wait would otherwise disable the timeout entirely (alarm 0).
case "$WAIT" in
  '' | *[!0-9]*) WAIT=3600 ;;
esac

# Inherited by everything below, including nested `npm run` hops.
export CAMPFIRE_TEST_LOCK_HELD=1

# Backstops, not the primary defence: the lock is what keeps runs apart, but if
# one is ever bypassed these keep a single run from taking the machine down.
export JEST_MAX_WORKERS="${JEST_MAX_WORKERS:-4}"
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-4}"
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${CAMPFIRE_TEST_HEAP_MB:-2048}"

# perl is preferred over flock(1) because it can take the lock and then exec the
# command in place. flock(1) stays a parent process, so a signal aimed at it
# does not reach the test command. perl ships with macOS; flock(1) covers hosts
# that have util-linux but no perl.
if command -v perl >/dev/null 2>&1; then
  exec perl -e '
    use strict;
    use Fcntl qw(:flock F_SETFD);
    my $path = shift @ARGV;
    my $wait = shift @ARGV;
    open(my $fh, ">>", $path) or die "with-test-lock: cannot open $path: $!\n";
    # Clear close-on-exec on this descriptor specifically, so the lock survives
    # the exec below. Not $^F, which only covers descriptors up to its value:
    # with fds 3..10 already inherited, perl would hand back fd 11 and the lock
    # would be silently dropped the moment the test started.
    fcntl($fh, F_SETFD, 0) or die "with-test-lock: cannot clear close-on-exec: $!\n";
    unless (flock($fh, LOCK_EX | LOCK_NB)) {
      # A zero wait means "do not queue": report the conflict now rather than
      # falling through to a blocking flock, which alarm 0 would never interrupt.
      if ($wait == 0) {
        warn "with-test-lock: another test run holds $path — not waiting\n";
        exit 75;
      }
      warn "with-test-lock: another test run holds $path — waiting...\n";
      $SIG{ALRM} = sub {
        warn "with-test-lock: gave up after ${wait}s waiting for $path\n";
        exit 75;
      };
      alarm $wait;
      flock($fh, LOCK_EX) or die "with-test-lock: cannot lock $path: $!\n";
      alarm 0;
    }
    exec { $ARGV[0] } @ARGV or die "with-test-lock: cannot run $ARGV[0]: $!\n";
  ' "$LOCK" "$WAIT" "$@"
fi

if command -v flock >/dev/null 2>&1; then
  # -F/--no-fork execs the command in place, matching the perl path above, so a
  # signal aimed at the wrapper reaches the test rather than a parent flock that
  # merely waits on it. The flag postdates util-linux 2.30, so fall back to the
  # forking form where it is unavailable.
  if flock --help 2>&1 | grep -q -- '--no-fork'; then
    exec flock -E 75 -w "$WAIT" -F "$LOCK" "$@"
  fi
  exec flock -E 75 -w "$WAIT" "$LOCK" "$@"
fi

echo "with-test-lock: neither perl nor flock(1) found — running WITHOUT the lock." >&2
echo "with-test-lock: concurrent test runs on this host will not be serialized." >&2
exec "$@"
