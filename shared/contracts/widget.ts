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
  agentic?: boolean;
  context_function?: string;
  actions_function?: string;
  context_sources?: WidgetContextSourceRef[];
  agent_actions?: WidgetActionDeclaration[];
}

export type WidgetContextSourceRef = string;

export type WidgetContextSourceType = 'd1_table' | 'd1_query' | 'function';

export interface WidgetContextSourceDeclaration {
  id: string;
  label: string;
  description?: string;
  type: WidgetContextSourceType;
  access: 'read';
  searchable?: boolean;
  default_for_widgets?: string[];
  tables?: string[];
  query?: string;
  function?: string;
  redactions?: WidgetContextRedaction[];
}

export interface WidgetContextRedaction {
  field?: string;
  pattern?: string;
  replacement?: string;
}

export type WidgetActionMode = 'read' | 'write' | 'ui';

export type WidgetConfirmationPolicy = 'none' | 'user' | 'high_risk';

export interface WidgetMcpActionBinding {
  function: string;
  args_template?: Record<string, unknown>;
}

export interface WidgetUiActionBinding {
  command?: string;
  component_id?: string;
  args_template?: Record<string, unknown>;
}

export interface WidgetActionDeclaration {
  id: string;
  label: string;
  description?: string;
  mode: WidgetActionMode;
  args_schema?: Record<string, unknown>;
  confirmation?: WidgetConfirmationPolicy;
  mcp?: WidgetMcpActionBinding;
  ui?: WidgetUiActionBinding;
  expected_result?: string;
}

export interface WidgetDataRef {
  type?: string;
  id?: string;
  label?: string;
  table?: string;
  field?: string;
  value?: unknown;
}

export interface WidgetVisibleComponent {
  id: string;
  type?: string;
  label?: string;
  purpose?: string;
  data_refs?: WidgetDataRef[];
  actions?: string[];
  state?: Record<string, unknown>;
}

export interface WidgetPendingEdit {
  field: string;
  label?: string;
  value?: unknown;
  dirty?: boolean;
  entity?: WidgetDataRef;
}

export interface WidgetStateSnapshot {
  surface_id?: string;
  app_id?: string;
  app_slug?: string;
  widget_id: string;
  title?: string;
  summary?: string;
  current_view?: string;
  visible_components?: WidgetVisibleComponent[];
  visible_data_refs?: WidgetDataRef[];
  selected_entities?: WidgetDataRef[];
  pending_edits?: WidgetPendingEdit[];
  enabled_actions?: string[];
  errors?: string[];
  updated_at?: string;
}

export type WidgetSurfaceEventKind =
  | 'user'
  | 'agent'
  | 'data'
  | 'navigation'
  | 'error'
  | 'system';

export interface WidgetSurfaceEvent {
  id?: string;
  surface_id?: string;
  widget_id?: string;
  kind: WidgetSurfaceEventKind;
  action_id?: string;
  turn_id?: string;
  label?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  snapshot?: WidgetStateSnapshot;
  created_at?: string;
}

export type WidgetSurfaceKind = 'inline' | 'window' | 'command_card';

export type WidgetSurfaceStatus = 'opening' | 'ready' | 'stale' | 'closed';

export interface ActiveWidgetContext {
  surfaceId: string;
  kind?: WidgetSurfaceKind;
  appId: string;
  appSlug: string;
  appName: string;
  widgetId: string;
  widgetName?: string;
  title?: string;
  context?: Record<string, string>;
  status?: WidgetSurfaceStatus;
  snapshot?: WidgetStateSnapshot | null;
  actions?: WidgetActionDeclaration[];
  recentEvents?: WidgetSurfaceEvent[];
  recentEventSummary?: string;
  recentEventCount?: number;
  latestDataPayload?: Record<string, unknown> | null;
  updatedAt?: number;
}

export interface WidgetActionInvocation {
  surface_id: string;
  widget_id: string;
  action_id: string;
  args?: Record<string, unknown>;
  turn_id?: string;
  source?: 'user' | 'agent' | 'system';
}

export interface WidgetActionResult {
  surface_id?: string;
  widget_id?: string;
  action_id: string;
  turn_id?: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  snapshot?: WidgetStateSnapshot;
  event?: WidgetSurfaceEvent;
}

export type CommandCardRenderMode = 'native';

export type CommandCardKind =
  | 'metric'
  | 'list'
  | 'timeline'
  | 'sparkline'
  | 'progress'
  | 'summary'
  | 'composite';

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

export type CommandCardBody =
  | CommandMetricCardBody
  | CommandListCardBody
  | CommandTimelineCardBody
  | CommandSparklineCardBody
  | CommandProgressCardBody
  | CommandSummaryCardBody
  | CommandCompositeCardBody;

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
