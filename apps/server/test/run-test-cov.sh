#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
nest build
NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=4096" \
  jest --coverage --runInBand --coverageThreshold='{}' "$@"
node test/finalize-oidc-spawn-coverage.cjs
