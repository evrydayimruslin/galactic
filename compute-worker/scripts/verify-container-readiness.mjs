#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function verifyContainerReadiness(payload, expectedName, expectedImage) {
  if (!Array.isArray(payload)) {
    throw new Error("Wrangler returned an invalid Container application list.");
  }
  if (!/^[a-z0-9-]+$/u.test(expectedName)) {
    throw new Error("Expected Container application name is malformed.");
  }
  if (!/^registry\.cloudflare\.com\/[0-9a-f]{32}\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/u.test(expectedImage)) {
    throw new Error("Expected Container image must be an exact Cloudflare registry digest.");
  }

  const matches = payload.filter((entry) =>
    isRecord(entry) && entry.name === expectedName
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Container application named ${expectedName}; found ${matches.length}.`,
    );
  }
  const application = matches[0];
  if (application.state !== "active" && application.state !== "ready") {
    throw new Error(
      `Container application ${expectedName} is ${String(application.state)}; waiting for active or ready.`,
    );
  }
  if (application.image !== expectedImage) {
    throw new Error(
      `Container application ${expectedName} does not reference the released image digest.`,
    );
  }
  if (typeof application.id !== "string" || application.id.length === 0) {
    throw new Error(`Container application ${expectedName} omitted its ID.`);
  }
  if (
    (typeof application.version !== "string" && typeof application.version !== "number") ||
    String(application.version).length === 0
  ) {
    throw new Error(`Container application ${expectedName} omitted its version.`);
  }

  return {
    schema_version: 1,
    id: application.id,
    name: application.name,
    state: application.state,
    instances: application.instances ?? null,
    image: application.image,
    version: application.version,
    updated_at: application.updated_at ?? null,
  };
}

async function main() {
  const listPath = process.argv[2];
  const expectedName = process.argv[3];
  const expectedImage = process.argv[4];
  if (!listPath || !expectedName || !expectedImage) {
    throw new Error(
      "Usage: verify-container-readiness.mjs <containers-list.json> <application-name> <exact-image>",
    );
  }
  const payload = JSON.parse(await readFile(listPath, "utf8"));
  const evidence = verifyContainerReadiness(payload, expectedName, expectedImage);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
