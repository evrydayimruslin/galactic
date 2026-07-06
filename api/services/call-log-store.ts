// Call-log store — persisted runtime console output, keyed by receipt.
//
// Every execution already captures the agent's console.log/warn/error lines
// (LogEntry[]) and previously threw them away after the response, which made a
// live incident undebuggable: the owner had a 2000-char error_message and no
// way to retrieve the log line they added. This module persists the captured
// lines as an R2 blob per call and lets the APP OWNER read them back via
// gx.logs({ receipt_id }).
//
// Design (locked 2026-07-06):
// - Capture: ALWAYS-ON, best-effort — persisting logs must never fail or slow
//   the call itself. The blob key is deterministic (receipt_id is the
//   mcp_call_logs row id); the row pointer is PATCHed on only after the blob
//   write + debit succeed, so pointer ⟺ blob and log_bytes ⟺ debited.
// - Read: OWNER-ONLY + disclosed (platform terms) + AUDITED — every read is
//   recorded in the append-only support_data_access_log before data returns
//   (fail-closed, same posture as the D1 support_read path).
// - Retention: 7 days. The hourly sweep deletes expired blobs and credits the
//   bytes back to the owner's data-storage allowance.
// - Cost: blob bytes debit the app OWNER's data-storage allowance (the owner is
//   the only reader), via the existing adjust_data_storage RPC.
// - Cap: 256 KB per call, keeping the TAIL (the crash is at the end).

import type { LogEntry } from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import { adjustDataStorage } from "./data-quota.ts";
import { recordSupportDataAccess } from "./support-access-log.ts";

export const CALL_LOG_MAX_BYTES = 256 * 1024;
export const CALL_LOG_MAX_LINE_BYTES = 8 * 1024;
export const CALL_LOG_RETENTION_DAYS = 7;
const SWEEP_BATCH_SIZE = 200;

const encoder = new TextEncoder();

export function buildCallLogObjectKey(
  appId: string,
  receiptId: string,
): string {
  return `call-logs/${appId}/${receiptId}.json`;
}

export interface TruncatedLogs {
  entries: LogEntry[];
  truncated: boolean;
  droppedEntries: number;
  bytes: number;
}

/**
 * Bound the captured logs to the per-call cap, keeping the TAIL — when an agent
 * crashes, the useful lines are the last ones. Oversized single lines are
 * clipped to CALL_LOG_MAX_LINE_BYTES so one giant console.log can't consume the
 * whole budget. `bytes` is the serialized size of the kept entries.
 */
export function truncateLogsToTail(
  logs: LogEntry[],
  maxBytes: number = CALL_LOG_MAX_BYTES,
): TruncatedLogs {
  const kept: LogEntry[] = [];
  let total = 0;
  let clippedALine = false;

  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    let message = typeof entry.message === "string"
      ? entry.message
      : String(entry.message);
    if (encoder.encode(message).length > CALL_LOG_MAX_LINE_BYTES) {
      // Clip by code unit; a multi-byte overshoot is fine — this is a bound,
      // not an exact budget.
      message = message.slice(0, CALL_LOG_MAX_LINE_BYTES) +
        "… [line clipped]";
      clippedALine = true;
    }
    const normalized: LogEntry = { ...entry, message };
    const size = encoder.encode(JSON.stringify(normalized)).length + 1;
    if (total + size > maxBytes) break;
    total += size;
    kept.push(normalized);
  }

  kept.reverse();
  return {
    entries: kept,
    truncated: clippedALine || kept.length < logs.length,
    droppedEntries: logs.length - kept.length,
    bytes: total,
  };
}

export interface PreparedCallLogCapture {
  receiptId: string;
  objectKey: string;
  body: string;
  bytes: number;
  truncated: boolean;
  droppedEntries: number;
}

/**
 * Synchronously prepare a capture: deterministic key + serialized payload +
 * byte size. The async persist step writes the blob and then PATCHes the
 * pointer onto the receipt row. Returns null when there is nothing to store.
 */
export function prepareCallLogCapture(params: {
  appId: string | undefined;
  receiptId: string | undefined;
  logs: unknown;
}): PreparedCallLogCapture | null {
  // Runs synchronously on the execution hot path — it must never throw, even
  // on a malformed log entry. Anything unexpected simply skips capture.
  try {
    const { appId, receiptId } = params;
    if (!appId || !receiptId) return null;
    if (!Array.isArray(params.logs) || params.logs.length === 0) return null;

    const bounded = truncateLogsToTail(params.logs as LogEntry[]);
    if (bounded.entries.length === 0) return null;

    const body = JSON.stringify({
      version: 1,
      receipt_id: receiptId,
      app_id: appId,
      captured_at: new Date().toISOString(),
      truncated: bounded.truncated,
      dropped_entries: bounded.droppedEntries,
      logs: bounded.entries,
    });

    return {
      receiptId,
      objectKey: buildCallLogObjectKey(appId, receiptId),
      body,
      bytes: encoder.encode(body).length,
      truncated: bounded.truncated,
      droppedEntries: bounded.droppedEntries,
    };
  } catch (err) {
    console.error("[CALL-LOGS] Failed to prepare capture:", err);
    return null;
  }
}

