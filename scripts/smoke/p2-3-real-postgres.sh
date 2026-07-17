#!/usr/bin/env bash
# P2.3 disposable real-Postgres certification.
#
# This intentionally exercises the database RPCs through independent psql
# sessions. Every row carries unique UUIDs and a run marker, and the EXIT trap
# removes only those exact fixtures. The connection string is never printed.

set -Eeuo pipefail
umask 077

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required." >&2
  exit 2
fi
if [[ "$DATABASE_URL" != postgres://* && "$DATABASE_URL" != postgresql://* ]]; then
  echo "DATABASE_URL must be a PostgreSQL connection URL." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required." >&2
  exit 2
fi

new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
    return
  fi
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    tr '[:upper:]' '[:lower:]' < /proc/sys/kernel/random/uuid
    return
  fi
  echo "uuidgen or /proc/sys/kernel/random/uuid is required." >&2
  return 1
}

RUN_UUID="$(new_uuid)"
RUN_TOKEN="${RUN_UUID//-/}"
RUN_TOKEN="${RUN_TOKEN:0:16}"
BARRIER_KEY_NAMESPACE=$((16#${RUN_TOKEN:0:7}))
RUN_MARKER="p23-smoke-${RUN_TOKEN}"
FREE_USER_ID="$(new_uuid)"
PRO_USER_ID="$(new_uuid)"
FREE_AGENT_A_ID="$(new_uuid)"
FREE_AGENT_B_ID="$(new_uuid)"
PRO_AGENT_ID="$(new_uuid)"
FREE_A_PRIMARY_ID="$(new_uuid)"
FREE_A_SIBLING_ID="$(new_uuid)"
FREE_B_PRIMARY_ID="$(new_uuid)"
FREE_B_SIBLING_ID="$(new_uuid)"
FILTERED_ALERT_ID="$(new_uuid)"
GLOBAL_ALERT_ID="$(new_uuid)"
FREE_EMAIL="${RUN_MARKER}-free@example.invalid"
PRO_EMAIL="${RUN_MARKER}-pro@example.invalid"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/galactic-p23-smoke.XXXXXX")"

psql_smoke() {
  local app_name="${PGAPPNAME_OVERRIDE:-galactic-p2.3-smoke:${RUN_MARKER}}"
  PGAPPNAME="$app_name" \
    psql "$DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 "$@"
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e

  psql_smoke --quiet \
    --set=free_user_id="$FREE_USER_ID" \
    --set=pro_user_id="$PRO_USER_ID" \
    --set=free_agent_a_id="$FREE_AGENT_A_ID" \
    --set=free_agent_b_id="$FREE_AGENT_B_ID" \
    --set=pro_agent_id="$PRO_AGENT_ID" \
    --set=free_email="$FREE_EMAIL" \
    --set=pro_email="$PRO_EMAIL" <<'SQL' >/dev/null
SET statement_timeout = '30s';
SET lock_timeout = '15s';
BEGIN;
DELETE FROM public.apps
WHERE (id, owner_id) IN (
  (:'free_agent_a_id'::uuid, :'free_user_id'::uuid),
  (:'free_agent_b_id'::uuid, :'free_user_id'::uuid),
  (:'pro_agent_id'::uuid, :'pro_user_id'::uuid)
);
DELETE FROM public.users
WHERE (id = :'free_user_id'::uuid AND email = :'free_email')
   OR (id = :'pro_user_id'::uuid AND email = :'pro_email');
COMMIT;
SQL
  cleanup_status=$?
  rm -rf "$TMP_ROOT"

  if (( cleanup_status != 0 )); then
    echo "Fixture cleanup failed for run marker ${RUN_MARKER}; operator follow-up is required." >&2
    if (( original_status == 0 )); then
      original_status=$cleanup_status
    fi
  fi
  exit "$original_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "P2.3 smoke failed: $*" >&2
  exit 1
}

run_pair() {
  local sql_a="$1" output_a="$2" error_a="$3"
  local sql_b="$4" output_b="$5" error_b="$6"
  local pid_a pid_b holder_pid
  local status_a=0 status_b=0 holder_status=0
  local holder_ready=0 waiters_ready=0 observed=""
  PAIR_SEQUENCE=$((PAIR_SEQUENCE + 1))
  local barrier_key_a="$BARRIER_KEY_NAMESPACE"
  local barrier_key_b="$PAIR_SEQUENCE"
  local holder_app="g-p23:${RUN_TOKEN}:p${PAIR_SEQUENCE}:holder"
  local app_a="g-p23:${RUN_TOKEN}:p${PAIR_SEQUENCE}:a"
  local app_b="g-p23:${RUN_TOKEN}:p${PAIR_SEQUENCE}:b"
  local barrier_fifo="$TMP_ROOT/barrier-${PAIR_SEQUENCE}.fifo"
  local holder_output="$TMP_ROOT/barrier-${PAIR_SEQUENCE}.out"
  local holder_error="$TMP_ROOT/barrier-${PAIR_SEQUENCE}.err"
  local barrier_acquire_sql

  # Hold a transaction-scoped exclusive advisory lock in a controller session.
  # Each worker requests the matching shared transaction lock before its RPC.
  # This is safe through a session or transaction pooler: every lock is bounded
  # by an explicit transaction and cannot leak when a pooled session is reused.
  mkfifo "$barrier_fifo"
  exec 9<>"$barrier_fifo"
  PGAPPNAME_OVERRIDE="$holder_app" psql_smoke --quiet \
    <"$barrier_fifo" >"$holder_output" 2>"$holder_error" &
  holder_pid=$!
  {
    echo "BEGIN;"
    echo "SET LOCAL statement_timeout = '45s';"
    printf "DO \$barrier\$ BEGIN PERFORM pg_advisory_xact_lock(%s, %s); END \$barrier\$;\n" \
      "$barrier_key_a" "$barrier_key_b"
  } >&9

  for _ in {1..100}; do
    if ! kill -0 "$holder_pid" 2>/dev/null; then
      break
    fi
    observed="$(psql_smoke --quiet --tuples-only --no-align \
      --set=barrier_key_a="$barrier_key_a" \
      --set=barrier_key_b="$barrier_key_b" <<'SQL'
SELECT count(*)
FROM pg_catalog.pg_locks AS held
WHERE held.locktype = 'advisory'
  AND held.classid = :'barrier_key_a'::oid
  AND held.objid = :'barrier_key_b'::oid
  AND held.objsubid = 2
  AND held.granted
  AND held.mode = 'ExclusiveLock';
SQL
)" || observed=""
    if [[ "$observed" == "1" ]]; then
      holder_ready=1
      break
    fi
    sleep 0.1
  done

  if (( holder_ready != 1 )); then
    printf 'ROLLBACK;\n\\q\n' >&9 2>/dev/null || true
    exec 9>&-
    wait "$holder_pid" || holder_status=$?
    echo "Concurrent barrier controller failed to acquire its lock (status=${holder_status})." >&2
    [[ -s "$holder_error" ]] && sed -n '1,40p' "$holder_error" >&2
    return 1
  fi

  barrier_acquire_sql="BEGIN; SET LOCAL statement_timeout = '45s'; DO \$barrier\$ BEGIN PERFORM pg_advisory_xact_lock_shared($barrier_key_a, $barrier_key_b); END \$barrier\$;"
  PGAPPNAME_OVERRIDE="$app_a" psql_smoke --quiet --tuples-only --no-align \
    --field-separator='|' --command="$barrier_acquire_sql" \
    --file="$sql_a" --command='COMMIT;' >"$output_a" 2>"$error_a" &
  pid_a=$!
  PGAPPNAME_OVERRIDE="$app_b" psql_smoke --quiet --tuples-only --no-align \
    --field-separator='|' --command="$barrier_acquire_sql" \
    --file="$sql_b" --command='COMMIT;' >"$output_b" 2>"$error_b" &
  pid_b=$!

  # Do not release the controller until both independent backends are proven
  # blocked on this run's exact advisory key. This makes the race deterministic
  # instead of merely starting two local processes close together.
  for _ in {1..100}; do
    observed="$(psql_smoke --quiet --tuples-only --no-align \
      --set=barrier_key_a="$barrier_key_a" \
      --set=barrier_key_b="$barrier_key_b" <<'SQL'
SELECT count(DISTINCT waiting_lock.pid)
FROM pg_catalog.pg_locks AS waiting_lock
WHERE waiting_lock.locktype = 'advisory'
  AND waiting_lock.classid = :'barrier_key_a'::oid
  AND waiting_lock.objid = :'barrier_key_b'::oid
  AND waiting_lock.objsubid = 2
  AND NOT waiting_lock.granted
  AND waiting_lock.mode = 'ShareLock';
SQL
)" || observed=""
    if [[ "$observed" == "2" ]]; then
      waiters_ready=1
      break
    fi
    if ! kill -0 "$pid_a" 2>/dev/null || ! kill -0 "$pid_b" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  if (( waiters_ready == 1 )); then
    printf 'COMMIT;\n\\q\n' >&9
  else
    printf 'ROLLBACK;\n\\q\n' >&9 2>/dev/null || true
  fi
  exec 9>&-
  wait "$holder_pid" || holder_status=$?

  wait "$pid_a" || status_a=$?
  wait "$pid_b" || status_b=$?
  if (( waiters_ready != 1 )); then
    echo "Concurrent barrier did not observe both database sessions waiting before release." >&2
    [[ -s "$holder_error" ]] && sed -n '1,40p' "$holder_error" >&2
    [[ -s "$error_a" ]] && sed -n '1,40p' "$error_a" >&2
    [[ -s "$error_b" ]] && sed -n '1,40p' "$error_b" >&2
    return 1
  fi
  if (( holder_status != 0 || status_a != 0 || status_b != 0 )); then
    echo "Concurrent database session failed (controller=${holder_status}, session A=${status_a}, session B=${status_b})." >&2
    [[ -s "$holder_error" ]] && sed -n '1,40p' "$holder_error" >&2
    [[ -s "$error_a" ]] && sed -n '1,40p' "$error_a" >&2
    [[ -s "$error_b" ]] && sed -n '1,40p' "$error_b" >&2
    return 1
  fi
}

PAIR_SEQUENCE=0

echo "P2.3 real-Postgres smoke: preflight"
psql_smoke --quiet --tuples-only --no-align <<'SQL' >/dev/null
SET statement_timeout = '20s';
SELECT 1 / CASE WHEN
  to_regclass('public.users') IS NOT NULL
  AND to_regclass('public.apps') IS NOT NULL
  AND to_regclass('public.user_routines') IS NOT NULL
  AND to_regclass('public.account_entitlements') IS NOT NULL
  AND to_regclass('public.agent_capacity_windows') IS NOT NULL
  AND to_regclass('public.user_notifications') IS NOT NULL
  AND to_regprocedure('public.activate_managed_routine_with_slot(uuid,uuid,jsonb)') IS NOT NULL
  AND to_regprocedure('public.set_agent_capacity_policy(uuid,uuid,integer)') IS NOT NULL
  AND to_regprocedure('public.reserve_account_capacity_v2(uuid,uuid,text,double precision,timestamp with time zone,jsonb,timestamp with time zone)') IS NOT NULL
  AND to_regprocedure('public.settle_account_capacity(uuid,uuid,double precision)') IS NOT NULL
  AND to_regprocedure('public.release_account_capacity(uuid,uuid,boolean)') IS NOT NULL
  AND to_regprocedure('public.get_launch_fleet_snapshot(uuid)') IS NOT NULL
  AND has_function_privilege(
    'service_role', 'public.activate_managed_routine_with_slot(uuid,uuid,jsonb)', 'EXECUTE'
  )
  AND has_function_privilege(
    'service_role', 'public.set_agent_capacity_policy(uuid,uuid,integer)', 'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.reserve_account_capacity_v2(uuid,uuid,text,double precision,timestamp with time zone,jsonb,timestamp with time zone)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role', 'public.settle_account_capacity(uuid,uuid,double precision)', 'EXECUTE'
  )
  AND has_function_privilege(
    'service_role', 'public.release_account_capacity(uuid,uuid,boolean)', 'EXECUTE'
  )
  AND has_function_privilege(
    'service_role', 'public.get_launch_fleet_snapshot(uuid)', 'EXECUTE'
  )
THEN 1 ELSE 0 END;
SQL

echo "P2.3 real-Postgres smoke: create disposable fixtures"
psql_smoke --quiet \
  --set=run_marker="$RUN_MARKER" \
  --set=free_user_id="$FREE_USER_ID" \
  --set=pro_user_id="$PRO_USER_ID" \
  --set=free_agent_a_id="$FREE_AGENT_A_ID" \
  --set=free_agent_b_id="$FREE_AGENT_B_ID" \
  --set=pro_agent_id="$PRO_AGENT_ID" \
  --set=free_a_primary_id="$FREE_A_PRIMARY_ID" \
  --set=free_a_sibling_id="$FREE_A_SIBLING_ID" \
  --set=free_b_primary_id="$FREE_B_PRIMARY_ID" \
  --set=free_b_sibling_id="$FREE_B_SIBLING_ID" \
  --set=free_email="$FREE_EMAIL" \
  --set=pro_email="$PRO_EMAIL" <<'SQL' >/dev/null
SET statement_timeout = '30s';
SET lock_timeout = '15s';
BEGIN;

INSERT INTO public.users (id, email, tier, display_name)
VALUES
  (:'free_user_id'::uuid, :'free_email', 'free', :'run_marker' || ' Free'),
  (:'pro_user_id'::uuid, :'pro_email', 'pro', :'run_marker' || ' Pro');

INSERT INTO public.apps (
  id, owner_id, slug, name, visibility, storage_key, app_type,
  exports, declared_permissions, description
) VALUES
  (:'free_agent_a_id'::uuid, :'free_user_id'::uuid,
    :'run_marker' || '-free-a', :'run_marker' || ' Free A', 'private',
    'smoke/' || :'run_marker' || '/free-a', 'mcp', '[]'::jsonb, '[]'::jsonb,
    'Disposable P2.3 real-Postgres smoke Agent A'),
  (:'free_agent_b_id'::uuid, :'free_user_id'::uuid,
    :'run_marker' || '-free-b', :'run_marker' || ' Free B', 'private',
    'smoke/' || :'run_marker' || '/free-b', 'mcp', '[]'::jsonb, '[]'::jsonb,
    'Disposable P2.3 real-Postgres smoke Agent B'),
  (:'pro_agent_id'::uuid, :'pro_user_id'::uuid,
    :'run_marker' || '-pro', :'run_marker' || ' Pro', 'private',
    'smoke/' || :'run_marker' || '/pro', 'mcp', '[]'::jsonb, '[]'::jsonb,
    'Disposable P2.3 real-Postgres smoke Pro Agent');

INSERT INTO public.account_entitlements (
  user_id, plan_code, source, capacity_anchor_at, subscription_status
) VALUES
  (:'free_user_id'::uuid, 'free', 'admin', now(), 'inactive'),
  (:'pro_user_id'::uuid, 'pro', 'admin', now(), 'active')
ON CONFLICT (user_id) DO UPDATE
SET plan_code = EXCLUDED.plan_code,
    source = EXCLUDED.source,
    capacity_anchor_at = EXCLUDED.capacity_anchor_at,
    free_agent_id = NULL,
    subscription_status = EXCLUDED.subscription_status;

-- Paused plus a far-future next_run_at makes these rows impossible for the
-- minute scheduler to claim even if the smoke runs during a live cron tick.
INSERT INTO public.user_routines (
  id, user_id, composer_app_id, composer_app_slug, template_id, name,
  handler_function, status, schedule, budget_policy, max_concurrency,
  next_run_at, metadata
) VALUES
  (:'free_a_primary_id'::uuid, :'free_user_id'::uuid, :'free_agent_a_id'::uuid,
    :'run_marker' || '-free-a', 'p23-smoke-primary', 'Free A primary', 'run',
    'paused', '{"type":"interval","every_seconds":300}'::jsonb,
    '{"max_light_per_run":1,"max_light_per_day":10,"max_light_per_month":100,"max_calls_per_run":10}'::jsonb,
    1, now() + interval '365 days',
    '{"launch_managed":true,"launch_role":"primary","launch_primary":true,"source":"p2.3-smoke"}'::jsonb),
  (:'free_a_sibling_id'::uuid, :'free_user_id'::uuid, :'free_agent_a_id'::uuid,
    :'run_marker' || '-free-a', 'p23-smoke-sibling', 'Free A sibling', 'run',
    'paused', '{"type":"cron","cron":"17 3 * * *","timezone":"UTC"}'::jsonb,
    '{"max_light_per_run":1,"max_light_per_day":10,"max_light_per_month":100,"max_calls_per_run":10}'::jsonb,
    1, now() + interval '365 days',
    '{"launch_managed":true,"launch_role":"routine","source":"p2.3-smoke"}'::jsonb),
  (:'free_b_primary_id'::uuid, :'free_user_id'::uuid, :'free_agent_b_id'::uuid,
    :'run_marker' || '-free-b', 'p23-smoke-primary', 'Free B primary', 'run',
    'paused', '{"type":"interval","every_seconds":600}'::jsonb,
    '{"max_light_per_run":1,"max_light_per_day":10,"max_light_per_month":100,"max_calls_per_run":10}'::jsonb,
    1, now() + interval '365 days',
    '{"launch_managed":true,"launch_role":"primary","launch_primary":true,"source":"p2.3-smoke"}'::jsonb),
  (:'free_b_sibling_id'::uuid, :'free_user_id'::uuid, :'free_agent_b_id'::uuid,
    :'run_marker' || '-free-b', 'p23-smoke-sibling', 'Free B sibling', 'run',
    'paused', '{"type":"cron","cron":"23 4 * * *","timezone":"America/New_York"}'::jsonb,
    '{"max_light_per_run":1,"max_light_per_day":10,"max_light_per_month":100,"max_calls_per_run":10}'::jsonb,
    1, now() + interval '365 days',
    '{"launch_managed":true,"launch_role":"routine","source":"p2.3-smoke"}'::jsonb);

COMMIT;
SQL

cat >"$TMP_ROOT/free-a.sql" <<SQL
SET statement_timeout = '20s';
SET lock_timeout = '15s';
SELECT allowed::integer, code, coalesce(occupied_by::text, '')
FROM public.activate_managed_routine_with_slot(
  '$FREE_USER_ID'::uuid,
  '$FREE_A_PRIMARY_ID'::uuid,
  '{"max_light_per_run":1,"max_light_per_day":10,"max_light_per_month":100,"max_calls_per_run":10}'::jsonb
);
SQL
cat >"$TMP_ROOT/free-b.sql" <<SQL
SET statement_timeout = '20s';
SET lock_timeout = '15s';
SELECT allowed::integer, code, coalesce(occupied_by::text, '')
FROM public.activate_managed_routine_with_slot(
  '$FREE_USER_ID'::uuid,
  '$FREE_B_PRIMARY_ID'::uuid,
  '{"max_light_per_run":1,"max_light_per_day":10,"max_light_per_month":100,"max_calls_per_run":10}'::jsonb
);
SQL

echo "P2.3 real-Postgres smoke: atomic Free Agent activation"
run_pair \
  "$TMP_ROOT/free-a.sql" "$TMP_ROOT/free-a.out" "$TMP_ROOT/free-a.err" \
  "$TMP_ROOT/free-b.sql" "$TMP_ROOT/free-b.out" "$TMP_ROOT/free-b.err" \
  || fail "concurrent Free Agent activation did not complete"

FREE_ALLOWED_COUNT="$(awk -F '|' '$1 == "1" { count++ } END { print count + 0 }' \
  "$TMP_ROOT/free-a.out" "$TMP_ROOT/free-b.out")"
FREE_RESULT_COUNT="$(awk 'NF { count++ } END { print count + 0 }' \
  "$TMP_ROOT/free-a.out" "$TMP_ROOT/free-b.out")"
[[ "$FREE_RESULT_COUNT" == "2" && "$FREE_ALLOWED_COUNT" == "1" ]] \
  || fail "exactly one of two Free Agent activations must be admitted"

WINNING_FREE_AGENT_ID="$(psql_smoke --quiet --tuples-only --no-align \
  --set=free_user_id="$FREE_USER_ID" \
  --command="SELECT free_agent_id FROM public.account_entitlements WHERE user_id = :'free_user_id'::uuid")"
case "$WINNING_FREE_AGENT_ID" in
  "$FREE_AGENT_A_ID")
    WINNING_SIBLING_ID="$FREE_A_SIBLING_ID"
    LOSING_FREE_AGENT_ID="$FREE_AGENT_B_ID"
    WINNING_FREE_OUTPUT="$TMP_ROOT/free-a.out"
    LOSING_FREE_OUTPUT="$TMP_ROOT/free-b.out"
    ;;
  "$FREE_AGENT_B_ID")
    WINNING_SIBLING_ID="$FREE_B_SIBLING_ID"
    LOSING_FREE_AGENT_ID="$FREE_AGENT_A_ID"
    WINNING_FREE_OUTPUT="$TMP_ROOT/free-b.out"
    LOSING_FREE_OUTPUT="$TMP_ROOT/free-a.out"
    ;;
  *) fail "Free entitlement did not select either disposable Agent" ;;
