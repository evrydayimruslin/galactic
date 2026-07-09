// Model precedence for the sandbox AI binding (ai-binding.ts). Pure so it can
// be unit-tested without the cloudflare:workers import (same pattern as
// memory-scope.ts).

// The user's EXPLICIT per-function override is pinned (modelPinned, arrives as
// defaultModel) and beats everything; otherwise dev's per-call model > user's
// selected model (defaultModel) > platform fallback.
export function resolveRequestedModel(input: {
  requestModel: string | null | undefined;
  defaultModel: string | null | undefined;
  modelPinned: boolean | undefined;
  fallbackModel: string;
}): string {
  if (input.modelPinned && input.defaultModel) {
    return input.defaultModel;
  }
  return input.requestModel || input.defaultModel || input.fallbackModel;
}

// Retry a failed call once with the platform fallback model — but only on the
// OpenRouter path, where that slug is valid. A pinned model (the user's
// explicit per-function choice) is never silently substituted: surface the
// upstream error so the user can fix their override instead of unknowingly
// running a different model.
export function shouldRetryWithFallbackModel(input: {
  upstreamProvider: string | null | undefined;
  attemptedModel: string;
  fallbackModel: string;
  modelPinned: boolean | undefined;
}): boolean {
  return input.upstreamProvider === "openrouter" &&
    input.attemptedModel !== input.fallbackModel &&
    !input.modelPinned;
}
