import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import {
  CHAT_MIN_BALANCE_LIGHT,
  CHAT_PLATFORM_MARKUP,
} from "../../shared/contracts/ai.ts";
import {
  ACTIVE_BYOK_PROVIDER_IDS,
  BYOK_PROVIDERS,
} from "../../shared/types/index.ts";
import type { UserProfile, UserService } from "./user.ts";
import { buildInferenceOptions } from "./inference-options.ts";

type OptionsUserService = Pick<UserService, "getUser">;

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

Deno.test("inference options: Light-only account exposes provider registry and balance state", async () => {
  const userService: OptionsUserService = {
    getUser: async () => makeUser(),
  };

  const options = await buildInferenceOptions({
    userId: "user-1",
    userService,
    checkBalance: async () => 42,
  });

  assertEquals(options.defaultBillingMode, "light");
  assertEquals(options.selected, {
    billingMode: "light",
    provider: "openrouter",
    model: BYOK_PROVIDERS.openrouter.defaultModel,
    webSearchEnabled: false,
  });
  assertEquals(options.light.balanceLight, 42);
  assertEquals(options.light.minimumBalanceLight, CHAT_MIN_BALANCE_LIGHT);
  assertEquals(options.light.usable, false);
  assertEquals(options.light.markup, CHAT_PLATFORM_MARKUP);
  assertEquals(options.configuredProviderIds, []);
  assertEquals(options.providers.map((provider) => provider.id), [...ACTIVE_BYOK_PROVIDER_IDS]);
  assert(options.providers.every((provider) => provider.protocol === "openai-compatible"));
  assert(options.providers.every((provider) => provider.configured === false));
});

Deno.test("inference options: configured BYOK account selects primary provider", async () => {
  const userService: OptionsUserService = {
    getUser: async () =>
      makeUser({
        byok_enabled: true,
        byok_provider: "nvidia",
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
            model: "minimaxai/minimax-m2.7",
            added_at: "2026-04-25T00:00:00Z",
          },
        ],
      }),
  };

  const options = await buildInferenceOptions({
    userId: "user-1",
    userService,
    checkBalance: async () => 500,
  });

  assertEquals(options.defaultBillingMode, "byok");
  assertEquals(options.selected, {
    billingMode: "byok",
    provider: "nvidia",
    model: "minimaxai/minimax-m2.7",
    webSearchEnabled: false,
  });
  assertEquals(options.light.usable, true);
  assertEquals(options.configuredProviderIds, ["openai", "nvidia"]);

  const nvidia = options.providers.find((provider) => provider.id === "nvidia");
  assert(nvidia);
  assertEquals(nvidia.configured, true);
  assertEquals(nvidia.primary, true);
  assertEquals(nvidia.configuredModel, "minimaxai/minimax-m2.7");
  assertEquals(nvidia.addedAt, "2026-04-25T00:00:00Z");

  const anthropic = options.providers.find((provider) => (provider.id as string) === "anthropic");
  assertEquals(anthropic, undefined);
});

Deno.test("inference options: balance failures do not hide BYOK choices", async () => {
  const options = await buildInferenceOptions({
    userId: "user-1",
    userService: {
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
    },
    checkBalance: async () => {
      throw new Error("balance backend unavailable");
    },
  });

  assertEquals(options.defaultBillingMode, "byok");
  assertEquals(options.light.balanceLight, null);
  assertEquals(options.light.usable, false);
  assertEquals(options.light.unavailableReason, "balance backend unavailable");
  assertEquals(options.selected.provider, "deepseek");
});

Deno.test("inference options: stale provider rows without keys are not selectable", async () => {
  const options = await buildInferenceOptions({
    userId: "user-1",
    userService: {
      getUser: async () =>
        makeUser({
          byok_enabled: true,
          byok_provider: "openai",
          byok_configs: [
            {
              provider: "openai",
              has_key: false,
              model: "gpt-4o-mini",
              added_at: "2026-04-24T00:00:00Z",
            },
            {
              provider: "deepseek",
              has_key: true,
              model: "deepseek-v4-pro",
              added_at: "2026-04-25T00:00:00Z",
            },
          ],
        }),
    },
    checkBalance: async () => 500,
  });

  assertEquals(options.defaultBillingMode, "byok");
  assertEquals(options.selected.provider, "deepseek");
  assertEquals(options.configuredProviderIds, ["deepseek"]);

  const openai = options.providers.find((provider) => provider.id === "openai");
  assert(openai);
  assertEquals(openai.configured, false);
  assertEquals(openai.primary, false);
  assertEquals(openai.configuredModel, null);
});
