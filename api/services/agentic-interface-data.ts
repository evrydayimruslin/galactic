import {
  type AgenticCommandCardDataBinding,
  type AgenticContextSourceDataBinding,
  type AgenticInterfaceDataBinding,
  type AgenticInterfaceSpec,
  type AgenticMcpReadFunctionDataBinding,
  validateAgenticInterfaceSpec,
} from "../../shared/contracts/agentic-interface.ts";
import {
  readContextSourceRows as defaultReadContextSourceRows,
  type ContextSourceRowsOptions,
  type ContextSourceRowsResult,
} from "./app-context-magnifier.ts";
import {
  getCommandSurfaceInventory as defaultGetCommandSurfaceInventory,
  type CommandSurfaceInventory,
} from "./command-surfaces.ts";
import {
  type FunctionIndex,
  getOrRebuildFunctionIndex as defaultGetOrRebuildFunctionIndex,
} from "./function-index.ts";
import { verifyAgenticInterfaceSpec } from "./agentic-interface-validate.ts";

export interface AgenticInterfaceDataRequest {
  spec?: unknown;
  binding_ids?: unknown;
  query?: unknown;
  max_rows_per_binding?: unknown;
}

export interface AgenticInterfaceBindingData {
  binding_id: string;
  source: AgenticInterfaceDataBinding["source"];
  label?: string;
  status: "ok" | "error" | "skipped";
  data: unknown;
  raw?: unknown;
  row_count?: number;
  refreshed_at: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgenticInterfaceDataResult {
  spec_id: string;
  title: string;
  bindings: Record<string, AgenticInterfaceBindingData>;
  binding_order: string[];
  errors: string[];
  row_count: number;
  refreshed_at: string;
}

export interface AgenticInterfaceDataDependencies {
  getFunctionIndex?: (userId: string) => Promise<FunctionIndex>;
  getCommandSurfaceInventory?: (userId: string) => Promise<CommandSurfaceInventory>;
  readContextSourceRows?: (
    source: FunctionIndex["contextSources"][number],
    options: ContextSourceRowsOptions,
  ) => Promise<ContextSourceRowsResult>;
  executeAppFunction?: (
    input: {
      appId: string;
      appSlug?: string;
      functionName: string;
      args?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  now?: () => Date;
}

const DEFAULT_MAX_ROWS_PER_BINDING = 12;
const MAX_ROWS_PER_BINDING = 30;
const MAX_RAW_CHARS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0
        )
        .map((entry) => entry.trim()),
    ),
  ];
}

function maxRows(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_ROWS_PER_BINDING;
  }
  return Math.max(1, Math.min(MAX_ROWS_PER_BINDING, Math.floor(value)));
}

function compactRaw(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (!text || text.length <= MAX_RAW_CHARS) return value;
    return {
      truncated: true,
      preview: `${text.slice(0, MAX_RAW_CHARS)}...`,
    };
  } catch {
    return undefined;
  }
}

function parseMcpPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const content = value.content;
  if (!Array.isArray(content)) return value;
  const text = content.find((entry) =>
    isRecord(entry) && entry.type === "text" && typeof entry.text === "string"
  ) as { text?: string } | undefined;
  if (!text?.text) return value;
  try {
    return JSON.parse(text.text);
  } catch {
    return text.text;
  }
}

function normalizePayload(value: unknown): unknown {
  const payload = parseMcpPayload(value);
  if (!isRecord(payload)) return payload;
  if (payload.body !== undefined) return payload.body;
  if (payload.data !== undefined) return payload.data;
  if (payload.result !== undefined) return payload.result;
  return payload;
}

function buildToolName(appSlug: string | undefined, functionName: string): string {
  return appSlug ? `${appSlug}_${functionName}` : functionName;
}

function findContextSource(
  fnIndex: FunctionIndex,
  binding: AgenticContextSourceDataBinding,
): FunctionIndex["contextSources"][number] | null {
  return (fnIndex.contextSources || []).find((source) =>
    source.id === binding.context_source_id &&
    source.appId === binding.app_id &&
    (!binding.app_slug || source.appSlug === binding.app_slug)
  ) ?? null;
}

async function resolveCommandCardBinding(
  binding: AgenticCommandCardDataBinding,
  deps: Required<Pick<AgenticInterfaceDataDependencies, "executeAppFunction">>,
): Promise<{ data: unknown; raw: unknown; rowCount?: number }> {
  const functionName = binding.data_function || `widget_${binding.widget_id}_data`;
  const raw = await deps.executeAppFunction({
    appId: binding.app_id,
    appSlug: binding.app_slug,
    functionName: buildToolName(binding.app_slug, functionName),
    args: {
      card_id: binding.card_id,
      data_view: binding.data_view || binding.card_id,
    },
  });
  const data = normalizePayload(raw);
  const rowCount = Array.isArray(data)
    ? data.length
    : isRecord(data) && Array.isArray(data.items)
    ? data.items.length
    : undefined;
  return { data, raw, rowCount };
}

