# Release builds must pass the complete digest-pinned reference through
# --build-arg, for example:
# docker.io/cloudflare/sandbox:0.12.3-python@sha256:<64 lowercase hex chars>
# There is intentionally no mutable default.
ARG SANDBOX_BASE_IMAGE
ARG UBUNTU_SNAPSHOT=20260805T110000Z

# Build the Go CLIs from immutable, checksum-verified modules with a patched
# compiler. gh and rclone stay on their product-pinned releases while forcing
# fixed gRPC-Go, x/net, and x/text releases. These binaries are copied into the
# runtime image; no build toolchain is retained.
FROM docker.io/library/golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651 AS go-tools
ARG GH_VERSION=2.96.0
ARG GIT_LFS_VERSION=3.7.1
ARG GALACTIC_RCLONE_VERSION=1.74.4
ARG GRPC_GO_VERSION=1.82.1
ARG GOLANG_X_NET_VERSION=0.56.0
ARG GOLANG_X_TEXT_VERSION=0.39.0
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
    go mod download "github.com/cli/cli/v2@v${GH_VERSION}"; \
    cp -a "$(go env GOMODCACHE)/github.com/cli/cli/v2@v${GH_VERSION}" /tmp/gh; \
    chmod -R u+w /tmp/gh; \
    cd /tmp/gh; \
    go mod edit "-require=google.golang.org/grpc@v${GRPC_GO_VERSION}"; \
    go mod edit "-require=golang.org/x/net@v${GOLANG_X_NET_VERSION}"; \
    go mod edit "-require=golang.org/x/text@v${GOLANG_X_TEXT_VERSION}"; \
    go mod tidy; \
    go mod verify; \
    test "$(go list -m -f '{{.Version}}' google.golang.org/grpc)" = "v${GRPC_GO_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' golang.org/x/net)" = "v${GOLANG_X_NET_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' golang.org/x/text)" = "v${GOLANG_X_TEXT_VERSION}"; \
    go build -trimpath \
      -ldflags="-s -w -X github.com/cli/cli/v2/internal/build.Version=${GH_VERSION} -X github.com/cli/cli/v2/internal/build.Date=2026-07-02" \
      -o /out/gh ./cmd/gh; \
    /out/gh --version | grep -F "gh version ${GH_VERSION}"; \
    go version -m /out/gh | grep -F 'go1.26.5'; \
    go version -m /out/gh | awk -v expected="v${GRPC_GO_VERSION}" \
      '$1 == "dep" && $2 == "google.golang.org/grpc" && $3 == expected { found = 1 } END { exit !found }'; \
    go version -m /out/gh | awk -v expected="v${GOLANG_X_NET_VERSION}" \
      '$1 == "dep" && $2 == "golang.org/x/net" && $3 == expected { found = 1 } END { exit !found }'; \
    go version -m /out/gh | awk -v expected="v${GOLANG_X_TEXT_VERSION}" \
      '$1 == "dep" && $2 == "golang.org/x/text" && $3 == expected { found = 1 } END { exit !found }'; \
    rm -rf /tmp/gh

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eux; \
    go mod download "github.com/rclone/rclone@v${GALACTIC_RCLONE_VERSION}"; \
    cp -a "$(go env GOMODCACHE)/github.com/rclone/rclone@v${GALACTIC_RCLONE_VERSION}" /tmp/rclone; \
    chmod -R u+w /tmp/rclone; \
    cd /tmp/rclone; \
    go mod edit "-require=google.golang.org/grpc@v${GRPC_GO_VERSION}"; \
    go mod edit "-require=golang.org/x/net@v${GOLANG_X_NET_VERSION}"; \
    go mod edit "-require=golang.org/x/text@v${GOLANG_X_TEXT_VERSION}"; \
    go mod tidy; \
    go mod verify; \
    test "$(go list -m -f '{{.Version}}' google.golang.org/grpc)" = "v${GRPC_GO_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' golang.org/x/net)" = "v${GOLANG_X_NET_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' golang.org/x/text)" = "v${GOLANG_X_TEXT_VERSION}"; \
    go build -trimpath \
      -ldflags="-s -w -X github.com/rclone/rclone/fs.Version=v${GALACTIC_RCLONE_VERSION}" \
      -o /out/rclone .; \
    /out/rclone version | grep -F "rclone v${GALACTIC_RCLONE_VERSION}"; \
    /out/rclone version | grep -F 'go/version: go1.26.5'; \
    go version -m /out/rclone | grep -F 'go1.26.5'; \
    go version -m /out/rclone | awk -v expected="v${GRPC_GO_VERSION}" \
      '$1 == "dep" && $2 == "google.golang.org/grpc" && $3 == expected { found = 1 } END { exit !found }'; \
    go version -m /out/rclone | awk -v expected="v${GOLANG_X_NET_VERSION}" \
      '$1 == "dep" && $2 == "golang.org/x/net" && $3 == expected { found = 1 } END { exit !found }'; \
    go version -m /out/rclone | awk -v expected="v${GOLANG_X_TEXT_VERSION}" \
      '$1 == "dep" && $2 == "golang.org/x/text" && $3 == expected { found = 1 } END { exit !found }'; \
    rm -rf /tmp/rclone

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
    test "$(go list -m -f '{{.Version}}' golang.org/x/net)" = "v${GOLANG_X_NET_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' golang.org/x/text)" = "v${GOLANG_X_TEXT_VERSION}"; \
    go test ./...; \
    go build -trimpath \
      -ldflags="-s -w -X github.com/git-lfs/git-lfs/v3/config.GitCommit=v${GIT_LFS_VERSION}-galactic.1 -X github.com/git-lfs/git-lfs/v3/config.Vendor=Galactic" \
      -o /out/git-lfs ./git-lfs.go; \
    /out/git-lfs version | grep -F "git-lfs/${GIT_LFS_VERSION} (Galactic;"; \
    go version -m /out/git-lfs | grep -F 'go1.26.5'; \
    go version -m /out/git-lfs | awk -v expected="v${GOLANG_X_NET_VERSION}" \
      '$1 == "dep" && $2 == "golang.org/x/net" && $3 == expected { found = 1 } END { exit !found }'; \
    go version -m /out/git-lfs | awk -v expected="v${GOLANG_X_TEXT_VERSION}" \
      '$1 == "dep" && $2 == "golang.org/x/text" && $3 == expected { found = 1 } END { exit !found }'; \
    rm -rf /tmp/git-lfs /tmp/git-lfs.tar.gz

