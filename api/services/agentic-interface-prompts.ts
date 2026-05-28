import type { ContextSourceMagnifyResult } from "./app-context-magnifier.ts";
import type { CommandDashboardSummary } from "./command-dashboard.ts";
import type { CommandSurfaceInventory } from "./command-surfaces.ts";
import type { FunctionIndex } from "./function-index.ts";
import type { WidgetGenerationHints } from "../../shared/contracts/widget.ts";

export const AGENTIC_INTERFACE_PLANNER_VERSION = "agentic-interface-planner-v1";

export function buildAgenticInterfacePlannerSystemPrompt(): string {
  return [
    "Generate only typed AgenticInterfaceSpec JSON.",
    "Do not generate raw HTML, React, CSS, DOM selectors, scripts, or iframes.",
    "Use command_card, context_source, mcp_read_function, and literal data bindings only.",
    "Use widget_action, mcp_function, open_widget, refresh_binding, and select_entity actions only.",
    "Write actions must require user or high_risk confirmation.",
    "Prefer installed Command cards and widgets before inventing new views.",
    "Never persist the interface during planning; persistence is a later explicit user action.",
  ].join("\n");
}

export interface AgenticInterfacePlannerContextSummary {
  surfaces: string[];
  functions: string[];
  context_sources: string[];
  saved_dashboards: string[];
  data_preview?: {
    source_count: number;
    row_count: number;
    errors: string[];
  };
}

function oneLine(value: string | null | undefined, max = 120): string {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  return normalized.length > max
    ? `${normalized.slice(0, max - 3)}...`
    : normalized;
}

function hintSummary(hints?: WidgetGenerationHints): string | null {
  if (!hints) return null;
  const parts = [
    hints.tags?.length ? `tags=${hints.tags.join(",")}` : null,
    hints.preferred_component ? `preferred=${hints.preferred_component}` : null,
    hints.entity_types?.length
      ? `entities=${hints.entity_types.join(",")}`
      : null,
    hints.action_group ? `actions=${hints.action_group}` : null,
    hints.prompt_examples?.length
      ? `examples=${hints.prompt_examples.slice(0, 2).join("; ")}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? oneLine(parts.join(" | "), 180) : null;
}

export function buildAgenticInterfacePlannerContextSummary(input: {
  inventory: CommandSurfaceInventory;
  functions: FunctionIndex["functions"];
  contextSources: FunctionIndex["contextSources"];
  dashboards?: CommandDashboardSummary[];
  dataPreview?: ContextSourceMagnifyResult | null;
  maxItems?: number;
}): AgenticInterfacePlannerContextSummary {
  const maxItems = input.maxItems ?? 8;
  return {
    surfaces: input.inventory.surfaces.slice(0, maxItems).map((surface) => {
      if (surface.surface === "command_card") {
        return [
          `card ${surface.app_slug}/${surface.widget_id}/${surface.card_id}`,
          oneLine(surface.card_label),
          surface.kind ? `kind=${surface.kind}` : null,
          surface.data_view ? `view=${surface.data_view}` : null,
          hintSummary(surface.generation_hints),
        ].filter(Boolean).join(" | ");
      }
      return [
        `widget ${surface.app_slug}/${surface.widget_id}`,
        oneLine(surface.widget_label),
        `${surface.cards_count} cards`,
        hintSummary(surface.generation_hints),
      ].filter(Boolean).join(" | ");
    }),
    functions: Object.entries(input.functions).slice(0, maxItems).map((
      [name, fn],
    ) =>
      [
        `codemode.${name}`,
        `${fn.appSlug}/${fn.fnName}`,
        oneLine(fn.description),
        hintSummary(fn.generationHints),
      ].filter(Boolean).join(" | ")
    ),
    context_sources: input.contextSources.slice(0, maxItems).map((source) =>
      [
        `${source.appSlug}/${source.id}`,
        source.type,
        oneLine(source.label),
        hintSummary(source.generationHints),
      ].filter(Boolean).join(" | ")
    ),
    saved_dashboards: (input.dashboards || []).slice(0, maxItems).map((
      dashboard,
    ) =>
      [
        dashboard.dashboard_key,
        oneLine(dashboard.title),
        `${dashboard.card_count} cards`,
      ].join(" | ")
    ),
    ...(input.dataPreview
      ? {
        data_preview: {
          source_count: input.dataPreview.sourceCount,
          row_count: input.dataPreview.rowCount,
          errors: input.dataPreview.errors,
        },
      }
      : {}),
  };
}
