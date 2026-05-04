import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import { BYOK_PROVIDERS } from "../../shared/types/index.ts";
import type { UserProfile, UserService } from "./user.ts";
import {
  InferenceRouteError,
  resolveInferenceRoute,
} from "./inference-route.ts";
import {
  DEEPSEEK_API_BASE_URL,
  ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
  ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
} from "./platform-inference-models.ts";

type RouteUserService = Pick<UserService, "getUser" | "getDecryptedApiKey">;

function makeUser(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: "user-1",
    email: "user@example.com",
    display_name: null,
    avatar_url: null,
    tier: "free",
    country: null,
    featured_app_id: null,
    profile_slug: null,
    byok_enabled: false,
    byok_provider: null,
    byok_configs: [],
    ...overrides,
  };
}

Deno.test("inference route: Light mode routes DeepSeek platform models directly and requires debit", async () => {
  const userService: RouteUserService = {
    getUser: async () => makeUser(),
    getDecryptedApiKey: async () => {
      throw new Error("BYOK key should not be read");
    },
  };
  let openRouterCalled = false;
  const platformKeys: string[] = [];

  const route = await resolveInferenceRoute({
    userId: "user-1",
    userEmail: "auth@example.com",
    requestedModel: "deepseek/deepseek-v4-pro",
    userService,
    getPlatformApiKey: async (envName) => {
      platformKeys.push(envName);
      return "ds-platform-key";
    },
    getOrCreateOpenRouterKey: async () => {
      openRouterCalled = true;
      return "or-platform-key";
    },
  });

  assertEquals(route.billingMode, "light");
  assertEquals(route.provider, "ultralight");
  assertEquals(route.upstreamProvider, "deepseek");
  assertEquals(route.baseUrl, DEEPSEEK_API_BASE_URL);
  assertEquals(route.apiKey, "ds-platform-key");
  assertEquals(route.model, "deepseek-v4-pro");
  assertEquals(route.canonicalModelId, ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL);
  assertEquals(route.keySource, "platform_deepseek");
  assertEquals(route.billingSource, "platform_deepseek_direct");
  assertEquals(route.shouldRequireBalance, true);
  assertEquals(route.shouldDebitLight, true);
  assertEquals(platformKeys, ["DEEPSEEK_API_KEY"]);
  assertEquals(openRouterCalled, false);
});

Deno.test("inference route: Light mode keeps non-platform models on platform OpenRouter", async () => {
  const platformCalls: Array<{ userId: string; userEmail: string }> = [];

  const route = await resolveInferenceRoute({
    userId: "user-1",
    userEmail: "auth@example.com",
    requestedModel: "openai/gpt-4o-mini",
    userService: {
      getUser: async () => makeUser(),
      getDecryptedApiKey: async () => {
        throw new Error("BYOK key should not be read");
      },
    },
    getPlatformApiKey: async () => {
      throw new Error("DeepSeek key should not be read");
    },
    getOrCreateOpenRouterKey: async (userId, userEmail) => {
      platformCalls.push({ userId, userEmail });
      return "or-platform-key";
    },
  });

  assertEquals(route.billingMode, "light");
  assertEquals(route.provider, "ultralight");
  assertEquals(route.upstreamProvider, "openrouter");
  assertEquals(route.baseUrl, BYOK_PROVIDERS.openrouter.baseUrl);
  assertEquals(route.apiKey, "or-platform-key");
  assertEquals(route.model, "openai/gpt-4o-mini");
  assertEquals(route.keySource, "platform_openrouter");
  assertEquals(route.billingSource, "openrouter");
  assertEquals(platformCalls, [{ userId: "user-1", userEmail: "auth@example.com" }]);
});

Deno.test("inference route: BYOK mode uses configured provider key and skips Light", async () => {
  const userService: RouteUserService = {
    getUser: async () =>
      makeUser({
        byok_enabled: true,
        byok_provider: "deepseek",
        byok_configs: [{
          provider: "deepseek",
          has_key: true,
          model: "deepseek-v4-pro",
          added_at: "2026-04-24T00:00:00Z",
        }],
      }),
    getDecryptedApiKey: async (_userId, provider) => {
      assertEquals(provider, "deepseek");
      return "ds-user-key";
    },
  };

  const route = await resolveInferenceRoute({
    userId: "user-1",
    userEmail: "auth@example.com",
    userService,
    getOrCreateOpenRouterKey: async () => {
      throw new Error("platform key should not be provisioned");
    },
  });

  assertEquals(route.billingMode, "byok");
  assertEquals(route.provider, "deepseek");
  assertEquals(route.upstreamProvider, "deepseek");
  assertEquals(route.baseUrl, BYOK_PROVIDERS.deepseek.baseUrl);
  assertEquals(route.apiKey, "ds-user-key");
  assertEquals(route.model, "deepseek-v4-pro");
  assertEquals(route.keySource, "user_byok");
  assertEquals(route.billingSource, "none");
  assertEquals(route.shouldRequireBalance, false);
  assertEquals(route.shouldDebitLight, false);
});

