import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import { decryptApiKey, encryptApiKey } from "./api-key-crypto.ts";
import {
  getStoredOpenRouterKey,
  storeOpenRouterKey,
} from "./openrouter-keys.ts";
import { createUserService } from "./user.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  BYOK_ENCRYPTION_KEY: "1234567890abcdef1234567890abcdef",
};

let testQueue = Promise.resolve();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runSerial(fn: () => Promise<void>): Promise<void> {
  const run = testQueue.then(fn, fn);
  testQueue = run.catch(() => {});
  await run;
}

async function withMockedEnvAndFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  const previousFetch = globalThis.fetch;

  globalWithEnv.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  };
  globalThis.fetch = handler as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
}

Deno.test("OpenRouter keys: decrypts encrypted platform-managed entries", async () => {
  await runSerial(async () => {
    let encryptedKey = "";
    const methods: string[] = [];

    await withMockedEnvAndFetch(async (_input, init) => {
      methods.push(init?.method || "GET");
      return jsonResponse([{
        byok_keys: {
          _platform_openrouter: {
            encrypted_key: encryptedKey,
            added_at: "2026-04-16T00:00:00Z",
            provisioned_at: "2026-04-16T00:00:00Z",
            managed_by_platform: true,
          },
        },
      }]);
    }, async () => {
      encryptedKey = await encryptApiKey("or-encrypted-key");
      const key = await getStoredOpenRouterKey("user-1");
      assertEquals(key, "or-encrypted-key");
    });

    assertEquals(methods, ["GET"]);
  });
});

Deno.test("OpenRouter keys: auto-migrates legacy plaintext entries to encrypted on read", async () => {
  await runSerial(async () => {
    const methods: string[] = [];
    let patchBody: Record<string, unknown> | null = null;

    await withMockedEnvAndFetch(async (_input, init) => {
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "PATCH") {
        patchBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }

      return jsonResponse([{
        byok_keys: {
          openai: {
            encrypted_key: "keep-existing-provider",
            added_at: "2026-04-01T00:00:00Z",
          },
          _platform_openrouter: {
            key: "or-legacy-key",
            provisioned_at: "2026-04-15T00:00:00Z",
          },
        },
      }]);
    }, async () => {
      // Returns the usable key AND migrates it to encrypted at rest. Assert
      // inside the mocked-env block so decryptApiKey can read BYOK_ENCRYPTION_KEY.
      const key = await getStoredOpenRouterKey("user-1");
      assertEquals(key, "or-legacy-key");

      assertEquals(methods, ["GET", "PATCH"]);
      assert(patchBody !== null);
      const byokKeys = (patchBody as {
        byok_keys: Record<string, Record<string, unknown>>;
      }).byok_keys;
      const migrated = byokKeys._platform_openrouter;
      assertEquals(typeof migrated.key, "undefined");
      assertEquals(migrated.managed_by_platform, true);
      assertEquals(
        await decryptApiKey(migrated.encrypted_key as string),
        "or-legacy-key",
      );
      // The migration merge preserves other providers' keys untouched.
      assertEquals(byokKeys.openai.encrypted_key, "keep-existing-provider");
    });
  });
});

Deno.test("OpenRouter keys: storeOpenRouterKey persists encrypted platform-managed entry", async () => {
  await runSerial(async () => {
    let patchBody: Record<string, unknown> | null = null;

    await withMockedEnvAndFetch(async (_input, init) => {
      const method = init?.method || "GET";
      if (method === "PATCH") {
        patchBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }

      return jsonResponse([{
        byok_keys: {
          anthropic: {
            encrypted_key: "existing-anthropic-key",
            added_at: "2026-04-01T00:00:00Z",
          },
        },
      }]);
    }, async () => {
      await storeOpenRouterKey("user-1", "or-new-platform-key");
      assert(patchBody !== null);
      const body = patchBody as {
        byok_keys: Record<string, Record<string, unknown>>;
      };
      const byokKeys = body.byok_keys;
      const storedEntry = byokKeys._platform_openrouter;
      assert(storedEntry !== undefined);
      assertEquals(typeof storedEntry.key, "undefined");
      assertEquals(storedEntry.managed_by_platform, true);
      assertEquals(
        await decryptApiKey(storedEntry.encrypted_key as string),
        "or-new-platform-key",
      );
      assertEquals(byokKeys.anthropic.encrypted_key, "existing-anthropic-key");
    });
  });
});

