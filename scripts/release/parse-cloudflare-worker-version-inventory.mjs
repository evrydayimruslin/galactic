#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_DEPLOYABLE_VERSIONS = 100;

function fail(message) {
  throw new Error(
    `Cloudflare Worker version inventory failed closed: ${message}`,
  );
}

function resultShape(result) {
  if (Array.isArray(result)) return "array";
  if (result === null) return "null";
  return typeof result;
}

/**
 * Cloudflare currently documents the paginated `{ result: { items: [] } }`
 * envelope, while `deployable=true` is also returned by the production API as
 * the legacy non-paginated `{ result: [] }` envelope. Both contain the same
 * version records. Normalize only those two known shapes and fail closed on
 * every other response.
 */
export function parseCloudflareWorkerVersionInventory(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("response is not a JSON object");
  }

  if (
    payload.success !== true ||
    !Array.isArray(payload.errors) ||
    payload.errors.length !== 0
  ) {
    fail(
      `success=${String(payload.success)}, ` +
        `errors=${Array.isArray(payload.errors) ? payload.errors.length : "invalid"}`,
    );
  }

  let items;
  if (Array.isArray(payload.result)) {
    items = payload.result;
  } else if (
    payload.result &&
    typeof payload.result === "object" &&
    !Array.isArray(payload.result) &&
    Array.isArray(payload.result.items)
  ) {
    items = payload.result.items;
  } else {
    fail(`unsupported result envelope (${resultShape(payload.result)})`);
  }

  if (
    items.length < 1 ||
    items.length > MAX_DEPLOYABLE_VERSIONS
  ) {
    fail(
      `expected 1-${MAX_DEPLOYABLE_VERSIONS} deployable versions, ` +
        `received ${items.length}`,
    );
  }

  const seen = new Set();
  for (const item of items) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.id !== "string" ||
      !UUID.test(item.id)
    ) {
      fail("version records contain a malformed ID");
    }
    const normalizedId = item.id.toLowerCase();
    if (seen.has(normalizedId)) {
      fail("version records contain a duplicate ID");
    }
    seen.add(normalizedId);
  }

  return items;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    fail("response is not valid JSON");
  }
}

function main(argv) {
  if (argv.length !== 1) {
    throw new Error(
      "Usage: parse-cloudflare-worker-version-inventory.mjs <inventory-json>",
    );
  }
  for (const item of parseCloudflareWorkerVersionInventory(readJson(argv[0]))) {
    console.log(item.id);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
