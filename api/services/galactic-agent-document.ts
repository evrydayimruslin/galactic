import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Node,
  parseAllDocuments,
} from "yaml";

import {
  type AppManifest,
  type ManifestFunction,
  normalizeManifestEnvVars,
  validateManifest,
} from "../../shared/contracts/manifest.ts";
import {
  type D1TestFixtureConfig,
  resolveD1TestFixtureConfig,
} from "./d1-test-fixtures.ts";
import {
  type HttpTestFixtureConfig,
  resolveHttpTestFixtureConfig,
} from "./http-test-fixtures.ts";
import { canonicalJson, sha256Hex } from "./trust.ts";

export const GALACTIC_AGENT_API_VERSION =
  "agents.connectgalactic.com/v1alpha1" as const;
export const GALACTIC_AGENT_KIND = "Agent" as const;

export const GALACTIC_STABLE_EFFECT_IDS = [
  "storage.read",
  "storage.write",
  "storage.delete",
  "database.read",
  "database.write",
  "memory.read",
  "memory.write",
  "routine.read",
  "notification.owner.write",
  "inference.generate",
  "inference.embed",
  "compute.execute",
  "network.http",
  "network.tcp",
  "credential.http",
  "email.imap.read",
  "email.smtp.send",
  "event.publish",
  "agent.call",
] as const;

export type GalacticStableEffectId =
  (typeof GALACTIC_STABLE_EFFECT_IDS)[number];
export type GalacticEffectId =
  | GalacticStableEffectId
  | `x-${string}`;
export type GalacticAuthorityLevel =
  | "read"
  | "internal_write"
  | "external_write";
export type GalacticEffectPolicy = "ask" | "free";

const GALACTIC_AUTHORITY_LEVEL_RANK: Record<GalacticAuthorityLevel, number> = {
  read: 0,
  internal_write: 1,
  external_write: 2,
};

const GALACTIC_EFFECT_MINIMUM_AUTHORITY_LEVEL: Partial<
  Record<GalacticStableEffectId, GalacticAuthorityLevel>
> = {
  "storage.write": "internal_write",
  "storage.delete": "internal_write",
  "database.write": "internal_write",
  "memory.write": "internal_write",
  "notification.owner.write": "external_write",
  "network.http": "external_write",
  "network.tcp": "external_write",
  "credential.http": "external_write",
  "email.imap.read": "external_write",
  "email.smtp.send": "external_write",
  "event.publish": "external_write",
  "agent.call": "external_write",
};

/**
 * Return the least human-facing consequence level that honestly covers the
 * known stable effects. Extension effects do not mint runtime capabilities and
 * therefore cannot lower or raise this platform-defined minimum.
 */
export function minimumGalacticAuthorityLevel(
  effects: Iterable<string>,
): GalacticAuthorityLevel {
  let minimum: GalacticAuthorityLevel = "read";
  for (const effect of effects) {
    if (!STABLE_EFFECT_SET.has(effect)) continue;
    const candidate = GALACTIC_EFFECT_MINIMUM_AUTHORITY_LEVEL[
      effect as GalacticStableEffectId
    ] ?? "read";
    if (
      GALACTIC_AUTHORITY_LEVEL_RANK[candidate] >
        GALACTIC_AUTHORITY_LEVEL_RANK[minimum]
    ) {
      minimum = candidate;
    }
  }
  return minimum;
}

export function galacticAuthorityLevelCoversEffects(
  level: GalacticAuthorityLevel,
  effects: Iterable<string>,
): boolean {
  return GALACTIC_AUTHORITY_LEVEL_RANK[level] >=
    GALACTIC_AUTHORITY_LEVEL_RANK[minimumGalacticAuthorityLevel(effects)];
}

export interface GalacticFunctionAuthority {
  level: GalacticAuthorityLevel;
  effects: Partial<Record<GalacticEffectId, GalacticEffectPolicy>>;
  [extension: `x-${string}`]: unknown;
}

export interface GalacticFunctionSpend {
  inference?: GalacticEffectPolicy;
  compute?: GalacticEffectPolicy;
  [extension: `x-${string}`]: unknown;
}

export interface GalacticConformanceFixtures {
  env?: Record<string, string>;
  database?: D1TestFixtureConfig;
  http?: HttpTestFixtureConfig;
  [extension: `x-${string}`]: unknown;
}

export interface GalacticConformanceCase {
  id: string;
  function: string;
  input?: Record<string, unknown>;
  fixtures?: GalacticConformanceFixtures;
  required?: boolean;
  [extension: `x-${string}`]: unknown;
}

export interface NormalizedGalacticConformanceCase
  extends GalacticConformanceCase {
  required: boolean;
}

export type GalacticAgentFunction =
  & Omit<ManifestFunction, "uses_inference" | "uses_compute">
  & {
    authority: GalacticFunctionAuthority;
    spend?: GalacticFunctionSpend;
    [extension: `x-${string}`]: unknown;
  };

export interface GalacticAgentMetadata {
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  parentReleaseDigest?: string;
  [extension: `x-${string}`]: unknown;
}

export interface GalacticAgentSpec {
  entry?: AppManifest["entry"];
  functions: Record<string, GalacticAgentFunction>;
  operator_errors?: AppManifest["operator_errors"];
  access_policy?: AppManifest["access_policy"];
  external_functions?: AppManifest["external_functions"];
  imports?: AppManifest["imports"];
  emits?: AppManifest["emits"];
  interfaces?: AppManifest["interfaces"];
  widgets?: AppManifest["widgets"];
  context_sources?: AppManifest["context_sources"];
  routines?: AppManifest["routines"];
  env_vars?: AppManifest["env_vars"];
  http?: AppManifest["http"];
  rate_limit?: AppManifest["rate_limit"];
  network?: AppManifest["network"];
  compute?: AppManifest["compute"];
  conformance: {
    profile: "basic";
    cases: NormalizedGalacticConformanceCase[];
    [extension: `x-${string}`]: unknown;
  };
  [extension: `x-${string}`]: unknown;
}

export interface GalacticAgentDocument {
  apiVersion: typeof GALACTIC_AGENT_API_VERSION;
  kind: typeof GALACTIC_AGENT_KIND;
  metadata: GalacticAgentMetadata;
  spec: GalacticAgentSpec;
  [extension: `x-${string}`]: unknown;
}

