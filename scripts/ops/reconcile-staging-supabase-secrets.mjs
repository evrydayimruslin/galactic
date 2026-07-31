#!/usr/bin/env node
// Reconcile the staging API Worker's two Supabase API keys with the canonical
// keys returned by the pinned staging project in the Supabase Management API.
//
// Safety properties:
// - staging only: the project ref, Worker name, config, and Wrangler env are
//   pinned here and cannot be supplied on the command line;
// - project health: the pinned project must report an ACTIVE_HEALTHY lifecycle
//   state before any data-plane probe or Cloudflare mutation;
// - fail closed: the canonical anonymous key is exercised against Supabase
//   Auth and both affected PostgREST surfaces are exercised with the canonical
//   service-role key before Cloudflare is changed;
// - no secret values are printed, hashed, passed in argv, or inherited by the
//   Wrangler child process;
// - Wrangler receives a mode-0600 JSON file containing exactly the two keys;
// - the preferred recovery path prepares that fixed runner-temporary file for
//   the candidate `wrangler deploy --secrets-file`, making code and secret
//   activation atomic while preserving secrets absent from the file;
// - prepared files have an explicit cleanup mode; the legacy `--apply` path
//   retains its own temporary-directory cleanup for operator compatibility.
//
// Usage from the repository root (after `npm ci` in api/):
//   # Check/apply require SUPABASE_ACCESS_TOKEN,
//   # SUPABASE_STAGING_PROJECT_ID, and ULTRALIGHT_TOKEN. Apply additionally
//   # requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
//   node scripts/ops/reconcile-staging-supabase-secrets.mjs --check
//   node scripts/ops/reconcile-staging-supabase-secrets.mjs --apply
//   # CI candidate deployment uses a fixed path beneath RUNNER_TEMP:
//   node scripts/ops/reconcile-staging-supabase-secrets.mjs --prepare-deploy
//   node scripts/ops/reconcile-staging-supabase-secrets.mjs --cleanup-deploy

import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fetchStagingProjectAuthKeys,
  STAGING_API_BASE,
  STAGING_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_URL,
  SUPABASE_MANAGEMENT_API_BASE,
} from "../smoke/with-staging-owner-session.mjs";

export const STAGING_WORKER_NAME = "ultralight-api-staging";
// Wrangler's legacy environment naming appends `-staging` when --env staging
// is paired with this base name. Passing STAGING_WORKER_NAME here would target
// a nonexistent `ultralight-api-staging-staging` Worker.
export const WRANGLER_BASE_WORKER_NAME = "ultralight-api";
export const PINNED_CLOUDFLARE_ACCOUNT_ID =
  "8d2df08dac65694aa1c6bf56233a2090";
export const SECRET_NAMES = Object.freeze([
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]);
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
export const POST_APPLY_PROBE_ATTEMPTS = 3;
export const POST_APPLY_PROBE_DELAY_MS = 1_000;
export const PREPARED_SECRET_FILE_NAME =
  "galactic-staging-supabase-secrets.json";
const ACTIVE_PROJECT_STATUS = "ACTIVE_HEALTHY";
const MANAGEMENT_PROJECT_STATUSES = new Set([
  "INACTIVE",
  ACTIVE_PROJECT_STATUS,
  "ACTIVE_UNHEALTHY",
  "COMING_UP",
  "UNKNOWN",
  "GOING_DOWN",
  "INIT_FAILED",
  "REMOVED",
  "RESTORING",
  "UPGRADING",
  "PAUSING",
  "RESTORE_FAILED",
  "RESTARTING",
  "PAUSE_FAILED",
  "RESIZING",
]);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");
export const STAGING_WRANGLER_CONFIG = join(
  REPOSITORY_ROOT,
  "api/wrangler.toml",
);
export const WRANGLER_BIN = join(
  REPOSITORY_ROOT,
  "api/node_modules/.bin/wrangler",
);

const TOKEN_STORE_PROBE_PATH =
  "/rest/v1/user_api_tokens?select=id&limit=0";
const DISCOVERY_COUNT_PROBE_PATH =
  "/rest/v1/apps?visibility=eq.public&deleted_at=is.null&select=id";

export class StagingSecretReconcileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StagingSecretReconcileError";
    this.code = code;
  }
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new StagingSecretReconcileError(
      "missing_environment",
      `${label} is required.`,
    );
  }
  return normalized;
}

