const DEFAULT_UNWIND_TIMEOUT_MS = 30_000;

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Cancellation must not acknowledge destruction until the active executor has
 * stopped issuing SDK calls and a final bounded destroy succeeds. A timed-out
 * unwind remains an error so the control plane keeps the run fenced and can
 * retry; it is never converted into a false `{ destroyed: true }` receipt.
 */
export async function coordinateComputeCancellation(input: {
  active?: {
    abort: AbortController;
    completion: Promise<unknown>;
  };
  /** Each call must itself be bounded and retry-safe. */
  destroy: () => Promise<void>;
  unwindTimeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.unwindTimeoutMs ?? DEFAULT_UNWIND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("compute cancellation timeout is invalid");
  }

  if (!input.active) {
    await input.destroy();
    return;
  }

  input.active.abort.abort("compute run cancelled");
  // Best-effort early destruction interrupts startup/commands. Even if it
  // fails, continue to unwind and make the authoritative final attempt.
  await input.destroy().catch(() => undefined);

  let unwindError: unknown;
  try {
    await withTimeout(
      input.active.completion.catch(() => undefined),
      timeoutMs,
      "compute cancellation unwind timed out",
    );
  } catch (error) {
    unwindError = error;
  }

  // This success is the only event that can authorize `{ destroyed: true }`.
  // It occurs after the executor has either unwound or reached the hard wait
  // bound, so a timeout is still surfaced even when destruction itself works.
  await input.destroy();
  if (unwindError) throw unwindError;
}
