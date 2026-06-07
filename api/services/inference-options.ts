import {
  CHAT_MIN_BALANCE_LIGHT,
  CHAT_PLATFORM_MARKUP,
  type ChatInferenceOptionsResponse,
  type ChatInferenceProviderOption,
} from "../../shared/contracts/ai.ts";
import {
  BYOK_PROVIDERS,
  isActiveBYOKProvider,
  type ActiveBYOKProvider,
} from "../../shared/types/index.ts";
import { checkChatBalance } from "./chat-billing.ts";
import { createUserService, type UserProfile, type UserService } from "./user.ts";

export interface BuildInferenceOptionsParams {
  userId: string;
  userService?: Pick<UserService, "getUser">;
  checkBalance?: typeof checkChatBalance;
}

function getConfiguredProviderIds(user: UserProfile): ActiveBYOKProvider[] {
  return user.byok_configs
    .filter((config) => config.has_key)
    .map((config) => config.provider)
    .filter(isActiveBYOKProvider);
}

function buildProviderOptions(user: UserProfile): ChatInferenceProviderOption[] {
  const configByProvider = new Map(
    user.byok_configs
      .filter((config) => isActiveBYOKProvider(config.provider))
      .map((config) => [config.provider as ActiveBYOKProvider, config]),
  );

  return Object.values(BYOK_PROVIDERS).map((provider) => {
    const config = configByProvider.get(provider.id);
    const configured = !!config?.has_key;
    return {
      id: provider.id,
      name: provider.name,
      description: provider.description,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      models: provider.models,
      capabilities: provider.capabilities,
      apiKeyPrefix: provider.apiKeyPrefix,
      docsUrl: provider.docsUrl,
      apiKeyUrl: provider.apiKeyUrl,
      configured,
      primary: configured && user.byok_enabled && user.byok_provider === provider.id,
      configuredModel: configured ? config?.model ?? null : null,
      addedAt: configured ? config?.added_at ?? null : null,
    };
  });
}

export async function buildInferenceOptions(
  params: BuildInferenceOptionsParams,
): Promise<ChatInferenceOptionsResponse> {
  const userService = params.userService ?? createUserService();
  const user = await userService.getUser(params.userId);

  if (!user) {
    throw new Error("User not found");
  }

  let balanceLight: number | null = null;
  let balanceError: string | undefined;
  try {
    balanceLight = await (params.checkBalance ?? checkChatBalance)(params.userId);
  } catch (error) {
    balanceError = error instanceof Error ? error.message : "Balance unavailable";
  }

  const configuredProviderIds = getConfiguredProviderIds(user);
  const primaryProvider = user.byok_enabled &&
      isActiveBYOKProvider(user.byok_provider) &&
      configuredProviderIds.includes(user.byok_provider)
    ? user.byok_provider
    : configuredProviderIds[0] ?? null;
  const defaultBillingMode = primaryProvider ? "byok" : "light";
  const selectedProvider = primaryProvider ?? "openrouter";
  const configuredModel = primaryProvider
    ? user.byok_configs.find((config) => config.provider === primaryProvider)?.model
    : undefined;

  return {
    defaultBillingMode,
    selected: {
      billingMode: defaultBillingMode,
      provider: selectedProvider,
      model: configuredModel?.trim() || BYOK_PROVIDERS[selectedProvider].defaultModel,
      webSearchEnabled: false,
    },
    light: {
      provider: "openrouter",
      defaultModel: BYOK_PROVIDERS.openrouter.defaultModel,
      models: BYOK_PROVIDERS.openrouter.models,
      balanceLight,
      minimumBalanceLight: CHAT_MIN_BALANCE_LIGHT,
      usable: balanceLight !== null && balanceLight >= CHAT_MIN_BALANCE_LIGHT,
      markup: CHAT_PLATFORM_MARKUP,
      ...(balanceError ? { unavailableReason: balanceError } : {}),
    },
    providers: buildProviderOptions(user),
    configuredProviderIds,
  };
}
