import {
  type AgenticInterfaceAction,
  type AgenticInterfaceSpec,
  validateAgenticInterfaceSpec,
} from "../../shared/contracts/agentic-interface.ts";
import {
  getCommandSurfaceInventory as defaultGetCommandSurfaceInventory,
  type CommandSurfaceInventory,
} from "./command-surfaces.ts";
import {
  type FunctionIndex,
  getOrRebuildFunctionIndex as defaultGetOrRebuildFunctionIndex,
} from "./function-index.ts";
import { verifyAgenticInterfaceSpec } from "./agentic-interface-validate.ts";

export interface AgenticInterfaceActionRequest {
  spec?: unknown;
  action_id?: unknown;
  args?: unknown;
  confirmed?: unknown;
  surface_id?: unknown;
  turn_id?: unknown;
  component_id?: unknown;
}

export type AgenticInterfaceActionStatus =
  | "ok"
  | "error"
  | "requires_confirmation"
  | "client_action_required";

export interface AgenticInterfaceActionAudit {
  surface_id?: string;
  interface_id: string;
  action_id: string;
  turn_id: string;
  component_id?: string;
}

export interface AgenticInterfaceActionResult {
  spec_id: string;
  action_id: string;
  kind: AgenticInterfaceAction["kind"];
  mode: AgenticInterfaceAction["mode"];
  confirmation: AgenticInterfaceAction["confirmation"];
  status: AgenticInterfaceActionStatus;
  result?: unknown;
  error?: string;
  refreshed_binding_ids?: string[];
  open_widget?: {
    app_id: string;
    app_slug?: string;
    widget_id: string;
    context?: Record<string, string>;
  };
  widget_action?: {
    app_id?: string;
    app_slug?: string;
    widget_id: string;
    action_id: string;
    surface_id?: string;
    args: Record<string, unknown>;
  };
  selected_entity?: {
    component_id?: string;
    args: Record<string, unknown>;
  };
  audit: AgenticInterfaceActionAudit;
  executed_at: string;
}