esac

[[ "$(tr -d '\r\n' <"$WINNING_FREE_OUTPUT")" == "1|ok|$WINNING_FREE_AGENT_ID" ]] \
  || fail "the winning Free Agent activation returned an unexpected result"
[[ "$(tr -d '\r\n' <"$LOSING_FREE_OUTPUT")" == "0|active_agent_limit|$WINNING_FREE_AGENT_ID" ]] \
  || fail "the denied Free Agent must report active_agent_limit and the winning Agent"

SIBLING_RESULT="$(psql_smoke --quiet --tuples-only --no-align --field-separator='|' \
  --set=free_user_id="$FREE_USER_ID" \
  --set=sibling_id="$WINNING_SIBLING_ID" \
  --command="SET statement_timeout='20s'; SELECT allowed::integer, code FROM public.activate_managed_routine_with_slot(:'free_user_id'::uuid, :'sibling_id'::uuid, '{\"max_light_per_run\":1,\"max_light_per_day\":10,\"max_light_per_month\":100,\"max_calls_per_run\":10}'::jsonb)")"
[[ "$SIBLING_RESULT" == "1|ok" ]] \
  || fail "a sibling routine on the selected Free Agent must activate"

FREE_STATE_OK="$(psql_smoke --quiet --tuples-only --no-align \
  --set=free_user_id="$FREE_USER_ID" \
  --set=winner_agent_id="$WINNING_FREE_AGENT_ID" \
  --set=loser_agent_id="$LOSING_FREE_AGENT_ID" <<'SQL'
