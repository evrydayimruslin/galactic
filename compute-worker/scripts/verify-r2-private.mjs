#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireCloudflareEnvelope(payload, description) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.result)) {
    throw new Error(`Cloudflare returned an invalid ${description} response.`);
  }
  return payload.result;
}

export function verifyComputeR2Private(managedPayload, customPayload) {
  const managed = requireCloudflareEnvelope(managedPayload, "R2 managed-domain");
  if (managed.enabled !== false) {
    throw new Error("The R2 development URL must be explicitly disabled.");
  }

  const custom = requireCloudflareEnvelope(customPayload, "R2 custom-domain");
  if (!Array.isArray(custom.domains)) {
    throw new Error("Cloudflare R2 custom-domain response omitted domains.");
  }
  if (custom.domains.length !== 0) {
    const domains = custom.domains.map((entry) =>
      isRecord(entry) && typeof entry.domain === "string"
        ? entry.domain
        : "<unknown>"
    );
    throw new Error(
      `Compute artifact R2 must have no attached custom domains: ${domains.join(", ")}.`,
    );
  }
}

async function main() {
  const managedPath = process.argv[2];
  const customPath = process.argv[3];
  if (!managedPath || !customPath) {
    throw new Error(
      "Usage: verify-r2-private.mjs <managed-domain.json> <custom-domains.json>",
    );
  }
  const [managed, custom] = await Promise.all([
    readFile(managedPath, "utf8").then(JSON.parse),
    readFile(customPath, "utf8").then(JSON.parse),
  ]);
  verifyComputeR2Private(managed, custom);
  process.stdout.write("R2 public access is disabled for Galactic Compute.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
