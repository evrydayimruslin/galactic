import {
  normalizeOptionalString,
  readJsonObject,
  RequestValidationError,
} from "./request-validation.ts";
import type { CaptureInspectionFilters } from "./capture-inspection.ts";
import type {
  BuildFlashTrainingDatasetOptions,
  FlashTrainingDatasetFilterMode,
  FlashTrainingJsonlFormat,
} from "./flash-training-dataset.ts";

const GAP_SEVERITIES = new Set<CreateGapPayload["severity"]>([
  "low",
  "medium",
  "high",
  "critical",
]);
const GAP_STATUSES = new Set<NonNullable<UpdateGapPayload["status"]>>([
  "open",
  "claimed",
  "fulfilled",
  "closed",
]);
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_GAP_TITLE_LENGTH = 200;
const MAX_GAP_DESCRIPTION_LENGTH = 8000;
const MAX_AGENT_NOTES_LENGTH = 8000;
const MAX_REVIEWED_BY_LENGTH = 120;
const MAX_APP_CATEGORY_LENGTH = 64;
const MAX_PAYOUT_POLICY_COPY_LENGTH = 1200;
const MAX_POINTS_VALUE = 1_000_000;
const MAX_TOP_UP_LIGHT = 100_000_000;
const MAX_FEE_WAIVER_CREDIT_LIGHT = 100_000_000;
const MAX_FEE_WAIVER_CREDIT_REASON_LENGTH = 160;
const MAX_REFERENCE_TABLE_LENGTH = 80;
const MAX_FUNDING_MINIMUM_CENTS = 500_000;
const MAX_STORAGE_FREE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_FLASH_TRAINING_EXPORT_LIMIT = 1000;

const FLASH_TRAINING_RESPONSE_FORMATS = new Set<
  FlashTrainingExportResponseFormat | "ndjson"
>([
  "json",
  "jsonl",
  "ndjson",
]);
const FLASH_TRAINING_JSONL_FORMATS = new Set<FlashTrainingJsonlFormat>([
  "ultralight",
  "openai_messages",
]);
const FLASH_TRAINING_FILTER_MODES = new Set<
  FlashTrainingDatasetFilterMode
>([
  "training_ready",
  "human_accepted",
  "needs_review",
  "all",
]);
const FLASH_TRAINING_EXPORT_QUERY_KEYS = new Set([
  "conversationId",
  "anonUserId",
  "source",
  "since",
  "until",
  "limit",
  "format",
  "datasetFormat",
  "filterMode",
  "componentId",
  "componentIds",
  "schemaId",
  "schemaIds",
  "capability",
  "capabilities",
  "includeTools",
  "includeIncomplete",
]);

export interface CreateGapPayload {
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  pointsValue: number;
  season: number;
  sourceShortcomingIds: string[];
  sourceQueryIds: string[];
}

export interface UpdateGapPayload {
  title?: string;
  description?: string;
  severity?: "low" | "medium" | "high" | "critical";
  pointsValue?: number;
  season?: number;
  status?: "open" | "claimed" | "fulfilled" | "closed";
  sourceShortcomingIds?: string[];
  sourceQueryIds?: string[];
  fulfilledByAppId?: string | null;
  fulfilledByUserId?: string | null;
}

export interface RecordAssessmentPayload {
  agentScore?: number;
  agentNotes?: string;
  proposedPoints?: number;
}

export interface ApproveAssessmentPayload {
  awardedPoints?: number;
  reviewedBy?: string;
}

export interface TopUpBalancePayload {
  amountLight: number;
}

export interface GrantFeeWaiverCreditPayload {
  publisherUserId: string;
  amountLight: number;
  reason?: string;
  createdByUserId?: string;
  referenceTable?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
}

export interface SetAppCategoryPayload {
  category: string | null;
}

export interface SetAppFeaturedPayload {
  featured: boolean;
}

