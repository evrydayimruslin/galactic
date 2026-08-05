const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const GALACTIC_WORKER_VERSION_HEADER = "X-Galactic-Worker-Version";

interface WorkerVersionMetadataEnvironment {
  CF_VERSION_METADATA?: {
    id?: unknown;
    tag?: unknown;
    timestamp?: unknown;
  };
}

export function workerVersionId(
  env: WorkerVersionMetadataEnvironment,
): string | null {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === "string" && WORKER_VERSION_ID_PATTERN.test(id)
    ? id
    : null;
}

export function applyWorkerVersionResponseHeader(
  headers: Headers,
  request: Request,
  env: WorkerVersionMetadataEnvironment,
): void {
  if (!request.headers.has("Cloudflare-Workers-Version-Overrides")) return;
  const versionId = workerVersionId(env);
  if (versionId !== null) {
    headers.set(GALACTIC_WORKER_VERSION_HEADER, versionId);
  }
}