function getR2Bucket(): R2Bucket | null {
  return (globalThis as { __env?: { R2_BUCKET?: R2Bucket } }).__env
    ?.R2_BUCKET ?? null;
}

/**
 * Write the prepared blob, debit the owner's data-storage allowance, and ONLY
 * THEN set the row pointer (a PATCH on the already-inserted receipt row).
 *
 * The ordering carries the accounting invariant:
 * - log_object_key set  ⟺  the blob actually exists (readable);
 * - log_bytes set       ⟺  the debit actually succeeded — so the retention
 *   sweep credits back exactly what was debited, never a phantom credit.
 * If the pointer PATCH fails after a successful debit, the debit is
 * compensated and the blob deleted, so nothing is stranded either way.
 *
 * Best-effort by contract: failures log and return — persisting logs must
 * never break or slow the call whose logs these are.
 */
export async function persistPreparedCallLogs(
  prepared: PreparedCallLogCapture,
  ownerUserId: string | undefined,
): Promise<void> {
  try {
    const bucket = getR2Bucket();
    if (!bucket) return;
    await bucket.put(prepared.objectKey, prepared.body, {
      httpMetadata: { contentType: "application/json" },
    });

    // Debit is best-effort (adjustDataStorage returns null on failure). Bytes
    // are recorded on the row ONLY when the debit succeeded.
    let debitedBytes: number | null = null;
    if (ownerUserId) {
      const adjusted = await adjustDataStorage(ownerUserId, prepared.bytes);
      if (adjusted) debitedBytes = prepared.bytes;
    }

    const { url, headers } = supabaseHeaders();
    const patchRes = await fetch(
      `${url}/rest/v1/mcp_call_logs?id=eq.${
        encodeURIComponent(prepared.receiptId)
      }`,
      {
        method: "PATCH",
        headers: { ...headers, "Prefer": "return=minimal" },
        body: JSON.stringify({
          log_object_key: prepared.objectKey,
          log_bytes: debitedBytes,
        }),
      },
    );
    if (!patchRes.ok) {
      // Pointer never landed: compensate the debit and remove the blob so the
      // ledger and the bucket both stay consistent with "no logs stored".
      console.error(
        "[CALL-LOGS] Pointer PATCH failed; compensating:",
        await patchRes.text().catch(() => ""),
      );
      if (ownerUserId && debitedBytes) {
        await adjustDataStorage(ownerUserId, -debitedBytes);
      }
      await bucket.delete(prepared.objectKey).catch(() => {});
    }
  } catch (err) {
    console.error("[CALL-LOGS] Failed to persist call logs:", err);
  }
}

