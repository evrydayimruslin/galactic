#!/bin/sh
set -eu

image=${1:-galactic-compute:developer-v1}

docker run --rm --entrypoint /bin/bash "$image" -lc '
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
  node --version
  test "$(npm --version)" = "12.0.1"
  deno --version | grep "^deno 2.9.3 "
  test "$(galactic --version)" = 2.4.0
  test "$(galacticconnection --version)" = 2.4.0
  test ! -e /usr/local/bin/cloudflared
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
    if (browser.version() !== "151.0.7922.34") throw new Error(`Unexpected Chromium ${browser.version()}`);
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