export interface UpdateBillingConfigPayload {
  canonical_light_per_usd?: number;
  wallet_light_per_usd?: number;
  wire_light_per_usd?: number;
  payout_light_per_usd?: number;
  platform_fee_rate?: number;
  min_withdrawal_light?: number;
  card_minimum_cents?: number;
  wire_minimum_cents?: number;
  cloud_unit_light_per_1k?: number;
  worker_ms_per_cloud_unit?: number;
  d1_read_rows_per_cloud_unit?: number;
  d1_write_rows_per_cloud_unit?: number;
  r2_ops_per_cloud_unit?: number;
  kv_ops_per_cloud_unit?: number;
  widget_pulls_per_cloud_unit?: number;
  storage_free_bytes?: number;
  storage_light_per_gb_month?: number;
  publish_deposit_enabled?: boolean;
  published_hosting_meter_enabled?: boolean;
  payout_policy_copy?: string;
}

export type FlashTrainingExportResponseFormat = "json" | "jsonl";

export interface FlashTrainingExportQuery {
  captureFilters: CaptureInspectionFilters;
  datasetOptions: BuildFlashTrainingDatasetOptions;
  responseFormat: FlashTrainingExportResponseFormat;
  datasetFormat: FlashTrainingJsonlFormat;
  includeTools: boolean;
}

function normalizeRequiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const normalized = normalizeOptionalString(value, field, { maxLength });
  if (!normalized) {
    throw new RequestValidationError(`Missing ${field}`);
  }
  return normalized;
}

function normalizeQueryString(
  params: URLSearchParams,
  field: string,
  maxLength = 128,
): string | undefined {
  const values = params.getAll(field).filter((value) => value.trim());
  if (values.length === 0) return undefined;
  if (values.length > 1) {
    throw new RequestValidationError(`${field} may only be provided once`);
  }
  const normalized = values[0].trim();
  if (normalized.length > maxLength) {
    throw new RequestValidationError(
      `${field} must be ${maxLength} characters or less`,
    );
  }
  return normalized;
}

function normalizeQueryEnum<T extends string>(
  params: URLSearchParams,
  field: string,
  allowed: Set<T>,
): T | undefined {
  const normalized = normalizeQueryString(params, field, 64);
  if (!normalized) return undefined;
  if (!allowed.has(normalized as T)) {
    throw new RequestValidationError(
      `${field} must be one of: ${Array.from(allowed).join(", ")}`,
    );
  }
  return normalized as T;
}

function normalizeQueryBoolean(
  params: URLSearchParams,
  field: string,
): boolean | undefined {
  const normalized = normalizeQueryString(params, field, 16);
  if (!normalized) return undefined;
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new RequestValidationError(`${field} must be a boolean`);
}

function normalizeQueryInteger(
  params: URLSearchParams,
  field: string,
  {
    min,
    max,
  }: {
    min: number;
    max: number;
  },
): number | undefined {
  const normalized = normalizeQueryString(params, field, 16);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) {
    throw new RequestValidationError(`${field} must be an integer`);
  }
  if (parsed < min) {
    throw new RequestValidationError(`${field} must be at least ${min}`);
  }
  if (parsed > max) {
    throw new RequestValidationError(`${field} must be ${max} or less`);
  }
  return parsed;
}

function normalizeQueryIsoTime(
  params: URLSearchParams,
  field: string,
): string | undefined {
  const normalized = normalizeQueryString(params, field, 128);
  if (!normalized) return undefined;
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new RequestValidationError(`${field} must be a valid timestamp`);
  }
  return normalized;
}

function normalizeQueryList(
  params: URLSearchParams,
  fields: string[],
): string[] {
  const values: string[] = [];
  for (const field of fields) {
    for (const raw of params.getAll(field)) {
      for (const part of raw.split(",")) {
        const normalized = part.trim();
        if (!normalized) continue;
        if (normalized.length > 160) {
          throw new RequestValidationError(
            `${field} values must be 160 characters or less`,
          );
        }
        values.push(normalized);
      }
    }
  }
  return Array.from(new Set(values));
}