# The Sandbox Python flavor currently carries an older /usr/local/python tree.
# Build a replacement at the same prefix and apply the exact upstream 3.13
# security backport before any runtime files are copied into the final stage.
FROM ${SANDBOX_BASE_IMAGE} AS python-runtime
ARG UBUNTU_SNAPSHOT
ARG PYTHON_VERSION=3.13.14
COPY compute-worker/images/standard/python/requirements.lock /tmp/python-requirements.lock
# Vendored as exact unified diffs from these immutable upstream commits. GitHub's
# generated .patch representation is not an immutable artifact and must not be
# fetched during a release build:
# CVE-2026-11972: 3f031d431f80668e14f3bc066bbf4369cd9281b9
# CVE-2026-11940: 771d12dda5140313db0ac550292987975651bbde
# CVE-2026-15308: 7933f4bf7131aa4140750f9404f5de0aa2969ced
COPY compute-worker/images/standard/python/patches /tmp/python-security-patches
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources && \
    snapshot_root="https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}" && \
    printf '%s\n' \
      "deb ${snapshot_root} jammy main restricted universe multiverse" \
      "deb ${snapshot_root} jammy-updates main restricted universe multiverse" \
      "deb ${snapshot_root} jammy-backports main restricted universe multiverse" \
      "deb ${snapshot_root} jammy-security main restricted universe multiverse" \
      > /etc/apt/sources.list && \
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
    echo '4d7ccbe21433911d9fccbb73fbe02b6767f3968837e117dbd4a2361ab23d7df2  /tmp/python-security-patches/cve-2026-11972.patch' | sha256sum -c -; \
    echo '164d2fa4eda5d9ba9084b30940bf81359523e1d1d8e6b0ff753a17fb9c308eac  /tmp/python-security-patches/cve-2026-11940.patch' | sha256sum -c -; \
    echo '1468bb09b06e351b2ed9212f9a068a8f7a988f84dd1bc0021233f85cf05693d4  /tmp/python-security-patches/cve-2026-15308.patch' | sha256sum -c -; \
    mkdir -p /tmp/python-source; \
    tar -xJf /tmp/Python.tar.xz --strip-components=1 -C /tmp/python-source; \
    patch --batch --fuzz=0 -d /tmp/python-source -p1 < /tmp/python-security-patches/cve-2026-11972.patch; \
    patch --batch --fuzz=0 -d /tmp/python-source -p1 < /tmp/python-security-patches/cve-2026-11940.patch; \
    patch --batch --fuzz=0 -d /tmp/python-source -p1 < /tmp/python-security-patches/cve-2026-15308.patch; \
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
      /tmp/python-security-patches \
      /tmp/python-requirements.lock

