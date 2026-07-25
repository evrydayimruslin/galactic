#!/usr/bin/env node
// Mint a genuine, short-lived Supabase account session for the owner of the
// fixed staging G1 smoke Agent, then run one child command with that bearer in
// memory. This closes the gap between connected API-token smokes and
// account-session-only launch surfaces without storing a human password,
// refresh token, recovery link, token hash, service-role key, or access token.
//
// Safe workflow contract:
//   SUPABASE_ACCESS_TOKEN=... \
//   SUPABASE_STAGING_PROJECT_ID=... \
//   ULTRALIGHT_TOKEN=... \
//   GALACTIC_SMOKE_APP_ID=... \
//   node scripts/smoke/with-staging-owner-session.mjs -- \
//     node scripts/smoke/<owner-session-smoke>.mjs
//
// The child receives:
//   GALACTIC_OWNER_ACCESS_TOKEN  — short-lived Supabase access JWT (secret)
//   ULTRALIGHT_TOKEN + GALACTIC_SMOKE_APP_ID — existing bounded smoke fixture
// Every other sensitive-name or Supabase-project bootstrap variable is removed.
//
// `--check` performs the same exchange and validation, then discards the token.
// Do not redirect or serialize the child environment. The access token is never
// printed by this helper and must never be passed as a command-line argument.
// Local logout revokes refresh capability, but the stateless access JWT can
// remain valid until its bounded expiry; the helper clears its child-env copy
// immediately after spawn and exits with the runner step.

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STAGING_API_BASE =
  "https://ultralight-api-staging.rgn4jz429m.workers.dev";
export const STAGING_SUPABASE_PROJECT_REF = "mtekfhozmsboxizxxxyn";
export const STAGING_SUPABASE_URL =
  `https://${STAGING_SUPABASE_PROJECT_REF}.supabase.co`;
export const SUPABASE_MANAGEMENT_API_BASE = "https://api.supabase.com";
export const OWNER_ACCESS_TOKEN_ENV = "GALACTIC_OWNER_ACCESS_TOKEN";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_OWNER_SESSION_TTL_SECONDS = 2 * 60 * 60;
const MIN_OWNER_SESSION_REMAINING_SECONDS = 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
// Mirrors the platform's existing session-revocation policy: these statuses
// mean the local session is already invalid, absent, or no longer addressable.
const SIGN_OUT_IGNORE_STATUSES = new Set([401, 403, 404]);
const SENSITIVE_ENV_NAME_RE =
  /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|COOKIE|AUTH)/iu;
const CHILD_SMOKE_ENV_NAMES = [
  "ULTRALIGHT_TOKEN",
  "GALACTIC_SMOKE_APP_ID",
];
const BOOTSTRAP_ONLY_ENV_NAME_RE = /^SUPABASE_.*PROJECT_ID$/iu;

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function assertUuid(value, label) {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
}

function normalizedEmail(value, label) {
  const email = requiredString(value, label).toLowerCase();
  if (!email.includes("@") || email.length > 320) {
    throw new Error(`${label} is invalid.`);
  }
  return email;
}

function decodeJwtPayload(token, label) {
  const segments = String(token || "").split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new Error(`${label} is not a JWT.`);
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new Error(`${label} has an invalid JWT payload.`);
  }
}

