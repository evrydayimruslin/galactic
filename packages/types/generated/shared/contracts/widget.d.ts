export interface WidgetDeclaration {
    id: string;
    label: string;
    description?: string;
    ui_function?: string;
    data_function?: string;
    data_tool?: string;
    poll_interval_s?: number;
    dependencies?: WidgetDependencyDeclaration[];
    cards?: CommandCardDeclaration[];
}
export type CommandCardRenderMode = 'native';
export type CommandCardKind = 'metric' | 'list' | 'timeline' | 'sparkline' | 'progress' | 'summary' | 'composite';
export interface WidgetDependencyDeclaration {
    app: string;
    functions: string[];
    access?: 'read';
}
export interface CommandCardDeclaration {
    id: string;
    label: string;
    description?: string;
    size: string;
    render?: CommandCardRenderMode;
    kind?: CommandCardKind;
    data_view?: string;
    data_function?: string;
    refresh_interval_s?: number;
    dependencies?: WidgetDependencyDeclaration[];
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
    cards?: Record<string, CommandCardDataPayload>;
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
export interface CommandCardDataPayload {
    card_id?: string;
    meta?: Partial<WidgetMeta> & {
        status?: 'live' | 'paused' | 'error' | string;
        accent?: string;
        cost_per_min?: number;
    };
    body: CommandCardBody;
    footer?: string;
    updated_at?: string;
    version?: string;
}
export type CommandCardBody = CommandMetricCardBody | CommandListCardBody | CommandTimelineCardBody | CommandSparklineCardBody | CommandProgressCardBody | CommandSummaryCardBody | CommandCompositeCardBody;
export interface CommandMetricCardBody {
    kind: 'metric';
    metric: string | number;
    label?: string;
    delta?: string;
}
export interface CommandListCardBody {
    kind: 'list';
    rows: Array<Array<string | number | boolean | null>>;
}
export interface CommandTimelineCardBody {
    kind: 'timeline';
    rows: Array<{
        time?: string;
        title: string;
        subtitle?: string;
        accent?: string;
    }>;
}
export interface CommandSparklineCardBody {
    kind: 'sparkline';
    metric?: string | number;
    label?: string;
    points: number[];
}
export interface CommandProgressCardBody {
    kind: 'progress';
    value: number;
    max?: number;
    label?: string;
}
export interface CommandSummaryCardBody {
    kind: 'summary';
    title?: string;
    lines: string[];
}
export interface CommandCompositeCardBody {
    kind: 'composite';
    children: Array<{
        app_id?: string;
        widget_id: string;
        card_id: string;
        label?: string;
    }>;
}
