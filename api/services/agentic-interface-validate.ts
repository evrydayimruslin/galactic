import {
  type AgenticInterfaceAction,
  type AgenticInterfaceComponent,
  type AgenticInterfaceDataBinding,
  type AgenticInterfaceDroppedItem,
  type AgenticInterfaceField,
  type AgenticInterfacePermission,
  type AgenticInterfaceSpec,
  type AgenticInterfaceVerificationResult,
  type AgenticInterfaceWarning,
  validateAgenticInterfaceSpec,
} from "../../shared/contracts/agentic-interface.ts";
import type {
  CommandCardSurfaceEntry,
  CommandSurfaceEntry,
  CommandSurfaceInventory,
  CommandWidgetSurfaceEntry,
} from "./command-surfaces.ts";
import type { FunctionIndex } from "./function-index.ts";

export interface AgenticInterfaceVerifyOptions {
  maxComponents?: number;
  maxActions?: number;
  maxDataBindings?: number;
  maxFields?: number;
  maxColumns?: number;
  now?: () => Date;
}

interface VerifyContext {
  fnIndex: Pick<
    FunctionIndex,
    "functions" | "widgets" | "contextSources" | "updatedAt"
  >;
  inventory: CommandSurfaceInventory;
  options: Required<AgenticInterfaceVerifyOptions>;
  warnings: AgenticInterfaceWarning[];
  dropped: AgenticInterfaceDroppedItem[];
  cardByKey: Map<string, CommandCardSurfaceEntry>;
  widgetByKey: Map<string, WidgetLookupEntry>;
  contextSourceByKey: Map<string, FunctionIndex["contextSources"][number]>;
  functionByKey: Map<string, FunctionLookupEntry>;
  widgetActionByKey: Map<string, WidgetActionLookupEntry>;
}

interface FunctionLookupEntry {
  sanitizedName: string;
  appId: string;
  appSlug: string;
  fnName: string;
  description: string;
  mode: "read" | "write";
  params: FunctionIndex["functions"][string]["params"];
  returns: string;
}

interface WidgetLookupEntry {
  appId: string;
  appSlug: string;
  appName: string;
  widgetId: string;
  label: string;
}

interface WidgetActionLookupEntry {
  widget: WidgetLookupEntry;
  action: NonNullable<FunctionIndex["widgets"][number]["agentActions"]>[number];
}

const DEFAULT_LIMITS: Required<AgenticInterfaceVerifyOptions> = {
  maxComponents: 12,
  maxActions: 12,
  maxDataBindings: 16,
  maxFields: 16,
  maxColumns: 12,
  now: () => new Date(),
};

const READ_FUNCTION_RE =
  /\b(list|get|search|find|fetch|read|view|status|summary|summarize|preview|count|recent|lookup)\b/i;
const WRITE_FUNCTION_RE =
  /\b(act|add|approve|archive|book|cancel|create|delete|import|link|mark|post|publish|reject|remove|revise|run|save|schedule|send|set|start|stop|submit|sync|unlink|update|write)\b/i;
