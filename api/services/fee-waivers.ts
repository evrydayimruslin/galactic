import { RequestValidationError } from "./request-validation.ts";
import { createSupabaseRestClient } from "./platform-clients/supabase-rest.ts";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LEDGER_LIMIT = 100;
const MAX_LEADERBOARD_LIMIT = 100;
const DEFAULT_LEDGER_LIMIT = 50;
const DEFAULT_LEADERBOARD_LIMIT = 50;
const PERIOD_DAYS = {
  "30d": 30,
  "90d": 90,
} as const;

export type FeeWaiverLeaderboardPeriod = keyof typeof PERIOD_DAYS | "all";

interface FeeWaiverDeps {
  fetchFn?: typeof fetch;
  now?: () => Date;
}

interface FeeCreditAccountRow {
  publisher_user_id: string;
  balance_light: number | null;
  lifetime_granted_light: number | null;
  lifetime_spent_light: number | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface FeeCreditLedgerRow {
  id: string;
  publisher_user_id: string;
  amount_light: number | null;
  balance_after_light: number | null;
  kind: "grant" | "spend" | "adjustment";
  reason: string;
  reference_table: string | null;
  reference_id: string | null;
  created_by_user_id: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

interface GrantFeeCreditRpcRow {
  publisher_user_id: string;
  balance_light: number | null;
  lifetime_granted_light: number | null;
  lifetime_spent_light: number | null;
  ledger_id: string;
  amount_light: number | null;
  reason: string;
  created_at: string;
}

interface LeaderboardRpcRow {
  rank: number;
  publisher_user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_slug: string | null;
  fee_waived_light: number | null;
  event_count: number | null;
  referral_waived_light: number | null;
  fee_credit_waived_light: number | null;
  marketplace_waived_light: number | null;
  tool_call_waived_light: number | null;
  gpu_developer_fee_waived_light: number | null;
  first_waived_at: string | null;
  last_waived_at: string | null;
}

export interface GrantPublisherFeeWaiverCreditInput {
  publisherUserId: string;
  amountLight: number;
  reason?: string;
  createdByUserId?: string | null;
  referenceTable?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FeeWaiverCreditAccount {
  publisher_user_id: string;
  balance_light: number;
  lifetime_granted_light: number;
  lifetime_spent_light: number;
  metadata: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
}

export interface FeeWaiverCreditLedgerEntry {
  id: string;
  publisher_user_id: string;
  amount_light: number;
  balance_after_light: number;
  kind: "grant" | "spend" | "adjustment";
  reason: string;
  reference_table: string | null;
  reference_id: string | null;
  created_by_user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface FeeWaiverCreditSummary {
  publisher_user_id: string;
  account: FeeWaiverCreditAccount;
  ledger: FeeWaiverCreditLedgerEntry[];
}

export interface GrantPublisherFeeWaiverCreditResult {
  success: true;
  publisher_user_id: string;
  account: FeeWaiverCreditAccount;
  ledger_entry: FeeWaiverCreditLedgerEntry;
}

export interface FeeWaiverLeaderboardEntry {
  rank: number;
  publisher_user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_slug: string | null;
  fee_waived_light: number;
  event_count: number;
  referral_waived_light: number;
  fee_credit_waived_light: number;
  marketplace_waived_light: number;
  tool_call_waived_light: number;
  gpu_developer_fee_waived_light: number;
  first_waived_at: string | null;
  last_waived_at: string | null;
}

export interface FeeWaiverLeaderboard {
  period: FeeWaiverLeaderboardPeriod;
  since: string | null;
  limit: number;
  generated_at: string;
  entries: FeeWaiverLeaderboardEntry[];
}

export interface FeeWaiverLeaderboardOptions {
  period?: FeeWaiverLeaderboardPeriod;
  limit?: number;
}

function postgrestEq(value: string): string {
  return encodeURIComponent(`eq.${value}`);
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value || NaN)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value as number), max));
}