export function parseReconcileMode(argv) {
  const modes = new Map([
    ["--check", "check"],
    ["--apply", "apply"],
    ["--prepare-deploy", "prepare"],
    ["--cleanup-deploy", "cleanup"],
  ]);
  if (argv.length !== 1 || !modes.has(argv[0])) {
    throw new StagingSecretReconcileError(
      "invalid_arguments",
      "Choose exactly one staging-only reconciliation mode.",
    );
  }
  return modes.get(argv[0]);
}

function preparedSecretFilePath(env) {
  const runnerTemp = requiredString(env?.RUNNER_TEMP, "RUNNER_TEMP");
  const file = requiredString(
    env?.STAGING_SUPABASE_SECRETS_FILE,
    "STAGING_SUPABASE_SECRETS_FILE",
  );
  const expected = join(resolve(runnerTemp), PREPARED_SECRET_FILE_NAME);
  if (!isAbsolute(file) || resolve(file) !== expected) {
    throw new StagingSecretReconcileError(
      "invalid_prepared_secret_path",
      "Prepared staging secret file must use the fixed runner-temporary path.",
    );
  }
  return expected;
}

function validateApprovedSecrets(secrets) {
  const keys = Object.keys(secrets || {}).sort();
  if (
    keys.length !== SECRET_NAMES.length ||
    !SECRET_NAMES.every((name) => keys.includes(name)) ||
    SECRET_NAMES.some((name) =>
      typeof secrets[name] !== "string" || !secrets[name]
    )
  ) {
    throw new StagingSecretReconcileError(
      "invalid_secret_payload",
      "The staging secret update must contain exactly the two approved Supabase keys.",
    );
  }
}

function statusCode(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 0;
}

async function fetchWithHardTimeout(
  fetchImpl,
  url,
  init,
  { code, label, timeoutMs },
) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new StagingSecretReconcileError(
      `${code}_transport`,
      `${label} timed out or failed at the transport layer.`,
    );
  }
  if (!response?.ok) {
    throw new StagingSecretReconcileError(
      `${code}_http`,
      `${label} failed (HTTP ${statusCode(response)}).`,
    );
  }
  return response;
}

function canonicalServiceHeaders(serviceRoleKey, prefer) {
  return {
    Accept: "application/json",
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Prefer: prefer,
  };
}