function supabaseHeaders(): { url: string; headers: Record<string, string> } {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("call-log store is not configured");
  return {
    url,
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

export interface CallLogReadResult {
  receipt_id: string;
  app_id: string;
  function_name: string;
  success: boolean | null;
  created_at: string;
  error_message: string | null;
  truncated: boolean;
  dropped_entries: number;
  logs: LogEntry[];
}

/**
 * Owner-only read of a call's persisted logs. The caller must own the app the
 * receipt belongs to; the read is audit-logged (fail-closed: no audit row → no
 * data) because run logs can contain end-user data.
 */
export async function readCallLogsByReceipt(params: {
  callerUserId: string;
  receiptId: string;
}): Promise<CallLogReadResult> {
  const { url, headers } = supabaseHeaders();

  const rowRes = await fetch(
    `${url}/rest/v1/mcp_call_logs?id=eq.${
      encodeURIComponent(params.receiptId)
    }&select=id,app_id,user_id,function_name,success,created_at,error_message,log_object_key,log_bytes&limit=1`,
    { headers },
  );
  if (!rowRes.ok) {
    throw new Error(`call lookup failed: ${await rowRes.text()}`);
  }
  const rows = await rowRes.json() as Array<{
    id: string;
    app_id: string | null;
    user_id: string;
    function_name: string;
    success: boolean | null;
    created_at: string;
    error_message: string | null;
    log_object_key: string | null;
    log_bytes: number | null;
  }>;
  const row = rows?.[0];
  if (!row || !row.app_id) {
    throw new CallLogNotFound("No call found for that receipt_id.");
  }

  // Owner gate: the reader must own the app this call ran against.
  const appRes = await fetch(
    `${url}/rest/v1/apps?id=eq.${row.app_id}&select=id,owner_id&limit=1`,
    { headers },
  );
  if (!appRes.ok) {
    throw new Error(`app lookup failed: ${await appRes.text()}`);
  }
  const apps = await appRes.json() as Array<{ id: string; owner_id: string }>;
  const app = apps?.[0];
  if (!app || app.owner_id !== params.callerUserId) {
    throw new CallLogForbidden(
      "Only the app owner can read a call's runtime logs.",
    );
  }

  if (!row.log_object_key) {
    throw new CallLogNotFound(
      "No runtime logs are stored for this call (nothing was captured, or they aged past the 7-day retention).",
    );
  }

  const bucket = getR2Bucket();
  const obj = bucket ? await bucket.get(row.log_object_key) : null;
  if (!obj) {
    throw new CallLogNotFound(
      "The stored logs for this call are no longer available.",
    );
  }
  const payload = JSON.parse(await obj.text()) as {
    truncated?: boolean;
    dropped_entries?: number;
    logs?: LogEntry[];
  };

  // Audit BEFORE returning data — no audit row, no logs (fail-closed), because
  // run logs can contain the end user's data. Owners see these reads.
  await recordSupportDataAccess({
    accessorUserId: params.callerUserId,
    appId: row.app_id,
    action: "log_read",
    rowCount: payload.logs?.length ?? 0,
    metadata: {
      receipt_id: row.id,
      function_name: row.function_name,
      subject_user_id: row.user_id,
    },
  });

  return {
    receipt_id: row.id,
    app_id: row.app_id,
    function_name: row.function_name,
    success: row.success,
    created_at: row.created_at,
    error_message: row.error_message,
    truncated: payload.truncated ?? false,
    dropped_entries: payload.dropped_entries ?? 0,
    logs: payload.logs ?? [],
  };
}

export class CallLogNotFound extends Error {}
export class CallLogForbidden extends Error {}

export interface CallLogSweepResult {
  scanned: number;
  deleted: number;
  reclaimedBytes: number;
  errors: number;
}

/**
 * Hourly retention sweep: delete blobs older than the retention window, clear
 * their pointers, and credit the bytes back to each app owner's data-storage
 * allowance (grouped per owner to keep RPC volume low).
 */
export async function sweepExpiredCallLogs(options?: {
  retentionDays?: number;
  batchSize?: number;
}): Promise<CallLogSweepResult> {
  const retentionDays = options?.retentionDays ?? CALL_LOG_RETENTION_DAYS;
  const batchSize = options?.batchSize ?? SWEEP_BATCH_SIZE;
  const { url, headers } = supabaseHeaders();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString();

  const res = await fetch(
    `${url}/rest/v1/mcp_call_logs?log_object_key=not.is.null&created_at=lt.${
      encodeURIComponent(cutoff)
    }&select=id,app_id,log_object_key,log_bytes&order=created_at.asc&limit=${batchSize}`,
    { headers },
  );
  if (!res.ok) {
    throw new Error(`sweep scan failed: ${await res.text()}`);
  }
  const rows = await res.json() as Array<{
    id: string;
    app_id: string | null;
    log_object_key: string;
    log_bytes: number | null;
  }>;
  if (rows.length === 0) {
    return { scanned: 0, deleted: 0, reclaimedBytes: 0, errors: 0 };
  }

  const bucket = getR2Bucket();
  let deleted = 0;
  let errors = 0;
  const clearedIds: string[] = [];
  const bytesByApp = new Map<string, number>();

  for (const row of rows) {
    try {
      if (bucket) await bucket.delete(row.log_object_key);
      clearedIds.push(row.id);
      deleted++;
      // log_bytes is non-null ONLY when the original debit succeeded, so this
      // credits back exactly what was charged.
      if (row.app_id && row.log_bytes) {
        bytesByApp.set(
          row.app_id,
          (bytesByApp.get(row.app_id) ?? 0) + row.log_bytes,
        );
      }
    } catch (err) {
      errors++;
      console.error(
        `[CALL-LOGS] Sweep failed to delete ${row.log_object_key}:`,
        err,
      );
    }
  }

  // Clear pointers for everything we deleted (keeps reads honest + shrinks the
  // partial index). Row stays — the receipt/error history is unaffected.
  if (clearedIds.length > 0) {
    const clearRes = await fetch(
      `${url}/rest/v1/mcp_call_logs?id=in.(${clearedIds.join(",")})`,
      {
        method: "PATCH",
        headers: { ...headers, "Prefer": "return=minimal" },
        body: JSON.stringify({ log_object_key: null }),
      },
    );
    if (!clearRes.ok) {
      throw new Error(`sweep pointer clear failed: ${await clearRes.text()}`);
    }
  }

  // Credit each owner's allowance back, grouped per app owner.
  let reclaimedBytes = 0;
  if (bytesByApp.size > 0) {
    const appIds = [...bytesByApp.keys()];
    const ownersRes = await fetch(
      `${url}/rest/v1/apps?id=in.(${appIds.join(",")})&select=id,owner_id`,
      { headers },
    );
    if (ownersRes.ok) {
      const owners = await ownersRes.json() as Array<
        { id: string; owner_id: string }
      >;
      const bytesByOwner = new Map<string, number>();
      for (const app of owners) {
        const b = bytesByApp.get(app.id) ?? 0;
        bytesByOwner.set(
          app.owner_id,
          (bytesByOwner.get(app.owner_id) ?? 0) + b,
        );
      }
      for (const [ownerId, bytes] of bytesByOwner) {
        await adjustDataStorage(ownerId, -bytes);
        reclaimedBytes += bytes;
      }
    } else {
      console.error(
        "[CALL-LOGS] Sweep owner lookup failed:",
        await ownersRes.text(),
      );
    }
  }

  return { scanned: rows.length, deleted, reclaimedBytes, errors };
}
