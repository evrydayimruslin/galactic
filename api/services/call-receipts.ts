import { getEnv } from "../lib/env.ts";

export const CALL_RECEIPT_LOG_SELECT = [
  "id",
  "user_id",
  "app_id",
  "app_name",
  "function_name",
  "method",
  "success",
  "duration_ms",
  "error_message",
  "created_at",
  "call_charge_light",
  "app_price_light",
  "app_charge_light",
  "infra_charge_light",
  "platform_fee_light",
  "developer_net_light",
  "free_call",
  "free_call_count",
  "free_call_limit",
  "cloud_usage_hold_id",
  "cloud_usage_event_id",
  "cloud_units",
  "cloud_charge_light",
  "cloud_payer_user_id",
  "cloud_owner_sponsored",
  "buyer_billing_address_id",
  "buyer_billing_address_version",
  "tax_status",
  "taxable_amount_light",
  "tax_amount_light",
].join(",");

const CLOUD_USAGE_EVENT_RECEIPT_SELECT = [
  "id",
  "receipt_id",
  "source",
  "resource",
  "units",
  "cloud_units",
  "amount_light",
  "payer_user_id",
  "sponsor_user_id",
  "caller_user_id",
  "owner_user_id",
  "app_id",
  "function_name",
  "billing_config_version",
  "metadata",
  "created_at",
].join(",");

export type ReceiptResource =
  | "worker_execution"
  | "r2_operation"
  | "kv_operation"
  | "d1_read"
  | "d1_write"
  | "widget_pull"
  | "storage_at_rest";

export interface CallReceiptLogRow {
  id: string;
  user_id?: string | null;
  app_id?: string | null;
  app_name?: string | null;
  function_name?: string | null;
  method?: string | null;
  success?: boolean | null;
  duration_ms?: number | null;
  error_message?: string | null;
  created_at?: string | null;
  call_charge_light?: number | null;
  app_price_light?: number | null;
  app_charge_light?: number | null;
  infra_charge_light?: number | null;
  platform_fee_light?: number | null;
  developer_net_light?: number | null;
  free_call?: boolean | null;
  free_call_count?: number | null;
  free_call_limit?: number | null;
  cloud_usage_hold_id?: string | null;
  cloud_usage_event_id?: string | null;
  cloud_units?: number | null;
  cloud_charge_light?: number | null;
  cloud_payer_user_id?: string | null;
  cloud_owner_sponsored?: boolean | null;
  buyer_billing_address_id?: string | null;
  buyer_billing_address_version?: number | null;
  tax_status?: string | null;
  taxable_amount_light?: number | null;
  tax_amount_light?: number | null;
}

