import {
  type AgenticInterfaceAction,
  type AgenticInterfaceComponent,
  type AgenticInterfaceComponentKind,
  type AgenticInterfaceDataBinding,
  type AgenticInterfaceDroppedItem,
  type AgenticInterfacePermission,
  type AgenticInterfaceSpec,
  type AgenticInterfaceValidationResult,
  type AgenticInterfaceVerificationResult,
  type AgenticInterfaceWarning,
  validateAgenticInterfaceSpec,
} from "../../shared/contracts/agentic-interface.ts";
import type {
  WidgetGenerationHints,
  WidgetGenerationSuggestedComponent,
} from "../../shared/contracts/widget.ts";
import {
  type ContextSourceMagnifyOptions,
  type ContextSourceMagnifyResult,
  magnifyContextSources as defaultMagnifyContextSources,
} from "./app-context-magnifier.ts";
import {
  type CommandDashboardSummary,
  listCommandDashboardLayouts as defaultListCommandDashboardLayouts,
} from "./command-dashboard.ts";
import {
  type CommandCardSurfaceEntry,
  type CommandSurfaceEntry,
  type CommandSurfaceInventory,
  type CommandSurfaceInventoryOptions,
  flattenCommandSurfaceInventory,
  getCommandSurfaceInventory as defaultGetCommandSurfaceInventory,
} from "./command-surfaces.ts";
import {
  AGENTIC_INTERFACE_PLANNER_VERSION,
  type AgenticInterfacePlannerContextSummary,
  buildAgenticInterfacePlannerContextSummary,
  buildAgenticInterfacePlannerSystemPrompt,
} from "./agentic-interface-prompts.ts";
import {
  type FunctionIndex,
  getOrRebuildFunctionIndex as defaultGetOrRebuildFunctionIndex,
} from "./function-index.ts";
import { verifyAgenticInterfaceSpec } from "./agentic-interface-validate.ts";

export interface AgenticInterfacePlannerInput {
  prompt?: unknown;
  query?: unknown;
  mode?: unknown;
  desired_mode?: unknown;
  max_components?: unknown;
  limit?: unknown;
  include_data_preview?: unknown;
  app_id?: unknown;
  app_ids?: unknown;
  app_slug?: unknown;
  app_slugs?: unknown;
  app_scope?: unknown;
}

export interface AgenticInterfacePlannerResult {
  draft_spec: AgenticInterfaceSpec;
  normalized_spec: AgenticInterfaceSpec;
  validation: AgenticInterfaceValidationResult;
  verification: AgenticInterfaceVerificationResult;
  rationale: string[];
  warnings: AgenticInterfaceWarning[];
  dropped: AgenticInterfaceDroppedItem[];
  planner: {
    version: string;
    policy: string;
    context_summary: AgenticInterfacePlannerContextSummary;
  };
  inventory: {
    surfaces_considered: number;
    functions_considered: number;
    context_sources_considered: number;
    saved_dashboards_considered: number;
    data_preview_rows?: number;
  };
  data_preview?: Pick<
    ContextSourceMagnifyResult,
    "context" | "sourceCount" | "rowCount" | "errors"
  >;
  persisted: false;
}

export interface AgenticInterfacePlannerDependencies {
  getFunctionIndex?: (userId: string) => Promise<FunctionIndex>;
  getCommandSurfaceInventory?: (
    userId: string,
    options?: CommandSurfaceInventoryOptions,
  ) => Promise<CommandSurfaceInventory>;
  listDashboards?: (
    userId: string,
  ) => Promise<{ dashboards: CommandDashboardSummary[] }>;
  magnifyContextSources?: (
    sources: FunctionIndex["contextSources"],
    options: ContextSourceMagnifyOptions,
  ) => Promise<ContextSourceMagnifyResult>;
  now?: () => Date;
}

export interface BuildAgenticInterfacePlanOptions {
  dashboards?: CommandDashboardSummary[];
  dataPreview?: ContextSourceMagnifyResult | null;
  now?: () => Date;
}

interface PlannerScope {
  appIds: Set<string>;
  appSlugs: Set<string>;
}

interface ScoredFunction {
  name: string;
  fn: FunctionIndex["functions"][string];
  score: number;
  mode: "read" | "write";
}

const DEFAULT_MAX_COMPONENTS = 6;
const MAX_COMPONENTS = 12;
const MAX_DATA_PREVIEW_CHARS = 4000;
const READ_FUNCTION_RE =
  /\b(list|get|search|find|fetch|read|view|status|summary|summarize|preview|count|recent|lookup)\b/i;