SELECT (
  (SELECT count(*) FROM public.user_routines
    WHERE user_id = :'free_user_id'::uuid
      AND composer_app_id = :'winner_agent_id'::uuid
      AND status = 'active' AND deleted_at IS NULL) = 2
  AND
  (SELECT count(*) FROM public.user_routines
    WHERE user_id = :'free_user_id'::uuid
      AND composer_app_id = :'loser_agent_id'::uuid
      AND status = 'active' AND deleted_at IS NULL) = 0
)::integer;
SQL
)"
[[ "$FREE_STATE_OK" == "1" ]] \
  || fail "Free Agent activation state is inconsistent"

echo "P2.3 real-Postgres smoke: Agent-filtered Fleet alert"
psql_smoke --quiet \
  --set=free_user_id="$FREE_USER_ID" \
  --set=winner_agent_id="$WINNING_FREE_AGENT_ID" \
  --set=filtered_alert_id="$FILTERED_ALERT_ID" \
  --set=global_alert_id="$GLOBAL_ALERT_ID" \
  --set=run_marker="$RUN_MARKER" <<'SQL' >/dev/null
INSERT INTO public.user_notifications (
  id, user_id, agent_id, kind, severity, title, body, entity_type,
  entity_id, action_url, dedupe_key
) VALUES
  (:'filtered_alert_id'::uuid, :'free_user_id'::uuid, :'winner_agent_id'::uuid,
    'p23_smoke', 'warning', 'P2.3 filtered smoke alert',
    'Disposable Agent-attributed certification alert.', 'app',
    :'winner_agent_id', '/agents/' || :'winner_agent_id',
    :'run_marker' || ':filtered'),
  (:'global_alert_id'::uuid, :'free_user_id'::uuid, NULL,
    'p23_smoke', 'info', 'P2.3 global decoy alert',
    'Must not appear in an Agent-filtered Fleet card.', NULL, NULL, NULL,
    :'run_marker' || ':global');
