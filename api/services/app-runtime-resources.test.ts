import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  buildMissingAppSecretsErrorDetails,
  buildMissingAppSecretsMessage,
  classifyAppSupabaseConfigState,
  createAppD1Resources,
  fetchAppEntryCode,
  resolveAppRuntimeEnvVars,
  resolveAppD1StorageDisclosure,
  resolveAppSupabaseConfig,
  resolveManifestPermissions,
  resolveRuntimeAppCallDependencies,
  resolveStrictManifestPermissions,
  resolveWidgetAppCallDependencies,
  SupabaseConfigMigrationRequiredError,
} from "./app-runtime-resources.ts";

Deno.test("app runtime resources: entry code fetch checks cache before probing R2", async () => {
  const calls: string[] = [];
  const cache = {
    get: () => "cached-code",
    set: () => {
      throw new Error("cache set should not run on cache hit");
    },
  };

  const code = await fetchAppEntryCode(
    { id: "app-123", storage_key: "apps/app-123/current/" } as {
      id: string;
      storage_key: string;
    },
    {
      codeCache: cache,
      r2Service: {
        fetchTextFile: async (path: string) => {
          calls.push(path);
          return "from-r2";
        },
      } as unknown as ReturnType<typeof import("./storage.ts").createR2Service>,
    },
  );

  assertEquals(code, "cached-code");
  assertEquals(calls.length, 0);
});

Deno.test("app runtime resources: entry code fetch probes supported files and caches the first hit", async () => {
  const visited: string[] = [];
  let cached: string | null = null;

  const code = await fetchAppEntryCode(
    { id: "app-123", storage_key: "apps/app-123/current/" } as {
      id: string;
      storage_key: string;
    },
    {
      codeCache: {
        get: () => null,
        set: (_appId, _storageKey, value) => {
          cached = value;
        },
      },
      r2Service: {
        fetchTextFile: async (path: string) => {
          visited.push(path);
          if (path.endsWith("index.ts")) {
            return "export const ok = true;";
          }
          throw new Error("missing");
        },
      } as unknown as ReturnType<typeof import("./storage.ts").createR2Service>,
    },
  );

  assertEquals(visited, [
    "apps/app-123/current/index.tsx",
    "apps/app-123/current/index.ts",
  ]);
  assertEquals(code, "export const ok = true;");
  assertEquals(cached, "export const ok = true;");
});

