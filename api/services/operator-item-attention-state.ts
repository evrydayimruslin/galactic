import { getEnv } from "../lib/env.ts";
import type {
  LaunchOperatorAttentionAction,
  LaunchOperatorAttentionActionResponse,
  LaunchOperatorAttentionState,
} from "../../shared/contracts/launch.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_SNOOZE_MS = 30 * 24 * 60 * 60 * 1_000;
const ACTIONS = new Set<LaunchOperatorAttentionAction>([
  "mark_read",
  "mark_unread",
  "snooze",
  "reopen",
  "dismiss",
]);

interface OperatorItemAttentionStateDependencies {
  fetchFn?: typeof fetch;
  now?: Date;
  serviceRoleKey?: string;
  supabaseUrl?: string;
}

type OperatorItemAttentionStateErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "SERVICE_UNAVAILABLE"
  | "UPDATE_FAILED"
  | "INVALID_RESPONSE";

export class OperatorItemAttentionStateError extends Error {
  constructor(
    readonly code: OperatorItemAttentionStateErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OperatorItemAttentionStateError";
  }
}

function fail(
  code: OperatorItemAttentionStateErrorCode,
  message: string,
): never {
  const status = code === "INVALID_REQUEST"
    ? 400
    : code === "NOT_FOUND"
    ? 404
    : 503;
  throw new OperatorItemAttentionStateError(code, message, status);
}

function uuid(
  value: unknown,
  label: string,
  invalidCode: "INVALID_REQUEST" | "INVALID_RESPONSE" = "INVALID_REQUEST",
): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail(invalidCode, `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  const parsed = record(value);
  if (
    !parsed ||
    Object.keys(parsed).sort().join(",") !== [...expected].sort().join(",")
  ) {
    fail("INVALID_RESPONSE", "Operator Attention returned an invalid state.");
  }
  return parsed;
}

function iso(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("INVALID_RESPONSE", `${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function actionInput(
  actionValue: unknown,
  snoozedUntilValue: unknown,
  now: Date,
): { action: LaunchOperatorAttentionAction; snoozedUntil: string | null } {
  if (
    typeof actionValue !== "string" ||
    !ACTIONS.has(actionValue as LaunchOperatorAttentionAction)
  ) {
    fail("INVALID_REQUEST", "Operator Attention action is invalid.");
  }
  const action = actionValue as LaunchOperatorAttentionAction;
  if (action !== "snooze") {
    if (snoozedUntilValue !== undefined) {
      fail(
        "INVALID_REQUEST",
        "snoozedUntil is valid only for the snooze action.",
      );
    }
    return { action, snoozedUntil: null };
  }
  if (
    typeof snoozedUntilValue !== "string" ||
    !Number.isFinite(Date.parse(snoozedUntilValue))
  ) {
    fail("INVALID_REQUEST", "snoozedUntil must be a future ISO timestamp.");
  }
  const snoozedUntil = new Date(snoozedUntilValue);
  if (
    snoozedUntil.getTime() <= now.getTime() ||
    snoozedUntil.getTime() - now.getTime() > MAX_SNOOZE_MS
  ) {
    fail(
      "INVALID_REQUEST",
      "snoozedUntil must be within the next 30 days.",
    );
  }
  return { action, snoozedUntil: snoozedUntil.toISOString() };
}

function parseState(
  value: unknown,
  expectedUserId: string,
  expectedItemId: string,
): LaunchOperatorAttentionState {
  const state = exactKeys(value, [
    "item_id",
    "user_id",
    "state",
    "read_at",
    "snoozed_until",
    "dismissed_at",
    "created_at",
    "updated_at",
  ]);
  if (
    uuid(state.user_id, "Operator Attention user", "INVALID_RESPONSE") !==
      expectedUserId ||
    uuid(state.item_id, "Operator Attention item", "INVALID_RESPONSE") !==
      expectedItemId ||
    !["open", "snoozed", "dismissed"].includes(String(state.state))
  ) {
    fail("INVALID_RESPONSE", "Operator Attention returned an invalid state.");
  }
  const readAt = state.read_at === null
    ? null
    : iso(state.read_at, "Operator Attention readAt");
  const snoozedUntil = state.snoozed_until === null
    ? null
    : iso(state.snoozed_until, "Operator Attention snoozedUntil");
  const dismissedAt = state.dismissed_at === null
    ? null
    : iso(state.dismissed_at, "Operator Attention dismissedAt");
  if (
    (state.state === "open" &&
      (snoozedUntil !== null || dismissedAt !== null)) ||
    (state.state === "snoozed" &&
      (snoozedUntil === null || dismissedAt !== null)) ||
    (state.state === "dismissed" &&
      (snoozedUntil !== null || dismissedAt === null))
  ) {
    fail("INVALID_RESPONSE", "Operator Attention returned an invalid state.");
  }
  return {
    state: state.state as LaunchOperatorAttentionState["state"],
    readAt,
    snoozedUntil,
    dismissedAt,
  };
}

export async function applyOperatorItemAttentionAction(
  input: {
    userId: string;
    itemId: string;
    action: unknown;
    snoozedUntil?: unknown;
  },
  dependencies: OperatorItemAttentionStateDependencies = {},
): Promise<LaunchOperatorAttentionActionResponse> {
  const userId = uuid(input.userId, "userId");
  const itemId = uuid(input.itemId, "itemId");
  const now = dependencies.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    fail("INVALID_REQUEST", "now is invalid.");
  }
  const { action, snoozedUntil } = actionInput(
    input.action,
    input.snoozedUntil,
    now,
  );
  const baseUrl = (dependencies.supabaseUrl ?? getEnv("SUPABASE_URL")).replace(
    /\/+$/u,
    "",
  );
  const serviceRoleKey = dependencies.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    fail("SERVICE_UNAVAILABLE", "Operator Attention is not configured.");
  }
  const response = await (dependencies.fetchFn ?? fetch)(
    `${baseUrl}/rest/v1/rpc/apply_operator_item_attention_action`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_item_id: itemId,
        p_action: action,
        p_snoozed_until: snoozedUntil,
      }),
    },
  ).catch(() =>
    fail("UPDATE_FAILED", "Operator Attention could not be updated.")
  );
  if (!response.ok) {
    await response.text().catch(() => "");
    fail("UPDATE_FAILED", "Operator Attention could not be updated.");
  }
  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    fail("INVALID_RESPONSE", "Operator Attention returned an invalid state.");
  }
  if (!Array.isArray(rows)) {
    fail("INVALID_RESPONSE", "Operator Attention returned an invalid state.");
  }
  if (rows.length === 0) {
    fail("NOT_FOUND", "Operator item was not found.");
  }
  if (rows.length !== 1) {
    fail("INVALID_RESPONSE", "Operator Attention returned an invalid state.");
  }
  return {
    itemId,
    attention: parseState(rows[0], userId, itemId),
  };
}
