import type {
  WidgetActionMode,
  WidgetConfirmationPolicy,
  WidgetDataRef,
} from "./widget.ts";

export type AgenticInterfaceMode = "temporary" | "saved";

export type AgenticInterfaceComponentKind =
  | "metric"
  | "list"
  | "table"
  | "detail"
  | "form"
  | "action_bar"
  | "timeline"
  | "card_ref"
  | "widget_embed"
  | "routine_panel"
  | "text";

export type AgenticInterfaceDataBindingSource =
  | "command_card"
  | "context_source"
  | "mcp_read_function"
  | "literal";

export type AgenticInterfaceActionKind =
  | "widget_action"
  | "mcp_function"
  | "open_widget"
  | "refresh_binding"
  | "select_entity";

export type AgenticInterfacePermissionKind =
  | "read_context_source"
  | "call_mcp_function"
  | "invoke_widget_action"
  | "open_widget";

export interface AgenticInterfaceScope {
  app_ids?: string[];
  app_slugs?: string[];
  widget_ids?: string[];
  context_source_ids?: string[];
  function_names?: string[];
}

export interface AgenticInterfaceLayoutItem {
  component_id: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface AgenticInterfaceLayout {
  columns?: number;
  items?: AgenticInterfaceLayoutItem[];
}

export interface AgenticInterfaceField {
  id: string;
  label: string;
  type?:
    | "string"
    | "number"
    | "boolean"
    | "select"
    | "textarea"
    | "date"
    | "datetime";
  description?: string;
  required?: boolean;
  default_value?: unknown;
  options?: Array<{ label: string; value: string | number | boolean }>;
  data_ref?: WidgetDataRef;
}

export interface AgenticInterfaceColumn {
  id: string;
  label: string;
  field?: string;
  data_ref?: WidgetDataRef;
  width?: number;
}

export interface AgenticInterfaceComponentBase {
  id: string;
  kind: AgenticInterfaceComponentKind;
  title?: string;
  description?: string;
  data_binding_id?: string;
  action_ids?: string[];
  data_refs?: WidgetDataRef[];
  layout?: AgenticInterfaceLayoutItem;
  state?: Record<string, unknown>;
}

export interface AgenticInterfaceMetricComponent
  extends AgenticInterfaceComponentBase {
  kind: "metric";
  metric_field?: string;
  label_field?: string;
  suffix?: string;
}

export interface AgenticInterfaceListComponent
  extends AgenticInterfaceComponentBase {
  kind: "list";
  primary_field?: string;
  secondary_field?: string;
  trailing_field?: string;
  max_items?: number;
}

export interface AgenticInterfaceTableComponent
  extends AgenticInterfaceComponentBase {
  kind: "table";
  columns?: AgenticInterfaceColumn[];
  selectable?: boolean;
}

export interface AgenticInterfaceDetailComponent
  extends AgenticInterfaceComponentBase {
  kind: "detail";
  fields?: AgenticInterfaceField[];
  entity_ref?: WidgetDataRef;
}

export interface AgenticInterfaceFormComponent
  extends AgenticInterfaceComponentBase {
  kind: "form";
  fields: AgenticInterfaceField[];
  submit_action_id?: string;
}

export interface AgenticInterfaceActionBarComponent
  extends AgenticInterfaceComponentBase {
  kind: "action_bar";
  action_ids: string[];
}

export interface AgenticInterfaceTimelineComponent
  extends AgenticInterfaceComponentBase {
  kind: "timeline";
  time_field?: string;
  title_field?: string;
  subtitle_field?: string;
}

export interface AgenticInterfaceCardRefComponent
  extends AgenticInterfaceComponentBase {
  kind: "card_ref";
  app_id: string;
  app_slug?: string;
  widget_id: string;
  card_id: string;
  size?: string;
}

export interface AgenticInterfaceWidgetEmbedComponent
  extends AgenticInterfaceComponentBase {
  kind: "widget_embed";
  app_id: string;
  app_slug?: string;
  widget_id: string;
  context?: Record<string, string>;
}

export interface AgenticInterfaceRoutinePanelComponent
  extends AgenticInterfaceComponentBase {
  kind: "routine_panel";
  routine_ids?: string[];
  template_ids?: string[];
}

export interface AgenticInterfaceTextComponent
  extends AgenticInterfaceComponentBase {
  kind: "text";
  text: string;
}

export type AgenticInterfaceComponent =
  | AgenticInterfaceMetricComponent
  | AgenticInterfaceListComponent
  | AgenticInterfaceTableComponent
  | AgenticInterfaceDetailComponent
  | AgenticInterfaceFormComponent
  | AgenticInterfaceActionBarComponent
  | AgenticInterfaceTimelineComponent
  | AgenticInterfaceCardRefComponent
  | AgenticInterfaceWidgetEmbedComponent
  | AgenticInterfaceRoutinePanelComponent
  | AgenticInterfaceTextComponent;

export interface AgenticInterfaceDataBindingBase {
  id: string;
  source: AgenticInterfaceDataBindingSource;
  label?: string;
  description?: string;
  refresh_interval_s?: number;
}

export interface AgenticCommandCardDataBinding
  extends AgenticInterfaceDataBindingBase {
  source: "command_card";
  app_id: string;
  app_slug?: string;
  widget_id: string;
  card_id: string;
  data_view?: string;
  data_function?: string;
}

export interface AgenticContextSourceDataBinding
  extends AgenticInterfaceDataBindingBase {
  source: "context_source";
  app_id: string;
  app_slug?: string;
  context_source_id: string;
  query?: string;
  max_rows?: number;
}

export interface AgenticMcpReadFunctionDataBinding
  extends AgenticInterfaceDataBindingBase {
  source: "mcp_read_function";
  app_id: string;
  app_slug?: string;
  function_name: string;
  args?: Record<string, unknown>;
}

export interface AgenticLiteralDataBinding
  extends AgenticInterfaceDataBindingBase {
  source: "literal";
  value: unknown;
}

export type AgenticInterfaceDataBinding =
  | AgenticCommandCardDataBinding
  | AgenticContextSourceDataBinding
  | AgenticMcpReadFunctionDataBinding
  | AgenticLiteralDataBinding;

export interface AgenticInterfaceActionBase {
  id: string;
  kind: AgenticInterfaceActionKind;
  label: string;
  description?: string;
  mode: WidgetActionMode;
  confirmation?: WidgetConfirmationPolicy;
  args_schema?: Record<string, unknown>;
  args_template?: Record<string, unknown>;
  expected_result?: string;
}

export interface AgenticWidgetActionBinding extends AgenticInterfaceActionBase {
  kind: "widget_action";
  app_id?: string;
  app_slug?: string;
  widget_id: string;
  action_id: string;
  surface_id?: string;
}

export interface AgenticMcpFunctionActionBinding
  extends AgenticInterfaceActionBase {
  kind: "mcp_function";
  app_id: string;
  app_slug?: string;
  function_name: string;
}

export interface AgenticOpenWidgetActionBinding
  extends AgenticInterfaceActionBase {
  kind: "open_widget";
  app_id: string;
  app_slug?: string;
  widget_id: string;
  context?: Record<string, string>;
}

export interface AgenticRefreshBindingAction
  extends AgenticInterfaceActionBase {
  kind: "refresh_binding";
  binding_ids: string[];
}

export interface AgenticSelectEntityAction extends AgenticInterfaceActionBase {
  kind: "select_entity";
  data_ref?: WidgetDataRef;
  component_id?: string;
}

export type AgenticInterfaceAction =
  | AgenticWidgetActionBinding
  | AgenticMcpFunctionActionBinding
  | AgenticOpenWidgetActionBinding
  | AgenticRefreshBindingAction
  | AgenticSelectEntityAction;

export interface AgenticInterfacePermission {
  kind: AgenticInterfacePermissionKind;
  access: WidgetActionMode;
  app_id?: string;
  app_slug?: string;
  function_name?: string;
  widget_id?: string;
  action_id?: string;
  context_source_id?: string;
  reason?: string;
}

export interface AgenticInterfaceProvenance {
  prompt?: string;
  generated_at?: string;
  planner_model?: string;
  inventory_updated_at?: string | null;
  source?: "command" | "widget" | "system";
}

export interface AgenticInterfaceWarning {
  code: string;
  message: string;
  path?: string;
}

export interface AgenticInterfaceSpec {
  id: string;
  title: string;
  description?: string;
  mode: AgenticInterfaceMode;
  intent?: string;
  scope?: AgenticInterfaceScope;
  layout?: AgenticInterfaceLayout;
  components: AgenticInterfaceComponent[];
  data_bindings?: AgenticInterfaceDataBinding[];
  actions?: AgenticInterfaceAction[];
  permissions?: AgenticInterfacePermission[];
  provenance?: AgenticInterfaceProvenance;
  warnings?: AgenticInterfaceWarning[];
  version?: number;
}

export interface AgenticInterfaceValidationIssue {
  path: string;
  message: string;
}

export interface AgenticInterfaceValidationResult {
  valid: boolean;
  spec?: AgenticInterfaceSpec;
  errors: AgenticInterfaceValidationIssue[];
  warnings: AgenticInterfaceWarning[];
}

export type AgenticInterfaceDroppedItemKind =
  | "data_binding"
  | "action"
  | "component"
  | "layout"
  | "permission"
  | "field"
  | "column"
  | "warning";

export interface AgenticInterfaceDroppedItem {
  kind: AgenticInterfaceDroppedItemKind;
  path: string;
  reason: string;
  id?: string;
}

export interface AgenticInterfaceVerificationResult {
  verified: boolean;
  spec: AgenticInterfaceSpec;
  validation: AgenticInterfaceValidationResult;
  warnings: AgenticInterfaceWarning[];
  dropped: AgenticInterfaceDroppedItem[];
}

const COMPONENT_KINDS = new Set<AgenticInterfaceComponentKind>([
  "metric",
  "list",
  "table",
  "detail",
  "form",
  "action_bar",
  "timeline",
  "card_ref",
  "widget_embed",
  "routine_panel",
  "text",
]);

const DATA_BINDING_SOURCES = new Set<AgenticInterfaceDataBindingSource>([
  "command_card",
  "context_source",
  "mcp_read_function",
  "literal",
]);

const ACTION_KINDS = new Set<AgenticInterfaceActionKind>([
  "widget_action",
  "mcp_function",
  "open_widget",
  "refresh_binding",
  "select_entity",
]);

const ACTION_MODES = new Set<WidgetActionMode>(["read", "write", "ui"]);
const CONFIRMATION_POLICIES = new Set<WidgetConfirmationPolicy>([
  "none",
  "user",
  "high_risk",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(
  value: unknown,
  path: string,
  errors: AgenticInterfaceValidationIssue[],
) {
  if (value !== undefined && typeof value !== "string") {
    errors.push({ path, message: "must be a string" });
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: AgenticInterfaceValidationIssue[],
  options: { required?: boolean; nonEmpty?: boolean } = {},
): string[] {
  if (value === undefined) {
    if (options.required) errors.push({ path, message: "is required" });
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array of strings" });
    return [];
  }
  const strings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isNonEmptyString(entry)) {
      errors.push({
        path: `${path}.${index}`,
        message: "must be a non-empty string",
      });
      continue;
    }
    strings.push(entry.trim());
  }
  if (options.nonEmpty && strings.length === 0) {
    errors.push({ path, message: "must contain at least one string" });
  }
  return strings;
}

function validateObjectArray(
  value: unknown,
  path: string,
  errors: AgenticInterfaceValidationIssue[],
): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push({ path: `${path}.${index}`, message: "must be an object" });
      continue;
    }
    records.push(entry);
  }
  return records;
}

