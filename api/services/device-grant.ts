import { getEnv } from "../lib/env.ts";
import { createToken } from "./tokens.ts";

/**
 * WO-F4: device authorization grant. The CLI mints a pairing, the human
 * confirms the user code inside their existing web session, and the poll
 * exchanges the device code for a standard-scope gx_ key — the existing
 * credential, a new issuance path. Single-use, ten-minute codes; the
 * device code is stored only as a SHA-256 hash; the key is revealed only
 * in the successful poll response.
 */

export const DEVICE_GRANT_WINDOW_MS = 10 * 60 * 1_000;
export const DEVICE_KEY_SCOPES = [
  "apps:read",
  "apps:call",
  "agents:build",
  "agents:operate",
];
export const DEVICE_KEY_EXPIRES_IN_DAYS = 90;
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type DeviceGrantErrorCode =
  | "not_found"
  | "expired"
  | "already_resolved"
  | "membership_required"
  | "unavailable";

export class DeviceGrantError extends Error {
  readonly code: DeviceGrantErrorCode;
  constructor(code: DeviceGrantErrorCode, message: string) {
    super(message);
    this.name = "DeviceGrantError";
    this.code = code;
  }
}

export interface DeviceGrantServiceOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  randomUUID?: () => string;
  randomBytes?: (length: number) => Uint8Array;
  mintKey?: typeof createToken;
}

interface RestConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
}

function restConfig(options: DeviceGrantServiceOptions): RestConfig {
  const supabaseUrl = options.supabaseUrl ?? getEnv("SUPABASE_URL");
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new DeviceGrantError("unavailable", "Device login is unavailable");
  }
  return { supabaseUrl, serviceRoleKey, fetchFn: options.fetchFn ?? fetch };
}

