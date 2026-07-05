import { getEnv } from "../lib/env.ts";
import type {
  RoutineBudgetDefaults,
  RoutineCapabilityAccess,
} from "../../shared/contracts/routine.ts";

export const ROUTINE_ACTOR_TOKEN_PREFIX = "gxr_v1_";

const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 60 * 60;
const DEFAULT_SCOPES = ["apps:call"];
const CLAIM_TYPE = "ultralight.routine_actor";

export interface RoutineActorUserInput {
  id: string;
  email: string;
  tier?: string | null;
  provisional?: boolean | null;
}

export interface RoutineActorRoutineInput {
  id: string;
  composerAppId?: string | null;
  composerAppSlug?: string | null;
  handlerFunction?: string | null;
  budgetPolicy?: RoutineBudgetDefaults | null;
}

export interface RoutineActorCapabilityInput {
  app_id?: string | null;
  app_ref?: string | null;
  function_name?: string | null;
  access?: RoutineCapabilityAccess | null;
  approved?: boolean | null;
  required?: boolean | null;
  constraints?: Record<string, unknown> | null;
  pricing_snapshot?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateRoutineActorTokenInput {
  user: RoutineActorUserInput;
  routine: RoutineActorRoutineInput;
  routineRunId: string;
  traceId?: string | null;
  capabilities?: RoutineActorCapabilityInput[];
  scopes?: string[];
  expiresInSeconds?: number;
  tokenId?: string;
}

export interface RoutineActorStoredRoutineInput {
  id: string;
  composer_app_id?: string | null;
  composer_app_slug?: string | null;
  handler_function?: string | null;
  budget_policy?: RoutineBudgetDefaults | null;
  capabilities?: RoutineActorCapabilityInput[];
}

export interface RoutineActorStoredRunInput {
  id: string;
  trace_id?: string | null;
}

export interface RoutineActorCapabilityScope {
  app_id: string | null;
  app_ref: string | null;
  function_name: string;
  access: RoutineCapabilityAccess;
  required: boolean;
  constraints?: Record<string, unknown>;
  pricing_snapshot?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RoutineActorTokenClaims {
  typ: typeof CLAIM_TYPE;
  ver: 1;
  jti: string;
  sub: string;
  user_id: string;
  user_email: string;
  user_tier: string;
  provisional: boolean;
  routine_id: string;
  routine_run_id: string;
  trace_id?: string;
  composer_app_id?: string;
  composer_app_slug?: string;
  handler_function?: string;
  app_ids: string[];
  function_names: string[];
  scopes: string[];
  capabilities: RoutineActorCapabilityScope[];
  budget_policy?: RoutineBudgetDefaults;
  iat: number;
  exp: number;
}

export interface VerifiedRoutineActorToken {
  token: string;
  claims: RoutineActorTokenClaims;
}

export interface RoutineActorTokenCryptoOptions {
  secret?: string;
  now?: Date;
}

export interface CreatedRoutineActorToken {
  token: string;
  claims: RoutineActorTokenClaims;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  )
    .sort();
}

function getSigningSecret(explicitSecret?: string): string {
  if (explicitSecret?.trim()) return explicitSecret.trim();

  for (
    const key of [
      "ROUTINE_ACTOR_TOKEN_SECRET",
      // Server-only fallback. Deliberately NOT WORKER_SECRET (sandbox-exposed):
      // WORKER_SECRET is injected into the dynamic-worker sandbox, so including
      // it here would let app code forge routine-actor (gxr_v1_) tokens and
      // impersonate any user. Matches sandbox-actor.ts / agent-caller-context.ts.
      "SUPABASE_SERVICE_ROLE_KEY",
    ]
  ) {
    const value = getEnv(key);
    if (value.trim()) return value.trim();
  }

  throw new Error("Routine actor token signing secret is not configured");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(
    base64.length + (4 - base64.length % 4) % 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLength; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function encodeClaims(claims: RoutineActorTokenClaims): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
}

function decodeClaims(payload: string): unknown {
  const json = new TextDecoder().decode(base64UrlToBytes(payload));
  return JSON.parse(json);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && !!item.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoutineActorCapabilityScope(
  value: unknown,
): value is RoutineActorCapabilityScope {
  if (!isRecord(value)) return false;
  return (
    (value.app_id === null || typeof value.app_id === "string") &&
    (value.app_ref === null || typeof value.app_ref === "string") &&
    typeof value.function_name === "string" &&
    (value.access === "read" || value.access === "write") &&
    typeof value.required === "boolean"
  );
}

function isRoutineActorTokenClaims(
  value: unknown,
): value is RoutineActorTokenClaims {
  if (!isRecord(value)) return false;
  return (
    value.typ === CLAIM_TYPE &&
    value.ver === 1 &&
    typeof value.jti === "string" &&
    typeof value.sub === "string" &&
    typeof value.user_id === "string" &&
    value.sub === value.user_id &&
    typeof value.user_email === "string" &&
    typeof value.user_tier === "string" &&
    typeof value.provisional === "boolean" &&
    typeof value.routine_id === "string" &&
    typeof value.routine_run_id === "string" &&
    (value.trace_id === undefined || typeof value.trace_id === "string") &&
    (value.composer_app_id === undefined ||
      typeof value.composer_app_id === "string") &&
    (value.composer_app_slug === undefined ||
      typeof value.composer_app_slug === "string") &&
    (value.handler_function === undefined ||
      typeof value.handler_function === "string") &&
    isStringArray(value.app_ids) &&
    value.app_ids.length > 0 &&
    isStringArray(value.function_names) &&
    value.function_names.length > 0 &&
    isStringArray(value.scopes) &&
    value.scopes.length > 0 &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isRoutineActorCapabilityScope) &&
    (value.budget_policy === undefined || isRecord(value.budget_policy)) &&
    typeof value.iat === "number" &&
    Number.isFinite(value.iat) &&
    typeof value.exp === "number" &&
    Number.isFinite(value.exp)
  );
}

function normalizeCapabilityScope(
  capability: RoutineActorCapabilityInput,
): RoutineActorCapabilityScope | null {
  if (capability.approved !== true) return null;

  const functionName = optionalTrimmed(capability.function_name);
  if (!functionName) return null;

  const access = capability.access === "write" ? "write" : "read";
  return {
    app_id: optionalTrimmed(capability.app_id) ?? null,
    app_ref: optionalTrimmed(capability.app_ref) ?? null,
    function_name: functionName,
    access,
    required: capability.required !== false,
    ...(capability.constraints && Object.keys(capability.constraints).length > 0
      ? { constraints: capability.constraints }
      : {}),
    ...(capability.pricing_snapshot &&
        Object.keys(capability.pricing_snapshot).length > 0
      ? { pricing_snapshot: capability.pricing_snapshot }
      : {}),
    ...(capability.metadata && Object.keys(capability.metadata).length > 0
      ? { metadata: capability.metadata }
      : {}),
  };
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  const normalized = dedupeSorted(
    scopes && scopes.length > 0 ? scopes : DEFAULT_SCOPES,
  );
  if (!normalized.includes("apps:call") && !normalized.includes("*")) {
    normalized.push("apps:call");
  }
  return dedupeSorted(normalized);
}

export function routineActorScopeFromCapabilities(input: {
  routine: RoutineActorRoutineInput;
  capabilities?: RoutineActorCapabilityInput[];
}): {
  appIds: string[];
  functionNames: string[];
  capabilities: RoutineActorCapabilityScope[];
} {
  const appIds: string[] = [];
  const functionNames: string[] = [];

  const composerAppId = optionalTrimmed(input.routine.composerAppId);
  const composerAppSlug = optionalTrimmed(input.routine.composerAppSlug);
  const handlerFunction = optionalTrimmed(input.routine.handlerFunction);
  if (composerAppId) appIds.push(composerAppId);
  if (composerAppSlug) appIds.push(composerAppSlug);
  if (handlerFunction) functionNames.push(handlerFunction);

  const capabilities = (input.capabilities || [])
    .map(normalizeCapabilityScope)
    .filter((capability): capability is RoutineActorCapabilityScope =>
      !!capability
    );

  for (const capability of capabilities) {
    if (capability.app_id) appIds.push(capability.app_id);
    if (capability.app_ref) appIds.push(capability.app_ref);
    functionNames.push(capability.function_name);
  }

  return {
    appIds: dedupeSorted(appIds),
    functionNames: dedupeSorted(functionNames),
    capabilities,
  };
}

export async function createRoutineActorToken(
  input: CreateRoutineActorTokenInput,
  options: RoutineActorTokenCryptoOptions = {},
): Promise<CreatedRoutineActorToken> {
  const userId = requiredString(input.user.id, "user.id");
  const userEmail = requiredString(input.user.email, "user.email");
  const routineId = requiredString(input.routine.id, "routine.id");
  const routineRunId = requiredString(input.routineRunId, "routineRunId");
  const { appIds, functionNames, capabilities } =
    routineActorScopeFromCapabilities({
      routine: input.routine,
      capabilities: input.capabilities,
    });

  if (appIds.length === 0) {
    throw new Error("routine actor token requires at least one app identifier");
  }
  if (functionNames.length === 0) {
    throw new Error("routine actor token requires at least one function name");
  }

  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const ttl = Math.max(
    1,
    Math.min(
      MAX_TTL_SECONDS,
      Math.floor(input.expiresInSeconds ?? DEFAULT_TTL_SECONDS),
    ),
  );
  const composerAppId = optionalTrimmed(input.routine.composerAppId);
  const composerAppSlug = optionalTrimmed(input.routine.composerAppSlug);
  const handlerFunction = optionalTrimmed(input.routine.handlerFunction);
  const traceId = optionalTrimmed(input.traceId);

  const claims: RoutineActorTokenClaims = {
    typ: CLAIM_TYPE,
    ver: 1,
    jti: input.tokenId?.trim() || crypto.randomUUID(),
    sub: userId,
    user_id: userId,
    user_email: userEmail,
    user_tier: optionalTrimmed(input.user.tier) ?? "free",
    provisional: input.user.provisional === true,
    routine_id: routineId,
    routine_run_id: routineRunId,
    ...(traceId ? { trace_id: traceId } : {}),
    ...(composerAppId ? { composer_app_id: composerAppId } : {}),
    ...(composerAppSlug ? { composer_app_slug: composerAppSlug } : {}),
    ...(handlerFunction ? { handler_function: handlerFunction } : {}),
    app_ids: appIds,
    function_names: functionNames,
    scopes: normalizeScopes(input.scopes),
    capabilities,
    ...(input.routine.budgetPolicy
      ? { budget_policy: input.routine.budgetPolicy }
      : {}),
    iat: nowSeconds,
    exp: nowSeconds + ttl,
  };

  const payload = encodeClaims(claims);
  const signature = await signPayload(
    payload,
    getSigningSecret(options.secret),
  );
  return {
    token: `${ROUTINE_ACTOR_TOKEN_PREFIX}${payload}.${signature}`,
    claims,
  };
}

export function routineActorTokenInputFromStoredRun(input: {
  user: RoutineActorUserInput;
  routine: RoutineActorStoredRoutineInput;
  run: RoutineActorStoredRunInput;
  scopes?: string[];
  expiresInSeconds?: number;
  tokenId?: string;
}): CreateRoutineActorTokenInput {
  return {
    user: input.user,
    routine: {
      id: input.routine.id,
      composerAppId: input.routine.composer_app_id ?? null,
      composerAppSlug: input.routine.composer_app_slug ?? null,
      handlerFunction: input.routine.handler_function ?? null,
      budgetPolicy: input.routine.budget_policy ?? null,
    },
    routineRunId: input.run.id,
    traceId: input.run.trace_id ?? null,
    capabilities: input.routine.capabilities ?? [],
    scopes: input.scopes,
    expiresInSeconds: input.expiresInSeconds,
    tokenId: input.tokenId,
  };
}

export function createRoutineActorTokenForRun(
  input: Parameters<typeof routineActorTokenInputFromStoredRun>[0],
  options: RoutineActorTokenCryptoOptions = {},
): Promise<CreatedRoutineActorToken> {
  return createRoutineActorToken(
    routineActorTokenInputFromStoredRun(input),
    options,
  );
}

export function isRoutineActorToken(token: string): boolean {
  return token.startsWith(ROUTINE_ACTOR_TOKEN_PREFIX);
}

export async function verifyRoutineActorToken(
  token: string,
  options: RoutineActorTokenCryptoOptions = {},
): Promise<VerifiedRoutineActorToken | null> {
  if (!isRoutineActorToken(token)) return null;

  const tokenBody = token.slice(ROUTINE_ACTOR_TOKEN_PREFIX.length);
  const parts = tokenBody.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [payload, signature] = parts;
  const expectedSignature = await signPayload(
    payload,
    getSigningSecret(options.secret),
  );
  if (!constantTimeEqual(signature, expectedSignature)) return null;

  let decoded: unknown;
  try {
    decoded = decodeClaims(payload);
  } catch {
    return null;
  }

  if (!isRoutineActorTokenClaims(decoded)) return null;

  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  if (decoded.exp <= nowSeconds) return null;
  if (decoded.iat > nowSeconds + 60) return null;

  return { token, claims: decoded };
}