export type CompiledGalacticFunction =
  & ManifestFunction
  & {
    authority: GalacticFunctionAuthority;
    spend?: GalacticFunctionSpend;
    [extension: `x-${string}`]: unknown;
  };

export type CompiledGalacticManifest =
  & Omit<AppManifest, "functions">
  & {
    functions: Record<string, CompiledGalacticFunction>;
    [extension: `x-${string}`]: unknown;
  };

export interface GalacticAgentDocumentResolution {
  sourceKind: "legacy_manifest" | "galactic_yaml";
  compiledManifest: CompiledGalacticManifest | AppManifest;
  document: GalacticAgentDocument | null;
  normalizedJson: string;
  documentDigest: string;
  cases: NormalizedGalacticConformanceCase[];
  functions: string[];
  effects: GalacticEffectId[];
  effectsByFunction: Record<string, GalacticEffectId[]>;
}

export type GalacticAgentDocumentErrorCode =
  | "GALACTIC_DOCUMENT_TOO_LARGE"
  | "GALACTIC_DOCUMENT_PARSE_ERROR"
  | "GALACTIC_DOCUMENT_UNSAFE_YAML"
  | "GALACTIC_DOCUMENT_SCHEMA_ERROR"
  | "GALACTIC_DOCUMENT_NOT_ROOT"
  | "GALACTIC_DOCUMENT_AMBIGUOUS"
  | "GALACTIC_MANIFEST_PARSE_ERROR"
  | "GALACTIC_MANIFEST_INVALID";

export class GalacticAgentDocumentError extends Error {
  override readonly name = "GalacticAgentDocumentError";

  constructor(
    readonly code: GalacticAgentDocumentErrorCode,
    readonly path: string,
    detail: string,
  ) {
    super(`${code} at ${path || "$"}: ${detail}`);
  }
}

interface SourceFile {
  path: string;
  content: string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_DOCUMENT_DEPTH = 32;
const MAX_DOCUMENT_NODES = 10_000;
const PARENT_RELEASE_DIGEST_RE = /^[a-f0-9]{64}$/;
const FUNCTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CASE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const EXTENSION_KEY_RE = /^x-.+/;
const STABLE_EFFECT_SET = new Set<string>(GALACTIC_STABLE_EFFECT_IDS);

const ROOT_KEYS = new Set(["apiVersion", "kind", "metadata", "spec"]);
const METADATA_KEYS = new Set([
  "name",
  "version",
  "description",
  "author",
  "icon",
  "parentReleaseDigest",
]);
const SPEC_KEYS = new Set([
  "entry",
  "functions",
  "operator_errors",
  "access_policy",
  "external_functions",
  "imports",
  "emits",
  "interfaces",
  "widgets",
  "context_sources",
  "routines",
  "env_vars",
  "http",
  "rate_limit",
  "network",
  "compute",
  "conformance",
]);
const FUNCTION_KEYS = new Set([
  "description",
  "parameters",
  "returns",
  "examples",
  "annotations",
  "generation_hints",
  "execution",
  "authority",
  "spend",
]);
const AUTHORITY_KEYS = new Set(["level", "effects"]);
const SPEND_KEYS = new Set(["inference", "compute"]);
const CONFORMANCE_KEYS = new Set(["profile", "cases"]);
const CASE_KEYS = new Set([
  "id",
  "function",
  "input",
  "fixtures",
  "required",
]);
const FIXTURE_KEYS = new Set(["env", "database", "http"]);
const ENTRY_KEYS = new Set(["functions"]);
const EXECUTION_KEYS = new Set(["class", "timeout_ms"]);
const PARAMETER_KEYS = new Set([
  "type",
  "description",
  "required",
  "default",
  "enum",
  "items",
  "properties",
]);
const RETURN_KEYS = new Set(["type", "description"]);
const ANNOTATION_KEYS = new Set([
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
]);
const GENERATION_HINT_KEYS = new Set([
  "tags",
  "preferred_component",
  "entity_types",
  "action_group",
  "safe_default_filters",
  "suggested_components",
  "prompt_examples",
]);
const GENERATION_COMPONENT_KEYS = new Set([
  "kind",
  "title",
  "description",
  "data_view",
  "context_source_id",
  "action_ids",
]);
const OPERATOR_ERROR_KEYS = new Set([
  "summary",
  "detail",
  "retryable",
  "suggested_actions",
]);
const ACCESS_POLICY_KEYS = new Set(["mode", "module", "export"]);
const DEPENDENCY_KEYS = new Set(["app", "functions", "access"]);
const IMPORT_KEYS = new Set(["description", "signature", "functions"]);
const INTERFACE_KEYS = new Set([
  "id",
  "label",
  "description",
  "entry",
  "functions",
  "read_models",
  "min_height",
  "hash",
]);
const INTERFACE_READ_MODEL_KEYS = new Set([
  "fresh_for_ms",
  "stale_for_ms",
  "prefetch_args",
]);
const WIDGET_KEYS = new Set([
  "id",
  "label",
  "description",
  "ui_function",
  "data_function",
  "data_tool",
  "poll_interval_s",
  "dependencies",
  "cards",
  "agentic",
  "context_function",
  "actions_function",
  "context_sources",
  "agent_actions",
  "generation_hints",
]);
const COMMAND_CARD_KEYS = new Set([
  "id",
  "label",
  "description",
  "size",
  "render",
  "kind",
  "data_view",
  "data_function",
  "refresh_interval_s",
  "dependencies",
  "generation_hints",
]);
const WIDGET_ACTION_KEYS = new Set([
  "id",
  "label",
  "description",
  "mode",
  "args_schema",
  "confirmation",
  "mcp",
  "ui",
  "expected_result",
  "generation_hints",
]);
const WIDGET_ACTION_MCP_KEYS = new Set(["function", "args_template"]);
const WIDGET_ACTION_UI_KEYS = new Set([
  "command",
  "component_id",
  "args_template",
]);
const CONTEXT_SOURCE_KEYS = new Set([
  "id",
  "label",
  "description",
  "type",
  "access",
  "searchable",
  "default_for_widgets",
  "tables",
  "query",
  "function",
  "redactions",
  "generation_hints",
]);
const CONTEXT_REDACTION_KEYS = new Set([
  "field",
  "pattern",
  "replacement",
]);
const ROUTINE_KEYS = new Set([
  "id",
  "label",
  "description",
  "handler",
  "default_schedule",
  "config_schema",
  "default_config",
  "capabilities",
  "budget_defaults",
  "approval_policy",
  "surfaces",
]);
const ROUTINE_SCHEDULE_KEYS = new Set([
  "type",
  "every_seconds",
  "every_minutes",
  "timezone",
  "cron",
]);
const ROUTINE_CAPABILITY_KEYS = new Set([
  "app",
  "functions",
  "access",
  "required",
  "purpose",
]);
const ROUTINE_BUDGET_KEYS = new Set([
  "max_light_per_run",
  "max_light_per_day",
  "max_light_per_month",
  "max_calls_per_run",
]);
const ROUTINE_APPROVAL_KEYS = new Set([
  "require_user_approval",
  "require_paid_capability_approval",
  "require_external_side_effect_approval",
]);
const ROUTINE_SURFACE_KEYS = new Set([
  "widgets",
  "command_cards",
  "dashboard_key",
]);
const ROUTINE_COMMAND_CARD_KEYS = new Set(["widget_id", "card_id"]);
const ENV_VAR_KEYS = new Set([
  "description",
  "required",
  "default",
  "scope",
  "type",
  "label",
  "input",
  "placeholder",
  "help",
  "group",
  "credential",
]);
const CREDENTIAL_KEYS = new Set(["destination", "inject"]);
const CREDENTIAL_INJECT_KEYS = new Set([
  "as",
  "name",
  "prefix",
  "username_env",
]);
const HTTP_KEYS = new Set(["defaults", "routes"]);
const HTTP_ROUTE_KEYS = new Set([
  "auth",
  "methods",
  "cors",
  "rate_limit",
  "billing",
  "data_scope",
]);
const HTTP_CORS_KEYS = new Set([
  "origins",
  "credentials",
  "headers",
  "max_age_seconds",
]);
const HTTP_RATE_LIMIT_KEYS = new Set(["rpm", "burst", "daily"]);
const CALL_RATE_LIMIT_KEYS = new Set([
  "calls_per_minute",
  "calls_per_day",
]);
const NETWORK_KEYS = new Set(["allowed_destinations"]);
const NETWORK_DESTINATION_KEYS = new Set([
  "host",
  "label",
  "description",
]);
const COMPUTE_KEYS = new Set(["profile", "tools", "secrets"]);

const EFFECT_PERMISSION: Partial<Record<GalacticStableEffectId, string>> = {
  "storage.read": "storage:read",
  "storage.write": "storage:write",
  "storage.delete": "storage:delete",
  "memory.read": "memory:read",
  "memory.write": "memory:write",
  "notification.owner.write": "notify:owner",
  "inference.generate": "ai:call",
  "inference.embed": "ai:embed",
  "compute.execute": "compute:exec",
  "network.http": "net:fetch",
  "network.tcp": "net:connect",
  "credential.http": "net:fetch",
  "email.imap.read": "net:connect",
  "email.smtp.send": "net:connect",
  "agent.call": "app:call",
};

function fail(
  code: GalacticAgentDocumentErrorCode,
  path: string,
  detail: string,
): never {
  throw new GalacticAgentDocumentError(code, path, detail);
}

function pathForKey(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("GALACTIC_DOCUMENT_SCHEMA_ERROR", path, "must be an object");
  }
  return value;
}