Deno.test("inference route: requested model overrides BYOK configured model", async () => {
  const userService: RouteUserService = {
    getUser: async () =>
      makeUser({
        byok_enabled: true,
        byok_provider: "nvidia",
        byok_configs: [{
          provider: "nvidia",
          has_key: true,
          model: "deepseek-ai/deepseek-v4-flash",
          added_at: "2026-04-24T00:00:00Z",
        }],
      }),
    getDecryptedApiKey: async () => "nv-user-key",
  };

  const route = await resolveInferenceRoute({
    userId: "user-1",
    userEmail: "auth@example.com",
    requestedModel: "minimaxai/minimax-m2.7",
    userService,
    getOrCreateOpenRouterKey: async () => {
      throw new Error("platform key should not be provisioned");
    },
  });

  assertEquals(route.provider, "nvidia");
  assertEquals(route.baseUrl, "https://integrate.api.nvidia.com/v1");
  assertEquals(route.model, "minimaxai/minimax-m2.7");
  assertEquals(route.shouldDebitLight, false);
});

Deno.test("inference route: explicit Light selection bypasses configured BYOK", async () => {
  const userService: RouteUserService = {
    getUser: async () =>
      makeUser({
        byok_enabled: true,
        byok_provider: "deepseek",
        byok_configs: [{
          provider: "deepseek",
          has_key: true,
          model: "deepseek-v4-pro",
          added_at: "2026-04-24T00:00:00Z",
        }],
      }),
    getDecryptedApiKey: async () => {
      throw new Error("BYOK key should not be read for explicit Light mode");
    },
  };

  const route = await resolveInferenceRoute({
    userId: "user-1",
    userEmail: "auth@example.com",
    requestedModel: "openai/gpt-4o-mini",
    selection: { billingMode: "light", model: "deepseek/deepseek-v4-flash" },
    userService,
    getPlatformApiKey: async () => "ds-platform-key",
    getOrCreateOpenRouterKey: async () => {
      throw new Error("OpenRouter key should not be provisioned for direct DeepSeek");
    },
  });

  assertEquals(route.billingMode, "light");
  assertEquals(route.provider, "ultralight");
  assertEquals(route.upstreamProvider, "deepseek");
  assertEquals(route.model, "deepseek-v4-flash");
  assertEquals(route.canonicalModelId, ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL);
  assertEquals(route.keySource, "platform_deepseek");
  assertEquals(route.billingSource, "platform_deepseek_direct");
  assertEquals(route.shouldRequireBalance, true);
  assertEquals(route.shouldDebitLight, true);
});

Deno.test("inference route: direct DeepSeek Light route fails clearly when platform key is missing", async () => {
  const error = await assertRejects(
    () =>
      resolveInferenceRoute({
        userId: "user-1",
        userEmail: "auth@example.com",
        requestedModel: ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
        userService: {
          getUser: async () => makeUser(),
          getDecryptedApiKey: async () => null,
        },
        getPlatformApiKey: async () => "",
        getOrCreateOpenRouterKey: async () => {
          throw new Error("No silent OpenRouter fallback");
        },
      }),
    InferenceRouteError,
    "DEEPSEEK_API_KEY is not configured",
  );

  assertEquals(error.code, "platform_key_unavailable");
  assertEquals(error.status, 503);
});

