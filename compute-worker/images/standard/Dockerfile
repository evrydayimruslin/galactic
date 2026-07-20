# Release builds must pass the complete digest-pinned reference through
# --build-arg, for example:
# docker.io/cloudflare/sandbox:0.12.3-python@sha256:<64 lowercase hex chars>
# There is intentionally no mutable default.
ARG SANDBOX_BASE_IMAGE

# Build the two Go CLIs from immutable sources with a patched compiler. These
# binaries are copied into the runtime image; no build toolchain is retained.
FROM docker.io/library/golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651 AS go-tools
ARG GH_VERSION=2.96.0
ARG GIT_LFS_VERSION=3.7.1
ENV GOTOOLCHAIN=local \
    GOPROXY=https://proxy.golang.org,direct \
    GOSUMDB=sum.golang.org \
    CGO_ENABLED=0

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl patch && \
    rm -rf /var/lib/apt/lists/*

COPY compute-worker/images/standard/overlays/git-lfs-v3.7.1-go-modules.patch /tmp/git-lfs-go-modules.patch
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eux; \
    mkdir -p /out; \
    GOBIN=/out go install -trimpath \
      -ldflags="-s -w -X github.com/cli/cli/v2/internal/build.Version=${GH_VERSION} -X github.com/cli/cli/v2/internal/build.Date=2026-07-02" \
      "github.com/cli/cli/v2/cmd/gh@v${GH_VERSION}"; \
    /out/gh --version | grep -F "gh version ${GH_VERSION}"; \
    go version -m /out/gh | grep -F 'go1.26.5'

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eux; \
    curl -fsSL -o /tmp/git-lfs.tar.gz \
      "https://github.com/git-lfs/git-lfs/releases/download/v${GIT_LFS_VERSION}/git-lfs-v${GIT_LFS_VERSION}.tar.gz"; \
    echo '8f56058622edfea1d111e50e9844ef2f5ce670b2dbe4d55d48e765c943af4351  /tmp/git-lfs.tar.gz' | sha256sum -c -; \
    mkdir -p /tmp/git-lfs; \
    tar -xzf /tmp/git-lfs.tar.gz --strip-components=1 -C /tmp/git-lfs; \
    patch -d /tmp/git-lfs -p1 < /tmp/git-lfs-go-modules.patch; \
    cd /tmp/git-lfs; \
    go mod verify; \
    go test ./...; \
    go build -trimpath \
      -ldflags="-s -w -X github.com/git-lfs/git-lfs/v3/config.GitCommit=v${GIT_LFS_VERSION}-galactic.1 -X github.com/git-lfs/git-lfs/v3/config.Vendor=Galactic" \
      -o /out/git-lfs ./git-lfs.go; \
    /out/git-lfs version | grep -F "git-lfs/${GIT_LFS_VERSION} (Galactic;"; \
    go version -m /out/git-lfs | grep -F 'go1.26.5'; \
    rm -rf /tmp/git-lfs /tmp/git-lfs.tar.gz

# The Sandbox Python flavor currently carries an older /usr/local/python tree.
# Build a replacement at the same prefix and apply the exact upstream 3.13
# security backport before any runtime files are copied into the final stage.
FROM ${SANDBOX_BASE_IMAGE} AS python-runtime
ARG PYTHON_VERSION=3.13.14
COPY compute-worker/images/standard/python/requirements.lock /tmp/python-requirements.lock
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl patch xz-utils \
      libbluetooth-dev libbz2-dev libdb-dev libexpat1-dev libffi-dev libgdbm-dev \
      liblzma-dev libncursesw5-dev libreadline-dev libsqlite3-dev \
      libssl-dev tk-dev uuid-dev zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSL -o /tmp/Python.tar.xz \
      "https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tar.xz"; \
    echo '639e43243c620a308f968213df9e00f2f8f62332f7adbaa7a7eeb9783057c690  /tmp/Python.tar.xz' | sha256sum -c -; \
    curl -fsSL -o /tmp/cpython-cve-2026-11972.patch \
      'https://github.com/python/cpython/commit/3f031d431f80668e14f3bc066bbf4369cd9281b9.patch'; \
    echo '240177f6a8e0e328773cb775add1f2cfe9128e67d461a9ba728fbb3cbbe89086  /tmp/cpython-cve-2026-11972.patch' | sha256sum -c -; \
    curl -fsSL -o /tmp/cpython-cve-2026-11940.patch \
      'https://github.com/python/cpython/commit/771d12dda5140313db0ac550292987975651bbde.patch'; \
    echo 'f74e92f1eb84a91b3efc144660d9e59162d81a922bb9ecccb2e64b832c91d387  /tmp/cpython-cve-2026-11940.patch' | sha256sum -c -; \
    curl -fsSL -o /tmp/cpython-cve-2026-15308.patch \
      'https://github.com/python/cpython/commit/7933f4bf7131aa4140750f9404f5de0aa2969ced.patch'; \
    echo 'd8913b46e769704d0e810994909ee81c8af6aaa7230b79ff4c0d849fe1f305a4  /tmp/cpython-cve-2026-15308.patch' | sha256sum -c -; \
    mkdir -p /tmp/python-source; \
    tar -xJf /tmp/Python.tar.xz --strip-components=1 -C /tmp/python-source; \
    patch -d /tmp/python-source -p1 < /tmp/cpython-cve-2026-11972.patch; \
    patch -d /tmp/python-source -p1 < /tmp/cpython-cve-2026-11940.patch; \
    patch -d /tmp/python-source -p1 < /tmp/cpython-cve-2026-15308.patch; \
    cd /tmp/python-source; \
    LDFLAGS='-Wl,-rpath=/usr/local/python/lib' ./configure \
      --prefix=/usr/local/python \
      --enable-shared \
      --enable-optimizations \
      --enable-loadable-sqlite-extensions \
      --enable-option-checking=fatal \
      --with-ensurepip=install; \
    make -j"$(nproc)"; \
    LD_LIBRARY_PATH=/tmp/python-source \
      ./python -m test -u cpu test_tarfile test_htmlparser; \
    rm -rf /usr/local/python; \
    make install; \
    /usr/local/python/bin/python3 -m pip install \
      --no-cache-dir --only-binary=:all: --require-hashes \
      --requirement /tmp/python-requirements.lock; \
    /usr/local/python/bin/python3 -c 'import html.parser, IPython, matplotlib, numpy, pandas, psutil; assert hasattr(html.parser.HTMLParser(), "_pending")'; \
    test "$(/usr/local/python/bin/python3 --version)" = "Python ${PYTHON_VERSION}"; \
    rm -rf /tmp/python-source /tmp/Python.tar.xz \
      /tmp/cpython-cve-2026-11972.patch \
      /tmp/cpython-cve-2026-11940.patch \
      /tmp/cpython-cve-2026-15308.patch \
      /tmp/python-requirements.lock

FROM ${SANDBOX_BASE_IMAGE}

# A pre-FROM ARG is only in Docker's global scope. Redeclare it in the build
# stage so the exact base reference is preserved in image metadata.
ARG SANDBOX_BASE_IMAGE
ARG TARGETARCH
ARG DUCKDB_VERSION=1.5.1
ARG PLAYWRIGHT_VERSION=1.62.0-alpha-2026-07-20
ARG CLAUDE_CODE_VERSION=2.1.215
ARG CODEX_VERSION=0.144.6
ARG DENO_VERSION=2.9.3
ARG GALACTIC_CLI_VERSION=2.4.0
ARG GH_VERSION=2.96.0
ARG GIT_LFS_VERSION=3.7.1
ARG GALACTIC_RCLONE_VERSION=1.74.4
ARG PYTHON_VERSION=3.13.14
ARG NPM_VERSION=12.0.1

# Keep the exact release inputs visible in OCI metadata. The Node package graph
# itself is installed from toolchain/package-lock.json below; these labels also
# let release evidence assert that the lock and intended direct versions agree.
LABEL org.opencontainers.image.base.name="${SANDBOX_BASE_IMAGE}" \
      ai.galactic.tool.playwright="playwright@${PLAYWRIGHT_VERSION}" \
      ai.galactic.tool.claude-code="@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      ai.galactic.tool.codex="@openai/codex@${CODEX_VERSION}" \
      ai.galactic.tool.deno="deno@${DENO_VERSION}" \
      ai.galactic.tool.galactic-cli="galacticconnection@${GALACTIC_CLI_VERSION}" \
      ai.galactic.tool.gh="gh@${GH_VERSION}" \
      ai.galactic.tool.git-lfs="git-lfs@${GIT_LFS_VERSION}-galactic.1" \
      ai.galactic.tool.rclone="rclone@${GALACTIC_RCLONE_VERSION}" \
      ai.galactic.tool.python="python@${PYTHON_VERSION}+cve-2026-11940-11972-15308-backports" \
      ai.galactic.tool.npm="npm@${NPM_VERSION}" \
      ai.galactic.security.cloudflared="absent-private-egress-v1"

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/usr/local/python/bin:${PATH} \
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
      git openssh-client rsync \
      curl wget ca-certificates dnsutils netcat-openbsd \
      jq ripgrep sqlite3 \
      postgresql-client default-mysql-client redis-tools \
      ffmpeg imagemagick \
      pandoc \
      libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils tesseract-ocr tesseract-ocr-eng \
      xvfb fonts-dejavu fonts-liberation \
      file unzip zip gzip bzip2 xz-utils tar less tree && \
    rm -rf /var/lib/apt/lists/*

# Replace inherited vulnerable runtimes and install the audited Go builds. The
# Cloudflare quick-tunnel helper is intentionally absent: bodies use private
# service bindings and v1 exposes no public Sandbox tunnel/preview primitive.
RUN rm -rf /usr/local/python && \
    rm -f /usr/local/bin/cloudflared
COPY --from=python-runtime /usr/local/python /usr/local/python
COPY --from=go-tools /out/gh /usr/local/bin/gh
COPY --from=go-tools /out/git-lfs /usr/local/bin/git-lfs
RUN set -eux; \
    update-alternatives --remove python3 /usr/local/bin/python3.11; \
    rm -f /usr/local/bin/python3.11; \
    ln -sfn /usr/local/python/bin/python3.13 /usr/local/bin/python3.13; \
    ln -sfn /usr/local/python/bin/python3 /usr/local/bin/python3; \
    ln -sfn /usr/local/python/bin/python3 /usr/local/bin/python; \
    ln -sfn /usr/local/python/bin/pip3 /usr/local/bin/pip3; \
    ln -sfn /usr/local/python/bin/pip3 /usr/local/bin/pip; \
    update-alternatives --install /usr/bin/python3 python3 /usr/local/bin/python3.13 1; \
    ldconfig; \
    test "$(/usr/bin/python3 --version)" = "Python ${PYTHON_VERSION}"; \
    ldd /usr/local/python/bin/python3.13 | grep -F 'libpython3.13.so.1.0'

# rclone's upstream binary is already built with Go 1.26.5. Pin and verify the
# release archive instead of retaining Ubuntu's old statically linked build.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) rclone_arch=amd64; rclone_sha=fe435e0c36228e7c2f116a8701f01127bb1f694005fc11d1f27186c8bca4115d ;; \
      arm64) rclone_arch=arm64; rclone_sha=97685285c9ad6a0cf17d5844115d2a67245af6444db672187074bd9c358de419 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    rclone_archive="rclone-v${GALACTIC_RCLONE_VERSION}-linux-${rclone_arch}.zip"; \
    curl -fsSL -o "/tmp/${rclone_archive}" \
      "https://github.com/rclone/rclone/releases/download/v${GALACTIC_RCLONE_VERSION}/${rclone_archive}"; \
    echo "${rclone_sha}  /tmp/${rclone_archive}" | sha256sum -c -; \
    unzip -q "/tmp/${rclone_archive}" -d /tmp/rclone; \
    install -m 0755 "/tmp/rclone/rclone-v${GALACTIC_RCLONE_VERSION}-linux-${rclone_arch}/rclone" /usr/local/bin/rclone; \
    rm -rf /tmp/rclone "/tmp/${rclone_archive}"; \
    rclone version | grep -F "rclone v${GALACTIC_RCLONE_VERSION}"; \
    rclone version | grep -F 'go/version: go1.26.5'

# npm is part of the base Node runtime. Replace its old bundled dependency tree
# from an integrity-pinned registry tarball before installing any body tools.
RUN set -eux; \
    curl -fsSL -o /tmp/npm.tgz \
      "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz"; \
    echo '2f94fd8bf600416416a934bfc59c4991e8bff7372ef7d842784e2a8b8d48c81555ee645069ddea73625fb8e92dc261feab0188fd5dab6c22fefd46316f5f9140  /tmp/npm.tgz' | sha512sum -c -; \
    npm install --global /tmp/npm.tgz; \
    rm /tmp/npm.tgz; \
    test "$(npm --version)" = "${NPM_VERSION}"; \
    test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/picomatch/package.json").version')" = 4.0.5; \
    test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/sigstore/package.json").version')" = 5.0.0

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
      amd64) deno_arch=x86_64; deno_sha=8101865641cbede56f08ad19c0a67a87df84bce127fee0d3e3e1f7467717ffa6 ;; \
      arm64) deno_arch=aarch64; deno_sha=753937db98a4b56cbbbd26e8f00eb4b789191a229afec93f74bcfa4e79bc2c8b ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    deno_archive="deno-${deno_arch}-unknown-linux-gnu.zip"; \
    curl -fsSL -o "/tmp/${deno_archive}" \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${deno_archive}"; \
    echo "${deno_sha}  /tmp/${deno_archive}" | sha256sum -c -; \
    unzip -q "/tmp/${deno_archive}" -d /usr/local/bin; \
    rm "/tmp/${deno_archive}"; \
    test "$(deno --version | awk 'NR == 1 { print $2 }')" = "${DENO_VERSION}"

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
