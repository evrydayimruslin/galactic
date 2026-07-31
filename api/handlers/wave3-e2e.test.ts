import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertExists } from "https://deno.land/std@0.210.0/assert/assert_exists.ts";
import { assertMatch } from "https://deno.land/std@0.210.0/assert/assert_match.ts";

import { handleHttpEndpoint } from "./http.ts";
import { handleMcp } from "./mcp.ts";
import {
  executeSetVersion,
  handlePlatformMcp,
  inspectLiveAppStorageAccounting,
} from "./platform-mcp.ts";
import { handleRun } from "./run.ts";
import { getCodeCache } from "../services/codecache.ts";
import { encryptEnvVar } from "../services/envvars.ts";
import { getPermissionCache } from "../services/permission-cache.ts";
import {
  buildD1FixtureWriteResult,
  type D1TestFixtureConfig,
  findD1TestFixtureResponse,
} from "../services/d1-test-fixtures.ts";
import {
  blockUlTestEffect,
  createUlTestAiResponse,
  createUlTestEmbedResponse,
  createUlTestNotifyResponse,
  createUlTestRunsResponse,
  UL_TEST_BLOCKED_EFFECTS,
  UL_TEST_OBSERVED_EFFECTS,
  type UlTestObservedEffect,
} from "../services/ul-test-runtime.ts";
import { TestRuntimeStateStore } from "../services/test-state-store.ts";
import type { HttpTestFixtureConfig } from "../services/http-test-fixtures.ts";
import { resolveHttpTestRuntimeResponse } from "../src/bindings/http-test-runtime.ts";
import type { VersionMetadata } from "../../shared/types/index.ts";
import { buildVersionTrustMetadata } from "../services/trust.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const COLLAB_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_TOKEN = "wave3-owner-token";
const OWNER_BUILDER_TOKEN = "gx_11111111111111111111111111111111";
const COLLAB_TOKEN = "wave3-collab-token";
const OWNER_EMAIL = "owner@example.com";
const COLLAB_EMAIL = "collab@example.com";

type JsonRecord = Record<string, unknown>;

class Wave3TestRuntimeSession {
  readonly state = new TestRuntimeStateStore();

  dup(): Wave3TestRuntimeSession {
    return this;
  }

  storeAppData(key: string, value: unknown): Promise<void> {
    this.state.storeAppData(key, value);
    return Promise.resolve();
  }

  loadAppData(key: string): Promise<unknown> {
    return Promise.resolve(this.state.loadAppData(key));
  }

  removeAppData(key: string): Promise<void> {
    this.state.removeAppData(key);
    return Promise.resolve();
  }

  listAppData(prefix?: string): Promise<string[]> {
    return Promise.resolve(this.state.listAppData(prefix));
  }

  rememberMemory(
    scope: "agent" | "user",
    key: string,
    value: unknown,
  ): Promise<void> {
    this.state.rememberMemory(scope, key, value);
    return Promise.resolve();
  }

  recallMemory(scope: "agent" | "user", key: string): Promise<unknown> {
    return Promise.resolve(this.state.recallMemory(scope, key));
  }

  beginHttpFixtureAttempt(): Promise<void> {
    this.state.beginHttpFixtureAttempt();
    return Promise.resolve();
  }

  reserveHttpFixtureExchangeBytes(
    requestBytes: number,
    responseBytes: number,
  ): Promise<void> {
    this.state.reserveHttpFixtureExchangeBytes(requestBytes, responseBytes);
    return Promise.resolve();
  }

  recordBlockedEffect(
    effect: typeof UL_TEST_BLOCKED_EFFECTS[
      keyof typeof UL_TEST_BLOCKED_EFFECTS
    ],
  ): Promise<void> {
    this.state.recordBlockedEffect(effect);
    return Promise.resolve();
  }

  recordObservedEffect(effect: UlTestObservedEffect): Promise<void> {
    this.state.recordObservedEffect(effect);
    return Promise.resolve();
  }

  sealAndSnapshot(): Promise<{
    blockedEffects: string[];
    observedEffects: string[];
  }> {
    return Promise.resolve({
      blockedEffects: this.state.blockedEffects(),
      observedEffects: this.state.observedEffects(),
    });
  }

  close(): Promise<void> {
    this.state.close();
    return Promise.resolve();
  }

  [Symbol.dispose](): void {
    // Local harness owns no remote capability graph.
  }
}

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
  deployment_state?: "legacy" | "ready";
  hosting_suspended?: boolean;
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

