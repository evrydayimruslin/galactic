import type { ActiveBYOKProvider, BYOKProviderCapabilities } from "../../shared/types/index.ts";
import { BYOK_PROVIDERS, isActiveBYOKProvider } from "../../shared/types/index.ts";
import type {
  InferenceBillingMode,
  InferenceRoutePreference,
} from "../../shared/contracts/ai.ts";
import { getOrCreateOpenRouterKey } from "./openrouter-keys.ts";
import {
  type PlatformInferenceProvider,
  type PlatformInferenceRequestDefaults,
  type PlatformInferenceUpstreamProvider,
  type PlatformInferenceKeySource,
  resolvePlatformInferenceModel,
} from "./platform-inference-models.ts";
import { createUserService, type UserProfile, type UserService } from "./user.ts";

export type InferenceProvider = ActiveBYOKProvider | PlatformInferenceProvider;
export type InferenceUpstreamProvider = ActiveBYOKProvider | PlatformInferenceUpstreamProvider;
export type InferenceKeySource = "user_byok" | "platform_openrouter" | PlatformInferenceKeySource;
export type InferenceBillingSource = "none" | "openrouter" | "platform_deepseek_direct";
export type InferenceRouteErrorCode =
  | "user_not_found"
  | "invalid_route_selection"
  | "byok_provider_not_configured"
  | "byok_key_missing"
  | "platform_key_unavailable";

export interface ResolvedInferenceRoute {
  billingMode: InferenceBillingMode;
  provider: InferenceProvider;
  upstreamProvider: InferenceUpstreamProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  canonicalModelId?: string;
  billingModelId?: string;
  keySource: InferenceKeySource;
  billingSource: InferenceBillingSource;
  requestDefaults?: PlatformInferenceRequestDefaults;
  shouldRequireBalance: boolean;
  shouldDebitLight: boolean;
  // The route model is the caller's EXPLICIT choice (e.g. the installer's
  // per-function override) and must win over any per-call ai({model}) argument
  // from app code. Executors (selectInferenceModel, the sandbox AI binding)
  // pin route.model when this is set.
  modelPinned?: boolean;
}

export function getInferenceRouteCapabilities(
  route: Pick<ResolvedInferenceRoute, "billingMode" | "provider" | "upstreamProvider">,
): BYOKProviderCapabilities | null {
  if (route.billingMode === "byok" && isActiveBYOKProvider(route.provider)) {
    return BYOK_PROVIDERS[route.provider].capabilities;
  }
  if (isActiveBYOKProvider(route.upstreamProvider)) {
    return BYOK_PROVIDERS[route.upstreamProvider].capabilities;
  }
  return null;
}

export function routeSupportsRealtime(
  route: Pick<ResolvedInferenceRoute, "billingMode" | "provider" | "upstreamProvider">,
): boolean {
  return getInferenceRouteCapabilities(route)?.realtime === true;
}

export interface ResolveInferenceRouteParams {
  userId: string;
  userEmail: string;
  requestedModel?: string | null;
  selection?: InferenceRoutePreference | null;
  // The selection is a user's EXPLICIT override (per-function model picker):
  // when it carries a model, the resolved route is marked modelPinned so the
  // dev's per-call ai({model}) argument cannot outrank it.
  pinSelectedModel?: boolean;
  userService?: Pick<UserService, "getUser" | "getDecryptedApiKey">;
  getOrCreateOpenRouterKey?: typeof getOrCreateOpenRouterKey;
  /** Persistent Agent launch path: never provision or fall back to platform inference. */
  byokOnly?: boolean;
}

export class InferenceRouteError extends Error {
  readonly code: InferenceRouteErrorCode;
  readonly status: number;

  constructor(code: InferenceRouteErrorCode, message: string, status: number) {
    super(message);
    this.name = "InferenceRouteError";
    this.code = code;
    this.status = status;
  }
}

function requestedOrDefault(
  requestedModel: string | null | undefined,
  configuredModel: string | undefined,
  provider: ActiveBYOKProvider,
): string {
  return requestedModel?.trim() ||
    configuredModel?.trim() ||
    BYOK_PROVIDERS[provider].defaultModel;
}

function getPrimaryByokProvider(user: UserProfile): ActiveBYOKProvider | null {
  return user.byok_enabled && isActiveBYOKProvider(user.byok_provider)
    ? user.byok_provider
    : null;
}

function getSelectionBillingMode(
  selection: InferenceRoutePreference | null | undefined,
): InferenceBillingMode | null {
  if (!selection?.billingMode) return null;
  if (selection.billingMode === "byok" || selection.billingMode === "light") {
    return selection.billingMode;
  }
  throw new InferenceRouteError(
    "invalid_route_selection",
    "Inference billing mode must be either byok or light",
    400,
  );
}

function getSelectionProvider(
  selection: InferenceRoutePreference | null | undefined,
): ActiveBYOKProvider | null {
  if (!selection?.provider) return null;
  if (isActiveBYOKProvider(selection.provider)) return selection.provider;
  throw new InferenceRouteError(
    "invalid_route_selection",
    `Unsupported inference provider: ${selection.provider}`,
    400,
  );
}

function getRequestedLightModel(params: ResolveInferenceRouteParams): string | null {
  return params.selection?.model?.trim() ||
    params.requestedModel?.trim() ||
    null;
}

function shouldPinSelectedModel(params: ResolveInferenceRouteParams): boolean {
  return (params.pinSelectedModel ?? false) && !!params.selection?.model?.trim();
}