async function requestJson(
  fetchImpl,
  url,
  init,
  label,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init?.signal || AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${label} request failed.`);
  }
  if (!response?.ok) {
    throw new Error(
      `${label} failed (HTTP ${Number(response?.status) || 0}).`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export async function resolveStagingSmokeOwner({
  apiToken,
  smokeAgentId,
  apiBase = STAGING_API_BASE,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const token = requiredString(apiToken, "ULTRALIGHT_TOKEN");
  const agentId = requiredString(smokeAgentId, "GALACTIC_SMOKE_APP_ID");
  assertUuid(agentId, "GALACTIC_SMOKE_APP_ID");
  if (apiBase !== STAGING_API_BASE) {
    throw new Error("Owner-session bootstrap is restricted to staging.");
  }

  const authorization = { Authorization: `Bearer ${token}` };
  const owner = await requestJson(
    fetchImpl,
    `${apiBase}/auth/user`,
    { headers: authorization },
    "Staging smoke owner lookup",
    timeoutMs,
  );
  const ownerId = requiredString(owner?.id, "Staging smoke owner id");
  const email = normalizedEmail(owner?.email, "Staging smoke owner email");
  assertUuid(ownerId, "Staging smoke owner id");
  if (owner?.authSource !== "api_token") {
    throw new Error(
      "ULTRALIGHT_TOKEN did not resolve through API-token authentication.",
    );
  }
  if (owner?.provisional !== false) {
    throw new Error(
      "The staging smoke token must belong to a registered account.",
    );
  }

  const projection = await requestJson(
    fetchImpl,
    `${apiBase}/api/launch/agents/${encodeURIComponent(agentId)}`,
    { headers: authorization },
    "Staging smoke Agent ownership lookup",
    timeoutMs,
  );
  const agent = projection?.agent;
  if (
    agent?.id !== agentId ||
    agent?.relationship !== "owner" ||
    agent?.visibility !== "private" ||
    agent?.owner?.userId !== ownerId
  ) {
    throw new Error(
      "The fixed staging smoke Agent is not owned by the smoke-token identity.",
    );
  }

  return { id: ownerId, email, smokeAgentId: agentId };
}

function selectLegacyProjectKey(keys, name, projectRef) {
  const matches = Array.isArray(keys)
    ? keys.filter((key) =>
      key?.name === name &&
      key?.type === "legacy" &&
      typeof key?.api_key === "string" &&
      key.api_key.length > 0
    )
    : [];
  if (matches.length !== 1) {
    throw new Error(
      `Supabase project must expose exactly one legacy ${name} API key.`,
    );
  }
  const key = matches[0].api_key;
  const claims = decodeJwtPayload(key, `Supabase ${name} API key`);
  if (claims.ref !== projectRef || claims.role !== name) {
    throw new Error(
      `Supabase ${name} API key does not belong to the staging project.`,
    );
  }
  return key;
}

export async function fetchStagingProjectAuthKeys({
  managementAccessToken,
  projectRef,
  fetchImpl = fetch,
  managementApiBase = SUPABASE_MANAGEMENT_API_BASE,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const accessToken = requiredString(
    managementAccessToken,
    "SUPABASE_ACCESS_TOKEN",
  );
  const ref = requiredString(projectRef, "SUPABASE_STAGING_PROJECT_ID");
  if (ref !== STAGING_SUPABASE_PROJECT_REF) {
    throw new Error(
      "SUPABASE_STAGING_PROJECT_ID does not match the pinned staging project.",
    );
  }
  if (managementApiBase !== SUPABASE_MANAGEMENT_API_BASE) {
    throw new Error("Unexpected Supabase Management API origin.");
  }

  const keys = await requestJson(
    fetchImpl,
    `${managementApiBase}/v1/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
    "Supabase project API-key lookup",
    timeoutMs,
  );

  return {
    supabaseUrl: STAGING_SUPABASE_URL,
    anonKey: selectLegacyProjectKey(keys, "anon", ref),
    serviceRoleKey: selectLegacyProjectKey(keys, "service_role", ref),
  };
}

function assertOwnerAccessClaims({
  accessToken,
  owner,
  supabaseUrl,
  nowMs,
}) {
  const claims = decodeJwtPayload(accessToken, "Owner access token");
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    claims.sub !== owner.id ||
    claims.role !== "authenticated" ||
    claims.aud !== "authenticated" ||
    !UUID_RE.test(String(claims.session_id || "")) ||
    claims.iss !== `${supabaseUrl}/auth/v1`
  ) {
    throw new Error(
      "Redeemed owner access token has unexpected identity claims.",
    );
  }
  if (
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp - nowSeconds < MIN_OWNER_SESSION_REMAINING_SECONDS ||
    claims.exp - nowSeconds > MAX_OWNER_SESSION_TTL_SECONDS
  ) {
    throw new Error(
      "Redeemed owner access token is not within the approved short-lived TTL.",
    );
  }
  return claims;
}

