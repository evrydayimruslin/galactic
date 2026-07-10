// Usage metadata for AI calls that produce NO economic row (BYOK / unbilled
// routes). Credits-billed calls are already recorded by billing_transactions;
// without this, BYOK traffic leaves literally no trace and model-per-function
// stats are blind to it.
//
// INVARIANT: this is a fire-and-forget write on a NON-economic path. It must
// never touch debit_light or any wallet — a bug here must not be able to
// charge a BYOK user — and it must never fail the AI call it describes.

import { getEnv } from "../lib/env.ts";

export interface UnbilledAiUsageInput {
  userId: string;
  appId?: string | null;
  functionName?: string | null;
  executionId?: string | null;
  /** 'byok' = user's own provider key; 'unbilled' = any other zero-debit route. */
  billingMode: "byok" | "unbilled";
  provider?: string | null;
  upstreamProvider?: string | null;
  keySource?: string | null;
  /** Model actually served (response model). */
  model: string;
  requestedModel?: string | null;
  promptTokens: number;
  completionTokens: number;
  /** Emitting code path ('runtime_ai_binding' | 'runtime_ai'). */
  source: string;
}

/**
 * Fire-and-forget insert into ai_usage_events. Swallows every failure after a
 * console.warn — usage telemetry must never break inference.
 */
export function recordUnbilledAiUsage(input: UnbilledAiUsageInput): void {
  const promptTokens = Math.max(0, Math.floor(input.promptTokens || 0));
  const completionTokens = Math.max(
    0,
    Math.floor(input.completionTokens || 0),
  );
  if (promptTokens + completionTokens <= 0) return;

  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;

  fetch(`${url}/rest/v1/ai_usage_events`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      user_id: input.userId,
      app_id: input.appId ?? null,
      function_name: input.functionName ?? null,
      execution_id: input.executionId ?? null,
      billing_mode: input.billingMode,
      provider: input.provider ?? null,
      upstream_provider: input.upstreamProvider ?? null,
      key_source: input.keySource ?? null,
      model: input.model,
      requested_model: input.requestedModel ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      source: input.source,
    }),
  }).then((res) => {
    if (!res.ok) {
      res.text().then((text) =>
        console.warn(`[AI-USAGE] Failed to record usage event: ${text}`)
      ).catch(() => {});
    }
  }).catch((err) => {
    console.warn("[AI-USAGE] Failed to record usage event:", err);
  });
}
