#!/usr/bin/env bash
# Galactic post-deploy smoke test.
# Verifies the deployed API surface and, optionally, a real authenticated chat.
#
# Examples:
#   ./scripts/smoke-test.sh --url https://ultralight-api-staging.rgn4jz429m.workers.dev
#   ULTRALIGHT_TOKEN=... ./scripts/smoke-test.sh --exercise-chat

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

API_URL="${ULTRALIGHT_API_URL:-https://api.ultralightagent.com}"
FALLBACK_URL="${ULTRALIGHT_FALLBACK_URL:-}"
TOKEN="${ULTRALIGHT_TOKEN:-}"
CHAT_MODEL="${ULTRALIGHT_CHAT_MODEL:-ultralight/deepseek-v4-flash}"
EXERCISE_CHAT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) API_URL="$2"; shift 2 ;;
    --fallback-url) FALLBACK_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --model) CHAT_MODEL="$2"; shift 2 ;;
    --exercise-chat) EXERCISE_CHAT=1; shift ;;
    --help)
      cat <<'EOF'
Usage: ./scripts/smoke-test.sh [options]

Options:
  --url URL            API base URL to test (default: https://api.ultralightagent.com)
  --fallback-url URL   Optional direct worker URL to compare when the public URL fails
  --token TOKEN        Bearer token for authenticated checks
  --model MODEL        Chat model to use for --exercise-chat
  --exercise-chat      Send one tiny streaming chat request (incurs small cost)
  --help               Show this help
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$FALLBACK_URL" ]] && [[ "$API_URL" == "https://api.ultralight.dev" ]]; then
  FALLBACK_URL="https://api.ultralightagent.com"
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_command curl
require_command python3

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0
SKIP=0

pass() {
  echo -e "${GREEN}✓ PASS${NC} - $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "${RED}✗ FAIL${NC} - $1"
  FAIL=$((FAIL + 1))
}

skip() {
  echo -e "${YELLOW}⚠ SKIP${NC} - $1"
  SKIP=$((SKIP + 1))
}

json_get() {
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'PY'
import json, sys

path = sys.argv[1]
expr = sys.argv[2]

with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)

value = data
for part in expr.split('.'):
    if not part:
        continue
    if isinstance(value, list):
        value = value[int(part)]
    else:
        value = value.get(part)

if isinstance(value, bool):
    print('true' if value else 'false')
elif value is None:
    print('')
else:
    print(value)
PY
}

fetch_json() {
  local label="$1"
  local url="$2"
  local outfile="$3"
  shift 3
  local status
  status=$(curl -sS -o "$outfile" -w '%{http_code}' "$@" "$url")
  echo "$status"
}

echo "╔══════════════════════════════════════════════╗"
echo "║        Galactic Post-Deploy Smoke         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "API:   $API_URL"
if [[ -n "$FALLBACK_URL" ]]; then
  echo "Worker fallback: $FALLBACK_URL"
fi
if [[ -n "$TOKEN" ]]; then
  echo "Auth:  bearer token provided"
else
  echo "Auth:  unauthenticated checks only"
fi
if [[ "$EXERCISE_CHAT" -eq 1 ]]; then
  echo "Chat:  exercising real streaming chat via $CHAT_MODEL"
fi
echo ""

echo -n "1. /health... "
HEALTH_JSON="$TMP_DIR/health.json"
HEALTH_STATUS=$(fetch_json "health" "$API_URL/health" "$HEALTH_JSON")
if [[ "$HEALTH_STATUS" == "200" ]] && [[ "$(json_get "$HEALTH_JSON" "status")" == "ok" ]]; then
  pass "/health returned ok"
else
  if [[ -n "$FALLBACK_URL" ]]; then
    FALLBACK_HEALTH_JSON="$TMP_DIR/fallback-health.json"
    FALLBACK_HEALTH_STATUS=$(fetch_json "fallback health" "$FALLBACK_URL/health" "$FALLBACK_HEALTH_JSON")
    if [[ "$FALLBACK_HEALTH_STATUS" == "200" ]] && [[ "$(json_get "$FALLBACK_HEALTH_JSON" "status")" == "ok" ]]; then
      fail "/health failed on the public URL (status $HEALTH_STATUS) while the worker fallback stayed healthy. Check DNS/custom-domain routing."
    else
      fail "/health failed (status $HEALTH_STATUS)"
    fi
  else
    fail "/health failed (status $HEALTH_STATUS)"
  fi
fi

echo -n "2. /api/discover/status... "
DISCOVER_STATUS_JSON="$TMP_DIR/discover-status.json"
DISCOVER_STATUS_CODE=$(fetch_json "discover status" "$API_URL/api/discover/status" "$DISCOVER_STATUS_JSON")
if [[ "$DISCOVER_STATUS_CODE" == "200" ]] && [[ -n "$(json_get "$DISCOVER_STATUS_JSON" "endpoints.search_get")" ]]; then
  AVAILABLE="$(json_get "$DISCOVER_STATUS_JSON" "available")"
  APP_COUNT="$(json_get "$DISCOVER_STATUS_JSON" "app_count")"
  pass "discover status available=$AVAILABLE app_count=${APP_COUNT:-0}"
