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
cp /etc/ssl/certs/ca-certificates.crt "$GALACTIC_CA_BUNDLE"
if [ -s /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then
  cat /etc/cloudflare/certs/cloudflare-containers-ca.crt >> "$GALACTIC_CA_BUNDLE"
  export NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
fi
export SSL_CERT_FILE="$GALACTIC_CA_BUNDLE"
export CURL_CA_BUNDLE="$GALACTIC_CA_BUNDLE"
export REQUESTS_CA_BUNDLE="$GALACTIC_CA_BUNDLE"

exec /container-server/sandbox