function rejectUnknownQueryKeys(
  params: URLSearchParams,
  allowedKeys: Set<string>,
): void {
  const unknown = Array.from(new Set(params.keys())).filter((key) =>
    !allowedKeys.has(key)
  );
  if (unknown.length > 0) {
    throw new RequestValidationError(
      `Unsupported query parameter(s): ${unknown.join(", ")}`,
    );
  }
}

function normalizeEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: Set<T>,
): T {
  const normalized = normalizeRequiredString(value, field, 64);
  if (!allowed.has(normalized as T)) {
    throw new RequestValidationError(
      `${field} must be one of: ${Array.from(allowed).join(", ")}`,
    );
  }
  return normalized as T;
}

function normalizeOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: Set<T>,
): T | undefined {
  const normalized = normalizeOptionalString(value, field, { maxLength: 64 });
  if (!normalized) {
    return undefined;
  }
  if (!allowed.has(normalized as T)) {
    throw new RequestValidationError(
      `${field} must be one of: ${Array.from(allowed).join(", ")}`,
    );
  }
  return normalized as T;
}

function normalizeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    throw new RequestValidationError(`${field} must be an integer`);
  }
  return value;
}

function normalizePositiveInteger(
  value: unknown,
  field: string,
  {
    min = 1,
    max = MAX_POINTS_VALUE,
  }: {
    min?: number;
    max?: number;
  } = {},
): number {
  const normalized = normalizeInteger(value, field);
  if (normalized < min) {
    throw new RequestValidationError(`${field} must be at least ${min}`);
  }
  if (normalized > max) {
    throw new RequestValidationError(`${field} must be ${max} or less`);
  }
  return normalized;
}

function normalizeOptionalPositiveInteger(
  value: unknown,
  field: string,
  options?: {
    min?: number;
    max?: number;
  },
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizePositiveInteger(value, field, options);
}

function normalizePositiveNumber(
  value: unknown,
  field: string,
  {
    minExclusive = 0,
    max = MAX_POINTS_VALUE,
  }: {
    minExclusive?: number;
    max?: number;
  } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(`${field} must be a number`);
  }
  if (value <= minExclusive) {
    throw new RequestValidationError(
      `${field} must be greater than ${minExclusive}`,
    );
  }
  if (value > max) {
    throw new RequestValidationError(`${field} must be ${max} or less`);
  }
  return value;
}

function normalizeMetadataObject(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function normalizeRequiredRate(value: unknown, field: string): number {
  const normalized = normalizePositiveNumber(value, field, {
    max: 10_000,
  });
  if (!Number.isInteger(normalized)) {
    throw new RequestValidationError(
      `${field} must be an integer Light-per-USD rate`,
    );
  }
  return normalized;
}

function normalizeRequiredFeeRate(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(`${field} must be a number`);
  }
  if (value < 0 || value >= 1) {
    throw new RequestValidationError(
      `${field} must be at least 0 and less than 1`,
    );
  }
  return value;
}

function normalizeRequiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new RequestValidationError(`${field} must be a boolean`);
  }
  return value;
}

function normalizeOptionalUuid(
  value: unknown,
  field: string,
): string | undefined {
  const normalized = normalizeOptionalString(value, field, { maxLength: 128 });
  if (!normalized) {
    return undefined;
  }
  if (!UUID_REGEX.test(normalized)) {
    throw new RequestValidationError(`${field} must be a valid UUID`);
  }
  return normalized;
}

function normalizeUuid(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field, 128);
  if (!UUID_REGEX.test(normalized)) {
    throw new RequestValidationError(`${field} must be a valid UUID`);
  }
  return normalized;
}

function normalizeNullableUuid(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return normalizeOptionalUuid(value, field);
}

function normalizeUuidArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new RequestValidationError(`${field} must be an array of UUIDs`);
  }

  const deduped = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !UUID_REGEX.test(entry)) {
      throw new RequestValidationError(
        `${field} must contain only valid UUIDs`,
      );
    }
    deduped.add(entry);
  }
  return Array.from(deduped);
}

function normalizeOptionalUuidArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeUuidArray(value, field);
}

export function validateFlashTrainingExportUrl(
  url: URL,
): FlashTrainingExportQuery {
  const params = url.searchParams;
  rejectUnknownQueryKeys(params, FLASH_TRAINING_EXPORT_QUERY_KEYS);

  const rawResponseFormat = normalizeQueryEnum(
    params,
    "format",
    FLASH_TRAINING_RESPONSE_FORMATS,
  );
  const responseFormat: FlashTrainingExportResponseFormat =
    rawResponseFormat === "jsonl" || rawResponseFormat === "ndjson"
      ? "jsonl"
      : "json";
  const includeIncomplete = normalizeQueryBoolean(
    params,
    "includeIncomplete",
  );

  return {
    captureFilters: {
      conversationId: normalizeQueryString(params, "conversationId", 160),
      anonUserId: normalizeQueryString(params, "anonUserId", 160),
      source: normalizeQueryString(params, "source", 160),
      since: normalizeQueryIsoTime(params, "since"),
      until: normalizeQueryIsoTime(params, "until"),
      limit: normalizeQueryInteger(params, "limit", {
        min: 1,
        max: MAX_FLASH_TRAINING_EXPORT_LIMIT,
      }),
    },
    datasetOptions: {
      filterMode: normalizeQueryEnum(
        params,
        "filterMode",
        FLASH_TRAINING_FILTER_MODES,
      ),
      componentIds: normalizeQueryList(params, ["componentId", "componentIds"]),
      schemaIds: normalizeQueryList(params, ["schemaId", "schemaIds"]),
      capabilities: normalizeQueryList(params, ["capability", "capabilities"]),
      includeIncomplete,
    },
    responseFormat,
    datasetFormat: normalizeQueryEnum(
      params,
      "datasetFormat",
      FLASH_TRAINING_JSONL_FORMATS,
    ) || "ultralight",
    includeTools: normalizeQueryBoolean(params, "includeTools") || false,
  };
}

export async function validateCreateGapRequest(
  request: Request,
): Promise<CreateGapPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: [
      "title",
      "description",
      "severity",
      "points_value",
      "season",
      "source_shortcoming_ids",
      "source_query_ids",
    ],
  });

  return {
    title: normalizeRequiredString(body.title, "title", MAX_GAP_TITLE_LENGTH),
    description: normalizeRequiredString(
      body.description,
      "description",
      MAX_GAP_DESCRIPTION_LENGTH,
    ),
    severity:
      normalizeOptionalEnum(body.severity, "severity", GAP_SEVERITIES) ||
      "medium",
    pointsValue:
      normalizeOptionalPositiveInteger(body.points_value, "points_value") ??
        100,
    season: normalizeOptionalPositiveInteger(body.season, "season", {
      max: 10_000,
    }) ?? 1,
    sourceShortcomingIds: normalizeUuidArray(
      body.source_shortcoming_ids,
      "source_shortcoming_ids",
    ),
    sourceQueryIds: normalizeUuidArray(
      body.source_query_ids,
      "source_query_ids",
    ),
  };
}

