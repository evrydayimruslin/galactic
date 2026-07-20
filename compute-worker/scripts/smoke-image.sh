#!/bin/sh
set -eu

image=${1:-galactic-compute:developer-v1}

docker run --rm --entrypoint /bin/bash "$image" -lc '
  set -eu
  command -v bash git gh jq rg sqlite3 duckdb ffmpeg convert pandoc libreoffice pdfinfo tesseract rclone psql mysql redis-cli gx claude codex playwright deno galactic galacticconnection
  duckdb --version
  python3 --version
  node --version
  deno --version | grep "^deno 2.6.10 "
  test "$(galactic --version)" = 2.4.0
  test "$(galacticconnection --version)" = 2.4.0
  node --check /opt/galactic/bin/gx.mjs
  node --check /opt/galactic/bridge/gx-mcp.mjs
  test -f /opt/galactic/bridge/node_modules/@modelcontextprotocol/sdk/package.json
  test -L /node_modules/playwright
  test -L /node_modules/playwright-core
  playwright --version
  cd /workspace
  node --input-type=module -e '\''
    import { chromium } from "playwright";
    import { accessSync, constants } from "node:fs";
    accessSync(chromium.executablePath(), constants.X_OK);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent("<title>compute-smoke</title>");
    if (await page.title() !== "compute-smoke") throw new Error("Chromium smoke failed");
    await browser.close();
  '\''
  test "$(stat -c %a /run/galactic/secrets)" = 700
  test ! -e /run/galactic/job-token
  printf "opaque-smoke-token" > /tmp/galactic-job-token
  GALACTIC_LEASE_ID=lease_smoke \
    GALACTIC_JOB_TOKEN_FILE=/tmp/galactic-job-token \
    GALACTIC_GATEWAY_URL=https://galactic.internal/v1 \
    galactic budget --help | grep "active Galactic Compute lease budget"
  rm /tmp/galactic-job-token
  printf "compute image smoke passed\n"
'