FROM ${SANDBOX_BASE_IMAGE}

# A pre-FROM ARG is only in Docker's global scope. Redeclare it in the build
# stage so the exact base reference is preserved in image metadata.
ARG SANDBOX_BASE_IMAGE
ARG UBUNTU_SNAPSHOT
ARG TARGETARCH
ARG DUCKDB_VERSION=1.5.1
ARG PLAYWRIGHT_VERSION=1.62.0-alpha-2026-07-20
ARG CHROME_FOR_TESTING_VERSION=152.0.7977.8
ARG CLAUDE_CODE_VERSION=2.1.215
ARG CODEX_VERSION=0.144.6
ARG DENO_VERSION=2.9.3
ARG GH_VERSION=2.96.0
ARG GIT_LFS_VERSION=3.7.1
ARG GALACTIC_RCLONE_VERSION=1.74.4
ARG GRPC_GO_VERSION=1.82.1
ARG PYTHON_VERSION=3.13.14
ARG NPM_VERSION=12.0.1
ARG BRACE_EXPANSION_VERSION=5.0.9
ARG IP_ADDRESS_VERSION=10.4.0

# Keep the exact externally pinned release inputs visible in OCI metadata. The
# local Galactic CLI version is intentionally derived from cli/package.json
# below and recorded inside the image instead of being duplicated here.
LABEL org.opencontainers.image.base.name="${SANDBOX_BASE_IMAGE}" \
      ai.galactic.security.ubuntu-snapshot="${UBUNTU_SNAPSHOT}" \
      ai.galactic.tool.playwright="playwright@${PLAYWRIGHT_VERSION}" \
      ai.galactic.tool.chrome="chrome-for-testing-beta@${CHROME_FOR_TESTING_VERSION}" \
      ai.galactic.tool.claude-code="@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      ai.galactic.tool.codex="@openai/codex@${CODEX_VERSION}" \
      ai.galactic.tool.deno="deno@${DENO_VERSION}" \
      ai.galactic.tool.galactic-cli.source="cli/package.json" \
      ai.galactic.tool.gh="gh@${GH_VERSION}" \
      ai.galactic.tool.git-lfs="git-lfs@${GIT_LFS_VERSION}-galactic.1" \
      ai.galactic.tool.rclone="rclone@${GALACTIC_RCLONE_VERSION}" \
      ai.galactic.security.grpc-go="${GRPC_GO_VERSION}" \
      ai.galactic.tool.python="python@${PYTHON_VERSION}+cve-2026-11940-11972-15308-backports" \
      ai.galactic.tool.npm="npm@${NPM_VERSION}" \
      ai.galactic.security.npm-brace-expansion="${BRACE_EXPANSION_VERSION}" \
      ai.galactic.security.npm-ip-address="${IP_ADDRESS_VERSION}" \
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
# Every Ubuntu package is resolved from one signed, timestamped Canonical
# snapshot. This makes the build repeatable and avoids live-mirror index skew.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources && \
    snapshot_root="https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}" && \
    printf '%s\n' \
      "deb ${snapshot_root} jammy main restricted universe multiverse" \
      "deb ${snapshot_root} jammy-updates main restricted universe multiverse" \
      "deb ${snapshot_root} jammy-backports main restricted universe multiverse" \
      "deb ${snapshot_root} jammy-security main restricted universe multiverse" \
      > /etc/apt/sources.list && \
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
COPY --from=go-tools /out/rclone /usr/local/bin/rclone
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