export async function validateUpdateGapRequest(
  request: Request,
): Promise<UpdateGapPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: [
      "title",
      "description",
      "severity",
      "points_value",
      "season",
      "status",
      "source_shortcoming_ids",
      "source_query_ids",
      "fulfilled_by_app_id",
      "fulfilled_by_user_id",
    ],
  });

  const payload: UpdateGapPayload = {};

  if (body.title !== undefined) {
    payload.title = normalizeRequiredString(
      body.title,
      "title",
      MAX_GAP_TITLE_LENGTH,
    );
  }
  if (body.description !== undefined) {
    payload.description = normalizeRequiredString(
      body.description,
      "description",
      MAX_GAP_DESCRIPTION_LENGTH,
    );
  }
  if (body.severity !== undefined) {
    payload.severity = normalizeEnum(body.severity, "severity", GAP_SEVERITIES);
  }
  if (body.points_value !== undefined) {
    payload.pointsValue = normalizePositiveInteger(
      body.points_value,
      "points_value",
    );
  }
  if (body.season !== undefined) {
    payload.season = normalizePositiveInteger(body.season, "season", {
      max: 10_000,
    });
  }
  if (body.status !== undefined) {
    payload.status = normalizeEnum(body.status, "status", GAP_STATUSES);
  }
  if (body.source_shortcoming_ids !== undefined) {
    payload.sourceShortcomingIds = normalizeOptionalUuidArray(
      body.source_shortcoming_ids,
      "source_shortcoming_ids",
    );
  }
  if (body.source_query_ids !== undefined) {
    payload.sourceQueryIds = normalizeOptionalUuidArray(
      body.source_query_ids,
      "source_query_ids",
    );
  }
  if (body.fulfilled_by_app_id !== undefined) {
    payload.fulfilledByAppId = normalizeNullableUuid(
      body.fulfilled_by_app_id,
      "fulfilled_by_app_id",
    );
  }
  if (body.fulfilled_by_user_id !== undefined) {
    payload.fulfilledByUserId = normalizeNullableUuid(
      body.fulfilled_by_user_id,
      "fulfilled_by_user_id",
    );
  }

  if (Object.keys(payload).length === 0) {
    throw new RequestValidationError("At least one gap field is required");
  }

  return payload;
}

export async function validateRecordAssessmentRequest(
  request: Request,
): Promise<RecordAssessmentPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["agent_score", "agent_notes", "proposed_points"],
  });

  const payload: RecordAssessmentPayload = {};
  if (body.agent_score !== undefined) {
    payload.agentScore = normalizePositiveInteger(
      body.agent_score,
      "agent_score",
      { min: 0, max: 100 },
    );
  }
  if (body.agent_notes !== undefined) {
    payload.agentNotes = normalizeRequiredString(
      body.agent_notes,
      "agent_notes",
      MAX_AGENT_NOTES_LENGTH,
    );
  }
  if (body.proposed_points !== undefined) {
    payload.proposedPoints = normalizePositiveInteger(
      body.proposed_points,
      "proposed_points",
    );
  }

  if (Object.keys(payload).length === 0) {
    throw new RequestValidationError(
      "At least one of agent_score, agent_notes, proposed_points required",
    );
  }

  return payload;
}

export async function validateApproveAssessmentRequest(
  request: Request,
): Promise<ApproveAssessmentPayload> {
  const body = await readJsonObject(request, {
    allowEmptyBody: true,
    allowedKeys: ["awarded_points", "reviewed_by"],
  });

  return {
    awardedPoints: normalizeOptionalPositiveInteger(
      body.awarded_points,
      "awarded_points",
    ),
    reviewedBy: normalizeOptionalString(body.reviewed_by, "reviewed_by", {
      maxLength: MAX_REVIEWED_BY_LENGTH,
    }),
  };
}

export async function validateTopUpBalanceRequest(
  request: Request,
): Promise<TopUpBalancePayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["amount_light"],
  });

  return {
    amountLight: normalizePositiveInteger(body.amount_light, "amount_light", {
      max: MAX_TOP_UP_LIGHT,
    }),
  };
}

