#!/bin/sh
set -eu

image=${1:-galactic-compute:developer-v1}
base=${COMPUTE_SANDBOX_BASE_IMAGE:-}
prefix='docker.io/cloudflare/sandbox:0.12.3-python@sha256:'

case "$base" in
  "$prefix"*) ;;
  *)
    echo "COMPUTE_SANDBOX_BASE_IMAGE must be the reviewed 0.12.3-python image with an @sha256 digest." >&2
    exit 1
    ;;
esac

digest=${base#"$prefix"}
case "$digest" in
  ''|*[!0-9a-f]*)
    echo "COMPUTE_SANDBOX_BASE_IMAGE digest must contain 64 lowercase hexadecimal characters." >&2
    exit 1
    ;;
esac
if [ "${#digest}" -ne 64 ]; then
  echo "COMPUTE_SANDBOX_BASE_IMAGE digest must contain 64 lowercase hexadecimal characters." >&2
  exit 1
fi

docker pull "$base"
DOCKER_BUILDKIT=1 docker build \
  --platform linux/amd64 \
  --build-arg "SANDBOX_BASE_IMAGE=$base" \
  --tag "$image" \
  --file images/standard/Dockerfile \
  ..