# npm is part of the base Node runtime. Replace its old bundled dependency tree
# from an integrity-pinned registry tarball before installing any body tools.
# npm 12.0.1 predates the fixed brace-expansion and ip-address releases, so
# overlay those exact checksum-pinned packages until npm bundles fixed versions.
RUN set -eux; \
    curl -fsSL -o /tmp/npm.tgz \
      "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz"; \
    curl -fsSL -o /tmp/brace-expansion.tgz \
      "https://registry.npmjs.org/brace-expansion/-/brace-expansion-${BRACE_EXPANSION_VERSION}.tgz"; \
    curl -fsSL -o /tmp/ip-address.tgz \
      "https://registry.npmjs.org/ip-address/-/ip-address-${IP_ADDRESS_VERSION}.tgz"; \
    echo '2f94fd8bf600416416a934bfc59c4991e8bff7372ef7d842784e2a8b8d48c81555ee645069ddea73625fb8e92dc261feab0188fd5dab6c22fefd46316f5f9140  /tmp/npm.tgz' | sha512sum -c -; \
    echo '49c43822ebc8105d533253fb66dfaf8c9ffff7394f6f64837315b13376e4f2ceade8619d27b28ed5d09c4e274e3c929e3d6df42c4ff6713ef00b23e1a3dfd6c6  /tmp/brace-expansion.tgz' | sha512sum -c -; \
    echo 'a122bde86ae6dda3fa3ab4b6eb7c55c5b3431952fbaf306d61da46aa50c6f2241da1e9c3a13b3f9e4922f837e561b00413c5e5ea8e58c61c65acabc8de7a8a5d  /tmp/ip-address.tgz' | sha512sum -c -; \
    npm install --global /tmp/npm.tgz; \
    rm -rf \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/ip-address; \
    mkdir -p \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/ip-address; \
    tar -xzf /tmp/brace-expansion.tgz --strip-components=1 \
      -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion; \
    tar -xzf /tmp/ip-address.tgz --strip-components=1 \
      -C /usr/local/lib/node_modules/npm/node_modules/ip-address; \
    rm /tmp/npm.tgz /tmp/brace-expansion.tgz /tmp/ip-address.tgz; \
    test "$(npm --version)" = "${NPM_VERSION}"; \
    test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json").version')" = "${BRACE_EXPANSION_VERSION}"; \
    test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion").EXPANSION_MAX_LENGTH')" = 4000000; \
    test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion").expand("a{b,c}d").join(",")')" = "abd,acd"; \
    test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/ip-address/package.json").version')" = "${IP_ADDRESS_VERSION}"; \
    test "$(node -p 'const { Address4, Address6 } = require("/usr/local/lib/node_modules/npm/node_modules/ip-address"); new Address4("192.0.2.1").correctForm() + "," + new Address6("2001:db8::1").correctForm()')" = "192.0.2.1,2001:db8::1"; \
    test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/minimatch").minimatch("release-v0.4.52", "release-v{0.4.52,0.4.53}")')" = true; \
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

