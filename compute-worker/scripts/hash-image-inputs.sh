#!/bin/sh
set -eu

output=${1:?usage: hash-image-inputs.sh OUTPUT_FILE}
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)

cd "$repo_root"
if command -v sha256sum >/dev/null 2>&1; then
  hash_files() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
  hash_files() { shasum -a 256 "$@"; }
else
  echo "sha256sum or shasum is required" >&2
  exit 1
fi

hash_files \
  .dockerignore \
  cli/package.json \
  cli/package-lock.json \
  cli/bin/ultralight.js \
  cli/lib/job-context.mjs \
  cli/lib/mcp-bridge.mjs \
  cli/scripts/postinstall.js \
  cli/mod.ts \
  cli/api.ts \
  cli/colors.ts \
  cli/config.ts \
  cli/logging.ts \
  cli/job-context.ts \
  cli/deno.lock \
  cli/skills.md \
  compute-worker/images/standard/Dockerfile \
  compute-worker/images/standard/toolchain/package.json \
  compute-worker/images/standard/toolchain/package-lock.json \
  compute-worker/images/standard/bridge/package.json \
  compute-worker/images/standard/bridge/package-lock.json \
  compute-worker/images/standard/bridge/gx-mcp.mjs \
  compute-worker/images/standard/gx.mjs \
  compute-worker/images/standard/entrypoint.sh \
  > "$output"