Deno.test("inference route: explicit BYOK provider selection uses that configured provider", async () => {
  const userService: RouteUserService = {
    getUser: async () =>
      makeUser({
        byok_enabled: true,
        byok_provider: "openai",
        byok_configs: [
          {
            provider: "openai",
            has_key: true,
            model: "gpt-4o-mini",
            added_at: "2026-04-24T00:00:00Z",
          },
          {
            provider: "nvidia",
            has_key: true,
            model: "deepseek-ai/deepseek-v4-flash",
            added_at: "2026-04-24T00:00:00Z",
          },
        ],
      }),
    getDecryptedApiKey: async (_userId, provider) => {
      assertEquals(provider, "nvidia");
      return "nv-user-key";
    },
  };

  const route = await resolveInferenceRoute({
    userId: "user-1",
    userEmail: "auth@example.com",
    selection: {
      billingMode: "byok",
      provider: "nvidia",
      model: "minimaxai/minimax-m2.7",
    },
    userService,
    getOrCreateOpenRouterKey: async () => {
      throw new Error("platform key should not be provisioned");
    },
  });

  assertEquals(route.billingMode, "byok");
  assertEquals(route.provider, "nvidia");
  assertEquals(route.apiKey, "nv-user-key");
  assertEquals(route.model, "minimaxai/minimax-m2.7");
  assertEquals(route.shouldRequireBalance, false);
  assertEquals(route.shouldDebitLight, false);
});

Deno.test("inference route: explicit BYOK provider must be configured", async () => {
  const error = await assertRejects(
    () =>
      resolveInferenceRoute({
        userId: "user-1",
        userEmail: "auth@example.com",
        selection: { billingMode: "byok", provider: "google" },
        userService: {
          getUser: async () =>
            makeUser({
              byok_enabled: true,
              byok_provider: "openai",
              byok_configs: [{
                provider: "openai",
                has_key: true,
                model: "gpt-4o-mini",
                added_at: "2026-04-24T00:00:00Z",
              }],
            }),
          getDecryptedApiKey: async () => null,
        },
        getOrCreateOpenRouterKey: async () => "or-platform-key",
      }),
    InferenceRouteError,
    "BYOK provider google is not configured",
  );

  assertEquals(error.code, "byok_provider_not_configured");
  assertEquals(error.status, 409);
});

Deno.test("inference route: BYOK mode fails closed when the configured key is missing", async () => {
  const userService: RouteUserService = {
    getUser: async () =>
      makeUser({
        byok_enabled: true,
        byok_provider: "xai",
        byok_configs: [{
          provider: "xai",
          has_key: true,
          model: "grok-4.20-reasoning",
          added_at: "2026-04-24T00:00:00Z",
        }],
      }),
    getDecryptedApiKey: async () => null,
  };
  let platformCalled = false;

  const error = await assertRejects(
    () =>
      resolveInferenceRoute({
        userId: "user-1",
        userEmail: "auth@example.com",
        userService,
        getOrCreateOpenRouterKey: async () => {
          platformCalled = true;
          return "or-platform-key";
        },
      }),
    InferenceRouteError,
    "BYOK is enabled for xai",
  );

  assertEquals(error.code, "byok_key_missing");
  assertEquals(error.status, 409);
  assertEquals(platformCalled, false);
});

Deno.test("inference route: legacy BYOK provider state falls back to Light mode", async () => {
  const userService: RouteUserService = {
    getUser: async () =>
      makeUser({
        byok_enabled: true,
        byok_provider: "anthropic",
        byok_configs: [],
      }),
    getDecryptedApiKey: async () => {
      throw new Error("legacy BYOK key should not be read");
    },
  };

  const route = await resolveInferenceRoute({
    userId: "user-1",
    userEmail: "auth@example.com",
    userService,
    getPlatformApiKey: async () => "ds-platform-key",
    getOrCreateOpenRouterKey: async () => {
      throw new Error("OpenRouter key should not be provisioned for default Ultralight route");
    },
  });

  assertEquals(route.billingMode, "light");
  assertEquals(route.provider, "ultralight");
  assertEquals(route.upstreamProvider, "deepseek");
  assertEquals(route.model, "deepseek-v4-flash");
  assertEquals(route.canonicalModelId, ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL);
  assertEquals(route.shouldRequireBalance, true);
  assertEquals(route.shouldDebitLight, true);
});

Deno.test("inference route: missing user returns typed route error", async () => {
  const error = await assertRejects(
    () =>
      resolveInferenceRoute({
        userId: "missing-user",
        userEmail: "auth@example.com",
        userService: {
          getUser: async () => null,
          getDecryptedApiKey: async () => null,
        },
        getOrCreateOpenRouterKey: async () => "or-platform-key",
      }),
    InferenceRouteError,
    "User not found",
  );

  assertEquals(error.code, "user_not_found");
  assertEquals(error.status, 404);
});
