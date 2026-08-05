#!/bin/sh
set -eu

image=${1:-galactic-compute:developer-v1}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cli_package="$script_dir/../../cli/package.json"
expected_cli_version=$(node -e '
  const { version } = require(process.argv[1]);
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) process.exit(1);
  process.stdout.write(version);
' "$cli_package")

docker run --rm \
  --env "EXPECTED_GALACTIC_CLI_VERSION=$expected_cli_version" \
  --entrypoint /bin/bash "$image" -lc '
  set -eu
  command -v bash git git-lfs gh jq rg sqlite3 duckdb ffmpeg convert pandoc libreoffice pdfinfo tesseract rclone psql mysql redis-cli gx claude codex playwright deno galactic galacticconnection python3 pip3 npm
  gh --version | grep "gh version 2.96.0"
  git-lfs version | grep "git-lfs/3.7.1 (Galactic;"
  rclone version | grep "rclone v1.74.4"
  rclone version | grep "go/version: go1.26.5"
  duckdb --version
  test "$(python3 --version)" = "Python 3.13.14"
  test "$(/usr/bin/python3 --version)" = "Python 3.13.14"
  pip3 --version | grep "pip 26.1.2 "
  python3 -c '\''import bz2, ctypes, curses, dbm, html.parser, lzma, readline, socket, sqlite3, ssl, tkinter, uuid, zlib; assert hasattr(html.parser.HTMLParser(), "_pending"); assert hasattr(socket, "AF_BLUETOOTH")'\''
  MPLBACKEND=Agg python3 -c '\''import IPython, matplotlib, numpy, pandas, psutil; frame = pandas.DataFrame({"x": numpy.array([1, 2]), "y": [3, 4]}); axes = frame.plot(x="x", y="y"); axes.figure.canvas.draw()'\''
  test "$(grep -c '^deb https://snapshot.ubuntu.com/ubuntu/20260805T110000Z jammy' /etc/apt/sources.list)" = "4"
  ! grep -R -E '\''https?://(archive|security)\.ubuntu\.com/ubuntu'\'' /etc/apt/sources.list /etc/apt/sources.list.d
  node --version
  test "$(npm --version)" = "12.0.1"
  test "$(node -p '\''require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json").version'\'')" = "5.0.9"
  test "$(node -p '\''require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion").EXPANSION_MAX_LENGTH'\'')" = "4000000"
  test "$(node -p '\''require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion").expand("a{b,c}d").join(",")'\'')" = "abd,acd"
  test "$(node -p '\''require("/usr/local/lib/node_modules/npm/node_modules/ip-address/package.json").version'\'')" = "10.4.0"
  test "$(node -p '\''const { Address4, Address6 } = require("/usr/local/lib/node_modules/npm/node_modules/ip-address"); new Address4("192.0.2.1").correctForm() + "," + new Address6("2001:db8::1").correctForm()'\'')" = "192.0.2.1,2001:db8::1"
  test "$(node -p '\''require("/usr/local/lib/node_modules/npm/node_modules/minimatch").minimatch("release-v0.4.52", "release-v{0.4.52,0.4.53}")'\'')" = "true"
  deno --version | grep "^deno 2.9.3 "
  test "$(cat /opt/galactic/image-metadata/galactic-cli-version.txt)" = "$EXPECTED_GALACTIC_CLI_VERSION"
  test "$(galactic --version)" = "$EXPECTED_GALACTIC_CLI_VERSION"
  test "$(galacticconnection --version)" = "$EXPECTED_GALACTIC_CLI_VERSION"
  test ! -e /usr/local/bin/cloudflared
  node --check /opt/galactic/bin/gx.mjs
  node --check /opt/galactic/bin/configure-chrome-ca-policy.mjs
  node --check /opt/galactic/bridge/gx-mcp.mjs
  test -f /opt/galactic/bridge/node_modules/@modelcontextprotocol/sdk/package.json
  test -L /node_modules/playwright
  test -L /node_modules/playwright-core
  playwright --version
  awk '\''
    /-----BEGIN CERTIFICATE-----/ { emitting = 1 }
    emitting { print }
    /-----END CERTIFICATE-----/ { exit }
  '\'' /etc/ssl/certs/ca-certificates.crt > /tmp/galactic-smoke-ca.crt
  /opt/galactic/bin/configure-chrome-ca-policy.mjs \
    /tmp/galactic-smoke-ca.crt \
    /tmp/galactic-chrome-policy/managed/galactic-cloudflare-ca.json
  node -e '\''
    const { readFileSync } = require("node:fs");
    const policy = JSON.parse(readFileSync(
      "/tmp/galactic-chrome-policy/managed/galactic-cloudflare-ca.json",
      "utf8",
    ));
    if (!Array.isArray(policy.CACertificates) || policy.CACertificates.length !== 1) process.exit(1);
  '\''
  test "$(stat -c %a /tmp/galactic-chrome-policy/managed)" = 755
  test "$(stat -c %a /tmp/galactic-chrome-policy/managed/galactic-cloudflare-ca.json)" = 444
  test "$(stat -c %u /tmp/galactic-chrome-policy/managed/galactic-cloudflare-ca.json)" = 0
  rm -rf /tmp/galactic-smoke-ca.crt /tmp/galactic-chrome-policy
  cd /workspace
  node --input-type=module -e '\''
    import { chromium } from "playwright";
    import { accessSync, constants } from "node:fs";
    accessSync(chromium.executablePath(), constants.X_OK);
    const browser = await chromium.launch({ headless: true });
    if (browser.version() !== "152.0.7977.8") throw new Error(`Unexpected Chromium ${browser.version()}`);
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>compute-smoke</title>");
    if (await page.title() !== "compute-smoke") throw new Error("Chromium smoke failed");
    await browser.close();
  '\''
  test "$(stat -c %a /run/galactic/secrets)" = 700
  test ! -e /run/galactic/job-token
  printf "opaque-smoke-token" > /tmp/galactic-job-token
  GALACTIC_LEASE_ID=lease_smoke \
    GALACTIC_JOB_TOKEN_FILE=/tmp/galactic-job-token \
    GALACTIC_GATEWAY_URL=https://galactic.internal/v1 \
    galactic budget --help | grep "conserved budget for the active Galactic Compute lease"
  rm /tmp/galactic-job-token
  printf "compute image smoke passed\n"
'