Deno.test("User service: hides internal platform-managed key from byok_configs", async () => {
  await runSerial(async () => {
    let openrouterKey = "";
    let platformKey = "";

    await withMockedEnvAndFetch(async () =>
      jsonResponse([{
        id: "user-1",
        email: "user@example.com",
        display_name: null,
        avatar_url: null,
        tier: "free",
        country: null,
        featured_app_id: null,
        profile_slug: null,
        byok_enabled: true,
        byok_provider: "openrouter",
        byok_keys: {
          openrouter: {
            encrypted_key: openrouterKey,
            model: "anthropic/claude-sonnet-4",
            added_at: "2026-04-10T00:00:00Z",
          },
          _platform_openrouter: {
            encrypted_key: platformKey,
            added_at: "2026-04-11T00:00:00Z",
            provisioned_at: "2026-04-11T00:00:00Z",
            managed_by_platform: true,
          },
        },
      }]), async () => {
      openrouterKey = await encryptApiKey("or-user-key");
      platformKey = await encryptApiKey("or-platform-key");
      const user = await createUserService().getUser("user-1");
      assert(user !== null);
      assertEquals(user.byok_configs.length, 1);
      assertEquals(user.byok_configs[0].provider, "openrouter");
      assertEquals(user.byok_configs[0].has_key, true);
      assertEquals(user.byok_configs[0].model, "anthropic/claude-sonnet-4");
    });
  });
});

Deno.test("User service: internal platform key does not count as BYOK-enabled state", async () => {
  await runSerial(async () => {
    let platformKey = "";

    await withMockedEnvAndFetch(async () =>
      jsonResponse([{
        id: "user-1",
        email: "user@example.com",
        display_name: null,
        avatar_url: null,
        tier: "free",
        country: null,
        featured_app_id: null,
        profile_slug: null,
        byok_enabled: true,
        byok_provider: "_platform_openrouter",
        byok_keys: {
          _platform_openrouter: {
            encrypted_key: platformKey,
            added_at: "2026-04-11T00:00:00Z",
            provisioned_at: "2026-04-11T00:00:00Z",
            managed_by_platform: true,
          },
        },
      }]), async () => {
      platformKey = await encryptApiKey("or-platform-key");
      const user = await createUserService().getUser("user-1");
      assert(user !== null);
      assertEquals(user.byok_enabled, false);
      assertEquals(user.byok_provider, null);
      assertEquals(user.byok_configs.length, 0);
    });
  });
});

Deno.test("User service: active provider rows without encrypted keys are not usable BYOK state", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(async () =>
      jsonResponse([{
        id: "user-1",
        email: "user@example.com",
        display_name: null,
        avatar_url: null,
        tier: "free",
        country: null,
        featured_app_id: null,
        profile_slug: null,
        byok_enabled: true,
        byok_provider: "openai",
        byok_keys: {
          openai: {
            model: "gpt-4o-mini",
            added_at: "2026-04-11T00:00:00Z",
          },
        },
      }]), async () => {
      const user = await createUserService().getUser("user-1");
      assert(user !== null);
      assertEquals(user.byok_enabled, false);
      assertEquals(user.byok_provider, null);
      assertEquals(user.byok_configs.length, 1);
      assertEquals(user.byok_configs[0].provider, "openai");
      assertEquals(user.byok_configs[0].has_key, false);
    });
  });
});

Deno.test("User service: primary provider requires an encrypted key", async () => {
  await runSerial(async () => {
    let patchCalled = false;

    await withMockedEnvAndFetch(async (_input, init) => {
      if ((init?.method || "GET") === "PATCH") {
        patchCalled = true;
        return new Response(null, { status: 204 });
      }
      return jsonResponse([{
        byok_keys: {
          openai: {
            model: "gpt-4o-mini",
            added_at: "2026-04-11T00:00:00Z",
          },
        },
      }]);
    }, async () => {
      await assertRejects(
        () => createUserService().setPrimaryProvider("user-1", "openai"),
        Error,
        "Provider openai not configured",
      );
    });

    assertEquals(patchCalled, false);
  });
});

