#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const COMPUTE_PREFIX = "compute-v1/";
const FINALIZATION_CHECKPOINT_PREFIX =
  "_galactic-control/v1/compute-finalization/";
const MAX_MULTIPART_AGE_SECONDS = 86_400;
const CHECKPOINT_AGE_SECONDS = 86_400;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function prefixesOverlap(left, right) {
  return left.startsWith(right) || right.startsWith(left);
}

export function verifyComputeR2Lifecycle(payload) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.result)) {
    throw new Error("Cloudflare returned an invalid R2 lifecycle response.");
  }
  const rules = payload.result.rules;
  if (!Array.isArray(rules)) {
    throw new Error("Cloudflare R2 lifecycle response omitted rules.");
  }

  const enabledOverlappingRules = rules.filter((rule) =>
    isRecord(rule) && rule.enabled === true && isRecord(rule.conditions) &&
    typeof rule.conditions.prefix === "string" &&
    prefixesOverlap(rule.conditions.prefix, COMPUTE_PREFIX)
  );
  const deleting = enabledOverlappingRules.filter((rule) =>
    isRecord(rule.deleteObjectsTransition)
  );
  if (deleting.length > 0) {
    const ids = deleting.map((rule) => String(rule.id ?? "<unnamed>"));
    throw new Error(
      `R2 object-deletion lifecycle overlaps ${COMPUTE_PREFIX}: ${ids.join(", ")}. ` +
        "Database reconciliation owns artifact deletion.",
    );
  }

  const hasBoundedMultipartAbort = enabledOverlappingRules.some((rule) => {
    const transition = rule.abortMultipartUploadsTransition;
    if (!isRecord(transition) || !isRecord(transition.condition)) return false;
    return transition.condition.type === "Age" &&
      Number.isFinite(transition.condition.maxAge) &&
      transition.condition.maxAge > 0 &&
      transition.condition.maxAge <= MAX_MULTIPART_AGE_SECONDS;
  });
  if (!hasBoundedMultipartAbort) {
    throw new Error(
      `${COMPUTE_PREFIX} needs an enabled incomplete-multipart abort rule of at most one day.`,
    );
  }

  const checkpointDeletionRules = rules.filter((rule) =>
    isRecord(rule) && rule.enabled === true && isRecord(rule.conditions) &&
    typeof rule.conditions.prefix === "string" &&
    prefixesOverlap(rule.conditions.prefix, FINALIZATION_CHECKPOINT_PREFIX) &&
    isRecord(rule.deleteObjectsTransition)
  );
  const isSafeCheckpointRule = (rule) => {
    if (rule.conditions.prefix !== FINALIZATION_CHECKPOINT_PREFIX) return false;
    const condition = rule.deleteObjectsTransition.condition;
    if (!isRecord(condition) || condition.type !== "Age") return false;
    const maxAge = condition.maxAge;
    return Number.isFinite(maxAge) && maxAge === CHECKPOINT_AGE_SECONDS;
  };
  const broadOrNarrowCheckpointRules = checkpointDeletionRules.filter((rule) =>
    rule.conditions.prefix !== FINALIZATION_CHECKPOINT_PREFIX
  );
  if (broadOrNarrowCheckpointRules.length > 0) {
    throw new Error(
      `R2 object-deletion lifecycle can race or escape the checkpoint bound: ${
        broadOrNarrowCheckpointRules.map((rule) =>
          String(rule.id ?? "<unnamed>")
        ).join(", ")
      }.`,
    );
  }
  const invalidExactCheckpointRules = checkpointDeletionRules.filter((rule) =>
    !isSafeCheckpointRule(rule)
  );
  if (invalidExactCheckpointRules.length > 0) {
    throw new Error(
      `${FINALIZATION_CHECKPOINT_PREFIX} object expiry must be exactly one day: ${
        invalidExactCheckpointRules.map((rule) =>
          String(rule.id ?? "<unnamed>")
        ).join(", ")
      }.`,
    );
  }
  const hasBoundedCheckpointExpiry = checkpointDeletionRules.some(
    isSafeCheckpointRule,
  );
  if (!hasBoundedCheckpointExpiry) {
    throw new Error(
      `${FINALIZATION_CHECKPOINT_PREFIX} needs an enabled object-expiry rule ` +
        "of exactly one day so active replay is preserved and abandoned checkpoints are bounded.",
    );
  }
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: verify-r2-lifecycle.mjs <lifecycle.json>");
  const payload = JSON.parse(await readFile(path, "utf8"));
  verifyComputeR2Lifecycle(payload);
  process.stdout.write("R2 lifecycle is safe for Galactic Compute.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
