import { getEnv } from "../lib/env.ts";
import {
  type AccountCapacityStatus,
  getAccountCapacityStatus,
} from "./account-capacity.ts";
import {
  OPERATOR_ITEM_SOURCE,
  reconcileAccountUsageOperatorItems,
} from "./operator-item-producers.ts";
import type { ReconcileOperatorItemsResult } from "./operator-item-persistence.ts";

const DEFAULT_OWNER_LIMIT = 100;
const MAX_OWNER_LIMIT = 500;

interface ActiveAccountUsageRow {
  user_id: string;
}

interface ActiveRoutineAgentRow {
  composer_app_id: string | null;
  composer_app_slug: string | null;
}

type AgentReference = { id: string; name: string };

export interface OperatorProducerReconciliationDependencies {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  getAccountStatus?: (
    userId: string,
    observedAt: string,
  ) => Promise<AccountCapacityStatus>;
  loadAffectedAgents?: (userId: string) => Promise<AgentReference[]>;
  reconcileAccountUsage?: (
    input: Parameters<typeof reconcileAccountUsageOperatorItems>[0],
  ) => Promise<{ reconciliation: ReconcileOperatorItemsResult }>;
  log?: (
    level: "warn" | "error",
    message: string,
    fields: Record<string, unknown>,
  ) => void;
}

export interface OperatorProducerReconciliationSummary {
  checkedAt: string;
  ownersDiscovered: number;
  ownersReconciled: number;
  ownersFailed: number;
  itemsObserved: number;
  itemsRecovered: number;
}

function config(
  dependencies: OperatorProducerReconciliationDependencies,
): {
  fetchFn: typeof fetch;
  baseUrl: string;
  serviceRoleKey: string;
} {
  const baseUrl = (dependencies.supabaseUrl ?? getEnv("SUPABASE_URL")).replace(
    /\/+$/u,
    "",
  );
  const serviceRoleKey = dependencies.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    throw new Error("Operator producer reconciliation is not configured");
  }
  return {
    fetchFn: dependencies.fetchFn ?? fetch,
    baseUrl,
    serviceRoleKey,
  };
}

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function readRows<T>(
  url: URL,
  dependencies: OperatorProducerReconciliationDependencies,
  label: string,
): Promise<T[]> {
  const resolved = config(dependencies);
  const response = await resolved.fetchFn(url.toString(), {
    headers: serviceHeaders(resolved.serviceRoleKey),
  });
  if (!response.ok) {
    throw new Error(`${label} failed with status ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return payload as T[];
}

async function activeAccountUsageOwners(
  limit: number,
  dependencies: OperatorProducerReconciliationDependencies,
): Promise<string[]> {
  const resolved = config(dependencies);
  const url = new URL(`${resolved.baseUrl}/rest/v1/operator_items`);
  url.searchParams.set("source_key", `eq.${OPERATOR_ITEM_SOURCE.accountUsage}`);
  url.searchParams.set("lifecycle_state", "eq.active");
  url.searchParams.set("select", "user_id");
  url.searchParams.set("order", "last_observed_at.asc,user_id.asc");
  url.searchParams.set("limit", String(limit));
  const rows = await readRows<ActiveAccountUsageRow>(
    url,
    dependencies,
    "Account usage owner discovery",
  );
  return [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
}

async function activeRoutineAgents(
  userId: string,
  dependencies: OperatorProducerReconciliationDependencies,
): Promise<AgentReference[]> {
  const resolved = config(dependencies);
  const url = new URL(`${resolved.baseUrl}/rest/v1/user_routines`);
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("status", "eq.active");
  url.searchParams.set("deleted_at", "is.null");
  url.searchParams.set("composer_app_id", "not.is.null");
  url.searchParams.set("select", "composer_app_id,composer_app_slug");
  url.searchParams.set("order", "composer_app_id.asc");
  url.searchParams.set("limit", "1000");
  const rows = await readRows<ActiveRoutineAgentRow>(
    url,
    dependencies,
    "Account usage affected-Agent discovery",
  );
  const agents = new Map<string, AgentReference>();
  for (const row of rows) {
    if (!row.composer_app_id || agents.has(row.composer_app_id)) continue;
    agents.set(row.composer_app_id, {
      id: row.composer_app_id,
      name: row.composer_app_slug || row.composer_app_id,
    });
  }
  return [...agents.values()];
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OWNER_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OWNER_LIMIT) {
    throw new Error(
      `Operator producer owner limit must be between 1 and ${MAX_OWNER_LIMIT}`,
    );
  }
  return value;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
  ) {
    return error.code;
  }
  return error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(error.name)
    ? error.name
    : "OPERATOR_PRODUCER_RECONCILIATION_FAILED";
}

/**
 * Bounded replay/recovery for account usage reports. Event producers open the
 * report immediately; this sweep rechecks backend capacity truth after reset
 * even when no page is opened and no new routine wake has occurred.
 */
export async function runOperatorItemProducerReconciliationCycle(
  input: { now?: Date; ownerLimit?: number } = {},
  dependencies: OperatorProducerReconciliationDependencies = {},
): Promise<OperatorProducerReconciliationSummary> {
  const observedAt = (input.now ?? new Date()).toISOString();
  const owners = await activeAccountUsageOwners(
    boundedLimit(input.ownerLimit),
    dependencies,
  );
  const summary: OperatorProducerReconciliationSummary = {
    checkedAt: observedAt,
    ownersDiscovered: owners.length,
    ownersReconciled: 0,
    ownersFailed: 0,
    itemsObserved: 0,
    itemsRecovered: 0,
  };
  const getStatus = dependencies.getAccountStatus ??
    ((userId: string, at: string) =>
      getAccountCapacityStatus(
        userId,
        { now: at },
        {
          fetchFn: dependencies.fetchFn,
          supabaseUrl: dependencies.supabaseUrl,
          serviceRoleKey: dependencies.serviceRoleKey,
        },
      ));
  const loadAgents = dependencies.loadAffectedAgents ??
    ((userId: string) => activeRoutineAgents(userId, dependencies));
  const reconcile = dependencies.reconcileAccountUsage ??
    ((producerInput) => reconcileAccountUsageOperatorItems(producerInput));
  const log = dependencies.log ??
    ((level, message, fields) => console[level](message, fields));

  for (const userId of owners) {
    try {
      const [status, affectedAgents] = await Promise.all([
        getStatus(userId, observedAt),
        loadAgents(userId),
      ]);
      const result = await reconcile({
        userId,
        status,
        affectedAgents,
        observedAt,
      });
      summary.ownersReconciled += 1;
      summary.itemsObserved += result.reconciliation.observedCount;
      summary.itemsRecovered += result.reconciliation.recoveredCount;
    } catch (error) {
      summary.ownersFailed += 1;
      log("warn", "[OPERATOR-ITEMS] account usage recheck failed", {
        userId,
        errorCode: errorCode(error),
      });
    }
  }
  return summary;
}
