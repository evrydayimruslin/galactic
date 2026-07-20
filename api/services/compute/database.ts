import { getEnv } from "../../lib/env.ts";

export interface ComputeDatabaseDeps {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  tokenPepper?: string;
  now?: Date;
}

export class ComputeControlPlaneError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | null;

  constructor(input: {
    code: string;
    status: number;
    message: string;
    details?: Record<string, unknown> | null;
  }) {
    super(input.message);
    this.name = "ComputeControlPlaneError";
    this.code = input.code;
    this.status = input.status;
    this.details = input.details ?? null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function dbConfig(deps: ComputeDatabaseDeps): {
  baseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
} {
  const baseUrl = (deps.supabaseUrl ?? getEnv("SUPABASE_URL")).replace(
    /\/+$/,
    "",
  );
  const serviceRoleKey = deps.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_UNAVAILABLE",
      status: 503,
      message: "Galactic Compute persistence is not configured.",
    });
  }
  return { baseUrl, serviceRoleKey, fetchFn: deps.fetchFn ?? fetch };
}

async function responseError(
  response: Response,
): Promise<ComputeControlPlaneError> {
  const payload = await response.json().catch(() => null);
  const record = asRecord(payload);
  const postgresCode = typeof record?.code === "string" ? record.code : null;
  if (postgresCode === "55P03" || postgresCode === "40001") {
    return new ComputeControlPlaneError({
      code: "COMPUTE_CONCURRENT_LIFECYCLE",
      status: 409,
      message:
        "A concurrent Agent or owner lifecycle change is in progress; retry.",
      details: { postgresCode },
    });
  }
  let details = asRecord(record?.details) ?? record;
  if (typeof record?.details === "string") {
    try {
      details = asRecord(JSON.parse(record.details)) ?? details;
    } catch {
      // Keep the outer PostgREST error. Never include request credentials.
    }
  }
  const code = typeof details?.code === "string"
    ? details.code
    : "COMPUTE_DATABASE_ERROR";
  const message = typeof details?.message === "string"
    ? details.message
    : `Galactic Compute persistence failed (${response.status}).`;
  return new ComputeControlPlaneError({
    code,
    status: response.status >= 400 && response.status < 600
      ? response.status
      : 503,
    message,
    details,
  });
}

export async function callComputeRpc(
  name: string,
  body: Record<string, unknown>,
  deps: ComputeDatabaseDeps = {},
): Promise<unknown> {
  const { baseUrl, serviceRoleKey, fetchFn } = dbConfig(deps);
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_UNAVAILABLE",
      status: 503,
      message: "Galactic Compute persistence is unavailable.",
    });
  }
  if (!response.ok) throw await responseError(response);
  return await response.json().catch(() => null);
}

export async function queryComputeRows(
  pathAndQuery: string,
  deps: ComputeDatabaseDeps = {},
): Promise<Record<string, unknown>[]> {
  const { baseUrl, serviceRoleKey, fetchFn } = dbConfig(deps);
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/rest/v1/${pathAndQuery}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });
  } catch {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_UNAVAILABLE",
      status: 503,
      message: "Galactic Compute persistence is unavailable.",
    });
  }
  if (!response.ok) throw await responseError(response);
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_INVALID_RESPONSE",
      status: 503,
      message: "Galactic Compute persistence returned an invalid response.",
    });
  }
  return payload.filter((value): value is Record<string, unknown> =>
    asRecord(value) !== null
  );
}

export function firstComputeRow(
  value: unknown,
  operation: string,
): Record<string, unknown> {
  const row = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  if (!row) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_INVALID_RESPONSE",
      status: 503,
      message: `${operation} returned no decision.`,
    });
  }
  return row;
}

export function requiredString(
  row: Record<string, unknown>,
  field: string,
  operation: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || !value) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_INVALID_RESPONSE",
      status: 503,
      message: `${operation} returned invalid ${field}.`,
    });
  }
  return value;
}

export function nullableString(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  return typeof value === "string" && value ? value : null;
}

export function integerString(
  row: Record<string, unknown>,
  field: string,
  operation: string,
): string {
  const value = row[field];
  if (
    (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  ) return String(value);
  throw new ComputeControlPlaneError({
    code: "COMPUTE_DATABASE_INVALID_RESPONSE",
    status: 503,
    message: `${operation} returned invalid ${field}.`,
  });
}
