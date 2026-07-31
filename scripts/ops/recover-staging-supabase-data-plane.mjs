#!/usr/bin/env node
// Recover the pinned staging Supabase data plane when an explicitly dispatched
// staging API deployment proves that authenticated PostgREST is stalled.
//
// Safety properties:
// - staging only: the project ref and Management API origin are constants;
// - no speculative restart: the exact canonical PostgREST probe must time out
//   twice, and Management API project status must remain readable;
// - one restart at most: this process never retries the mutating request;
// - fail closed: reconciliation and deployment remain blocked until both
//   Management project status and real authenticated PostgREST recover;
// - secret safe: no upstream body, key, token, platform diagnostic, or raw
//   exception is logged.
//
// This command is intentionally wired only to API Deploy's manual staging path:
//   node scripts/ops/recover-staging-supabase-data-plane.mjs \
//     --restart-if-degraded

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  probeCanonicalStagingManagementProject,
  probeCanonicalStagingPostgrest,
  StagingSecretReconcileError,
} from "./reconcile-staging-supabase-secrets.mjs";
import {
  fetchStagingProjectAuthKeys,
  STAGING_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_URL,
  SUPABASE_MANAGEMENT_API_BASE,
} from "../smoke/with-staging-owner-session.mjs";

export const INITIAL_DATA_PLANE_PROBE_ATTEMPTS = 2;
export const INITIAL_DATA_PLANE_PROBE_DELAY_MS = 2_000;
export const RECOVERY_POLL_ATTEMPTS = 60;
export const RECOVERY_POLL_DELAY_MS = 10_000;
export const DEFAULT_RECOVERY_TIMEOUT_MS = 10_000;

const RESTARTABLE_INITIAL_ERROR =
  "canonical_token_store_probe_transport";
const TRANSIENT_RECOVERY_CODES = new Set([
  "canonical_management_project_unhealthy",
  "canonical_management_project_probe_transport",
  "canonical_management_project_probe_http",
  "canonical_token_store_probe_transport",
  "canonical_token_store_probe_http",
  "canonical_discovery_count_probe_transport",
  "canonical_discovery_count_probe_http",
]);

export class StagingDataPlaneRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StagingDataPlaneRecoveryError";
    this.code = code;
  }
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new StagingDataPlaneRecoveryError(
      "missing_environment",
      `${label} is required.`,
    );
  }
  return normalized;
}

export function parseRecoveryMode(argv) {
  if (
    argv.length !== 1 ||
    argv[0] !== "--restart-if-degraded"
  ) {
    throw new StagingDataPlaneRecoveryError(
      "invalid_arguments",
      "Choose exactly --restart-if-degraded. This recovery is staging-only.",
    );
  }
  return "restart-if-degraded";
}

function statusCode(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 0;
}