function isConfiguredByokProvider(
  user: UserProfile,
  provider: ActiveBYOKProvider,
): boolean {
  return user.byok_enabled &&
    user.byok_configs.some((config) => config.provider === provider && config.has_key);
}

async function buildByokRoute(
  user: UserProfile,
  params: ResolveInferenceRouteParams,
  provider: ActiveBYOKProvider,
): Promise<ResolvedInferenceRoute> {
  if (!isConfiguredByokProvider(user, provider)) {
    throw new InferenceRouteError(
      "byok_provider_not_configured",
      `BYOK provider ${provider} is not configured for this user`,
      409,
    );
  }

  const userService = params.userService ?? createUserService();
  const apiKey = await userService.getDecryptedApiKey(params.userId, provider);
  if (!apiKey) {
    throw new InferenceRouteError(
      "byok_key_missing",
      `BYOK is enabled for ${provider}, but no usable API key is available`,
      409,
    );
  }

  const providerInfo = BYOK_PROVIDERS[provider];
  const configuredModel = user.byok_configs.find((config) => config.provider === provider)
    ?.model;
  const requestedModel = params.selection?.model ?? params.requestedModel;

  return {
    billingMode: "byok",
    provider,
    upstreamProvider: provider,
    baseUrl: providerInfo.baseUrl,
    apiKey,
    model: requestedOrDefault(requestedModel, configuredModel, provider),
    keySource: "user_byok",
    billingSource: "none",
    shouldRequireBalance: false,
    shouldDebitLight: false,
    modelPinned: shouldPinSelectedModel(params),
  };
}

async function buildLightRoute(
  params: ResolveInferenceRouteParams,
  user: UserProfile | null,
): Promise<ResolvedInferenceRoute> {
  const selectedProvider = getSelectionProvider(params.selection);
  if (selectedProvider && selectedProvider !== "openrouter") {
    throw new InferenceRouteError(
      "invalid_route_selection",
      "Light-debit inference provider selection must be omitted or openrouter; model IDs choose the Galactic upstream",
      400,
    );
  }

  // Platform (Light) inference routes entirely through OpenRouter, billed in
  // credits at the platform markup. DeepSeek-direct is retired — DeepSeek and
  // every other model are reached as OpenRouter model slugs. A legacy platform
  // model id (e.g. ultralight/deepseek-v4-flash or deepseek-v4-flash) is mapped
  // to its OpenRouter slug (deepseek/deepseek-v4-flash) so existing callers keep
  // working. Model precedence: per-request model > the user's saved platform
  // model > the OpenRouter provider default. The saved preference makes both
  // interactive chat AND autonomous/agent runs (which pass no model) honor the
  // user's choice.
  const requestedModel = getRequestedLightModel(params);
  const platformModel = requestedModel
    ? resolvePlatformInferenceModel(requestedModel)
    : null;
  const openRouterModel = platformModel
    ? platformModel.aliases.find((alias) => alias.includes("/")) ?? requestedModel
    : requestedModel;

  try {
    const apiKey = await (params.getOrCreateOpenRouterKey ?? getOrCreateOpenRouterKey)(
      params.userId,
      params.userEmail,
    );
    const providerInfo = BYOK_PROVIDERS.openrouter;

    return {
      billingMode: "light",
      provider: "ultralight",
      upstreamProvider: "openrouter",
      baseUrl: providerInfo.baseUrl,
      apiKey,
      model: requestedOrDefault(openRouterModel, user?.platform_inference_model ?? undefined, "openrouter"),
      keySource: "platform_openrouter",
      billingSource: "openrouter",
      shouldRequireBalance: true,
      shouldDebitLight: true,
      modelPinned: shouldPinSelectedModel(params),
    };
  } catch (error) {
    if (error instanceof InferenceRouteError) throw error;
    const detail = error instanceof Error ? error.message : "OpenRouter key provisioning failed";
    throw new InferenceRouteError("platform_key_unavailable", detail, 503);
  }
}

export async function resolveInferenceRoute(
  params: ResolveInferenceRouteParams,
): Promise<ResolvedInferenceRoute> {
  const userService = params.userService ?? createUserService();
  const user = await userService.getUser(params.userId);

  if (!user) {
    throw new InferenceRouteError("user_not_found", "User not found", 404);
  }

  const selectedBillingMode = getSelectionBillingMode(params.selection);
  const selectedProvider = getSelectionProvider(params.selection);

  if (selectedBillingMode === "light") {
    if (params.byokOnly) {
      throw new InferenceRouteError(
        "byok_provider_not_configured",
        "This Agent requires a configured BYOK provider; Galactic does not supply inference keys.",
        409,
      );
    }
    return await buildLightRoute(params, user);
  }

  if (selectedBillingMode === "byok" || selectedProvider) {
    const provider = selectedProvider ?? getPrimaryByokProvider(user);
    if (!provider) {
      throw new InferenceRouteError(
        "byok_provider_not_configured",
        "BYOK inference was requested, but no BYOK provider is configured",
        409,
      );
    }
    return await buildByokRoute(user, params, provider);
  }

  const byokProvider = getPrimaryByokProvider(user);
  if (byokProvider) {
    return await buildByokRoute(user, params, byokProvider);
  }

  if (params.byokOnly) {
    throw new InferenceRouteError(
      "byok_provider_not_configured",
      "This Agent requires a configured BYOK provider; add a provider API key in Account.",
      409,
    );
  }

  return await buildLightRoute(params, user);
}
