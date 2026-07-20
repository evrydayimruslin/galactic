/**
 * Lease-scoped authentication for Galactic Compute jobs.
 *
 * A compute job must never inherit a developer's persistent CLI session. The
 * presence of any job-only environment variable therefore switches resolution
 * into a fail-closed mode: all required context is validated before the token
 * file is read and ~/.galactic is never consulted.
 */

import type { Config } from "./config.ts";

export const DEFAULT_JOB_GATEWAY_URL = "https://galactic.internal/v1";
export const DEFAULT_JOB_TOKEN_FILE = "/run/galactic/job-token";

const JOB_ENV_KEYS = [
  "GALACTIC_JOB_TOKEN_FILE",
  "GALACTIC_GATEWAY_URL",
  "GALACTIC_LEASE_ID",
] as const;

export interface ComputeJobEnvironment {
  gatewayUrl: string;
  leaseId: string;
  tokenFile: string;
}

interface RuntimeConfigDependencies {
  env?: Record<string, string>;
  readTokenFile?: (path: string) => Promise<string>;
  readPersistentConfig?: () => Promise<Config>;
}

function present(env: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function normalizeGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GALACTIC_GATEWAY_URL must be a valid absolute URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GALACTIC_GATEWAY_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "GALACTIC_GATEWAY_URL cannot contain credentials, a query, or a fragment",
    );
  }

  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolve the job marker without reading any files.
 *
 * GALACTIC_LEASE_ID is the explicit compute-mode marker. Any other job-only
 * variable without it is treated as a broken job launch, not as human mode.
 */
export function resolveComputeJobEnvironment(
  env: Record<string, string>,
): ComputeJobEnvironment | null {
  const hasJobSignal = JOB_ENV_KEYS.some((key) => present(env, key));
  if (!hasJobSignal) return null;

  const leaseId = env.GALACTIC_LEASE_ID?.trim();
  if (!leaseId) {
    throw new Error(
      "Incomplete Galactic Compute job context: GALACTIC_LEASE_ID is required",
    );
  }

  const explicitTokenFile = env.GALACTIC_JOB_TOKEN_FILE?.trim();
  if (present(env, "GALACTIC_JOB_TOKEN_FILE") && !explicitTokenFile) {
    throw new Error("GALACTIC_JOB_TOKEN_FILE cannot be empty");
  }

  const explicitGateway = env.GALACTIC_GATEWAY_URL?.trim();
  if (present(env, "GALACTIC_GATEWAY_URL") && !explicitGateway) {
    throw new Error("GALACTIC_GATEWAY_URL cannot be empty");
  }

  return {
    leaseId,
    tokenFile: explicitTokenFile || DEFAULT_JOB_TOKEN_FILE,
    gatewayUrl: normalizeGatewayUrl(explicitGateway || DEFAULT_JOB_GATEWAY_URL),
  };
}

function normalizeJobToken(raw: string): string {
  const token = raw.trim();
  if (!token) throw new Error("Galactic Compute job token file is empty");
  if (token.length > 16_384 || /[\r\n\0]/.test(token)) {
    throw new Error("Galactic Compute job token file is invalid");
  }
  return token;
}

/**
 * Load either an ephemeral compute-job config or the normal persistent config.
 * Dependencies are injectable so precedence and non-access can be proven in
 * tests without touching a developer's real home directory.
 */
export async function loadRuntimeConfig(
  dependencies: RuntimeConfigDependencies = {},
): Promise<Config> {
  const env = dependencies.env ?? Deno.env.toObject();
  const job = resolveComputeJobEnvironment(env);

  if (!job) {
    if (!dependencies.readPersistentConfig) {
      throw new Error("Persistent config reader was not provided");
    }
    return await dependencies.readPersistentConfig();
  }

  const readTokenFile = dependencies.readTokenFile ?? Deno.readTextFile;
  let rawToken: string;
  try {
    rawToken = await readTokenFile(job.tokenFile);
  } catch {
    throw new Error(
      `Unable to read Galactic Compute job token file: ${job.tokenFile}`,
    );
  }

  return {
    api_url: job.gatewayUrl,
    auth: {
      token: normalizeJobToken(rawToken),
      is_job_token: true,
    },
    runtime: {
      kind: "compute-job",
      lease_id: job.leaseId,
      token_file: job.tokenFile,
    },
  };
}
