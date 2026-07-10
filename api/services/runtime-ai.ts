import type {
  AIRequest,
  AIResponse,
  ChatUsage,
  InferenceRoutePreference,
} from "../../shared/contracts/ai.ts";
import { CHAT_MIN_BALANCE_LIGHT } from "../../shared/contracts/ai.ts";
import type { RuntimeAIRoute } from "../runtime/sandbox.ts";
import { createAIService } from "./ai.ts";
import { recordUnbilledAiUsage } from "./ai-usage-events.ts";
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
    keySource: route.keySource,
    requestDefaults: route.requestDefaults,
    shouldDebitLight: route.shouldDebitLight,
    shouldRequireBalance: route.shouldRequireBalance,
    modelPinned: route.modelPinned,
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

interface RuntimeAIAttribution {
  appId?: string | null;
  functionName?: string | null;
}

export function createRoutedRuntimeAIService(
  route: ResolvedInferenceRoute,
  userId: string,
  checkBalance: typeof checkChatBalance = checkChatBalance,
  attribution: RuntimeAIAttribution = {},
): RuntimeAIService {
  const service = createAIService(
    route.upstreamProvider,
    route.apiKey,
    route.model,
    route.requestDefaults,
  );
  // A metered route re-checks the wallet on EVERY ai() call. The context-build
  // gate (createRuntimeAIContext) only fires once; without this a buyer could
  // fan out many galactic.ai() calls in one execution and outspend their
  // balance, since the post-hoc debit allows partial debiting. BYOK routes are
  // not metered and skip this entirely.
  const metered = route.shouldRequireBalance && route.shouldDebitLight;

  return {
    call: async (request: AIRequest): Promise<AIResponse> => {
      const model = selectInferenceModel(route, request.model);

      if (metered) {
        // Fail OPEN on a balance-read error (match the context-build gate's
        // normal branch): availability wins on infra blips, and the post-hoc
        // debit still applies. Free-Mode users are already denied at context
        // build, so a call only reaches here for a funded, non-Free user.
        let balance: number | null = null;
        try {
          balance = await checkBalance(userId);
        } catch (balanceError) {
          console.warn(
            "[RUNTIME-AI] Per-call balance re-check unavailable; proceeding un-gated:",
            balanceError,
          );
        }
        if (balance !== null && balance < CHAT_MIN_BALANCE_LIGHT) {
          return emptyAIResponse(
            model,
            `Platform inference requires at least ${CHAT_MIN_BALANCE_LIGHT} credits ` +
              `(current balance: ${balance}). Add credits in the wallet or configure ` +
              `a BYOK provider key in Settings.`,
          );
        }
      }

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
              appId: attribution.appId ?? null,
              functionName: attribution.functionName ?? null,
            },
            { billingSource: route.billingSource },
          );
          // A depleting (partial) debit means the buyer could not fully cover
          // this call: withhold the content so they cannot consume inference
          // they did not pay for. Only on metered routes (a BYOK route never
          // depletes a platform wallet, so was_depleted there is irrelevant).
          if (metered && billing.was_depleted) {
            return emptyAIResponse(
              response.model || model,
              `Insufficient credits to complete this AI call. Add credits in the ` +
                `wallet or configure a BYOK provider key in Settings.`,
            );
          }
          response.usage.cost_light = billing.cost_light;
        } catch (err) {
          console.error("[RUNTIME-AI] Failed to debit Light for AI call:", err);
        }
      } else if (
        !route.shouldDebitLight && usage.total_tokens > 0 && !response.error
      ) {
        // Zero-debit route (BYOK or otherwise unbilled): record usage metadata
        // on a NON-economic path so model/function analytics aren't blind to
        // BYOK traffic. Fire-and-forget — never blocks or fails the call, and
        // never touches debit_light.
        recordUnbilledAiUsage({
          userId,
          appId: attribution.appId ?? null,
          functionName: attribution.functionName ?? null,
          billingMode: route.keySource === "user_byok" ? "byok" : "unbilled",
          provider: route.provider,
          upstreamProvider: route.upstreamProvider,
          keySource: route.keySource,
          model: response.model || model,
          requestedModel: model,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          source: "runtime_ai",
        });
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
  // App + entry-function attribution stamped onto this execution's billing
  // and usage rows. Omitted on surfaces with no app context (e.g. chat).
  attribution?: RuntimeAIAttribution;
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
      // inferenceSelection is the installer's explicit per-function override:
      // when it names a model, pin it so the dev's per-call ai({model})
      // argument cannot outrank the user's choice.
      pinSelectedModel: Boolean(options.inferenceSelection?.model?.trim()),
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
      aiService: createRoutedRuntimeAIService(
        route,
        user.id,
        checkBalance,
        options.attribution ?? {},
      ),
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
