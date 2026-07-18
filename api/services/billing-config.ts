import {
  CAPACITY_D1_READ_LIGHT_PER_MILLION_ROWS,
  CAPACITY_D1_WRITE_LIGHT_PER_MILLION_ROWS,
  CAPACITY_KV_DELETE_LIGHT_PER_MILLION_OPERATIONS,
  CAPACITY_KV_LIST_LIGHT_PER_MILLION_OPERATIONS,
  CAPACITY_KV_READ_LIGHT_PER_MILLION_OPERATIONS,
  CAPACITY_KV_WRITE_LIGHT_PER_MILLION_OPERATIONS,
  CAPACITY_QUEUE_LIGHT_PER_MILLION_OPERATIONS,
  CAPACITY_R2_CLASS_A_LIGHT_PER_MILLION_OPERATIONS,
  CAPACITY_R2_CLASS_B_LIGHT_PER_MILLION_OPERATIONS,
  CAPACITY_R2_DELETE_LIGHT_PER_MILLION_OPERATIONS,
  CAPACITY_RATE_CARD_VERSION,
  CARD_MINIMUM_CENTS,
  CLOUD_UNIT_LIGHT_PER_1K,
  COMBINED_FREE_TIER_BYTES,
  D1_READ_ROWS_PER_CLOUD_UNIT,
  D1_WRITE_ROWS_PER_CLOUD_UNIT,
  KV_OPS_PER_CLOUD_UNIT,
  LIGHT_PER_DOLLAR_CANONICAL,
  LIGHT_PER_DOLLAR_PAYOUT,
  LIGHT_PER_DOLLAR_WALLET,
  LIGHT_PER_DOLLAR_WIRE,
  LIGHT_SYMBOL,
  MIN_WITHDRAWAL_LIGHT,
  PLATFORM_FEE_RATE,
  PUBLISHER_MIN_PUBLISH_BALANCE_LIGHT,
  R2_OPS_PER_CLOUD_UNIT,
  STORAGE_LIGHT_PER_GB_MONTH,
  WIDGET_PULLS_PER_CLOUD_UNIT,
  WIRE_MINIMUM_CENTS,
  WORKER_LOAD_LIGHT_PER_INVOCATION,
  WORKER_MS_PER_CLOUD_UNIT,
  WORKER_REQUEST_LIGHT_PER_INVOCATION,
} from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";

export interface BillingConfig {
  id: string;
  version: number;
  canonicalLightPerUsd: number;
  walletLightPerUsd: number;
  wireLightPerUsd: number;
  payoutLightPerUsd: number;
  platformFeeRate: number;
  minWithdrawalLight: number;
  cardMinimumCents: number;
  wireMinimumCents: number;
  cloudUnitLightPer1k: number;
  workerMsPerCloudUnit: number;
  workerRequestLightPerInvocation: number;
  workerLoadLightPerInvocation: number;
  capacityRateCardVersion: number;
  capacityD1ReadLightPerMillionRows: number;
  capacityD1WriteLightPerMillionRows: number;
  capacityKvReadLightPerMillionOperations: number;
  capacityKvWriteLightPerMillionOperations: number;
  capacityKvDeleteLightPerMillionOperations: number;
  capacityKvListLightPerMillionOperations: number;
  capacityR2ClassALightPerMillionOperations: number;
  capacityR2ClassBLightPerMillionOperations: number;
  capacityR2DeleteLightPerMillionOperations: number;
  capacityQueueLightPerMillionOperations: number;
  d1ReadRowsPerCloudUnit: number;
  d1WriteRowsPerCloudUnit: number;
  r2OpsPerCloudUnit: number;
  kvOpsPerCloudUnit: number;
  widgetPullsPerCloudUnit: number;
  storageFreeBytes: number;
  storageLightPerGbMonth: number;
  publishDepositEnabled: boolean;
  publisherMinPublishBalanceLight: number;
  publishedHostingMeterEnabled: boolean;
  payoutPolicyCopy: string;
  updatedAt: string | null;
}