type FakeApiTokenRow = JsonRecord & {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  token_salt: string | null;
  plaintext_token: string | null;
  scopes: string[] | null;
  app_ids: string[] | null;
  function_names: string[] | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  created_at: string;
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
  failNextPutPrefix: string | null = null;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.failNextPutPrefix && key.startsWith(this.failNextPutPrefix)) {
      this.failNextPutPrefix = null;
      throw new Error("injected KV persistence failure");
    }
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
  readonly apiTokens: FakeApiTokenRow[] = [];

  readonly tokens = new Map<string, FakeAuthUser>();
  readonly r2 = new FakeR2Bucket();
  readonly codeCache = new FakeKVNamespace();
  readonly weeklyCalls = new Map<string, number>();
  readonly callerUsage = new Map<string, number>();
  readonly appData = new Map<string, Map<string, unknown>>();
  readonly memory = new Map<string, Map<string, unknown>>();
  readonly promotionActions = new Map<string, {
    requestId: string;
    leaseToken: string;
    userId: string;
    version: string;
    status: "in_progress" | "completed" | "failed";
    phase: string | null;
  }>();
  failNextStorageAccounting = false;

  seedActivePromotion(appId: string, userId: string, version: string): void {
    this.promotionActions.set(appId, {
      requestId: crypto.randomUUID(),
      leaseToken: crypto.randomUUID(),
      userId,
      version,
      status: "in_progress",
      phase: "live_bundle",
    });
  }

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
        FixtureDatabaseBinding: (
          { props }: {
            props: {
              fixtures: D1TestFixtureConfig;
              session: Wave3TestRuntimeSession;
            };
          },
        ) => ({
          select: async (op: Record<string, unknown>) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.databaseRead,
            );
            const fixture = findD1TestFixtureResponse(props.fixtures, {
              method: "select",
              table: typeof op.table === "string" ? op.table : undefined,
              op,
            });
            if (!fixture) throw new Error("missing select fixture");
            return Array.isArray(fixture.result) ? fixture.result : [];
          },
          insert: async (op: Record<string, unknown>) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.databaseWrite,
            );
            const fixture = findD1TestFixtureResponse(props.fixtures, {
              method: "insert",
              table: typeof op.table === "string" ? op.table : undefined,
              op,
            });
            if (!fixture) throw new Error("missing insert fixture");
            return buildD1FixtureWriteResult(fixture.result, true);
          },
          count: async (op: Record<string, unknown>) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.databaseRead,
            );
            const fixture = findD1TestFixtureResponse(props.fixtures, {
              method: "count",
              table: typeof op.table === "string" ? op.table : undefined,
              op,
            });
            if (!fixture) throw new Error("missing count fixture");
            return typeof fixture.result === "number" ? fixture.result : 0;
          },
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
        TestRuntimeSessionFactory: () => ({
          create: () => Promise.resolve(new Wave3TestRuntimeSession()),
        }),
        TestAIBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          call: async () => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.inferenceGenerate,
            );
            return createUlTestAiResponse();
          },
        }),
        TestEmbedBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          embed: async () => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.inferenceEmbed,
            );
            return createUlTestEmbedResponse();
          },
        }),
        TestNotifyBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          notifyOwner: async () => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.notificationOwnerWrite,
            );
            return createUlTestNotifyResponse();
          },
        }),
        TestAppDataBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          store: async (key: string, value: unknown) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.storageWrite,
            );
            return await props.session.storeAppData(key, value);
          },
          load: async (key: string) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.storageRead,
            );
            return await props.session.loadAppData(key);
          },
          remove: async (key: string) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.storageDelete,
            );
            return await props.session.removeAppData(key);
          },
          list: async (prefix?: string) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.storageRead,
            );
            return await props.session.listAppData(prefix);
          },
        }),
        TestMemoryBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          remember: async (
            key: string,
            value: unknown,
            scope?: "agent" | "user",
          ) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.memoryWrite,
            );
            return await props.session.rememberMemory(
              scope === "user" ? "user" : "agent",
              key,
              value,
            );
          },
          recall: async (key: string, scope?: "agent" | "user") => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.memoryRead,
            );
            return await props.session.recallMemory(
              scope === "user" ? "user" : "agent",
              key,
            );
          },
        }),
        TestRunsBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          recent: async () => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.routineRead,
            );
            return createUlTestRunsResponse();
          },
        }),
        TestOutboundBinding: (
          { props }: {
            props: {
              session: Wave3TestRuntimeSession;
              fixtures: HttpTestFixtureConfig;
              allowedDestinations: string[];
            };
          },
        ) => ({
          fetch: (
            input: Request | string | URL,
            init?: RequestInit,
          ) =>
            resolveHttpTestRuntimeResponse({
              kind: "raw",
              request: input instanceof Request
                ? input
                : new Request(input, init),
              fixtures: props.fixtures,
              allowedDestinations: props.allowedDestinations,
              recorder: props.session,
            }),
          connect: () =>
            blockUlTestEffect(
              props.session,
              UL_TEST_BLOCKED_EFFECTS.outboundTcp,
            ),
        }),
        TestCredentialBinding: (
          { props }: {
            props: {
              session: Wave3TestRuntimeSession;
              fixtures: HttpTestFixtureConfig;
              allowedDestinations: string[];
              credentialDestinations: Record<string, string>;
            };
          },
        ) => ({
          authenticatedFetch: (
            credentialKey: string,
            url: string,
            init?: {
              method?: string;
              headers?: Record<string, string>;
              body?: string | null;
            },
          ) => {
            const method = (init?.method ?? "GET").toUpperCase();
            return resolveHttpTestRuntimeResponse({
              kind: "credential",
              credentialKey,
              request: new Request(url, {
                method,
                headers: init?.headers,
                body: method === "GET" || method === "HEAD"
                  ? null
                  : init?.body ?? null,
              }),
              fixtures: props.fixtures,
              allowedDestinations: props.allowedDestinations,
              credentialDestinations: props.credentialDestinations,
              recorder: props.session,
            });
          },
        }),
        TestNetworkBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          imapFetchUnseen: () =>
            blockUlTestEffect(
              props.session,
              UL_TEST_BLOCKED_EFFECTS.imap,
            ),
          smtpSend: () =>
            blockUlTestEffect(
              props.session,
              UL_TEST_BLOCKED_EFFECTS.smtp,
            ),
        }),
        TestEventsBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          emit: () =>
            blockUlTestEffect(
              props.session,
              UL_TEST_BLOCKED_EFFECTS.eventPublish,
            ),
        }),
        TestAppCallBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          fetch: () =>
            blockUlTestEffect(
              props.session,
              UL_TEST_BLOCKED_EFFECTS.agentCall,
            ),
        }),
        TestComputeBinding: (
          { props }: { props: { session: Wave3TestRuntimeSession } },
        ) => ({
          call: async () => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.computeExecute,
            );
            return {
              ok: true,
              value: {
                run_id: "test-compute-run",
                receipt_id: "test-compute-receipt",
                status: "completed",
                profile: "developer-v1",
                tools: [],
                created_at: new Date(0).toISOString(),
                started_at: new Date(0).toISOString(),
                finished_at: new Date(0).toISOString(),
                exit_code: 0,
                stdout: "",
                stderr: "",
                artifacts: [],
                async: false,
              },
            };
          },
          get: async (runId: string) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.computeExecute,
            );
            return {
              ok: true,
              value: {
                run_id: runId,
                receipt_id: `test-receipt-${runId}`,
                status: "completed",
                profile: "developer-v1",
                tools: [],
                created_at: new Date(0).toISOString(),
              },
            };
          },
          cancel: async (runId: string) => {
            await props.session.recordObservedEffect(
              UL_TEST_OBSERVED_EFFECTS.computeExecute,
            );
            return {
              ok: true,
              value: {
                run_id: runId,
                receipt_id: `test-receipt-${runId}`,
                status: "cancelled",
                profile: "developer-v1",
                tools: [],
                created_at: new Date(0).toISOString(),
              },
            };
          },
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

  seedApiToken(
    token: string,
    userId: string,
    scopes: string[] = ["agents:build"],
  ): void {
    this.upsertById(this.apiTokens, {
      id: crypto.randomUUID(),
      user_id: userId,
      name: "Wave 3 builder",
      token_prefix: token.slice(0, 8),
      token_hash: "",
      token_salt: null,
      plaintext_token: token,
      scopes,
      app_ids: null,
      function_names: null,
      last_used_at: null,
      last_used_ip: null,
      expires_at: null,
      created_at: new Date(0).toISOString(),
    });
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
      deployment_state: "legacy",
      hosting_suspended: false,
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
    type WorkerCode = {
      modules: Record<string, string>;
      env: Record<string, unknown>;
      globalOutbound?: {
        fetch(request: Request): Promise<Response>;
      } | null;
    };
    // Real behavior: per-execution data (functionName/args/authToken/callerCtx/
    // execCtxHandle) arrives in the fetch REQUEST BODY (not baked into the
    // wrapper), and get(id, cb) builds the worker from cb() then runs
    // identically to load(). Both paths share this runner.
    const runWorker = async (
      workerCode: WorkerCode,
      request: Request,
    ): Promise<Response> => {
      const runFetch = this.buildWorkerFetch(workerCode);
      return await runFetch(request);
    };
    // Cache-by-id so get() mirrors the real Worker Loader: the build callback
    // fires ONCE per id (cold start); a warm hit REPLAYS the frozen env/modules
    // and ignores the callback. Per-call data reaches the frozen isolate only
    // through the fetch body.
    const getCache = new Map<string, WorkerCode>();
    return {
      load: (workerCode: WorkerCode) => ({
        getEntrypoint: () => ({
          fetch: (request: Request) => runWorker(workerCode, request),
        }),
      }),
      get: (id: string, cb: () => WorkerCode | Promise<WorkerCode>) => ({
        getEntrypoint: () => ({
          fetch: async (request: Request) => {
            if (!getCache.has(id)) getCache.set(id, await cb());
            return await runWorker(getCache.get(id)!, request);
          },
        }),
      }),
    };
  }

  private buildWorkerFetch(workerCode: {
    modules: Record<string, string>;
    env: Record<string, unknown>;
    globalOutbound?: {
      fetch(request: Request): Promise<Response>;
    } | null;
  }) {
    return async (request: Request): Promise<Response> => {
      const previousFetch = globalThis.fetch;
      const previousConsole = globalThis.console;
      const previousGalactic = (globalThis as Record<string, unknown>)
        .ultralight;
      const previousRpcEnv = (globalThis as Record<string, unknown>).__rpcEnv;
      const previousReq = (globalThis as Record<string, unknown>).__ulReq;
      const previousHandle = (globalThis as Record<string, unknown>)
        .__execHandle;

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

      let functionInvoked = false;
      let drainPendingEffects = async (): Promise<void> => {};
      try {
        if (workerCode.globalOutbound) {
          globalThis.fetch = workerCode.globalOutbound.fetch.bind(
            workerCode.globalOutbound,
          );
        }
        // Per-request payload (functionName/args/authToken/callerCtx/
        // execCtxHandle) arrives in the fetch body, exactly like the real
        // wrapper.
        const req = await request.json().catch(() => ({})) as {
          functionName?: string;
          args?: unknown[];
          authToken?: string;
          callerCtx?: string;
          execCtxHandle?: string;
        };
        // This in-memory harness executes setup.js through Function rather than
        // Worker Loader's ESM runtime. Adapt only its two module exports so the
        // production template can keep the RPC environment and effect tracker
        // in module-private lexical state.
        const setupForHarness = workerCode.modules["setup.js"]
          .replace(
            "export function __setGalacticRpcEnv",
            "function __setGalacticRpcEnv",
          )
          .replace(
            "export async function __drainGalacticPendingEffects",
            "async function __drainGalacticPendingEffects",
          );
        const runtimeBridge = new Function(
          `${setupForHarness}
return { __setGalacticRpcEnv, __drainGalacticPendingEffects };`,
        )() as {
          __setGalacticRpcEnv(env: Record<string, unknown>): void;
          __drainGalacticPendingEffects(): Promise<void>;
        };
        runtimeBridge.__setGalacticRpcEnv(workerCode.env);
        drainPendingEffects = runtimeBridge.__drainGalacticPendingEffects.bind(
          runtimeBridge,
        );
        (globalThis as Record<string, unknown>).__execHandle =
          req.execCtxHandle ?? null;
        (globalThis as Record<string, unknown>).__ulReq = {
          authToken: req.authToken ?? "",
          callerCtx: req.callerCtx ?? "",
        };
        globalThis.console = {
          ...previousConsole,
          log: (...args: unknown[]) => capture("log", args),
          error: (...args: unknown[]) => capture("error", args),
          warn: (...args: unknown[]) => capture("warn", args),
          info: (...args: unknown[]) => capture("info", args),
        };

        const fnName = typeof req.functionName === "string"
          ? req.functionName
          : "";
        const fnArgs = Array.isArray(req.args) ? req.args : [];
        const appModule = await import(
          `data:text/javascript;charset=utf-8,${
            encodeURIComponent(
              `${workerCode.modules["app.js"]}\n// ${crypto.randomUUID()}`,
            )
          }`
        );

        let targetFn = appModule[fnName];
        if (
          !targetFn && appModule.default &&
          typeof appModule.default === "object"
        ) {
          targetFn = (appModule.default as Record<string, unknown>)[fnName];
        }

        if (typeof targetFn !== "function") {
          // Mirror the real wrapper: enumerate the app's callable exports.
          const available: string[] = [];
          for (const k of Object.keys(appModule)) {
            if (typeof appModule[k] === "function") available.push(k);
          }
          if (
            appModule.default && typeof appModule.default === "object"
          ) {
            for (const k of Object.keys(appModule.default)) {
              if (
                typeof (appModule.default as Record<string, unknown>)[k] ===
                  "function"
              ) available.push(k);
            }
          }
          return Response.json({
            success: false,
            functionInvoked,
            result: null,
            logs,
            aiCostLight: (globalThis as Record<string, unknown>)
              .__aiCostLight as number || 0,
            error: {
              type: "FunctionNotFound",
              message: `Function "${fnName}" not found. Available: ${
                [...new Set(available)].join(", ")
              }`,
            },
          });
        }

        functionInvoked = true;
        const result = await targetFn(...fnArgs);
        await drainPendingEffects();
        return Response.json({
          success: true,
          functionInvoked,
          result,
          logs,
          aiCostLight: (globalThis as Record<string, unknown>)
            .__aiCostLight as number || 0,
        });
      } catch (caught) {
        let err = caught;
        try {
          await drainPendingEffects();
        } catch (drainError) {
          err = drainError;
        }
        return Response.json({
          success: false,
          functionInvoked,
          result: null,
          logs,
          aiCostLight: (globalThis as Record<string, unknown>)
            .__aiCostLight as number || 0,
          error: {
            type: err instanceof Error ? err.constructor.name : "Error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      } finally {
        globalThis.fetch = previousFetch;
        globalThis.console = previousConsole;
        if (previousGalactic === undefined) {
          delete (globalThis as Record<string, unknown>).ultralight;
        } else {
          (globalThis as Record<string, unknown>).ultralight = previousGalactic;
        }
        if (previousRpcEnv === undefined) {
          delete (globalThis as Record<string, unknown>).__rpcEnv;
        } else {
          (globalThis as Record<string, unknown>).__rpcEnv = previousRpcEnv;
        }
        if (previousReq === undefined) {
          delete (globalThis as Record<string, unknown>).__ulReq;
        } else {
          (globalThis as Record<string, unknown>).__ulReq = previousReq;
        }
        if (previousHandle === undefined) {
          delete (globalThis as Record<string, unknown>).__execHandle;
        } else {
          (globalThis as Record<string, unknown>).__execHandle = previousHandle;
        }
      }
    };
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
    if (url.pathname === "/rest/v1/account_entitlements") {
      return Response.json([{
        plan_code: "pro",
        subscription_status: "active",
      }]);
    }
    if (url.pathname === "/rest/v1/user_api_tokens") {
      return await this.handleApiTokens(request, url);
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
      case "/rest/v1/rpc/get_agent_home_revision":
        return Response.json("1");
      case "/rest/v1/rpc/claim_agent_home_action": {
        const appId = String(body.p_app_id);
        const active = this.promotionActions.get(appId);
        if (active?.status === "in_progress") {
          return Response.json({
            code: "P0001",
            details: JSON.stringify({
              code: "AGENT_HOME_ACTION_IN_PROGRESS",
            }),
          }, { status: 400 });
        }
        const requestId = crypto.randomUUID();
        const leaseToken = crypto.randomUUID();
        const version = String(
          (body.p_request_payload as Record<string, unknown>)?.version || "",
        );
        this.promotionActions.set(appId, {
          requestId,
          leaseToken,
          userId: String(body.p_user_id),
          version,
          status: "in_progress",
          phase: null,
        });
        return Response.json([{
          request_id: requestId,
          is_new: true,
          request_status: "in_progress",
          request_response: {},
          request_fingerprint: "a".repeat(64),
          request_lease_token: leaseToken,
          current_revision: "1",
        }]);
      }
      case "/rest/v1/rpc/fence_agent_home_promotion_step": {
        const action = this.promotionActions.get(String(body.p_app_id));
        if (
          !action || action.status !== "in_progress" ||
          action.requestId !== body.p_request_id ||
          action.leaseToken !== body.p_lease_token
        ) {
          return Response.json({
            code: "P0001",
            details: JSON.stringify({
              code: "AGENT_HOME_ACTION_IN_PROGRESS",
            }),
          }, { status: 400 });
        }
        action.phase = String(body.p_step);
        return Response.json([{
          lease_expires_at: "2099-01-01T00:00:00.000Z",
          current_revision: "1",
        }]);
      }
      case "/rest/v1/rpc/commit_agent_home_promotion_app_record": {
        const appId = String(body.p_app_id);
        const action = this.promotionActions.get(appId);
        if (
          !action || action.status !== "in_progress" ||
          action.requestId !== body.p_request_id ||
          action.leaseToken !== body.p_lease_token
        ) {
          return Response.json({
            code: "P0001",
            details: JSON.stringify({
              code: "AGENT_HOME_ACTION_IN_PROGRESS",
            }),
          }, { status: 400 });
        }
        const app = this.apps.find((row) => row.id === appId);
        if (app) {
          app.current_version = String(body.p_version);
          app.storage_key = String(body.p_storage_key);
          app.exports = Array.isArray(body.p_exports)
            ? body.p_exports as string[]
            : [];
          if (body.p_set_manifest === true) {
            app.manifest = String(body.p_manifest);
            app.env_schema = (body.p_env_schema as Record<string, unknown>) ||
              {};
          }
        }
        return Response.json([{ new_revision: "2" }]);
      }
      case "/rest/v1/rpc/complete_agent_home_action": {
        const action = this.promotionActions.get(String(body.p_app_id));
        if (
          !action || action.requestId !== body.p_request_id ||
          action.leaseToken !== body.p_lease_token
        ) {
          return Response.json({
            code: "P0001",
            details: JSON.stringify({ code: "AGENT_HOME_ACTION_NOT_FOUND" }),
          }, { status: 400 });
        }
        action.status = body.p_status === "completed" ? "completed" : "failed";
        return Response.json([{
          request_id: action.requestId,
          request_status: action.status,
          request_response: body.p_response || {},
        }]);
      }
      case "/rest/v1/rpc/increment_weekly_calls": {
        const key = `${body.p_user_id}:${body.p_week_start}`;
        const next = (this.weeklyCalls.get(key) || 0) + 1;
        this.weeklyCalls.set(key, next);
        return Response.json([{ current_count: next }]);
      }
      case "/rest/v1/rpc/record_upload_storage":
      case "/rest/v1/rpc/set_app_storage_bytes": {
        if (this.failNextStorageAccounting) {
          this.failNextStorageAccounting = false;
          return Response.json({ message: "injected storage failure" }, {
            status: 503,
          });
        }
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
      if (
        request.headers.get("Accept")?.includes(
          "application/vnd.pgrst.object+json",
        )
      ) {
        return Response.json(rows[0] ?? null);
      }
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

  private async handleApiTokens(
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (request.method === "GET") {
      const rows = this.applyFilters(this.apiTokens, url.searchParams);
      if (
        request.headers.get("Accept")?.includes(
          "application/vnd.pgrst.object+json",
        )
      ) {
        return Response.json(rows[0] ?? null);
      }
      return this.jsonArrayResponse(rows, request.headers, rows.length);
    }

    if (request.method === "PATCH") {
      const body = await request.json() as Partial<FakeApiTokenRow>;
      const rows = this.applyFilters(this.apiTokens, url.searchParams);
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
        deployment_state: "legacy",
        hosting_suspended: false,
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
          // Phase 3: the per-user secret is VAULTED — connected (the missing-
          // secret gate cleared, so the call runs) and usable via the credential
          // binding, but NOT readable from ultralight.env. Consistent across all
          // three surfaces (parity preserved, now for the secure behavior).
          assertEquals(mcpResult.user, null);
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
            null,
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
          assertEquals(httpPayload.user, null);
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
          assert(scaffoldFiles.some((file) => file.path === "galactic.yaml"));
          assertEquals(
            scaffoldFiles.some((file) => file.path === "manifest.json"),
            false,
          );

          const testResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "ul.test",
                  arguments: {
                    files: scaffoldFiles,
                  },
                }),
              ),
            }),
          );
          const testPayload = await parseJson(testResponse);
          const testResult = expectToolSuccess(testPayload);
          assertEquals(testResult.success, true);
          assertEquals(testResult.profile, "basic");
          assertEquals(testResult.test_attestation_schema_version, 2);
          assert(typeof testResult.test_attestation === "string");
          const caseResults = testResult.case_results as JsonRecord[];
          assertEquals(caseResults.length, 1);
          assertEquals(caseResults[0].function, "hello");
          assertEquals(caseResults[0].invoked, true);
          assertEquals(caseResults[0].success, true);
          const conformance = testResult.conformance as JsonRecord;
          const coverage = conformance.coverage as JsonRecord;
          assertEquals(coverage.functions, {
            declared: 2,
            exercised: 1,
            names: ["hello"],
          });

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
                    test_attestation: testResult.test_attestation,
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

      await t.step(
        "full-time scaffold executes a representative gx.test wake",
        async () => {
          const scaffoldResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "gx.download",
                  arguments: {
                    name: "Wave 3 Keeper",
                    description: "Persistent-agent golden path",
                    full_time: true,
                  },
                }),
              ),
            }),
          );
          const scaffold = expectToolSuccess(
            await parseJson(scaffoldResponse),
          );
          const files = scaffold.files as Array<{
            path: string;
            content: string;
          }>;

          const testResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "gx.test",
                  arguments: {
                    files,
                  },
                }),
              ),
            }),
          );
          const tested = expectToolSuccess(await parseJson(testResponse));
          assertEquals(tested.success, true);
          assertEquals(tested.profile, "basic");
          assertEquals(tested.test_attestation_schema_version, 2);
          assertEquals(tested.test_attestation_mode, "deno_execution");
          assert(typeof tested.test_attestation === "string");
          const conformance = tested.conformance as JsonRecord;
          const coverage = conformance.coverage as JsonRecord;
          assertEquals(coverage.cases, {
            declared: 2,
            required: 2,
            passed: 2,
            optional_failed: 0,
          });
          assertEquals(coverage.functions, {
            declared: 2,
            exercised: 2,
            names: ["status", "tick"],
          });
          assertEquals(coverage.effects, {
            declared: 6,
            exercised: 5,
            untested: 1,
            exercised_ids: [
              "status:database.read",
              "tick:database.read",
              "tick:database.write",
              "tick:inference.generate",
              "tick:routine.read",
            ],
            untested_ids: ["tick:notification.owner.write"],
          });
        },
      );

      await t.step(
        "gx.test keeps DATA and MEMORY local while preserving SDK behavior",
        async () => {
          const scaffoldResponse = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "gx.download",
                  arguments: {
                    name: "Wave 3 Local State",
                    description: "gx.test local state containment",
                    permissions: [
                      "storage:read",
                      "storage:write",
                      "memory:read",
                      "memory:write",
                    ],
                  },
                }),
              ),
            }),
          );
          const scaffold = expectToolSuccess(
            await parseJson(scaffoldResponse),
          );
          const files = (scaffold.files as Array<{
            path: string;
            content: string;
          }>).flatMap((file) => {
            if (file.path === "index.ts") {
              return [{
                ...file,
                content: `
export async function local_roundtrip() {
  await galactic.store("state/current", { status: "ready" });
  await galactic.remember("cursor", { page: 4 });
  return {
    data: await galactic.load("state/current"),
    memory: await galactic.recall("cursor"),
  };
}
`,
              }];
            }
            if (file.path === "galactic.yaml") {
              return [{
                path: "manifest.json",
                content: JSON.stringify({
                  name: "Wave 3 Local State",
                  version: "1.0.0",
                  type: "mcp",
                  entry: { functions: "index.ts" },
                  permissions: [
                    "storage:read",
                    "storage:write",
                    "memory:read",
                    "memory:write",
                  ],
                  functions: {
                    local_roundtrip: {
                      description:
                        "Exercise invocation-local data and memory state.",
                    },
                  },
                }),
              }];
            }
            return [file];
          });

          const response = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "gx.test",
                  arguments: {
                    files,
                    function_name: "local_roundtrip",
                  },
                }),
              ),
            }),
          );
          const tested = expectToolSuccess(await parseJson(response));
          assertEquals(tested.success, true);
          assertEquals(tested.result, {
            data: { status: "ready" },
            memory: { page: 4 },
          });
          assert(typeof tested.test_attestation === "string");
        },
      );

      await t.step(
        "gx.test qualifies exact raw and credentialed HTTP fixtures without network",
        async () => {
          const files = [
            {
              path: "index.ts",
              content: `
export async function read_public() {
  const response = await fetch("https://api.example.com/public?limit=1");
  return await response.json();
}

export async function create_private() {
  const response = await galactic.fetch(
    "API_TOKEN",
    "https://api.example.com/private",
    { method: "POST", body: "{}" },
  );
  return await response.json();
}
`,
            },
            {
              path: "galactic.yaml",
              content: `
apiVersion: agents.connectgalactic.com/v1alpha1
kind: Agent
metadata:
  name: Wave 3 HTTP Fixtures
  version: 1.0.0
spec:
  entry:
    functions: index.ts
  functions:
    read_public:
      description: Read one public fixture.
      authority:
        level: external_write
        effects:
          network.http: free
    create_private:
      description: Exercise a credential-bound fixture.
      authority:
        level: external_write
        effects:
          credential.http: ask
  network:
    allowed_destinations:
      - api.example.com
  env_vars:
    API_TOKEN:
      description: Owner API token.
      required: true
      scope: per_user
      input: password
      credential:
        destination: api.example.com
        inject:
          as: bearer
  conformance:
    profile: basic
    cases:
      - id: raw-http
        function: read_public
        fixtures:
          http:
            - id: public-list
              kind: raw
              request:
                method: GET
                url: https://api.example.com/public?limit=1
              response:
                status: 200
                headers:
                  content-type: application/json
                body_text: '{"items":[]}'
      - id: credential-http
        function: create_private
        fixtures:
          http:
            - id: private-create
              kind: credential
              credential_key: API_TOKEN
              request:
                method: POST
                url: https://api.example.com/private
                body_sha256: 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
              response:
                status: 201
                headers:
                  content-type: application/json
                body_text: '{"created":true}'
`,
            },
          ];

          const response = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "gx.test",
                  arguments: { files },
                }),
              ),
            }),
          );
          const tested = expectToolSuccess(await parseJson(response));
          assertEquals(tested.success, true);
          assertEquals(tested.test_attestation_schema_version, 2);
          const conformance = tested.conformance as JsonRecord;
          const coverage = conformance.coverage as JsonRecord;
          assertEquals(coverage.cases, {
            declared: 2,
            required: 2,
            passed: 2,
            optional_failed: 0,
          });
          assertEquals(coverage.effects, {
            declared: 2,
            exercised: 2,
            untested: 0,
            exercised_ids: [
              "create_private:credential.http",
              "read_public:network.http",
            ],
            untested_ids: [],
          });
          assertEquals(
            (tested.case_results as JsonRecord[]).map((entry) =>
              entry.observed_effects
            ),
            [["network.http"], ["credential.http"]],
          );
        },
      );

      await t.step(
        "a caught external effect fails gx.test and receives no attestation",
        async () => {
          const response = await handlePlatformMcp(
            new Request("https://wave3.ultralight.test/mcp/platform", {
              method: "POST",
              headers: authHeaders(OWNER_TOKEN),
              body: JSON.stringify(
                rpcRequest("tools/call", {
                  name: "gx.test",
                  arguments: {
                    files: [{
                      path: "index.ts",
                      content: `
export async function caught_effect() {
  try {
    await fetch("https://example.com/should-not-run", {
      method: "POST",
      body: "blocked",
    });
  } catch {
    // Catching the local error must not turn this into a qualification pass.
  }
  return { caught: true };
}
`,
                    }],
                    function_name: "caught_effect",
                  },
                }),
              ),
            }),
          );
          const tested = expectToolSuccess(await parseJson(response));
          assertEquals(tested.success, false);
          assert(
            typeof tested.error === "string" &&
              tested.error.includes("outbound_http"),
          );
          assertEquals("test_attestation" in tested, false);
        },
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "qualification V2: promotion rechecks the exact retained release before any write",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = new Wave3Harness();
    const restore = harness.install();
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<JsonRecord> => {
      const response = await handlePlatformMcp(
        new Request("https://wave3.ultralight.test/mcp/platform", {
          method: "POST",
          headers: authHeaders(OWNER_BUILDER_TOKEN),
          body: JSON.stringify(
            rpcRequest("tools/call", { name, arguments: args }),
          ),
        }),
      );
      return expectToolSuccess(await parseJson(response));
    };
    const source = (version: string, marker: string) => [{
      path: "index.ts",
      content: `
export function inspect(input = {}) {
  return { marker: ${JSON.stringify(marker)}, input };
}
`,
    }, {
      path: "galactic.yaml",
      content: `
apiVersion: agents.connectgalactic.com/v1alpha1
kind: Agent
metadata:
  name: Qualified Promotion
  version: ${version}
spec:
  entry:
    functions: index.ts
  functions:
    inspect:
      description: Inspect a fixture.
      authority:
        level: read
        effects: {}
  conformance:
    profile: basic
    cases:
      - id: inspect-basic
        function: inspect
        input:
          probe: true
`,
    }];

    try {
      harness.seedUser(
        { id: OWNER_ID, email: OWNER_EMAIL, display_name: "Owner" },
        OWNER_TOKEN,
      );
      harness.seedApiToken(OWNER_BUILDER_TOKEN, OWNER_ID);

      const liveFiles = source("1.0.0", "live");
      const liveTest = await call("gx.test", { files: liveFiles });
      const created = await call("gx.upload", {
        name: "Qualified Promotion",
        visibility: "private",
        files: liveFiles,
        test_attestation: liveTest.test_attestation,
      });
      const appId = String(created.app_id);

      const candidateFiles = source("1.0.1", "candidate");
      const candidateTest = await call("gx.test", {
        files: candidateFiles,
      });
      const staged = await call("gx.upload", {
        app_id: appId,
        version: "1.0.1",
        files: candidateFiles,
        test_attestation: candidateTest.test_attestation,
      });
      assertEquals(staged.is_live, false);
      const exactCandidate = harness.codeCache.read(
        `esm:${appId}:1.0.1`,
      );
      assertExists(exactCandidate);

      const appRow = harness.apps.find((app) => app.id === appId);
      assertExists(appRow);
      const candidateMetadata = [
        ...(appRow.version_metadata || []),
      ].reverse().find((entry) => entry.version === "1.0.1") as
        | VersionMetadata
        | undefined;
      assertExists(candidateMetadata);
      const originalProof = candidateMetadata.test_attestation;
      const originalTrust = candidateMetadata.trust;
      assertEquals(originalProof?.schema_version, 2);
      assertExists(originalTrust);

      // A genuinely signed, structurally clean V1 record remains historical
      // evidence only. It cannot make gx.project advertise a candidate or
      // satisfy an owner/API-token guarded promotion.
      const legacyProof = {
        schema_version: 1 as const,
        attestation_id: originalProof!.attestation_id,
        mode: originalProof!.mode,
        source_hash: originalProof!.source_hash,
        tested_at: originalProof!.tested_at,
        token_expires_at: originalProof!.token_expires_at,
        verified_at: originalProof!.verified_at,
      };
      candidateMetadata.test_attestation = legacyProof;
      candidateMetadata.trust = await buildVersionTrustMetadata({
        appId,
        version: "1.0.1",
        runtime: "deno",
        manifest: appRow.manifest,
        files: [],
        executable: exactCandidate,
        testAttestation: legacyProof,
      });
      const legacyProject = await call("gx.project", { app_id: appId });
      const legacyRelease = legacyProject.capsule as {
        release?: {
          candidate_version?: string | null;
          candidate_tested?: boolean;
        };
      };
      assertEquals(legacyRelease.release?.candidate_version, null);
      assertEquals(legacyRelease.release?.candidate_tested, false);
      const cleanLegacySteps: string[] = [];
      let cleanLegacyMessage = "";
      try {
        await executeSetVersion(
          OWNER_ID,
          { app_id: appId, version: "1.0.1" },
          {
            requireTestAttestation: true,
            beforeIrreversibleStep: async (step) => {
              cleanLegacySteps.push(step);
            },
          },
        );
      } catch (error) {
        cleanLegacyMessage = error instanceof Error
          ? error.message
          : String(error);
      }
      assert(
        cleanLegacyMessage.includes("current V2 gx.test qualification"),
        cleanLegacyMessage ||
          "Expected trust-sensitive promotion to reject clean V1 evidence",
      );
      assertEquals(cleanLegacySteps, []);
      assertEquals(appRow.current_version, "1.0.0");
      candidateMetadata.test_attestation = originalProof;
      candidateMetadata.trust = originalTrust;

      // Replacing a V2 proof body with a structurally valid legacy V1 body
      // must not bypass the signed qualification digest carried by trust.
      candidateMetadata.test_attestation = {
        schema_version: 1,
        attestation_id: originalProof!.attestation_id,
        mode: originalProof!.mode,
        source_hash: originalProof!.source_hash,
        tested_at: originalProof!.tested_at,
        token_expires_at: originalProof!.token_expires_at,
        verified_at: originalProof!.verified_at,
      };
      const downgradeSteps: string[] = [];
      let downgradeMessage = "";
      try {
        await executeSetVersion(
          OWNER_ID,
          { app_id: appId, version: "1.0.1" },
          {
            requireTestAttestation: true,
            beforeIrreversibleStep: async (step) => {
              downgradeSteps.push(step);
            },
          },
        );
      } catch (error) {
        downgradeMessage = error instanceof Error
          ? error.message
          : String(error);
      }
      candidateMetadata.test_attestation = originalProof;
      assert(
        downgradeMessage.includes(
          "invalid or incomplete qualification evidence",
        ),
        downgradeMessage ||
          "Expected promotion to reject a V2-to-V1 proof downgrade",
      );
      assertEquals(downgradeSteps, []);
      assertEquals(appRow.current_version, "1.0.0");

      // Removing the V2 marker cannot turn that forged legacy body into a
      // valid V1 record: the marker is part of the signed trust envelope.
      candidateMetadata.test_attestation = {
        schema_version: 1,
        attestation_id: originalProof!.attestation_id,
        mode: originalProof!.mode,
        source_hash: originalProof!.source_hash,
        tested_at: originalProof!.tested_at,
        token_expires_at: originalProof!.token_expires_at,
        verified_at: originalProof!.verified_at,
      };
      candidateMetadata.trust = { ...originalTrust };
      delete candidateMetadata.trust.test_attestation_digest;
      const markerRemovalSteps: string[] = [];
      let markerRemovalMessage = "";
      try {
        await executeSetVersion(
          OWNER_ID,
          { app_id: appId, version: "1.0.1" },
          {
            requireTestAttestation: true,
            beforeIrreversibleStep: async (step) => {
              markerRemovalSteps.push(step);
            },
          },
        );
      } catch (error) {
        markerRemovalMessage = error instanceof Error
          ? error.message
          : String(error);
      }
      candidateMetadata.test_attestation = originalProof;
      candidateMetadata.trust = originalTrust;
      assert(
        markerRemovalMessage.includes("invalid signed release metadata"),
        markerRemovalMessage ||
          "Expected promotion to reject removal of a signed V2 marker",
      );
      assertEquals(markerRemovalSteps, []);
      assertEquals(appRow.current_version, "1.0.0");

      // The latest metadata row for a version is authoritative. A replacement
      // row without proof must not fall back to an older qualified duplicate.
      appRow.version_metadata!.push({
        version: "1.0.1",
        size_bytes: 0,
      });
      const duplicateSteps: string[] = [];
      let duplicateMessage = "";
      try {
        await executeSetVersion(
          OWNER_ID,
          { app_id: appId, version: "1.0.1" },
          {
            requireTestAttestation: true,
            beforeIrreversibleStep: async (step) => {
              duplicateSteps.push(step);
            },
          },
        );
      } catch (error) {
        duplicateMessage = error instanceof Error
          ? error.message
          : String(error);
      }
      appRow.version_metadata!.pop();
      assert(
        duplicateMessage.includes(
          "staged with a verified gx.test attestation",
        ),
        duplicateMessage ||
          "Expected promotion to reject the authoritative proof-less row",
      );
      assertEquals(duplicateSteps, []);
      assertEquals(appRow.current_version, "1.0.0");

      // Candidate readiness is committed only after the exact versioned
      // executable is durable. A KV failure may leave unreferenced R2 bytes,
      // but must not create version/trust metadata that gx.project can see.
      const ghostFiles = source("1.0.2", "ghost");
      const ghostTest = await call("gx.test", { files: ghostFiles });
      harness.codeCache.failNextPutPrefix = `esm:${appId}:1.0.2`;
      const ghostResponse = await handlePlatformMcp(
        new Request("https://wave3.ultralight.test/mcp/platform", {
          method: "POST",
          headers: authHeaders(OWNER_BUILDER_TOKEN),
          body: JSON.stringify(
            rpcRequest("tools/call", {
              name: "gx.upload",
              arguments: {
                app_id: appId,
                version: "1.0.2",
                files: ghostFiles,
                test_attestation: ghostTest.test_attestation,
              },
            }),
          ),
        }),
      );
      const ghostPayload = await parseJson(ghostResponse);
      const ghostResult = ghostPayload.result as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      assertEquals(ghostResult.isError, true);
      assert(
        String(ghostResult.content?.[0]?.text).includes(
          "could not write ESM bundle to KV",
        ),
      );
      assertEquals(appRow.versions?.includes("1.0.2"), false);
      assertEquals(
        appRow.version_metadata?.some((entry) => entry.version === "1.0.2"),
        false,
      );

      // A valid live-bundle sidecar would not make these substituted bytes the
      // gx.test subject. Promotion must stop before migrations/live KV/DB.
      await harness.codeCache.put(
        `esm:${appId}:1.0.1`,
        `${exactCandidate}\n// replaced after upload`,
      );
      const steps: string[] = [];
      let rejectionMessage = "";
      try {
        await executeSetVersion(
          OWNER_ID,
          { app_id: appId, version: "1.0.1" },
          {
            requireTestAttestation: true,
            beforeIrreversibleStep: async (step) => {
              steps.push(step);
            },
          },
        );
      } catch (error) {
        rejectionMessage = error instanceof Error
          ? error.message
          : String(error);
      }
      assert(
        rejectionMessage.includes("executable differs from gx.test"),
        rejectionMessage || "Expected promotion to reject substituted bytes",
      );
      assertEquals(steps, []);
      assertEquals(
        harness.apps.find((app) => app.id === appId)?.current_version,
        "1.0.0",
      );

      await harness.codeCache.put(`esm:${appId}:1.0.1`, exactCandidate);
      await executeSetVersion(
        OWNER_ID,
        { app_id: appId, version: "1.0.1" },
        {
          requireTestAttestation: true,
          afterQualificationSnapshot: async () => {
            const prefix = `apps/${appId}/1.0.1/`;
            await harness.r2.put(
              `${prefix}manifest.json`,
              new TextEncoder().encode(JSON.stringify({
                name: "Injected after qualification",
                version: "9.9.9",
                type: "mcp",
                entry: { functions: "index.ts" },
                functions: {
                  injected: {
                    description: "Must never enter the live projection.",
                  },
                },
              })),
            );
            await harness.r2.put(
              `${prefix}_source_index.ts`,
              new TextEncoder().encode(
                "export function injected() { return { injected: true }; }",
              ),
            );
            await harness.r2.put(
              `${prefix}migrations/999_injected.sql`,
              new TextEncoder().encode(`
CREATE TABLE injected_rows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);
CREATE INDEX idx_injected_rows_user ON injected_rows(user_id);
`),
            );
          },
          beforeIrreversibleStep: async (step) => {
            steps.push(step);
          },
        },
      );
      assertEquals(steps, [
        "live_bundle",
        "app_record",
        "storage_accounting",
      ]);
      assertEquals(
        harness.apps.find((app) => app.id === appId)?.current_version,
        "1.0.1",
      );
      const promoted = harness.apps.find((app) => app.id === appId);
      assertEquals(promoted?.exports, ["inspect"]);
      assertEquals(
        JSON.parse(String(promoted?.manifest)).name,
        "Qualified Promotion",
      );
      assertEquals(
        JSON.parse(String(promoted?.manifest)).functions.injected,
        undefined,
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
        "promotion fencing aborts before the first guarded external write",
        async () => {
          const beforeLive = harness.codeCache.read(`esm:${appId}:latest`);
          const beforeVersion = row.current_version;
          let stoppedAt: string | null = null;
          let threw = false;
          try {
            await executeSetVersion(
              OWNER_ID,
              { app_id: appId, version: "1.0.0" },
              {
                beforeIrreversibleStep: async (step) => {
                  stoppedAt = step;
                  throw new Error("lease lost");
                },
              },
            );
          } catch {
            threw = true;
          }
          assertEquals(threw, true);
          assertEquals(stoppedAt, "live_bundle");
          assertEquals(
            harness.codeCache.read(`esm:${appId}:latest`),
            beforeLive,
          );
          assertEquals(row.current_version, beforeVersion);
        },
      );

      await t.step(
        "fast path: set version=1.0.0 copies the retained per-version bundle to :latest",
        async () => {
          // Precondition: the runtime is serving v2.
          assertEquals(
            harness.codeCache.read(`esm:${appId}:latest`),
            V2_BUNDLE,
          );

          const payload = await callSet("1.0.0");
          const result = expectToolSuccess(payload);
          assertEquals(result.live_version, "1.0.0");

          // The bundle the runtime loads is now v1 — the actual rollback.
          assertEquals(
            harness.codeCache.read(`esm:${appId}:latest`),
            V1_BUNDLE,
          );
        },
      );

      await t.step(
        "every irreversible promotion phase is fenced in order",
        async () => {
          const steps: string[] = [];
          await executeSetVersion(
            OWNER_ID,
            { app_id: appId, version: "2.0.0" },
            {
              beforeIrreversibleStep: async (step) => {
                steps.push(step);
              },
            },
          );
          assertEquals(steps, [
            "live_bundle",
            "app_record",
            "storage_accounting",
          ]);
          assertEquals(row.current_version, "2.0.0");
          assertEquals(
            harness.codeCache.read(`esm:${appId}:latest`),
            V2_BUNDLE,
          );
        },
      );

      await t.step(
        "a post-switch accounting failure remains detectable and repairable",
        async () => {
          const recordedBefore = Number(row.storage_bytes || 0);
          harness.failNextStorageAccounting = true;
          let threw = false;
          try {
            await executeSetVersion(OWNER_ID, {
              app_id: appId,
              version: "1.0.0",
            });
          } catch {
            threw = true;
          }
          assertEquals(threw, true);
          assertEquals(row.current_version, "1.0.0");
          assertEquals(
            harness.codeCache.read(`esm:${appId}:latest`),
            V1_BUNDLE,
          );
          assertEquals(Number(row.storage_bytes || 0), recordedBefore);

          const partial = await inspectLiveAppStorageAccounting(
            OWNER_ID,
            appId,
            "1.0.0",
          );
          assertEquals(partial.current, false);

          await executeSetVersion(OWNER_ID, {
            app_id: appId,
            version: "1.0.0",
          });
          const repaired = await inspectLiveAppStorageAccounting(
            OWNER_ID,
            appId,
            "1.0.0",
          );
          assertEquals(repaired.current, true);
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

      await t.step(
        "a direct set cannot touch live KV while Agent Home owns the durable promotion fence",
        async () => {
          harness.seedActivePromotion(appId, OWNER_ID, "2.0.0");
          const beforeLive = harness.codeCache.read(`esm:${appId}:latest`);
          const beforeVersion = row.current_version;
          const payload = await callSet("1.0.0");
          assert(
            typeof payload.error === "object",
            "The competing direct promotion must be rejected",
          );
          assertEquals(
            harness.codeCache.read(`esm:${appId}:latest`),
            beforeLive,
          );
          assertEquals(row.current_version, beforeVersion);
        },
      );
    } finally {
      restore();
    }
  },
});
