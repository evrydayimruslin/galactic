// Regression tests for per-function override pinning in the sandbox AI
// binding. Before this, the dev's per-call ai({model}) argument silently
// outranked the installer's explicit per-function model override (the override
// only reached the binding as defaultModel).

import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  resolveRequestedModel,
  shouldRetryWithFallbackModel,
} from "./ai-model-precedence.ts";

const FALLBACK = "deepseek/deepseek-v4-flash";

Deno.test("resolveRequestedModel: a pinned override beats the dev's per-call model", () => {
  assertEquals(
    resolveRequestedModel({
      requestModel: "openai/gpt-4o-mini",
      defaultModel: "anthropic/claude-x",
      modelPinned: true,
      fallbackModel: FALLBACK,
    }),
    "anthropic/claude-x",
  );
});

Deno.test("resolveRequestedModel: unpinned keeps dev per-call > default > fallback", () => {
  assertEquals(
    resolveRequestedModel({
      requestModel: "openai/gpt-4o-mini",
      defaultModel: "anthropic/claude-x",
      modelPinned: false,
      fallbackModel: FALLBACK,
    }),
    "openai/gpt-4o-mini",
  );
  assertEquals(
    resolveRequestedModel({
      requestModel: undefined,
      defaultModel: "anthropic/claude-x",
      modelPinned: false,
      fallbackModel: FALLBACK,
    }),
    "anthropic/claude-x",
  );
  assertEquals(
    resolveRequestedModel({
      requestModel: undefined,
      defaultModel: null,
      modelPinned: undefined,
      fallbackModel: FALLBACK,
    }),
    FALLBACK,
  );
});

Deno.test("resolveRequestedModel: pinned without a default degrades to the normal chain", () => {
  // Defensive: a pin flag with no route model must never produce an empty model.
  assertEquals(
    resolveRequestedModel({
      requestModel: "openai/gpt-4o-mini",
      defaultModel: null,
      modelPinned: true,
      fallbackModel: FALLBACK,
    }),
    "openai/gpt-4o-mini",
  );
});

Deno.test("shouldRetryWithFallbackModel: never substitutes a pinned model", () => {
  assertEquals(
    shouldRetryWithFallbackModel({
      upstreamProvider: "openrouter",
      attemptedModel: "anthropic/claude-x",
      fallbackModel: FALLBACK,
      modelPinned: true,
    }),
    false,
  );
  assertEquals(
    shouldRetryWithFallbackModel({
      upstreamProvider: "openrouter",
      attemptedModel: "anthropic/claude-x",
      fallbackModel: FALLBACK,
      modelPinned: false,
    }),
    true,
  );
});

Deno.test("shouldRetryWithFallbackModel: OpenRouter-only, and never retries the fallback itself", () => {
  assertEquals(
    shouldRetryWithFallbackModel({
      upstreamProvider: "deepseek",
      attemptedModel: "anthropic/claude-x",
      fallbackModel: FALLBACK,
      modelPinned: false,
    }),
    false,
  );
  assertEquals(
    shouldRetryWithFallbackModel({
      upstreamProvider: "openrouter",
      attemptedModel: FALLBACK,
      fallbackModel: FALLBACK,
      modelPinned: false,
    }),
    false,
  );
});