function validateUniqueId(
  id: unknown,
  path: string,
  seen: Set<string>,
  label: string,
  errors: AgenticInterfaceValidationIssue[],
): string | null {
  if (!isNonEmptyString(id)) {
    errors.push({ path, message: "id is required and must be a string" });
    return null;
  }
  const normalized = id.trim();
  if (seen.has(normalized)) {
    errors.push({ path, message: `duplicate ${label} id "${normalized}"` });
    return normalized;
  }
  seen.add(normalized);
  return normalized;
}

function validateCommonComponentFields(
  component: Record<string, unknown>,
  path: string,
  dataBindingIds: Set<string>,
  actionIds: Set<string>,
  errors: AgenticInterfaceValidationIssue[],
) {
  optionalString(component.title, `${path}.title`, errors);
  optionalString(component.description, `${path}.description`, errors);
  if (component.data_binding_id !== undefined) {
    if (!isNonEmptyString(component.data_binding_id)) {
      errors.push({
        path: `${path}.data_binding_id`,
        message: "must be a non-empty string",
      });
    } else if (!dataBindingIds.has(component.data_binding_id.trim())) {
      errors.push({
        path: `${path}.data_binding_id`,
        message: `unknown data binding "${component.data_binding_id.trim()}"`,
      });
    }
  }
  for (
    const actionId of validateStringArray(
      component.action_ids,
      `${path}.action_ids`,
      errors,
    )
  ) {
    if (!actionIds.has(actionId)) {
      errors.push({
        path: `${path}.action_ids`,
        message: `unknown action "${actionId}"`,
      });
    }
  }
}