const SAFE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const UNSAFE_UI_KEYS = new Set([
  "html",
  "app_html",
  "react",
  "jsx",
  "css",
  "style",
  "script",
  "dom_selector",
  "selector",
  "iframe",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function labelValue(value: unknown, fallback: string, max = 96): string {
  const text = stringValue(value, fallback).replace(/\s+/g, " ").trim() ||
    fallback;
  return text.slice(0, max);
}

function optionalLabel(value: unknown, max = 240): string | undefined {
  const text = stringValue(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function slugify(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

function stableId(
  value: unknown,
  fallback: string,
  seen: Set<string>,
  path: string,
  ctx: Pick<VerifyContext, "warnings">,
): string {
  const raw = stringValue(value);
  let id = raw && SAFE_ID_RE.test(raw)
    ? raw
    : slugify(raw || fallback, fallback);
  if (id !== raw && raw) {
    ctx.warnings.push({
      code: "id_normalized",
      path,
      message: `Normalized id "${raw}" to "${id}".`,
    });
  }
  let candidate = id;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${id}_${suffix}`;
    suffix++;
  }
  if (candidate !== id) {
    ctx.warnings.push({
      code: "duplicate_id_renamed",
      path,
      message: `Renamed duplicate id "${id}" to "${candidate}".`,
    });
  }
  seen.add(candidate);
  return candidate;
}

function numberValue(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function addDropped(
  ctx: Pick<VerifyContext, "dropped">,
  item: AgenticInterfaceDroppedItem,
) {
  ctx.dropped.push(item);
}

function addWarning(
  ctx: Pick<VerifyContext, "warnings">,
  code: string,
  message: string,
  path?: string,
) {
  ctx.warnings.push({ code, message, ...(path ? { path } : {}) });
}

function lookupKeys(
  appId: string | undefined,
  appSlug: string | undefined,
  id: string,
): string[] {
  return [
    appId ? `id:${appId}:${id}` : "",
    appSlug ? `slug:${appSlug}:${id}` : "",
  ].filter(Boolean);
}

function cardKeys(
  appId: string | undefined,
  appSlug: string | undefined,
  widgetId: string,
  cardId: string,
): string[] {
  return [
    appId ? `id:${appId}:${widgetId}:${cardId}` : "",
    appSlug ? `slug:${appSlug}:${widgetId}:${cardId}` : "",
  ].filter(Boolean);
}

function functionKeys(
  appId: string | undefined,
  appSlug: string | undefined,
  functionName: string,
): string[] {
  return [
    appId ? `id:${appId}:${functionName}` : "",
    appSlug ? `slug:${appSlug}:${functionName}` : "",
  ].filter(Boolean);
}

function inferFunctionMode(
  name: string,
  fnName: string,
  description: string,
): "read" | "write" {
  const text = `${name} ${fnName} ${description}`;
  if (WRITE_FUNCTION_RE.test(text)) return "write";
  if (READ_FUNCTION_RE.test(text)) return "read";
  return "read";
}

function findByKeys<T>(map: Map<string, T>, keys: string[]): T | null {
  for (const key of keys) {
    const item = map.get(key);
    if (item) return item;
  }
  return null;
}

function buildLookupContext(
  fnIndex: VerifyContext["fnIndex"],
  inventory: CommandSurfaceInventory,
  options: AgenticInterfaceVerifyOptions,
): VerifyContext {
  const ctx: VerifyContext = {
    fnIndex,
    inventory,
    options: { ...DEFAULT_LIMITS, ...options },
    warnings: [],
    dropped: [],
    cardByKey: new Map(),
    widgetByKey: new Map(),
    contextSourceByKey: new Map(),
    functionByKey: new Map(),
    widgetActionByKey: new Map(),
  };

  for (const surface of inventory.surfaces) {
    if (surface.surface === "command_card") {
      for (
        const key of cardKeys(
          surface.app_id,
          surface.app_slug,
          surface.widget_id,
          surface.card_id,
        )
      ) {
        ctx.cardByKey.set(key, surface);
      }
    } else {
      addWidgetLookup(ctx, surface);
    }
  }

  for (const widget of fnIndex.widgets || []) {
    addWidgetLookup(ctx, {
      surface: "widget",
      id: `${widget.appId}:${widget.name}`,
      app_id: widget.appId,
      app_slug: widget.appSlug,
      app_name: widget.appName,
      widget_id: widget.name,
      widget_label: widget.label,
      description: widget.description || null,
      ui_function: widget.uiFunction,
      data_function: widget.dataFunction,
      cards_count: widget.cards.length,
      card_ids: widget.cards.map((card) => card.id),
      source: "installed",
      ...(widget.dependencies?.length
        ? { dependencies: widget.dependencies }
        : {}),
    });

    for (const card of widget.cards || []) {
      const entry: CommandCardSurfaceEntry = {
        surface: "command_card",
        id: `${widget.appId}:${widget.name}:${card.id}`,
        app_id: widget.appId,
        app_slug: widget.appSlug,
        app_name: widget.appName,
        widget_id: widget.name,
        widget_label: widget.label,
        card_id: card.id,
        card_label: card.label,
        description: card.description || widget.description || null,
        size: card.size,
        render: "native",
        ...(card.kind ? { kind: card.kind } : {}),
        ...(card.dataView ? { data_view: card.dataView } : {}),
        data_function: card.dataFunction || widget.dataFunction,
        ...(typeof card.refreshIntervalS === "number"
          ? { refresh_interval_s: card.refreshIntervalS }
          : {}),
        opens_widget: true,
        source: "installed",
      };
      for (
        const key of cardKeys(
          widget.appId,
          widget.appSlug,
          widget.name,
          card.id,
        )
      ) {
        ctx.cardByKey.set(key, entry);
      }
    }

    for (const action of widget.agentActions || []) {
      const widgetEntry = findByKeys(
        ctx.widgetByKey,
        lookupKeys(widget.appId, widget.appSlug, widget.name),
      );
      if (!widgetEntry) continue;
      for (
        const key of [
          widget.appId ? `id:${widget.appId}:${widget.name}:${action.id}` : "",
          widget.appSlug
            ? `slug:${widget.appSlug}:${widget.name}:${action.id}`
            : "",
        ].filter(Boolean)
      ) {
        ctx.widgetActionByKey.set(key, { widget: widgetEntry, action });
      }
    }
  }

  for (const source of fnIndex.contextSources || []) {
    for (const key of lookupKeys(source.appId, source.appSlug, source.id)) {
      ctx.contextSourceByKey.set(key, source);
    }
  }

  for (const [sanitizedName, fn] of Object.entries(fnIndex.functions || {})) {
    if (fn.fnName === "__context") continue;
    const entry: FunctionLookupEntry = {
      sanitizedName,
      appId: fn.appId,
      appSlug: fn.appSlug,
      fnName: fn.fnName,
      description: fn.description,
      mode: inferFunctionMode(sanitizedName, fn.fnName, fn.description),
      params: fn.params,
      returns: fn.returns,
    };
    for (const name of [fn.fnName, sanitizedName]) {
      for (const key of functionKeys(fn.appId, fn.appSlug, name)) {
        ctx.functionByKey.set(key, entry);
      }
    }
  }

  return ctx;
}

function addWidgetLookup(
  ctx: VerifyContext,
  surface: CommandWidgetSurfaceEntry,
) {
  const entry: WidgetLookupEntry = {
    appId: surface.app_id,
    appSlug: surface.app_slug,
    appName: surface.app_name,
    widgetId: surface.widget_id,
    label: surface.widget_label,
  };
  for (
    const key of lookupKeys(surface.app_id, surface.app_slug, surface.widget_id)
  ) {
    ctx.widgetByKey.set(key, entry);
  }
}

function containsUnsafeUiShape(value: unknown): boolean {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  if (Array.isArray(value)) return value.some(containsUnsafeUiShape);
  return Object.entries(value).some(([key, nested]) =>
    UNSAFE_UI_KEYS.has(key) || containsUnsafeUiShape(nested)
  );
}

function sanitizeArgsObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || containsUnsafeUiShape(value)) return undefined;
  return value;
}

function normalizeDataBindings(
  spec: AgenticInterfaceSpec,
  ctx: VerifyContext,
): {
  bindings: AgenticInterfaceDataBinding[];
  idMap: Map<string, string>;
} {
  const bindings: AgenticInterfaceDataBinding[] = [];
  const idMap = new Map<string, string>();
  const seen = new Set<string>();
  const rawBindings = (spec.data_bindings || []).slice(
    0,
    ctx.options.maxDataBindings,
  );
  if ((spec.data_bindings || []).length > rawBindings.length) {
    addWarning(
      ctx,
      "data_binding_limit_applied",
      "Dropped data bindings beyond the verifier limit.",
    );
  }

  rawBindings.forEach((binding, index) => {
    const path = `data_bindings.${index}`;
    if (!isRecord(binding) || containsUnsafeUiShape(binding)) {
      addDropped(ctx, {
        kind: "data_binding",
        path,
        reason: "unsafe or malformed binding",
      });
      return;
    }

    const originalId = stringValue(binding.id);
    const id = stableId(
      originalId || `${binding.source || "binding"}_${index}`,
      `binding_${index + 1}`,
      seen,
      `${path}.id`,
      ctx,
    );
    const common = {
      id,
      ...(optionalLabel(binding.label, 96)
        ? { label: optionalLabel(binding.label, 96) }
        : {}),
      ...(optionalLabel(binding.description, 240)
        ? { description: optionalLabel(binding.description, 240) }
        : {}),
      ...(typeof binding.refresh_interval_s === "number"
        ? {
          refresh_interval_s: numberValue(
            binding.refresh_interval_s,
            0,
            86400,
            0,
          ),
        }
        : {}),
    };

    switch (binding.source) {
      case "command_card": {
        const card = findByKeys(
          ctx.cardByKey,
          cardKeys(
            stringValue(binding.app_id),
            stringValue(binding.app_slug),
            stringValue(binding.widget_id),
            stringValue(binding.card_id),
          ),
        );
        if (!card) {
          addDropped(ctx, {
            kind: "data_binding",
            path,
            id: originalId || id,
            reason: "unknown command card reference",
          });
          return;
        }
        bindings.push({
          ...common,
          source: "command_card",
          app_id: card.app_id,
          app_slug: card.app_slug,
          widget_id: card.widget_id,
          card_id: card.card_id,
          ...(card.data_view ? { data_view: card.data_view } : {}),
          data_function: card.data_function,
        });
        break;
      }
      case "context_source": {
        const source = findByKeys(
          ctx.contextSourceByKey,
          lookupKeys(
            stringValue(binding.app_id),
            stringValue(binding.app_slug),
            stringValue(binding.context_source_id),
          ),
        );
        if (!source || source.access !== "read") {
          addDropped(ctx, {
            kind: "data_binding",
            path,
            id: originalId || id,
            reason: "unknown or non-readable context source",
          });
          return;
        }
        bindings.push({
          ...common,
          source: "context_source",
          app_id: source.appId,
          app_slug: source.appSlug,
          context_source_id: source.id,
          ...(optionalLabel(binding.query, 240)
            ? { query: optionalLabel(binding.query, 240) }
            : {}),
          max_rows: numberValue(binding.max_rows, 1, 100, 10),
        });
        break;
      }
      case "mcp_read_function": {
        const fn = findByKeys(
          ctx.functionByKey,
          functionKeys(
            stringValue(binding.app_id),
            stringValue(binding.app_slug),
            stringValue(binding.function_name),
          ),
        );
        if (!fn) {
          addDropped(ctx, {
            kind: "data_binding",
            path,
            id: originalId || id,
            reason: "unknown MCP read function",
          });
          return;
        }
        if (fn.mode === "write") {
          addDropped(ctx, {
            kind: "data_binding",
            path,
            id: originalId || id,
            reason: "read data bindings cannot call write-like MCP functions",
          });
          return;
        }
        bindings.push({
          ...common,
          source: "mcp_read_function",
          app_id: fn.appId,
          app_slug: fn.appSlug,
          function_name: fn.fnName,
          ...(sanitizeArgsObject(binding.args)
            ? { args: sanitizeArgsObject(binding.args) }
            : {}),
        });
        break;
      }
      case "literal":
        if (containsUnsafeUiShape(binding.value)) {
          addDropped(ctx, {
            kind: "data_binding",
            path,
            id: originalId || id,
            reason: "literal binding contains unsafe UI fields",
          });
          return;
        }
        bindings.push({ ...common, source: "literal", value: binding.value });
        break;
      default:
        addDropped(ctx, {
          kind: "data_binding",
          path,
          id: originalId || id,
          reason: "unsupported data binding source",
        });
        return;
    }

    if (originalId) idMap.set(originalId, id);
  });

  return { bindings, idMap };
}

function normalizeActions(
  spec: AgenticInterfaceSpec,
  ctx: VerifyContext,
  bindingIdMap: Map<string, string>,
  bindingIds: Set<string>,
): {
  actions: AgenticInterfaceAction[];
  idMap: Map<string, string>;
} {
  const actions: AgenticInterfaceAction[] = [];
  const idMap = new Map<string, string>();
  const seen = new Set<string>();
  const rawActions = (spec.actions || []).slice(0, ctx.options.maxActions);
  if ((spec.actions || []).length > rawActions.length) {
    addWarning(
      ctx,
      "action_limit_applied",
      "Dropped actions beyond the verifier limit.",
    );
  }

  rawActions.forEach((action, index) => {
    const path = `actions.${index}`;
    if (!isRecord(action) || containsUnsafeUiShape(action)) {
      addDropped(ctx, {
        kind: "action",
        path,
        reason: "unsafe or malformed action",
      });
      return;
    }
    const originalId = stringValue(action.id);
    const id = stableId(
      originalId || `${action.kind || "action"}_${index}`,
      `action_${index + 1}`,
      seen,
      `${path}.id`,
      ctx,
    );
    const label = labelValue(action.label, "Action");
    const common = {
      id,
      label,
      ...(optionalLabel(action.description, 240)
        ? { description: optionalLabel(action.description, 240) }
        : {}),
      ...(sanitizeArgsObject(action.args_schema)
        ? { args_schema: sanitizeArgsObject(action.args_schema) }
        : {}),
      ...(sanitizeArgsObject(action.args_template)
        ? { args_template: sanitizeArgsObject(action.args_template) }
        : {}),
      ...(optionalLabel(action.expected_result, 160)
        ? { expected_result: optionalLabel(action.expected_result, 160) }
        : {}),
    };

    switch (action.kind) {
      case "mcp_function": {
        const fn = findByKeys(
          ctx.functionByKey,
          functionKeys(
            stringValue(action.app_id),
            stringValue(action.app_slug),
            stringValue(action.function_name),
          ),
        );
        if (!fn) {
          addDropped(ctx, {
            kind: "action",
            path,
            id: originalId || id,
            reason: "unknown MCP function",
          });
          return;
        }
        const mode = fn.mode === "write"
          ? "write"
          : action.mode === "write"
          ? "write"
          : "read";
        const confirmation = mode === "write"
          ? action.confirmation === "high_risk" ? "high_risk" : "user"
          : "none";
        if (mode === "write" && action.confirmation !== confirmation) {
          addWarning(
            ctx,
            "write_confirmation_normalized",
            "Write action confirmation was normalized.",
            `${path}.confirmation`,
          );
        }
        actions.push({
          ...common,
          kind: "mcp_function",
          mode,
          confirmation,
          app_id: fn.appId,
          app_slug: fn.appSlug,
          function_name: fn.fnName,
        });
        break;
      }
      case "widget_action": {
        const widgetAction = findByKeys(
          ctx.widgetActionByKey,
          [
            stringValue(action.app_id)
              ? `id:${stringValue(action.app_id)}:${
                stringValue(action.widget_id)
              }:${stringValue(action.action_id)}`
              : "",
            stringValue(action.app_slug)
              ? `slug:${stringValue(action.app_slug)}:${
                stringValue(action.widget_id)
              }:${stringValue(action.action_id)}`
              : "",
          ].filter(Boolean),
        );
        if (!widgetAction) {
          addDropped(ctx, {
            kind: "action",
            path,
            id: originalId || id,
            reason: "unknown widget action",
          });
          return;
        }
        const mode = widgetAction.action.mode;
        const confirmation = mode === "write"
          ? widgetAction.action.confirmation === "high_risk"
            ? "high_risk"
            : "user"
          : widgetAction.action.confirmation || "none";
        actions.push({
          ...common,
          kind: "widget_action",
          mode,
          confirmation,
          app_id: widgetAction.widget.appId,
          app_slug: widgetAction.widget.appSlug,
          widget_id: widgetAction.widget.widgetId,
          action_id: widgetAction.action.id,
          ...(optionalLabel(action.surface_id, 96)
            ? { surface_id: optionalLabel(action.surface_id, 96) }
            : {}),
        });
        break;
      }
      case "open_widget": {
        const widget = findByKeys(
          ctx.widgetByKey,
          lookupKeys(
            stringValue(action.app_id),
            stringValue(action.app_slug),
            stringValue(action.widget_id),
          ),
        );
        if (!widget) {
          addDropped(ctx, {
            kind: "action",
            path,
            id: originalId || id,
            reason: "unknown widget reference",
          });
          return;
        }
        actions.push({
          ...common,
          kind: "open_widget",
          mode: "ui",
          confirmation: "none",
          app_id: widget.appId,
          app_slug: widget.appSlug,
          widget_id: widget.widgetId,
          ...(sanitizeArgsObject(action.context)
            ? {
              context: sanitizeArgsObject(action.context) as Record<
                string,
                string
              >,
            }
            : {}),
        });
        break;
      }
      case "refresh_binding": {
        const binding_ids = Array.isArray(action.binding_ids)
          ? action.binding_ids
            .filter((id): id is string => typeof id === "string")
            .map((id) => bindingIdMap.get(id) || id)
            .filter((id) => bindingIds.has(id))
          : [];
        if (binding_ids.length === 0) {
          addDropped(ctx, {
            kind: "action",
            path,
            id: originalId || id,
            reason: "no valid binding ids to refresh",
          });
          return;
        }
        actions.push({
          ...common,
          kind: "refresh_binding",
          mode: "read",
          confirmation: "none",
          binding_ids,
        });
        break;
      }
      case "select_entity":
        actions.push({
          ...common,
          kind: "select_entity",
          mode: "ui",
          confirmation: "none",
          ...(optionalLabel(action.component_id, 96)
            ? { component_id: optionalLabel(action.component_id, 96) }
            : {}),
        });
        break;
      default:
        addDropped(ctx, {
          kind: "action",
          path,
          id: originalId || id,
          reason: "unsupported action kind",
        });
        return;
    }

    if (originalId) idMap.set(originalId, id);
  });

  return { actions, idMap };
}

function normalizeFields(
  fields: unknown,
  ctx: VerifyContext,
  path: string,
): AgenticInterfaceField[] {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, ctx.options.maxFields).flatMap((field, index) => {
    if (!isRecord(field) || containsUnsafeUiShape(field)) {
      addDropped(ctx, {
        kind: "field",
        path: `${path}.${index}`,
        reason: "unsafe or malformed field",
      });
      return [];
    }
    const id = slugify(
      field.id || field.label || `field_${index + 1}`,
      `field_${index + 1}`,
    );
    return [{
      id,
      label: labelValue(field.label, id),
      ...(field.type === "number" || field.type === "boolean" ||
          field.type === "select" ||
          field.type === "textarea" || field.type === "date" ||
          field.type === "datetime" ||
          field.type === "string"
        ? { type: field.type }
        : {}),
      ...(optionalLabel(field.description, 160)
        ? { description: optionalLabel(field.description, 160) }
        : {}),
      ...(typeof field.required === "boolean"
        ? { required: field.required }
        : {}),
      ...(field.default_value !== undefined &&
          !containsUnsafeUiShape(field.default_value)
        ? { default_value: field.default_value }
        : {}),
    }];
  });
}

function normalizeComponents(
  spec: AgenticInterfaceSpec,
  ctx: VerifyContext,
  bindingIdMap: Map<string, string>,
  actionIdMap: Map<string, string>,
): AgenticInterfaceComponent[] {
  const components: AgenticInterfaceComponent[] = [];
  const seen = new Set<string>();
  const bindingIds = new Set(bindingIdMap.values());
  const actionIds = new Set(actionIdMap.values());
  const rawComponents = (spec.components || []).slice(
    0,
    ctx.options.maxComponents,
  );
  if ((spec.components || []).length > rawComponents.length) {
    addWarning(
      ctx,
      "component_limit_applied",
      "Dropped components beyond the verifier limit.",
    );
  }

  rawComponents.forEach((component, index) => {
    const path = `components.${index}`;
    if (!isRecord(component) || containsUnsafeUiShape(component)) {
      addDropped(ctx, {
        kind: "component",
        path,
        reason: "unsafe or malformed component",
      });
      return;
    }
    const originalId = stringValue(component.id);
    const id = stableId(
      originalId || `${component.kind || "component"}_${index}`,
      `component_${index + 1}`,
      seen,
      `${path}.id`,
      ctx,
    );
    const originalBindingId = stringValue(component.data_binding_id);
    const dataBindingId = originalBindingId
      ? bindingIdMap.get(originalBindingId)
      : undefined;
    const componentActionIds = Array.isArray(component.action_ids)
      ? component.action_ids
        .filter((actionId): actionId is string => typeof actionId === "string")
        .map((actionId) => actionIdMap.get(actionId))
        .filter((actionId): actionId is string =>
          !!actionId && actionIds.has(actionId)
        )
      : [];
    const common = {
      id,
      title: optionalLabel(component.title, 96),
      description: optionalLabel(component.description, 240),
      ...(dataBindingId ? { data_binding_id: dataBindingId } : {}),
      ...(componentActionIds.length > 0
        ? { action_ids: [...new Set(componentActionIds)] }
        : {}),
    };

    const needsData = ["metric", "list", "table", "detail", "timeline"]
      .includes(String(component.kind));
    if (needsData && originalBindingId && !dataBindingId) {
      addDropped(ctx, {
        kind: "component",
        path,
        id: originalId || id,
        reason: "unknown data binding reference",
      });
      return;
    }

    switch (component.kind) {
      case "metric":
        components.push({
          ...common,
          kind: "metric",
          ...(optionalLabel(component.metric_field, 64)
            ? { metric_field: optionalLabel(component.metric_field, 64) }
            : {}),
          ...(optionalLabel(component.label_field, 64)
            ? { label_field: optionalLabel(component.label_field, 64) }
            : {}),
          ...(optionalLabel(component.suffix, 24)
            ? { suffix: optionalLabel(component.suffix, 24) }
            : {}),
        });
        break;
      case "list":
        components.push({
          ...common,
          kind: "list",
          ...(optionalLabel(component.primary_field, 64)
            ? { primary_field: optionalLabel(component.primary_field, 64) }
            : {}),
          ...(optionalLabel(component.secondary_field, 64)
            ? { secondary_field: optionalLabel(component.secondary_field, 64) }
            : {}),
          ...(optionalLabel(component.trailing_field, 64)
            ? { trailing_field: optionalLabel(component.trailing_field, 64) }
            : {}),
          max_items: numberValue(component.max_items, 1, 50, 8),
        });
        break;
      case "table":
        components.push({
          ...common,
          kind: "table",
          selectable: component.selectable !== false,
        });
        break;
      case "detail":
        components.push({
          ...common,
          kind: "detail",
          fields: normalizeFields(component.fields, ctx, `${path}.fields`),
        });
        break;
      case "form": {
        const fields = normalizeFields(component.fields, ctx, `${path}.fields`);
        const submitActionId = stringValue(component.submit_action_id);
        if (fields.length === 0) {
          addDropped(ctx, {
            kind: "component",
            path,
            id: originalId || id,
            reason: "form has no valid fields",
          });
          return;
        }
        components.push({
          ...common,
          kind: "form",
          fields,
          ...(submitActionId && actionIdMap.get(submitActionId)
            ? { submit_action_id: actionIdMap.get(submitActionId) }
            : {}),
        });
        break;
      }
      case "action_bar":
        if (componentActionIds.length === 0) {
          addDropped(ctx, {
            kind: "component",
            path,
            id: originalId || id,
            reason: "action bar has no valid actions",
          });
          return;
        }
        components.push({
          ...common,
          kind: "action_bar",
          action_ids: [...new Set(componentActionIds)],
        });
        break;
      case "timeline":
        components.push({
          ...common,
          kind: "timeline",
          ...(optionalLabel(component.time_field, 64)
            ? { time_field: optionalLabel(component.time_field, 64) }
            : {}),
          ...(optionalLabel(component.title_field, 64)
            ? { title_field: optionalLabel(component.title_field, 64) }
            : {}),
          ...(optionalLabel(component.subtitle_field, 64)
            ? { subtitle_field: optionalLabel(component.subtitle_field, 64) }
            : {}),
        });
        break;
      case "card_ref": {
        const card = findByKeys(
          ctx.cardByKey,
          cardKeys(
            stringValue(component.app_id),
            stringValue(component.app_slug),
            stringValue(component.widget_id),
            stringValue(component.card_id),
          ),
        );
        if (!card) {
          addDropped(ctx, {
            kind: "component",
            path,
            id: originalId || id,
            reason: "unknown command card reference",
          });
          return;
        }
        components.push({
          ...common,
          kind: "card_ref",
          app_id: card.app_id,
          app_slug: card.app_slug,
          widget_id: card.widget_id,
          card_id: card.card_id,
          size: card.size,
        });
        break;
      }
      case "widget_embed": {
        const widget = findByKeys(
          ctx.widgetByKey,
          lookupKeys(
            stringValue(component.app_id),
            stringValue(component.app_slug),
            stringValue(component.widget_id),
          ),
        );
        if (!widget) {
          addDropped(ctx, {
            kind: "component",
            path,
            id: originalId || id,
            reason: "unknown widget reference",
          });
          return;
        }
        components.push({
          ...common,
          kind: "widget_embed",
          app_id: widget.appId,
          app_slug: widget.appSlug,
          widget_id: widget.widgetId,
          ...(sanitizeArgsObject(component.context)
            ? {
              context: sanitizeArgsObject(component.context) as Record<
                string,
                string
              >,
            }
            : {}),
        });
        break;
      }
      case "routine_panel":
        components.push({ ...common, kind: "routine_panel" });
        break;
      case "text":
        components.push({
          ...common,
          kind: "text",
          text: labelValue(
            component.text,
            "No verified interface content is available.",
            800,
          ),
        });
        break;
      default:
        addDropped(ctx, {
          kind: "component",
          path,
          id: originalId || id,
          reason: "unsupported component kind",
        });
    }
  });

  if (components.length === 0) {
    components.push({
      id: "verified_empty_state",
      kind: "text",
      title: "No verified interface content",
      text:
        "No generated components survived verification. Try a narrower prompt or install a matching widget.",
    });
    addWarning(
      ctx,
      "verified_empty_state",
      "The verifier returned a safe no-op interface.",
    );
  }

  return components;
}

function packLayout(
  components: AgenticInterfaceComponent[],
): AgenticInterfaceSpec["layout"] {
  let x = 0;
  let y = 0;
  let rowHeight = 1;
  return {
    columns: 4,
    items: components.map((component) => {
      const w = component.kind === "metric"
        ? 1
        : component.kind === "action_bar"
        ? 4
        : 2;
      const h = component.kind === "widget_embed" || component.kind === "table"
        ? 2
        : 1;
      if (x + w > 4) {
        x = 0;
        y += rowHeight;
        rowHeight = 1;
      }
      const item = { component_id: component.id, x, y, w, h };
      x += w;
      rowHeight = Math.max(rowHeight, h);
      return item;
    }),
  };
}

function normalizePermissions(
  bindings: AgenticInterfaceDataBinding[],
  actions: AgenticInterfaceAction[],
): AgenticInterfacePermission[] {
  const permissions = new Map<string, AgenticInterfacePermission>();
  const add = (permission: AgenticInterfacePermission) => {
    const key = [
      permission.kind,
      permission.access,
      permission.app_id || "",
      permission.app_slug || "",
      permission.function_name || "",
      permission.widget_id || "",
      permission.action_id || "",
      permission.context_source_id || "",
    ].join(":");
    permissions.set(key, permission);
  };

  for (const binding of bindings) {
    if (binding.source === "context_source") {
      add({
        kind: "read_context_source",
        access: "read",
        app_id: binding.app_id,
        app_slug: binding.app_slug,
        context_source_id: binding.context_source_id,
        reason: binding.label || binding.description,
      });
    } else if (binding.source === "mcp_read_function") {
      add({
        kind: "call_mcp_function",
        access: "read",
        app_id: binding.app_id,
        app_slug: binding.app_slug,
        function_name: binding.function_name,
        reason: binding.label || binding.description,
      });
    }
  }

  for (const action of actions) {
    if (action.kind === "mcp_function") {
      add({
        kind: "call_mcp_function",
        access: action.mode,
        app_id: action.app_id,
        app_slug: action.app_slug,
        function_name: action.function_name,
        reason: action.label,
      });
    } else if (action.kind === "widget_action") {
      add({
        kind: "invoke_widget_action",
        access: action.mode,
        app_id: action.app_id,
        app_slug: action.app_slug,
        widget_id: action.widget_id,
        action_id: action.action_id,
        reason: action.label,
      });
    } else if (action.kind === "open_widget") {
      add({
        kind: "open_widget",
        access: "ui",
        app_id: action.app_id,
        app_slug: action.app_slug,
        widget_id: action.widget_id,
        reason: action.label,
      });
    }
  }

  return Array.from(permissions.values());
}

function buildScope(
  bindings: AgenticInterfaceDataBinding[],
  actions: AgenticInterfaceAction[],
  components: AgenticInterfaceComponent[],
): AgenticInterfaceSpec["scope"] {
  return {
    app_ids: [
      ...new Set([
        ...bindings.map((binding) => "app_id" in binding ? binding.app_id : ""),
        ...actions.map((action) =>
          "app_id" in action ? action.app_id || "" : ""
        ),
        ...components.map((component) =>
          "app_id" in component ? component.app_id : ""
        ),
      ].filter(Boolean)),
    ],
    app_slugs: [
      ...new Set([
        ...bindings.map((binding) =>
          "app_slug" in binding ? binding.app_slug || "" : ""
        ),
        ...actions.map((action) =>
          "app_slug" in action ? action.app_slug || "" : ""
        ),
        ...components.map((component) =>
          "app_slug" in component ? component.app_slug || "" : ""
        ),
      ].filter(Boolean)),
    ],
    widget_ids: [
      ...new Set([
        ...actions.map((action) =>
          "widget_id" in action ? action.widget_id || "" : ""
        ),
        ...components.map((component) =>
          "widget_id" in component ? component.widget_id : ""
        ),
      ].filter(Boolean)),
    ],
    context_source_ids: [
      ...new Set(
        bindings
          .filter((binding) => binding.source === "context_source")
          .map((binding) => binding.context_source_id),
      ),
    ],
    function_names: [
      ...new Set([
        ...bindings
          .filter((binding) => binding.source === "mcp_read_function")
          .map((binding) => binding.function_name),
        ...actions
          .filter((action) => action.kind === "mcp_function")
          .map((action) => action.function_name),
      ]),
    ],
  };
}

export function verifyAgenticInterfaceSpec(
  draft: AgenticInterfaceSpec,
  input: {
    fnIndex: VerifyContext["fnIndex"];
    inventory: CommandSurfaceInventory;
    options?: AgenticInterfaceVerifyOptions;
  },
): AgenticInterfaceVerificationResult {
  const ctx = buildLookupContext(
    input.fnIndex,
    input.inventory,
    input.options || {},
  );
  for (const warning of draft.warnings || []) {
    if (
      isRecord(warning) && stringValue(warning.code) &&
      stringValue(warning.message)
    ) {
      ctx.warnings.push({
        code: stringValue(warning.code),
        message: stringValue(warning.message),
        ...(stringValue(warning.path)
          ? { path: stringValue(warning.path) }
          : {}),
      });
    }
  }
  const specRecord = asRecord(draft);
  const specId = stableId(
    specRecord.id,
    "generated_interface",
    new Set(),
    "id",
    ctx,
  );
  const { bindings, idMap: bindingIdMap } = normalizeDataBindings(draft, ctx);
  const bindingIds = new Set(bindings.map((binding) => binding.id));
  const { actions, idMap: actionIdMap } = normalizeActions(
    draft,
    ctx,
    bindingIdMap,
    bindingIds,
  );
  const components = normalizeComponents(draft, ctx, bindingIdMap, actionIdMap);
  const permissions = normalizePermissions(bindings, actions);

  const verifiedSpec: AgenticInterfaceSpec = {
    id: specId,
    title: labelValue(specRecord.title, "Generated Interface"),
    ...(optionalLabel(specRecord.description, 280)
      ? { description: optionalLabel(specRecord.description, 280) }
      : {}),
    mode: specRecord.mode === "saved" ? "saved" : "temporary",
    ...(optionalLabel(specRecord.intent, 280)
      ? { intent: optionalLabel(specRecord.intent, 280) }
      : {}),
    scope: buildScope(bindings, actions, components),
    layout: packLayout(components),
    components,
    ...(bindings.length > 0 ? { data_bindings: bindings } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(permissions.length > 0 ? { permissions } : {}),
    provenance: {
      ...asRecord(specRecord.provenance),
      generated_at:
        typeof asRecord(specRecord.provenance).generated_at === "string"
          ? asRecord(specRecord.provenance).generated_at as string
          : ctx.options.now().toISOString(),
      inventory_updated_at: input.fnIndex.updatedAt ||
        input.inventory.updated_at || null,
    },
    version: typeof specRecord.version === "number" ? specRecord.version : 1,
  };

  if (ctx.warnings.length > 0) verifiedSpec.warnings = ctx.warnings;
  const validation = validateAgenticInterfaceSpec(verifiedSpec);
  return {
    verified: validation.valid,
    spec: verifiedSpec,
    validation,
    warnings: ctx.warnings,
    dropped: ctx.dropped,
  };
}
