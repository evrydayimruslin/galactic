// Environment compatibility layer for Cloudflare Workers
// Replaces all Deno.env.get() calls with a universal accessor.
// globalThis.__env is set by worker-entry.ts on each request/scheduled event.

// ============================================
// ENV TYPES
// ============================================

export interface Env {
  // KV namespaces
  CODE_CACHE: KVNamespace;
  FN_INDEX: KVNamespace;

  // R2 bucket
  R2_BUCKET: R2Bucket;

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
  OPENROUTER_API_KEY: string;
  DEEPSEEK_API_KEY: string;
  BYOK_ENCRYPTION_KEY: string;
  RUNPOD_API_KEY: string;
  RUNPOD_TEMPLATE_ID: string;
  RUNPOD_BASE_IMAGE: string;
  RUNPOD_CONTAINER_REGISTRY_AUTH_ID: string;
  RUNPOD_ALLOW_SHARED_TEMPLATE_FALLBACK: string;
  GPU_SUPPORT_ENABLED: string;
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
  ENVIRONMENT: string;
  CORS_ALLOWED_ORIGINS: string;
  PLATFORM_MCP_DISABLED_ALIASES: string;
  CHAT_CAPTURE_ENABLED: string;
  CHAT_CAPTURE_ARTIFACTS_ENABLED: string;
  CHAT_CAPTURE_MAX_INLINE_BYTES: string;
  ANALYTICS_PEPPER_V1: string;
  ANALYTICS_PEPPER_VERSION: string;
  CHAT_CAPTURE_PEPPER: string;

  // Index signature for dynamic access
  [key: string]: unknown;
}

interface WorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
  env: Record<string, unknown>;
  globalOutbound?: unknown;
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
