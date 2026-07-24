#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const TARGETS = {
  production: {
    apiWorker: "ultralight-api",
    computeWorker: "galactic-compute",
  },
  staging: {
    apiWorker: "ultralight-api-staging",
    computeWorker: "galactic-compute-staging",
  },
};

function fail(message) {
  throw new Error(`API Compute bootstrap history is invalid: ${message}`);
}

function namedBindings(version, name) {
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings)) {
    fail(`version ${String(version?.id)} has no binding inventory`);
  }
  return bindings.filter((binding) => binding?.name === name);
}

export function verifyApiComputeBootstrapHistory({
  target,
  repository,
  activeVersionId,
  policy,
  inventory,
  versions,
  now = new Date(),
}) {
  const targetState = TARGETS[target];
  if (!targetState) fail(`unsupported target ${String(target)}`);
  if (repository !== policy?.repository) {
    fail("repository does not match the reviewed bootstrap policy");
  }
  if (policy?.schema_version !== 1) {
    fail("unsupported bootstrap policy schema");
  }

  const expiresAt = new Date(policy?.expires_at);
  const checkedAt = now instanceof Date ? now : new Date(now);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    !Number.isFinite(checkedAt.getTime()) ||
    checkedAt.getTime() >= expiresAt.getTime()
  ) {
    fail("reviewed bootstrap policy is expired or malformed");
  }

  const environment = policy?.environments?.[target];
  if (
    environment?.api_worker !== targetState.apiWorker ||
    environment?.compute_worker !== targetState.computeWorker ||
    environment?.allow_bootstrap_without_compute_worker !== true
  ) {
    fail("target is not explicitly approved by the bootstrap policy");
  }

  if (
    typeof activeVersionId !== "string" ||
    !UUID.test(activeVersionId)
  ) {
    fail("active API version ID is malformed");
  }
  if (
    inventory?.success !== true ||
    !Array.isArray(inventory?.errors) ||
    inventory.errors.length !== 0 ||
    !inventory.result ||
    typeof inventory.result !== "object" ||
    Array.isArray(inventory.result) ||
    !Array.isArray(inventory.result.items) ||
    inventory.result.items.length < 1 ||
    inventory.result.items.length > 100
  ) {
    fail("deployable API version inventory is malformed");
  }

  const inventoryIds = new Set();
  for (const item of inventory.result.items) {
    if (
      typeof item?.id !== "string" ||
      !UUID.test(item.id) ||
      inventoryIds.has(item.id.toLowerCase())
    ) {
      fail("deployable API version inventory IDs are malformed or duplicated");
    }
    inventoryIds.add(item.id.toLowerCase());
  }
  if (!inventoryIds.has(activeVersionId.toLowerCase())) {
    fail("active API version is absent from deployable version inventory");
  }

  if (
    !Array.isArray(versions) ||
    versions.length !== inventoryIds.size
  ) {
    fail("version details do not cover the complete deployable inventory");
  }
  const versionIds = new Set();
  for (const version of versions) {
    if (
      typeof version?.id !== "string" ||
      !UUID.test(version.id) ||
      versionIds.has(version.id.toLowerCase())
    ) {
      fail("retained API version IDs are malformed or duplicated");
    }
    versionIds.add(version.id.toLowerCase());
    if (!inventoryIds.has(version.id.toLowerCase())) {
      fail(`version detail ${version.id} is absent from deployable inventory`);
    }

    if (namedBindings(version, "COMPUTE_PLANE").length !== 0) {
      fail(`retained API version ${version.id} has a Compute Plane binding`);
    }
    const enabled = namedBindings(version, "COMPUTE_ENABLED");
    if (
      enabled.length > 1 ||
      (
        enabled.length === 1 &&
        (enabled[0]?.type !== "plain_text" || enabled[0]?.text !== "0")
      )
    ) {
      fail(`retained API version ${version.id} enabled Compute admission`);
    }
  }

  if (
    !versionIds.has(activeVersionId.toLowerCase()) ||
    [...inventoryIds].some((versionId) => !versionIds.has(versionId))
  ) {
    fail("version details do not cover the complete deployable inventory");
  }

  return {
    deployableVersions: versions.length,
    expiresAt: expiresAt.toISOString(),
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function main(argv) {
  if (argv.length < 6 || argv.length > 7) {
    throw new Error(
      "Usage: verify-api-compute-bootstrap-history.mjs " +
        "<production|staging> <repository> <active-version-id> " +
        "<policy-json> <inventory-json> <versions-json> [checked-at]",
    );
  }
  const result = verifyApiComputeBootstrapHistory({
    target: argv[0],
    repository: argv[1],
    activeVersionId: argv[2],
    policy: readJson(argv[3], "Bootstrap policy"),
    inventory: readJson(argv[4], "Deployable API version inventory"),
    versions: readJson(argv[5], "Deployable API version details"),
    now: argv[6] ? new Date(argv[6]) : new Date(),
  });
  console.log(JSON.stringify(result));
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
