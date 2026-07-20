#!/usr/bin/env bash

set -euo pipefail

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." >/dev/null 2>&1
  pwd
}

supabase_cli() {
  if command -v supabase >/dev/null 2>&1; then
    supabase "$@"
    return
  fi

  npx --yes supabase@2.109.1 "$@"
}

require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "[supabase] Missing required environment variable: ${key}" >&2
    exit 1
  fi
}

has_checked_in_migrations() {
  local root
  root="$(repo_root)"
  compgen -G "${root}/supabase/migrations/*.sql" >/dev/null
}

has_database_tests() {
  local root
  root="$(repo_root)"
  find "${root}/supabase/tests/database" -type f -name '*.sql' -print -quit | grep -q .
}

require_docker_daemon() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "[supabase] Docker is required for local database validation." >&2
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "[supabase] Docker is installed but the daemon is not running." >&2
    echo "[supabase] Start Docker Desktop, then rerun ./scripts/supabase/validate-local.sh." >&2
    exit 1
  fi
}
