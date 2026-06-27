import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertExists } from "https://deno.land/std@0.210.0/assert/assert_exists.ts";
import { assertMatch } from "https://deno.land/std@0.210.0/assert/assert_match.ts";

import { handleHttpEndpoint } from "./http.ts";
import { handleMcp } from "./mcp.ts";
import { handlePlatformMcp } from "./platform-mcp.ts";
import { handleRun } from "./run.ts";
import { getCodeCache } from "../services/codecache.ts";
import { encryptEnvVar } from "../services/envvars.ts";
import { getPermissionCache } from "../services/permission-cache.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const COLLAB_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_TOKEN = "wave3-owner-token";
const COLLAB_TOKEN = "wave3-collab-token";
const OWNER_EMAIL = "owner@example.com";
const COLLAB_EMAIL = "collab@example.com";

type JsonRecord = Record<string, unknown>;

type FakeUserRow = {
  id: string;
  email: string;
  display_name?: string | null;
  avatar_url?: string | null;
  tier?: string | null;
  country?: string | null;
  featured_app_id?: string | null;
  profile_slug?: string | null;
  byok_enabled?: boolean | null;
  byok_provider?: string | null;
  byok_keys?: Record<string, unknown> | null;
  balance_light?: number | null;
  escrow_light?: number | null;
  storage_used_bytes?: number | null;
  data_storage_used_bytes?: number | null;
  storage_limit_bytes?: number | null;
  stripe_connect_account_id?: string | null;
  stripe_connect_onboarded?: boolean | null;
  stripe_connect_payouts_enabled?: boolean | null;
};

type FakeAppRow = JsonRecord & {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: string;
  storage_key: string;
  exports: string[];
  manifest: string | null;
  env_schema?: Record<string, unknown>;
  env_vars?: Record<string, string>;
  runtime?: string | null;
  current_version?: string | null;
  versions?: string[] | null;
  storage_bytes?: number | null;
  version_metadata?: Array<{ version?: string; size_bytes?: number }> | null;
  d1_database_id?: string | null;
  d1_status?: string | null;
  http_enabled?: boolean | null;
  download_access?: string | null;
  deleted_at?: string | null;
};

type FakePermissionRow = JsonRecord & {
  app_id: string;
  granted_to_user_id: string;
  granted_by_user_id: string;
  function_name: string;
  allowed: boolean;
};

type FakePendingPermissionRow = JsonRecord & {
  app_id: string;
  invited_email: string;
  granted_by_user_id: string;
  function_name: string;
  allowed: boolean;
};

type FakeSecretRow = {
  user_id: string;
  app_id: string;
  key: string;
  value_encrypted: string;
  updated_at?: string;
};

type FakeAuthUser = {
  id: string;
  email: string;
  user_metadata?: Record<string, string>;
};

class FakeR2Object {
  constructor(private readonly bytes: Uint8Array) {}

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength,
    ) as ArrayBuffer;
  }
}

class FakeR2Bucket {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array | ArrayBuffer): Promise<void> {
    this.objects.set(
      key,
      value instanceof Uint8Array ? value : new Uint8Array(value),
    );
  }

  async get(key: string): Promise<FakeR2Object | null> {
    const value = this.objects.get(key);
    return value ? new FakeR2Object(value) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options: { prefix?: string } = {}): Promise<{
    objects: Array<{ key: string }>;
  }> {
    const prefix = options.prefix || "";
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key })),
    };
  }
}

class FakeKVNamespace {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  read(key: string): string | null {
    return this.values.get(key) ?? null;
  }
}

class Wave3Harness {
  readonly supabaseUrl = "https://wave3.supabase.test";
  readonly serviceKey = "wave3-service-role";
  readonly anonKey = "wave3-anon-key";
  readonly envEncryptionKey = "wave3-env-encryption-key-32-bytes";

  readonly users: FakeUserRow[] = [];
  readonly apps: FakeAppRow[] = [];
  readonly userAppPermissions: FakePermissionRow[] = [];
  readonly pendingPermissions: FakePendingPermissionRow[] = [];
  readonly userAppSecrets: FakeSecretRow[] = [];
  readonly mcpCallLogs: JsonRecord[] = [];
  readonly transfers: JsonRecord[] = [];
  readonly content: JsonRecord[] = [];

  readonly tokens = new Map<string, FakeAuthUser>();
  readonly r2 = new FakeR2Bucket();
  readonly codeCache = new FakeKVNamespace();
  readonly weeklyCalls = new Map<string, number>();
  readonly callerUsage = new Map<string, number>();
  readonly appData = new Map<string, Map<string, unknown>>();
  readonly memory = new Map<string, Map<string, unknown>>();

  private originalFetch: typeof fetch | null = null;
  private originalEnv: Record<string, unknown> | undefined;
  private originalCtx: Record<string, unknown> | undefined;
  private readonly originalEnvVars = new Map<string, string | undefined>();