function requireString(
  value: unknown,
  path: string,
  options: { nonEmpty?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    (options.nonEmpty && value.trim().length === 0)
  ) {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      path,
      options.nonEmpty ? "must be a non-empty string" : "must be a string",
    );
  }
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !EXTENSION_KEY_RE.test(key)) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        pathForKey(path, key),
        'is not a recognized v1alpha1 field; extension fields must start with "x-"',
      );
    }
  }
}

function assertOptionalObjectKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  if (isRecord(value)) assertKnownKeys(value, allowed, path);
}

function assertPresentObjectKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  if (value === undefined) return;
  assertKnownKeys(requireRecord(value, path), allowed, path);
}

function assertObjectArrayKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  visit?: (entry: Record<string, unknown>, path: string) => void,
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const entryPath = `${path}[${index}]`;
    assertKnownKeys(entry, allowed, entryPath);
    visit?.(entry, entryPath);
  });
}

function assertParameterShape(value: unknown, path: string): void {
  const parameter = requireRecord(value, path);
  assertKnownKeys(parameter, PARAMETER_KEYS, path);
  if (parameter.items !== undefined) {
    assertParameterShape(parameter.items, `${path}.items`);
  }
  if (parameter.properties !== undefined) {
    const properties = requireRecord(
      parameter.properties,
      `${path}.properties`,
    );
    for (const [name, property] of Object.entries(properties)) {
      assertParameterShape(property, `${path}.properties.${name}`);
    }
  }
}

function assertParameterMap(value: unknown, path: string): void {
  if (value === undefined) return;
  const parameters = requireRecord(value, path);
  for (const [name, parameter] of Object.entries(parameters)) {
    assertParameterShape(parameter, `${path}.${name}`);
  }
}

function assertGenerationHintsShape(value: unknown, path: string): void {
  if (!isRecord(value)) return;
  assertKnownKeys(value, GENERATION_HINT_KEYS, path);
  assertObjectArrayKeys(
    value.suggested_components,
    GENERATION_COMPONENT_KEYS,
    `${path}.suggested_components`,
  );
}

function assertDependencyArray(value: unknown, path: string): void {
  assertObjectArrayKeys(value, DEPENDENCY_KEYS, path);
}

function assertWidgetActionShape(
  value: Record<string, unknown>,
  path: string,
): void {
  assertOptionalObjectKeys(value.mcp, WIDGET_ACTION_MCP_KEYS, `${path}.mcp`);
  assertOptionalObjectKeys(value.ui, WIDGET_ACTION_UI_KEYS, `${path}.ui`);
  assertGenerationHintsShape(
    value.generation_hints,
    `${path}.generation_hints`,
  );
}

