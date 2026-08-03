// Pillar P0: persistence + projection for the effect witness.
// Batch insert at settlement (off the response path via waitUntil there);
// owner-safe read joins by routine run for the Studio Activity drawer.

import { getEnv } from "../lib/env.ts";
import type { CollectedEffectEvent } from "./effect-event-tracker.ts";
import type { LaunchRunEffectEvent } from "../../shared/contracts/launch.ts";

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export interface PersistEffectEventsInput {
  userId: string;
  appId: string;
  executionId: string;
  runId?: string | null;
  receiptId?: string | null;
  events: readonly CollectedEffectEvent[];
}

/** Batch-persist one execution's effect stream. Best-effort by contract:
 * a witness write failure logs and returns — it can never fail the
 * settlement that carries it. */
export async function persistEffectEvents(
  input: PersistEffectEventsInput,
): Promise<number> {
  if (input.events.length === 0) return 0;
  const rows = input.events.map((event, seq) => ({
    app_id: input.appId,
    user_id: input.userId,
    execution_id: input.executionId,
    run_id: input.runId ?? null,
    receipt_id: input.receiptId ?? null,
    seq,
    kind: event.kind,
    channel: event.channel ?? null,
    target_digest: event.targetDigest ?? null,
    outcome: event.outcome ?? null,
    attestation: event.attestation,
    evidence: event.evidence ?? [],
  }));
  try {
    const res = await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/agent_effect_events`,
      {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify(rows),
      },
    );
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      console.error("[WITNESS] effect persist failed:", err);
      return 0;
    }
    return rows.length;
  } catch (err) {
    console.error(
      "[WITNESS] effect persist failed:",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

interface EffectRow {
  execution_id: string;
  seq: number;
  kind: string;
  channel: string | null;
  target_digest: string | null;
  outcome: string | null;
  attestation: "attested" | "observed" | "app_claimed";
  evidence: unknown[];
  created_at: string;
}

/** Owner-safe effect stream for one routine run, ordered by occurrence. */
export async function readRunEffectEvents(
  userId: string,
  appId: string,
  runId: string,
  limit = 100,
): Promise<LaunchRunEffectEvent[]> {
  const res = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/agent_effect_events` +
      `?app_id=eq.${encodeURIComponent(appId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&run_id=eq.${encodeURIComponent(runId)}` +
      `&select=execution_id,seq,kind,channel,target_digest,outcome,attestation,evidence,created_at` +
      `&order=created_at.asc,seq.asc&limit=${Math.min(limit, 200)}`,
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to read run effects: ${err}`);
  }
  const rows = await res.json() as EffectRow[];
  return rows.map((row) => ({
    executionId: row.execution_id,
    seq: row.seq,
    kind: row.kind,
    channel: row.channel,
    targetDigest: row.target_digest,
    outcome: row.outcome,
    attestation: row.attestation,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    createdAt: row.created_at,
  }));
}