async function resolveMcpReadBinding(
  binding: AgenticMcpReadFunctionDataBinding,
  deps: Required<Pick<AgenticInterfaceDataDependencies, "executeAppFunction">>,
): Promise<{ data: unknown; raw: unknown; rowCount?: number }> {
  const raw = await deps.executeAppFunction({
    appId: binding.app_id,
    appSlug: binding.app_slug,
    functionName: buildToolName(binding.app_slug, binding.function_name),
    args: binding.args || {},
  });
  const data = normalizePayload(raw);
  const rowCount = Array.isArray(data)
    ? data.length
    : isRecord(data) && Array.isArray(data.items)
    ? data.items.length
    : undefined;
  return { data, raw, rowCount };
}

export async function resolveAgenticInterfaceData(
  userId: string,
  input: AgenticInterfaceDataRequest,
  dependencies: AgenticInterfaceDataDependencies = {},
): Promise<AgenticInterfaceDataResult> {
  const validation = validateAgenticInterfaceSpec(input.spec);
  if (!validation.valid || !validation.spec) {
    throw new Error(
      validation.errors[0]?.message || "Invalid agentic interface spec",
    );
  }

  const spec = validation.spec as AgenticInterfaceSpec;
  const now = dependencies.now || (() => new Date());
  const refreshedAt = now().toISOString();
  const requestedIds = new Set(stringList(input.binding_ids));
  const query = typeof input.query === "string" ? input.query : spec.intent || spec.title;
  const rowLimit = maxRows(input.max_rows_per_binding);
  const fnIndex = await (dependencies.getFunctionIndex || defaultGetOrRebuildFunctionIndex)(
    userId,
  );
  const inventory = await (dependencies.getCommandSurfaceInventory ||
    defaultGetCommandSurfaceInventory)(userId);
  const verification = verifyAgenticInterfaceSpec(spec, { fnIndex, inventory });
  const verifiedSpec = verification.spec;
  const readContextSourceRows = dependencies.readContextSourceRows ||
    defaultReadContextSourceRows;
  const executeAppFunction = dependencies.executeAppFunction;
  const bindings: Record<string, AgenticInterfaceBindingData> = {};
  const errors: string[] = [...verification.warnings.map((warning) => warning.message)];
  let rowCount = 0;

  for (const binding of verifiedSpec.data_bindings || []) {
    if (requestedIds.size > 0 && !requestedIds.has(binding.id)) continue;

    const base = {
      binding_id: binding.id,
      source: binding.source,
      label: binding.label,
      refreshed_at: refreshedAt,
    };

    try {
      if (binding.source === "literal") {
        bindings[binding.id] = {
          ...base,
          status: "ok",
          data: binding.value,
          raw: compactRaw(binding.value),
          row_count: Array.isArray(binding.value) ? binding.value.length : undefined,
        };
        continue;
      }

      if (binding.source === "context_source") {
        const source = findContextSource(fnIndex, binding);
        if (!source) {
          throw new Error(`Context source ${binding.context_source_id} is not available`);
        }
        const result = await readContextSourceRows(source, {
          userId,
          query: binding.query || query,
          maxRowsPerSource: Math.min(binding.max_rows || rowLimit, rowLimit),
        });
        if (result.errors.length > 0) errors.push(...result.errors);
        rowCount += result.rowCount;
        bindings[binding.id] = {
          ...base,
          status: result.errors.length > 0 ? "error" : "ok",
          data: { rows: result.rows, items: result.rows },
          raw: compactRaw(result.rows),
          row_count: result.rowCount,
          ...(result.errors[0] ? { error: result.errors[0] } : {}),
          metadata: {
            app_id: source.appId,
            app_slug: source.appSlug,
            context_source_id: source.id,
            type: source.type,
          },
        };
        continue;
      }

      if (!executeAppFunction) {
        throw new Error("App function execution is not configured");
      }

      const resolved = binding.source === "command_card"
        ? await resolveCommandCardBinding(binding, { executeAppFunction })
        : await resolveMcpReadBinding(binding, { executeAppFunction });
      if (typeof resolved.rowCount === "number") rowCount += resolved.rowCount;
      bindings[binding.id] = {
        ...base,
        status: "ok",
        data: resolved.data,
        raw: compactRaw(resolved.raw),
        row_count: resolved.rowCount,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${binding.id}: ${message}`);
      bindings[binding.id] = {
        ...base,
        status: "error",
        data: null,
        refreshed_at: refreshedAt,
        error: message,
      };
    }
  }

  return {
    spec_id: verifiedSpec.id,
    title: verifiedSpec.title,
    bindings,
    binding_order: Object.keys(bindings),
    errors,
    row_count: rowCount,
    refreshed_at: refreshedAt,
  };
}
