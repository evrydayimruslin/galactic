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

import {
  LaunchApiAuthenticationError,
  LaunchApiRequestError,
} from "./api";
import type {
  LaunchFunctionRunRequest,
  LaunchFunctionRunResponse,
  LaunchJobStatusResponse,
} from "../../../../shared/contracts/launch.ts";

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
  error?: InterfaceBridgeError | null;
}

/** Stable, structured execution failure sent over the Interface channel. */
export interface InterfaceBridgeError {
  type?: string;
  code?: string;
  message: string;
  status?: number;
  details?: unknown;
  retryAt?: string | null;
  retryable?: boolean;
  scope?: "account" | "agent" | string;
  /** Whether Galactic has durably queued the exact call and will resume it. */
  autoResumes?: boolean;
  /** A policy change is required; waiting or retrying cannot make it runnable. */
  ownerActionRequired?: boolean;
  /** Distinguishes durable queued work from a request that was never queued. */
  executionMode?: "durable_async" | "sync";
  /** Durable job associated with the call, when one was accepted. */
  jobId?: string | null;
  /** The job may still finish, but its status can no longer be observed here. */
  completionUnknown?: boolean;
}

const AUTO_RESUMABLE_CAPACITY_ERROR_TYPES = new Set([
  "capacity_waiting",
  "agent_cap_waiting",
  "concurrency_waiting",
  "concurrencywaitingerror",
]);
const OWNER_ACTION_CAPACITY_ERROR_TYPE = "agent_cap_too_low_for_request";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Convert API and local failures to the stable Interface wire error shape. */
export function normalizeInterfaceBridgeError(
  value: unknown,
): InterfaceBridgeError {
  const thrown = asRecord(value);
  const responseBody = value instanceof LaunchApiRequestError
    ? asRecord(value.responseBody)
    : asRecord(thrown?.responseBody);
  const responseError = asRecord(responseBody?.error);
  const details = value instanceof LaunchApiRequestError
    ? value.details ?? responseError?.details ?? responseBody?.details ?? null
    : thrown?.details ?? responseError?.details ?? responseBody?.details ??
      null;
  const detailRecord = asRecord(details);
  const type = firstString(
    value instanceof LaunchApiRequestError ? value.code : null,
    thrown?.type,
    thrown?.code,
    responseError?.type,
    responseError?.code,
  ) ?? "RUN_FAILED";
  const retryAt = firstString(
    thrown?.retryAt,
    thrown?.retry_at,
    detailRecord?.retry_at,
    detailRecord?.retryAt,
    responseError?.retry_at,
    responseBody?.retry_at,
  );
  const status = value instanceof LaunchApiRequestError
    ? value.status
    : typeof thrown?.status === "number"
    ? thrown.status
    : undefined;
  const normalizedType = type.toLowerCase();
  const ownerActionRequired = normalizedType ===
    OWNER_ACTION_CAPACITY_ERROR_TYPE;
  const retryable = ownerActionRequired
    ? false
    : typeof thrown?.retryable === "boolean"
    ? thrown.retryable
    : Boolean(retryAt) || status === 408 || status === 425 || status === 429 ||
      (typeof status === "number" && status >= 500);
  const message = value instanceof Error && value.message
    ? value.message
    : firstString(thrown?.message, responseError?.message) ??
      "Function call failed.";
  const scope = firstString(
    thrown?.scope,
    detailRecord?.concurrency_scope,
    detailRecord?.binding_constraint,
    detailRecord?.scope,
  );

  return {
    type,
    code: type,
    message,
    ...(status !== undefined ? { status } : {}),
    ...(details !== null && details !== undefined ? { details } : {}),
    retryAt,
    retryable: AUTO_RESUMABLE_CAPACITY_ERROR_TYPES.has(normalizedType)
      ? true
      : retryable,
    ...(scope ? { scope } : {}),
    ...(ownerActionRequired
      ? { autoResumes: false, ownerActionRequired: true }
      : {}),
  };
}

export interface InterfaceDurableExecutionClient {
  runAgentFunction(
    idOrSlug: string,
    functionName: string,
    request: LaunchFunctionRunRequest,
  ): Promise<LaunchFunctionRunResponse>;
  launchJob(jobId: string): Promise<LaunchJobStatusResponse>;
}