export async function validateGrantFeeWaiverCreditRequest(
  request: Request,
): Promise<GrantFeeWaiverCreditPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: [
      "publisher_user_id",
      "amount_light",
      "reason",
      "created_by_user_id",
      "reference_table",
      "reference_id",
      "metadata",
    ],
  });

  return {
    publisherUserId: normalizeUuid(body.publisher_user_id, "publisher_user_id"),
    amountLight: normalizePositiveNumber(body.amount_light, "amount_light", {
      max: MAX_FEE_WAIVER_CREDIT_LIGHT,
    }),
    reason: normalizeOptionalString(body.reason, "reason", {
      maxLength: MAX_FEE_WAIVER_CREDIT_REASON_LENGTH,
    }) || "admin_reward",
    createdByUserId: normalizeOptionalUuid(
      body.created_by_user_id,
      "created_by_user_id",
    ),
    referenceTable: normalizeOptionalString(body.reference_table, "reference_table", {
      maxLength: MAX_REFERENCE_TABLE_LENGTH,
    }),
    referenceId: normalizeOptionalUuid(body.reference_id, "reference_id"),
    metadata: normalizeMetadataObject(body.metadata, "metadata"),
  };
}

export async function validateSetAppCategoryRequest(
  request: Request,
): Promise<SetAppCategoryPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["category"],
  });

  if (body.category === null || body.category === undefined) {
    return { category: null };
  }

  return {
    category: normalizeRequiredString(
      body.category,
      "category",
      MAX_APP_CATEGORY_LENGTH,
    ),
  };
}

export async function validateSetAppFeaturedRequest(
  request: Request,
): Promise<SetAppFeaturedPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["featured"],
  });

  if (typeof body.featured !== "boolean") {
    throw new RequestValidationError("featured must be a boolean");
  }

  return {
    featured: body.featured,
  };
}