function validateDataBindings(
  value: unknown,
  errors: AgenticInterfaceValidationIssue[],
): Set<string> {
  const ids = new Set<string>();
  const bindings = validateObjectArray(value, "data_bindings", errors);
  bindings.forEach((binding, index) => {
    const path = `data_bindings.${index}`;
    const id = validateUniqueId(
      binding.id,
      `${path}.id`,
      ids,
      "data binding",
      errors,
    );
    if (
      !DATA_BINDING_SOURCES.has(
        binding.source as AgenticInterfaceDataBindingSource,
      )
    ) {
      errors.push({
        path: `${path}.source`,
        message: `source must be one of: ${
          Array.from(DATA_BINDING_SOURCES).join(", ")
        }`,
      });
    }
    optionalString(binding.label, `${path}.label`, errors);
    optionalString(binding.description, `${path}.description`, errors);
    if (
      binding.refresh_interval_s !== undefined &&
      (typeof binding.refresh_interval_s !== "number" ||
        !Number.isFinite(binding.refresh_interval_s) ||
        binding.refresh_interval_s < 0)
    ) {
      errors.push({
        path: `${path}.refresh_interval_s`,
        message: "must be a non-negative number",
      });
    }

    switch (binding.source) {
      case "command_card":
        for (const key of ["app_id", "widget_id", "card_id"]) {
          if (!isNonEmptyString(binding[key])) {
            errors.push({
              path: `${path}.${key}`,
              message: "is required and must be a string",
            });
          }
        }
        optionalString(binding.app_slug, `${path}.app_slug`, errors);
        optionalString(binding.data_view, `${path}.data_view`, errors);
        optionalString(binding.data_function, `${path}.data_function`, errors);
        break;
      case "context_source":
        for (const key of ["app_id", "context_source_id"]) {
          if (!isNonEmptyString(binding[key])) {
            errors.push({
              path: `${path}.${key}`,
              message: "is required and must be a string",
            });
          }
        }
        optionalString(binding.app_slug, `${path}.app_slug`, errors);
        optionalString(binding.query, `${path}.query`, errors);
        if (
          binding.max_rows !== undefined &&
          (typeof binding.max_rows !== "number" ||
            !Number.isFinite(binding.max_rows) ||
            binding.max_rows < 0)
        ) {
          errors.push({
            path: `${path}.max_rows`,
            message: "must be a non-negative number",
          });
        }
        break;
      case "mcp_read_function":
        for (const key of ["app_id", "function_name"]) {
          if (!isNonEmptyString(binding[key])) {
            errors.push({
              path: `${path}.${key}`,
              message: "is required and must be a string",
            });
          }
        }
        optionalString(binding.app_slug, `${path}.app_slug`, errors);
        if (binding.args !== undefined && !isRecord(binding.args)) {
          errors.push({ path: `${path}.args`, message: "must be an object" });
        }
        break;
      case "literal":
        if (!id) break;
        if (!("value" in binding)) {
          errors.push({
            path: `${path}.value`,
            message: "is required for literal data bindings",
          });
        }
        break;
    }
  });
  return ids;
}

