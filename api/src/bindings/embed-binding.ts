// RPC embedding binding for Dynamic Workers.
//
// Embeddings are a distinct SDK primitive from chat completion: the sandbox
// supplies text and receives a numeric vector, while provider credentials,
// billing attribution, and execution identity remain host-side.

import { WorkerEntrypoint } from "cloudflare:workers";
import { recordUnbilledAiUsage } from "../../services/ai-usage-events.ts";
import { recordAiSpend } from "../../services/ai-spend-tracker.ts";
import {
  createEmbeddingService,
  hashEmbeddingText,
} from "../../services/embedding.ts";
import { recordEmbeddingGenerationCharge } from "../../services/embedding-billing.ts";
import { getEmbeddingLightRatePer1kTokens } from "../../services/embedding-billing.ts";
import {
  assertExecutionContext,
  resolveExecutionContext,
} from "../../services/execution-context-registry.ts";
import {
  reserveRoutineRunBudget,
  settleRoutineRunBudgetReservation,
} from "../../services/routine-budget.ts";
import type { RoutineTraceContext } from "../../services/routine-trace.ts";
import {
  estimateEmbeddingReservationLight,
  settleAmbiguousEmbeddingReservation,
} from "./embedding-budget.ts";

const MAX_EMBED_INPUT_CHARS = 32_000;
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_FETCH_TIMEOUT_MS = 90_000;
const EMBEDDING_SETTLEMENT_MARGIN_MS = 30_000;

interface EmbedRequest {
  input?: unknown;
  model?: unknown;
}

interface EmbedResponse {
  embedding: number[];
  model: string;
  dimensions: number;
  usage: {
    input_tokens: number;
    total_tokens: number;
    cost_light: number;
  };
}

interface EmbedBindingProps {
  userId: string;
  appId: string;
  appVersion?: string | null;
  executionId?: string | null;
  // A user's OpenRouter BYOK key, when configured. It is frozen only inside
  // the parent-side binding props and never injected into tenant code.
  userApiKey?: string | null;
  requireExecCtx?: boolean;
  routineContext?: RoutineTraceContext | null;
}

