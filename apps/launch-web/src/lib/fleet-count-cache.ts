import { launchAuthSubject } from "./auth";

// v2 stores the working/ready count rather than the total fleet size. Changing
// the key prevents a pre-change total from flashing in the boot scaffold.
const FLEET_COUNT_CACHE_PREFIX = "ultralight.launch.workingAgentCount.v2";

function fleetCountCacheKey(token: string | null): string | null {
  const subject = launchAuthSubject(token);
  return subject
    ? `${FLEET_COUNT_CACHE_PREFIX}:${encodeURIComponent(subject)}`
    : null;
}

export function readCachedFleetCount(
  storage: Pick<Storage, "getItem">,
  token: string | null,
): number | undefined {
  const key = fleetCountCacheKey(token);
  if (!key) return undefined;

  try {
    const raw = storage.getItem(key);
    if (!raw || !/^\d+$/u.test(raw)) return undefined;
    const count = Number(raw);
    return Number.isSafeInteger(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedFleetCount(
  storage: Pick<Storage, "getItem" | "setItem">,
  token: string | null,
  count: number,
): void {
  const key = fleetCountCacheKey(token);
  if (!key || !Number.isSafeInteger(count) || count < 0) return;

  try {
    const value = String(count);
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  } catch {
    // The loader cache is a best-effort enhancement for restricted browsers.
  }
}