interface BillingConfigRow {
  id?: string | null;
  version?: number | null;
  canonical_light_per_usd?: number | null;
  wallet_light_per_usd?: number | null;
  wire_light_per_usd?: number | null;
  payout_light_per_usd?: number | null;
  platform_fee_rate?: number | null;
  min_withdrawal_light?: number | null;
  card_minimum_cents?: number | null;
  wire_minimum_cents?: number | null;
  cloud_unit_light_per_1k?: number | null;
  worker_ms_per_cloud_unit?: number | null;
  worker_request_light_per_invocation?: number | null;
  worker_load_light_per_invocation?: number | null;
  capacity_rate_card_version?: number | null;
  capacity_d1_read_light_per_million_rows?: number | null;
  capacity_d1_write_light_per_million_rows?: number | null;
  capacity_kv_read_light_per_million_operations?: number | null;
  capacity_kv_write_light_per_million_operations?: number | null;
  capacity_kv_delete_light_per_million_operations?: number | null;
  capacity_kv_list_light_per_million_operations?: number | null;
  capacity_r2_class_a_light_per_million_operations?: number | null;
  capacity_r2_class_b_light_per_million_operations?: number | null;
  capacity_r2_delete_light_per_million_operations?: number | null;
  capacity_queue_light_per_million_operations?: number | null;
  d1_read_rows_per_cloud_unit?: number | null;
  d1_write_rows_per_cloud_unit?: number | null;
  r2_ops_per_cloud_unit?: number | null;
  kv_ops_per_cloud_unit?: number | null;
  widget_pulls_per_cloud_unit?: number | null;
  storage_free_bytes?: number | null;
  storage_light_per_gb_month?: number | null;
  publish_deposit_enabled?: boolean | null;
  publisher_min_publish_balance_light?: number | null;
  published_hosting_meter_enabled?: boolean | null;
  payout_policy_copy?: string | null;
  updated_at?: string | null;
}

export const DEFAULT_PAYOUT_POLICY_COPY =
  "Payouts are processed on the first business day of each month. Requests must be submitted at least 21 days before that payout date to be included. Purchased credits cannot be cashed out; only creator earnings are eligible for payout.";

