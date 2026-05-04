export interface WidgetDeclaration {
    id: string;
    label: string;
    data_tool?: string;
    poll_interval_s?: number;
}
export interface WidgetAction {
    label: string;
    icon?: string;
    style?: string;
    tool: string;
    args: Record<string, unknown>;
    editable?: {
        field: string;
        initial_value: string;
    };
    prompt_input?: {
        placeholder: string;
    };
}
export interface WidgetItem {
    id: string;
    html: string;
    actions: WidgetAction[];
}
export interface WidgetData {
    meta?: WidgetMeta;
    badge_count?: number;
    items?: WidgetItem[];
}
export interface WidgetMeta {
    title: string;
    icon?: string;
    badge_count: number;
}
export interface WidgetAppResponse {
    meta: WidgetMeta;
    app_html: string;
    version?: string;
}