export async function validateUpdateBillingConfigRequest(
  request: Request,
): Promise<UpdateBillingConfigPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: [
      "canonical_light_per_usd",
      "wallet_light_per_usd",
      "wire_light_per_usd",
      "payout_light_per_usd",
      "platform_fee_rate",
      "min_withdrawal_light",
      "card_minimum_cents",
      "wire_minimum_cents",
      "cloud_unit_light_per_1k",
      "worker_ms_per_cloud_unit",
      "d1_read_rows_per_cloud_unit",
      "d1_write_rows_per_cloud_unit",
      "r2_ops_per_cloud_unit",
      "kv_ops_per_cloud_unit",
      "widget_pulls_per_cloud_unit",
      "storage_free_bytes",
      "storage_light_per_gb_month",
      "publish_deposit_enabled",
      "published_hosting_meter_enabled",
      "payout_policy_copy",
    ],
  });

  const payload: UpdateBillingConfigPayload = {};
  if (body.canonical_light_per_usd !== undefined) {
    payload.canonical_light_per_usd = normalizeRequiredRate(
      body.canonical_light_per_usd,
      "canonical_light_per_usd",
    );
  }
  if (body.wallet_light_per_usd !== undefined) {
    payload.wallet_light_per_usd = normalizeRequiredRate(
      body.wallet_light_per_usd,
      "wallet_light_per_usd",
    );
  }
  if (body.wire_light_per_usd !== undefined) {
    payload.wire_light_per_usd = normalizeRequiredRate(
      body.wire_light_per_usd,
      "wire_light_per_usd",
    );
  }
  if (body.payout_light_per_usd !== undefined) {
    payload.payout_light_per_usd = normalizeRequiredRate(
      body.payout_light_per_usd,
      "payout_light_per_usd",
    );
  }
  if (body.platform_fee_rate !== undefined) {
    payload.platform_fee_rate = normalizeRequiredFeeRate(
      body.platform_fee_rate,
      "platform_fee_rate",
    );
  }
  if (body.min_withdrawal_light !== undefined) {
    payload.min_withdrawal_light = normalizePositiveNumber(
      body.min_withdrawal_light,
      "min_withdrawal_light",
      { max: MAX_TOP_UP_LIGHT },
    );
  }
  if (body.card_minimum_cents !== undefined) {
    payload.card_minimum_cents = normalizePositiveInteger(
      body.card_minimum_cents,
      "card_minimum_cents",
      { max: MAX_FUNDING_MINIMUM_CENTS },
    );
  }
  if (body.wire_minimum_cents !== undefined) {
    payload.wire_minimum_cents = normalizePositiveInteger(
      body.wire_minimum_cents,
      "wire_minimum_cents",
      { max: MAX_FUNDING_MINIMUM_CENTS },
    );
  }
  if (body.cloud_unit_light_per_1k !== undefined) {
    payload.cloud_unit_light_per_1k = normalizePositiveNumber(
      body.cloud_unit_light_per_1k,
      "cloud_unit_light_per_1k",
      { max: MAX_TOP_UP_LIGHT },
    );
  }
  if (body.worker_ms_per_cloud_unit !== undefined) {
    payload.worker_ms_per_cloud_unit = normalizePositiveInteger(
      body.worker_ms_per_cloud_unit,
      "worker_ms_per_cloud_unit",
      { max: 60_000 },
    );
  }
  if (body.d1_read_rows_per_cloud_unit !== undefined) {
    payload.d1_read_rows_per_cloud_unit = normalizePositiveInteger(
      body.d1_read_rows_per_cloud_unit,
      "d1_read_rows_per_cloud_unit",
      { max: MAX_TOP_UP_LIGHT },
    );
  }
  if (body.d1_write_rows_per_cloud_unit !== undefined) {
    payload.d1_write_rows_per_cloud_unit = normalizePositiveInteger(
      body.d1_write_rows_per_cloud_unit,
      "d1_write_rows_per_cloud_unit",
      { max: MAX_TOP_UP_LIGHT },
    );
  }
  if (body.r2_ops_per_cloud_unit !== undefined) {
    payload.r2_ops_per_cloud_unit = normalizePositiveInteger(
      body.r2_ops_per_cloud_unit,
      "r2_ops_per_cloud_unit",
      { max: MAX_TOP_UP_LIGHT },
    );
  }
  if (body.kv_ops_per_cloud_unit !== undefined) {
    payload.kv_ops_per_cloud_unit = normalizePositiveInteger(
      body.kv_ops_per_cloud_unit,
      "kv_ops_per_cloud_unit",
      { max: MAX_TOP_UP_LIGHT },
    );
  }
  if (body.widget_pulls_per_cloud_unit !== undefined) {
    payload.widget_pulls_per_cloud_unit = normalizePositiveInteger(
      body.widget_pulls_per_cloud_unit,
      "widget_pulls_per_cloud_unit",
      { max: MAX_TOP_UP_LIGHT },
    );
  }
  if (body.storage_free_bytes !== undefined) {
    payload.storage_free_bytes = normalizePositiveInteger(
      body.storage_free_bytes,
      "storage_free_bytes",
      { max: MAX_STORAGE_FREE_BYTES },
    );
  }
  if (body.storage_light_per_gb_month !== undefined) {
    payload.storage_light_per_gb_month = normalizePositiveNumber(
      body.storage_light_per_gb_month,
      "storage_light_per_gb_month",
      { max: MAX_TOP_UP_LIGHT },
    );
  }
  if (body.publish_deposit_enabled !== undefined) {
    payload.publish_deposit_enabled = normalizeRequiredBoolean(
      body.publish_deposit_enabled,
      "publish_deposit_enabled",
    );
  }
  if (body.published_hosting_meter_enabled !== undefined) {
    payload.published_hosting_meter_enabled = normalizeRequiredBoolean(
      body.published_hosting_meter_enabled,
      "published_hosting_meter_enabled",
    );
  }
  if (body.payout_policy_copy !== undefined) {
    payload.payout_policy_copy = normalizeRequiredString(
      body.payout_policy_copy,
      "payout_policy_copy",
      MAX_PAYOUT_POLICY_COPY_LENGTH,
    );
  }

  if (Object.keys(payload).length === 0) {
    throw new RequestValidationError(
      "At least one billing config field is required",
    );
  }

  return payload;
}