export interface InterfaceDurableCallOptions {
  client: InterfaceDurableExecutionClient;
  agentId: string;
  functionName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  /** Test seam and optional status hook for host chrome. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onJobStatus?: (status: LaunchJobStatusResponse) => void;
}

function abortError(): DOMException {
  return new DOMException("The interface was closed.", "AbortError");
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function asyncEnvelope(value: unknown): { jobId: string } | null {
  const record = asRecord(value);
  return record?._async === true && typeof record.job_id === "string" &&
      record.job_id
    ? { jobId: record.job_id }
    : null;
}

function decorateExecutionError(
  value: unknown,
  executionMode: "durable_async" | "sync",
  jobId: string | null = null,
): InterfaceBridgeError {
  const error = normalizeInterfaceBridgeError(value);
  return {
    ...error,
    executionMode,
    autoResumes: false,
    ...(jobId ? { jobId } : {}),
  };
}

function pollDelay(status: LaunchJobStatusResponse): number {
  const resumeAt = status.admissionWait?.nextAttemptAt ??
    status.admissionWait?.retryAt;
  if (resumeAt) {
    const delay = Date.parse(resumeAt) - Date.now() + 500;
    if (Number.isFinite(delay) && delay > 0) {
      // Browser timers support roughly 24.8 days. Weekly capacity windows fit,
      // and sleeping until the durable retry prevents a status-poll storm.
      return Math.min(delay, 2_147_483_647);
    }
  }
  return status.status === "running" ? 1_000 : 1_500;
}

function retryableStatusReadFailure(value: unknown): boolean {
  if (value instanceof LaunchApiAuthenticationError) return false;
  const normalized = normalizeInterfaceBridgeError(value);
  if (value instanceof TypeError) return true;
  return normalized.status === 408 ||
    normalized.status === 425 || normalized.status === 429 ||
    (typeof normalized.status === "number" && normalized.status >= 500);
}

/**
 * Dispatch one Interface call as a durable job and follow that exact job to a
 * terminal result. Capacity admission waits stay attached to the same queued
 * write; this function never creates a second job to "retry" it.
 */
export async function runInterfaceFunctionDurably(
  options: InterfaceDurableCallOptions,
): Promise<InterfaceBridgeCallResult> {
  const sleep = options.sleep ?? defaultSleep;
  if (options.signal?.aborted) throw abortError();

  let dispatched: LaunchFunctionRunResponse;
  try {
    dispatched = await options.client.runAgentFunction(
      options.agentId,
      options.functionName,
      { args: { ...options.args, _async: true } },
    );
  } catch (reason) {
    // The request was rejected before a durable job id was returned. In
    // particular, never tell a write caller that Galactic will auto-resume it.
    return {
      success: false,
      error: decorateExecutionError(reason, "sync"),
    };
  }

  if (!dispatched.success) {
    return {
      success: false,
      receiptId: dispatched.receiptId,
      error: decorateExecutionError(dispatched.error, "sync"),
    };
  }

  const queued = asyncEnvelope(dispatched.result);
  if (!queued) {
    // Local development can intentionally fall back to synchronous execution
    // when EXEC_QUEUE is not bound. Preserve that honest behavior and never
    // imply that a rejected synchronous write was durably accepted.
    return {
      success: true,
      result: dispatched.result,
      receiptId: dispatched.receiptId,
      error: null,
    };
  }

  let transientPollFailures = 0;
  for (;;) {
    if (options.signal?.aborted) throw abortError();
    let status: LaunchJobStatusResponse;
    try {
      status = await options.client.launchJob(queued.jobId);
      transientPollFailures = 0;
    } catch (reason) {
      if (retryableStatusReadFailure(reason)) {
        transientPollFailures += 1;
        await sleep(
          Math.min(30_000, 1_000 * 2 ** Math.min(5, transientPollFailures - 1)),
          options.signal,
        );
        continue;
      }
      const error = decorateExecutionError(
        {
          type: "JOB_STATUS_UNAVAILABLE",
          message:
            "This action was queued, but its completion status is unavailable. Do not submit it again until you verify the result.",
          details: { cause: normalizeInterfaceBridgeError(reason) },
        },
        "durable_async",
        queued.jobId,
      );
      return {
        success: false,
        error: { ...error, completionUnknown: true },
      };
    }

    options.onJobStatus?.(status);
    if (status.status === "completed") {
      return { success: true, result: status.result, error: null };
    }
    if (status.status === "failed") {
      return {
        success: false,
        error: decorateExecutionError(
          status.error ?? {
            type: "EXECUTION_FAILED",
            message: "The queued function failed.",
          },
          "durable_async",
          queued.jobId,
        ),
      };
    }
    await sleep(pollDelay(status), options.signal);
  }
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

export function postInterfaceBridgeResult(
  port: Pick<MessagePort, "postMessage">,
  id: string | number,
  payload: InterfaceBridgeCallResult,
): void {
  try {
    port.postMessage({ type: "result", id, ...payload });
  } catch {
    // Do not strand the Interface if a future runtime regression returns a
    // non-cloneable value. This fallback contains primitives only, so a live
    // port can always settle the caller's Promise with an actionable error.
    try {
      port.postMessage({
        type: "result",
        id,
        success: false,
        error: {
          type: "UNSERIALIZABLE_RESULT",
          message:
            "The Agent returned a result the Interface could not safely receive.",
        },
      });
    } catch {
      // The port itself is gone; there is no remaining receiver to notify.
    }
  }
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
    postInterfaceBridgeResult(port, id, payload);
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
        reply(port, id, {
          success: false,
          error: normalizeInterfaceBridgeError(err),
        });
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