function validateActions(
  value: unknown,
  errors: AgenticInterfaceValidationIssue[],
  warnings: AgenticInterfaceWarning[],
): Set<string> {
  const ids = new Set<string>();
  const actions = validateObjectArray(value, "actions", errors);
  actions.forEach((action, index) => {
    const path = `actions.${index}`;
    validateUniqueId(action.id, `${path}.id`, ids, "action", errors);
    if (!ACTION_KINDS.has(action.kind as AgenticInterfaceActionKind)) {
      errors.push({
        path: `${path}.kind`,
        message: `kind must be one of: ${Array.from(ACTION_KINDS).join(", ")}`,
      });
    }
    if (!isNonEmptyString(action.label)) {
      errors.push({
        path: `${path}.label`,
        message: "label is required and must be a string",
      });
    }
    optionalString(action.description, `${path}.description`, errors);
    if (!ACTION_MODES.has(action.mode as WidgetActionMode)) {
      errors.push({
        path: `${path}.mode`,
        message: "mode must be one of: read, write, or ui",
      });
    }
    if (
      action.confirmation !== undefined &&
      !CONFIRMATION_POLICIES.has(
        action.confirmation as WidgetConfirmationPolicy,
      )
    ) {
      errors.push({
        path: `${path}.confirmation`,
        message: "confirmation must be one of: none, user, or high_risk",
      });
    }
    if (action.mode === "write" && action.confirmation === "none") {
      errors.push({
        path: `${path}.confirmation`,
        message: 'write actions cannot use confirmation="none"',
      });
    } else if (action.mode === "write" && action.confirmation === undefined) {
      warnings.push({
        code: "write_confirmation_defaulted",
        path: `${path}.confirmation`,
        message: "write actions should declare confirmation user or high_risk",
      });
    }
    if (action.args_schema !== undefined && !isRecord(action.args_schema)) {
      errors.push({
        path: `${path}.args_schema`,
        message: "must be an object",
      });
    }
    if (action.args_template !== undefined && !isRecord(action.args_template)) {
      errors.push({
        path: `${path}.args_template`,
        message: "must be an object",
      });
    }
    optionalString(action.expected_result, `${path}.expected_result`, errors);

    switch (action.kind) {
      case "widget_action":
        for (const key of ["widget_id", "action_id"]) {
          if (!isNonEmptyString(action[key])) {
            errors.push({
              path: `${path}.${key}`,
              message: "is required and must be a string",
            });
          }
        }
        optionalString(action.app_id, `${path}.app_id`, errors);
        optionalString(action.app_slug, `${path}.app_slug`, errors);
        optionalString(action.surface_id, `${path}.surface_id`, errors);
        break;
      case "mcp_function":
        if (action.mode === "ui") {
          errors.push({
            path: `${path}.mode`,
            message: "mcp_function actions cannot use mode ui",
          });
        }
        for (const key of ["app_id", "function_name"]) {
          if (!isNonEmptyString(action[key])) {
            errors.push({
              path: `${path}.${key}`,
              message: "is required and must be a string",
            });
          }
        }
        optionalString(action.app_slug, `${path}.app_slug`, errors);
        break;
      case "open_widget":
        if (action.mode === "write") {
          errors.push({
            path: `${path}.mode`,
            message: "open_widget actions cannot use mode write",
          });
        }
        for (const key of ["app_id", "widget_id"]) {
          if (!isNonEmptyString(action[key])) {
            errors.push({
              path: `${path}.${key}`,
              message: "is required and must be a string",
            });
          }
        }
        optionalString(action.app_slug, `${path}.app_slug`, errors);
        if (action.context !== undefined && !isRecord(action.context)) {
          errors.push({
            path: `${path}.context`,
            message: "must be an object",
          });
        }
        break;
      case "refresh_binding":
        if (action.mode === "write") {
          errors.push({
            path: `${path}.mode`,
            message: "refresh_binding actions cannot use mode write",
          });
        }
        validateStringArray(action.binding_ids, `${path}.binding_ids`, errors, {
          required: true,
          nonEmpty: true,
        });
        break;
      case "select_entity":
        if (action.mode === "write") {
          errors.push({
            path: `${path}.mode`,
            message: "select_entity actions cannot use mode write",
          });
        }
        optionalString(action.component_id, `${path}.component_id`, errors);
        break;
    }
  });
  return ids;
}