const WRITE_FUNCTION_RE =
  /\b(act|add|approve|archive|book|cancel|create|delete|import|link|mark|post|publish|reject|remove|revise|run|save|schedule|send|set|start|stop|submit|sync|unlink|update|write)\b/i;
const HINTED_CARD_COMPONENT_KINDS = new Set<AgenticInterfaceComponentKind>([
  "metric",
  "list",
  "table",
  "detail",
  "timeline",
  "card_ref",
]);
const HINTED_DATA_COMPONENT_KINDS = new Set<AgenticInterfaceComponentKind>([
  "metric",
  "list",
  "table",
  "detail",
  "timeline",
  "text",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, 500);
}

function normalizePrompt(input: AgenticInterfacePlannerInput): string {
  return normalizeString(input.prompt) || normalizeString(input.query) ||
    "Command interface";
}

function normalizeMode(value: unknown): "temporary" | "saved" {
  return value === "saved" ? "saved" : "temporary";
}

function normalizeMaxComponents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_COMPONENTS;
  }
  return Math.max(1, Math.min(MAX_COMPONENTS, Math.floor(value)));
}

function normalizeStringList(value: unknown): string[] {
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

function normalizeScope(input: AgenticInterfacePlannerInput): PlannerScope {
  const appScope = isRecord(input.app_scope) ? input.app_scope : {};
  return {
    appIds: new Set([
      ...normalizeStringList(input.app_id),
      ...normalizeStringList(input.app_ids),
      ...normalizeStringList(appScope.app_id),
      ...normalizeStringList(appScope.app_ids),
    ]),
    appSlugs: new Set([
      ...normalizeStringList(input.app_slug),
      ...normalizeStringList(input.app_slugs),
      ...normalizeStringList(appScope.app_slug),
      ...normalizeStringList(appScope.app_slugs),
    ]),
  };
}

function matchesScope(
  appId: string,
  appSlug: string | undefined,
  scope: PlannerScope,
): boolean {
  if (scope.appIds.size === 0 && scope.appSlugs.size === 0) return true;
  return scope.appIds.has(appId) ||
    (appSlug ? scope.appSlugs.has(appSlug) : false);
}

function slugify(value: string, fallback = "item"): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

function uniqueId(base: string, seen: Set<string>): string {
  const root = slugify(base);
  let candidate = root;
  let index = 2;
  while (seen.has(candidate)) {
    candidate = `${root}_${index}`;
    index++;
  }
  seen.add(candidate);
  return candidate;
}

function tokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 1),
    ),
  ].slice(0, 24);
}

function scoreText(query: string, text: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedText = text.toLowerCase();
  if (!normalizedQuery) return 1;
  let score = normalizedText.includes(normalizedQuery) ? 10 : 0;
  for (const token of tokens(query)) {
    if (normalizedText.includes(token)) score += 2;
  }
  return score;
}

function humanizeTitle(prompt: string): string {
  const words = tokens(prompt).slice(0, 5);
  if (words.length === 0) return "Command Interface";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(
    " ",
  );
}

function generationHintText(hints?: WidgetGenerationHints): string {
  if (!hints) return "";
  return [
    ...(hints.tags || []),
    ...(hints.entity_types || []),
    ...(hints.prompt_examples || []),
    hints.preferred_component || "",
    hints.action_group || "",
    ...Object.keys(hints.safe_default_filters || {}),
    ...(hints.suggested_components || []).flatMap((component) => [
      component.kind,
      component.title || "",
      component.description || "",
      component.data_view || "",
      component.context_source_id || "",
      ...(component.action_ids || []),
    ]),
  ].filter(Boolean).join(" ");
}

function safeDefaultArgs(
  hints?: WidgetGenerationHints,
): Record<string, unknown> | undefined {
  const filters = hints?.safe_default_filters;
  return filters && Object.keys(filters).length > 0 ? filters : undefined;
}

function preferredCardKind(
  hints?: WidgetGenerationHints,
): AgenticInterfaceComponentKind | null {
  const kind = hints?.preferred_component;
  if (!kind) return null;
  if (kind === "widget_embed") return "card_ref";
  return HINTED_CARD_COMPONENT_KINDS.has(kind as AgenticInterfaceComponentKind)
    ? kind as AgenticInterfaceComponentKind
    : null;
}

function preferredDataKind(
  hints?: WidgetGenerationHints,
  fallback: AgenticInterfaceComponentKind = "table",
): AgenticInterfaceComponentKind {
  const kind = hints?.preferred_component;
  if (
    kind &&
    HINTED_DATA_COMPONENT_KINDS.has(kind as AgenticInterfaceComponentKind)
  ) {
    return kind as AgenticInterfaceComponentKind;
  }
  return fallback;
}

