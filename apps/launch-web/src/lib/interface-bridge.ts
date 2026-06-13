// MessageChannel bridge between the agent page and a sandboxed developer
// interface iframe (Interfaces PR5 — docs/INTERFACE_RELAUNCH_PR_ROADMAP.md).
//
// SECURITY MODEL: the iframe is opaque-origin (sandbox="allow-scripts
// allow-forms" on a cross-site sandbox-worker origin) and its CSP denies all
// network access — this bridge is the interface's ONLY I/O. Origin checks
// are useless against opaque origins (they post with origin "null"), so the
// handshake instead verifies `event.source === iframe.contentWindow` and
// hands over a private MessageChannel port: an unforgeable capability no
// other frame or tab can obtain. Every inbound message is shape-checked,
// size-capped, and rate-limited; calls are refused unless the function is on
// the manifest-declared allowlist (already intersected with the agent's real
// functions by the facade).
//
// Protocol (documented for interface authors in PR6):
//   frame → window:  { type: "ul-interface-hello" }            (on load)
//   parent → frame:  { type: "ul-interface-connect", context } (+ port2)
//   frame → port:    { type: "call", id, functionName, args? }
//                    { type: "resize", height }
//   parent → port:   { type: "result", id, success, result?, error?, receiptId? }

export interface InterfaceBridgeContext {
  agent: { id: string; slug: string; name: string };
  interfaceId: string;
  signedIn: boolean;
  minHeight: number | null;
}

export interface InterfaceBridgeCallResult {
  success: boolean;
  result?: unknown;
  receiptId?: string | null;
  error?: { type?: string; message: string } | null;
}

export interface InterfaceBridgeOptions {
  iframe: HTMLIFrameElement;
  context: InterfaceBridgeContext;
  // Manifest-declared bridge allowlist for this interface.
  allowlist: readonly string[];
  // Performs the authenticated run (the Functions-playground path).
  runFunction: (
    functionName: string,
    args: Record<string, unknown>,
  ) => Promise<InterfaceBridgeCallResult>;
  onConnected?: () => void;
  onResize?: (height: number) => void;
  // Fired per successful call so the host chrome can show session spend.
  onCall?: (functionName: string) => void;
}

export const INTERFACE_MIN_HEIGHT = 120;
export const INTERFACE_MAX_HEIGHT = 900;
const MAX_ARGS_BYTES = 64 * 1024;
const MAX_IN_FLIGHT = 4;
const RATE_LIMIT_CALLS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

export function clampInterfaceHeight(value: number): number {
  if (!Number.isFinite(value)) return INTERFACE_MIN_HEIGHT;
  return Math.min(INTERFACE_MAX_HEIGHT, Math.max(INTERFACE_MIN_HEIGHT, value));
}

// Attaches the bridge for one iframe. Returns a cleanup function; call it on
// unmount or before re-attaching with different options.
export function attachInterfaceBridge(
  options: InterfaceBridgeOptions,
): () => void {
  let disposed = false;
  let activePort: MessagePort | null = null;
  let inFlight = 0;
  const callTimes: number[] = [];

  const reply = (
    port: MessagePort,
    id: string | number,
    payload: InterfaceBridgeCallResult,
  ) => {
    if (disposed || port !== activePort) return;
    try {
      port.postMessage({ type: "result", id, ...payload });
    } catch {
      // Result not structured-cloneable or port gone — nothing to deliver.
    }
  };

  const refuse = (
    port: MessagePort,
    id: string | number,
    type: string,
    message: string,
  ) => reply(port, id, { success: false, error: { type, message } });

  const handleCall = (port: MessagePort, data: Record<string, unknown>) => {
    const id = typeof data.id === "string" || typeof data.id === "number"
      ? data.id
      : null;
    if (id === null) return;

    const functionName = data.functionName;
    if (
      typeof functionName !== "string" ||
      !options.allowlist.includes(functionName)
    ) {
      refuse(
        port,
        id,
        "NOT_ALLOWED",
        "Function is not on this interface's allowlist.",
      );
      return;
    }
    if (!options.context.signedIn) {
      refuse(
        port,
        id,
        "SIGN_IN_REQUIRED",
        "Sign in on this page to use functions.",
      );
      return;
    }

    const rawArgs = data.args === undefined ? {} : data.args;
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      refuse(port, id, "BAD_ARGS", "args must be a JSON object.");
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(rawArgs);
    } catch {
      refuse(port, id, "BAD_ARGS", "args must be JSON-serializable.");
      return;
    }
    if (serialized.length > MAX_ARGS_BYTES) {
      refuse(
        port,
        id,
        "TOO_LARGE",
        `args exceed the ${MAX_ARGS_BYTES} byte bridge limit.`,
      );
      return;
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      refuse(port, id, "BUSY", "Too many calls in flight; retry shortly.");
      return;
    }
    const now = Date.now();
    while (callTimes.length > 0 && now - callTimes[0] > RATE_LIMIT_WINDOW_MS) {
      callTimes.shift();
    }
    if (callTimes.length >= RATE_LIMIT_CALLS) {
      refuse(port, id, "RATE_LIMITED", "Call rate limit reached; slow down.");
      return;
    }
    callTimes.push(now);

    inFlight += 1;
    options
      .runFunction(functionName, rawArgs as Record<string, unknown>)
      .then((result) => {
        if (result.success) options.onCall?.(functionName);
        reply(port, id, result);
      })
      .catch((err: unknown) => {
        refuse(
          port,
          id,
          "RUN_FAILED",
          err instanceof Error ? err.message : "Function call failed.",
        );
      })
      .finally(() => {
        inFlight -= 1;
      });
  };

  const handlePortMessage = (port: MessagePort, event: MessageEvent) => {
    if (disposed || port !== activePort) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    if (data.type === "resize") {
      if (typeof data.height === "number") {
        options.onResize?.(clampInterfaceHeight(data.height));
      }
      return;
    }
    if (data.type === "call") handleCall(port, data);
  };

  const connect = () => {
    // A new hello (first load or iframe reload) replaces any prior channel;
    // the stale port is closed so late messages on it are inert.
    activePort?.close();
    const channel = new MessageChannel();
    activePort = channel.port1;
    channel.port1.onmessage = (event) =>
      handlePortMessage(channel.port1, event);
    // An opaque-origin frame cannot be targeted by origin — "*" is required,
    // but the port transfer is what scopes the channel to this frame alone.
    options.iframe.contentWindow?.postMessage(
      { type: "ul-interface-connect", context: options.context },
      "*",
      [channel.port2],
    );
    options.onConnected?.();
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (disposed) return;
    // The load-bearing identity check: only OUR iframe's browsing context.
    if (event.source !== options.iframe.contentWindow) return;
    const data = event.data as { type?: unknown } | null;
    if (!data || data.type !== "ul-interface-hello") return;
    connect();
  };

  window.addEventListener("message", onWindowMessage);
  return () => {
    disposed = true;
    window.removeEventListener("message", onWindowMessage);
    activePort?.close();
    activePort = null;
  };
}
