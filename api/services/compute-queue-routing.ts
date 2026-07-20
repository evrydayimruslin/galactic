const COMPUTE_DLQ_NAMES = new Set([
  "galactic-compute-dlq",
  "galactic-compute-staging-dlq",
]);

/** Exact environment queue names only; substring routing can silently drop staging. */
export function isComputeDlqQueueName(queue: string): boolean {
  return COMPUTE_DLQ_NAMES.has(queue);
}