function surfaceText(surface: CommandSurfaceEntry): string {
  if (surface.embedding_text) return surface.embedding_text;
  const hints = generationHintText(surface.generation_hints);
  if (surface.surface === "command_card") {
    return [
      surface.app_name,
      surface.app_slug,
      surface.widget_label,
      surface.widget_id,
      surface.card_label,
      surface.card_id,
      surface.description || "",
      surface.kind || "",
      surface.data_view || "",
      hints,
    ].join(" ");
  }
  return [
    surface.app_name,
    surface.app_slug,
    surface.widget_label,
    surface.widget_id,
    surface.description || "",
    surface.card_ids.join(" "),
    hints,
  ].join(" ");
}

function contextSourceText(
  source: FunctionIndex["contextSources"][number],
): string {
  return [
    source.appName,
    source.appSlug,
    source.id,
    source.label,
    source.description || "",
    source.type,
    (source.tables || []).join(" "),
    generationHintText(source.generationHints),
  ].join(" ");
}

function functionText(
  name: string,
  fn: FunctionIndex["functions"][string],
): string {
  return [
    name,
    fn.appSlug,
    fn.fnName,
    fn.description,
    Object.keys(fn.params || {}).join(" "),
    fn.returns,
    generationHintText(fn.generationHints),
  ].join(" ");
}

function componentKindForCard(
  card: CommandCardSurfaceEntry,
): AgenticInterfaceComponentKind {
  const hintedKind = preferredCardKind(card.generation_hints);
  if (hintedKind) return hintedKind;
  const kind = (card.kind || card.data_view || "").toLowerCase();
  if (/\b(metric|kpi|count|progress|status|summary)\b/.test(kind)) {
    return "metric";
  }
  if (/\b(list|queue|feed|inbox)\b/.test(kind)) return "list";
  if (/\b(table|grid|sheet|rows)\b/.test(kind)) return "table";
  if (/\b(timeline|calendar|events|activity)\b/.test(kind)) return "timeline";
  if (/\b(detail|profile|record)\b/.test(kind)) return "detail";
  return "card_ref";
}

function inferFunctionMode(
  name: string,
  fn: FunctionIndex["functions"][string],
): "read" | "write" {
  const text = `${name} ${fn.fnName} ${fn.description}`;
  if (WRITE_FUNCTION_RE.test(text)) return "write";
  if (READ_FUNCTION_RE.test(text)) return "read";
  return "read";
}

function actionConfirmation(mode: "read" | "write"): "none" | "user" {
  return mode === "write" ? "user" : "none";
}

function sortByScore<T>(
  items: T[],
  query: string,
  text: (item: T) => string,
): T[] {
  return items
    .map((item) => ({ item, score: scoreText(query, text(item)) }))
    .filter((entry) => !query.trim() || entry.score > 0)
    .sort((a, b) =>
      b.score - a.score || text(a.item).localeCompare(text(b.item))
    )
    .map((entry) => entry.item);
}

