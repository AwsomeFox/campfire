#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
nest build
set +e
NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=4096" \
  jest --coverage --runInBand --coverageThreshold='{}' "$@"
JEST_EXIT=$?
set -e
node test/finalize-oidc-spawn-coverage.cjs
FINAL_EXIT=$?
if [ "$FINAL_EXIT" -ne 0 ]; then
  exit "$FINAL_EXIT"
fi
exit "$JEST_EXIT"
