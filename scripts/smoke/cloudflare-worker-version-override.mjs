const CLOUDFLARE_WORKER_NAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CLOUDFLARE_VERSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const COMPUTE_CERTIFICATION_API_VERSION_ID_ENV =
  "COMPUTE_CERTIFICATION_API_VERSION_ID";
export const CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER =
  "Cloudflare-Workers-Version-Overrides";
export const GALACTIC_WORKER_VERSION_HEADER = "X-Galactic-Worker-Version";

export function cloudflareWorkerVersionId(value) {
  const version = String(value ?? "").trim();
  if (!version) return null;
  if (!CLOUDFLARE_VERSION_ID_RE.test(version)) {
    throw new Error("Cloudflare Worker version id is invalid.");
  }
  return version;
}

/**
 * Build the structured request header Cloudflare uses to route a smoke request
 * to one exact Worker version in the active deployment. An absent version is a
 * deliberate no-op so the same smoke helpers remain usable outside rollouts.
 */
export function cloudflareWorkerVersionOverride(workerName, versionId) {
  const worker = String(workerName ?? "").trim();
  const version = cloudflareWorkerVersionId(versionId);
  if (version === null) return null;
  if (!CLOUDFLARE_WORKER_NAME_RE.test(worker)) {
    throw new Error("Cloudflare Worker name is invalid.");
  }
  return `${worker}="${version}"`;
}

export function cloudflareWorkerVersionOverrideHeaders(workerName, versionId) {
  const value = cloudflareWorkerVersionOverride(workerName, versionId);
  return value === null
    ? {}
    : { [CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER]: value };
}