export const LIGHT_ECONOMY_POLICY_COPY = {
  purchasedLight:
    "Purchased credits are spend-only platform credit. They cannot be cashed out, redeemed for money, or transferred directly between arbitrary accounts.",
  creatorEarnings:
    "Creator earnings come from platform-mediated app activity and marketplace sales. Earned credits can be added to spendable balance instantly or requested for payout through Stripe Connect while unconverted.",
  fundingTerms:
    "By adding credits, you agree that purchased credits are spend-only platform credit and that authenticated funding transactions are governed by the Terms.",
  payoutTerms:
    "By requesting a payout, you confirm that the amount is creator earnings and that payout timing, fees, and eligibility are governed by the Terms.",
  feeWaivers:
    "Galactic may waive its internal platform fee on eligible creator revenue through publisher referral grants or publisher fee-waiver credit.",
  feeWaiverEndUserImpact:
    "Platform fee waivers affect only Galactic's internal platform fee and publisher revenue. They do not change the gross credits amount paid by the end user.",
  feeWaiverCredit:
    "Publisher fee-waiver credit is platform scrip that can be used only to cover Galactic internal platform fees on eligible creator revenue and has no cash value.",
  cloudUsage:
    "Cloud usage is metered in cloud units and charged as exact fractional credits at Galactic's configured internal cloud-unit rates. The billing config version on receipts is the authoritative rate snapshot.",
  storagePolicy:
    "The first 100MB of combined storage is included. Storage above that is charged at Galactic's configured internal GB-month rate.",
  freeCallSponsorship:
    "Free calls use app-owner sponsorship for infrastructure when available. If the owner has no credits balance, the caller needs credits balance to cover infrastructure and continue.",
  termsUrl: "/terms",
} as const;

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  id: "singleton",
  version: 1,
  canonicalLightPerUsd: LIGHT_PER_DOLLAR_CANONICAL,
  walletLightPerUsd: LIGHT_PER_DOLLAR_WALLET,
  wireLightPerUsd: LIGHT_PER_DOLLAR_WIRE,
  payoutLightPerUsd: LIGHT_PER_DOLLAR_PAYOUT,
  platformFeeRate: PLATFORM_FEE_RATE,
  minWithdrawalLight: MIN_WITHDRAWAL_LIGHT,
  cardMinimumCents: CARD_MINIMUM_CENTS,
  wireMinimumCents: WIRE_MINIMUM_CENTS,
  cloudUnitLightPer1k: CLOUD_UNIT_LIGHT_PER_1K,
  workerMsPerCloudUnit: WORKER_MS_PER_CLOUD_UNIT,
  workerRequestLightPerInvocation: WORKER_REQUEST_LIGHT_PER_INVOCATION,
  workerLoadLightPerInvocation: WORKER_LOAD_LIGHT_PER_INVOCATION,
  capacityRateCardVersion: CAPACITY_RATE_CARD_VERSION,
  capacityD1ReadLightPerMillionRows: CAPACITY_D1_READ_LIGHT_PER_MILLION_ROWS,
  capacityD1WriteLightPerMillionRows: CAPACITY_D1_WRITE_LIGHT_PER_MILLION_ROWS,
  capacityKvReadLightPerMillionOperations:
    CAPACITY_KV_READ_LIGHT_PER_MILLION_OPERATIONS,
  capacityKvWriteLightPerMillionOperations:
    CAPACITY_KV_WRITE_LIGHT_PER_MILLION_OPERATIONS,
  capacityKvDeleteLightPerMillionOperations:
    CAPACITY_KV_DELETE_LIGHT_PER_MILLION_OPERATIONS,
  capacityKvListLightPerMillionOperations:
    CAPACITY_KV_LIST_LIGHT_PER_MILLION_OPERATIONS,
  capacityR2ClassALightPerMillionOperations:
    CAPACITY_R2_CLASS_A_LIGHT_PER_MILLION_OPERATIONS,
  capacityR2ClassBLightPerMillionOperations:
    CAPACITY_R2_CLASS_B_LIGHT_PER_MILLION_OPERATIONS,
  capacityR2DeleteLightPerMillionOperations:
    CAPACITY_R2_DELETE_LIGHT_PER_MILLION_OPERATIONS,
  capacityQueueLightPerMillionOperations:
    CAPACITY_QUEUE_LIGHT_PER_MILLION_OPERATIONS,
  d1ReadRowsPerCloudUnit: D1_READ_ROWS_PER_CLOUD_UNIT,
  d1WriteRowsPerCloudUnit: D1_WRITE_ROWS_PER_CLOUD_UNIT,
  r2OpsPerCloudUnit: R2_OPS_PER_CLOUD_UNIT,
  kvOpsPerCloudUnit: KV_OPS_PER_CLOUD_UNIT,
  widgetPullsPerCloudUnit: WIDGET_PULLS_PER_CLOUD_UNIT,
  storageFreeBytes: COMBINED_FREE_TIER_BYTES,
  storageLightPerGbMonth: STORAGE_LIGHT_PER_GB_MONTH,
  publishDepositEnabled: true,
  publisherMinPublishBalanceLight: PUBLISHER_MIN_PUBLISH_BALANCE_LIGHT,
  publishedHostingMeterEnabled: false,
  payoutPolicyCopy: DEFAULT_PAYOUT_POLICY_COPY,
  updatedAt: null,
};

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeBillingConfigRow(
  row?: BillingConfigRow | null,
): BillingConfig {
  if (!row) return DEFAULT_BILLING_CONFIG;
  return {
    id: row.id || DEFAULT_BILLING_CONFIG.id,
    version: Number.isInteger(row.version) && Number(row.version) > 0
      ? Number(row.version)
      : DEFAULT_BILLING_CONFIG.version,
    canonicalLightPerUsd: finitePositive(
      row.canonical_light_per_usd,
      DEFAULT_BILLING_CONFIG.canonicalLightPerUsd,
    ),
    walletLightPerUsd: finitePositive(
      row.wallet_light_per_usd,
      DEFAULT_BILLING_CONFIG.walletLightPerUsd,
    ),
    wireLightPerUsd: finitePositive(
      row.wire_light_per_usd,
      DEFAULT_BILLING_CONFIG.wireLightPerUsd,
    ),
    payoutLightPerUsd: finitePositive(
      row.payout_light_per_usd,
      DEFAULT_BILLING_CONFIG.payoutLightPerUsd,
    ),
    platformFeeRate: finiteNonNegative(
      row.platform_fee_rate,
      DEFAULT_BILLING_CONFIG.platformFeeRate,
    ),
    minWithdrawalLight: finitePositive(
      row.min_withdrawal_light,
      DEFAULT_BILLING_CONFIG.minWithdrawalLight,
    ),
    cardMinimumCents: positiveInteger(
      row.card_minimum_cents,
      DEFAULT_BILLING_CONFIG.cardMinimumCents,
    ),
    wireMinimumCents: positiveInteger(
      row.wire_minimum_cents,
      DEFAULT_BILLING_CONFIG.wireMinimumCents,
    ),
    cloudUnitLightPer1k: finitePositive(
      row.cloud_unit_light_per_1k,
      DEFAULT_BILLING_CONFIG.cloudUnitLightPer1k,
    ),
    workerMsPerCloudUnit: positiveInteger(
      row.worker_ms_per_cloud_unit,
      DEFAULT_BILLING_CONFIG.workerMsPerCloudUnit,
    ),
    workerRequestLightPerInvocation: finiteNonNegative(
      row.worker_request_light_per_invocation,
      DEFAULT_BILLING_CONFIG.workerRequestLightPerInvocation,
    ),
    // finiteNonNegative: the load floor legitimately defaults to 0 (OFF).
    workerLoadLightPerInvocation: finiteNonNegative(
      row.worker_load_light_per_invocation,
      DEFAULT_BILLING_CONFIG.workerLoadLightPerInvocation,
    ),
    capacityRateCardVersion: positiveInteger(
      row.capacity_rate_card_version,
      DEFAULT_BILLING_CONFIG.capacityRateCardVersion,
    ),
    capacityD1ReadLightPerMillionRows: finiteNonNegative(
      row.capacity_d1_read_light_per_million_rows,
      DEFAULT_BILLING_CONFIG.capacityD1ReadLightPerMillionRows,
    ),
    capacityD1WriteLightPerMillionRows: finiteNonNegative(
      row.capacity_d1_write_light_per_million_rows,
      DEFAULT_BILLING_CONFIG.capacityD1WriteLightPerMillionRows,
    ),
    capacityKvReadLightPerMillionOperations: finiteNonNegative(
      row.capacity_kv_read_light_per_million_operations,
      DEFAULT_BILLING_CONFIG.capacityKvReadLightPerMillionOperations,
    ),
    capacityKvWriteLightPerMillionOperations: finiteNonNegative(
      row.capacity_kv_write_light_per_million_operations,
      DEFAULT_BILLING_CONFIG.capacityKvWriteLightPerMillionOperations,
    ),
    capacityKvDeleteLightPerMillionOperations: finiteNonNegative(
      row.capacity_kv_delete_light_per_million_operations,
      DEFAULT_BILLING_CONFIG.capacityKvDeleteLightPerMillionOperations,
    ),
    capacityKvListLightPerMillionOperations: finiteNonNegative(
      row.capacity_kv_list_light_per_million_operations,
      DEFAULT_BILLING_CONFIG.capacityKvListLightPerMillionOperations,
    ),
    capacityR2ClassALightPerMillionOperations: finiteNonNegative(
      row.capacity_r2_class_a_light_per_million_operations,
      DEFAULT_BILLING_CONFIG.capacityR2ClassALightPerMillionOperations,
    ),
    capacityR2ClassBLightPerMillionOperations: finiteNonNegative(
      row.capacity_r2_class_b_light_per_million_operations,
      DEFAULT_BILLING_CONFIG.capacityR2ClassBLightPerMillionOperations,
    ),
    capacityR2DeleteLightPerMillionOperations: finiteNonNegative(
      row.capacity_r2_delete_light_per_million_operations,
      DEFAULT_BILLING_CONFIG.capacityR2DeleteLightPerMillionOperations,
    ),
    capacityQueueLightPerMillionOperations: finiteNonNegative(
      row.capacity_queue_light_per_million_operations,
      DEFAULT_BILLING_CONFIG.capacityQueueLightPerMillionOperations,
    ),
    d1ReadRowsPerCloudUnit: positiveInteger(
      row.d1_read_rows_per_cloud_unit,
      DEFAULT_BILLING_CONFIG.d1ReadRowsPerCloudUnit,
    ),
    d1WriteRowsPerCloudUnit: positiveInteger(
      row.d1_write_rows_per_cloud_unit,
      DEFAULT_BILLING_CONFIG.d1WriteRowsPerCloudUnit,
    ),
    r2OpsPerCloudUnit: positiveInteger(
      row.r2_ops_per_cloud_unit,
      DEFAULT_BILLING_CONFIG.r2OpsPerCloudUnit,
    ),
    kvOpsPerCloudUnit: positiveInteger(
      row.kv_ops_per_cloud_unit,
      DEFAULT_BILLING_CONFIG.kvOpsPerCloudUnit,
    ),
    widgetPullsPerCloudUnit: positiveInteger(
      row.widget_pulls_per_cloud_unit,
      DEFAULT_BILLING_CONFIG.widgetPullsPerCloudUnit,
    ),
    storageFreeBytes: positiveInteger(
      row.storage_free_bytes,
      DEFAULT_BILLING_CONFIG.storageFreeBytes,
    ),
    storageLightPerGbMonth: finitePositive(
      row.storage_light_per_gb_month,
      DEFAULT_BILLING_CONFIG.storageLightPerGbMonth,
    ),
    publishDepositEnabled: booleanValue(
      row.publish_deposit_enabled,
      DEFAULT_BILLING_CONFIG.publishDepositEnabled,
    ),
    publisherMinPublishBalanceLight: finitePositive(
      row.publisher_min_publish_balance_light,
      DEFAULT_BILLING_CONFIG.publisherMinPublishBalanceLight,
    ),
    publishedHostingMeterEnabled: booleanValue(
      row.published_hosting_meter_enabled,
      DEFAULT_BILLING_CONFIG.publishedHostingMeterEnabled,
    ),
    payoutPolicyCopy: row.payout_policy_copy ||
      DEFAULT_BILLING_CONFIG.payoutPolicyCopy,
    updatedAt: row.updated_at || null,
  };
}

