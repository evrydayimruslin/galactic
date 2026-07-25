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
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PRIVATE_AGENTS = 500;

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

async function readPrivateAgents({
  owner,
  keys,
  fetchImpl,
}) {
  const url = new URL(`${keys.supabaseUrl}/rest/v1/apps`);
  url.searchParams.set("owner_id", `eq.${owner.id}`);
  url.searchParams.set("visibility", "eq.private");
  url.searchParams.set("deleted_at", "is.null");
  url.searchParams.set("select", "id,slug,name");
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        apikey: keys.serviceRoleKey,
        Authorization: `Bearer ${keys.serviceRoleKey}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Canonical Attention Agent inventory request failed.");
  }
  if (!response?.ok) {
    await response?.text?.().catch(() => "");
    throw new Error("Canonical Attention Agent inventory is unavailable.");
  }
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new Error("Canonical Attention Agent inventory is invalid.");
  }
  if (
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > MAX_PRIVATE_AGENTS
  ) {
    throw new Error("Canonical Attention Agent inventory is invalid.");
  }
  const seen = new Set();
  const agents = rows.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(",") !== "id,name,slug" ||
      typeof row.id !== "string" ||
      !UUID.test(row.id) ||
      (row.slug !== null &&
        (typeof row.slug !== "string" || row.slug.length > 200)) ||
      (row.name !== null &&
        (typeof row.name !== "string" || row.name.length > 500)) ||
      seen.has(row.id)
    ) {
      throw new Error("Canonical Attention Agent inventory is invalid.");
    }
    seen.add(row.id);
    return {
      id: row.id,
      slug: row.slug || row.id,
      name: row.name || row.slug || row.id,
    };
  });
  if (!seen.has(owner.smokeAgentId)) {
    throw new Error("Canonical Attention Agent inventory is incomplete.");
  }
  return agents;
}

function assertProjection(projection) {
  if (
    projection?.contractVersion !== CONTRACT_VERSION ||
    projection?.available !== true ||
    projection?.unavailableReason !== null ||
    !Array.isArray(projection?.items) ||
    !Array.isArray(projection?.agentCounts)
  ) {
    throw new Error("Canonical Attention reader projection is invalid.");
  }
}

export async function runCanonicalAttentionDbProbe({
  env = process.env,
  resolveOwner = resolveStagingSmokeOwner,
  fetchProjectKeys = fetchStagingProjectAuthKeys,
  loadReader = defaultReaderModule,
  fetchImpl = fetch,
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
    const agents = await readPrivateAgents({ owner, keys, fetchImpl });
    const agentProjection = await reader.readOperatorAttentionPage(
      owner.id,
      agents,
      owner.smokeAgentId,
      { limit: 200 },
      {
        supabaseUrl: keys.supabaseUrl,
        serviceRoleKey: keys.serviceRoleKey,
      },
    );
    assertProjection(agentProjection);
    const accountProjection = await reader.readOperatorAttentionPage(
      owner.id,
      agents,
      null,
      { limit: 200 },
      {
        supabaseUrl: keys.supabaseUrl,
        serviceRoleKey: keys.serviceRoleKey,
      },
    );
    assertProjection(accountProjection);
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
  console.log(
    "Canonical account and Agent Attention readers returned valid projections.",
  );
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