export interface ReceiptCloudUsageEvent {
  id: string;
  receipt_id: string | null;
  source: string;
  resource: ReceiptResource;
  units: number | null;
  cloud_units: number | null;
  amount_light: number | null;
  payer_user_id?: string | null;
  sponsor_user_id?: string | null;
  caller_user_id?: string | null;
  owner_user_id?: string | null;
  app_id?: string | null;
  function_name?: string | null;
  billing_config_version?: number | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface ReceiptResourceSummary {
  event_count: number;
  units: number;
  cloud_units: number;
  amount_light: number;
}

export interface CallReceipt {
  receipt_id: string;
  app_price_light: number;
  app_charge_light: number;
  infra_light: number;
  total_light: number;
  platform_fee_light: number;
  developer_net_light: number;
  buyer_billing_address_id: string | null;
  buyer_billing_address_version: number | null;
  tax_status: string;
  taxable_amount_light: number;
  tax_amount_light: number;
  free_call: boolean;
  free_call_count: number | null;
  free_call_limit: number;
  cloud_units: number;
  worker_units: {
    milliseconds: number;
    cloud_units: number;
    amount_light: number;
  };
  r2_ops: {
    operations: number;
    cloud_units: number;
    amount_light: number;
  };
  kv_ops: {
    operations: number;
    cloud_units: number;
    amount_light: number;
  };
  d1_reads: {
    rows: number;
    cloud_units: number;
    amount_light: number;
  };
  d1_writes: {
    rows: number;
    cloud_units: number;
    amount_light: number;
  };
  widget_pulls: {
    pulls: number;
    cloud_units: number;
    amount_light: number;
  };
  resources: Record<ReceiptResource, ReceiptResourceSummary>;
  cloud_usage_event_ids: string[];
  cloud_payer_user_id: string | null;
  owner_sponsored_infra: boolean;
  caller_infra_fallback: boolean;
}

const RECEIPT_RESOURCES: ReceiptResource[] = [
  "worker_execution",
  "r2_operation",
  "kv_operation",
  "d1_read",
  "d1_write",
  "widget_pull",
  "storage_at_rest",
];

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyResourceSummary(): Record<
  ReceiptResource,
  ReceiptResourceSummary
> {
  return Object.fromEntries(
    RECEIPT_RESOURCES.map((resource) => [
      resource,
      { event_count: 0, units: 0, cloud_units: 0, amount_light: 0 },
    ]),
  ) as Record<ReceiptResource, ReceiptResourceSummary>;
}

export function summarizeReceiptCloudEvents(
  events: ReceiptCloudUsageEvent[],
): Record<ReceiptResource, ReceiptResourceSummary> {
  const resources = emptyResourceSummary();
  for (const event of events) {
    const resource = event.resource;
    if (!resources[resource]) continue;
    resources[resource].event_count += 1;
    resources[resource].units += numeric(event.units);
    resources[resource].cloud_units += numeric(event.cloud_units);
    resources[resource].amount_light += numeric(event.amount_light);
  }
  return resources;
}

export function buildCallReceipt(
  log: CallReceiptLogRow,
  cloudEvents: ReceiptCloudUsageEvent[] = [],
): CallReceipt {
  const resources = summarizeReceiptCloudEvents(cloudEvents);
  const eventInfraLight = Object.values(resources).reduce(
    (sum, resource) => sum + resource.amount_light,
    0,
  );
  const eventCloudUnits = Object.values(resources).reduce(
    (sum, resource) => sum + resource.cloud_units,
    0,
  );
  const legacyInfraLight = numeric(log.infra_charge_light) ||
    numeric(log.cloud_charge_light);
  const infraLight = eventInfraLight > 0 ? eventInfraLight : legacyInfraLight;
  const appChargeLight = numeric(log.app_charge_light) ||
    numeric(log.call_charge_light);
  const taxAmountLight = numeric(log.tax_amount_light);
  const cloudUnits = eventCloudUnits > 0
    ? eventCloudUnits
    : numeric(log.cloud_units);
  const eventIds = cloudEvents.map((event) => event.id).filter(Boolean);
  const callerInfraFallback =
    cloudEvents.some((event) =>
      event.metadata?.caller_infra_fallback === true
    ) ||
    (log.free_call === true &&
      log.cloud_owner_sponsored !== true &&
      log.cloud_payer_user_id != null &&
      log.cloud_payer_user_id === log.user_id);
  if (eventIds.length === 0 && log.cloud_usage_event_id) {
    eventIds.push(log.cloud_usage_event_id);
  }

  return {
    receipt_id: log.id,
    app_price_light: numeric(log.app_price_light) || appChargeLight,
    app_charge_light: appChargeLight,
    infra_light: infraLight,
    total_light: appChargeLight + infraLight + taxAmountLight,
    platform_fee_light: numeric(log.platform_fee_light),
    developer_net_light: numeric(log.developer_net_light),
    buyer_billing_address_id: log.buyer_billing_address_id || null,
    buyer_billing_address_version: nullableNumeric(
      log.buyer_billing_address_version,
    ),
    tax_status: log.tax_status || "not_collecting",
    taxable_amount_light: numeric(log.taxable_amount_light),
    tax_amount_light: taxAmountLight,
    free_call: log.free_call === true,
    free_call_count: nullableNumeric(log.free_call_count),
    free_call_limit: numeric(log.free_call_limit),
    cloud_units: cloudUnits,
    worker_units: {
      milliseconds: resources.worker_execution.units,
      cloud_units: resources.worker_execution.cloud_units ||
        numeric(log.cloud_units),
      amount_light: resources.worker_execution.amount_light ||
        legacyInfraLight,
    },
    r2_ops: {
      operations: resources.r2_operation.units,
      cloud_units: resources.r2_operation.cloud_units,
      amount_light: resources.r2_operation.amount_light,
    },
    kv_ops: {
      operations: resources.kv_operation.units,
      cloud_units: resources.kv_operation.cloud_units,
      amount_light: resources.kv_operation.amount_light,
    },
    d1_reads: {
      rows: resources.d1_read.units,
      cloud_units: resources.d1_read.cloud_units,
      amount_light: resources.d1_read.amount_light,
    },
    d1_writes: {
      rows: resources.d1_write.units,
      cloud_units: resources.d1_write.cloud_units,
      amount_light: resources.d1_write.amount_light,
    },
    widget_pulls: {
      pulls: resources.widget_pull.units,
      cloud_units: resources.widget_pull.cloud_units,
      amount_light: resources.widget_pull.amount_light,
    },
    resources,
    cloud_usage_event_ids: eventIds,
    cloud_payer_user_id: log.cloud_payer_user_id ?? null,
    owner_sponsored_infra: log.cloud_owner_sponsored === true,
    caller_infra_fallback: callerInfraFallback,
  };
}

export async function attachCallReceipts<T extends CallReceiptLogRow>(
  logs: T[],
  deps: { fetchFn?: typeof fetch } = {},
): Promise<Array<T & { receipt_id: string; receipt: CallReceipt }>> {
  const receiptIds = logs.map((log) => log.id).filter(Boolean);
  const eventsByReceipt = await fetchCloudEventsByReceipt(receiptIds, deps);
  return logs.map((log) => {
    const cloudEvents = eventsByReceipt.get(log.id) ?? [];
    return {
      ...log,
      receipt_id: log.id,
      receipt: buildCallReceipt(log, cloudEvents),
    };
  });
}

async function fetchCloudEventsByReceipt(
  receiptIds: string[],
  deps: { fetchFn?: typeof fetch },
): Promise<Map<string, ReceiptCloudUsageEvent[]>> {
  const eventsByReceipt = new Map<string, ReceiptCloudUsageEvent[]>();
  if (receiptIds.length === 0) return eventsByReceipt;

  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return eventsByReceipt;

  const uniqueIds = [...new Set(receiptIds)];
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(
    `${SUPABASE_URL}/rest/v1/cloud_usage_events?receipt_id=in.(${
      uniqueIds.map((id) => encodeURIComponent(id)).join(",")
    })&select=${CLOUD_USAGE_EVENT_RECEIPT_SELECT}`,
    {
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );

  if (!res.ok) return eventsByReceipt;

  const events = await res.json() as ReceiptCloudUsageEvent[];
  for (const event of events) {
    if (!event.receipt_id) continue;
    const bucket = eventsByReceipt.get(event.receipt_id) ?? [];
    bucket.push(event);
    eventsByReceipt.set(event.receipt_id, bucket);
  }

  return eventsByReceipt;
}
