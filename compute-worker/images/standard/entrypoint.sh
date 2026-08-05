#!/bin/sh
set -eu

# The base image and Container runtime are not credential channels. Explicit
# Agent-configured provider secrets arrive later on one isolated exec call;
# scrub every common ambient platform/provider variable before the body server
# starts so neither the base environment nor future runtime configuration can
# accidentally become authority.
unset \
  GALACTIC_AGENT_TOKEN GALACTIC_HUMAN_TOKEN GALACTIC_PLATFORM_KEY \
  GALACTIC_API_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY \
  CF_API_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID \
  OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY GEMINI_API_KEY \
  OPENROUTER_API_KEY GROQ_API_KEY MISTRAL_API_KEY COHERE_API_KEY \
  HUGGING_FACE_HUB_TOKEN HF_TOKEN REPLICATE_API_TOKEN TOGETHER_API_KEY \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  AWS_WEB_IDENTITY_TOKEN_FILE GOOGLE_APPLICATION_CREDENTIALS \
  AZURE_OPENAI_API_KEY AZURE_CLIENT_SECRET AZURE_CLIENT_CERTIFICATE_PATH \
  GITHUB_TOKEN GH_TOKEN NPM_TOKEN NODE_AUTH_TOKEN \
  DATABASE_URL PGPASSWORD MYSQL_PWD REDIS_URL || true

# HTTPS interception covers both the private galactic.internal gateway and the
# catch-all public HTTP(S) egress handler. Preserve the public root bundle while
# adding Cloudflare's runtime CA used by the interception layer.
GALACTIC_CA_BUNDLE=/tmp/galactic-ca-certificates.crt
CLOUDFLARE_CA_CERTIFICATES=/etc/cloudflare/certs/cloudflare-containers-ca.crt
CHROME_FOR_TESTING_CA_POLICY=/etc/opt/chrome_for_testing/policies/managed/galactic-cloudflare-ca.json
CHROME_NSS_DATABASE=/tmp/galactic-home/.local/share/pki/nssdb
cp /etc/ssl/certs/ca-certificates.crt "$GALACTIC_CA_BUNDLE"
if [ -s "$CLOUDFLARE_CA_CERTIFICATES" ]; then
  CHROME_NSS_CERTIFICATES=$(mktemp -d /tmp/galactic-chrome-ca.XXXXXX)

  # Preserve Chrome for Testing's mandatory enterprise policy as one trust
  # source and emit one canonical PEM per runtime CA for NSS below.
  node /opt/galactic/bin/configure-chrome-ca-policy.mjs \
    "$CLOUDFLARE_CA_CERTIFICATES" \
    "$CHROME_FOR_TESTING_CA_POLICY" \
    "$CHROME_NSS_CERTIFICATES"

  # Cloudflare's runtime CA is ephemeral and must be copied into the distro
  # store at container start, then refreshed before the body server starts.
  install -m 0444 "$CLOUDFLARE_CA_CERTIFICATES" \
    /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null

  # Since Chromium M146, Linux local trust is read from this NSS Shared DB.
  # Compute intentionally overrides every job's HOME to /tmp/galactic-home,
  # so importing into root's NSS DB would remain invisible to Playwright.
  install -d -m 0700 "$CHROME_NSS_DATABASE"
  if [ ! -f "$CHROME_NSS_DATABASE/cert9.db" ]; then
    certutil -N --empty-password -d "sql:$CHROME_NSS_DATABASE"
  fi
  chrome_ca_index=1
  for chrome_ca_file in "$CHROME_NSS_CERTIFICATES"/*.crt; do
    chrome_ca_nickname="Galactic Cloudflare Containers CA $chrome_ca_index"
    if certutil -L -d "sql:$CHROME_NSS_DATABASE" \
      -n "$chrome_ca_nickname" >/dev/null 2>&1; then
      certutil -D -d "sql:$CHROME_NSS_DATABASE" \
        -n "$chrome_ca_nickname"
    fi
    certutil -A -d "sql:$CHROME_NSS_DATABASE" \
      -n "$chrome_ca_nickname" -t "C,," -i "$chrome_ca_file"
    certutil -L -d "sql:$CHROME_NSS_DATABASE" \
      -n "$chrome_ca_nickname" >/dev/null
    chrome_ca_index=$((chrome_ca_index + 1))
  done
  rm -rf "$CHROME_NSS_CERTIFICATES"

  cat "$CLOUDFLARE_CA_CERTIFICATES" >> "$GALACTIC_CA_BUNDLE"
  export NODE_EXTRA_CA_CERTS="$CLOUDFLARE_CA_CERTIFICATES"
fi
export SSL_CERT_FILE="$GALACTIC_CA_BUNDLE"
export CURL_CA_BUNDLE="$GALACTIC_CA_BUNDLE"
export REQUESTS_CA_BUNDLE="$GALACTIC_CA_BUNDLE"

exec /container-server/sandbox