export class EmbedBinding extends WorkerEntrypoint<unknown, EmbedBindingProps> {
  async embed(
    request: EmbedRequest,
    execCtxHandle?: string,
  ): Promise<EmbedResponse> {
    assertExecutionContext(execCtxHandle, this.ctx.props.requireExecCtx);

    const input = typeof request?.input === "string"
      ? request.input.trim()
      : "";
    if (!input) {
      throw new Error("galactic.embed requires a non-empty string `input`.");
    }
    if (input.length > MAX_EMBED_INPUT_CHARS) {
      throw new Error(
        `galactic.embed input exceeds ${MAX_EMBED_INPUT_CHARS} characters.`,
      );
    }

    const requestedModel = typeof request?.model === "string"
      ? request.model.trim()
      : "";
    if (requestedModel && requestedModel !== DEFAULT_EMBEDDING_MODEL) {
      throw new Error(
        `galactic.embed currently supports only ${DEFAULT_EMBEDDING_MODEL}.`,
      );
    }

    const service = createEmbeddingService(
      this.ctx.props.userApiKey || undefined,
    );
    if (!service) {
      throw new Error(
        "galactic.embed is unavailable: configure an OpenRouter BYOK key or the platform embedding service.",
      );
    }

    const resolved = resolveExecutionContext(execCtxHandle);
    const executionId = resolved?.aiExecutionId ??
      this.ctx.props.executionId ?? null;
    const appId = resolved?.appId ?? this.ctx.props.appId;
    const functionName = resolved?.functionName ?? null;
    const routineContext = resolved?.routineContext ??
      this.ctx.props.routineContext ?? null;

    // Admission is authoritative and happens before provider work. BYOK still
    // reserves zero Light so each embedding consumes max_calls_per_run.
    let routineReservationId: string | null = null;
    let routineReservedLight = 0;
    if (routineContext) {
      const reserveLight = estimateEmbeddingReservationLight(
        input,
        getEmbeddingLightRatePer1kTokens(),
        !!this.ctx.props.userApiKey,
      );
      const admission = await reserveRoutineRunBudget({
        userId: this.ctx.props.userId,
        routine: routineContext,
        reservationKey: `embed:${
          executionId || "legacy"
        }:${crypto.randomUUID()}`,
        kind: "ai_call",
        reserveLight,
        expiresAt: new Date(
          Date.now() + EMBEDDING_FETCH_TIMEOUT_MS +
            EMBEDDING_SETTLEMENT_MARGIN_MS,
        ).toISOString(),
      }).catch((error) => {
        throw new Error(
          `Routine budget admission unavailable; embedding refused: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      if (!admission.allowed || !admission.reservation) {
        throw new Error(admission.message);
      }
      routineReservationId = admission.reservation.id;
      routineReservedLight = admission.reservation.reservedLight;
    }

    let result: Awaited<ReturnType<typeof service.embed>>;
    const providerAbort = new AbortController();
    const providerTimeout = setTimeout(
      () => providerAbort.abort(),
      EMBEDDING_FETCH_TIMEOUT_MS,
    );
    try {
      result = await service.embed(input, { signal: providerAbort.signal });
    } catch (error) {
      if (routineReservationId) {
        // A timeout/transport error after dispatch is ambiguous: the provider
        // may have completed billable work. Never restore hard-budget capacity
        // unless zero spend is known before execution begins.
        await settleAmbiguousEmbeddingReservation({
          reservationId: routineReservationId,
          userId: this.ctx.props.userId,
          reservedLight: routineReservedLight,
        }).catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(providerTimeout);
    }
    const inputTokens = Math.max(0, result.usage.prompt_tokens || 0);
    const totalTokens = Math.max(
      inputTokens,
      result.usage.total_tokens || inputTokens,
    );
    let costLight = 0;

    const actualRoutineLight = this.ctx.props.userApiKey
      ? 0
      : totalTokens * getEmbeddingLightRatePer1kTokens() / 1000;
    if (routineReservationId) {
      await settleRoutineRunBudgetReservation({
        reservationId: routineReservationId,
        userId: this.ctx.props.userId,
        actualLight: actualRoutineLight,
        applySpend: true,
      }).catch((error) => {
        throw new Error(
          `Routine budget settlement failed; embedding result withheld: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    if (this.ctx.props.userApiKey) {
      recordUnbilledAiUsage({
        userId: this.ctx.props.userId,
        appId,
        functionName,
        executionId,
        billingMode: "byok",
        provider: "openrouter",
        upstreamProvider: "openrouter",
        keySource: "user_byok",
        model: result.model,
        requestedModel: requestedModel || DEFAULT_EMBEDDING_MODEL,
        promptTokens: inputTokens,
        completionTokens: 0,
        source: "runtime_embed_binding",
      });
    } else {
      const inputHash = await hashEmbeddingText(input);
      const charge = await recordEmbeddingGenerationCharge({
        publisherUserId: this.ctx.props.userId,
        appId,
        appVersion: this.ctx.props.appVersion ?? null,
        model: result.model,
        promptTokens: inputTokens,
        totalTokens,
        idempotencyKey: [
          "runtime_embed",
          executionId || "no-execution",
          functionName || "unknown-function",
          inputHash,
        ].join(":"),
        metadata: {
          source: "runtime_embed_binding",
          function_name: functionName,
          execution_id: executionId,
        },
      });
      if (!charge || charge.status === "failed") {
        throw new Error("Embedding charge could not be recorded.");
      }
      if (charge.status === "insufficient_balance") {
        throw new Error("Insufficient Light for embedding generation.");
      }
      costLight = charge.amountDebitedLight;
      recordAiSpend(executionId, costLight);
    }

    return {
      embedding: result.embedding,
      model: result.model,
      dimensions: result.embedding.length,
      usage: {
        input_tokens: inputTokens,
        total_tokens: totalTokens,
        cost_light: costLight,
      },
    };
  }
}