export interface AgenticInterfaceActionDependencies {
  getFunctionIndex?: (userId: string) => Promise<FunctionIndex>;
  getCommandSurfaceInventory?: (userId: string) => Promise<CommandSurfaceInventory>;
  executeAppFunction?: (
    input: {
      appId: string;
      appSlug?: string;
      functionName: string;
      args?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  executeWidgetAction?: (
    input: {
      appId?: string;
      appSlug?: string;
      widgetId: string;
      actionId: string;
      surfaceId?: string;
      args: Record<string, unknown>;
      audit: AgenticInterfaceActionAudit;
    },
  ) => Promise<unknown>;
  now?: () => Date;
  randomUUID?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inputArgs(action: AgenticInterfaceAction, args: unknown): Record<string, unknown> {
  return {
    ...(isRecord(action.args_template) ? action.args_template : {}),
    ...(isRecord(args) ? args : {}),
  };
}

function buildToolName(appSlug: string | undefined, functionName: string): string {
  return appSlug ? `${appSlug}_${functionName}` : functionName;
}

function requiresConfirmation(action: AgenticInterfaceAction): boolean {
  return action.mode === "write" && action.confirmation !== "none";
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

function auditArgs(
  args: Record<string, unknown>,
  audit: AgenticInterfaceActionAudit,
): Record<string, unknown> {
  return {
    ...args,
    _agentic_surface_action: true,
    _agentic_surface_id: audit.surface_id,
    _agentic_interface_id: audit.interface_id,
    _agentic_action_id: audit.action_id,
    _agentic_turn_id: audit.turn_id,
    _agentic_component_id: audit.component_id,
  };
}

export async function executeAgenticInterfaceAction(
  userId: string,
  input: AgenticInterfaceActionRequest,
  dependencies: AgenticInterfaceActionDependencies = {},
): Promise<AgenticInterfaceActionResult> {
  const validation = validateAgenticInterfaceSpec(input.spec);
  if (!validation.valid || !validation.spec) {
    throw new Error(
      validation.errors[0]?.message || "Invalid agentic interface spec",
    );
  }

  const spec = validation.spec as AgenticInterfaceSpec;
  const actionId = optionalString(input.action_id);
  if (!actionId) throw new Error("Missing action_id");

  const fnIndex = await (dependencies.getFunctionIndex ||
    defaultGetOrRebuildFunctionIndex)(userId);
  const inventory = await (dependencies.getCommandSurfaceInventory ||
    defaultGetCommandSurfaceInventory)(userId);
  const verification = verifyAgenticInterfaceSpec(spec, { fnIndex, inventory });
  const verifiedSpec = verification.spec;
  const action = (verifiedSpec.actions || []).find((entry) =>
    entry.id === actionId
  );
  if (!action) {
    throw new Error(`Action ${actionId} is not available on this interface`);
  }

  const now = dependencies.now || (() => new Date());
  const turnId = optionalString(input.turn_id) ||
    (dependencies.randomUUID || (() => crypto.randomUUID()))();
  const audit: AgenticInterfaceActionAudit = {
    ...(optionalString(input.surface_id)
      ? { surface_id: optionalString(input.surface_id) }
      : {}),
    interface_id: verifiedSpec.id,
    action_id: action.id,
    turn_id: turnId,
    ...(optionalString(input.component_id)
      ? { component_id: optionalString(input.component_id) }
      : {}),
  };
  const executedAt = now().toISOString();
  const base = {
    spec_id: verifiedSpec.id,
    action_id: action.id,
    kind: action.kind,
    mode: action.mode,
    confirmation: action.confirmation,
    audit,
    executed_at: executedAt,
  };

  if (requiresConfirmation(action) && input.confirmed !== true) {
    return {
      ...base,
      status: "requires_confirmation",
      error: `${action.label} requires ${action.confirmation || "user"} confirmation.`,
    };
  }

  const args = inputArgs(action, input.args);

  try {
    switch (action.kind) {
      case "mcp_function": {
        if (!dependencies.executeAppFunction) {
          throw new Error("App function execution is not configured");
        }
        const raw = await dependencies.executeAppFunction({
          appId: action.app_id,
          appSlug: action.app_slug,
          functionName: buildToolName(action.app_slug, action.function_name),
          args: auditArgs(args, audit),
        });
        return {
          ...base,
          status: "ok",
          result: normalizePayload(raw),
        };
      }
      case "widget_action": {
        const widgetAction = {
          app_id: action.app_id,
          app_slug: action.app_slug,
          widget_id: action.widget_id,
          action_id: action.action_id,
          surface_id: action.surface_id || audit.surface_id,
          args,
        };
        if (!dependencies.executeWidgetAction) {
          return {
            ...base,
            status: "client_action_required",
            widget_action: widgetAction,
          };
        }
        const result = await dependencies.executeWidgetAction({
          appId: action.app_id,
          appSlug: action.app_slug,
          widgetId: action.widget_id,
          actionId: action.action_id,
          surfaceId: action.surface_id || audit.surface_id,
          args,
          audit,
        });
        return {
          ...base,
          status: "ok",
          widget_action: widgetAction,
          result: normalizePayload(result),
        };
      }
      case "open_widget":
        return {
          ...base,
          status: "ok",
          open_widget: {
            app_id: action.app_id,
            app_slug: action.app_slug,
            widget_id: action.widget_id,
            context: action.context,
          },
        };
      case "refresh_binding":
        return {
          ...base,
          status: "ok",
          refreshed_binding_ids: action.binding_ids || [],
        };
      case "select_entity":
        return {
          ...base,
          status: "ok",
          selected_entity: {
            component_id: action.component_id,
            args,
          },
        };
      default:
        return {
          ...base,
          status: "error",
          error: "Unsupported generated interface action.",
        };
    }
  } catch (err) {
    return {
      ...base,
      status: "error",
      error: err instanceof Error
        ? err.message
        : "Generated interface action failed.",
    };
  }
}
