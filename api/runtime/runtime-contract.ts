/**
 * Baked dynamic-worker contract revision.
 *
 * Keep this in a dependency-free module: both isolate reuse and signed
 * galactic.yaml release identities must rotate from the same source of truth.
 * Bump it for generated-module changes and for host RPC policy/behavior changes
 * that could change what the exact same executable is allowed to do.
 */
export const GALACTIC_SANDBOX_TEMPLATE_VERSION =
  "2026-08-04.compute-error-proof.v30";