function numeric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readRows<T>(response: Response, message: string): Promise<T[]> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail ? `${message}: ${detail}` : message);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload as T[] : [payload as T];
}

function emptyAccount(publisherUserId: string): FeeWaiverCreditAccount {
  return {
    publisher_user_id: publisherUserId,
    balance_light: 0,
    lifetime_granted_light: 0,
    lifetime_spent_light: 0,
    metadata: {},
    created_at: null,
    updated_at: null,
  };
}

function accountFromRow(row: FeeCreditAccountRow | null, publisherUserId: string): FeeWaiverCreditAccount {
  if (!row) return emptyAccount(publisherUserId);
  return {
    publisher_user_id: row.publisher_user_id,
    balance_light: numeric(row.balance_light),
    lifetime_granted_light: numeric(row.lifetime_granted_light),
    lifetime_spent_light: numeric(row.lifetime_spent_light),
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ledgerFromRow(row: FeeCreditLedgerRow): FeeWaiverCreditLedgerEntry {
  return {
    id: row.id,
    publisher_user_id: row.publisher_user_id,
    amount_light: numeric(row.amount_light),
    balance_after_light: numeric(row.balance_after_light),
    kind: row.kind,
    reason: row.reason,
    reference_table: row.reference_table,
    reference_id: row.reference_id,
    created_by_user_id: row.created_by_user_id,
    metadata: row.metadata || {},
    created_at: row.created_at,
  };
}

function sinceForPeriod(period: FeeWaiverLeaderboardPeriod, now: Date): string | null {
  if (period === "all") return null;
  return new Date(now.getTime() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000).toISOString();
}

function validatePublisherUserId(publisherUserId: string): void {
  if (!UUID_REGEX.test(publisherUserId)) {
    throw new RequestValidationError("publisherUserId must be a valid UUID");
  }
}

export function parseFeeWaiverLeaderboardQuery(url: URL): FeeWaiverLeaderboardOptions {
  const allowedKeys = new Set(["period", "limit"]);
  const unknown = Array.from(new Set(url.searchParams.keys())).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new RequestValidationError(`Unsupported query parameter(s): ${unknown.join(", ")}`);
  }

  const periodParam = url.searchParams.get("period") || "30d";
  if (periodParam !== "30d" && periodParam !== "90d" && periodParam !== "all") {
    throw new RequestValidationError("period must be one of: 30d, 90d, all");
  }

  const limitParam = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit)) {
      throw new RequestValidationError("limit must be an integer");
    }
    if (limit < 1 || limit > MAX_LEADERBOARD_LIMIT) {
      throw new RequestValidationError(`limit must be between 1 and ${MAX_LEADERBOARD_LIMIT}`);
    }
  }

  return { period: periodParam, limit };
}

export async function grantPublisherFeeWaiverCredit(
  input: GrantPublisherFeeWaiverCreditInput,
  deps: FeeWaiverDeps = {},
): Promise<GrantPublisherFeeWaiverCreditResult> {
  validatePublisherUserId(input.publisherUserId);
  if (!Number.isFinite(input.amountLight) || input.amountLight <= 0) {
    throw new RequestValidationError("amountLight must be positive");
  }

  const response = await createSupabaseRestClient({ fetchFn: deps.fetchFn }).rpc(
    "grant_publisher_fee_credit",
    {
      p_publisher_user_id: input.publisherUserId,
      p_amount_light: input.amountLight,
      p_reason: input.reason || "admin_reward",
      p_created_by_user_id: input.createdByUserId || null,
      p_reference_table: input.referenceTable || null,
      p_reference_id: input.referenceId || null,
      p_metadata: input.metadata || {},
    },
  );
  const rows = await readRows<GrantFeeCreditRpcRow>(response, "Failed to grant fee-waiver credit");
  const row = rows[0];
  if (!row) {
    throw new Error("Fee-waiver credit grant returned no rows");
  }

  return {
    success: true,
    publisher_user_id: row.publisher_user_id,
    account: {
      publisher_user_id: row.publisher_user_id,
      balance_light: numeric(row.balance_light),
      lifetime_granted_light: numeric(row.lifetime_granted_light),
      lifetime_spent_light: numeric(row.lifetime_spent_light),
      metadata: {},
      created_at: null,
      updated_at: null,
    },
    ledger_entry: {
      id: row.ledger_id,
      publisher_user_id: row.publisher_user_id,
      amount_light: numeric(row.amount_light),
      balance_after_light: numeric(row.balance_light),
      kind: "grant",
      reason: row.reason,
      reference_table: input.referenceTable || null,
      reference_id: input.referenceId || null,
      created_by_user_id: input.createdByUserId || null,
      metadata: input.metadata || {},
      created_at: row.created_at,
    },
  };
}