SQL

FLEET_ALERT_RESULT="$(psql_smoke --quiet --tuples-only --no-align --field-separator='|' \
  --set=free_user_id="$FREE_USER_ID" \
  --set=winner_agent_id="$WINNING_FREE_AGENT_ID" \
  --set=loser_agent_id="$LOSING_FREE_AGENT_ID" \
  --set=filtered_alert_id="$FILTERED_ALERT_ID" \
  --set=global_alert_id="$GLOBAL_ALERT_ID" <<'SQL'
SELECT
  winner.unread_alert_count,
  (winner.recent_activity @> jsonb_build_array(jsonb_build_object(
    'id', :'filtered_alert_id'::uuid, 'kind', 'alert'
  )))::integer,
  (winner.recent_activity @> jsonb_build_array(jsonb_build_object(
    'id', :'global_alert_id'::uuid
  )))::integer,
  loser.unread_alert_count
FROM public.get_launch_fleet_snapshot(:'free_user_id'::uuid) AS winner
JOIN public.get_launch_fleet_snapshot(:'free_user_id'::uuid) AS loser ON true
WHERE winner.agent_id = :'winner_agent_id'::uuid
  AND loser.agent_id = :'loser_agent_id'::uuid;
SQL
)"
[[ "$FLEET_ALERT_RESULT" == "1|1|0|0" ]] \
  || fail "Fleet snapshot did not isolate the Agent-attributed alert"

