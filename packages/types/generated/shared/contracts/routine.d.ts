export type RoutineCapabilityAccess = 'read' | 'write';
export interface RoutineParameter {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
    required?: boolean;
    default?: unknown;
    enum?: unknown[];
    items?: RoutineParameter;
    properties?: Record<string, RoutineParameter>;
}
export type RoutineConfigSchema = Record<string, RoutineParameter>;
export type RoutineScheduleDeclaration = string | {
    type?: 'interval';
    every_seconds?: number;
    every_minutes?: number;
    timezone?: string;
} | {
    type?: 'cron';
    cron: string;
    timezone?: string;
};
export interface RoutineCapabilityDeclaration {
    app: string;
    functions: string[];
    access?: RoutineCapabilityAccess;
    required?: boolean;
    purpose?: string;
}
export interface RoutineBudgetDefaults {
    max_light_per_run?: number;
    max_light_per_day?: number;
    max_light_per_month?: number;
    max_calls_per_run?: number;
}
export declare const DEFAULT_ROUTINE_BUDGET_POLICY: Required<RoutineBudgetDefaults>;
export declare const MIN_ROUTINE_INTERVAL_SECONDS = 60;
export interface RoutineApprovalPolicy {
    require_user_approval?: boolean;
    require_paid_capability_approval?: boolean;
    require_external_side_effect_approval?: boolean;
}
export interface RoutineCommandCardBinding {
    widget_id: string;
    card_id: string;
}
export interface RoutineSurfaceBindings {
    widgets?: string[];
    command_cards?: RoutineCommandCardBinding[];
    dashboard_key?: string;
}
export interface RoutineDeclaration {
    id: string;
    label: string;
    description?: string;
    handler: string;
    default_schedule?: RoutineScheduleDeclaration;
    config_schema?: RoutineConfigSchema;
    default_config?: Record<string, unknown>;
    capabilities?: RoutineCapabilityDeclaration[];
    budget_defaults?: RoutineBudgetDefaults;
    approval_policy?: RoutineApprovalPolicy;
    surfaces?: RoutineSurfaceBindings;
}