function assertWidgetShape(
  value: Record<string, unknown>,
  path: string,
): void {
  assertDependencyArray(value.dependencies, `${path}.dependencies`);
  assertObjectArrayKeys(
    value.cards,
    COMMAND_CARD_KEYS,
    `${path}.cards`,
    (card, cardPath) => {
      assertDependencyArray(card.dependencies, `${cardPath}.dependencies`);
      assertGenerationHintsShape(
        card.generation_hints,
        `${cardPath}.generation_hints`,
      );
    },
  );
  assertObjectArrayKeys(
    value.agent_actions,
    WIDGET_ACTION_KEYS,
    `${path}.agent_actions`,
    assertWidgetActionShape,
  );
  assertGenerationHintsShape(
    value.generation_hints,
    `${path}.generation_hints`,
  );
}

function assertRoutineShape(
  value: Record<string, unknown>,
  path: string,
): void {
  assertOptionalObjectKeys(
    value.default_schedule,
    ROUTINE_SCHEDULE_KEYS,
    `${path}.default_schedule`,
  );
  if (isRecord(value.config_schema)) {
    for (const [name, parameter] of Object.entries(value.config_schema)) {
      assertParameterShape(parameter, `${path}.config_schema.${name}`);
    }
  }
  assertObjectArrayKeys(
    value.capabilities,
    ROUTINE_CAPABILITY_KEYS,
    `${path}.capabilities`,
  );
  assertOptionalObjectKeys(
    value.budget_defaults,
    ROUTINE_BUDGET_KEYS,
    `${path}.budget_defaults`,
  );
  assertOptionalObjectKeys(
    value.approval_policy,
    ROUTINE_APPROVAL_KEYS,
    `${path}.approval_policy`,
  );
  if (isRecord(value.surfaces)) {
    assertKnownKeys(value.surfaces, ROUTINE_SURFACE_KEYS, `${path}.surfaces`);
    assertObjectArrayKeys(
      value.surfaces.command_cards,
      ROUTINE_COMMAND_CARD_KEYS,
      `${path}.surfaces.command_cards`,
    );
  }
}

function assertHttpRouteShape(value: unknown, path: string): void {
  if (!isRecord(value)) return;
  assertKnownKeys(value, HTTP_ROUTE_KEYS, path);
  assertOptionalObjectKeys(value.cors, HTTP_CORS_KEYS, `${path}.cors`);
  assertOptionalObjectKeys(
    value.rate_limit,
    HTTP_RATE_LIMIT_KEYS,
    `${path}.rate_limit`,
  );
}