function localSessionCleanup({
  accessToken,
  supabaseUrl,
  anonKey,
  fetchImpl,
  timeoutMs,
}) {
  let cleanupPromise = null;
  return async () => {
    // Idempotent in-process: validation failures and wrapper finalizers may
    // converge on the same cleanup without issuing two logout requests.
    if (cleanupPromise) return await cleanupPromise;
    cleanupPromise = (async () => {
      let response;
      try {
        response = await fetchImpl(
          `${supabaseUrl}/auth/v1/logout?scope=local`,
          {
            method: "POST",
            headers: {
              apikey: anonKey,
              Authorization: `Bearer ${accessToken}`,
            },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      } catch {
        throw new Error("Supabase local owner-session cleanup failed.");
      }
      if (response.ok || SIGN_OUT_IGNORE_STATUSES.has(response.status)) {
        return;
      }
      throw new Error(
        `Supabase local owner-session cleanup failed (HTTP ${response.status}).`,
      );
    })();
    return await cleanupPromise;
  };
}

export async function mintStagingOwnerSession({
  owner,
  apiBase = STAGING_API_BASE,
  supabaseUrl,
  anonKey,
  serviceRoleKey,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  if (apiBase !== STAGING_API_BASE) {
    throw new Error("Owner-session bootstrap is restricted to staging.");
  }
  const ownerId = requiredString(owner?.id, "Staging smoke owner id");
  const ownerEmail = normalizedEmail(
    owner?.email,
    "Staging smoke owner email",
  );
  assertUuid(ownerId, "Staging smoke owner id");
  const authBase = requiredString(supabaseUrl, "Staging Supabase URL");
  if (authBase !== STAGING_SUPABASE_URL) {
    throw new Error("Owner-session bootstrap is restricted to staging.");
  }
  const anon = requiredString(anonKey, "Staging Supabase anon key");
  const serviceRole = requiredString(
    serviceRoleKey,
    "Staging Supabase service-role key",
  );

  // Prove the auth user already exists by immutable id and exact email before
  // invoking any link generator. This keeps the bootstrap strictly
  // zero-create even if a future link type regains implicit-signup behavior.
  const adminUserResponse = await requestJson(
    fetchImpl,
    `${authBase}/auth/v1/admin/users/${encodeURIComponent(ownerId)}`,
    {
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
      },
    },
    "Supabase owner existence verification",
    timeoutMs,
  );
  const adminUser = adminUserResponse?.user ?? adminUserResponse;
  if (
    adminUser?.id !== ownerId ||
    normalizedEmail(adminUser?.email, "Supabase admin owner email") !==
      ownerEmail
  ) {
    throw new Error(
      "Supabase auth user did not match the existing smoke Agent owner.",
    );
  }

  // Admin recovery-link generation cannot create an absent user and does not
  // send email. The returned hash is consumed exactly once by normal /verify.
  const generated = await requestJson(
    fetchImpl,
    `${authBase}/auth/v1/admin/generate_link`,
    {
      method: "POST",
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "recovery", email: ownerEmail }),
    },
    "Supabase owner recovery-link generation",
    timeoutMs,
  );
  const tokenHash = requiredString(
    generated?.hashed_token,
    "Supabase owner recovery-link token hash",
  );
  if (
    generated?.verification_type !== "recovery" ||
    generated?.id !== ownerId ||
    normalizedEmail(
      generated?.email,
      "Supabase recovery-link owner email",
    ) !== ownerEmail
  ) {
    throw new Error(
      "Supabase generated recovery data for an unexpected identity.",
    );
  }

  const verified = await requestJson(
    fetchImpl,
    `${authBase}/auth/v1/verify`,
    {
      method: "POST",
      headers: {
        apikey: anon,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "recovery", token_hash: tokenHash }),
    },
    "Supabase owner recovery-link exchange",
    timeoutMs,
  );
  const accessToken = requiredString(
    verified?.access_token,
    "Supabase owner access token",
  );
  const revoke = localSessionCleanup({
    accessToken,
    supabaseUrl: authBase,
    anonKey: anon,
    fetchImpl,
    timeoutMs,
  });

  try {
    const claims = assertOwnerAccessClaims({
      accessToken,
      owner: { id: ownerId },
      supabaseUrl: authBase,
      nowMs: now(),
    });
    if (
      verified?.user?.id !== ownerId ||
      normalizedEmail(
        verified?.user?.email,
        "Supabase verification owner email",
      ) !== ownerEmail
    ) {
      throw new Error("Supabase verification did not return the exact owner.");
    }

    const supabaseUser = await requestJson(
      fetchImpl,
      `${authBase}/auth/v1/user`,
      {
        headers: {
          apikey: anon,
          Authorization: `Bearer ${accessToken}`,
        },
      },
      "Supabase owner-session verification",
      timeoutMs,
    );
    if (
      supabaseUser?.id !== ownerId ||
      normalizedEmail(supabaseUser?.email, "Verified Supabase owner email") !==
        ownerEmail
    ) {
      throw new Error("Supabase owner-session identity did not match.");
    }

    // Prove the deployed Galactic worker recognizes the JWT as a Supabase
    // account session, rather than trusting local JWT decoding alone.
    const galacticUser = await requestJson(
      fetchImpl,
      `${apiBase}/auth/user`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "Galactic owner-session verification",
      timeoutMs,
    );
    if (
      galacticUser?.id !== ownerId ||
      galacticUser?.authSource !== "supabase" ||
      normalizedEmail(galacticUser?.email, "Verified Galactic owner email") !==
        ownerEmail
    ) {
      throw new Error(
        "Galactic did not recognize the minted session as the smoke Agent owner.",
      );
    }

    // Intentionally discard verified.refresh_token. Local logout revokes the
    // corresponding server-side session; the already-issued access JWT remains
    // valid only until the bounded expiry above.
    return {
      accessToken,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      revoke,
    };
  } catch (error) {
    // A token may have been issued before a later identity check failed.
    // Best-effort local cleanup must not hide the more useful gate failure.
    await revoke().catch(() => {});
    throw error;
  }
}

