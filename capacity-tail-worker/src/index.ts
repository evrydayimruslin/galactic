const MARKER_PREFIX = "GALACTIC_CAPACITY_EXECUTION_V1 ";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface QueueBinding {
  send(body: unknown): Promise<void>;
}

interface Env {
  CAPACITY_TELEMETRY_QUEUE: QueueBinding;
  PRODUCER_SCRIPT_NAMES?: string;
}

interface TailLog {
  message?: unknown;
}

export interface TailItemLike {
  scriptName?: unknown;
  cpuTime?: unknown;
  cpuTimeMs?: unknown;
  wallTime?: unknown;
  wallTimeMs?: unknown;
  eventTimestamp?: unknown;
  event?: {
    request?: {
      headers?: unknown;
    };
  } | null;
  logs?: TailLog[];
}

export interface CapacityCpuObservation {
  version: 1;
  receiptId: string;
  cpuTimeMs: number;
  wallTimeMs: number;
  observedAt: string;
  source: "cloudflare_tail_parent";
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function validReceipt(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function stringsInMessage(message: unknown): string[] {
  if (typeof message === "string") return [message];
  if (Array.isArray(message)) {
    return message.flatMap((part) => stringsInMessage(part));
  }
  return [];
}

function receiptsFromLogs(logs: TailLog[] | undefined): string[] {
  const receipts = new Set<string>();
  for (const log of logs ?? []) {
    for (const text of stringsInMessage(log.message)) {
      const markerAt = text.indexOf(MARKER_PREFIX);
      if (markerAt < 0) continue;
      try {
        const parsed = JSON.parse(text.slice(markerAt + MARKER_PREFIX.length));
        const receipt = validReceipt(parsed?.receipt_id);
        if (receipt) receipts.add(receipt);
      } catch {
        // A malformed marker is ignored. It cannot become a capacity debit.
      }
    }
  }
  return [...receipts];
}

function itemReceipts(item: TailItemLike): string[] {
  // This Tail Worker is attached to the loader/API Worker and deliberately
  // accepts only its host-issued log marker. Worker Loader Dynamic Workers are
  // observed by the per-load `CapacityDynamicTail`; ignoring headers here also
  // prevents a future trace-format expansion from double-counting child CPU.
  return receiptsFromLogs(item.logs);
}

function scriptName(item: TailItemLike): string | null {
  return typeof item.scriptName === "string" && item.scriptName.length > 0
    ? item.scriptName
    : null;
}

function producerScriptNames(value: unknown): Set<string> {
  return new Set(
    (typeof value === "string" ? value : "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function observedAt(item: TailItemLike): string {
  const timestamp = typeof item.eventTimestamp === "number"
    ? item.eventTimestamp
    : Date.now();
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
}

/**
 * Attribute only loader/API trace items that carry a host-issued execution
 * receipt. Child CPU is observed independently by `CapacityDynamicTail`, so
 * this consumer deliberately never infers it. Unattributed platform work is
 * never guessed onto a customer account.
 */
export function buildCapacityObservations(
  items: TailItemLike[],
  allowedProducerScripts: ReadonlySet<string> = new Set([
    "ultralight-api",
    "ultralight-api-staging",
  ]),
): CapacityCpuObservation[] {
  // One Tail delivery represents a producer invocation and its lifecycle.
  // Host RPC entrypoints carry their own markers. If exactly one receipt exists
  // we can safely include unmarked same-script lifecycle items; with nested
  // receipts ambiguous CPU is never multiplied across them.
  const attribution = new Map<string, Set<string | null>>();
  for (const item of items) {
    const producer = scriptName(item);
    if (!producer || !allowedProducerScripts.has(producer)) continue;
    for (const receiptId of itemReceipts(item)) {
      const scripts = attribution.get(receiptId) ?? new Set<string | null>();
      scripts.add(scriptName(item));
      attribution.set(receiptId, scripts);
    }
  }

  const byReceipt = new Map<string, CapacityCpuObservation>();
  const add = (
    receiptId: string,
    item: TailItemLike,
    includeTiming: boolean,
  ) => {
    const cpuTimeMs = includeTiming
      ? finiteNonNegative(item.cpuTimeMs ?? item.cpuTime)
      : 0;
    const wallTimeMs = includeTiming
      ? finiteNonNegative(item.wallTimeMs ?? item.wallTime)
      : 0;
    const timestamp = observedAt(item);
    const current = byReceipt.get(receiptId);
    if (current) {
      current.cpuTimeMs += cpuTimeMs;
      current.wallTimeMs += wallTimeMs;
      if (timestamp > current.observedAt) current.observedAt = timestamp;
      return;
    }
    byReceipt.set(receiptId, {
      version: 1,
      receiptId,
      cpuTimeMs,
      wallTimeMs,
      observedAt: timestamp,
      source: "cloudflare_tail_parent",
    });
  };

  const rootReceipt = attribution.size > 0
    ? attribution.keys().next().value as string
    : null;
  for (const item of items) {
    const producer = scriptName(item);
    if (!producer || !allowedProducerScripts.has(producer)) continue;
    const receipts = itemReceipts(item);
    if (receipts.length > 0) {
      // A TailItem's CPU is indivisible. Charge it once to the first host
      // marker; additional markers complete their source with zero CPU rather
      // than multiplying one lifecycle total across nested receipts.
      receipts.forEach((receiptId, index) => add(receiptId, item, index === 0));
      continue;
    }
    if (rootReceipt) {
      const itemScript = scriptName(item);
      if (
        itemScript !== null && attribution.get(rootReceipt)!.has(itemScript)
      ) {
        // Some host entrypoints (notably globalOutbound) cannot carry the
        // opaque execution handle. Allocate their indivisible lifecycle CPU
        // exactly once to the first/root receipt. Nested calls inherit the
        // same account, capacity Agent, and routine run, preserving economic
        // truth without multiplying the item across receipts.
        add(rootReceipt, item, true);
      }
    }
  }
  return [...byReceipt.values()];
}

export default {
  async tail(items: TailItemLike[], env: Env): Promise<void> {
    const observations = buildCapacityObservations(
      items,
      producerScriptNames(env.PRODUCER_SCRIPT_NAMES),
    );
    await Promise.all(
      observations.map((observation) =>
        env.CAPACITY_TELEMETRY_QUEUE.send(observation)
      ),
    );
  },
};