function assertStrictSpecShapes(spec: Record<string, unknown>): void {
  assertOptionalObjectKeys(spec.entry, ENTRY_KEYS, "spec.entry");

  if (isRecord(spec.operator_errors)) {
    for (const [code, declaration] of Object.entries(spec.operator_errors)) {
      assertOptionalObjectKeys(
        declaration,
        OPERATOR_ERROR_KEYS,
        `spec.operator_errors.${code}`,
      );
    }
  }
  assertOptionalObjectKeys(
    spec.access_policy,
    ACCESS_POLICY_KEYS,
    "spec.access_policy",
  );
  assertObjectArrayKeys(
    spec.external_functions,
    DEPENDENCY_KEYS,
    "spec.external_functions",
  );

  if (isRecord(spec.imports)) {
    for (const [name, declaration] of Object.entries(spec.imports)) {
      assertOptionalObjectKeys(
        declaration,
        IMPORT_KEYS,
        `spec.imports.${name}`,
      );
    }
  }

  assertObjectArrayKeys(
    spec.interfaces,
    INTERFACE_KEYS,
    "spec.interfaces",
    (declaration, path) => {
      if (isRecord(declaration.read_models)) {
        for (
          const [name, readModel] of Object.entries(declaration.read_models)
        ) {
          assertOptionalObjectKeys(
            readModel,
            INTERFACE_READ_MODEL_KEYS,
            `${path}.read_models.${name}`,
          );
        }
      }
    },
  );
  assertObjectArrayKeys(
    spec.widgets,
    WIDGET_KEYS,
    "spec.widgets",
    assertWidgetShape,
  );
  assertObjectArrayKeys(
    spec.context_sources,
    CONTEXT_SOURCE_KEYS,
    "spec.context_sources",
    (source, path) => {
      assertObjectArrayKeys(
        source.redactions,
        CONTEXT_REDACTION_KEYS,
        `${path}.redactions`,
      );
      assertGenerationHintsShape(
        source.generation_hints,
        `${path}.generation_hints`,
      );
    },
  );
  assertObjectArrayKeys(
    spec.routines,
    ROUTINE_KEYS,
    "spec.routines",
    assertRoutineShape,
  );

  if (isRecord(spec.env_vars)) {
    const normalizedEnvVars = normalizeManifestEnvVars(spec.env_vars) ?? {};
    for (const [key, declaration] of Object.entries(spec.env_vars)) {
      if (!isRecord(declaration)) continue;
      const path = `spec.env_vars.${key}`;
      assertKnownKeys(declaration, ENV_VAR_KEYS, path);
      const normalizedDeclaration = normalizedEnvVars[key];
      if (
        declaration.default !== undefined &&
        (
          declaration.credential !== undefined ||
          normalizedDeclaration?.credential !== undefined ||
          normalizedDeclaration?.input === "password"
        )
      ) {
        fail(
          "GALACTIC_DOCUMENT_SCHEMA_ERROR",
          `${path}.default`,
          "password and credential variables cannot contain authored defaults",
        );
      }
      if (isRecord(declaration.credential)) {
        assertKnownKeys(
          declaration.credential,
          CREDENTIAL_KEYS,
          `${path}.credential`,
        );
        if (isRecord(declaration.credential.inject)) {
          const inject = declaration.credential.inject;
          const allowed = inject.as === "bearer"
            ? new Set(["as"])
            : inject.as === "header"
            ? new Set(["as", "name", "prefix"])
            : inject.as === "basic"
            ? new Set(["as", "username_env"])
            : inject.as === "query"
            ? new Set(["as", "name"])
            : CREDENTIAL_INJECT_KEYS;
          assertKnownKeys(inject, allowed, `${path}.credential.inject`);
        }
      }
    }
  }

  if (isRecord(spec.http)) {
    assertKnownKeys(spec.http, HTTP_KEYS, "spec.http");
    assertHttpRouteShape(spec.http.defaults, "spec.http.defaults");
    if (isRecord(spec.http.routes)) {
      for (const [name, route] of Object.entries(spec.http.routes)) {
        assertHttpRouteShape(route, `spec.http.routes.${name}`);
      }
    }
  }
  assertOptionalObjectKeys(
    spec.rate_limit,
    CALL_RATE_LIMIT_KEYS,
    "spec.rate_limit",
  );
  if (isRecord(spec.network)) {
    assertKnownKeys(spec.network, NETWORK_KEYS, "spec.network");
    assertObjectArrayKeys(
      spec.network.allowed_destinations,
      NETWORK_DESTINATION_KEYS,
      "spec.network.allowed_destinations",
    );
  }
  assertOptionalObjectKeys(spec.compute, COMPUTE_KEYS, "spec.compute");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

interface AstState {
  nodes: number;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function inspectAstNode(
  node: Node | null,
  path: string,
  depth: number,
  state: AstState,
): JsonValue {
  if (depth > MAX_DOCUMENT_DEPTH) {
    fail(
      "GALACTIC_DOCUMENT_UNSAFE_YAML",
      path,
      `nesting exceeds ${MAX_DOCUMENT_DEPTH} levels`,
    );
  }
  if (node === null) return null;

  state.nodes += 1;
  if (state.nodes > MAX_DOCUMENT_NODES) {
    fail(
      "GALACTIC_DOCUMENT_UNSAFE_YAML",
      path,
      `document exceeds ${MAX_DOCUMENT_NODES} YAML nodes`,
    );
  }
  if (isAlias(node)) {
    fail(
      "GALACTIC_DOCUMENT_UNSAFE_YAML",
      path,
      "aliases are not allowed",
    );
  }
  if ("anchor" in node && typeof node.anchor === "string") {
    fail(
      "GALACTIC_DOCUMENT_UNSAFE_YAML",
      path,
      "anchors are not allowed",
    );
  }
  if (typeof node.tag === "string") {
    fail(
      "GALACTIC_DOCUMENT_UNSAFE_YAML",
      path,
      "explicit YAML tags are not allowed",
    );
  }

  if (isScalar(node)) {
    const value = node.value;
    if (typeof value === "string") {
      if (containsLoneSurrogate(value)) {
        fail(
          "GALACTIC_DOCUMENT_UNSAFE_YAML",
          path,
          "strings must contain valid Unicode scalar values",
        );
      }
      return value;
    }
    if (value === null || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return Object.is(value, -0) ? 0 : value;
    }
    fail(
      "GALACTIC_DOCUMENT_UNSAFE_YAML",
      path,
      "scalars must be strings, booleans, finite numbers, or null",
    );
  }

  if (isSeq(node)) {
    return node.items.map((item, index) =>
      inspectAstNode(item as Node | null, `${path}[${index}]`, depth + 1, state)
    );
  }

  if (isMap(node)) {
    const result = Object.create(null) as JsonObject;
    const seen = new Set<string>();
    for (const pair of node.items) {
      const keyPath = path ? `${path}.[key]` : "[key]";
      const keyValue = inspectAstNode(
        pair.key as Node | null,
        keyPath,
        depth + 1,
        state,
      );
      if (typeof keyValue !== "string") {
        fail(
          "GALACTIC_DOCUMENT_UNSAFE_YAML",
          keyPath,
          "mapping keys must be strings",
        );
      }
      if (keyValue === "<<") {
        fail(
          "GALACTIC_DOCUMENT_UNSAFE_YAML",
          pathForKey(path, keyValue),
          "merge keys are not allowed",
        );
      }
      if (seen.has(keyValue)) {
        fail(
          "GALACTIC_DOCUMENT_UNSAFE_YAML",
          pathForKey(path, keyValue),
          "duplicate mapping key",
        );
      }
      seen.add(keyValue);
      result[keyValue] = inspectAstNode(
        pair.value as Node | null,
        pathForKey(path, keyValue),
        depth + 1,
        state,
      );
    }
    return result;
  }

  fail(
    "GALACTIC_DOCUMENT_UNSAFE_YAML",
    path,
    "unsupported YAML node",
  );
}

function parseStrictYaml(source: string): JsonObject {
  const byteLength = new TextEncoder().encode(source).byteLength;
  if (byteLength > MAX_DOCUMENT_BYTES) {
    fail(
      "GALACTIC_DOCUMENT_TOO_LARGE",
      "$",
      `galactic.yaml is ${byteLength} bytes; maximum is ${MAX_DOCUMENT_BYTES}`,
    );
  }

  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseYamlDocuments(source);
  } catch {
    fail(
      "GALACTIC_DOCUMENT_PARSE_ERROR",
      "$",
      "galactic.yaml is not valid YAML 1.2",
    );
  }

  if (documents.length !== 1) {
    fail(
      "GALACTIC_DOCUMENT_PARSE_ERROR",
      "$",
      "galactic.yaml must contain exactly one YAML document",
    );
  }
  const document = documents[0];
  if (document.errors.length > 0 || document.warnings.length > 0) {
    fail(
      "GALACTIC_DOCUMENT_PARSE_ERROR",
      "$",
      "galactic.yaml is not valid strict YAML 1.2",
    );
  }

  const parsed = inspectAstNode(document.contents, "$", 0, { nodes: 0 });
  if (!isRecord(parsed)) {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      "$",
      "galactic.yaml must contain an object",
    );
  }
  return parsed as JsonObject;
}

const STRICT_YAML_OPTIONS = {
  version: "1.2",
  schema: "core",
  strict: true,
  uniqueKeys: true,
  stringKeys: true,
  merge: false,
  resolveKnownTags: false,
} as const;

function parseYamlDocuments(
  source: string,
): ReturnType<typeof parseAllDocuments> {
  try {
    return parseAllDocuments(source, STRICT_YAML_OPTIONS);
  } catch (error) {
    // yaml@2.8.3's Node build consults process.env.LOG_TOKENS in Parser.next()
    // even though it is only a debugging switch. Deno correctly denies that
    // undeclared read in permission-minimal tests. Retry synchronously with an
    // empty process environment; no other task can interleave before restore.
    if (
      !(error instanceof Error) ||
      error.name !== "NotCapable" ||
      !error.message.includes('"LOG_TOKENS"')
    ) {
      throw error;
    }

    const runtimeProcess = (
      globalThis as typeof globalThis & {
        process?: Record<string, unknown>;
      }
    ).process;
    if (!runtimeProcess) throw error;
    const descriptor = Object.getOwnPropertyDescriptor(runtimeProcess, "env");
    if (!descriptor) throw error;
    Object.defineProperty(runtimeProcess, "env", {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      writable: true,
      value: Object.create(null),
    });
    try {
      return parseAllDocuments(source, STRICT_YAML_OPTIONS);
    } finally {
      Object.defineProperty(runtimeProcess, "env", descriptor);
    }
  }
}