echo "P2.3 real-Postgres smoke: atomic per-Agent capacity admission"
CAP_RESULT="$(psql_smoke --quiet --tuples-only --no-align --field-separator='|' \
  --set=pro_user_id="$PRO_USER_ID" \
  --set=pro_agent_id="$PRO_AGENT_ID" \
  --command="SELECT capacity_agent_id, agent_cap_basis_points FROM public.set_agent_capacity_policy(:'pro_user_id'::uuid, :'pro_agent_id'::uuid, 100)")"
[[ "$CAP_RESULT" == "$PRO_AGENT_ID|100" ]] \
  || fail "Pro Agent capacity cap was not set to one percent"

for suffix in a b; do
  cat >"$TMP_ROOT/reserve-${suffix}.sql" <<SQL
SET statement_timeout = '20s';
SET lock_timeout = '15s';
SELECT allowed::integer, code, coalesce(reservation_id::text, ''),
  coalesce(binding_constraint, '')
FROM public.reserve_account_capacity_v2(
  '$PRO_USER_ID'::uuid,
  '$PRO_AGENT_ID'::uuid,
  '$RUN_MARKER:reserve-$suffix',
  0.03,
  now() + interval '10 minutes',
  '{"source":"p2.3-smoke"}'::jsonb,
  now()
);
SQL
done

