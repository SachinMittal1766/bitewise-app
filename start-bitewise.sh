#!/bin/sh
set -eu

NODE_BIN="/Users/sachinmittalsachin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
exec "$NODE_BIN" "$(dirname "$0")/server.mjs"