  install(): () => void {
    this.originalFetch = globalThis.fetch.bind(globalThis);
    this.originalEnv = globalThis.__env
      ? { ...globalThis.__env as Record<string, unknown> }
      : undefined;
    this.originalCtx = globalThis.__ctx
      ? { ...globalThis.__ctx as Record<string, unknown> }
      : undefined;

    const envVars = {
      SUPABASE_URL: this.supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: this.serviceKey,
      SUPABASE_ANON_KEY: this.anonKey,
      ENV_VARS_ENCRYPTION_KEY: this.envEncryptionKey,
      BYOK_ENCRYPTION_KEY: this.envEncryptionKey,
      BASE_URL: "https://wave3.ultralight.test",
      CF_ACCOUNT_ID: "cf-account-wave3",
      CF_API_TOKEN: "cf-token-wave3",
      WORKER_SECRET: "worker-secret-wave3",
      ENVIRONMENT: "test",
    } as const;

    for (const [key, value] of Object.entries(envVars)) {
      this.originalEnvVars.set(key, Deno.env.get(key));
      Deno.env.set(key, value);
    }

    globalThis.fetch = this.fetch.bind(this);
    globalThis.__env = {
      ...(this.originalEnv || {}),
      ...envVars,
      R2_BUCKET: this.r2 as unknown as R2Bucket,
      CODE_CACHE: this.codeCache as unknown as KVNamespace,
      LOADER: this.createLoader(),
      SELF: { fetch: this.originalFetch },
    } as typeof globalThis.__env;
    globalThis.__ctx = {
      exports: {
        AppDataBinding: (
          { props }: { props: { appId: string; userId: string } },
        ) => this.createAppDataBinding(props.appId, props.userId),
        MemoryBinding: ({ props }: { props: { userId: string } }) =>
          this.createMemoryBinding(props.userId),
        AIBinding: () => ({
          call: async () => ({
            content: "[AI stubbed in Wave 3 E2E test]",
            model: "wave3-test",
            usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
          }),
        }),
        FixtureDatabaseBinding: () => ({
          run: async () => ({
            success: true,
            meta: {
              changes: 0,
              last_row_id: 0,
              duration: 0,
              rows_read: 0,
              rows_written: 0,
            },
          }),
          all: async () => [],
          first: async () => null,
          batch: async () => [],
          exec: async () => ({ success: true, count: 0 }),
        }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        promise.catch(() => {});
      },
    } as typeof globalThis.__ctx;

    getPermissionCache().clear();

    return () => {
      if (this.originalFetch) {
        globalThis.fetch = this.originalFetch;
      }
      if (this.originalEnv) {
        globalThis.__env = this.originalEnv as typeof globalThis.__env;
      } else {
        delete (globalThis as Record<string, unknown>).__env;
      }
      if (this.originalCtx) {
        globalThis.__ctx = this.originalCtx as typeof globalThis.__ctx;
      } else {
        delete (globalThis as Record<string, unknown>).__ctx;
      }
      for (const [key, value] of this.originalEnvVars.entries()) {
        if (value === undefined) {
          Deno.env.delete(key);
        } else {
          Deno.env.set(key, value);
        }
      }
    };
  }

  seedUser(
    user: Partial<FakeUserRow> & { id: string; email: string },
    token?: string,
  ): void {
    const row: FakeUserRow = {
      display_name: null,
      avatar_url: null,
      tier: "free",
      country: null,
      featured_app_id: null,
      profile_slug: null,
      byok_enabled: false,
      byok_provider: null,
      byok_keys: null,
      balance_light: 10_000,
      escrow_light: 0,
      storage_used_bytes: 0,
      data_storage_used_bytes: 0,
      storage_limit_bytes: 104_857_600,
      stripe_connect_account_id: null,
      stripe_connect_onboarded: false,
      stripe_connect_payouts_enabled: false,
      ...user,
    };
    this.upsertById(this.users, row);
    if (token) {
      this.tokens.set(token, {
        id: row.id,
        email: row.email,
        user_metadata: row.display_name
          ? { full_name: row.display_name }
          : undefined,
      });
    }
  }

  seedApp(
    app: Partial<FakeAppRow> & {
      id: string;
      owner_id: string;
      slug: string;
      name: string;
      exports: string[];
      storage_key: string;
      manifest: string | null;
    },
    sourceCode: string,
    entryFile = "index.js",
    esmCode = sourceCode,
  ): void {
    const version = app.current_version || this.extractVersion(app.storage_key);
    const row: FakeAppRow = {
      description: null,
      visibility: "private",
      runtime: "deno",
      current_version: version,
      versions: version ? [version] : null,
      env_schema: {},
      env_vars: {},
      d1_database_id: `db-${app.id}`,
      d1_status: "ready",
      http_enabled: true,
      download_access: "private",
      deleted_at: null,
      ...app,
    };
    this.upsertById(this.apps, row);
    this.writeSource(row.storage_key, entryFile, sourceCode);
    this.codeCache.put(`esm:${row.id}:latest`, esmCode);
    if (version) {
      this.codeCache.put(`esm:${row.id}:${version}`, esmCode);
    }
    getCodeCache().invalidate(row.id);
  }

  private writeSource(
    storageKey: string,
    fileName: string,
    content: string,
  ): void {
    this.r2.put(
      `${storageKey}${fileName}`,
      new TextEncoder().encode(content),
    );
  }

  private extractVersion(storageKey: string): string | null {
    const match = storageKey.match(/\/([^/]+)\/$/);
    return match?.[1] ?? null;
  }

  private upsertById<T extends { id: string }>(rows: T[], next: T): void {
    const index = rows.findIndex((row) => row.id === next.id);
    if (index === -1) {
      rows.push(next);
    } else {
      rows[index] = next;
    }
  }

  private upsertPermission(row: FakePermissionRow): void {
    const index = this.userAppPermissions.findIndex((existing) =>
      existing.app_id === row.app_id &&
      existing.granted_to_user_id === row.granted_to_user_id &&
      existing.function_name === row.function_name
    );
    if (index === -1) {
      this.userAppPermissions.push(row);
    } else {
      this.userAppPermissions[index] = row;
    }
  }

  private upsertPendingPermission(row: FakePendingPermissionRow): void {
    const index = this.pendingPermissions.findIndex((existing) =>
      existing.app_id === row.app_id &&
      existing.invited_email === row.invited_email &&
      existing.function_name === row.function_name
    );
    if (index === -1) {
      this.pendingPermissions.push(row);
    } else {
      this.pendingPermissions[index] = row;
    }
  }

  private upsertSecret(row: FakeSecretRow): void {
    const index = this.userAppSecrets.findIndex((existing) =>
      existing.user_id === row.user_id &&
      existing.app_id === row.app_id &&
      existing.key === row.key
    );
    if (index === -1) {
      this.userAppSecrets.push(row);
    } else {
      this.userAppSecrets[index] = row;
    }
  }

  private createAppDataBinding(appId: string, userId: string) {
    const key = `${appId}:${userId}`;
    let store = this.appData.get(key);
    if (!store) {
      store = new Map<string, unknown>();
      this.appData.set(key, store);
    }
    return {
      store: async (name: string, value: unknown) => {
        store!.set(name, value);
      },
      load: async (name: string) => store!.get(name) ?? null,
      remove: async (name: string) => {
        store!.delete(name);
      },
      list: async () => [...store!.keys()],
      query: async () => [],
    };
  }

  private createMemoryBinding(userId: string) {
    let store = this.memory.get(userId);
    if (!store) {
      store = new Map<string, unknown>();
      this.memory.set(userId, store);
    }
    return {
      remember: async (key: string, value: unknown) => {
        store!.set(key, value);
      },
      recall: async (key: string) => store!.get(key) ?? null,
    };
  }

  private createLoader() {
    return {
      load: (workerCode: {
        modules: Record<string, string>;
        env: Record<string, unknown>;
      }) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            const previousConsole = globalThis.console;
            const previousGalactic = (globalThis as Record<string, unknown>)
              .ultralight;
            const previousRpcEnv = (globalThis as Record<string, unknown>)
              .__rpcEnv;

            const logs: Array<{
              time: string;
              level: "log" | "error" | "warn" | "info";
              message: string;
            }> = [];
            const capture = (
              level: "log" | "error" | "warn" | "info",
              args: unknown[],
            ) => {
              logs.push({
                time: new Date().toISOString(),
                level,
                message: args.map((value) =>
                  typeof value === "string" ? value : JSON.stringify(value)
                ).join(" "),
              });
            };

            try {
              new Function(workerCode.modules["setup.js"])();
              (globalThis as Record<string, unknown>).__rpcEnv = workerCode.env;
              globalThis.console = {
                ...previousConsole,
                log: (...args: unknown[]) => capture("log", args),
                error: (...args: unknown[]) => capture("error", args),
                warn: (...args: unknown[]) => capture("warn", args),
                info: (...args: unknown[]) => capture("info", args),
              };

              const fnName = this.extractWrapperLiteral<string>(
                workerCode.modules["wrapper.js"],
                /const fnName = ([\s\S]*?);\n/,
              );
              const fnArgs = this.extractWrapperLiteral<unknown[]>(
                workerCode.modules["wrapper.js"],
                /const fnArgs = ([\s\S]*?);\n\n\s+let targetFn/,
              );
              const appModule = await import(
                `data:text/javascript;charset=utf-8,${
                  encodeURIComponent(
                    `${
                      workerCode.modules["app.js"]
                    }\n// ${crypto.randomUUID()}`,
                  )
                }`
              );

              let targetFn = appModule[fnName];
              if (
                !targetFn && appModule.default &&
                typeof appModule.default === "object"
              ) {
                targetFn =
                  (appModule.default as Record<string, unknown>)[fnName];
              }

              if (typeof targetFn !== "function") {
                return Response.json({
                  success: false,
                  result: null,
                  logs,
                  error: {
                    type: "FunctionNotFound",
                    message: `Function "${fnName}" not found`,
                  },
                });
              }

              const result = await targetFn(...fnArgs);
              return Response.json({ success: true, result, logs });
            } catch (err) {
              return Response.json({
                success: false,
                result: null,
                logs,
                error: {
                  type: err instanceof Error ? err.constructor.name : "Error",
                  message: err instanceof Error ? err.message : String(err),
                },
              });
            } finally {
              globalThis.console = previousConsole;
              if (previousGalactic === undefined) {
                delete (globalThis as Record<string, unknown>).ultralight;
              } else {
                (globalThis as Record<string, unknown>).ultralight =
                  previousGalactic;
              }
              if (previousRpcEnv === undefined) {
                delete (globalThis as Record<string, unknown>).__rpcEnv;
              } else {
                (globalThis as Record<string, unknown>).__rpcEnv =
                  previousRpcEnv;
              }
            }
          },
        }),
      }),
      get: () => ({
        getEntrypoint: () => ({
          fetch: async () => Response.json({ success: false }),
        }),
      }),
    };
  }

  private extractWrapperLiteral<T>(source: string, pattern: RegExp): T {
    const match = source.match(pattern);
    if (!match) {
      throw new Error(`Could not parse wrapper module with pattern ${pattern}`);
    }
    return JSON.parse(match[1]) as T;
  }

  private async fetch(
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.origin === this.supabaseUrl) {
      return await this.handleSupabase(request, url);
    }

    if (
      url.origin === "https://api.cloudflare.com" &&
      url.pathname.includes("/d1/database/")
    ) {
      return Response.json({
        success: true,
        errors: [],
        result: [{
          success: true,
          results: [],
          meta: {
            changes: 0,
            last_row_id: 0,
            duration: 0,
            rows_read: 0,
            rows_written: 0,
          },
        }],
      });
    }

    return await this.originalFetch!(request);
  }

  private async handleSupabase(request: Request, url: URL): Promise<Response> {
    if (url.pathname === "/auth/v1/user") {
      const token = request.headers.get("Authorization")?.replace(
        "Bearer ",
        "",
      );
      const user = token ? this.tokens.get(token) : null;
      return user
        ? Response.json(user)
        : new Response(JSON.stringify({ error: "invalid token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
    }

    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      return await this.handleRpc(request, url);
    }

    if (url.pathname === "/rest/v1/users") {
      return await this.handleUsers(request, url);
    }
    if (url.pathname === "/rest/v1/apps") {
      return await this.handleApps(request, url);
    }
    if (url.pathname === "/rest/v1/user_app_permissions") {
      return await this.handleUserAppPermissions(request, url);
    }
    if (url.pathname === "/rest/v1/pending_permissions") {
      return await this.handlePendingPermissions(request, url);
    }
    if (url.pathname === "/rest/v1/user_app_secrets") {
      return await this.handleUserAppSecrets(request, url);
    }
    if (url.pathname === "/rest/v1/mcp_call_logs") {
      return await this.handleJsonCollection(request, this.mcpCallLogs);
    }
    if (url.pathname === "/rest/v1/transfers") {
      return await this.handleJsonCollection(request, this.transfers);
    }
    if (url.pathname === "/rest/v1/content") {
      return await this.handleJsonCollection(request, this.content);
    }
    if (
      url.pathname === "/rest/v1/app_likes" ||
      url.pathname === "/rest/v1/user_app_library"
    ) {
      return await this.handleJsonCollection(request, []);
    }

    return Response.json([]);
  }

  private async handleRpc(request: Request, url: URL): Promise<Response> {
    const body = request.method === "POST" ? await request.json() : {};

    switch (url.pathname) {
      case "/rest/v1/rpc/check_rate_limit":
        return Response.json(true);
      case "/rest/v1/rpc/increment_weekly_calls": {
        const key = `${body.p_user_id}:${body.p_week_start}`;
        const next = (this.weeklyCalls.get(key) || 0) + 1;
        this.weeklyCalls.set(key, next);
        return Response.json([{ current_count: next }]);
      }
      case "/rest/v1/rpc/record_upload_storage":
      case "/rest/v1/rpc/set_app_storage_bytes": {
        const user = this.users.find((row) => row.id === body.p_user_id);
        const app = this.apps.find((row) => row.id === body.p_app_id);
        const previousBytes = Number(app?.storage_bytes || 0);
        const newBytes = Math.max(0, Number(body.p_size_bytes || 0));
        const deltaBytes = newBytes - previousBytes;
        if (app) {
          app.storage_bytes = newBytes;
        }
        if (user) {
          user.storage_used_bytes = Math.max(
            0,
            Number(user.storage_used_bytes || 0) + deltaBytes,
          );
        }
        return Response.json([{
          previous_bytes: previousBytes,
          new_bytes: newBytes,
          delta_bytes: deltaBytes,
          user_storage_used_bytes: Number(user?.storage_used_bytes || 0),
        }]);
      }
      case "/rest/v1/rpc/reclaim_app_storage": {
        const user = this.users.find((row) => row.id === body.p_user_id);
        const app = this.apps.find((row) => row.id === body.p_app_id);
        const reclaimedBytes = Number(app?.storage_bytes || 0);
        if (app) {
          app.storage_bytes = 0;
        }
        if (user) {
          user.storage_used_bytes = Math.max(
            0,
            Number(user.storage_used_bytes || 0) - reclaimedBytes,
          );
        }
        return Response.json(reclaimedBytes);
      }
      case "/rest/v1/rpc/transfer_balance":
      case "/rest/v1/rpc/transfer_light":
        return Response.json([{
          from_new_balance: 1000,
          to_new_balance: 1000,
          platform_fee: Number(body.p_amount_light || 0) * 0.15,
          transfer_id: "wave3-transfer",
        }]);
      case "/rest/v1/rpc/create_app_call_runtime_cloud_hold":
        return Response.json([{
          hold_id: crypto.randomUUID(),
          payer_user_id: body.p_caller_user_id === body.p_owner_user_id ||
              Number(body.p_app_price_light || 0) <= 0
            ? body.p_owner_user_id
            : body.p_caller_user_id,
          sponsor_user_id: body.p_caller_user_id !== body.p_owner_user_id &&
              Number(body.p_app_price_light || 0) <= 0
            ? body.p_owner_user_id
            : null,
          app_price_light: Number(body.p_app_price_light || 0),
          app_charge_light: body.p_caller_user_id === body.p_owner_user_id ||
              Number(body.p_app_price_light || 0) <= 0
            ? 0
            : Number(body.p_app_price_light || 0),
          free_call: body.p_caller_user_id !== body.p_owner_user_id &&
            Number(body.p_app_price_light || 0) <= 0,
          free_call_count: null,
          free_call_limit: Number(body.p_free_call_limit || 0),
          old_balance: 1000,
          new_balance: 999,
          held_amount_light: Number(body.p_expected_amount_light || 0),
          held_deposit_light: Number(body.p_expected_amount_light || 0),
          held_earned_light: 0,
        }]);
      case "/rest/v1/rpc/settle_cloud_usage_hold":
        return Response.json([{
          event_id: crypto.randomUUID(),
          hold_id: body.p_hold_id,
          settled_amount_light: Number(body.p_amount_light || 0),
          released_amount_light: 0,
        }]);
      case "/rest/v1/rpc/debit_cloud_usage":
        return Response.json([{
          event_id: crypto.randomUUID(),
          old_balance: 1000,
          new_balance: 1000 - Number(body.p_amount_light || 0),
          amount_debited: Number(body.p_amount_light || 0),
          deposit_debited: Number(body.p_amount_light || 0),
          earned_debited: 0,
        }]);
      case "/rest/v1/rpc/increment_caller_usage": {
        const key = `${body.p_app_id}:${body.p_user_id}:${body.p_counter_key}`;
        const next = (this.callerUsage.get(key) || 0) + 1;
        this.callerUsage.set(key, next);
        return Response.json([{ current_count: next }]);
      }
      case "/rest/v1/rpc/increment_app_runs":
      case "/rest/v1/rpc/increment_app_impression":
      case "/rest/v1/rpc/update_app_embedding":
      case "/rest/v1/rpc/increment_budget_used":
        return Response.json([{ ok: true }]);
      default:
        return Response.json([]);
    }
  }

  private async handleUsers(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET") {
      const rows = this.applyFilters(this.users, url.searchParams);
      return this.jsonArrayResponse(rows, request.headers, rows.length);
    }

    if (request.method === "POST") {
      const body = await request.json() as FakeUserRow;
      this.seedUser(body);
      return Response.json([this.users.find((row) => row.id === body.id)]);
    }

    if (request.method === "PATCH") {
      const body = await request.json() as Partial<FakeUserRow>;
      const rows = this.applyFilters(this.users, url.searchParams);
      for (const row of rows) {
        Object.assign(row, body);
      }
      return Response.json(rows);
    }

    return Response.json([]);
  }

  private async handleApps(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET") {
      const rows = this.applyFilters(this.apps, url.searchParams);
      return this.jsonArrayResponse(rows, request.headers, rows.length);
    }

    if (request.method === "POST") {
      const body = await request.json() as FakeAppRow;
      const version = this.extractVersion(body.storage_key || "") || "1.0.0";
      const row: FakeAppRow = {
        visibility: "private",
        description: null,
        runtime: "deno",
        current_version: version,
        versions: [version],
        env_schema: {},
        env_vars: {},
        d1_database_id: null,
        d1_status: null,
        http_enabled: true,
        download_access: "private",
        deleted_at: null,
        ...body,
      };
      this.upsertById(this.apps, row);
      return Response.json([row]);
    }

    if (request.method === "PATCH") {
      const body = await request.json() as Partial<FakeAppRow>;
      const rows = this.applyFilters(this.apps, url.searchParams);
      for (const row of rows) {
        Object.assign(row, body);
      }
      return Response.json(rows);
    }

    return Response.json([]);
  }

  private async handleUserAppPermissions(
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (request.method === "GET") {
      const rows = this.applyFilters(this.userAppPermissions, url.searchParams);
      return Response.json(rows);
    }

    if (request.method === "POST") {
      const body = await request.json() as
        | FakePermissionRow
        | FakePermissionRow[];
      const rows = Array.isArray(body) ? body : [body];
      for (const row of rows) {
        this.upsertPermission({ ...row });
      }
      return Response.json(rows);
    }

    if (request.method === "DELETE") {
      const matches = new Set(
        this.applyFilters(this.userAppPermissions, url.searchParams),
      );
      const remaining = this.userAppPermissions.filter((row) =>
        !matches.has(row)
      );
      this.userAppPermissions.length = 0;
      this.userAppPermissions.push(...remaining);
      return Response.json([]);
    }

    return Response.json([]);
  }

  private async handlePendingPermissions(
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (request.method === "GET") {
      return Response.json(
        this.applyFilters(this.pendingPermissions, url.searchParams),
      );
    }

    if (request.method === "POST") {
      const body = await request.json() as
        | FakePendingPermissionRow
        | FakePendingPermissionRow[];
      const rows = Array.isArray(body) ? body : [body];
      for (const row of rows) {
        this.upsertPendingPermission({
          ...row,
          invited_email: row.invited_email.toLowerCase(),
        });
      }
      return Response.json(rows);
    }

    if (request.method === "DELETE") {
      const matches = new Set(
        this.applyFilters(this.pendingPermissions, url.searchParams),
      );
      const remaining = this.pendingPermissions.filter((row) =>
        !matches.has(row)
      );
      this.pendingPermissions.length = 0;
      this.pendingPermissions.push(...remaining);
      return Response.json([]);
    }

    return Response.json([]);
  }

  private async handleUserAppSecrets(
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (request.method === "GET") {
      return Response.json(
        this.applyFilters(this.userAppSecrets, url.searchParams),
      );
    }

    if (request.method === "POST") {
      const body = await request.json() as FakeSecretRow;
      this.upsertSecret(body);
      return Response.json([body]);
    }

    if (request.method === "DELETE") {
      const matches = new Set(
        this.applyFilters(this.userAppSecrets, url.searchParams),
      );
      const remaining = this.userAppSecrets.filter((row) => !matches.has(row));
      this.userAppSecrets.length = 0;
      this.userAppSecrets.push(...remaining);
      return Response.json([]);
    }

    return Response.json([]);
  }

  private async handleJsonCollection(
    request: Request,
    collection: JsonRecord[],
  ): Promise<Response> {
    if (request.method === "POST") {
      const body = await request.json() as JsonRecord;
      collection.push(body);
      return Response.json([body]);
    }
    return Response.json(collection);
  }

  private jsonArrayResponse(
    rows: unknown[],
    requestHeaders: Headers,
    totalCount: number,
  ): Response {
    const headers = new Headers({ "Content-Type": "application/json" });
    if ((requestHeaders.get("Prefer") || "").includes("count=exact")) {
      const end = totalCount > 0 ? Math.min(totalCount - 1, 0) : 0;
      headers.set("content-range", `0-${end}/${totalCount}`);
    }
    return new Response(JSON.stringify(rows), { status: 200, headers });
  }

  private applyFilters<T extends JsonRecord>(
    rows: T[],
    params: URLSearchParams,
  ): T[] {
    let filtered = [...rows];

    for (const [key, rawValue] of params.entries()) {
      if (
        [
          "select",
          "limit",
          "order",
          "offset",
          "on_conflict",
        ].includes(key)
      ) {
        continue;
      }

      filtered = filtered.filter((row) =>
        this.matchesFilter(row[key], rawValue)
      );
    }

    const limit = params.get("limit");
    if (limit) {
      filtered = filtered.slice(0, Number(limit));
    }

    return filtered;
  }

  private matchesFilter(value: unknown, rawFilter: string): boolean {
    if (rawFilter.startsWith("eq.")) {
      return String(value ?? "") === rawFilter.slice(3);
    }
    if (rawFilter.startsWith("in.(") && rawFilter.endsWith(")")) {
      const values = rawFilter.slice(4, -1).split(",").filter(Boolean);
      return values.includes(String(value ?? ""));
    }
    if (rawFilter === "is.null") {
      return value === null || value === undefined;
    }
    if (rawFilter.startsWith("gte.")) {
      return String(value ?? "") >= rawFilter.slice(4);
    }
    if (rawFilter.startsWith("lte.")) {
      return String(value ?? "") <= rawFilter.slice(4);
    }
    return true;
  }
}

function buildManifest(input: {
  name: string;
  description: string;
  functions: Record<
    string,
    { description: string; parameters?: Record<string, unknown> }
  >;
  envVars?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    name: input.name,
    version: "1.0.0",
    type: "mcp",
    description: input.description,
    entry: { functions: "index.js" },
    functions: Object.fromEntries(
      Object.entries(input.functions).map(([name, definition]) => [
        name,
        {
          description: definition.description,
          parameters: definition.parameters || {},
          returns: { type: "object" },
        },
      ]),
    ),
    ...(input.envVars ? { env_vars: input.envVars } : {}),
  });
}

function rpcRequest(
  method: string,
  params?: unknown,
  id: number | string = 1,
): JsonRecord {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

function authHeaders(token: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-03-26",
  };
}

async function parseJson(response: Response): Promise<JsonRecord> {
  return await response.json() as JsonRecord;
}

function expectToolSuccess(payload: JsonRecord): JsonRecord {
  if (payload.error) {
    throw new Error(
      `Expected tool success, got ${JSON.stringify(payload.error)}`,
    );
  }
  const result = payload.result as JsonRecord | undefined;
  assertExists(result);
  return result.structuredContent as JsonRecord;
}

function expectJsonRpcError(payload: JsonRecord): JsonRecord {
  const error = payload.error as JsonRecord | undefined;
  assertExists(error);
  return error;
}

function appToolNames(payload: JsonRecord): string[] {
  const result = payload.result as JsonRecord;
  const tools = (result.tools as Array<{ name: string }>).map((tool) =>
    tool.name
  );
  return tools.filter((name) => !name.startsWith("ultralight."));
}

Deno.test({
  name: "wave 3: sharing, env parity, and Tool Maker prove out end to end",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const harness = new Wave3Harness();
    const restore = harness.install();

    try {
      harness.seedUser({
        id: OWNER_ID,
        email: OWNER_EMAIL,
        display_name: "Owner",
      }, OWNER_TOKEN);
      harness.tokens.set(COLLAB_TOKEN, {
        id: COLLAB_ID,
        email: COLLAB_EMAIL,
      });

      const sharedAppId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const sharedSlug = "shared-search";
      const sharedSource = `
const ultralight = globalThis.ultralight;

export async function search(args = {}) {
  return {
    ok: true,
    function: "search",
    caller: ultralight.user?.email || null,
    args,
  };
}

export async function list(args = {}) {
  return {
    ok: true,
    function: "list",
    args,
  };
}
`.trim();
      harness.seedApp(
        {
          id: sharedAppId,
          owner_id: OWNER_ID,
          slug: sharedSlug,
          name: "Shared Search",
          description: "Private app for sharing proof",
          visibility: "private",
          storage_key: `apps/${sharedAppId}/1.0.0/`,
          exports: ["search", "list"],
          manifest: buildManifest({
            name: "Shared Search",
            description: "Private app for sharing proof",
            functions: {
              search: {
                description: "Search records",
                parameters: { q: { type: "string", required: true } },
              },
              list: { description: "List records" },
            },
          }),
        },
        sharedSource,
      );

      const ownerSecret = await encryptEnvVar("owner-secret-value");
      const envAppId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const envSlug = "env-probe";
      const envSource = `
const ultralight = globalThis.ultralight;

export async function echo(args = {}) {
  const request = args.request || (
    args && typeof args === "object" && "method" in args && "query" in args
      ? args
      : null
  );
  return {
    owner: ultralight.env.OWNER_SECRET || null,
    user: ultralight.env.USER_SECRET || null,
    caller: ultralight.user?.email || null,
    probe: request?.query?.probe || args.probe || null,
    requestPath: request?.path || null,
  };
}
`.trim();
      harness.seedApp(
        {
          id: envAppId,
          owner_id: OWNER_ID,
          slug: envSlug,
          name: "Env Probe",
          description: "Cross-surface env parity proof",
          visibility: "private",
          storage_key: `apps/${envAppId}/1.0.0/`,
          exports: ["echo"],
          manifest: buildManifest({
            name: "Env Probe",
            description: "Cross-surface env parity proof",
            functions: {
              echo: { description: "Return runtime env values" },
            },
            envVars: {
              OWNER_SECRET: {
                scope: "universal",
                input: "password",
                description: "App-owned secret",
                required: true,
              },
              USER_SECRET: {
                scope: "per_user",
                input: "password",
                description: "Caller-owned secret",
                required: true,
              },
            },
          }),
          env_schema: {
            OWNER_SECRET: {
              scope: "universal",
              input: "password",
              description: "App-owned secret",
              required: true,
            },
            USER_SECRET: {
              scope: "per_user",
              input: "password",
              description: "Caller-owned secret",
              required: true,
            },
          },
          env_vars: {
            OWNER_SECRET: ownerSecret,
          },
        },
        envSource,
      );

      await t.step(
        "multi-user MCP sharing resolves a pending invite and enforces function scoping",
        async () => {
          const grantResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "ul.permissions",
                  arguments: {
                    app_id: sharedAppId,
                    action: "grant",
                    email: COLLAB_EMAIL,
                    functions: [`${sharedSlug}_search`],
                  },
                }),
              ),
            }),
          );
          const grantPayload = await parseJson(grantResponse);
          const grantResult = expectToolSuccess(grantPayload);
          assertEquals(grantResult.status, "pending");
          assertEquals(grantResult.functions_granted, ["search"]);

          const listResponse = await handleMcp(
            new Request(`https://wave3.ultralight.test/mcp/${sharedAppId}`, {
              method: "POST",
              headers: authHeaders(COLLAB_TOKEN),
              body: JSON.stringify(rpcRequest("tools/list")),
            }),
            sharedAppId,
          );
          const listPayload = await parseJson(listResponse);
          assertEquals(
            appToolNames(listPayload).sort(),
            [`${sharedSlug}_search`],
          );
          assertEquals(
            harness.pendingPermissions.length,
            0,
          );
          assertEquals(
            harness.userAppPermissions.map((row) => row.function_name),
            ["search"],
          );