export async function obtainStagingOwnerSession({
  managementAccessToken,
  projectRef,
  apiToken,
  smokeAgentId,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const owner = await resolveStagingSmokeOwner({
    apiToken,
    smokeAgentId,
    fetchImpl,
    timeoutMs,
  });
  const keys = await fetchStagingProjectAuthKeys({
    managementAccessToken,
    projectRef,
    fetchImpl,
    timeoutMs,
  });
  return await mintStagingOwnerSession({
    owner,
    ...keys,
    fetchImpl,
    now,
    timeoutMs,
  });
}

export async function runWithStagingOwnerSession(
  session,
  command,
  commandArgs = [],
  {
    spawnImpl = spawn,
    baseEnv = process.env,
  } = {},
) {
  if (typeof session?.revoke !== "function") {
    throw new Error("Owner session is missing local cleanup.");
  }

  let primaryError = null;
  try {
    const executable = requiredString(command, "Owner-session child command");
    const accessToken = requiredString(
      session?.accessToken,
      "Owner access token",
    );
    const explicitSmokeEnv = Object.fromEntries(
      CHILD_SMOKE_ENV_NAMES.map((name) => [
        name,
        requiredString(baseEnv?.[name], name),
      ]),
    );
    const childEnv = Object.create(null);
    for (const [name, value] of Object.entries(baseEnv || {})) {
      if (
        CHILD_SMOKE_ENV_NAMES.includes(name) ||
        SENSITIVE_ENV_NAME_RE.test(name) ||
        BOOTSTRAP_ONLY_ENV_NAME_RE.test(name) ||
        typeof value !== "string"
      ) {
        continue;
      }
      childEnv[name] = value;
    }
    Object.assign(childEnv, explicitSmokeEnv, {
      [OWNER_ACCESS_TOKEN_ENV]: accessToken,
    });

    return await new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawnImpl(executable, commandArgs, {
          env: childEnv,
          stdio: "inherit",
          shell: false,
        });
      } catch {
        rejectPromise(new Error("Could not start owner-session child command."));
        return;
      } finally {
        // spawn() copies the environment synchronously. Remove our extra
        // references immediately; never mutate process.env.
        for (
          const name of [OWNER_ACCESS_TOKEN_ENV, ...CHILD_SMOKE_ENV_NAMES]
        ) {
          childEnv[name] = "";
          if (Object.hasOwn(explicitSmokeEnv, name)) {
            explicitSmokeEnv[name] = "";
          }
        }
      }
      child.once("error", () => {
        rejectPromise(new Error("Owner-session child command failed to start."));
      });
      child.once("exit", (code, signal) => {
        if (signal) {
          rejectPromise(
            new Error(`Owner-session child command ended by signal ${signal}.`),
          );
          return;
        }
        resolvePromise(Number.isInteger(code) ? code : 1);
      });
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await session.revoke();
    } catch {
      if (!primaryError) {
        throw new Error("Supabase local owner-session cleanup failed.");
      }
    }
  }
}

function cliUsage() {
  return (
    "Usage: with-staging-owner-session.mjs --check | -- <command> [args...]\n" +
    "Required env: SUPABASE_ACCESS_TOKEN, SUPABASE_STAGING_PROJECT_ID, " +
    "ULTRALIGHT_TOKEN, GALACTIC_SMOKE_APP_ID"
  );
}

async function main(argv, env = process.env) {
  const checkOnly = argv.length === 1 && argv[0] === "--check";
  const separator = argv.indexOf("--");
  const commandArgs = separator === 0 ? argv.slice(1) : [];
  if (!checkOnly && commandArgs.length === 0) {
    throw new Error(cliUsage());
  }

  const session = await obtainStagingOwnerSession({
    managementAccessToken: env.SUPABASE_ACCESS_TOKEN,
    projectRef: env.SUPABASE_STAGING_PROJECT_ID,
    apiToken: env.ULTRALIGHT_TOKEN,
    smokeAgentId: env.GALACTIC_SMOKE_APP_ID,
  });

  if (checkOnly) {
    await session.revoke();
    console.log(
      "Staging owner session verified and locally revoked; no token was retained.",
    );
    return 0;
  }

  console.log("Staging owner session verified; running the owner-session smoke.");
  return await runWithStagingOwnerSession(
    session,
    commandArgs[0],
    commandArgs.slice(1),
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
