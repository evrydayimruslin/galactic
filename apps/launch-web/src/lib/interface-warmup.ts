const warmedDocuments = new Set<string>();
const warmedOrigins = new Set<string>();

const INTERFACE_ORIGINS = new Set([
  "https://interfaces.connectgalactic.com",
  "https://interfaces.ultralightagent.com",
  "https://ultralight-interfaces-staging.rgn4jz429m.workers.dev",
]);

function allowedInterfaceUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return INTERFACE_ORIGINS.has(url.origin) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Starts DNS/TLS setup and fills the normal HTTP cache with the immutable
 * interface document before the user opens it. Interface URLs contain their
 * content hash, so a warmed response cannot become a stale interface build.
 */
export function warmInterfaceDocument(value: string): void {
  if (typeof document === "undefined" || typeof fetch === "undefined") return;
  const url = allowedInterfaceUrl(value);
  if (!url) return;

  if (!warmedOrigins.has(url.origin)) {
    warmedOrigins.add(url.origin);
    const preconnect = document.createElement("link");
    preconnect.rel = "preconnect";
    preconnect.href = url.origin;
    document.head.appendChild(preconnect);
  }

  if (warmedDocuments.has(url.href)) return;
  warmedDocuments.add(url.href);
  void fetch(url.href, {
    cache: "force-cache",
    credentials: "include",
    mode: "no-cors",
    referrerPolicy: "no-referrer",
  }).catch(() => {
    // A transient warm-up failure must not prevent a later hover retry or the
    // iframe's normal navigation.
    warmedDocuments.delete(url.href);
  });
}

export function scheduleInterfaceWarmup(values: readonly string[]): () => void {
  if (typeof window === "undefined" || values.length === 0) return () => undefined;
  let cancelled = false;
  const warm = () => {
    if (cancelled) return;
    values.forEach(warmInterfaceDocument);
  };

  const idleWindow = window as Window & {
    cancelIdleCallback?: (handle: number) => void;
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
  };
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(warm, { timeout: 650 });
    return () => {
      cancelled = true;
      idleWindow.cancelIdleCallback?.(handle);
    };
  }

  const handle = window.setTimeout(warm, 180);
  return () => {
    cancelled = true;
    window.clearTimeout(handle);
  };
}