function validateComponents(
  value: unknown,
  dataBindingIds: Set<string>,
  actionIds: Set<string>,
  errors: AgenticInterfaceValidationIssue[],
) {
  if (!Array.isArray(value)) {
    errors.push({ path: "components", message: "components must be an array" });
    return;
  }
  const seen = new Set<string>();
  value.forEach((component, index) => {
    const path = `components.${index}`;
    if (!isRecord(component)) {
      errors.push({ path, message: "component must be an object" });
      return;
    }
    validateUniqueId(component.id, `${path}.id`, seen, "component", errors);
    if (!COMPONENT_KINDS.has(component.kind as AgenticInterfaceComponentKind)) {
      errors.push({
        path: `${path}.kind`,
        message: `kind must be one of: ${
          Array.from(COMPONENT_KINDS).join(", ")
        }`,
      });
      return;
    }
    validateCommonComponentFields(
      component,
      path,
      dataBindingIds,
      actionIds,
      errors,
    );

    switch (component.kind) {
      case "form":
        if (!Array.isArray(component.fields) || component.fields.length === 0) {
          errors.push({
            path: `${path}.fields`,
            message: "form components must declare fields",
          });
        }
        if (component.submit_action_id !== undefined) {
          if (!isNonEmptyString(component.submit_action_id)) {
            errors.push({
              path: `${path}.submit_action_id`,
              message: "must be a non-empty string",
            });
          } else if (!actionIds.has(component.submit_action_id.trim())) {
            errors.push({
              path: `${path}.submit_action_id`,
              message: `unknown action "${component.submit_action_id.trim()}"`,
            });
          }
        }
        break;
      case "action_bar":
        validateStringArray(
          component.action_ids,
          `${path}.action_ids`,
          errors,
          {
            required: true,
            nonEmpty: true,
          },
        );
        break;
      case "card_ref":
        for (const key of ["app_id", "widget_id", "card_id"]) {
          if (!isNonEmptyString(component[key])) {
            errors.push({
              path: `${path}.${key}`,
              message: "is required and must be a string",
            });
          }
        }
        optionalString(component.app_slug, `${path}.app_slug`, errors);
        optionalString(component.size, `${path}.size`, errors);
        break;
      case "widget_embed":
        for (const key of ["app_id", "widget_id"]) {
          if (!isNonEmptyString(component[key])) {
            errors.push({
              path: `${path}.${key}`,
              message: "is required and must be a string",
            });
          }
        }
        optionalString(component.app_slug, `${path}.app_slug`, errors);
        if (component.context !== undefined && !isRecord(component.context)) {
          errors.push({
            path: `${path}.context`,
            message: "must be an object",
          });
        }
        break;
      case "text":
        if (!isNonEmptyString(component.text)) {
          errors.push({
            path: `${path}.text`,
            message: "text is required and must be a string",
          });
        }
        break;
    }
  });
}