export function usdCentsToLight(
  amountCents: number,
  lightPerUsd: number,
): number {
  return Math.round((amountCents / 100) * lightPerUsd);
}

export function lightToUsdCents(
  amountLight: number,
  lightPerUsd: number,
): number {
  return Math.round((amountLight / lightPerUsd) * 100);
}

export function formatLightPerUsd(rate: number): string {
  return `${rate.toLocaleString("en-US")} credits / $1`;
}

function formatLightRate(rate: number): string {
  return `${LIGHT_SYMBOL}${
    rate.toLocaleString("en-US", {
      maximumFractionDigits: 6,
    })
  }`;
}

function formatUsdCents(amountCents: number): string {
  return `$${
    (amountCents / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (Number.isInteger(mb)) return `${mb.toLocaleString("en-US")}MB`;
  return `${mb.toLocaleString("en-US", { maximumFractionDigits: 2 })}MB`;
}

export function toPublicBillingConfig(config: BillingConfig) {
  return {
    version: config.version,
    canonical_light_per_usd: config.canonicalLightPerUsd,
    wallet_light_per_usd: config.walletLightPerUsd,
    wire_light_per_usd: config.wireLightPerUsd,
    ach_light_per_usd: config.wireLightPerUsd,
    payout_light_per_usd: config.payoutLightPerUsd,
    platform_fee_rate: config.platformFeeRate,
    min_withdrawal_light: config.minWithdrawalLight,
    card_minimum_cents: config.cardMinimumCents,
    wire_minimum_cents: config.wireMinimumCents,
    ach_minimum_cents: config.wireMinimumCents,
    cloud_unit_light_per_1k: config.cloudUnitLightPer1k,
    worker_ms_per_cloud_unit: config.workerMsPerCloudUnit,
    worker_request_light_per_invocation: config.workerRequestLightPerInvocation,
    worker_load_light_per_invocation: config.workerLoadLightPerInvocation,
    d1_read_rows_per_cloud_unit: config.d1ReadRowsPerCloudUnit,
    d1_write_rows_per_cloud_unit: config.d1WriteRowsPerCloudUnit,
    r2_ops_per_cloud_unit: config.r2OpsPerCloudUnit,
    kv_ops_per_cloud_unit: config.kvOpsPerCloudUnit,
    widget_pulls_per_cloud_unit: config.widgetPullsPerCloudUnit,
    storage_free_bytes: config.storageFreeBytes,
    storage_soft_cap_bytes: config.storageFreeBytes,
    storage_light_per_gb_month: config.storageLightPerGbMonth,
    publish_deposit_enabled: config.publishDepositEnabled,
    publisher_min_publish_balance_light: config.publisherMinPublishBalanceLight,
    published_hosting_meter_enabled: config.publishedHostingMeterEnabled,
    payout_policy_copy: config.payoutPolicyCopy,
    labels: {
      canonical_rate: formatLightPerUsd(config.canonicalLightPerUsd),
      wallet_rate: formatLightPerUsd(config.walletLightPerUsd),
      wire_rate: formatLightPerUsd(config.wireLightPerUsd),
      ach_rate: formatLightPerUsd(config.wireLightPerUsd),
      payout_rate: `${
        config.payoutLightPerUsd.toLocaleString("en-US")
      } credits = $1`,
      card_minimum: formatUsdCents(config.cardMinimumCents),
      wire_minimum: formatUsdCents(config.wireMinimumCents),
      ach_minimum: formatUsdCents(config.wireMinimumCents),
      cloud_unit_rate: `${
        formatLightRate(config.cloudUnitLightPer1k)
      } / 1,000 cloud units`,
      worker_unit: `1 cloud unit per started ${config.workerMsPerCloudUnit}ms`,
      d1_read_unit: `1 cloud unit per ${
        config.d1ReadRowsPerCloudUnit.toLocaleString("en-US")
      } D1 rows read`,
      d1_write_unit: `1 cloud unit per ${
        config.d1WriteRowsPerCloudUnit.toLocaleString("en-US")
      } D1 row written`,
      r2_operation_unit: `1 cloud unit per ${
        config.r2OpsPerCloudUnit.toLocaleString("en-US")
      } R2 operation`,
      kv_operation_unit: `1 cloud unit per ${
        config.kvOpsPerCloudUnit.toLocaleString("en-US")
      } KV operation`,
      widget_pull_unit: `1 cloud unit per ${
        config.widgetPullsPerCloudUnit.toLocaleString("en-US")
      } widget pull`,
      storage_at_rest: `${
        formatLightRate(config.storageLightPerGbMonth)
      } / GB-month after ${formatBytes(config.storageFreeBytes)} free`,
      publisher_min_publish_balance: formatLightRate(
        config.publisherMinPublishBalanceLight,
      ),
    },
    policy_copy: LIGHT_ECONOMY_POLICY_COPY,
  };
}

// In-isolate cache for the billing-config singleton — it is read on every
// execution settlement and several validation paths, but written only by the
// rare admin PATCH. The admin handler invalidates its own isolate immediately;
// other isolates converge within the TTL (acceptable staleness for rates).
// Fetch errors and missing env are never cached; a SUCCESSFUL read of an
// empty table IS cached (it resolves to the defaults — identical to what a
// fresh read would serve, and the admin first-insert invalidates).
const BILLING_CONFIG_TTL_MS = 60_000;
let cachedBillingConfig: { value: BillingConfig; cachedAt: number } | null =
  null;

export function invalidateBillingConfigCache(): void {
  cachedBillingConfig = null;
}

export async function getBillingConfig(): Promise<BillingConfig> {
  if (
    cachedBillingConfig &&
    Date.now() - cachedBillingConfig.cachedAt < BILLING_CONFIG_TTL_MS
  ) {
    // Shallow copy: callers must not be able to poison the shared cache.
    return { ...cachedBillingConfig.value };
  }

  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Copies on every path: the shared DEFAULT constant must never leak by
    // reference to a caller that might mutate it.
    return { ...DEFAULT_BILLING_CONFIG };
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_billing_config?id=eq.singleton&select=*&limit=1`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!res.ok) return { ...DEFAULT_BILLING_CONFIG };
    const rows = await res.json() as BillingConfigRow[];
    const config = { ...normalizeBillingConfigRow(rows[0]) };
    cachedBillingConfig = { value: config, cachedAt: Date.now() };
    return { ...config };
  } catch {
    return { ...DEFAULT_BILLING_CONFIG };
  }
}
