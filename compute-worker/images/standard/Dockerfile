# Release builds must pass the complete digest-pinned reference through
# --build-arg, for example:
# docker.io/cloudflare/sandbox:0.12.3-python@sha256:<64 lowercase hex chars>
# There is intentionally no mutable default.
ARG SANDBOX_BASE_IMAGE
FROM ${SANDBOX_BASE_IMAGE}

# A pre-FROM ARG is only in Docker's global scope. Redeclare it in the build
# stage so the exact base reference is preserved in image metadata.
ARG SANDBOX_BASE_IMAGE
ARG TARGETARCH
ARG DUCKDB_VERSION=1.5.1
ARG PLAYWRIGHT_VERSION=1.61.1
ARG CLAUDE_CODE_VERSION=2.1.215
ARG CODEX_VERSION=0.144.6
ARG DENO_VERSION=2.6.10
ARG GALACTIC_CLI_VERSION=2.4.0

# Keep the exact release inputs visible in OCI metadata. The Node package graph
# itself is installed from toolchain/package-lock.json below; these labels also
# let release evidence assert that the lock and intended direct versions agree.
LABEL org.opencontainers.image.base.name="${SANDBOX_BASE_IMAGE}" \
      ai.galactic.tool.playwright="playwright@${PLAYWRIGHT_VERSION}" \
      ai.galactic.tool.claude-code="@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      ai.galactic.tool.codex="@openai/codex@${CODEX_VERSION}" \
      ai.galactic.tool.deno="deno@${DENO_VERSION}" \
      ai.galactic.tool.galactic-cli="galacticconnection@${GALACTIC_CLI_VERSION}"

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DENO_DIR=/opt/galactic/deno-cache \
    DENO_NO_UPDATE_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_update_notifier=false \
    DO_NOT_TRACK=1

