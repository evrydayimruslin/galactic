const EXTERNAL_RETURN_REVALIDATION_KEY =
  "ultralight.launch.revalidateAfterExternalReturn";

export function markExternalReturnRevalidation(
  storage: Pick<Storage, "setItem"> = window.sessionStorage,
): void {
  try {
    storage.setItem(EXTERNAL_RETURN_REVALIDATION_KEY, "1");
  } catch {
    // Browser storage is an enhancement; pageshow still covers normal bfcache.
  }
}

export function consumeExternalReturnRevalidation(
  storage: Pick<Storage, "getItem" | "removeItem"> = window.sessionStorage,
): boolean {
  try {
    if (storage.getItem(EXTERNAL_RETURN_REVALIDATION_KEY) !== "1") return false;
    storage.removeItem(EXTERNAL_RETURN_REVALIDATION_KEY);
    return true;
  } catch {
    return false;
  }
}