async function rest(
  cfg: RestConfig,
  method: "GET" | "POST" | "PATCH",
  pathAndQuery: string,
  body?: unknown,
): Promise<unknown> {
  const fetchFn = cfg.fetchFn;
  let response: Response;
  try {
    response = await fetchFn(`${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(method === "GET" ? {} : { Prefer: "return=representation" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new DeviceGrantError(
      "unavailable",
      "Device login storage did not respond",
    );
  }
  if (!response.ok) {
    throw new DeviceGrantError(
      "unavailable",
      `Device login storage rejected the request (${response.status})`,
    );
  }
  return await response.json();
}

function firstRow(payload: unknown): Record<string, unknown> | null {
  const rows = Array.isArray(payload) ? payload : [];
  const row = rows[0];
  return row && typeof row === "object"
    ? row as Record<string, unknown>
    : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomBytes(
  options: DeviceGrantServiceOptions,
  length: number,
): Uint8Array {
  return (options.randomBytes ??
    ((size: number) => crypto.getRandomValues(new Uint8Array(size))))(length);
}

function generateUserCode(options: DeviceGrantServiceOptions): string {
  const bytes = randomBytes(options, 8);
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += USER_CODE_ALPHABET[bytes[index] % USER_CODE_ALPHABET.length];
    if (index === 3) code += "-";
  }
  return code;
}

export interface MintedDeviceAuthorization {
  userCode: string;
  deviceCode: string;
  expiresAt: string;
  verificationPath: string;
  pollIntervalSeconds: number;
}

export async function mintDeviceAuthorization(
  options: DeviceGrantServiceOptions = {},
): Promise<MintedDeviceAuthorization> {
  const cfg = restConfig(options);
  const now = options.now ? options.now() : new Date();
  const userCode = generateUserCode(options);
  const deviceCodeBytes = randomBytes(options, 32);
  const deviceCode = Array.from(deviceCodeBytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = new Date(now.getTime() + DEVICE_GRANT_WINDOW_MS)
    .toISOString();
  await rest(cfg, "POST", "device_authorizations", {
    id: (options.randomUUID ?? (() => crypto.randomUUID()))(),
    user_code: userCode,
    device_code_hash: await sha256Hex(deviceCode),
    status: "pending",
    created_at: now.toISOString(),
    expires_at: expiresAt,
  });
  return {
    userCode,
    deviceCode,
    expiresAt,
    verificationPath: "/device",
    pollIntervalSeconds: 3,
  };
}

/** The human's explicit confirmation, inside their web session. */
export async function approveDeviceAuthorization(
  input: { userCode: string; userId: string },
  options: DeviceGrantServiceOptions = {},
): Promise<{ approved: true }> {
  const userCode = input.userCode.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(userCode)) {
    throw new DeviceGrantError("not_found", "Unknown device code");
  }
  const cfg = restConfig(options);
  const now = options.now ? options.now() : new Date();
  const row = firstRow(
    await rest(
      cfg,
      "GET",
      `device_authorizations?user_code=eq.${encodeURIComponent(userCode)}` +
        `&select=id,status,expires_at&limit=1`,
    ),
  );
  if (!row) throw new DeviceGrantError("not_found", "Unknown device code");
  if (row.status !== "pending") {
    throw new DeviceGrantError(
      "already_resolved",
      "This device code was already used",
    );
  }
  if (
    typeof row.expires_at === "string" &&
    Date.parse(row.expires_at) <= now.getTime()
  ) {
    throw new DeviceGrantError("expired", "This device code has expired");
  }
  const patched = firstRow(
    await rest(
      cfg,
      "PATCH",
      `device_authorizations?id=eq.${
        encodeURIComponent(String(row.id))
      }&status=eq.pending`,
      {
        status: "approved",
        approved_by: input.userId,
        approved_at: now.toISOString(),
      },
    ),
  );
  if (!patched) {
    throw new DeviceGrantError(
      "already_resolved",
      "This device code was already used",
    );
  }
  return { approved: true };
}

export type DevicePollResult =
  | { status: "pending"; pollIntervalSeconds: number }
  | {
    status: "complete";
    plaintextToken: string;
    tokenPrefix: string;
    scopes: string[];
    expiresInDays: number;
  };

/** The CLI's poll: exchanges an approved device code for a gx_ key, once. */
export async function pollDeviceAuthorization(
  input: { deviceCode: string },
  options: DeviceGrantServiceOptions = {},
): Promise<DevicePollResult> {
  if (!/^[0-9a-f]{64}$/.test(input.deviceCode)) {
    throw new DeviceGrantError("not_found", "Unknown device code");
  }
  const cfg = restConfig(options);
  const now = options.now ? options.now() : new Date();
  const hash = await sha256Hex(input.deviceCode);
  const row = firstRow(
    await rest(
      cfg,
      "GET",
      `device_authorizations?device_code_hash=eq.${hash}` +
        `&select=id,status,expires_at,approved_by&limit=1`,
    ),
  );
  if (!row) throw new DeviceGrantError("not_found", "Unknown device code");
  if (
    typeof row.expires_at === "string" &&
    Date.parse(row.expires_at) <= now.getTime() &&
    row.status === "pending"
  ) {
    throw new DeviceGrantError("expired", "This device code has expired");
  }
  if (row.status === "pending") {
    return { status: "pending", pollIntervalSeconds: 3 };
  }
  if (row.status !== "approved" || typeof row.approved_by !== "string") {
    throw new DeviceGrantError(
      "already_resolved",
      "This device code was already used",
    );
  }

  // Claim exactly-once BEFORE minting, so a concurrent poll can never
  // yield two keys for one authorization.
  const claimed = firstRow(
    await rest(
      cfg,
      "PATCH",
      `device_authorizations?id=eq.${
        encodeURIComponent(String(row.id))
      }&status=eq.approved`,
      { status: "consumed", consumed_at: now.toISOString() },
    ),
  );
  if (!claimed) {
    throw new DeviceGrantError(
      "already_resolved",
      "This device code was already used",
    );
  }

  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  let minted;
  try {
    minted = await (options.mintKey ?? createToken)(
      row.approved_by,
      `Device login ${stamp}`,
      {
        expiresInDays: DEVICE_KEY_EXPIRES_IN_DAYS,
        scopes: [...DEVICE_KEY_SCOPES],
      },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.toLowerCase().includes("subscription")) {
      throw new DeviceGrantError(
        "membership_required",
        "An active membership is required for API keys — approve a build or subscribe first",
      );
    }
    throw new DeviceGrantError(
      "unavailable",
      "The device key could not be minted",
    );
  }
  return {
    status: "complete",
    plaintextToken: minted.plaintext_token,
    tokenPrefix: minted.plaintext_token.slice(0, 8),
    scopes: [...DEVICE_KEY_SCOPES],
    expiresInDays: DEVICE_KEY_EXPIRES_IN_DAYS,
  };
}
