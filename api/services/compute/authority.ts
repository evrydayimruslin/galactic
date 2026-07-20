import {
  COMPUTE_ACTIONS,
  type ComputeAction,
  type ComputeAuthority,
  type ComputeAuthorityDatabaseValue,
} from "./types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FUNCTION_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const MAX_CONSTRAINTS_BYTES = 8 * 1024;
const MAX_CONSTRAINT_DEPTH = 8;
const MAX_AUTHORITIES_PER_RUN = 256;

const ACTIONS = new Set<string>(COMPUTE_ACTIONS);

export class ComputeAuthorityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeAuthorityValidationError";
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ComputeAuthorityValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new ComputeAuthorityValidationError(
      `${field} contains unsupported field ${unexpected[0]}`,
    );
  }
}

function exactString(
  value: unknown,
  field: string,
  pattern: RegExp,
): string {
  if (typeof value !== "string") {
    throw new ComputeAuthorityValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.includes("*") || !pattern.test(normalized)) {
    throw new ComputeAuthorityValidationError(
      `${field} must be an exact, non-wildcard identifier`,
    );
  }
  return normalized;
}

export function requireComputeUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new ComputeAuthorityValidationError(`${field} must be a UUID`);
  }
  return value.trim().toLowerCase();
}

export function requireComputeFunctionName(
  value: unknown,
  field = "functionName",
): string {
  return exactString(value, field, FUNCTION_PATTERN);
}

export function requireComputeCallerFunction(value: unknown): string {
  return requireComputeFunctionName(value, "callerFunction");
}

function validateJsonValue(value: unknown, field: string, depth: number): void {
  if (depth > MAX_CONSTRAINT_DEPTH) {
    throw new ComputeAuthorityValidationError(`${field} is nested too deeply`);
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ComputeAuthorityValidationError(
        `${field} contains a non-finite number`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateJsonValue(value[index], `${field}[${index}]`, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ComputeAuthorityValidationError(
        `${field} must contain only plain JSON values`,
      );
    }
    for (const [key, nested] of Object.entries(value)) {
      validateJsonValue(nested, `${field}.${key}`, depth + 1);
    }
    return;
  }
  throw new ComputeAuthorityValidationError(
    `${field} must contain only JSON values`,
  );
}

export function canonicalizeComputeConstraints(
  value: unknown,
): Record<string, unknown> {
  if (value === undefined) return {};
  const constraints = record(value, "constraints");
  validateJsonValue(constraints, "constraints", 0);
  const encoded = JSON.stringify(constraints);
  if (new TextEncoder().encode(encoded).byteLength > MAX_CONSTRAINTS_BYTES) {
    throw new ComputeAuthorityValidationError(
      `constraints must be at most ${MAX_CONSTRAINTS_BYTES} bytes`,
    );
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

function canonicalAction(value: unknown): ComputeAction {
  if (typeof value !== "string" || !ACTIONS.has(value)) {
    throw new ComputeAuthorityValidationError("action is not supported");
  }
  return value as ComputeAction;
}

export function canonicalizeComputeAuthority(value: unknown): ComputeAuthority {
  const authority = record(value, "authority");
  onlyKeys(authority, ["action", "target", "constraints"], "authority");
  const action = canonicalAction(authority.action);
  const target = record(authority.target, "target");
  const constraints = canonicalizeComputeConstraints(authority.constraints);

  switch (action) {
    case "artifacts.read":
      onlyKeys(target, ["kind"], "target");
      if (target.kind !== "run_input") {
        throw new ComputeAuthorityValidationError(
          "artifacts.read requires target kind run_input",
        );
      }
      return { action, target: { kind: "run_input" }, constraints };
    case "artifacts.write":
      onlyKeys(target, ["kind"], "target");
      if (target.kind !== "run_output") {
        throw new ComputeAuthorityValidationError(
          "artifacts.write requires target kind run_output",
        );
      }
      return { action, target: { kind: "run_output" }, constraints };
    case "budget.read":
    case "receipts.read":
      onlyKeys(target, ["kind"], "target");
      if (target.kind !== "run") {
        throw new ComputeAuthorityValidationError(
          `${action} requires target kind run`,
        );
      }
      return { action, target: { kind: "run" }, constraints };
    case "platform.call":
      onlyKeys(target, ["kind", "functionName"], "target");
      if (target.kind !== "platform_function") {
        throw new ComputeAuthorityValidationError(
          "platform.call requires target kind platform_function",
        );
      }
      return {
        action,
        target: {
          kind: "platform_function",
          functionName: requireComputeFunctionName(
            target.functionName,
            "functionName",
          ),
        },
        constraints,
      };
    case "agents.call":
      onlyKeys(target, ["kind", "agentId", "functionName"], "target");
      if (target.kind !== "agent_function") {
        throw new ComputeAuthorityValidationError(
          "agents.call requires target kind agent_function",
        );
      }
      return {
        action,
        target: {
          kind: "agent_function",
          agentId: requireComputeUuid(target.agentId, "agentId"),
          functionName: requireComputeFunctionName(target.functionName),
        },
        constraints,
      };
  }
}

export function authorityToDatabaseValue(
  authorityInput: ComputeAuthority | unknown,
): ComputeAuthorityDatabaseValue {
  const authority = canonicalizeComputeAuthority(authorityInput);
  const base = {
    action: authority.action,
    resource_kind: authority.target.kind,
    target_agent_id: null,
    target_function: null,
    constraints: authority.constraints ?? {},
  } satisfies ComputeAuthorityDatabaseValue;

  switch (authority.target.kind) {
    case "platform_function":
      return { ...base, target_function: authority.target.functionName };
    case "agent_function":
      return {
        ...base,
        target_agent_id: authority.target.agentId,
        target_function: authority.target.functionName,
      };
    default:
      return base;
  }
}

export function authorityFromDatabaseValue(
  row: Record<string, unknown>,
): ComputeAuthority {
  const resourceKind = row.resource_kind;
  const target = resourceKind === "platform_function"
    ? { kind: "platform_function", functionName: row.target_function }
    : resourceKind === "agent_function"
    ? {
      kind: "agent_function",
      agentId: row.target_agent_id,
      functionName: row.target_function,
    }
    : { kind: resourceKind };
  return canonicalizeComputeAuthority({
    action: row.action,
    target,
    constraints: row.constraints ?? {},
  });
}

export function computeAuthorityKey(authorityInput: unknown): string {
  const authority = authorityToDatabaseValue(authorityInput);
  return JSON.stringify([
    authority.action,
    authority.resource_kind,
    authority.target_agent_id,
    authority.target_function,
    authority.constraints,
  ]);
}

export function canonicalizeComputeAuthorities(
  values: readonly unknown[],
): ComputeAuthority[] {
  if (values.length > MAX_AUTHORITIES_PER_RUN) {
    throw new ComputeAuthorityValidationError(
      `a compute run may request at most ${MAX_AUTHORITIES_PER_RUN} authorities`,
    );
  }
  const byKey = new Map<string, ComputeAuthority>();
  for (const value of values) {
    const authority = canonicalizeComputeAuthority(value);
    byKey.set(computeAuthorityKey(authority), authority);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, authority]) => authority);
}
