#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
# Compose rather than replace: assigning NODE_OPTIONS outright would drop
# whatever scripts/with-test-lock.sh exported and pin the heap at 4096 even when
# a caller asked for less. Instrumented coverage needs more headroom than the
# other tiers, so 4096 stays the default, but CAMPFIRE_TEST_HEAP_MB wins when set
# (V8 takes the last --max-old-space-size on the line).
NODE_OPTIONS="${NODE_OPTIONS:-} --experimental-vm-modules --max-old-space-size=${CAMPFIRE_TEST_HEAP_MB:-4096}" \
  jest --config jest.unit.config.js --coverage "$@"
