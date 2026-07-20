// Environment compatibility layer for Cloudflare Workers
// Replaces all Deno.env.get() calls with a universal accessor.
// globalThis.__env is set by worker-entry.ts on each request/scheduled event.

// ============================================
// ENV TYPES
// ============================================

export interface QueueProducer {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
}

/** Private named entrypoint exported by the dedicated Compute Worker. */
export interface ComputePlaneBinding {
  executeRun(message: unknown): Promise<unknown>;
  cancelRun(message: unknown): Promise<{ destroyed: true }>;
  runtimeIdentity(): Promise<{
    profile: "developer-v1";
    environmentDigest: string;
  }>;
}

export interface Env {
  // KV namespaces
  CODE_CACHE: KVNamespace;
  FN_INDEX: KVNamespace;

  // R2 bucket
  R2_BUCKET: R2Bucket;

  // Galactic Compute is deployed as a separate, non-public Worker. These
  // bindings are optional at the type boundary so tests and an intentionally
  // disabled rollout fail closed instead of needing fake infrastructure.
  COMPUTE_ARTIFACTS?: R2Bucket;
  COMPUTE_PLANE?: ComputePlaneBinding;
  COMPUTE_QUEUE?: QueueProducer;

  // Dynamic Workers loader
  LOADER: {
    load(code: WorkerCode): WorkerStub;
    get(id: string, callback: () => Promise<WorkerCode>): WorkerStub;
  };

  // String secrets and vars — all former Deno.env.get() keys
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRO_PRICE_ID: string;
  OPENROUTER_API_KEY: string;
  DEEPSEEK_API_KEY: string;
  BYOK_ENCRYPTION_KEY: string;
  RUNPOD_API_KEY: string;
  RUNPOD_TEMPLATE_ID: string;
  RUNPOD_BASE_IMAGE: string;
  RUNPOD_CONTAINER_REGISTRY_AUTH_ID: string;
  RUNPOD_ALLOW_SHARED_TEMPLATE_FALLBACK: string;
  GPU_SUPPORT_ENABLED: string;
  ROUTINES_ENABLED: string;
  GPU_INTERNAL_SECRET: string;
  GITHUB_ACTIONS_TOKEN: string;
  GITHUB_BUILD_TOKEN: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_BUILD_REPO: string;
  GITHUB_BUILD_WORKFLOW_ID: string;
  GITHUB_BUILD_REF: string;
  GHCR_IMAGE_NAMESPACE: string;
  GPU_BUILD_CALLBACK_SECRET: string;
  GPU_BUILD_CONTEXT_TTL_SECONDS: string;
  GPU_BUILD_LIGHT_PER_MINUTE: string;
  GPU_BASE_IMAGE_PYTHON_CUDA: string;
  GPU_BASE_IMAGE_TORCH_CUDA: string;
  GPU_BASE_IMAGE_PYTHON_CUDA_SIZE_BYTES: string;
  GPU_BASE_IMAGE_TORCH_CUDA_SIZE_BYTES: string;
  SUPABASE_MGMT_OAUTH_CLIENT_ID: string;
  SUPABASE_MGMT_OAUTH_CLIENT_SECRET: string;
  TIER_CHANGE_SECRET: string;
  GPU_SECRET: string;
  BASE_URL: string;
  LAUNCH_WEB_BASE_URL: string;
  SUBSCRIPTION_CAPACITY_ENABLED: string;
  AGENT_CAPACITY_ENABLED: string;
  ENVIRONMENT: string;
  CORS_ALLOWED_ORIGINS: string;
  PLATFORM_MCP_DISABLED_ALIASES: string;
  CHAT_CAPTURE_ENABLED: string;
  CHAT_CAPTURE_ARTIFACTS_ENABLED: string;
  CHAT_CAPTURE_MAX_INLINE_BYTES: string;
  ANALYTICS_PEPPER_V1: string;
  ANALYTICS_PEPPER_VERSION: string;
  CHAT_CAPTURE_PEPPER: string;
  // Slug of the private "Defaults Manager" Agent whose stored list provides the
  // pre-install default Agents seeded into new accounts (services/request-auth.ts
  // provisionDefaultApps reads its app-data). Unset => no defaults are seeded.
  // Not an authority — it just names which app feeds the starter list; the Agent
  // is owner-only because it is private.
  DEFAULTS_SOURCE_APP: string;