function normalizePolicy(value: unknown, path: string): GalacticEffectPolicy {
  if (value !== "ask" && value !== "free") {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      path,
      'must be "ask" or "free"',
    );
  }
  return value;
}

function normalizeAuthority(
  value: unknown,
  path: string,
): GalacticFunctionAuthority {
  const authority = requireRecord(value, path);
  assertKnownKeys(authority, AUTHORITY_KEYS, path);

  const level = authority.level;
  if (
    level !== "read" && level !== "internal_write" &&
    level !== "external_write"
  ) {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      `${path}.level`,
      'must be "read", "internal_write", or "external_write"',
    );
  }

  const rawEffects = requireRecord(authority.effects, `${path}.effects`);
  const effects = Object.create(null) as Record<
    GalacticEffectId,
    GalacticEffectPolicy
  >;
  for (const [effect, policy] of Object.entries(rawEffects)) {
    if (!STABLE_EFFECT_SET.has(effect) && !EXTENSION_KEY_RE.test(effect)) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.effects.${effect}`,
        'is not a recognized effect ID; extension effects must start with "x-"',
      );
    }
    effects[effect as GalacticEffectId] = normalizePolicy(
      policy,
      `${path}.effects.${effect}`,
    );
  }
  const minimumLevel = minimumGalacticAuthorityLevel(Object.keys(effects));
  if (!galacticAuthorityLevelCoversEffects(level, Object.keys(effects))) {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      `${path}.level`,
      `understates the declared stable effects; must be at least "${minimumLevel}"`,
    );
  }

  return {
    ...cloneJson(authority),
    level,
    effects,
  } as GalacticFunctionAuthority;
}

function normalizeSpend(
  value: unknown,
  authority: GalacticFunctionAuthority,
  path: string,
): GalacticFunctionSpend {
  const spend = requireRecord(value, path);
  assertKnownKeys(spend, SPEND_KEYS, path);
  const normalized: GalacticFunctionSpend = cloneJson(spend);

  if (spend.inference !== undefined) {
    normalized.inference = normalizePolicy(
      spend.inference,
      `${path}.inference`,
    );
    if (
      authority.effects["inference.generate"] === undefined &&
      authority.effects["inference.embed"] === undefined
    ) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.inference`,
        "requires inference.generate or inference.embed authority",
      );
    }
  }
  if (spend.compute !== undefined) {
    normalized.compute = normalizePolicy(spend.compute, `${path}.compute`);
    if (authority.effects["compute.execute"] === undefined) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.compute`,
        "requires compute.execute authority",
      );
    }
  }
  return normalized;
}

function normalizeFunctions(
  value: unknown,
): Record<string, GalacticAgentFunction> {
  const functions = requireRecord(value, "spec.functions");
  const normalized = Object.create(null) as Record<
    string,
    GalacticAgentFunction
  >;

  for (const [name, rawValue] of Object.entries(functions)) {
    if (!FUNCTION_NAME_RE.test(name)) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `spec.functions.${name}`,
        "function names must start with an ASCII letter and contain at most 64 ASCII letters, numbers, or underscores",
      );
    }
    const path = `spec.functions.${name}`;
    const fn = requireRecord(rawValue, path);
    assertKnownKeys(fn, FUNCTION_KEYS, path);
    assertParameterMap(fn.parameters, `${path}.parameters`);
    assertPresentObjectKeys(fn.returns, RETURN_KEYS, `${path}.returns`);
    assertPresentObjectKeys(
      fn.annotations,
      ANNOTATION_KEYS,
      `${path}.annotations`,
    );
    assertGenerationHintsShape(
      fn.generation_hints,
      `${path}.generation_hints`,
    );
    assertPresentObjectKeys(
      fn.execution,
      EXECUTION_KEYS,
      `${path}.execution`,
    );
    requireString(fn.description, `${path}.description`, { nonEmpty: true });
    if (fn.authority === undefined) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.authority`,
        "is required",
      );
    }

    const authority = normalizeAuthority(fn.authority, `${path}.authority`);
    const spend = fn.spend === undefined
      ? undefined
      : normalizeSpend(fn.spend, authority, `${path}.spend`);
    normalized[name] = {
      ...cloneJson(fn),
      authority,
      ...(spend ? { spend } : {}),
    } as GalacticAgentFunction;
  }
  return normalized;
}