          const searchResponse = await handleMcp(
            new Request(`https://wave3.ultralight.test/mcp/${sharedAppId}`, {
              method: "POST",
              headers: authHeaders(COLLAB_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: `${sharedSlug}_search`,
                  arguments: { q: "wave3" },
                }),
              ),
            }),
            sharedAppId,
          );
          const searchPayload = await parseJson(searchResponse);
          const searchResult = expectToolSuccess(searchPayload);
          assertEquals(searchResult.function, "search");
          assertEquals(searchResult.caller, COLLAB_EMAIL);
          assertEquals(searchResult.args, { q: "wave3" });

          const deniedResponse = await handleMcp(
            new Request(`https://wave3.ultralight.test/mcp/${sharedAppId}`, {
              method: "POST",
              headers: authHeaders(COLLAB_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: `${sharedSlug}_list`,
                  arguments: {},
                }),
              ),
            }),
            sharedAppId,
          );
          const deniedPayload = await parseJson(deniedResponse);
          const deniedError = expectJsonRpcError(deniedPayload);
          assertMatch(
            String(deniedError.message),
            /Permission denied: you do not have access to 'list'/,
          );

          const ownerPermissionList = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "ul.permissions",
                  arguments: {
                    app_id: sharedAppId,
                    action: "list",
                  },
                }),
              ),
            }),
          );
          const permissionPayload = await parseJson(ownerPermissionList);
          const permissionResult = expectToolSuccess(permissionPayload);
          const users = permissionResult.users as Array<JsonRecord>;
          assertEquals(users.length, 1);
          assertEquals(users[0].email, COLLAB_EMAIL);
          const grantedFunctions = users[0].functions as Array<JsonRecord>;
          assertEquals(grantedFunctions.length, 1);
          assertEquals(grantedFunctions[0].name, "search");
          assertEquals(
            (grantedFunctions[0].constraints as JsonRecord | undefined)
              ?.budget_used,
            0,
          );
        },
      );

      await t.step(
        "env vars behave the same across MCP, run, and HTTP",
        async () => {
          const missingMcpResponse = await handleMcp(
            new Request(`https://wave3.ultralight.test/mcp/${envAppId}`, {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: `${envSlug}_echo`,
                  arguments: { probe: "mcp-before" },
                }),
              ),
            }),
            envAppId,
          );
          const missingMcpPayload = await parseJson(missingMcpResponse);
          const missingMcpError = expectJsonRpcError(missingMcpPayload);
          assertMatch(
            String(missingMcpError.message),
            /Missing required secrets: USER_SECRET/,
          );

          const missingRunResponse = await handleRun(
            new Request(`https://wave3.ultralight.test/run/${envAppId}`, {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify({
                function: "echo",
                args: [{ probe: "run-before" }],
              }),
            }),
            envAppId,
          );
          const missingRunPayload = await parseJson(missingRunResponse);
          assertEquals(missingRunResponse.status, 400);
          assertMatch(
            String(missingRunPayload.error?.message),
            /Missing required secrets: USER_SECRET/,
          );
          assertEquals(
            missingRunPayload.error?.details?.type,
            "MISSING_SECRETS",
          );

          const missingHttpResponse = await handleHttpEndpoint(
            new Request(
              `https://wave3.ultralight.test/http/${envAppId}/echo?probe=http-before`,
              {
                method: "POST",
                headers: authHeaders(OWNER_TOKEN),
              },
            ),
            envAppId,
            "/echo",
          );
          const missingHttpPayload = await parseJson(missingHttpResponse);
          assertEquals(missingHttpResponse.status, 400);
          assertMatch(
            String(missingHttpPayload.error),
            /Missing required secrets: USER_SECRET/,
          );

          const connectResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "ul.connect",
                  arguments: {
                    app_id: envAppId,
                    secrets: { USER_SECRET: "user-secret-value" },
                  },
                }),
              ),
            }),
          );
          const connectPayload = await parseJson(connectResponse);
          const connectResult = expectToolSuccess(connectPayload);
          assertEquals(connectResult.fully_connected, true);
          assertEquals(connectResult.connected_keys, ["USER_SECRET"]);

          const mcpResponse = await handleMcp(
            new Request(`https://wave3.ultralight.test/mcp/${envAppId}`, {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: `${envSlug}_echo`,
                  arguments: { probe: "mcp-after" },
                }),
              ),
            }),
            envAppId,
          );
          const mcpPayload = await parseJson(mcpResponse);
          const mcpResult = expectToolSuccess(mcpPayload);
          assertEquals(mcpResult.owner, "owner-secret-value");
          assertEquals(mcpResult.user, "user-secret-value");
          assertEquals(mcpResult.probe, "mcp-after");
          assertEquals(mcpResult.caller, OWNER_EMAIL);

          const runResponse = await handleRun(
            new Request(`https://wave3.ultralight.test/run/${envAppId}`, {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify({
                function: "echo",
                args: [{ probe: "run-after" }],
              }),
            }),
            envAppId,
          );
          const runPayload = await parseJson(runResponse);
          assertEquals(runPayload.success, true);
          assertEquals(
            (runPayload.result as JsonRecord).owner,
            "owner-secret-value",
          );
          assertEquals(
            (runPayload.result as JsonRecord).user,
            "user-secret-value",
          );
          assertEquals((runPayload.result as JsonRecord).probe, "run-after");

          const httpResponse = await handleHttpEndpoint(
            new Request(
              `https://wave3.ultralight.test/http/${envAppId}/echo/inspect?probe=http-after`,
              {
                method: "POST",
                headers: authHeaders(OWNER_TOKEN),
              },
            ),
            envAppId,
            "/echo/inspect",
          );
          const httpPayload = await parseJson(httpResponse);
          assertEquals(httpResponse.status, 200);
          assertEquals(httpPayload.owner, "owner-secret-value");
          assertEquals(httpPayload.user, "user-secret-value");
          assertEquals(httpPayload.probe, "http-after");
          assertEquals(httpPayload.requestPath, "/inspect");
        },
      );

      await t.step(
        "Tool Maker scaffold -> test -> upload -> runtime call holds together",
        async () => {
          const scaffoldResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "ul.download",
                  arguments: {
                    name: "Wave 3 Hello",
                    description: "Golden path scaffold for Wave 3",
                    storage: "kv",
                    functions: [{
                      name: "hello",
                      description: "Return a scaffold placeholder payload",
                      parameters: [{
                        name: "name",
                        type: "string",
                        required: false,
                        description: "Optional greeting target",
                      }],
                    }],
                  },
                }),
              ),
            }),
          );
          const scaffoldPayload = await parseJson(scaffoldResponse);
          const scaffoldResult = expectToolSuccess(scaffoldPayload);
          const scaffoldFiles = scaffoldResult.files as Array<{
            path: string;
            content: string;
          }>;
          assert(scaffoldFiles.some((file) => file.path === "index.ts"));
          assert(scaffoldFiles.some((file) => file.path === "manifest.json"));

          const testResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "ul.test",
                  arguments: {
                    files: scaffoldFiles,
                    function_name: "hello",
                    test_args: { name: "Wave 3" },
                  },
                }),
              ),
            }),
          );
          const testPayload = await parseJson(testResponse);
          const testResult = expectToolSuccess(testPayload);
          assertEquals(testResult.success, true);
          assertEquals((testResult.result as JsonRecord).scaffold, true);
          assertEquals((testResult.result as JsonRecord).function, "hello");

          const uploadResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "ul.upload",
                  arguments: {
                    name: "Wave 3 Hello",
                    description: "Golden path scaffold for Wave 3",
                    visibility: "private",
                    files: scaffoldFiles,
                  },
                }),
              ),
            }),
          );
          const uploadPayload = await parseJson(uploadResponse);
          const uploadResult = expectToolSuccess(uploadPayload);
          assertEquals(uploadResult.is_live, true);
          const uploadedAppId = String(uploadResult.app_id);
          const uploadedSlug = String(uploadResult.slug);
          assertExists(harness.codeCache.read(`esm:${uploadedAppId}:latest`));

          const listResponse = await handleMcp(
            new Request(`https://wave3.ultralight.test/mcp/${uploadedAppId}`, {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(rpcRequest("tools/list")),
            }),
            uploadedAppId,
          );
          const listPayload = await parseJson(listResponse);
          assert(
            appToolNames(listPayload).includes(`${uploadedSlug}_hello`),
          );

          const callResponse = await handleMcp(
            new Request(`https://wave3.ultralight.test/mcp/${uploadedAppId}`, {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: `${uploadedSlug}_hello`,
                  arguments: { name: "Wave 3" },
                }),
              ),
            }),
            uploadedAppId,
          );
          const callPayload = await parseJson(callResponse);
          const callResult = expectToolSuccess(callPayload);
          assertEquals(callResult.scaffold, true);
          assertEquals(callResult.function, "hello");
          assertEquals(callResult.received, { name: "Wave 3" });
        },
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "rollback: gx.set repoints the live runnable bundle (fast path + R2 rebuild fallback)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const harness = new Wave3Harness();
    const restore = harness.install();

    const appId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const V1_BUNDLE = "/* esm v1 */ export const __v = 'v1-runtime-bundle';";
    const V2_BUNDLE = "/* esm v2 */ export const __v = 'v2-runtime-bundle';";

    const callSet = async (version: string): Promise<JsonRecord> => {
      const response = await handlePlatformMcp(
        new Request("https://wave3.ultralight.test/mcp/platform", {
          method: "POST",
          headers: authHeaders(OWNER_TOKEN),
          body: JSON.stringify(
            rpcRequest("tools/call", {
              name: "ul.set",
              arguments: { app_id: appId, version },
            }),
          ),
        }),
      );
      return await parseJson(response);
    };

    try {
      harness.seedUser(
        { id: OWNER_ID, email: OWNER_EMAIL, display_name: "Owner" },
        OWNER_TOKEN,
      );

      // Seed v1.0.0. Its runtime bundle is the sentinel V1_BUNDLE; R2 holds a
      // real entry file so executeSetVersion can extract exports.
      harness.seedApp(
        {
          id: appId,
          owner_id: OWNER_ID,
          slug: "rollback-app",
          name: "Rollback App",
          description: "Proves gx.set swaps the live runnable bundle",
          visibility: "private",
          storage_key: `apps/${appId}/1.0.0/`,
          exports: ["run"],
          manifest: null,
        },
        "export function run() { return 'v1'; }",
        "index.js",
        V1_BUNDLE,
      );

      // Promote to "live on v2" the way an upload would, and add a
      // fallback-only v3 whose per-version KV bundle is intentionally absent.
      const row = harness.apps.find((a) => a.id === appId)!;
      row.current_version = "2.0.0";
      row.versions = ["1.0.0", "2.0.0", "3.0.0"];
      // v2: per-version KV bundle present (fast path), R2 entry file present.
      harness.codeCache.put(`esm:${appId}:2.0.0`, V2_BUNDLE);
      harness.codeCache.put(`esm:${appId}:latest`, V2_BUNDLE); // runtime serves v2
      harness.r2.put(
        `apps/${appId}/2.0.0/index.js`,
        new TextEncoder().encode("export function run(){return 'v2';}"),
      );
      // v3: NO esm:{id}:3.0.0 in KV — forces the R2 _source_ rebuild fallback.
      harness.r2.put(
        `apps/${appId}/3.0.0/_source_index.ts`,
        new TextEncoder().encode(
          "export function run() { return { marker: 'v3-fallback-marker' }; }",
        ),
      );

      await t.step(
        "fast path: set version=1.0.0 copies the retained per-version bundle to :latest",
        async () => {
          // Precondition: the runtime is serving v2.
          assertEquals(harness.codeCache.read(`esm:${appId}:latest`), V2_BUNDLE);

          const payload = await callSet("1.0.0");
          const result = expectToolSuccess(payload);
          assertEquals(result.live_version, "1.0.0");

          // The bundle the runtime loads is now v1 — the actual rollback.
          assertEquals(harness.codeCache.read(`esm:${appId}:latest`), V1_BUNDLE);
        },
      );

      await t.step(
        "fallback: set version=3.0.0 rebuilds ESM from R2 when the per-version bundle is missing",
        async () => {
          assertEquals(harness.codeCache.read(`esm:${appId}:3.0.0`), null);

          const payload = await callSet("3.0.0");
          const result = expectToolSuccess(payload);
          assertEquals(result.live_version, "3.0.0");

          const live = harness.codeCache.read(`esm:${appId}:latest`);
          assertExists(live);
          // Rebuilt from R2 source — the marker survives bundling.
          assert(live!.includes("v3-fallback-marker"));
          // Backfilled so future swaps hit the fast path.
          assertEquals(harness.codeCache.read(`esm:${appId}:3.0.0`), live);
        },
      );
    } finally {
      restore();
    }
  },
});
