// Pillar P0: in-memory effect collector, drained at settlement.
//
// Stamped from db-diff-tracker.ts: host chokepoints (bindings) record
// events against the current executionId with ZERO write latency; the
// settlement path drains and batch-persists them. Caps and sweeps keep an
// abandoned execution from leaking memory. Never throws — witnessing must
// not be able to fail the work it witnesses.

export type EffectAttestation = "attested" | "observed" | "app_claimed";

export type EffectKind =
  | "function_started"
  | "function_completed"
  | "function_failed"
  | "ai_exchange"
  | "db_mutation"
  | "email_dispatch"
  | "notification"
  | "event_emit"
  | "http_request"
  | "agent_call"
  | "non_action"
  | "evidence";

export interface CollectedEffectEvent {
  kind: EffectKind;
  channel?: string | null;
  targetDigest?: string | null;
  outcome?: string | null;
  attestation: EffectAttestation;
  evidence?: unknown[];
}

const MAX_EVENTS_PER_EXECUTION = 60;
const SWEEP_THRESHOLD = 500;
const ENTRY_TTL_MS = 15 * 60 * 1000;

interface Entry {
  events: CollectedEffectEvent[];
  truncated: number;
  at: number;
}

const collected = new Map<string, Entry>();

function sweep(): void {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  for (const [key, entry] of collected) {
    if (entry.at < cutoff) collected.delete(key);
  }
}

function clip(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Record one effect against an execution. Free when executionId is absent
 * (legacy paths) and silently truncating past the per-execution cap — the
 * cap itself is recorded so receipts never silently under-count. */
export function recordEffectEvent(
  executionId: string | null | undefined,
  event: CollectedEffectEvent,
): void {
  if (!executionId) return;
  if (collected.size >= SWEEP_THRESHOLD) sweep();
  const entry = collected.get(executionId) ??
    { events: [], truncated: 0, at: Date.now() };
  entry.at = Date.now();
  if (entry.events.length >= MAX_EVENTS_PER_EXECUTION) {
    entry.truncated += 1;
  } else {
    entry.events.push({
      kind: event.kind,
      channel: clip(event.channel, 120),
      targetDigest: clip(event.targetDigest, 200),
      outcome: clip(event.outcome, 200),
      attestation: event.attestation,
      evidence: Array.isArray(event.evidence)
        ? event.evidence.slice(0, 5)
        : [],
    });
  }
  collected.set(executionId, entry);
}

export interface DrainedEffects {
  events: CollectedEffectEvent[];
  truncated: number;
}

/** Drain (and forget) an execution's collected events, appending a
 * truncation marker event when the cap was hit. */
export function drainEffectEvents(
  executionId: string | null | undefined,
): DrainedEffects {
  if (!executionId) return { events: [], truncated: 0 };
  const entry = collected.get(executionId);
  if (!entry) return { events: [], truncated: 0 };
  collected.delete(executionId);
  const events = [...entry.events];
  if (entry.truncated > 0) {
    events.push({
      kind: "non_action",
      channel: "witness",
      outcome: `${entry.truncated} further effects not recorded (cap)`,
      attestation: "attested",
    });
  }
  return { events, truncated: entry.truncated };
}

export function _effectTrackerSize(): number {
  return collected.size;
}
