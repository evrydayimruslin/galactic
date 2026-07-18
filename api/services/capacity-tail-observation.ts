const RECEIPT_HEADER = "x-galactic-capacity-receipt";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DynamicTailItemLike {
  cpuTime?: unknown;
  cpuTimeMs?: unknown;
  wallTime?: unknown;
  wallTimeMs?: unknown;
  eventTimestamp?: unknown;
  event?: unknown;
}

interface DynamicCapacityObservation {
  version: 1;
  receiptId: string;
  cpuTimeMs: number;
  wallTimeMs: number;
  observedAt: string;
  source: "cloudflare_dynamic_tail";
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function receiptFromHeaders(headers: unknown): string | null {
  let value: string | null = null;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    value = headers.get(RECEIPT_HEADER);
  } else if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (
        Array.isArray(pair) && pair.length >= 2 &&
        String(pair[0]).toLowerCase() === RECEIPT_HEADER
      ) {
        value = String(pair[1]);
        break;
      }
    }
  } else if (headers && typeof headers === "object") {
    for (const [key, candidate] of Object.entries(headers)) {
      if (
        key.toLowerCase() === RECEIPT_HEADER && typeof candidate === "string"
      ) {
        value = candidate;
        break;
      }
    }
  }
  const normalized = value?.trim().toLowerCase() ?? "";
  return UUID_RE.test(normalized) ? normalized : null;
}

function requestHeaders(event: unknown): unknown {
  if (!event || typeof event !== "object") return null;
  const request = (event as { request?: unknown }).request;
  if (!request || typeof request !== "object") return null;
  return (request as { headers?: unknown }).headers;
}

function eventTime(value: unknown): string {
  const date = new Date(typeof value === "number" ? value : Date.now());
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
}

/** Build exact CPU observations for Worker Loader Dynamic Worker traces. */
export function buildDynamicCapacityObservations(
  items: DynamicTailItemLike[],
): DynamicCapacityObservation[] {
  const observations = new Map<string, DynamicCapacityObservation>();
  for (const item of items) {
    // Only the loader's host-injected internal request header is an authority.
    // Tenant code controls every child console message and must never be able
    // to forge a receipt marker to move or multiply billable CPU.
    const receiptId = receiptFromHeaders(requestHeaders(item.event));
    if (!receiptId) continue;
    const cpuTimeMs = nonNegative(item.cpuTimeMs ?? item.cpuTime);
    const wallTimeMs = nonNegative(item.wallTimeMs ?? item.wallTime);
    const observedAt = eventTime(item.eventTimestamp);
    const current = observations.get(receiptId);
    if (current) {
      current.cpuTimeMs += cpuTimeMs;
      current.wallTimeMs += wallTimeMs;
      if (observedAt > current.observedAt) current.observedAt = observedAt;
    } else {
      observations.set(receiptId, {
        version: 1,
        receiptId,
        cpuTimeMs,
        wallTimeMs,
        observedAt,
        source: "cloudflare_dynamic_tail",
      });
    }
  }
  return [...observations.values()];
}
