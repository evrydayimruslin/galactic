import { launchAuthSubject } from "./auth";

const ALERT_COUNT_CACHE_PREFIX = "ultralight.launch.openAlertCount.v1";

function alertCountCacheKey(token: string | null): string | null {
  const subject = launchAuthSubject(token);
  return subject
    ? `${ALERT_COUNT_CACHE_PREFIX}:${encodeURIComponent(subject)}`
    : null;
}

export function readCachedAlertCount(
  storage: Pick<Storage, "getItem">,
  token: string | null,
): number | undefined {
  const key = alertCountCacheKey(token);
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

export function writeCachedAlertCount(
  storage: Pick<Storage, "getItem" | "setItem">,
  token: string | null,
  count: number,
): void {
  const key = alertCountCacheKey(token);
  if (!key || !Number.isSafeInteger(count) || count < 0) return;

  try {
    const value = String(count);
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  } catch {
    // The cache is a best-effort guard against a zero-count boot flash.
  }
}
