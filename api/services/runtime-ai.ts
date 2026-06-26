import type {
  AIRequest,
  AIResponse,
  ChatUsage,
  InferenceRoutePreference,
} from "../../shared/contracts/ai.ts";
import { CHAT_MIN_BALANCE_LIGHT } from "../../shared/contracts/ai.ts";
import type { RuntimeAIRoute } from "../runtime/sandbox.ts";
import { createAIService } from "./ai.ts";
import { checkChatBalance, deductChatCost } from "./chat-billing.ts";
import { isFreeModeEnabled } from "./free-mode.ts";
import { selectInferenceModel } from "./inference-client.ts";
import {
  InferenceRouteError,
  resolveInferenceRoute,
  type ResolvedInferenceRoute,
} from "./inference-route.ts";

export interface RuntimeAIService {
  call(request: AIRequest, apiKey?: string): Promise<AIResponse>;
}

export interface RuntimeAIContext {
  route: RuntimeAIRoute | null;
  resolvedRoute: ResolvedInferenceRoute | null;
  aiService: RuntimeAIService;
  userApiKey: string | null;
  // Human-readable reason AI is unavailable (no user, balance gate, route
  // error). Threaded into the dynamic-worker AI binding so sandboxed apps
  // see the same message as the in-process service path.
  unavailableReason: string | null;
}

export interface RuntimeAIUser {
  id: string;
  email: string;
}

function emptyAIResponse(model: string, errorMessage: string): AIResponse {
  return {
    content: "",
    model,
    usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
    error: errorMessage,
  };
}

export function createUnavailableAIService(errorMessage: string): RuntimeAIService {
  return {
    call: async (request: AIRequest) => emptyAIResponse(request.model || "none", errorMessage),
  };
}

function toRuntimeAIRoute(route: ResolvedInferenceRoute): RuntimeAIRoute {
  return {
    provider: route.provider,
    upstreamProvider: route.upstreamProvider,
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    canonicalModelId: route.canonicalModelId,
    billingModelId: route.billingModelId,
    billingSource: route.billingSource,
    requestDefaults: route.requestDefaults,
    shouldDebitLight: route.shouldDebitLight,
  };
}

function toChatUsage(response: AIResponse): ChatUsage {
  const promptTokens = response.usage.input_tokens || 0;
  const completionTokens = response.usage.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_cache_hit_tokens: response.usage.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: response.usage.prompt_cache_miss_tokens,
  };
}

export function createRoutedRuntimeAIService(
  route: ResolvedInferenceRoute,
  userId: string,
): RuntimeAIService {
  const service = createAIService(
    route.upstreamProvider,
    route.apiKey,
    route.model,
    route.requestDefaults,
  );

  return {
    call: async (request: AIRequest): Promise<AIResponse> => {
      const model = selectInferenceModel(route, request.model);
      const response = await service.call({ ...request, model });
      const usage = toChatUsage(response);

      if (route.shouldDebitLight && usage.total_tokens > 0) {
        try {
          const billingModel = route.billingSource === 'platform_deepseek_direct'
            ? response.model || model
            : route.billingModelId ?? response.model ?? model;
          const billing = await deductChatCost(
            userId,
            usage,
            billingModel,
            undefined,
            {
              provider: route.provider,
              upstream_provider: route.upstreamProvider,
              upstream_model: response.model || model,
              canonical_model_id: route.canonicalModelId ?? null,
              source: 'runtime_ai',
            },
            { billingSource: route.billingSource },
          );
          response.usage.cost_light = billing.cost_light;
        } catch (err) {
          console.error("[RUNTIME-AI] Failed to debit Light for AI call:", err);
        }
      }

      return response;
    },
  };
}

function routeErrorMessage(error: unknown): string {
  if (error instanceof InferenceRouteError) {
    if (error.code === "byok_key_missing") {
      return "BYOK is enabled, but the API key could not be loaded. Please re-add your API key in Settings.";
    }
    return error.message;
  }

  return error instanceof Error ? error.message : "AI service unavailable";
}

export interface CreateRuntimeAIContextOptions {
  resolveRoute?: typeof resolveInferenceRoute;
  checkBalance?: typeof checkChatBalance;
  // Free Mode (caller balance below threshold): when set, the credits-route
  // balance gate fails CLOSED — a balance-read error denies inference rather
  // than proceeding un-gated, so a $0 user can never spend. See FREE_MODE_DESIGN.
  freeMode?: boolean;
  // Per-(installer, app, function) route override → a resolveInferenceRoute
  // selection. null/undefined = no override → the default fallback chain.
  inferenceSelection?: InferenceRoutePreference | null;
}

export async function createRuntimeAIContext(
  user: RuntimeAIUser | null | undefined,
  options: CreateRuntimeAIContextOptions = {},
): Promise<RuntimeAIContext> {
  const resolveRoute = options.resolveRoute ?? resolveInferenceRoute;
  const checkBalance = options.checkBalance ?? checkChatBalance;

  if (!user) {
    const message = "AI requires an authenticated user.";
    return {
      route: null,
      resolvedRoute: null,
      aiService: createUnavailableAIService(message),
      userApiKey: null,
      unavailableReason: message,
    };
  }

  try {
    const route = await resolveRoute({
      userId: user.id,
      userEmail: user.email,
      selection: options.inferenceSelection ?? null,
    });

    // Pre-call balance gate for credits-billed routes (BYOK routes set
    // shouldRequireBalance to false). Blocks runtime inference when the
    // user is known to be below the platform minimum, instead of relying
    // solely on post-hoc allow-partial debiting.
    if (route.shouldRequireBalance) {
      try {
        const balance = await checkBalance(user.id);
        if (balance < CHAT_MIN_BALANCE_LIGHT) {
          const message =
            `Platform inference requires at least ${CHAT_MIN_BALANCE_LIGHT} credits ` +
            `(current balance: ${balance}). Add credits in the wallet or configure ` +
            `a BYOK provider key in Settings.`;
          return {
            route: null,
            resolvedRoute: null,
            aiService: createUnavailableAIService(message),
            userApiKey: null,
            unavailableReason: message,
          };
        }
      } catch (balanceError) {
        // Free Mode: FAIL CLOSED. We already believe the caller is below the
        // threshold, so a balance-read failure must not let inference through —
        // deny instead of relying on post-hoc allow-partial debiting.
        if (isFreeModeEnabled() && options.freeMode) {
          const message =
            "Platform inference is unavailable in free mode. Add a BYOK " +
            "provider key in Settings, or add credits to your wallet.";
          return {
            route: null,
            resolvedRoute: null,
            aiService: createUnavailableAIService(message),
            userApiKey: null,
            unavailableReason: message,
          };
        }
        // FAIL OPEN (normal): the gate protects against known-insufficient
        // balances; availability wins on infra errors. If the billing read is
        // unavailable we proceed un-gated — post-hoc debiting in
        // createRoutedRuntimeAIService still applies.
        console.warn(
          "[RUNTIME-AI] Balance check unavailable; proceeding un-gated:",
          balanceError,
        );
      }
    }

    return {
      route: toRuntimeAIRoute(route),
      resolvedRoute: route,
      aiService: createRoutedRuntimeAIService(route, user.id),
      userApiKey: route.apiKey,
      unavailableReason: null,
    };
  } catch (error) {
    const message = routeErrorMessage(error);
    return {
      route: null,
      resolvedRoute: null,
      aiService: createUnavailableAIService(message),
      userApiKey: null,
      unavailableReason: message,
    };
  }
}
