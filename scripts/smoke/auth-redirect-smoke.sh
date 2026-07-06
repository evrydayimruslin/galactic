#!/usr/bin/env bash
# Desktop auth redirect smoke for staging or production.
# Validates the browser redirect chain around /auth/login, /auth/desktop-poll,
# and /auth/signout without requiring a full desktop UI session.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

BASE_URL="${ULTRALIGHT_API_URL:-https://ultralight-api-staging.rgn4jz429m.workers.dev}"
EXPECTED_SUPABASE_URL="${ULTRALIGHT_SUPABASE_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) BASE_URL="$2"; shift 2 ;;
    --supabase-url) EXPECTED_SUPABASE_URL="$2"; shift 2 ;;
    --help)
      cat <<'EOF'
Usage: ./scripts/smoke/auth-redirect-smoke.sh [options]

Options:
  --url URL               API base URL to test (default: https://ultralight-api-staging.rgn4jz429m.workers.dev)
  --supabase-url URL      Expected Supabase project origin for the OAuth redirect
  --help                  Show this help
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "Missing required command: curl" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Missing required command: python3" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0

pass() {
  echo -e "${GREEN}✓ PASS${NC} - $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "${RED}✗ FAIL${NC} - $1"
  FAIL=$((FAIL + 1))
}

SESSION_ID="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"

SESSION_SECRET="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"

SESSION_SECRET_HASH="$(python3 - "$SESSION_SECRET" <<'PY'
import hashlib, sys
print(hashlib.sha256(sys.argv[1].encode()).hexdigest())
PY
)"

validate_login_redirect() {
  local location="$1"
  local expect_prompt="$2"

  LOCATION="$location" BASE_URL="$BASE_URL" EXPECTED_SUPABASE_URL="$EXPECTED_SUPABASE_URL" EXPECT_PROMPT="$expect_prompt" python3 - <<'PY'
import os
import urllib.parse

location = os.environ['LOCATION']
base_url = os.environ['BASE_URL']
expected_supabase_url = os.environ.get('EXPECTED_SUPABASE_URL', '').strip()
expect_prompt = os.environ['EXPECT_PROMPT']

redirect = urllib.parse.urlparse(location)
if expected_supabase_url:
    expected = urllib.parse.urlparse(expected_supabase_url)
    if (redirect.scheme, redirect.netloc) != (expected.scheme, expected.netloc):
        raise SystemExit(f"Expected OAuth redirect origin {expected.scheme}://{expected.netloc}, got {redirect.scheme}://{redirect.netloc}")

if not redirect.path.endswith('/auth/v1/authorize'):
    raise SystemExit(f"Expected /auth/v1/authorize redirect, got {redirect.path}")

params = urllib.parse.parse_qs(redirect.query)
if params.get('provider', [''])[0] != 'google':
    raise SystemExit('Missing provider=google in redirect')
if params.get('code_challenge_method', [''])[0] != 'S256':
    raise SystemExit('Missing code_challenge_method=S256 in redirect')
if not params.get('code_challenge', [''])[0]:
    raise SystemExit('Missing code_challenge in redirect')

redirect_to = params.get('redirect_to', [''])[0]
if not redirect_to:
    raise SystemExit('Missing redirect_to in redirect')

callback = urllib.parse.urlparse(redirect_to)
base = urllib.parse.urlparse(base_url)
if (callback.scheme, callback.netloc, callback.path) != (base.scheme, base.netloc, '/auth/callback'):
    raise SystemExit(
        f"Expected redirect_to {base.scheme}://{base.netloc}/auth/callback, got {callback.scheme}://{callback.netloc}{callback.path}"
    )

# The PKCE verifier + desktop session are NO LONGER carried in the redirect_to
# query — auth.ts moved them into HttpOnly __Host- cookies so the verifier can't
# leak via Supabase/Google logs, referrers, or history. The Set-Cookie checks
# live in the shell callers (they have the response headers).

prompt = params.get('prompt', [''])[0]
if expect_prompt == 'select_account':
    if prompt != 'select_account':
        raise SystemExit(f'Expected prompt=select_account, got {prompt or "<missing>"}')
else:
    if prompt:
        raise SystemExit(f'Did not expect prompt in default login redirect, got {prompt}')

print('ok')
PY
}

echo "╔══════════════════════════════════════════════╗"
echo "║      Galactic Auth Redirect Smoke         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "API:       $BASE_URL"
if [[ -n "$EXPECTED_SUPABASE_URL" ]]; then
  echo "Supabase:  $EXPECTED_SUPABASE_URL"
