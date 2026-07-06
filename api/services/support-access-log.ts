// Append-only audit trail for the disclosed support data-read (PR 5).
//
// Unlike telemetry (logMcpCall, fire-and-forget), this is a COMPLIANCE log:
// recordSupportDataAccess is AWAITED and FAILS CLOSED. The caller records the
// access before returning any cross-user data, so if the audit write cannot be
// durably committed, the data is not disclosed. Writes to the append-only
// support_data_access_log table (a trigger blocks UPDATE/DELETE).

import { getEnv } from "../lib/env.ts";

export interface SupportDataAccessEntry {
  /** The developer (app owner) reading the data. */
  accessorUserId: string;
  appId: string;
  /** "support_read" today. */
  action: string;
  tableName?: string;
  rowCount?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record a support data-access event. Resolves only on a durable write; throws
 * on any failure (missing config, non-2xx) so the caller can refuse to serve the
 * data when it cannot be audited.
 */
export async function recordSupportDataAccess(
  entry: SupportDataAccessEntry,
): Promise<void> {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("support-access audit store is not configured");
  }
  const res = await fetch(`${url}/rest/v1/support_data_access_log`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      accessor_user_id: entry.accessorUserId,
      app_id: entry.appId,
      action: entry.action,
      table_name: entry.tableName ?? null,
      row_count: entry.rowCount ?? null,
      reason: entry.reason ?? null,
      metadata: entry.metadata ?? {},
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `support-access audit write failed (${res.status})${detail ? ": " + detail : ""}`,
    );
  }
}