function normalizeFixtureEnv(
  value: unknown,
  path: string,
): Record<string, string> {
  const env = requireRecord(value, path);
  const normalized: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(env)) {
    if (!key.trim() || typeof envValue !== "string") {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.${key}`,
        "fixture environment keys must be non-empty and values must be strings",
      );
    }
    normalized[key] = envValue;
  }
  return normalized;
}

function assertFixtureEnvDeclarations(
  fixtureEnv: Record<string, string>,
  declaredEnvVars: Record<string, unknown>,
  path: string,
): void {
  const normalizedEnvVars = normalizeManifestEnvVars(declaredEnvVars) ?? {};
  for (const key of Object.keys(fixtureEnv)) {
    const declaration = Object.hasOwn(declaredEnvVars, key)
      ? declaredEnvVars[key]
      : undefined;
    const normalizedDeclaration = normalizedEnvVars[key];
    if (!isRecord(declaration) || !normalizedDeclaration) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.${key}`,
        `must reference an ordinary variable declared at spec.env_vars.${key}`,
      );
    }
    if (
      declaration.credential !== undefined ||
      normalizedDeclaration.credential !== undefined ||
      normalizedDeclaration.input === "password"
    ) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.${key}`,
        "cannot provide fixture values for password or credential variables",
      );
    }
  }
}

function normalizeCases(
  value: unknown,
  functions: Record<string, GalacticAgentFunction>,
  declaredEnvVars: Record<string, unknown>,
): NormalizedGalacticConformanceCase[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      "spec.conformance.cases",
      "must contain between 1 and 16 cases",
    );
  }

  const ids = new Set<string>();
  let requiredCount = 0;
  const cases = value.map((rawValue, index) => {
    const path = `spec.conformance.cases[${index}]`;
    const testCase = requireRecord(rawValue, path);
    assertKnownKeys(testCase, CASE_KEYS, path);
    const id = requireString(testCase.id, `${path}.id`, { nonEmpty: true });
    if (!CASE_ID_RE.test(id)) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.id`,
        'must begin with a letter and contain at most 64 letters, numbers, ".", "_", or "-"',
      );
    }
    if (ids.has(id)) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.id`,
        `duplicates conformance case "${id}"`,
      );
    }
    ids.add(id);

    const functionName = requireString(
      testCase.function,
      `${path}.function`,
      { nonEmpty: true },
    );
    if (!functions[functionName]) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.function`,
        `references undeclared function "${functionName}"`,
      );
    }

    let input: Record<string, unknown> | undefined;
    if (testCase.input !== undefined) {
      input = requireRecord(testCase.input, `${path}.input`);
    }

    let fixtures: GalacticConformanceFixtures | undefined;
    if (testCase.fixtures !== undefined) {
      const rawFixtures = requireRecord(
        testCase.fixtures,
        `${path}.fixtures`,
      );
      assertKnownKeys(rawFixtures, FIXTURE_KEYS, `${path}.fixtures`);
      fixtures = cloneJson(rawFixtures) as GalacticConformanceFixtures;
      if (rawFixtures.env !== undefined) {
        const fixtureEnv = normalizeFixtureEnv(
          rawFixtures.env,
          `${path}.fixtures.env`,
        );
        assertFixtureEnvDeclarations(
          fixtureEnv,
          declaredEnvVars,
          `${path}.fixtures.env`,
        );
        fixtures.env = fixtureEnv;
      }
      if (rawFixtures.database !== undefined) {
        try {
          const database = resolveD1TestFixtureConfig(
            rawFixtures.database,
            { strictUnknownKeys: true },
          );
          if (database) fixtures.database = database;
        } catch (error) {
          fail(
            "GALACTIC_DOCUMENT_SCHEMA_ERROR",
            `${path}.fixtures.database`,
            error instanceof Error ? error.message : "is invalid",
          );
        }
      }
      if (rawFixtures.http !== undefined) {
        try {
          const http = resolveHttpTestFixtureConfig(rawFixtures.http);
          if (http) fixtures.http = http;
        } catch (error) {
          fail(
            "GALACTIC_DOCUMENT_SCHEMA_ERROR",
            `${path}.fixtures.http`,
            error instanceof Error ? error.message : "is invalid",
          );
        }
      }
    }

    if (
      testCase.required !== undefined &&
      typeof testCase.required !== "boolean"
    ) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        `${path}.required`,
        "must be a boolean",
      );
    }
    const required = testCase.required ?? true;
    if (required) requiredCount += 1;

    return {
      ...cloneJson(testCase),
      id,
      function: functionName,
      ...(input ? { input } : {}),
      ...(fixtures ? { fixtures } : {}),
      required,
    } as NormalizedGalacticConformanceCase;
  });

  if (requiredCount === 0) {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      "spec.conformance.cases",
      "must include at least one required case",
    );
  }
  return cases;
}

function normalizeDocument(parsed: JsonObject): GalacticAgentDocument {
  const root = parsed as Record<string, unknown>;
  assertKnownKeys(root, ROOT_KEYS, "$");
  if (root.apiVersion !== GALACTIC_AGENT_API_VERSION) {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      "apiVersion",
      `must be "${GALACTIC_AGENT_API_VERSION}"`,
    );
  }
  if (root.kind !== GALACTIC_AGENT_KIND) {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      "kind",
      `must be "${GALACTIC_AGENT_KIND}"`,
    );
  }

  const metadata = requireRecord(root.metadata, "metadata");
  assertKnownKeys(metadata, METADATA_KEYS, "metadata");
  requireString(metadata.name, "metadata.name", { nonEmpty: true });
  requireString(metadata.version, "metadata.version", { nonEmpty: true });
  for (const optional of ["description", "author", "icon"]) {
    if (metadata[optional] !== undefined) {
      requireString(metadata[optional], `metadata.${optional}`);
    }
  }
  if (metadata.parentReleaseDigest !== undefined) {
    const digest = requireString(
      metadata.parentReleaseDigest,
      "metadata.parentReleaseDigest",
    );
    if (!PARENT_RELEASE_DIGEST_RE.test(digest)) {
      fail(
        "GALACTIC_DOCUMENT_SCHEMA_ERROR",
        "metadata.parentReleaseDigest",
        "must be a lowercase 64-character SHA-256 hex digest",
      );
    }
  }

  const spec = requireRecord(root.spec, "spec");
  assertKnownKeys(spec, SPEC_KEYS, "spec");
  assertStrictSpecShapes(spec);
  const functions = normalizeFunctions(spec.functions);
  const conformance = requireRecord(spec.conformance, "spec.conformance");
  assertKnownKeys(conformance, CONFORMANCE_KEYS, "spec.conformance");
  if (conformance.profile !== "basic") {
    fail(
      "GALACTIC_DOCUMENT_SCHEMA_ERROR",
      "spec.conformance.profile",
      'must be "basic"',
    );
  }
  const cases = normalizeCases(
    conformance.cases,
    functions,
    isRecord(spec.env_vars) ? spec.env_vars : {},
  );

  return {
    ...cloneJson(root),
    apiVersion: GALACTIC_AGENT_API_VERSION,
    kind: GALACTIC_AGENT_KIND,
    metadata: cloneJson(metadata) as unknown as GalacticAgentMetadata,
    spec: {
      ...cloneJson(spec),
      functions,
      conformance: {
        ...cloneJson(conformance),
        profile: "basic",
        cases,
      },
    } as GalacticAgentSpec,
  };
}