fi
echo ""

echo -n "1. /health... "
HEALTH_JSON="$TMP_DIR/health.json"
HEALTH_STATUS=$(curl -sS -o "$HEALTH_JSON" -w '%{http_code}' "$BASE_URL/health")
if [[ "$HEALTH_STATUS" == "200" ]] && grep -q '"status":"ok"' "$HEALTH_JSON"; then
  pass "/health returned ok"
else
  fail "/health failed (status $HEALTH_STATUS)"
fi

echo -n "2. /auth/login desktop redirect... "
LOGIN_HEADERS="$TMP_DIR/login.headers"
LOGIN_STATUS=$(curl -sS -D "$LOGIN_HEADERS" -o /dev/null -w '%{http_code}' \
  "$BASE_URL/auth/login?desktop_session=$SESSION_ID&desktop_poll_secret_hash=$SESSION_SECRET_HASH")
LOGIN_LOCATION="$(grep -i '^location:' "$LOGIN_HEADERS" | tail -n 1 | cut -d' ' -f2- | tr -d '\r')"
if [[ "$LOGIN_STATUS" == "302" ]] && [[ -n "$LOGIN_LOCATION" ]] && validate_login_redirect "$LOGIN_LOCATION" "" \
  && grep -qi 'set-cookie: __Host-ul_oauth_verifier=[^;]' "$LOGIN_HEADERS" \
  && grep -qi "set-cookie: __Host-ul_oauth_desktop_session=$SESSION_ID;" "$LOGIN_HEADERS"; then
  pass "desktop login redirects to Google via Supabase (state in __Host- cookies)"
else
  fail "/auth/login redirect failed (status $LOGIN_STATUS)"
fi

echo -n "3. /auth/login use-another-account redirect... "
SELECT_HEADERS="$TMP_DIR/select.headers"
SELECT_STATUS=$(curl -sS -D "$SELECT_HEADERS" -o /dev/null -w '%{http_code}' \
  "$BASE_URL/auth/login?desktop_session=${SESSION_ID}-select&desktop_poll_secret_hash=$SESSION_SECRET_HASH&prompt=select_account")
SELECT_LOCATION="$(grep -i '^location:' "$SELECT_HEADERS" | tail -n 1 | cut -d' ' -f2- | tr -d '\r')"
if [[ "$SELECT_STATUS" == "302" ]] && [[ -n "$SELECT_LOCATION" ]] && validate_login_redirect "$SELECT_LOCATION" "select_account" \
  && grep -qi 'set-cookie: __Host-ul_oauth_verifier=[^;]' "$SELECT_HEADERS" \
  && grep -qi "set-cookie: __Host-ul_oauth_desktop_session=${SESSION_ID}-select;" "$SELECT_HEADERS"; then
  pass "account-switch redirect preserves prompt=select_account (state in __Host- cookies)"
else
  fail "/auth/login select_account redirect failed (status $SELECT_STATUS)"
fi

echo -n "4. /auth/desktop-poll pending state... "
POLL_JSON="$TMP_DIR/poll.json"
POLL_STATUS=$(curl -sS -o "$POLL_JSON" -w '%{http_code}' \
  "$BASE_URL/auth/desktop-poll?session_id=$SESSION_ID&session_secret=$SESSION_SECRET")
if [[ "$POLL_STATUS" == "200" ]] && grep -q '"status":"pending"' "$POLL_JSON"; then
  pass "desktop poll returns pending before callback completion"
else
  fail "/auth/desktop-poll failed (status $POLL_STATUS)"
fi

echo -n "5. /auth/signout cookie clearing... "
SIGNOUT_HEADERS="$TMP_DIR/signout.headers"
SIGNOUT_BODY="$TMP_DIR/signout.json"
SIGNOUT_STATUS=$(curl -sS -X POST -D "$SIGNOUT_HEADERS" -o "$SIGNOUT_BODY" -w '%{http_code}' "$BASE_URL/auth/signout")
if [[ "$SIGNOUT_STATUS" == "200" ]] && grep -q '"ok":true' "$SIGNOUT_BODY" \
  && grep -q '__Host-ul_session=.*Max-Age=0' "$SIGNOUT_HEADERS" \
  && grep -q '__Host-ul_refresh=.*Max-Age=0' "$SIGNOUT_HEADERS"; then
  pass "signout clears HttpOnly auth cookies"
else
  fail "/auth/signout failed (status $SIGNOUT_STATUS)"
fi

echo ""
echo "══════════════════════════════════════════════"
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "══════════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