run_pair \
  "$TMP_ROOT/reserve-a.sql" "$TMP_ROOT/reserve-a.out" "$TMP_ROOT/reserve-a.err" \
  "$TMP_ROOT/reserve-b.sql" "$TMP_ROOT/reserve-b.out" "$TMP_ROOT/reserve-b.err" \
  || fail "concurrent Pro Agent capacity admission did not complete"

CAP_ALLOWED_COUNT="$(awk -F '|' '$1 == "1" { count++ } END { print count + 0 }' \
  "$TMP_ROOT/reserve-a.out" "$TMP_ROOT/reserve-b.out")"
CAP_RESULT_COUNT="$(awk 'NF { count++ } END { print count + 0 }' \
  "$TMP_ROOT/reserve-a.out" "$TMP_ROOT/reserve-b.out")"
[[ "$CAP_RESULT_COUNT" == "2" && "$CAP_ALLOWED_COUNT" == "1" ]] \
  || fail "exactly one simultaneous 0.03 hold must fit the one-percent Agent cap"

FIRST_RESERVATION_ID="$(awk -F '|' '$1 == "1" { print $3 }' \
  "$TMP_ROOT/reserve-a.out" "$TMP_ROOT/reserve-b.out")"
[[ "$FIRST_RESERVATION_ID" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "admitted capacity hold did not return a reservation ID"
CAP_ALLOWED_RESULT="$(awk -F '|' '$1 == "1" { print }' \
  "$TMP_ROOT/reserve-a.out" "$TMP_ROOT/reserve-b.out")"
CAP_DENIED_RESULT="$(awk -F '|' '$1 == "0" { print }' \
  "$TMP_ROOT/reserve-a.out" "$TMP_ROOT/reserve-b.out")"
[[ "$CAP_ALLOWED_RESULT" == "1|ok|$FIRST_RESERVATION_ID|" ]] \
  || fail "the admitted Agent capacity hold returned an unexpected result"
[[ "$CAP_DENIED_RESULT" == "0|agent_cap_waiting||agent" ]] \
  || fail "the denied hold must report agent_cap_waiting, bind to Agent capacity, and return no reservation"

SECOND_RESERVE_RESULT="$(psql_smoke --quiet --tuples-only --no-align --field-separator='|' \
  --set=pro_user_id="$PRO_USER_ID" \
  --set=pro_agent_id="$PRO_AGENT_ID" \
  --set=idempotency_key="$RUN_MARKER:reserve-second" <<'SQL'
SET statement_timeout = '20s';
SELECT allowed::integer, code, coalesce(reservation_id::text, '')
FROM public.reserve_account_capacity_v2(
  :'pro_user_id'::uuid, :'pro_agent_id'::uuid, :'idempotency_key', 0.02,
  now() + interval '10 minutes', '{"source":"p2.3-smoke"}'::jsonb, now()
);
SQL
)"
IFS='|' read -r SECOND_ALLOWED SECOND_CODE SECOND_RESERVATION_ID \
  <<<"$SECOND_RESERVE_RESULT"
[[ "$SECOND_ALLOWED" == "1" && "$SECOND_CODE" == "ok" \
   && "$SECOND_RESERVATION_ID" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "the second 0.02 hold must fit the remaining one-percent capacity"

cat >"$TMP_ROOT/settle.sql" <<SQL
SET statement_timeout = '20s';
SET lock_timeout = '15s';
SELECT public.settle_account_capacity(
  '$FIRST_RESERVATION_ID'::uuid, '$PRO_USER_ID'::uuid, 0.03
)::integer;
SQL
cat >"$TMP_ROOT/release.sql" <<SQL
SET statement_timeout = '20s';
SET lock_timeout = '15s';
SELECT public.release_account_capacity(
  '$SECOND_RESERVATION_ID'::uuid, '$PRO_USER_ID'::uuid, false
)::integer;
SQL

echo "P2.3 real-Postgres smoke: concurrent settle/release ledger parity"
run_pair \
  "$TMP_ROOT/settle.sql" "$TMP_ROOT/settle.out" "$TMP_ROOT/settle.err" \
  "$TMP_ROOT/release.sql" "$TMP_ROOT/release.out" "$TMP_ROOT/release.err" \
  || fail "concurrent settle/release did not complete without deadlock"
[[ "$(tr -d '[:space:]' <"$TMP_ROOT/settle.out")" == "1" \
   && "$(tr -d '[:space:]' <"$TMP_ROOT/release.out")" == "1" ]] \
  || fail "settle/release returned an unexpected result"

LEDGER_RESULT="$(psql_smoke --quiet --tuples-only --no-align --field-separator='|' \
  --set=pro_user_id="$PRO_USER_ID" \
  --set=pro_agent_id="$PRO_AGENT_ID" \
  --set=first_reservation_id="$FIRST_RESERVATION_ID" \
  --set=second_reservation_id="$SECOND_RESERVATION_ID" <<'SQL'
WITH statuses AS (
  SELECT
    count(*) FILTER (
      WHERE id = :'first_reservation_id'::uuid AND status = 'settled'
        AND abs(actual_light - 0.03) < 0.000000001
    ) = 1 AS settled_ok,
    count(*) FILTER (
      WHERE id = :'second_reservation_id'::uuid AND status = 'released'
    ) = 1 AS released_ok
  FROM public.account_capacity_reservations
  WHERE user_id = :'pro_user_id'::uuid
    AND id IN (:'first_reservation_id'::uuid, :'second_reservation_id'::uuid)
), ledger AS (
  SELECT
    count(*) = 2 AS two_windows,
    bool_and(abs(account_window.reserved_light) < 0.000000001) AS account_clear,
    bool_and(abs(agent_window.reserved_light) < 0.000000001) AS agent_clear,
    bool_and(abs(account_window.used_light - agent_window.used_light) < 0.000000001)
      AS used_mirrors,
    bool_and(abs(account_window.used_light - 0.03) < 0.000000001)
      AS expected_used
  FROM public.account_capacity_windows AS account_window
  JOIN public.agent_capacity_windows AS agent_window
    ON agent_window.user_id = account_window.user_id
   AND agent_window.window_kind = account_window.window_kind
   AND agent_window.window_started_at = account_window.window_started_at
  WHERE account_window.user_id = :'pro_user_id'::uuid
    AND agent_window.capacity_agent_id = :'pro_agent_id'::uuid
)
SELECT
  statuses.settled_ok::integer,
  statuses.released_ok::integer,
  ledger.two_windows::integer,
  ledger.account_clear::integer,
  ledger.agent_clear::integer,
  ledger.used_mirrors::integer,
  ledger.expected_used::integer
FROM statuses CROSS JOIN ledger;
SQL
)"
[[ "$LEDGER_RESULT" == "1|1|1|1|1|1|1" ]] \
  || fail "settled/released statuses or account/Agent ledgers diverged"

echo "P2.3 real-Postgres smoke: PASS"