export async function restartPinnedStagingProject({
  managementAccessToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_RECOVERY_TIMEOUT_MS,
}) {
  const accessToken = requiredString(
    managementAccessToken,
    "SUPABASE_ACCESS_TOKEN",
  );
  let response;
  try {
    response = await fetchImpl(
      `${SUPABASE_MANAGEMENT_API_BASE}/v1/projects/${STAGING_SUPABASE_PROJECT_REF}/restart`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    throw new StagingDataPlaneRecoveryError(
      "staging_restart_transport",
      "Pinned staging Supabase restart timed out or failed at the transport layer.",
    );
  }
  if (!response?.ok) {
    throw new StagingDataPlaneRecoveryError(
      "staging_restart_http",
      `Pinned staging Supabase restart failed (HTTP ${statusCode(response)}).`,
    );
  }
}

function defaultWait(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

function isErrorCode(error, code) {
  return typeof error?.code === "string" && error.code === code;
}

function isTransientRecoveryError(error) {
  return typeof error?.code === "string" &&
    TRANSIENT_RECOVERY_CODES.has(error.code);
}

export async function recoverStagingSupabaseDataPlane({
  env = process.env,
  fetchImpl = fetch,
  fetchKeysImpl = fetchStagingProjectAuthKeys,
  probeDataPlaneImpl = probeCanonicalStagingPostgrest,
  probeHealthImpl = probeCanonicalStagingManagementProject,
  restartProjectImpl = restartPinnedStagingProject,
  waitImpl = defaultWait,
  timeoutMs = DEFAULT_RECOVERY_TIMEOUT_MS,
  initialProbeAttempts = INITIAL_DATA_PLANE_PROBE_ATTEMPTS,
  recoveryPollAttempts = RECOVERY_POLL_ATTEMPTS,
  initialProbeDelayMs = INITIAL_DATA_PLANE_PROBE_DELAY_MS,
  recoveryPollDelayMs = RECOVERY_POLL_DELAY_MS,
  log = console.log,
} = {}) {
  const managementAccessToken = requiredString(
    env?.SUPABASE_ACCESS_TOKEN,
    "SUPABASE_ACCESS_TOKEN",
  );
  const projectRef = requiredString(
    env?.SUPABASE_STAGING_PROJECT_ID,
    "SUPABASE_STAGING_PROJECT_ID",
  );
  if (projectRef !== STAGING_SUPABASE_PROJECT_REF) {
    throw new StagingDataPlaneRecoveryError(
      "staging_project_mismatch",
      "SUPABASE_STAGING_PROJECT_ID does not match the pinned staging project.",
    );
  }
  if (
    !Number.isInteger(initialProbeAttempts) ||
    initialProbeAttempts < 2 ||
    !Number.isInteger(recoveryPollAttempts) ||
    recoveryPollAttempts < 1
  ) {
    throw new StagingDataPlaneRecoveryError(
      "invalid_recovery_policy",
      "Staging recovery probe policy is invalid.",
    );
  }

  const keys = await fetchKeysImpl({
    managementAccessToken,
    projectRef,
    fetchImpl,
    timeoutMs,
  });
  if (
    keys?.supabaseUrl !== STAGING_SUPABASE_URL ||
    typeof keys?.serviceRoleKey !== "string" ||
    !keys.serviceRoleKey
  ) {
    throw new StagingDataPlaneRecoveryError(
      "staging_project_key_mismatch",
      "Supabase Management API keys resolved to an unexpected staging project.",
    );
  }

  for (let attempt = 1; attempt <= initialProbeAttempts; attempt += 1) {
    try {
      await probeDataPlaneImpl({
        serviceRoleKey: keys.serviceRoleKey,
        fetchImpl,
        timeoutMs,
      });
      log("Canonical staging PostgREST is responsive; no restart was needed.");
      return { restarted: false };
    } catch (error) {
      if (!isErrorCode(error, RESTARTABLE_INITIAL_ERROR)) throw error;
      if (attempt < initialProbeAttempts) {
        await waitImpl(initialProbeDelayMs);
      }
    }
  }

  try {
    const health = await probeHealthImpl({
      managementAccessToken,
      fetchImpl,
      timeoutMs,
    });
    log(
      `Canonical staging Supabase project status before recovery: ${health.summary}.`,
    );
  } catch (error) {
    if (
      !isErrorCode(error, "canonical_management_project_unhealthy") ||
      !(error instanceof StagingSecretReconcileError)
    ) {
      throw error;
    }
    // This error is constructed from the pinned ref and an allowlisted project
    // lifecycle status. No upstream project metadata is included.
    log(error.message);
  }

  await restartProjectImpl({
    managementAccessToken,
    fetchImpl,
    timeoutMs,
  });
  log("Requested one restart of the pinned staging Supabase project.");

  for (let attempt = 1; attempt <= recoveryPollAttempts; attempt += 1) {
    try {
      await probeHealthImpl({
        managementAccessToken,
        fetchImpl,
        timeoutMs,
      });
      await probeDataPlaneImpl({
        serviceRoleKey: keys.serviceRoleKey,
        fetchImpl,
        timeoutMs,
      });
      log(
        `Pinned staging Supabase project and authenticated PostgREST recovered after restart (attempt ${attempt}/${recoveryPollAttempts}).`,
      );
      return { restarted: true };
    } catch (error) {
      if (!isTransientRecoveryError(error)) throw error;
      if (attempt < recoveryPollAttempts) {
        await waitImpl(recoveryPollDelayMs);
      }
    }
  }

  throw new StagingDataPlaneRecoveryError(
    "staging_recovery_timeout",
    "Pinned staging Supabase did not recover within the bounded readiness window.",
  );
}

async function main() {
  parseRecoveryMode(process.argv.slice(2));
  await recoverStagingSupabaseDataPlane();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "unexpected";
    const message = error instanceof Error
      ? error.message
      : "Staging Supabase data-plane recovery failed.";
    console.error(
      `Staging Supabase data-plane recovery failed [${code}]: ${message}`,
    );
    process.exitCode = 1;
  });
}
