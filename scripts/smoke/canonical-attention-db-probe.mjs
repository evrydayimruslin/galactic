#!/usr/bin/env node
// Secret-safe staging diagnostic for the canonical Agent Attention reader.
//
// The release gate normally proves canonical reads through the deployed API.
// When shadow mode falls back to legacy, this probe exercises the same reader
// directly with the pinned staging project and reports only its allowlisted
// failure stage. It never prints or persists an owner identifier, projection,
// service-role key, response body, or exception text.
//
// Node must run this file with `--experimental-transform-types` so the exact
// TypeScript production reader can be imported instead of duplicating it.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fetchStagingProjectAuthKeys,
  resolveStagingSmokeOwner,
} from "./with-staging-owner-session.mjs";

const CONTRACT_VERSION = "2026-07-24.operator-issues.1";
const SAFE_FAILURE_STAGE =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+){0,5}$/u;

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

async function defaultReaderModule() {
  return await import(
    new URL("../../api/services/operator-item-reader.ts", import.meta.url).href
  );
}

export async function runCanonicalAttentionDbProbe({
  env = process.env,
  resolveOwner = resolveStagingSmokeOwner,
  fetchProjectKeys = fetchStagingProjectAuthKeys,
  loadReader = defaultReaderModule,
} = {}) {
  const owner = await resolveOwner({
    apiToken: requiredString(env.ULTRALIGHT_TOKEN, "ULTRALIGHT_TOKEN"),
    smokeAgentId: requiredString(
      env.GALACTIC_SMOKE_APP_ID,
      "GALACTIC_SMOKE_APP_ID",
    ),
  });
  const keys = await fetchProjectKeys({
    managementAccessToken: requiredString(
      env.SUPABASE_ACCESS_TOKEN,
      "SUPABASE_ACCESS_TOKEN",
    ),
    projectRef: requiredString(
      env.SUPABASE_STAGING_PROJECT_ID,
      "SUPABASE_STAGING_PROJECT_ID",
    ),
  });

  let reader;
  try {
    reader = await loadReader();
    if (
      typeof reader?.readOperatorAttentionPage !== "function" ||
      typeof reader?.operatorItemReadFailureStage !== "function"
    ) {
      throw new Error("Canonical Attention reader module is invalid.");
    }
    const projection = await reader.readOperatorAttentionPage(
      owner.id,
      [{
        id: owner.smokeAgentId,
        slug: "staging-smoke-agent",
        name: "Staging smoke Agent",
      }],
      owner.smokeAgentId,
      { limit: 200 },
      {
        supabaseUrl: keys.supabaseUrl,
        serviceRoleKey: keys.serviceRoleKey,
      },
    );
    if (
      projection?.contractVersion !== CONTRACT_VERSION ||
      projection?.available !== true ||
      projection?.unavailableReason !== null ||
      !Array.isArray(projection?.items) ||
      !Array.isArray(projection?.agentCounts)
    ) {
      throw new Error("Canonical Attention reader projection is invalid.");
    }
    return { valid: true };
  } catch (error) {
    const candidate = typeof reader?.operatorItemReadFailureStage === "function"
      ? reader.operatorItemReadFailureStage(error)
      : "unknown";
    const stage = typeof candidate === "string" &&
        SAFE_FAILURE_STAGE.test(candidate)
      ? candidate
      : "unknown";
    throw new Error(
      `Canonical Agent Attention reader failed at the allowlisted ${stage} stage.`,
    );
  } finally {
    // Shorten the lifetime of bootstrap credentials in process memory.
    if (keys && typeof keys === "object") {
      keys.anonKey = "";
      keys.serviceRoleKey = "";
    }
  }
}

async function main() {
  await runCanonicalAttentionDbProbe();
  console.log("Canonical Agent Attention reader returned a valid projection.");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
