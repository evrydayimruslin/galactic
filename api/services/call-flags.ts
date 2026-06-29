// Receipt-verified post-call flags (Phase 3 trust signal).
//
// gx.flag records a caller's binary outcome assessment of a call, bound to the
// call's receipt_id (= mcp_call_logs.id). The flag is accepted ONLY when the
// receipt is a REAL, recent call that THIS user made and does not own — so the
// "feedback telemetry" can't be farmed without actually making calls, and an
// owner can't inflate their own Agent. One flag per receipt (upsert).

import { getEnv } from "../lib/env.ts";

// A receipt older than this can no longer be flagged (a flag is a fresh
// post-call signal, not a retroactive bulk action).
const FLAG_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type FlagStatus = "positive" | "negative";

// Notes are ranking-only and never rendered; cap length here so EVERY caller is
// bounded regardless of entry point.
const MAX_NOTE_LEN = 500;

export interface FlagResult {
  ok: boolean;
  reason?:
    | "unavailable"
    | "lookup_failed"
    | "receipt_not_found"
    | "receipt_not_yours"
    | "no_target_app"
    | "receipt_stale"
    | "free_call"
    | "app_not_found"
    | "self_flag"
    | "write_failed";
  app_id?: string;
  status?: FlagStatus;
}

interface ReceiptRow {
  id: string;
  user_id: string;
  app_id: string | null;
  function_name: string | null;
  success: boolean | null;
  created_at: string;
  call_charge_light: number | null;
}

export async function recordCallFlag(input: {
  receiptId: string;
  userId: string;
  status: FlagStatus;
  note?: string;
  weight: number;
}): Promise<FlagResult> {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { ok: false, reason: "unavailable" };
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // 1. The receipt must be a real call this user made.
  let receipt: ReceiptRow | undefined;
  try {
    const res = await fetch(
      `${url}/rest/v1/mcp_call_logs?id=eq.${encodeURIComponent(input.receiptId)}` +
        `&select=id,user_id,app_id,function_name,success,created_at,call_charge_light&limit=1`,
      { headers },
    );
    if (!res.ok) return { ok: false, reason: "lookup_failed" };
    receipt = (await res.json() as ReceiptRow[])[0];
  } catch {
    return { ok: false, reason: "lookup_failed" };
  }
  if (!receipt) return { ok: false, reason: "receipt_not_found" };
  if (receipt.user_id !== input.userId) return { ok: false, reason: "receipt_not_yours" };
  if (!receipt.app_id) return { ok: false, reason: "no_target_app" };

  // 2. Recent.
  const age = Date.now() - Date.parse(receipt.created_at);
  if (!Number.isFinite(age) || age > FLAG_RECEIPT_MAX_AGE_MS) {
    return { ok: false, reason: "receipt_stale" };
  }

  // 3. Paid call only. A free / zero-charge call is nearly costless to mint, so
  // counting its flag would give Sybil farming no price floor — mirror the Phase
  // 1 health signal, which also excludes free calls.
  if (!(Number(receipt.call_charge_light) > 0)) {
    return { ok: false, reason: "free_call" };
  }

  // 4. Not self — the flagger must not own the target Agent (anti-inflation).
  // FAIL CLOSED: a flag is written only when ownership was positively confirmed
  // non-self, so a degraded owner lookup can never let an owner self-inflate.
  let ownerId: string | null | undefined;
  try {
    const ownerRes = await fetch(
      `${url}/rest/v1/apps?id=eq.${encodeURIComponent(receipt.app_id)}&select=owner_id&limit=1`,
      { headers },
    );
    if (!ownerRes.ok) return { ok: false, reason: "lookup_failed" };
    const owners = await ownerRes.json() as Array<{ owner_id: string | null }>;
    if (owners.length === 0) return { ok: false, reason: "app_not_found" };
    ownerId = owners[0]?.owner_id;
  } catch {
    return { ok: false, reason: "lookup_failed" };
  }
  if (ownerId === input.userId) return { ok: false, reason: "self_flag" };

  // 5. One flag per receipt (upsert).
  try {
    const up = await fetch(
      `${url}/rest/v1/app_call_flags?on_conflict=receipt_id`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          receipt_id: input.receiptId,
          app_id: receipt.app_id,
          user_id: input.userId,
          status: input.status,
          note: typeof input.note === "string" ? input.note.slice(0, MAX_NOTE_LEN) : null,
          weight: input.weight,
          function_name: receipt.function_name,
          created_at: new Date().toISOString(),
        }),
      },
    );
    if (!up.ok) return { ok: false, reason: "write_failed" };
  } catch {
    return { ok: false, reason: "write_failed" };
  }

  return { ok: true, app_id: receipt.app_id, status: input.status };
}