  // Galactic Compute rollout and immutable environment identity. The job
  // token pepper is a Worker secret; it must never be passed to a body.
  COMPUTE_ENABLED: string;
  COMPUTE_ENVIRONMENT_DIGEST: string;
  COMPUTE_JOB_TOKEN_PEPPER: string;
  /** Dedicated public-edge credential for global Compute stop/release only. */
  COMPUTE_EMERGENCY_STOP_TOKEN: string;
  COMPUTE_ROLLOUT_MODE: string;
  /** Comma-separated exact `owner UUID/Agent UUID` pairs. */
  COMPUTE_CANARY_ALLOWLIST: string;

  // Index signature for dynamic access
  [key: string]: unknown;
}

interface WorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
  env: Record<string, unknown>;
  globalOutbound?: unknown;
  tails?: unknown[];
  // Per-isolate resource ceilings (workerd resource limits) — without them a
  // loaded tenant isolate inherits the parent's full CPU/subrequest budget.
  limits?: { cpuMs?: number; subRequests?: number };
}

interface WorkerEntrypoint {
  fetch(request: Request, init?: RequestInit): Promise<Response>;
}

interface WorkerStub {
  getEntrypoint(): WorkerEntrypoint;
}

// ============================================
// GLOBAL DECLARATIONS
// ============================================

declare global {
  var __env: Env;
  var __ctx: ExecutionContext;
}

// ============================================
// ENV ACCESSOR
// ============================================

/**
 * Get an environment variable by key.
 * Reads from globalThis.__env, set by worker-entry.ts on each request.
 * Local dev uses `wrangler dev` which provides the same env bindings.
 *
 * Replaces all 175 occurrences of Deno.env.get() across the codebase.
 */
export function getEnv(): Env;
export function getEnv(key: string): string;
export function getEnv(key?: string): Env | string {
  if (key === undefined) {
    return globalThis.__env;
  }
  const val = globalThis.__env?.[key];
  if (typeof val === "string") return val;
  return "";
}

/**
 * The SELF service binding (wrangler [[services]] -> this same worker) as a
 * callable fetcher, or null when unbound (tests, misconfigured env).
 *
 * Internal worker-to-worker calls MUST use this instead of fetch()ing our own
 * public hostname: same-worker self-fetch over the CDN is blocked (error
 * 1042), and binding hops are free of per-request fees. Use synthetic URLs
 * like https://internal/mcp/{appId} — routing is by pathname.
 */
export function getSelfFetcher():
  | ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>)
  | null {
  const self = globalThis.__env?.SELF;
  if (
    self && typeof self === "object" &&
    typeof (self as { fetch?: unknown }).fetch === "function"
  ) {
    const fetcher = self as { fetch: typeof fetch };
    return fetcher.fetch.bind(fetcher);
  }
  return null;
}

function getQueueProducer(binding: string): QueueProducer | null {
  const queue = globalThis.__env?.[binding];
  if (
    queue && typeof queue === "object" &&
    typeof (queue as { send?: unknown }).send === "function"
  ) {
    const producer = queue as QueueProducer;
    return { send: producer.send.bind(producer) };
  }
  return null;
}

/**
 * The durable-execution queue producer (wrangler [[queues.producers]]
 * EXEC_QUEUE), or null when unbound (tests, local setups without queues —
 * callers fall back to synchronous execution).
 */
export function getExecQueue(): QueueProducer | null {
  return getQueueProducer("EXEC_QUEUE");
}

/**
 * The event-bus dispatch queue producer (wrangler [[queues.producers]]
 * EVENT_QUEUE), or null when unbound — emit falls back to the cron sweeper's
 * inline dispatch.
 */
export function getEventQueue(): QueueProducer | null {
  return getQueueProducer("EVENT_QUEUE");
}

/**
 * Capacity telemetry/recovery queue producer. Cloudflare Tail observations and
 * compact post-execution settlement intents share this durable queue; its
 * consumer discriminates their versioned message shapes.
 */
export function getCapacityTelemetryQueue(): QueueProducer | null {
  return getQueueProducer("CAPACITY_TELEMETRY_QUEUE");
}

/** Durable async dispatch to the dedicated Compute Worker. */
export function getComputeQueue(): QueueProducer | null {
  return getQueueProducer("COMPUTE_QUEUE");
}