Deno.test("app runtime resources: secret/config split — secrets vaulted, per-user config readable (3b)", async () => {
  const fetchCalls: string[] = [];

  const result = await resolveAppRuntimeEnvVars(
    {
      id: "app-123",
      env_vars: {
        APP_ONLY: "enc-app-only",
        APP_REGION: "enc-app-shared",
      },
      env_schema: {
        USER_TOKEN: { scope: "per_user", input: "password", required: true },
        APP_REGION: { scope: "per_user", required: false },
        APP_ONLY: { scope: "universal", required: false },
      },
      manifest: null,
    },
    "user-123",
    {
      decryptEnvVarsFn: async (envVars) =>
        Object.fromEntries(
          Object.entries(envVars).map(([key, value]) => [key, `app:${value}`]),
        ),
      decryptEnvVarFn: async (value: string) => `user:${value}`,
      fetchFn: async (input) => {
        fetchCalls.push(String(input));
        return new Response(
          JSON.stringify([
            { key: "USER_TOKEN", value_encrypted: "enc-user-token" },
            { key: "APP_REGION", value_encrypted: "enc-user-override" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      supabaseUrl: "https://supabase.example",
      supabaseServiceRoleKey: "service-role",
    },
  );

  assertEquals(fetchCalls, [
    "https://supabase.example/rest/v1/user_app_secrets?user_id=eq.user-123&app_id=eq.app-123&select=key,value_encrypted",
  ]);
  // Secret/config split (3b): the SECRET (input:password) is vaulted only; the
  // non-secret per-user CONFIG (APP_REGION) is ALSO readable in the sandbox env
  // (user value overrides the app default). Universal vars are readable as always.
  assertEquals(result.envVars, {
    APP_ONLY: "app:enc-app-only",
    APP_REGION: "user:enc-user-override",
  });
  // ALL per-user values are resolvable host-side by key (net.* + CredentialBinding);
  // the SECRET (USER_TOKEN) exists ONLY here — never in envVars above.
  assertEquals(result.credentials, {
    USER_TOKEN: { value: "user:enc-user-token", credential: undefined },
    APP_REGION: { value: "user:enc-user-override", credential: undefined },
  });
  assertEquals(result.missingRequiredSecrets, []);
});

Deno.test("app runtime resources: runtime env reports missing required per-user secrets", async () => {
  const result = await resolveAppRuntimeEnvVars(
    {
      id: "app-123",
      env_vars: {},
      env_schema: {
        USER_TOKEN: { scope: "per_user", required: true },
        OPTIONAL_TOKEN: { scope: "per_user", required: false },
      },
      manifest: null,
    },
    "user-123",
    {
      decryptEnvVarsFn: async () => ({}),
      fetchFn: async () => new Response(JSON.stringify([]), { status: 200 }),
      supabaseUrl: "https://supabase.example",
      supabaseServiceRoleKey: "service-role",
    },
  );

  assertEquals(result.envVars, {});
  assertEquals(result.missingRequiredSecrets, ["USER_TOKEN"]);
  assertEquals(
    buildMissingAppSecretsMessage(result.missingRequiredSecrets),
    "Missing required secrets: USER_TOKEN. Use gx.secrets to provide them.",
  );
  assertEquals(
    buildMissingAppSecretsErrorDetails(
      "app-123",
      result.missingRequiredSecrets,
    ),
    {
      type: "MISSING_SECRETS",
      state: "action_required",
      missing_secrets: ["USER_TOKEN"],
      app_id: "app-123",
      message:
        "Per-user settings are incomplete. Missing required keys: USER_TOKEN.",
      remediation:
        "Provide the missing secrets with gx.secrets before running the app.",
      hint: 'Call gx.secrets with app_id="app-123" and provide: USER_TOKEN',
      connect_command:
        'gx.secrets({ app_id: "app-123", secrets: {"USER_TOKEN":"<USER_TOKEN>"} })',
    },
  );
});

Deno.test("app runtime resources: universal credentials stay parent-side and are never injected", async () => {
  const credential = {
    destination: "archive.example.com",
    inject: {
      as: "header" as const,
      name: "Authorization",
      prefix: "Bearer ",
    },
  };
  const result = await resolveAppRuntimeEnvVars(
    {
      id: "app-123",
      env_vars: {
        ARCHIVE_TOKEN: "enc-token",
        REGION: "enc-region",
      },
      env_schema: {
        ARCHIVE_TOKEN: {
          scope: "universal",
          required: true,
          credential,
        },
        REGION: { scope: "universal", required: true },
      },
      manifest: null,
    },
    "user-123",
    {
      decryptEnvVarsFn: async (values) =>
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, `plain:${value}`]),
        ),
      fetchFn: async () => new Response(JSON.stringify([]), { status: 200 }),
      supabaseUrl: "https://supabase.example",
      supabaseServiceRoleKey: "service-role",
    },
  );

  assertEquals(result.envVars, { REGION: "plain:enc-region" });
  assertEquals(result.credentials, {
    ARCHIVE_TOKEN: { value: "plain:enc-token", credential },
  });
  assertEquals(result.missingRequiredSecrets, []);
});

Deno.test("app runtime resources: undecryptable required universal settings fail closed", async () => {
  const result = await resolveAppRuntimeEnvVars(
    {
      id: "app-123",
      env_vars: { REQUIRED_SETTING: "malformed-ciphertext" },
      env_schema: {
        REQUIRED_SETTING: { scope: "universal", required: true },
      },
      manifest: null,
    },
    "user-123",
    {
      decryptEnvVarsFn: async () => {
        throw new Error("cannot decrypt");
      },
      fetchFn: async () => new Response(JSON.stringify([]), { status: 200 }),
      supabaseUrl: "https://supabase.example",
      supabaseServiceRoleKey: "service-role",
      logger: { error: () => undefined },
    },
  );

  assertEquals(result.envVars, {});
  assertEquals(result.credentials, {});
  assertEquals(result.missingRequiredSecrets, ["REQUIRED_SETTING"]);
});

Deno.test("app runtime resources: undeclared dormant secret rows never enter runtime bindings", async () => {
  const decrypted: string[] = [];
  const result = await resolveAppRuntimeEnvVars(
    {
      id: "app-123",
      env_vars: {},
      env_schema: {
        ACTIVE_TOKEN: {
          scope: "per_user",
          input: "password",
          required: true,
        },
      },
      manifest: null,
    },
    "user-123",
    {
      decryptEnvVarsFn: async () => ({}),
      decryptEnvVarFn: async (value: string) => {
        decrypted.push(value);
        return `plain:${value}`;
      },
      fetchFn: async () =>
        new Response(
          JSON.stringify([
            { key: "ACTIVE_TOKEN", value_encrypted: "active" },
            { key: "REMOVED_TOKEN", value_encrypted: "dormant" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      supabaseUrl: "https://supabase.example",
      supabaseServiceRoleKey: "service-role",
    },
  );

  assertEquals(decrypted, ["active"]);
  assertEquals(result.credentials, {
    ACTIVE_TOKEN: { value: "plain:active", credential: undefined },
  });
  assertEquals(result.envVars, {});
  assertEquals(result.missingRequiredSecrets, []);
});

Deno.test("app runtime resources: Supabase config prefers config_id before legacy fallbacks", async () => {
  const calls: string[] = [];
  const telemetry: Array<Record<string, unknown>> = [];
  const config = await resolveAppSupabaseConfig(
    {
      id: "app-123",
      owner_id: "owner-123",
      supabase_config_id: "cfg-123",
      supabase_enabled: true,
      supabase_url: "https://legacy.example",
      supabase_anon_key_encrypted: "legacy-anon",
      supabase_service_key_encrypted: "legacy-service",
    },
    {
      getDecryptedSupabaseConfigFn: async (configId: string) => {
        calls.push(`config:${configId}`);
        return { url: "https://managed.example", anonKey: "managed-anon" };
      },
      getDecryptedPlatformSupabaseFn: async () => {
        calls.push("platform");
        return { url: "https://platform.example", anonKey: "platform-anon" };
      },
      decryptEnvVarFn: async (value: string) => `dec:${value}`,
      logAppSupabaseResolutionFn: (entry) => {
        telemetry.push({
          app_id: entry.appId,
          owner_id: entry.ownerId,
          source: entry.source,
          note: entry.note ?? null,
        });
      },
    },
  );

  assertEquals(calls, ["config:cfg-123"]);
  assertEquals(config, {
    url: "https://managed.example",
    anonKey: "managed-anon",
  });
  assertEquals(telemetry, [
    {
      app_id: "app-123",
      owner_id: "owner-123",
      source: "saved_config",
      note: null,
    },
  ]);
});

Deno.test("app runtime resources: Supabase config telemetry records legacy app config fallback", async () => {
  const telemetry: Array<Record<string, unknown>> = [];

  const config = await resolveAppSupabaseConfig(
    {
      id: "app-legacy",
      owner_id: "owner-123",
      supabase_config_id: "cfg-missing",
      supabase_enabled: true,
      supabase_url: "https://legacy.example",
      supabase_anon_key_encrypted: "legacy-anon",
      supabase_service_key_encrypted: null,
    },
    {
      allowLegacyAppConfig: true,
      getDecryptedSupabaseConfigFn: async () => null,
      getDecryptedPlatformSupabaseFn: async () => {
        throw new Error(
          "platform fallback should not run once legacy config resolves",
        );
      },
      decryptEnvVarFn: async (value: string) => `dec:${value}`,
      logAppSupabaseResolutionFn: (entry) => {
        telemetry.push({
          app_id: entry.appId,
          source: entry.source,
          note: entry.note ?? null,
        });
      },
    },
  );

  assertEquals(config, {
    url: "https://legacy.example",
    anonKey: "dec:legacy-anon",
  });
  assertEquals(telemetry, [
    {
      app_id: "app-legacy",
      source: "legacy_app_config",
      note: "saved_config_missing",
    },
  ]);
});

Deno.test("app runtime resources: canonical runtime rejects legacy app config fallback", async () => {
  const telemetry: Array<Record<string, unknown>> = [];

  await assertRejects(
    () =>
      resolveAppSupabaseConfig(
        {
          id: "app-legacy",
          owner_id: "owner-123",
          supabase_config_id: null,
          supabase_enabled: true,
          supabase_url: "https://legacy.example",
          supabase_anon_key_encrypted: "legacy-anon",
          supabase_service_key_encrypted: null,
        },
        {
          logAppSupabaseResolutionFn: (entry) => {
            telemetry.push({
              app_id: entry.appId,
              source: entry.source,
              note: entry.note ?? null,
            });
          },
        },
      ),
    SupabaseConfigMigrationRequiredError,
    "legacy app-level Supabase credentials",
  );

  assertEquals(telemetry, [
    {
      app_id: "app-legacy",
      source: "none",
      note: "legacy_app_config_disabled,platform_default_disabled",
    },
  ]);
});

Deno.test("app runtime resources: canonical runtime rejects platform-default fallback", async () => {
  const telemetry: Array<Record<string, unknown>> = [];

  await assertRejects(
    () =>
      resolveAppSupabaseConfig(
        {
          id: "app-platform",
          owner_id: "owner-123",
          supabase_config_id: null,
          supabase_enabled: true,
          supabase_url: null,
          supabase_anon_key_encrypted: null,
          supabase_service_key_encrypted: null,
        },
        {
          logAppSupabaseResolutionFn: (entry) => {
            telemetry.push({
              app_id: entry.appId,
              source: entry.source,
              note: entry.note ?? null,
            });
          },
        },
      ),
    SupabaseConfigMigrationRequiredError,
    "deprecated default Supabase server",
  );

  assertEquals(telemetry, [
    {
      app_id: "app-platform",
      source: "none",
      note: "legacy_app_config_unavailable,platform_default_disabled",
    },
  ]);
});

Deno.test("app runtime resources: classify Supabase config state matches migration surfaces", () => {
  assertEquals(
    classifyAppSupabaseConfigState({
      supabase_config_id: "cfg-123",
      supabase_enabled: true,
      supabase_url: null,
      supabase_anon_key_encrypted: null,
    }),
    "saved_config",
  );
  assertEquals(
    classifyAppSupabaseConfigState({
      supabase_config_id: null,
      supabase_enabled: false,
      supabase_url: null,
      supabase_anon_key_encrypted: null,
    }),
    "disabled",
  );
  assertEquals(
    classifyAppSupabaseConfigState({
      supabase_config_id: null,
      supabase_enabled: true,
      supabase_url: "https://legacy.example",
      supabase_anon_key_encrypted: "enc",
    }),
    "legacy_app_config",
  );
  assertEquals(
    classifyAppSupabaseConfigState({
      supabase_config_id: null,
      supabase_enabled: true,
      supabase_url: null,
      supabase_anon_key_encrypted: null,
    }),
    "platform_default",
  );
});

Deno.test("app runtime resources: manifest permissions only admit allowlisted runtime expansions", () => {
  const permissions = resolveManifestPermissions(
    {
      manifest: JSON.stringify({
        permissions: ["net:connect", "ai:call", "fs:write"],
      }),
    },
    ["memory:read", "net:fetch"],
  );

  assertEquals(permissions, ["memory:read", "net:fetch", "net:connect"]);
});

Deno.test("app runtime resources: strict manifest permissions only grant declared runtime capabilities", () => {
  const resolution = resolveStrictManifestPermissions({
    manifest: JSON.stringify({
      permissions: ["ai:call", "storage:read", "net:connect", "unknown:scope"],
    }),
  });

  assertEquals(resolution.manifestBacked, true);
  assertEquals(resolution.permissions, [
    "ai:call",
    "storage:read",
    "net:connect",
  ]);
  assertEquals(resolution.ignoredPermissions, ["unknown:scope"]);
});

Deno.test("app runtime resources: widget dependencies become read-only app call grants", () => {
  const dependencies = resolveWidgetAppCallDependencies({
    manifest: JSON.stringify({
      widgets: [
        {
          id: "overview",
          label: "Overview",
          dependencies: [
            { app: "email-ops", functions: ["listDrafts"], access: "read" },
          ],
          cards: [
            {
              id: "queue",
              label: "Queue",
              size: "2x1",
              dependencies: [
                { app: "email-ops", functions: ["getDraft", "listDrafts"] },
                { app: "github-mcp", functions: ["listPRs"], access: "write" },
              ],
            },
          ],
        },
      ],
    }),
  });

  assertEquals(dependencies, [
    {
      app: "email-ops",
      functions: ["getDraft", "listDrafts"],
      access: "read",
    },
  ]);
});

Deno.test("app runtime resources: manifest external_functions become app call grants", () => {
  const dependencies = resolveRuntimeAppCallDependencies({
    manifest: JSON.stringify({
      external_functions: [
        { app: "email-ops", functions: ["listDrafts", "getDraft"] },
        { app: "crm", functions: ["logLead"], access: "write" },
        { app: "", functions: ["ignored"] },
        { app: "bad-entry", functions: [] },
      ],
    }),
  });

  assertEquals(dependencies, [
    {
      app: "crm",
      functions: ["logLead"],
      access: "write",
    },
    {
      app: "email-ops",
      functions: ["getDraft", "listDrafts"],
      access: "read",
    },
  ]);
});

Deno.test("app runtime resources: external_functions merge with widget dependencies", () => {
  const dependencies = resolveRuntimeAppCallDependencies({
    manifest: JSON.stringify({
      external_functions: [
        { app: "email-ops", functions: ["sendDraft"], access: "write" },
      ],
      widgets: [
        {
          id: "overview",
          label: "Overview",
          dependencies: [
            { app: "email-ops", functions: ["listDrafts"], access: "read" },
          ],
        },
      ],
    }),
  });

  assertEquals(dependencies, [
    {
      app: "email-ops",
      functions: ["listDrafts"],
      access: "read",
    },
    {
      app: "email-ops",
      functions: ["sendDraft"],
      access: "write",
    },
  ]);
});

Deno.test("app runtime resources: runtime dependencies include routine actor capability grants", () => {
  const dependencies = resolveRuntimeAppCallDependencies(
    {
      manifest: JSON.stringify({
        widgets: [
          {
            id: "overview",
            label: "Overview",
            dependencies: [
              { app: "email-ops", functions: ["listDrafts"] },
            ],
          },
        ],
      }),
    },
    {
      routineActor: {
        capabilities: [
          {
            app_id: "crm-app-id",
            app_ref: "crm",
            function_name: "logLead",
            access: "write",
          },
          {
            app_id: null,
            app_ref: "email-ops",
            function_name: "getDraft",
            access: "read",
          },
        ],
      },
    },
  );

  assertEquals(dependencies, [
    {
      app: "crm",
      functions: ["logLead"],
      access: "write",
    },
    {
      app: "crm-app-id",
      functions: ["logLead"],
      access: "write",
    },
    {
      app: "email-ops",
      functions: ["getDraft", "listDrafts"],
      access: "read",
    },
  ]);
});

Deno.test("app runtime resources: D1 setup stays disabled when provisioning cannot resolve a database id", async () => {
  const resources = await createAppD1Resources(
    { id: "app-123", d1_database_id: null },
    {
      getD1DatabaseIdFn: async () => null,
    },
  );

  assertEquals(resources, {
    d1DatabaseId: null,
    d1DataService: null,
  });
});

Deno.test("app runtime resources: D1 disclosure is accurate and never exposes the database id", () => {
  const disclosure = resolveAppD1StorageDisclosure({
    d1_database_id: "cloudflare-database-secret-id",
    d1_status: "ready",
    d1_last_migration_version: 3,
  });

  assertEquals(disclosure, {
    type: "d1",
    status: "ready",
    provisioned: true,
    migration_version: 3,
    note:
      "Agent-owned Galactic D1 storage. Data remains scoped by Agent and user.",
  });
  assertEquals(
    JSON.stringify(disclosure).includes("cloudflare-database-secret-id"),
    false,
  );
  assertEquals(resolveAppD1StorageDisclosure({
    d1_database_id: null,
    d1_status: null,
    d1_last_migration_version: 0,
  }), null);
});
