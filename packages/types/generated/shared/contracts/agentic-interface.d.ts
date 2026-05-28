import type { WidgetActionMode, WidgetConfirmationPolicy, WidgetDataRef } from "./widget.ts";
export type AgenticInterfaceMode = "temporary" | "saved";
export type AgenticInterfaceComponentKind = "metric" | "list" | "table" | "detail" | "form" | "action_bar" | "timeline" | "card_ref" | "widget_embed" | "routine_panel" | "text";
export type AgenticInterfaceDataBindingSource = "command_card" | "context_source" | "mcp_read_function" | "literal";
export type AgenticInterfaceActionKind = "widget_action" | "mcp_function" | "open_widget" | "refresh_binding" | "select_entity";
export type AgenticInterfacePermissionKind = "read_context_source" | "call_mcp_function" | "invoke_widget_action" | "open_widget";
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
    type?: "string" | "number" | "boolean" | "select" | "textarea" | "date" | "datetime";
    description?: string;
    required?: boolean;
    default_value?: unknown;
    options?: Array<{
        label: string;
        value: string | number | boolean;
    }>;
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
export interface AgenticInterfaceMetricComponent extends AgenticInterfaceComponentBase {
    kind: "metric";
    metric_field?: string;
    label_field?: string;
    suffix?: string;
}
export interface AgenticInterfaceListComponent extends AgenticInterfaceComponentBase {
    kind: "list";
    primary_field?: string;
    secondary_field?: string;
    trailing_field?: string;
    max_items?: number;
}
export interface AgenticInterfaceTableComponent extends AgenticInterfaceComponentBase {
    kind: "table";
    columns?: AgenticInterfaceColumn[];
    selectable?: boolean;
}
export interface AgenticInterfaceDetailComponent extends AgenticInterfaceComponentBase {
    kind: "detail";
    fields?: AgenticInterfaceField[];
    entity_ref?: WidgetDataRef;
}
export interface AgenticInterfaceFormComponent extends AgenticInterfaceComponentBase {
    kind: "form";
    fields: AgenticInterfaceField[];
    submit_action_id?: string;
}
export interface AgenticInterfaceActionBarComponent extends AgenticInterfaceComponentBase {
    kind: "action_bar";
    action_ids: string[];
}
export interface AgenticInterfaceTimelineComponent extends AgenticInterfaceComponentBase {
    kind: "timeline";
    time_field?: string;
    title_field?: string;
    subtitle_field?: string;
}
export interface AgenticInterfaceCardRefComponent extends AgenticInterfaceComponentBase {
    kind: "card_ref";
    app_id: string;
    app_slug?: string;
    widget_id: string;
    card_id: string;
    size?: string;
}
export interface AgenticInterfaceWidgetEmbedComponent extends AgenticInterfaceComponentBase {
    kind: "widget_embed";
    app_id: string;
    app_slug?: string;
    widget_id: string;
    context?: Record<string, string>;
}
export interface AgenticInterfaceRoutinePanelComponent extends AgenticInterfaceComponentBase {
    kind: "routine_panel";
    routine_ids?: string[];
    template_ids?: string[];
}
export interface AgenticInterfaceTextComponent extends AgenticInterfaceComponentBase {
    kind: "text";
    text: string;
}
export type AgenticInterfaceComponent = AgenticInterfaceMetricComponent | AgenticInterfaceListComponent | AgenticInterfaceTableComponent | AgenticInterfaceDetailComponent | AgenticInterfaceFormComponent | AgenticInterfaceActionBarComponent | AgenticInterfaceTimelineComponent | AgenticInterfaceCardRefComponent | AgenticInterfaceWidgetEmbedComponent | AgenticInterfaceRoutinePanelComponent | AgenticInterfaceTextComponent;
export interface AgenticInterfaceDataBindingBase {
    id: string;
    source: AgenticInterfaceDataBindingSource;
    label?: string;
    description?: string;
    refresh_interval_s?: number;
}
export interface AgenticCommandCardDataBinding extends AgenticInterfaceDataBindingBase {
    source: "command_card";
    app_id: string;
    app_slug?: string;
    widget_id: string;
    card_id: string;
    data_view?: string;
    data_function?: string;
}
export interface AgenticContextSourceDataBinding extends AgenticInterfaceDataBindingBase {
    source: "context_source";
    app_id: string;
    app_slug?: string;
    context_source_id: string;
    query?: string;
    max_rows?: number;
}
export interface AgenticMcpReadFunctionDataBinding extends AgenticInterfaceDataBindingBase {
    source: "mcp_read_function";
    app_id: string;
    app_slug?: string;
    function_name: string;
    args?: Record<string, unknown>;
}
export interface AgenticLiteralDataBinding extends AgenticInterfaceDataBindingBase {
    source: "literal";
    value: unknown;
}
export type AgenticInterfaceDataBinding = AgenticCommandCardDataBinding | AgenticContextSourceDataBinding | AgenticMcpReadFunctionDataBinding | AgenticLiteralDataBinding;
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
export interface AgenticMcpFunctionActionBinding extends AgenticInterfaceActionBase {
    kind: "mcp_function";
    app_id: string;
    app_slug?: string;
    function_name: string;
}
export interface AgenticOpenWidgetActionBinding extends AgenticInterfaceActionBase {
    kind: "open_widget";
    app_id: string;
    app_slug?: string;
    widget_id: string;
    context?: Record<string, string>;
}
export interface AgenticRefreshBindingAction extends AgenticInterfaceActionBase {
    kind: "refresh_binding";
    binding_ids: string[];
}
export interface AgenticSelectEntityAction extends AgenticInterfaceActionBase {
    kind: "select_entity";
    data_ref?: WidgetDataRef;
    component_id?: string;
}
export type AgenticInterfaceAction = AgenticWidgetActionBinding | AgenticMcpFunctionActionBinding | AgenticOpenWidgetActionBinding | AgenticRefreshBindingAction | AgenticSelectEntityAction;
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
export type AgenticInterfaceDroppedItemKind = "data_binding" | "action" | "component" | "layout" | "permission" | "field" | "column" | "warning";
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
export declare function validateAgenticInterfaceSpec(input: unknown): AgenticInterfaceValidationResult;
export declare function isAgenticInterfaceSpec(input: unknown): input is AgenticInterfaceSpec;