export async function getPublisherFeeWaiverCredit(
  publisherUserId: string,
  options: { ledgerLimit?: number } & FeeWaiverDeps = {},
): Promise<FeeWaiverCreditSummary> {
  validatePublisherUserId(publisherUserId);
  const limit = clampLimit(options.ledgerLimit, DEFAULT_LEDGER_LIMIT, MAX_LEDGER_LIMIT);
  const client = createSupabaseRestClient({ fetchFn: options.fetchFn });

  const [accountResponse, ledgerResponse] = await Promise.all([
    client.request(
      `/rest/v1/publisher_fee_credit_accounts?publisher_user_id=${
        postgrestEq(publisherUserId)
      }&select=publisher_user_id,balance_light,lifetime_granted_light,lifetime_spent_light,metadata,created_at,updated_at&limit=1`,
    ),
    client.request(
      `/rest/v1/publisher_fee_credit_ledger?publisher_user_id=${
        postgrestEq(publisherUserId)
      }&select=id,publisher_user_id,amount_light,balance_after_light,kind,reason,reference_table,reference_id,created_by_user_id,metadata,created_at&order=created_at.desc&limit=${limit}`,
    ),
  ]);

  const [accountRows, ledgerRows] = await Promise.all([
    readRows<FeeCreditAccountRow>(accountResponse, "Failed to fetch fee-waiver credit account"),
    readRows<FeeCreditLedgerRow>(ledgerResponse, "Failed to fetch fee-waiver credit ledger"),
  ]);

  return {
    publisher_user_id: publisherUserId,
    account: accountFromRow(accountRows[0] || null, publisherUserId),
    ledger: ledgerRows.map(ledgerFromRow),
  };
}

export async function getFeeWaiverLeaderboard(
  options: FeeWaiverLeaderboardOptions & FeeWaiverDeps = {},
): Promise<FeeWaiverLeaderboard> {
  const period = options.period || "30d";
  const limit = clampLimit(options.limit, DEFAULT_LEADERBOARD_LIMIT, MAX_LEADERBOARD_LIMIT);
  const now = options.now?.() || new Date();
  const since = sinceForPeriod(period, now);
  const response = await createSupabaseRestClient({ fetchFn: options.fetchFn }).rpc(
    "get_fee_waiver_leaderboard",
    {
      p_since: since,
      p_limit: limit,
    },
  );
  const rows = await readRows<LeaderboardRpcRow>(response, "Failed to fetch fee-waiver leaderboard");

  return {
    period,
    since,
    limit,
    generated_at: now.toISOString(),
    entries: rows.map((row) => ({
      rank: Number(row.rank || 0),
      publisher_user_id: row.publisher_user_id,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      profile_slug: row.profile_slug,
      fee_waived_light: numeric(row.fee_waived_light),
      event_count: Number(row.event_count || 0),
      referral_waived_light: numeric(row.referral_waived_light),
      fee_credit_waived_light: numeric(row.fee_credit_waived_light),
      marketplace_waived_light: numeric(row.marketplace_waived_light),
      tool_call_waived_light: numeric(row.tool_call_waived_light),
      gpu_developer_fee_waived_light: numeric(row.gpu_developer_fee_waived_light),
      first_waived_at: row.first_waived_at,
      last_waived_at: row.last_waived_at,
    })),
  };
}