# The v1 developer body is deliberately broad. Tool selection is an admission,
# audit, and future layering signal; binaries are not treated as authorities.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
      bash build-essential cmake pkg-config \
      git git-lfs gh openssh-client rsync \
      curl wget ca-certificates dnsutils netcat-openbsd \
      jq ripgrep sqlite3 \
      postgresql-client default-mysql-client redis-tools \
      ffmpeg imagemagick \
      pandoc \
      libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils tesseract-ocr tesseract-ocr-eng \
      rclone \
      xvfb fonts-dejavu fonts-liberation \
      file unzip zip gzip bzip2 xz-utils tar less tree && \
    rm -rf /var/lib/apt/lists/*

# DuckDB is pinned to an immutable release asset and verified before install.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) duckdb_arch=amd64; duckdb_sha=88e2ef7b47a384eef1c40d43cb863608cec4f49b72ff11fb277f9075c43670bc ;; \
      arm64) duckdb_arch=arm64; duckdb_sha=75e7e750426c1905aa8d0679634616ac2fb217e0004072fb26d176d100a15a27 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/duckdb.gz \
      "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-${duckdb_arch}.gz"; \
    echo "${duckdb_sha}  /tmp/duckdb.gz" | sha256sum -c -; \
    gzip -d /tmp/duckdb.gz; \
    install -m 0755 /tmp/duckdb /usr/local/bin/duckdb; \
    rm /tmp/duckdb; \
    duckdb --version

# The local Galactic CLI delegates its full command surface to Deno. Pin and
# verify the runtime so `galactic budget`, artifacts, and platform calls work
# in a body without downloading code during the lease.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) deno_arch=x86_64; deno_sha=a7c9d5c1f93bfaabe03c3c0583a8c88caf695db3cec4dea2938440038609f225 ;; \
      arm64) deno_arch=aarch64; deno_sha=ad4031b16b193997cd40d2bf68c9af8b5148e0f39c1e975cfbb6d60ecec19496 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    deno_archive="deno-${deno_arch}-unknown-linux-gnu.zip"; \
    curl -fsSL -o "/tmp/${deno_archive}" \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${deno_archive}"; \
    echo "${deno_sha}  /tmp/${deno_archive}" | sha256sum -c -; \
    unzip -q "/tmp/${deno_archive}" -d /usr/local/bin; \
    rm "/tmp/${deno_archive}"; \
    test "$(deno --version | sed -n '1s/^deno //p')" = "${DENO_VERSION}"

# Browser automation and coding-agent CLIs are lockfile-pinned. They receive no
# ambient credentials; a developer must explicitly bind the provider secret a
# chosen CLI needs to the Agent's compute policy.
COPY compute-worker/images/standard/toolchain/package.json compute-worker/images/standard/toolchain/package-lock.json /opt/galactic/toolchain/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefix /opt/galactic/toolchain && \
    test "$(node -p 'require("/opt/galactic/toolchain/node_modules/playwright/package.json").version')" = "${PLAYWRIGHT_VERSION}" && \
    test "$(node -p 'require("/opt/galactic/toolchain/node_modules/@anthropic-ai/claude-code/package.json").version')" = "${CLAUDE_CODE_VERSION}" && \
    test "$(node -p 'require("/opt/galactic/toolchain/node_modules/@openai/codex/package.json").version')" = "${CODEX_VERSION}" && \
    /opt/galactic/toolchain/node_modules/.bin/playwright install --with-deps chromium && \
    for command in playwright claude codex; do \
      ln -sf "/opt/galactic/toolchain/node_modules/.bin/${command}" "/usr/local/bin/${command}"; \
    done && \
    mkdir -p /node_modules && \
    ln -s /opt/galactic/toolchain/node_modules/playwright /node_modules/playwright && \
    ln -s /opt/galactic/toolchain/node_modules/playwright-core /node_modules/playwright-core && \
    npm cache clean --force

# Bake the exact CLI source from this release. It is intentionally not fetched
# from npm: the Compute job-mode implementation and the image are one audited
# artifact, and an unpublished/local release cannot silently resolve older code.
COPY cli/package.json cli/package-lock.json /opt/galactic/cli/
COPY cli/bin /opt/galactic/cli/bin
COPY cli/lib /opt/galactic/cli/lib
COPY cli/scripts /opt/galactic/cli/scripts
COPY cli/mod.ts cli/api.ts cli/colors.ts cli/config.ts cli/logging.ts cli/job-context.ts cli/deno.lock cli/skills.md /opt/galactic/cli/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --prefix /opt/galactic/cli && \
    test "$(node -p 'require("/opt/galactic/cli/package.json").version')" = "${GALACTIC_CLI_VERSION}" && \
    deno cache --no-config --lock=/opt/galactic/cli/deno.lock --frozen /opt/galactic/cli/mod.ts && \
    chmod 0755 /opt/galactic/cli/bin/ultralight.js && \
    ln -sf /opt/galactic/cli/bin/ultralight.js /usr/local/bin/galactic && \
    ln -sf /opt/galactic/cli/bin/ultralight.js /usr/local/bin/galacticconnection && \
    npm cache clean --force

COPY compute-worker/images/standard/gx.mjs /opt/galactic/bin/gx.mjs
COPY compute-worker/images/standard/bridge /opt/galactic/bridge
COPY compute-worker/images/standard/entrypoint.sh /opt/galactic/bin/entrypoint.sh

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --prefix /opt/galactic/bridge && \
    chmod 0755 /opt/galactic/bin/gx.mjs /opt/galactic/bridge/gx-mcp.mjs /opt/galactic/bin/entrypoint.sh && \
    ln -s /opt/galactic/bin/gx.mjs /usr/local/bin/gx && \
    mkdir -p /workspace /run/galactic/secrets /opt/galactic/packs && \
    chmod 0700 /run/galactic /run/galactic/secrets && \
    chmod 0755 /workspace /opt/galactic /opt/galactic/packs /opt/galactic/bin

WORKDIR /workspace
ENTRYPOINT ["/opt/galactic/bin/entrypoint.sh"]