function validateScope(
  scope: unknown,
  errors: AgenticInterfaceValidationIssue[],
) {
  if (scope === undefined) return;
  if (!isRecord(scope)) {
    errors.push({ path: "scope", message: "scope must be an object" });
    return;
  }
  for (
    const key of [
      "app_ids",
      "app_slugs",
      "widget_ids",
      "context_source_ids",
      "function_names",
    ]
  ) {
    validateStringArray(scope[key], `scope.${key}`, errors);
  }
}

export function validateAgenticInterfaceSpec(
  input: unknown,
): AgenticInterfaceValidationResult {
  const errors: AgenticInterfaceValidationIssue[] = [];
  const warnings: AgenticInterfaceWarning[] = [];

  if (!isRecord(input)) {
    return {
      valid: false,
      errors: [{
        path: "",
        message: "agentic interface spec must be an object",
      }],
      warnings,
    };
  }

  if (!isNonEmptyString(input.id)) {
    errors.push({ path: "id", message: "id is required and must be a string" });
  }
  if (!isNonEmptyString(input.title)) {
    errors.push({
      path: "title",
      message: "title is required and must be a string",
    });
  }
  if (input.mode !== "temporary" && input.mode !== "saved") {
    errors.push({
      path: "mode",
      message: "mode must be one of: temporary, saved",
    });
  }
  optionalString(input.description, "description", errors);
  optionalString(input.intent, "intent", errors);
  validateScope(input.scope, errors);

  const dataBindingIds = validateDataBindings(input.data_bindings, errors);
  const actionIds = validateActions(input.actions, errors, warnings);
  validateComponents(input.components, dataBindingIds, actionIds, errors);

  if (input.permissions !== undefined) {
    for (
      const [index, permission] of validateObjectArray(
        input.permissions,
        "permissions",
        errors,
      )
        .entries()
    ) {
      const path = `permissions.${index}`;
      if (
        permission.kind !== "read_context_source" &&
        permission.kind !== "call_mcp_function" &&
        permission.kind !== "invoke_widget_action" &&
        permission.kind !== "open_widget"
      ) {
        errors.push({
          path: `${path}.kind`,
          message:
            "kind must be one of: read_context_source, call_mcp_function, invoke_widget_action, open_widget",
        });
      }
      if (!ACTION_MODES.has(permission.access as WidgetActionMode)) {
        errors.push({
          path: `${path}.access`,
          message: "access must be one of: read, write, or ui",
        });
      }
    }
  }

  if (input.warnings !== undefined) {
    for (
      const [index, warning] of validateObjectArray(
        input.warnings,
        "warnings",
        errors,
      ).entries()
    ) {
      const path = `warnings.${index}`;
      if (!isNonEmptyString(warning.code)) {
        errors.push({
          path: `${path}.code`,
          message: "code is required and must be a string",
        });
      }
      if (!isNonEmptyString(warning.message)) {
        errors.push({
          path: `${path}.message`,
          message: "message is required and must be a string",
        });
      }
      optionalString(warning.path, `${path}.path`, errors);
    }
  }

  return {
    valid: errors.length === 0,
    ...(errors.length === 0
      ? { spec: input as unknown as AgenticInterfaceSpec }
      : {}),
    errors,
    warnings,
  };
}

export function isAgenticInterfaceSpec(
  input: unknown,
): input is AgenticInterfaceSpec {
  return validateAgenticInterfaceSpec(input).valid;
}
