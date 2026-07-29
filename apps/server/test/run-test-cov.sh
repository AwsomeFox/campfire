#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=4096" \
  jest --config jest.unit.config.js --coverage "$@"