# Browser automation and coding-agent CLIs are lockfile-pinned. Playwright's
# currently bundled Chrome predates the vendor's 151.0.7922.72 security fix, so
# keep the JavaScript API pinned while replacing only its browser payload with
# Google's newer, version-addressed and checksum-pinned Chrome-for-Testing beta.
# This is the vendor's automation-specific artifact and has no package-manager
# or updater hooks. The image is amd64-only today; fail closed rather than
# silently installing the wrong architecture. Link both of Playwright's normal
# zero-config launch paths (headed Chromium and its default headless-shell
# registry) to the audited binary. These tools receive no ambient credentials;
# a developer must explicitly bind the provider secret a chosen CLI needs to
# the Agent's compute policy.
COPY compute-worker/images/standard/toolchain/package.json compute-worker/images/standard/toolchain/package-lock.json /opt/galactic/toolchain/
RUN --mount=type=cache,target=/root/.npm \
    set -eux; \
    test "${TARGETARCH}" = amd64; \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      npm ci --omit=dev --prefix /opt/galactic/toolchain; \
    test "$(node -p 'require("/opt/galactic/toolchain/node_modules/playwright/package.json").version')" = "${PLAYWRIGHT_VERSION}"; \
    test "$(node -p 'require("/opt/galactic/toolchain/node_modules/@anthropic-ai/claude-code/package.json").version')" = "${CLAUDE_CODE_VERSION}"; \
    test "$(node -p 'require("/opt/galactic/toolchain/node_modules/@openai/codex/package.json").version')" = "${CODEX_VERSION}"; \
    /opt/galactic/toolchain/node_modules/.bin/playwright install-deps chromium; \
    /opt/galactic/toolchain/node_modules/.bin/playwright install ffmpeg; \
    chrome_archive="chrome-for-testing-${CHROME_FOR_TESTING_VERSION}-linux64.zip"; \
    headless_archive="chrome-headless-shell-for-testing-${CHROME_FOR_TESTING_VERSION}-linux64.zip"; \
    curl -fsSL -o "/tmp/${chrome_archive}" \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/linux64/chrome-linux64.zip"; \
    curl -fsSL -o "/tmp/${headless_archive}" \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/linux64/chrome-headless-shell-linux64.zip"; \
    printf '%s  %s\n' \
      '931865951a28fccf0491a7f5e0a2fe1a0605765210a4ce4a4758d9d3d97d0b77' \
      "/tmp/${chrome_archive}" | sha256sum -c -; \
    printf '%s  %s\n' \
      '9615c0c2557b614a87605e7149372ef50cff8fe8c52e7ebb855efd0cea6b1501' \
      "/tmp/${headless_archive}" | sha256sum -c -; \
    rm -rf /ms-playwright/chromium-1234 \
      /ms-playwright/chromium_headless_shell-1234; \
    install -d /ms-playwright/chromium-1234 \
      /ms-playwright/chromium_headless_shell-1234; \
    unzip -q "/tmp/${chrome_archive}" -d /ms-playwright/chromium-1234; \
    unzip -q "/tmp/${headless_archive}" -d /ms-playwright/chromium_headless_shell-1234; \
    rm "/tmp/${chrome_archive}" "/tmp/${headless_archive}"; \
    test "$(/ms-playwright/chromium-1234/chrome-linux64/chrome --version | awk '{ print $NF }')" = "${CHROME_FOR_TESTING_VERSION}"; \
    test "$(/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell --version | awk '{ print $NF }')" = "${CHROME_FOR_TESTING_VERSION}"; \
    touch /ms-playwright/chromium-1234/INSTALLATION_COMPLETE; \
    touch /ms-playwright/chromium_headless_shell-1234/INSTALLATION_COMPLETE; \
    test "$(node -e 'const { chromium } = require("/opt/galactic/toolchain/node_modules/playwright"); process.stdout.write(chromium.executablePath())')" = "/ms-playwright/chromium-1234/chrome-linux64/chrome"; \
    test -x /ms-playwright/chromium-1234/chrome-linux64/chrome; \
    test -x /ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell; \
    for command in playwright claude codex; do \
      ln -sf "/opt/galactic/toolchain/node_modules/.bin/${command}" "/usr/local/bin/${command}"; \
    done; \
    mkdir -p /node_modules; \
    ln -s /opt/galactic/toolchain/node_modules/playwright /node_modules/playwright; \
    ln -s /opt/galactic/toolchain/node_modules/playwright-core /node_modules/playwright-core; \
    rm -rf /var/lib/apt/lists/*; \
    npm cache clean --force

# Bake the exact CLI source from this release. It is intentionally not fetched
# from npm: the Compute job-mode implementation and the image are one audited
# artifact, and an unpublished/local release cannot silently resolve older code.
COPY cli/package.json cli/package-lock.json /opt/galactic/cli/
COPY cli/bin /opt/galactic/cli/bin
COPY cli/lib /opt/galactic/cli/lib
COPY cli/scripts /opt/galactic/cli/scripts
COPY cli/mod.ts cli/api.ts cli/colors.ts cli/config.ts cli/logging.ts cli/job-context.ts cli/source-files.ts cli/deno.lock cli/skills.md /opt/galactic/cli/
RUN --mount=type=cache,target=/root/.npm \
    set -eux; \
    cli_version="$(node -p 'require("/opt/galactic/cli/package.json").version')"; \
    node -e 'const version = require("/opt/galactic/cli/package.json").version; if (typeof version !== "string" || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) process.exit(1)'; \
    npm ci --omit=dev --ignore-scripts --prefix /opt/galactic/cli; \
    deno cache --no-config --lock=/opt/galactic/cli/deno.lock --frozen /opt/galactic/cli/mod.ts && \
    chmod 0755 /opt/galactic/cli/bin/ultralight.js && \
    ln -sf /opt/galactic/cli/bin/ultralight.js /usr/local/bin/galactic && \
    ln -sf /opt/galactic/cli/bin/ultralight.js /usr/local/bin/galacticconnection && \
    install -d -m 0755 /opt/galactic/image-metadata && \
    printf '%s\n' "$cli_version" > /opt/galactic/image-metadata/galactic-cli-version.txt && \
    test "$(galactic --version)" = "$cli_version" && \
    test "$(galacticconnection --version)" = "$cli_version" && \
    npm cache clean --force

COPY compute-worker/images/standard/gx.mjs /opt/galactic/bin/gx.mjs
COPY compute-worker/images/standard/configure-chrome-ca-policy.mjs /opt/galactic/bin/configure-chrome-ca-policy.mjs
COPY compute-worker/images/standard/bridge /opt/galactic/bridge
COPY compute-worker/images/standard/entrypoint.sh /opt/galactic/bin/entrypoint.sh

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --prefix /opt/galactic/bridge && \
    chmod 0755 /opt/galactic/bin/gx.mjs \
      /opt/galactic/bin/configure-chrome-ca-policy.mjs \
      /opt/galactic/bridge/gx-mcp.mjs \
      /opt/galactic/bin/entrypoint.sh && \
    ln -s /opt/galactic/bin/gx.mjs /usr/local/bin/gx && \
    mkdir -p /workspace /run/galactic/secrets /opt/galactic/packs && \
    chmod 0700 /run/galactic /run/galactic/secrets && \
    chmod 0755 /workspace /opt/galactic /opt/galactic/packs /opt/galactic/bin

WORKDIR /workspace
ENTRYPOINT ["/opt/galactic/bin/entrypoint.sh"]