export async function probeCanonicalStagingManagementProject({
  managementAccessToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  const accessToken = requiredString(
    managementAccessToken,
    "SUPABASE_ACCESS_TOKEN",
  );
  const response = await fetchWithHardTimeout(
    fetchImpl,
    `${SUPABASE_MANAGEMENT_API_BASE}/v1/projects/${STAGING_SUPABASE_PROJECT_REF}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    {
      code: "canonical_management_project_probe",
      label: "Canonical staging Supabase Management project probe",
      timeoutMs,
    },
  );

  let body;
  try {
    body = await response.json();
  } catch {
    throw new StagingSecretReconcileError(
      "canonical_management_project_probe_payload",
      "Canonical staging Supabase Management project probe returned an invalid payload.",
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.ref !== STAGING_SUPABASE_PROJECT_REF ||
    !MANAGEMENT_PROJECT_STATUSES.has(body.status)
  ) {
    throw new StagingSecretReconcileError(
      "canonical_management_project_probe_payload",
      "Canonical staging Supabase Management project probe returned an invalid payload.",
    );
  }

  // Deliberately project only the pinned identity and allowlisted lifecycle
  // state. Names, organization metadata, database details, and any future
  // Management API fields never reach CI output or caller-visible errors.
  const project = { ref: body.ref, status: body.status };
  const summary = `project=${project.status}`;
  if (project.status !== ACTIVE_PROJECT_STATUS) {
    throw new StagingSecretReconcileError(
      "canonical_management_project_unhealthy",
      `Canonical staging Supabase project is not ready (${summary}).`,
    );
  }
  return { project, summary };
}

export async function probeCanonicalStagingPostgrest({
  serviceRoleKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  const key = requiredString(
    serviceRoleKey,
    "Canonical staging Supabase service-role key",
  );

  // No rows or counts are returned. This verifies that the canonical legacy
  // service-role JWT is accepted by the exact PostgREST project that owns the
  // API-token table involved in the staging auth failure.
  await fetchWithHardTimeout(
    fetchImpl,
    `${STAGING_SUPABASE_URL}${TOKEN_STORE_PROBE_PATH}`,
    {
      method: "HEAD",
      headers: canonicalServiceHeaders(key, "count=none"),
    },
    {
      code: "canonical_token_store_probe",
      label: "Canonical staging API-token PostgREST probe",
      timeoutMs,
    },
  );

  // Mirror handleStatus() exactly. Keeping this separate is important: if the
  // count query itself stalls, changing a Cloudflare secret cannot fix it.
  await fetchWithHardTimeout(
    fetchImpl,
    `${STAGING_SUPABASE_URL}${DISCOVERY_COUNT_PROBE_PATH}`,
    {
      method: "HEAD",
      headers: canonicalServiceHeaders(key, "count=exact"),
    },
    {
      code: "canonical_discovery_count_probe",
      label: "Canonical staging discovery-count PostgREST probe",
      timeoutMs,
    },
  );
}

export async function probeCanonicalStagingAuth({
  anonKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  const key = requiredString(
    anonKey,
    "Canonical staging Supabase anon key",
  );
  const response = await fetchWithHardTimeout(
    fetchImpl,
    `${STAGING_SUPABASE_URL}/auth/v1/settings`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        apikey: key,
      },
    },
    {
      code: "canonical_auth_probe",
      label: "Canonical staging Supabase Auth probe",
      timeoutMs,
    },
  );
  try {
    const body = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !body.external ||
      typeof body.external !== "object" ||
      Array.isArray(body.external)
    ) {
      throw new Error("unexpected body");
    }
  } catch {
    throw new StagingSecretReconcileError(
      "canonical_auth_probe_payload",
      "Canonical staging Supabase Auth probe returned an invalid payload.",
    );
  }
}

export async function probeStagingWorkerSupabase({
  apiToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  const token = requiredString(
    apiToken,
    "ULTRALIGHT_TOKEN",
  );
  const response = await fetchWithHardTimeout(
    fetchImpl,
    `${STAGING_API_BASE}/auth/user`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
    {
      code: "staging_worker_supabase_probe",
      label: "Staging Worker authenticated Supabase readiness probe",
      timeoutMs,
    },
  );
  try {
    const body = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.id !== "string" ||
      !body.id ||
      typeof body.email !== "string" ||
      !body.email.includes("@") ||
      body.authSource !== "api_token"
    ) {
      throw new Error("unexpected body");
    }
  } catch {
    throw new StagingSecretReconcileError(
      "staging_worker_supabase_probe_payload",
      "Staging Worker authenticated Supabase readiness returned an invalid payload.",
    );
  }
}

function safeWranglerEnv(baseEnv) {
  const accountId = requiredString(
    baseEnv?.CLOUDFLARE_ACCOUNT_ID,
    "CLOUDFLARE_ACCOUNT_ID",
  );
  if (accountId !== PINNED_CLOUDFLARE_ACCOUNT_ID) {
    throw new StagingSecretReconcileError(
      "cloudflare_account_mismatch",
      "CLOUDFLARE_ACCOUNT_ID does not match the pinned Galactic account.",
    );
  }
  const apiToken = requiredString(
    baseEnv?.CLOUDFLARE_API_TOKEN,
    "CLOUDFLARE_API_TOKEN",
  );
  const result = Object.create(null);
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]) {
    if (typeof baseEnv?.[name] === "string" && baseEnv[name]) {
      result[name] = baseEnv[name];
    }
  }
  Object.assign(result, {
    CI: "true",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
    WRANGLER_SEND_METRICS: "false",
  });
  return result;
}

export async function spawnWranglerSecretBulk({
  secretFile,
  baseEnv = process.env,
  spawnImpl = spawn,
}) {
  const file = requiredString(secretFile, "Secure staging secret file");
  const env = safeWranglerEnv(baseEnv);
  const fixedTargetArgs = [
    "--config",
    STAGING_WRANGLER_CONFIG,
    "--env",
    "staging",
    "--name",
    WRANGLER_BASE_WORKER_NAME,
  ];

  async function run(args, code, label) {
    await new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawnImpl(WRANGLER_BIN, args, {
          cwd: REPOSITORY_ROOT,
          env,
          shell: false,
          stdio: ["ignore", "inherit", "inherit"],
        });
      } catch {
        rejectPromise(
          new StagingSecretReconcileError(
            "wrangler_start_failed",
            `Could not start the pinned Wrangler ${label}.`,
          ),
        );
        return;
      }
      child.once("error", () => {
        rejectPromise(
          new StagingSecretReconcileError(
            "wrangler_start_failed",
            `Could not start the pinned Wrangler ${label}.`,
          ),
        );
      });
      child.once("exit", (exitCode, signal) => {
        if (exitCode === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(
          new StagingSecretReconcileError(
            code,
            signal
              ? `Wrangler ${label} was interrupted.`
              : `Wrangler ${label} failed (exit ${exitCode ?? "unknown"}).`,
          ),
        );
      });
    });
  }

  // `secret bulk` offers to create a draft Worker when its target is absent.
  // Prove the fixed staging target exists with a read-only command first, so a
  // typo/config drift fails before the mutating command can reach that path.
  await run(
    ["secret", "list", "--format", "json", ...fixedTargetArgs],
    "wrangler_target_missing",
    "staging Worker lookup",
  );
  await run(
    ["secret", "bulk", file, ...fixedTargetArgs],
    "wrangler_update_failed",
    "staging secret update",
  );
}

export async function withSecureSecretFile(
  secrets,
  operation,
  {
    mkdtempImpl = mkdtemp,
    writeFileImpl = writeFile,
    chmodImpl = chmod,
    statImpl = stat,
    rmImpl = rm,
    temporaryRoot = tmpdir(),
  } = {},
) {
  validateApprovedSecrets(secrets);
  if (typeof operation !== "function") {
    throw new StagingSecretReconcileError(
      "invalid_secret_operation",
      "A secure staging secret operation is required.",
    );
  }

  const directory = await mkdtempImpl(
    join(temporaryRoot, "galactic-staging-supabase-secrets-"),
  );
  const file = join(directory, "secrets.json");
  let primaryError = null;
  try {
    await writeFileImpl(file, `${JSON.stringify(secrets)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmodImpl(file, 0o600);
    const metadata = await statImpl(file);
    if ((metadata.mode & 0o077) !== 0) {
      throw new StagingSecretReconcileError(
        "insecure_secret_file",
        "The staging secret file permissions are not owner-only.",
      );
    }
    return await operation(file);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await rmImpl(directory, { recursive: true, force: true });
    } catch {
      throw new StagingSecretReconcileError(
        "secret_cleanup_failed",
        primaryError
          ? "The staging secret operation failed and its temporary directory could not be removed."
          : "Could not remove the temporary staging secret directory.",
      );
    }
  }
}

export async function writePreparedStagingSecretFile({
  secrets,
  env = process.env,
  writeFileImpl = writeFile,
  chmodImpl = chmod,
  statImpl = stat,
  rmImpl = rm,
}) {
  validateApprovedSecrets(secrets);
  const file = preparedSecretFilePath(env);
  let wroteFile = false;
  let primaryError = null;
  try {
    await writeFileImpl(file, `${JSON.stringify(secrets)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    wroteFile = true;
    await chmodImpl(file, 0o600);
    const metadata = await statImpl(file);
    if (
      typeof metadata?.isFile !== "function" ||
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new StagingSecretReconcileError(
        "insecure_secret_file",
        "The prepared staging secret file is not an owner-only regular file.",
      );
    }
    return file;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (primaryError && wroteFile) {
      try {
        await rmImpl(file, { force: true });
      } catch {
        throw new StagingSecretReconcileError(
          "secret_cleanup_failed",
          "The prepared staging secret file could not be removed after preparation failed.",
        );
      }
    }
  }
}

export async function cleanupPreparedStagingSecretFile({
  env = process.env,
  rmImpl = rm,
} = {}) {
  const file = preparedSecretFilePath(env);
  try {
    await rmImpl(file, { force: true });
  } catch {
    throw new StagingSecretReconcileError(
      "secret_cleanup_failed",
      "Could not remove the prepared staging secret file.",
    );
  }
}

async function retryWorkerProbe({
  apiToken,
  fetchImpl,
  timeoutMs,
  waitImpl,
}) {
  let lastError;
  for (let attempt = 1; attempt <= POST_APPLY_PROBE_ATTEMPTS; attempt += 1) {
    try {
      await probeStagingWorkerSupabase({ apiToken, fetchImpl, timeoutMs });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < POST_APPLY_PROBE_ATTEMPTS) {
        await waitImpl(POST_APPLY_PROBE_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function defaultWait(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

export async function reconcileStagingSupabaseSecrets({
  mode,
  env = process.env,
  fetchImpl = fetch,
  fetchKeysImpl = fetchStagingProjectAuthKeys,
  wranglerBulkImpl = spawnWranglerSecretBulk,
  secureFileImpl = withSecureSecretFile,
  prepareFileImpl = writePreparedStagingSecretFile,
  waitImpl = defaultWait,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  log = console.log,
}) {
  if (!["check", "apply", "prepare"].includes(mode)) {
    throw new StagingSecretReconcileError(
      "invalid_mode",
      "Reconciliation mode must be check, apply, or prepare.",
    );
  }
  const managementAccessToken = requiredString(
    env?.SUPABASE_ACCESS_TOKEN,
    "SUPABASE_ACCESS_TOKEN",
  );
  const projectRef = requiredString(
    env?.SUPABASE_STAGING_PROJECT_ID,
    "SUPABASE_STAGING_PROJECT_ID",
  );
  const apiToken = mode === "prepare"
    ? null
    : requiredString(env?.ULTRALIGHT_TOKEN, "ULTRALIGHT_TOKEN");
  if (projectRef !== STAGING_SUPABASE_PROJECT_REF) {
    throw new StagingSecretReconcileError(
      "staging_project_mismatch",
      "SUPABASE_STAGING_PROJECT_ID does not match the pinned staging project.",
    );
  }

  const keys = await fetchKeysImpl({
    managementAccessToken,
    projectRef,
    fetchImpl,
    timeoutMs,
  });
  if (keys?.supabaseUrl !== STAGING_SUPABASE_URL) {
    throw new StagingSecretReconcileError(
      "staging_project_url_mismatch",
      "Supabase Management API keys resolved to an unexpected project.",
    );
  }
  log("Canonical staging Supabase keys validated for the pinned project.");

  const managementProject = await probeCanonicalStagingManagementProject({
    managementAccessToken,
    fetchImpl,
    timeoutMs,
  });
  log(
    `Canonical staging Supabase project status passed (${managementProject.summary}).`,
  );

  await probeCanonicalStagingPostgrest({
    serviceRoleKey: keys.serviceRoleKey,
    fetchImpl,
    timeoutMs,
  });
  await probeCanonicalStagingAuth({
    anonKey: keys.anonKey,
    fetchImpl,
    timeoutMs,
  });
  log("Canonical Auth, API-token, and discovery-count probes passed.");

  const approvedSecrets = {
    SUPABASE_ANON_KEY: requiredString(
      keys.anonKey,
      "Canonical staging Supabase anon key",
    ),
    SUPABASE_SERVICE_ROLE_KEY: requiredString(
      keys.serviceRoleKey,
      "Canonical staging Supabase service-role key",
    ),
  };

  if (mode === "prepare") {
    await prepareFileImpl({ secrets: approvedSecrets, env });
    log(
      `Prepared exactly ${SECRET_NAMES.length} canonical staging Supabase secrets for atomic candidate deployment.`,
    );
    return { prepared: true };
  }

  if (mode === "check") {
    await probeStagingWorkerSupabase({ apiToken, fetchImpl, timeoutMs });
    log("Staging Worker already reaches Supabase with its configured secrets.");
    return { applied: false };
  }

  // `--apply` is an explicit, manual staging repair. Always write both
  // Management-API-derived keys after validating them directly. A service-role
  // read cannot prove the anonymous key used by magic-link/session auth, and a
  // successful owner lookup may come from the Worker's short verdict cache.
  // Skipping here could therefore leave passwordless sign-in broken.
  safeWranglerEnv(env);
  await secureFileImpl(
    approvedSecrets,
    async (secretFile) => {
      await wranglerBulkImpl({ secretFile, baseEnv: env });
    },
  );
  log(
    `Updated exactly ${SECRET_NAMES.length} encrypted secrets on ${STAGING_WORKER_NAME}; unrelated secrets were preserved.`,
  );

  await retryWorkerProbe({ apiToken, fetchImpl, timeoutMs, waitImpl });
  log("Staging Worker Supabase readiness passed after reconciliation.");
  return { applied: true };
}

async function main() {
  const mode = parseReconcileMode(process.argv.slice(2));
  if (mode === "cleanup") {
    await cleanupPreparedStagingSecretFile();
    console.log("Removed the prepared staging Supabase secret file.");
    return;
  }
  await reconcileStagingSupabaseSecrets({ mode });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "unexpected";
    const message = error instanceof Error
      ? error.message
      : "Staging secret reconciliation failed.";
    console.error(
      `Staging Supabase secret reconciliation failed [${code}]: ${message}`,
    );
    process.exitCode = 1;
  });
}