function selectFunctions(
  fnIndex: Pick<FunctionIndex, "functions">,
  prompt: string,
  scope: PlannerScope,
  limit: number,
): ScoredFunction[] {
  return Object.entries(fnIndex.functions || {})
    .filter(([, fn]) => fn.fnName !== "__context")
    .filter(([, fn]) => matchesScope(fn.appId, fn.appSlug, scope))
    .map(([name, fn]) => ({
      name,
      fn,
      score: scoreText(prompt, functionText(name, fn)),
      mode: inferFunctionMode(name, fn),
    }))
    .filter((entry) => !prompt.trim() || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function selectContextSources(
  fnIndex: Pick<FunctionIndex, "contextSources">,
  prompt: string,
  scope: PlannerScope,
  limit: number,
): FunctionIndex["contextSources"] {
  return sortByScore(
    (fnIndex.contextSources || []).filter((source) =>
      source.access === "read" &&
      matchesScope(source.appId, source.appSlug, scope)
    ),
    prompt,
    contextSourceText,
  ).slice(0, limit);
}

function addPermission(
  permissions: AgenticInterfacePermission[],
  permission: AgenticInterfacePermission,
) {
  const key = [
    permission.kind,
    permission.app_id || "",
    permission.app_slug || "",
    permission.function_name || "",
    permission.widget_id || "",
    permission.action_id || "",
    permission.context_source_id || "",
    permission.access,
  ].join(":");
  if (
    permissions.some((existing) =>
      [
        existing.kind,
        existing.app_id || "",
        existing.app_slug || "",
        existing.function_name || "",
        existing.widget_id || "",
        existing.action_id || "",
        existing.context_source_id || "",
        existing.access,
      ].join(":") === key
    )
  ) return;
  permissions.push(permission);
}

function packLayout(
  components: AgenticInterfaceComponent[],
): AgenticInterfaceSpec["layout"] {
  let x = 0;
  let y = 0;
  let rowHeight = 1;
  const items = components.map((component) => {
    const w = component.kind === "metric"
      ? 1
      : component.kind === "action_bar"
      ? 4
      : 2;
    const h = component.kind === "widget_embed" ? 2 : 1;
    if (x + w > 4) {
      x = 0;
      y += rowHeight;
      rowHeight = 1;
    }
    const item = { component_id: component.id, x, y, w, h };
    x += w;
    rowHeight = Math.max(rowHeight, h);
    return item;
  });
  return { columns: 4, items };
}

function cardBinding(
  card: CommandCardSurfaceEntry,
  id: string,
): AgenticInterfaceDataBinding {
  return {
    id,
    source: "command_card",
    label: card.card_label,
    ...(card.description ? { description: card.description } : {}),
    app_id: card.app_id,
    app_slug: card.app_slug,
    widget_id: card.widget_id,
    card_id: card.card_id,
    ...(card.data_view ? { data_view: card.data_view } : {}),
    data_function: card.data_function,
    ...(typeof card.refresh_interval_s === "number"
      ? { refresh_interval_s: card.refresh_interval_s }
      : {}),
  };
}

function componentForCard(
  card: CommandCardSurfaceEntry,
  componentId: string,
  bindingId: string,
  actionIds: string[],
): AgenticInterfaceComponent {
  const kind = componentKindForCard(card);
  const base = {
    id: componentId,
    kind,
    title: card.card_label,
    ...(card.description ? { description: card.description } : {}),
    data_binding_id: bindingId,
    ...(actionIds.length > 0 ? { action_ids: actionIds } : {}),
  };

  if (kind === "card_ref") {
    return {
      ...base,
      kind: "card_ref",
      app_id: card.app_id,
      app_slug: card.app_slug,
      widget_id: card.widget_id,
      card_id: card.card_id,
      size: card.size,
    };
  }
  if (kind === "table") return { ...base, kind: "table", selectable: true };
  if (kind === "list") return { ...base, kind: "list", max_items: 8 };
  if (kind === "timeline") return { ...base, kind: "timeline" };
  if (kind === "detail") return { ...base, kind: "detail" };
  return { ...base, kind: "metric" };
}

function componentForDataBinding(input: {
  id: string;
  bindingId?: string;
  title: string;
  description?: string;
  actionIds: string[];
  kind: AgenticInterfaceComponentKind;
}): AgenticInterfaceComponent {
  const base = {
    id: input.id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.bindingId ? { data_binding_id: input.bindingId } : {}),
    ...(input.actionIds.length > 0 ? { action_ids: input.actionIds } : {}),
  };
  if (input.kind === "metric") return { ...base, kind: "metric" };
  if (input.kind === "list") return { ...base, kind: "list", max_items: 8 };
  if (input.kind === "timeline") return { ...base, kind: "timeline" };
  if (input.kind === "detail") return { ...base, kind: "detail" };
  if (input.kind === "text") {
    return {
      id: input.id,
      kind: "text",
      title: input.title,
      text: input.description || input.title,
      ...(input.actionIds.length > 0 ? { action_ids: input.actionIds } : {}),
    };
  }
  return { ...base, kind: "table", selectable: true };
}

function suggestedComponentKind(
  suggestion: WidgetGenerationSuggestedComponent,
): AgenticInterfaceComponentKind | null {
  const kind = suggestion.kind as AgenticInterfaceComponentKind;
  if (kind === "action_bar" || kind === "text") return kind;
  return HINTED_DATA_COMPONENT_KINDS.has(kind) ? kind : null;
}

function componentForSuggestion(input: {
  suggestion: WidgetGenerationSuggestedComponent;
  bindingId?: string;
  fallbackTitle: string;
  actionIds: string[];
  seenIds: Set<string>;
}): AgenticInterfaceComponent | null {
  const kind = suggestedComponentKind(input.suggestion);
  if (!kind) return null;
  const title = input.suggestion.title || input.fallbackTitle;
  const id = uniqueId(`hint_${title}_${kind}`, input.seenIds);
  if (kind === "action_bar") {
    if (input.actionIds.length === 0) return null;
    return {
      id,
      kind: "action_bar",
      title,
      ...(input.suggestion.description
        ? { description: input.suggestion.description }
        : {}),
      action_ids: input.actionIds,
    };
  }
  return componentForDataBinding({
    id,
    bindingId: kind === "text" ? undefined : input.bindingId,
    title,
    description: input.suggestion.description,
    actionIds: input.actionIds,
    kind,
  });
}

function mcpReadBinding(
  selected: ScoredFunction,
  id: string,
): AgenticInterfaceDataBinding {
  const args = safeDefaultArgs(selected.fn.generationHints) || {};
  return {
    id,
    source: "mcp_read_function",
    label: selected.fn.description || selected.fn.fnName,
    app_id: selected.fn.appId,
    app_slug: selected.fn.appSlug,
    function_name: selected.fn.fnName,
    args,
  };
}

function contextBinding(
  source: FunctionIndex["contextSources"][number],
  id: string,
  prompt: string,
): AgenticInterfaceDataBinding {
  return {
    id,
    source: "context_source",
    label: source.label,
    ...(source.description ? { description: source.description } : {}),
    app_id: source.appId,
    app_slug: source.appSlug,
    context_source_id: source.id,
    query: prompt,
    max_rows: 10,
  };
}

function buildWarnings(
  warnings: AgenticInterfaceWarning[],
  validation: AgenticInterfaceValidationResult,
): AgenticInterfaceWarning[] {
  const all = [...warnings, ...validation.warnings];
  if (!validation.valid) {
    all.push({
      code: "draft_validation_failed",
      message: "The planner draft did not pass contract validation.",
    });
  }
  return all;
}

export function buildAgenticInterfacePlanFromInventory(
  fnIndex: Pick<
    FunctionIndex,
    "functions" | "widgets" | "contextSources" | "updatedAt"
  >,
  inventory: CommandSurfaceInventory,
  input: AgenticInterfacePlannerInput,
  options: BuildAgenticInterfacePlanOptions = {},
): AgenticInterfacePlannerResult {
  const prompt = normalizePrompt(input);
  const mode = normalizeMode(input.mode ?? input.desired_mode);
  const maxComponents = normalizeMaxComponents(
    input.max_components ?? input.limit,
  );
  const scope = normalizeScope(input);
  const now = options.now || (() => new Date());
  const warnings: AgenticInterfaceWarning[] = [];
  const rationale: string[] = [];
  const seenIds = new Set<string>();
  const dataBindings: AgenticInterfaceDataBinding[] = [];
  const actions: AgenticInterfaceAction[] = [];
  const permissions: AgenticInterfacePermission[] = [];

  const cards = inventory.surfaces
    .filter((surface): surface is CommandCardSurfaceEntry =>
      surface.surface === "command_card"
    )
    .slice(0, Math.min(4, Math.max(1, maxComponents - 2)));
  const widgets = inventory.surfaces
    .filter((surface) => surface.surface === "widget")
    .slice(0, 3);
  const selectedContextSources = selectContextSources(
    fnIndex,
    prompt,
    scope,
    3,
  );
  const selectedFunctions = selectFunctions(fnIndex, prompt, scope, 8);
  const readFunctions = selectedFunctions.filter((entry) =>
    entry.mode === "read"
  ).slice(0, 2);
  const writeFunctions = selectedFunctions.filter((entry) =>
    entry.mode === "write"
  ).slice(0, 3);

  const widgetTargets = new Map<string, {
    app_id: string;
    app_slug?: string;
    widget_id: string;
    label: string;
  }>();
  for (const card of cards) {
    widgetTargets.set(`${card.app_id}:${card.widget_id}`, {
      app_id: card.app_id,
      app_slug: card.app_slug,
      widget_id: card.widget_id,
      label: card.widget_label,
    });
  }
  for (const widget of widgets) {
    widgetTargets.set(`${widget.app_id}:${widget.widget_id}`, {
      app_id: widget.app_id,
      app_slug: widget.app_slug,
      widget_id: widget.widget_id,
      label: widget.widget_label,
    });
  }

  const openWidgetActionIds: string[] = [];
  for (const widget of Array.from(widgetTargets.values()).slice(0, 2)) {
    const actionId = uniqueId(`open_${widget.widget_id}`, seenIds);
    openWidgetActionIds.push(actionId);
    actions.push({
      id: actionId,
      kind: "open_widget",
      label: `Open ${widget.label}`,
      mode: "ui",
      confirmation: "none",
      app_id: widget.app_id,
      app_slug: widget.app_slug,
      widget_id: widget.widget_id,
    });
    addPermission(permissions, {
      kind: "open_widget",
      access: "ui",
      app_id: widget.app_id,
      app_slug: widget.app_slug,
      widget_id: widget.widget_id,
      reason: `Open the source widget for ${widget.label}.`,
    });
  }

  const writeActionIds: string[] = [];
  for (const selected of writeFunctions) {
    const actionId = uniqueId(selected.name, seenIds);
    const argsTemplate = safeDefaultArgs(selected.fn.generationHints);
    writeActionIds.push(actionId);
    actions.push({
      id: actionId,
      kind: "mcp_function",
      label: selected.fn.description || selected.fn.fnName,
      mode: "write",
      confirmation: actionConfirmation("write"),
      app_id: selected.fn.appId,
      app_slug: selected.fn.appSlug,
      function_name: selected.fn.fnName,
      args_schema: {
        type: "object",
        properties: selected.fn.params || {},
      },
      ...(argsTemplate ? { args_template: argsTemplate } : {}),
      expected_result: selected.fn.returns,
    });
    addPermission(permissions, {
      kind: "call_mcp_function",
      access: "write",
      app_id: selected.fn.appId,
      app_slug: selected.fn.appSlug,
      function_name: selected.fn.fnName,
      reason: selected.fn.description,
    });
  }

  const componentActions = [...openWidgetActionIds, ...writeActionIds].slice(
    0,
    4,
  );
  const components: AgenticInterfaceComponent[] = [];

  for (const card of cards) {
    const bindingId = uniqueId(
      `card_${card.widget_id}_${card.card_id}`,
      seenIds,
    );
    const componentId = uniqueId(
      `view_${card.widget_id}_${card.card_id}`,
      seenIds,
    );
    dataBindings.push(cardBinding(card, bindingId));
    components.push(
      componentForCard(card, componentId, bindingId, componentActions),
    );
    for (
      const suggestion of card.generation_hints?.suggested_components || []
    ) {
      if (components.length >= maxComponents) break;
      const suggested = componentForSuggestion({
        suggestion,
        bindingId,
        fallbackTitle: card.card_label,
        actionIds: componentActions,
        seenIds,
      });
      if (suggested) components.push(suggested);
    }
    rationale.push(
      `Used ${card.card_label} from ${card.app_name} because it matched the request.`,
    );
    if (card.generation_hints) {
      rationale.push(`Applied generation hints from ${card.card_label}.`);
    }
  }

  for (
    const source of selectedContextSources.slice(
      0,
      Math.max(0, maxComponents - components.length),
    )
  ) {
    const bindingId = uniqueId(`context_${source.id}`, seenIds);
    const componentId = uniqueId(`context_view_${source.id}`, seenIds);
    dataBindings.push(contextBinding(source, bindingId, prompt));
    components.push(componentForDataBinding({
      id: componentId,
      bindingId,
      title: source.label,
      description: source.description,
      actionIds: componentActions,
      kind: preferredDataKind(source.generationHints),
    }));
    addPermission(permissions, {
      kind: "read_context_source",
      access: "read",
      app_id: source.appId,
      app_slug: source.appSlug,
      context_source_id: source.id,
      reason: `Read ${source.label} for the generated interface.`,
    });
    rationale.push(`Added ${source.label} as searchable D1/context data.`);
    if (source.generationHints) {
      rationale.push(`Applied context generation hints from ${source.label}.`);
    }
  }

  for (
    const selected of readFunctions.slice(
      0,
      Math.max(0, maxComponents - components.length),
    )
  ) {
    const bindingId = uniqueId(`read_${selected.name}`, seenIds);
    const componentId = uniqueId(`read_view_${selected.name}`, seenIds);
    dataBindings.push(mcpReadBinding(selected, bindingId));
    components.push(componentForDataBinding({
      id: componentId,
      bindingId,
      title: selected.fn.description || selected.fn.fnName,
      actionIds: componentActions,
      kind: preferredDataKind(selected.fn.generationHints),
    }));
    addPermission(permissions, {
      kind: "call_mcp_function",
      access: "read",
      app_id: selected.fn.appId,
      app_slug: selected.fn.appSlug,
      function_name: selected.fn.fnName,
      reason: selected.fn.description,
    });
    rationale.push(`Bound ${selected.name} as a read function for live data.`);
    if (selected.fn.generationHints) {
      rationale.push(
        `Applied function generation hints from ${selected.name}.`,
      );
    }
  }

  if (components.length < maxComponents) {
    const firstWidget = Array.from(widgetTargets.values())[0];
    if (firstWidget) {
      components.push({
        id: uniqueId(`embed_${firstWidget.widget_id}`, seenIds),
        kind: "widget_embed",
        title: firstWidget.label,
        app_id: firstWidget.app_id,
        app_slug: firstWidget.app_slug,
        widget_id: firstWidget.widget_id,
      });
      rationale.push(
        `Embedded ${firstWidget.label} so the clickable widget remains available.`,
      );
    }
  }

  if (dataBindings.length > 0) {
    const refreshActionId = uniqueId("refresh_interface_data", seenIds);
    actions.push({
      id: refreshActionId,
      kind: "refresh_binding",
      label: "Refresh data",
      mode: "read",
      confirmation: "none",
      binding_ids: dataBindings.map((binding) => binding.id),
    });
  }

  if (actions.length > 0 && components.length < maxComponents) {
    components.push({
      id: uniqueId("interface_actions", seenIds),
      kind: "action_bar",
      title: "Actions",
      action_ids: actions.map((action) => action.id),
    });
  }

  if (components.length === 0) {
    components.push({
      id: uniqueId("empty_state", seenIds),
      kind: "text",
      title: "No matching interface parts",
      text:
        "No installed command cards, widgets, context sources, or MCP functions matched this request yet.",
    });
    warnings.push({
      code: "no_matching_inventory",
      message: "No installed interface inventory matched the prompt.",
    });
  }

  if (inventory.surfaces.length === 0) {
    warnings.push({
      code: "no_command_surfaces",
      message:
        "No installed Command widgets or cards were available to the planner.",
    });
  }

  const spec: AgenticInterfaceSpec = {
    id: uniqueId(`interface_${prompt}`, new Set()),
    title: humanizeTitle(prompt),
    description: prompt,
    mode,
    intent: prompt,
    scope: {
      app_ids: [
        ...new Set([
          ...dataBindings.map((binding) =>
            "app_id" in binding ? binding.app_id : ""
          ),
          ...actions.map((action) =>
            "app_id" in action ? action.app_id || "" : ""
          ),
        ].filter(Boolean)),
      ],
      app_slugs: [
        ...new Set([
          ...dataBindings.map((binding) =>
            "app_slug" in binding ? binding.app_slug || "" : ""
          ),
          ...actions.map((action) =>
            "app_slug" in action ? action.app_slug || "" : ""
          ),
        ].filter(Boolean)),
      ],
      widget_ids: [
        ...new Set([
          ...components.map((component) =>
            "widget_id" in component ? component.widget_id : ""
          ),
          ...actions.map((action) =>
            "widget_id" in action ? action.widget_id || "" : ""
          ),
        ].filter(Boolean)),
      ],
      context_source_ids: selectedContextSources.map((source) => source.id),
      function_names: selectedFunctions.map((entry) => entry.fn.fnName),
    },
    components: components.slice(0, maxComponents),
    ...(dataBindings.length > 0 ? { data_bindings: dataBindings } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(permissions.length > 0 ? { permissions } : {}),
    provenance: {
      prompt,
      generated_at: now().toISOString(),
      planner_model: AGENTIC_INTERFACE_PLANNER_VERSION,
      inventory_updated_at: fnIndex.updatedAt || inventory.updated_at || null,
      source: "command",
    },
    version: 1,
  };

  const validation = validateAgenticInterfaceSpec(spec);
  const combinedWarnings = buildWarnings(warnings, validation);
  if (combinedWarnings.length > 0) spec.warnings = combinedWarnings;
  const verification = verifyAgenticInterfaceSpec(spec, {
    fnIndex,
    inventory,
    options: { maxComponents },
  });

  const contextSummary = buildAgenticInterfacePlannerContextSummary({
    inventory,
    functions: fnIndex.functions,
    contextSources: fnIndex.contextSources,
    dashboards: options.dashboards,
    dataPreview: options.dataPreview || null,
  });

  if ((options.dashboards || []).length > 0) {
    rationale.push(
      `Considered ${
        (options.dashboards || []).length
      } saved Command dashboard(s).`,
    );
  }
  if (options.dataPreview && options.dataPreview.rowCount > 0) {
    rationale.push(
      `Included a safe read-only D1 preview with ${options.dataPreview.rowCount} row(s).`,
    );
  }
  if (rationale.length === 0) {
    rationale.push(
      "Built a draft from the available typed inventory without persisting it.",
    );
  }

  return {
    draft_spec: spec,
    normalized_spec: verification.spec,
    validation: verification.validation,
    verification,
    rationale,
    warnings: verification.warnings,
    dropped: verification.dropped,
    planner: {
      version: AGENTIC_INTERFACE_PLANNER_VERSION,
      policy: buildAgenticInterfacePlannerSystemPrompt(),
      context_summary: contextSummary,
    },
    inventory: {
      surfaces_considered: inventory.surfaces.length,
      functions_considered: selectedFunctions.length,
      context_sources_considered: selectedContextSources.length,
      saved_dashboards_considered: (options.dashboards || []).length,
      ...(options.dataPreview
        ? { data_preview_rows: options.dataPreview.rowCount }
        : {}),
    },
    ...(options.dataPreview
      ? {
        data_preview: {
          context: options.dataPreview.context.slice(0, MAX_DATA_PREVIEW_CHARS),
          sourceCount: options.dataPreview.sourceCount,
          rowCount: options.dataPreview.rowCount,
          errors: options.dataPreview.errors,
        },
      }
      : {}),
    persisted: false,
  };
}

export async function planAgenticInterface(
  userId: string,
  input: AgenticInterfacePlannerInput = {},
  dependencies: AgenticInterfacePlannerDependencies = {},
): Promise<AgenticInterfacePlannerResult> {
  const prompt = normalizePrompt(input);
  const maxComponents = normalizeMaxComponents(
    input.max_components ?? input.limit,
  );
  const fnIndex =
    await (dependencies.getFunctionIndex || defaultGetOrRebuildFunctionIndex)(
      userId,
    );
  const inventory = await (dependencies.getCommandSurfaceInventory ||
    defaultGetCommandSurfaceInventory)(
      userId,
      {
        query: prompt,
        surfaces: ["command_card", "widget"],
        limit: Math.max(12, maxComponents * 3),
        app_id: input.app_id,
        app_ids: input.app_ids,
        app_slug: input.app_slug,
        app_slugs: input.app_slugs,
        app_scope: input.app_scope,
      },
    );

  let dashboards: CommandDashboardSummary[] = [];
  const plannerWarnings: AgenticInterfaceWarning[] = [];
  try {
    dashboards = (await (dependencies.listDashboards ||
      defaultListCommandDashboardLayouts)(userId))
      .dashboards;
  } catch (err) {
    plannerWarnings.push({
      code: "saved_dashboard_context_unavailable",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const scope = normalizeScope(input);
  const selectedContextSources = selectContextSources(
    fnIndex,
    prompt,
    scope,
    3,
  );
  let dataPreview: ContextSourceMagnifyResult | null = null;
  if (
    input.include_data_preview === true && selectedContextSources.length > 0
  ) {
    try {
      dataPreview = await (dependencies.magnifyContextSources ||
        defaultMagnifyContextSources)(
          selectedContextSources,
          {
            userId,
            query: prompt,
            maxSources: 3,
            maxRowsPerSource: 5,
            maxChars: MAX_DATA_PREVIEW_CHARS,
          },
        );
    } catch (err) {
      plannerWarnings.push({
        code: "data_preview_unavailable",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = buildAgenticInterfacePlanFromInventory(
    fnIndex,
    inventory,
    input,
    {
      dashboards,
      dataPreview,
      now: dependencies.now,
    },
  );

  if (plannerWarnings.length === 0) return result;
  const warnings = [...plannerWarnings, ...result.warnings];
  const draft = { ...result.draft_spec, warnings };
  const normalized = { ...result.normalized_spec, warnings };
  const validation = validateAgenticInterfaceSpec(normalized);
  const verification = {
    ...result.verification,
    spec: normalized,
    validation,
    warnings,
    verified: validation.valid,
  };
  return {
    ...result,
    draft_spec: draft,
    normalized_spec: normalized,
    validation,
    verification,
    warnings,
  };
}

export function buildAgenticInterfacePlanFromFunctionIndex(
  fnIndex: FunctionIndex,
  input: AgenticInterfacePlannerInput = {},
  options: BuildAgenticInterfacePlanOptions = {},
): AgenticInterfacePlannerResult {
  const prompt = normalizePrompt(input);
  const inventory = flattenCommandSurfaceInventory(fnIndex, {
    query: prompt,
    surfaces: ["command_card", "widget"],
    limit: Math.max(
      12,
      normalizeMaxComponents(input.max_components ?? input.limit) * 3,
    ),
    app_id: input.app_id,
    app_ids: input.app_ids,
    app_slug: input.app_slug,
    app_slugs: input.app_slugs,
    app_scope: input.app_scope,
  });
  return buildAgenticInterfacePlanFromInventory(
    fnIndex,
    inventory,
    input,
    options,
  );
}
