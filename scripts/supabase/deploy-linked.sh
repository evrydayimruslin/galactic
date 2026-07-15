#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/supabase/_lib.sh
source "${SCRIPT_DIR}/_lib.sh"

ROOT="$(repo_root)"

require_env "SUPABASE_ACCESS_TOKEN"
require_env "SUPABASE_PROJECT_ID"
require_env "SUPABASE_DB_PASSWORD"

ENV_NAME="${SUPABASE_ENV_NAME:-remote}"

if ! has_checked_in_migrations; then
  echo "[supabase] No checked-in migrations yet; skipping ${ENV_NAME} deploy."
  exit 0
fi

echo "[supabase] Linking ${ENV_NAME} project ${SUPABASE_PROJECT_ID}"
supabase_cli link \
  --project-ref "${SUPABASE_PROJECT_ID}" \
  -p "${SUPABASE_DB_PASSWORD}" \
  --workdir "${ROOT}" \
  --yes

DB_PUSH_ARGS=(
  --linked
  -p "${SUPABASE_DB_PASSWORD}"
  --workdir "${ROOT}"
)

# Production can intentionally have a historical migration gap. Crossing it
# must be an explicit operator decision; normal staging and production pushes
# retain the safer default refusal.
if [[ "${SUPABASE_INCLUDE_ALL:-0}" == "1" ]]; then
  DB_PUSH_ARGS+=(--include-all)
fi

# DRY_RUN=1 executes the CLI's real push planner and pushes nothing. This is
# stronger than migration-list output because it also catches a historical gap
# unless the operator explicitly selected SUPABASE_INCLUDE_ALL=1.
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "[supabase] DRY RUN — pending migrations for ${ENV_NAME} (no push):"
  supabase_cli db push "${DB_PUSH_ARGS[@]}" --dry-run
  exit 0
fi

echo "[supabase] Pushing migrations to ${ENV_NAME}"
supabase_cli db push "${DB_PUSH_ARGS[@]}" --yes

echo "[supabase] Migration history after ${ENV_NAME} deploy"
supabase_cli migration list \
  --linked \
  -p "${SUPABASE_DB_PASSWORD}" \
  --workdir "${ROOT}"