function compileDocument(
  document: GalacticAgentDocument,
): {
  manifest: CompiledGalacticManifest;
  effects: GalacticEffectId[];
  effectsByFunction: Record<string, GalacticEffectId[]>;
} {
  const permissions = new Set<string>();
  const effects = new Set<GalacticEffectId>();
  const effectsByFunction: Record<string, GalacticEffectId[]> = {};
  let flightRecorder = false;
  const compiledFunctions: Record<string, CompiledGalacticFunction> = {};

  for (
    const [name, authoredFunction] of Object.entries(document.spec.functions)
  ) {
    const functionEffects = Object.keys(authoredFunction.authority.effects)
      .sort() as GalacticEffectId[];
    effectsByFunction[name] = functionEffects;
    let usesInference = false;
    let usesCompute = false;

    for (const effect of functionEffects) {
      effects.add(effect);
      const permission = STABLE_EFFECT_SET.has(effect)
        ? EFFECT_PERMISSION[effect as GalacticStableEffectId]
        : undefined;
      if (permission) permissions.add(permission);
      if (
        effect === "inference.generate" || effect === "inference.embed"
      ) {
        usesInference = true;
      }
      if (effect === "compute.execute") usesCompute = true;
      if (effect === "routine.read") flightRecorder = true;
    }

    compiledFunctions[name] = {
      ...cloneJson(authoredFunction),
      ...(usesInference ? { uses_inference: true } : {}),
      ...(usesCompute ? { uses_compute: true } : {}),
    } as CompiledGalacticFunction;
  }

  const { metadata, spec } = document;
  const rawManifest: Record<string, unknown> = {
    name: metadata.name,
    version: metadata.version,
    ...(metadata.description !== undefined
      ? { description: metadata.description }
      : {}),
    ...(metadata.author !== undefined ? { author: metadata.author } : {}),
    ...(metadata.icon !== undefined ? { icon: metadata.icon } : {}),
    type: "mcp",
    entry: cloneJson(spec.entry ?? { functions: "index.ts" }),
    functions: compiledFunctions,
  };

  const copiedSpecFields = [
    "operator_errors",
    "access_policy",
    "external_functions",
    "imports",
    "emits",
    "interfaces",
    "widgets",
    "context_sources",
    "routines",
    "env_vars",
    "http",
    "rate_limit",
    "network",
    "compute",
  ] as const;
  for (const field of copiedSpecFields) {
    if (spec[field] !== undefined) rawManifest[field] = cloneJson(spec[field]);
  }
  for (const [key, value] of Object.entries(spec)) {
    if (EXTENSION_KEY_RE.test(key)) rawManifest[key] = cloneJson(value);
  }
  if (metadata.parentReleaseDigest !== undefined) {
    rawManifest["x-galactic-parent-release-digest"] =
      metadata.parentReleaseDigest;
  }
  if (permissions.size > 0) rawManifest.permissions = [...permissions].sort();
  if (flightRecorder) rawManifest.flight_recorder = true;

  const validationInput = cloneJson(rawManifest);
  const validation = validateManifest(validationInput);
  if (!validation.valid || !validation.manifest) {
    const first = validation.errors[0];
    fail(
      "GALACTIC_MANIFEST_INVALID",
      first?.path ? `spec.${first.path}` : "spec",
      validation.errors.map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ") || "compiled manifest is invalid",
    );
  }

  return {
    manifest: validation.manifest as CompiledGalacticManifest,
    effects: [...effects].sort(),
    effectsByFunction,
  };
}

export async function compileGalacticAgentYaml(
  source: string,
): Promise<GalacticAgentDocumentResolution> {
  const parsed = parseStrictYaml(source);
  const document = normalizeDocument(parsed);
  const normalizedJson = canonicalJson(document);
  const compiled = compileDocument(document);
  return {
    sourceKind: "galactic_yaml",
    compiledManifest: compiled.manifest,
    document,
    normalizedJson,
    documentDigest: await sha256Hex(normalizedJson),
    cases: document.spec.conformance.cases,
    functions: Object.keys(document.spec.functions).sort(),
    effects: compiled.effects,
    effectsByFunction: compiled.effectsByFunction,
  };
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export async function resolveGalacticAgentDocument(
  files: SourceFile[],
): Promise<GalacticAgentDocumentResolution | null> {
  const rootDocuments = files.filter((file) => file.path === "galactic.yaml");
  const nestedDocuments = files.filter((file) =>
    file.path !== "galactic.yaml" && basename(file.path) === "galactic.yaml"
  );
  if (rootDocuments.length === 0 && nestedDocuments.length > 0) {
    fail(
      "GALACTIC_DOCUMENT_NOT_ROOT",
      nestedDocuments[0].path,
      "galactic.yaml must be at the exact project root",
    );
  }
  if (rootDocuments.length > 1 || nestedDocuments.length > 0) {
    fail(
      "GALACTIC_DOCUMENT_AMBIGUOUS",
      "galactic.yaml",
      "exactly one root galactic.yaml is allowed",
    );
  }

  const manifests = files.filter((file) =>
    basename(file.path) === "manifest.json"
  );
  if (rootDocuments.length === 1) {
    if (manifests.length > 0) {
      fail(
        "GALACTIC_DOCUMENT_AMBIGUOUS",
        manifests[0].path,
        "do not author manifest.json alongside galactic.yaml; Galactic compiles it",
      );
    }
    return await compileGalacticAgentYaml(rootDocuments[0].content);
  }

  const manifestFile = manifests[0];
  if (!manifestFile) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestFile.content);
  } catch {
    fail(
      "GALACTIC_MANIFEST_PARSE_ERROR",
      manifestFile.path,
      "manifest.json is not valid JSON",
    );
  }
  const validationInput = cloneJson(parsed);
  const validation = validateManifest(validationInput);
  if (!validation.valid || !validation.manifest) {
    const first = validation.errors[0];
    fail(
      "GALACTIC_MANIFEST_INVALID",
      first?.path ? `${manifestFile.path}.${first.path}` : manifestFile.path,
      validation.errors.map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ") || "manifest.json is invalid",
    );
  }

  const normalizedJson = canonicalJson(validation.manifest);
  const functions = Object.keys(validation.manifest.functions ?? {}).sort();
  return {
    sourceKind: "legacy_manifest",
    compiledManifest: validation.manifest,
    document: null,
    normalizedJson,
    documentDigest: await sha256Hex(normalizedJson),
    cases: [],
    functions,
    effects: [],
    effectsByFunction: Object.fromEntries(
      functions.map((name) => [name, []]),
    ),
  };
}