else
  fail "/api/discover/status failed (status $DISCOVER_STATUS_CODE)"
fi

echo -n "3. /api/discover/featured... "
FEATURED_JSON="$TMP_DIR/featured.json"
FEATURED_STATUS=$(fetch_json "featured" "$API_URL/api/discover/featured?limit=1" "$FEATURED_JSON")
if [[ "$FEATURED_STATUS" == "200" ]]; then
  FEATURED_TOTAL="$(json_get "$FEATURED_JSON" "total")"
  if [[ -n "$FEATURED_TOTAL" ]]; then
    pass "featured endpoint returned total=${FEATURED_TOTAL}"
  else
    fail "/api/discover/featured returned an unexpected payload"
  fi
else
  fail "/api/discover/featured failed (status $FEATURED_STATUS)"
fi

echo -n "4. /chat/models... "
MODELS_JSON="$TMP_DIR/chat-models.json"
MODELS_STATUS=$(fetch_json "chat models" "$API_URL/chat/models" "$MODELS_JSON")
if [[ "$MODELS_STATUS" == "200" ]] && [[ -n "$(json_get "$MODELS_JSON" "models.0.id")" ]]; then
  FIRST_MODEL="$(json_get "$MODELS_JSON" "models.0.id")"
  pass "chat models available (first: $FIRST_MODEL)"
else
  fail "/chat/models failed (status $MODELS_STATUS)"
fi

if [[ -z "$TOKEN" ]]; then
  skip "Authenticated checks require ULTRALIGHT_TOKEN or --token"
else
  AUTH_HEADER=(-H "Authorization: Bearer $TOKEN")

  echo -n "5. /auth/user... "
  AUTH_USER_JSON="$TMP_DIR/auth-user.json"
  AUTH_USER_STATUS=$(fetch_json "auth user" "$API_URL/auth/user" "$AUTH_USER_JSON" "${AUTH_HEADER[@]}")
  if [[ "$AUTH_USER_STATUS" == "200" ]] && [[ -n "$(json_get "$AUTH_USER_JSON" "email")" ]]; then
    AUTH_EMAIL="$(json_get "$AUTH_USER_JSON" "email")"
    pass "authenticated as $AUTH_EMAIL"
  else
    fail "/auth/user failed (status $AUTH_USER_STATUS)"
  fi

  echo -n "6. retired /debug/chat-preflight... "
  PREFLIGHT_JSON="$TMP_DIR/chat-preflight.json"
  PREFLIGHT_STATUS=$(fetch_json "retired chat preflight" "$API_URL/debug/chat-preflight" "$PREFLIGHT_JSON" "${AUTH_HEADER[@]}")
  if [[ "$PREFLIGHT_STATUS" == "404" ]]; then
    # P0 intentionally removed debug routes that exposed auth, balance, and
    # provider-key diagnostics. Their absence is a security assertion; launch
    # BYOK behavior is covered by the account-session browser journey.
    pass "retired billing/key diagnostic route remains unavailable"
  elif [[ "$PREFLIGHT_STATUS" == "200" ]]; then
    fail "retired /debug/chat-preflight is unexpectedly exposed"
  else
    fail "retired /debug/chat-preflight returned unexpected status $PREFLIGHT_STATUS"
  fi

  if [[ "$EXERCISE_CHAT" -eq 1 ]]; then
    echo -n "7. /chat/stream... "
    CHAT_PAYLOAD="$TMP_DIR/chat-payload.json"
    cat > "$CHAT_PAYLOAD" <<EOF
{"model":"$CHAT_MODEL","messages":[{"role":"user","content":"Reply with exactly the word ultralight."}]}
EOF
    CHAT_OUTPUT="$TMP_DIR/chat-stream.txt"
    CHAT_STATUS=$(curl -sS -N --max-time 90 \
      -o "$CHAT_OUTPUT" \
      -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      "$API_URL/chat/stream" \
      --data @"$CHAT_PAYLOAD")
    if [[ "$CHAT_STATUS" == "200" ]] && grep -q '^data: ' "$CHAT_OUTPUT" && grep -q '\[DONE\]' "$CHAT_OUTPUT"; then
      pass "streaming chat completed"
    else
      fail "/chat/stream failed (status $CHAT_STATUS)"
    fi
  else
    skip "Real chat send skipped (use --exercise-chat to include it)"
  fi
fi

echo ""
echo "══════════════════════════════════════════════"
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$SKIP skipped${NC}"
echo "══════════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