Deno.test("User service: updating a stale provider row requires a replacement key", async () => {
  await runSerial(async () => {
    let patchCalled = false;

    await withMockedEnvAndFetch(async (_input, init) => {
      if ((init?.method || "GET") === "PATCH") {
        patchCalled = true;
        return new Response(null, { status: 204 });
      }
      return jsonResponse([{
        byok_keys: {
          openai: {
            model: "gpt-4o-mini",
            added_at: "2026-04-11T00:00:00Z",
          },
        },
      }]);
    }, async () => {
      await assertRejects(
        () => createUserService().updateBYOKProvider("user-1", "openai", {
          model: "gpt-4o",
        }),
        Error,
        "Provider openai not configured",
      );
    });

    assertEquals(patchCalled, false);
  });
});

Deno.test("User service: replacing a stale provider key makes the row usable", async () => {
  await runSerial(async () => {
    let patchBody: Record<string, unknown> | null = null;

    await withMockedEnvAndFetch(async (_input, init) => {
      if ((init?.method || "GET") === "PATCH") {
        patchBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }
      return jsonResponse([{
        byok_keys: {
          openai: {
            model: "gpt-4o-mini",
            added_at: "2026-04-11T00:00:00Z",
          },
        },
      }]);
    }, async () => {
      const config = await createUserService().updateBYOKProvider("user-1", "openai", {
        apiKey: "  sk-new-openai-key  ",
        model: "gpt-4o",
      });

      assertEquals(config.has_key, true);
      assertEquals(config.model, "gpt-4o");
      assert(patchBody !== null);
      const byokKeys = (patchBody as {
        byok_keys: Record<string, Record<string, unknown>>;
      }).byok_keys;
      assertEquals(
        await decryptApiKey(byokKeys.openai.encrypted_key as string),
        "sk-new-openai-key",
      );
    });
  });
});

Deno.test("User service: BYOK writes surface persistence failures", async () => {
  await runSerial(async () => {
    let encryptedKey = "";

    await withMockedEnvAndFetch(async (_input, init) => {
      if ((init?.method || "GET") === "PATCH") {
        return new Response("database unavailable", { status: 503 });
      }
      return jsonResponse([{
        byok_keys: {
          openai: {
            encrypted_key: encryptedKey,
            model: "gpt-4o-mini",
            added_at: "2026-04-11T00:00:00Z",
          },
        },
      }]);
    }, async () => {
      encryptedKey = await encryptApiKey("sk-existing-openai-key");
      await assertRejects(
        () => createUserService().updateBYOKProvider("user-1", "openai", {
          model: "gpt-4o",
        }),
        Error,
        "Failed to update BYOK provider: database unavailable",
      );
    });
  });
});

Deno.test("User service: legacy BYOK providers are ignored without breaking hydration", async () => {
  await runSerial(async () => {
    let anthropicKey = "";

    await withMockedEnvAndFetch(async () =>
      jsonResponse([{
        id: "user-1",
        email: "user@example.com",
        display_name: null,
        avatar_url: null,
        tier: "free",
        country: null,
        featured_app_id: null,
        profile_slug: null,
        byok_enabled: true,
        byok_provider: "anthropic",
        byok_keys: {
          anthropic: {
            encrypted_key: anthropicKey,
            model: "claude-3-5-sonnet-latest",
            added_at: "2026-04-10T00:00:00Z",
          },
        },
      }]), async () => {
      anthropicKey = await encryptApiKey("anthropic-legacy-key");
      const user = await createUserService().getUser("user-1");
      assert(user !== null);
      assertEquals(user.byok_enabled, false);
      assertEquals(user.byok_provider, null);
      assertEquals(user.byok_configs.length, 0);
    });
  });
});
