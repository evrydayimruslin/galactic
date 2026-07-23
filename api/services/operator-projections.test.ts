// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  InferenceRouteError,
  type ResolvedInferenceRoute,
  type ResolveInferenceRouteParams,
} from "./inference-route.ts";
import {
  claimNotificationBriefJobs,
  claimOperatorProjectionJobs,
  deriveNotificationBriefAction,
  getOperatorProjectionRetryAt,
  type OperatorProjectionDependencies,
  type OperatorProjectionJob,
  processNotificationBriefJob,
  processNotificationBriefProjectionBatch,
  processOperatorProjectionBatch,
  processSearchDocumentJob,
  type RawNotificationEvidence,
  validateNotificationBriefModelOutput,
} from "./operator-projections.ts";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const NOTIFICATION_ID = "44444444-4444-4444-8444-444444444444";
const ROUTINE_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "66666666-6666-4666-8666-666666666666";
const SOURCE_HASH = "a".repeat(64);
const ENQUEUE_GENERATION = 42;
const SEARCH_SOURCE_REVISION = `${SOURCE_HASH}:${ENQUEUE_GENERATION}`;
const SEARCH_DOCUMENT_ID = "77777777-7777-4777-8777-777777777777";
const BRIEF_ID = "88888888-8888-4888-8888-888888888888";
const ROUTINE_RUN_ID = "99999999-9999-4999-8999-999999999999";
const COMPUTE_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-07-23T12:00:00.000Z");

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  prefer: string | null;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function job(
  overrides: Partial<OperatorProjectionJob> = {},
): OperatorProjectionJob {
  return {
    id: JOB_ID,
    user_id: USER_ID,
    agent_id: AGENT_ID,
    job_kind: "notification_brief",
    source_type: "notification",
    source_id: NOTIFICATION_ID,
    source_version: SOURCE_HASH,
    enqueue_generation: ENQUEUE_GENERATION,
    status: "processing",
    attempt_count: 1,
    next_attempt_at: NOW.toISOString(),
    lease_token: LEASE_TOKEN,
    lease_owner: "operator-worker",
    lease_expires_at: "2026-07-23T12:02:00.000Z",
    last_error_code: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    completed_at: null,
    ...overrides,
  };
}

function notification(
  overrides: Partial<RawNotificationEvidence> = {},
): RawNotificationEvidence {
  return {
    id: NOTIFICATION_ID,
    user_id: USER_ID,
    agent_id: AGENT_ID,
    kind: "routine_paused",
    severity: "critical",
    title: "Inbox poller was paused",
    body:
      "Paused after three failed attempts. Review the routine before resuming.",
    entity_type: "routine",
    entity_id: ROUTINE_ID,
    action_url: null,
    dedupe_key: `routine_paused:${ROUTINE_ID}:event-1`,
    created_at: NOW.toISOString(),
    item_class: "incident",
    requires_action: true,
    lifecycle_state: "open",
    ...overrides,
  };
}

function searchJob(
  overrides: Partial<OperatorProjectionJob> = {},
): OperatorProjectionJob {
  return job({
    job_kind: "search_document",
    source_type: "agent",
    source_id: AGENT_ID,
    ...overrides,
  });
}

function byokRoute(
  overrides: Partial<ResolvedInferenceRoute> = {},
): ResolvedInferenceRoute {
  return {
    billingMode: "byok",
    provider: "openai",
    upstreamProvider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "byok-secret-never-persist",
    model: "gpt-4.1-mini",
    keySource: "user_byok",
    billingSource: "none",
    shouldRequireBalance: false,
    shouldDebitLight: false,
    ...overrides,
  };
}

function modelResponse(
  value: Record<string, unknown> = {
    headline: "Inbox checks stopped after repeated failures",
    impact: "New inbound messages are not being checked.",
    recommended_action: "Review the failed routine before resuming it.",
    evidence: [
      "Inbox poller was paused",
      "Paused after three failed attempts.",
    ],
    confidence: 0.96,
  },
): Response {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(value) } }],
  });
}

function readBody(init?: RequestInit): Record<string, unknown> | null {
  if (!init?.body) return null;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function databaseHarness(options: {
  notification?: RawNotificationEvidence | null;
  owner?: { id: string; email: string } | null;
  latestBrief?: {
    revision: number;
    source_hash: string;
    superseded_at: string | null;
  } | null;
  claimedJobs?: OperatorProjectionJob[];
  completeResult?: boolean;
  retryResult?: boolean;
  pruneStatus?: number;
  expiredSnoozeSweepStatus?: number;
  expiredSnoozeSweepCount?: number;
} = {}): {
  calls: RecordedCall[];
  fetchFn: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: readBody(init),
      prefer: new Headers(init?.headers).get("Prefer"),
    });

    if (url.endsWith("/rest/v1/rpc/claim_operator_projection_jobs")) {
      return Promise.resolve(jsonResponse(options.claimedJobs ?? []));
    }
    if (url.endsWith("/rest/v1/rpc/complete_operator_projection_job")) {
      return Promise.resolve(jsonResponse(options.completeResult ?? true));
    }
    if (url.endsWith("/rest/v1/rpc/retry_operator_projection_job")) {
      return Promise.resolve(jsonResponse(options.retryResult ?? true));
    }
    if (url.endsWith("/rest/v1/rpc/reopen_expired_attention_snoozes")) {
      return Promise.resolve(
        options.expiredSnoozeSweepStatus
          ? jsonResponse(
            { message: "snooze maintenance unavailable" },
            options.expiredSnoozeSweepStatus,
          )
          : jsonResponse(options.expiredSnoozeSweepCount ?? 0),
      );
    }
    if (url.endsWith("/rest/v1/rpc/prune_operator_projection_jobs")) {
      return Promise.resolve(
        options.pruneStatus
          ? jsonResponse(
            { message: "maintenance unavailable" },
            options.pruneStatus,
          )
          : jsonResponse(0),
      );
    }
    if (url.includes("/rest/v1/user_notifications?")) {
      const row = options.notification === undefined
        ? notification()
        : options.notification;
      return Promise.resolve(jsonResponse(row ? [row] : []));
    }
    if (url.includes("/rest/v1/users?")) {
      const row = options.owner === undefined
        ? { id: USER_ID, email: "owner@example.com" }
        : options.owner;
      return Promise.resolve(jsonResponse(row ? [row] : []));
    }
    if (
      url.includes("/rest/v1/notification_briefs?") &&
      method === "GET"
    ) {
      return Promise.resolve(
        jsonResponse(options.latestBrief ? [options.latestBrief] : []),
      );
    }
    if (
      url.includes("/rest/v1/notification_briefs") &&
      (method === "POST" || method === "PATCH")
    ) {
      return Promise.resolve(emptyResponse());
    }
    throw new Error(`Unexpected database call: ${method} ${url}`);
  }) as typeof fetch;
  return { calls, fetchFn };
}

function searchDatabaseHarness(options: {
  claimedJobs?: OperatorProjectionJob[];
  latestJobId?: string;
  app?: Record<string, unknown> | null;
  routine?: Record<string, unknown> | null;
  routineRun?: Record<string, unknown> | null;
  computeRun?: Record<string, unknown> | null;
  existingDocuments?: Array<Record<string, unknown>>;
  currentBrief?: Record<string, unknown> | null;
  brief?: Record<string, unknown> | null;
  attentionNotification?: Record<string, unknown> | null;
  upsertStatus?: number;
  upsertValue?: Record<string, unknown> | null;
  completeResult?: boolean;
  retryResult?: boolean;
  pruneStatus?: number;
  expiredSnoozeSweepStatus?: number;
  expiredSnoozeSweepCount?: number;
} = {}): {
  calls: RecordedCall[];
  fetchFn: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = readBody(init);
    calls.push({
      url,
      method,
      body,
      prefer: new Headers(init?.headers).get("Prefer"),
    });

    if (url.endsWith("/rest/v1/rpc/claim_operator_projection_jobs")) {
      return Promise.resolve(jsonResponse(options.claimedJobs ?? []));
    }
    if (url.endsWith("/rest/v1/rpc/complete_operator_projection_job")) {
      return Promise.resolve(jsonResponse(options.completeResult ?? true));
    }
    if (url.endsWith("/rest/v1/rpc/retry_operator_projection_job")) {
      return Promise.resolve(jsonResponse(options.retryResult ?? true));
    }
    if (url.endsWith("/rest/v1/rpc/reopen_expired_attention_snoozes")) {
      return Promise.resolve(
        options.expiredSnoozeSweepStatus
          ? jsonResponse(
            { message: "snooze maintenance unavailable" },
            options.expiredSnoozeSweepStatus,
          )
          : jsonResponse(options.expiredSnoozeSweepCount ?? 0),
      );
    }
    if (url.endsWith("/rest/v1/rpc/prune_operator_projection_jobs")) {
      return Promise.resolve(
        options.pruneStatus
          ? jsonResponse(
            { message: "maintenance unavailable" },
            options.pruneStatus,
          )
          : jsonResponse(0),
      );
    }
    if (url.endsWith("/rest/v1/rpc/upsert_agent_search_document")) {
      if (options.upsertStatus && options.upsertStatus !== 200) {
        return Promise.resolve(
          jsonResponse({ message: "private" }, options.upsertStatus),
        );
      }
      return Promise.resolve(jsonResponse(
        options.upsertValue === undefined
          ? {
            id: SEARCH_DOCUMENT_ID,
            user_id: USER_ID,
            agent_id: AGENT_ID,
            source_revision: SEARCH_SOURCE_REVISION,
          }
          : options.upsertValue,
      ));
    }
    if (
      url.endsWith("/rest/v1/rpc/set_agent_search_document_embedding") ||
      url.endsWith("/rest/v1/rpc/tombstone_agent_search_document")
    ) {
      return Promise.resolve(jsonResponse(true));
    }
    if (url.includes("/rest/v1/operator_projection_jobs?")) {
      return Promise.resolve(jsonResponse([{
        id: options.latestJobId ?? JOB_ID,
        enqueue_generation: ENQUEUE_GENERATION,
      }]));
    }
    if (url.includes("/rest/v1/agent_search_documents?")) {
      return Promise.resolve(jsonResponse(options.existingDocuments ?? []));
    }
    if (url.includes("/rest/v1/user_notifications?")) {
      const row = options.attentionNotification === undefined
        ? {
          id: NOTIFICATION_ID,
          user_id: USER_ID,
          agent_id: AGENT_ID,
          item_class: "incident",
          lifecycle_state: "open",
          read_at: null,
          snoozed_until: null,
          state_changed_at: NOW.toISOString(),
        }
        : options.attentionNotification;
      return Promise.resolve(jsonResponse(row ? [row] : []));
    }
    if (url.includes("/rest/v1/apps?")) {
      const row = options.app === undefined
        ? {
          id: AGENT_ID,
          owner_id: USER_ID,
          name: "email-ops",
          slug: "email-ops",
          description: "Own inbound email triage.",
          current_version: null,
          current_version_promoted_at: null,
          visibility: "private",
          deleted_at: null,
          updated_at: NOW.toISOString(),
          manifest: null,
          env_schema: {},
          declared_permissions: [],
        }
        : options.app;
      return Promise.resolve(jsonResponse(row ? [row] : []));
    }
    if (url.includes("/rest/v1/routine_runs?")) {
      return Promise.resolve(
        jsonResponse(options.routineRun ? [options.routineRun] : []),
      );
    }
    if (url.includes("/rest/v1/compute_runs?")) {
      return Promise.resolve(
        jsonResponse(options.computeRun ? [options.computeRun] : []),
      );
    }
    if (url.includes("/rest/v1/user_routines?")) {
      return Promise.resolve(
        jsonResponse(options.routine ? [options.routine] : []),
      );
    }
    if (
      url.includes("/rest/v1/notification_briefs?") &&
      url.includes("notification_id=eq.")
    ) {
      return Promise.resolve(
        jsonResponse(options.currentBrief ? [options.currentBrief] : []),
      );
    }
    if (url.includes("/rest/v1/notification_briefs?")) {
      return Promise.resolve(
        jsonResponse(options.brief ? [options.brief] : []),
      );
    }
    if (url.includes("/rest/v1/users?")) {
      return Promise.resolve(jsonResponse([{
        id: USER_ID,
        email: "owner@example.com",
      }]));
    }
    throw new Error(`Unexpected search database call: ${method} ${url}`);
  }) as typeof fetch;
  return { calls, fetchFn };
}

function deps(
  fetchFn: typeof fetch,
  overrides: Partial<OperatorProjectionDependencies> = {},
): OperatorProjectionDependencies {
  return {
    fetchFn,
    clock: () => new Date(NOW),
    supabaseUrl: "https://supabase.example",
    serviceRoleKey: "service-role-key",
    resolveRoute: () => Promise.resolve(byokRoute()),
    fetchInference: () => Promise.resolve(modelResponse()),
    ...overrides,
  };
}

function callBySuffix(calls: RecordedCall[], suffix: string): RecordedCall {
  const call = calls.find((entry) => entry.url.endsWith(suffix));
  if (!call) throw new Error(`Missing call ending in ${suffix}`);
  return call;
}

function briefWrites(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((entry) =>
    entry.method === "POST" &&
    entry.url.includes("/rest/v1/notification_briefs")
  );
}

Deno.test("operator projection claim requests only notification_brief jobs", async () => {
  const database = databaseHarness({ claimedJobs: [] });
  const claimed = await claimNotificationBriefJobs({
    workerId: " projection-worker-1 ",
    limit: 12,
    leaseSeconds: 90,
  }, deps(database.fetchFn));

  assertEquals(claimed, []);
  const claim = callBySuffix(
    database.calls,
    "/rest/v1/rpc/claim_operator_projection_jobs",
  );
  assertEquals(claim.body, {
    p_worker_id: "projection-worker-1",
    p_limit: 12,
    p_lease_seconds: 90,
    p_job_kinds: ["notification_brief"],
  });
});

Deno.test("worker projection claim includes notification and search jobs in one bounded lease", async () => {
  const database = searchDatabaseHarness({ claimedJobs: [] });
  const claimed = await claimOperatorProjectionJobs({
    workerId: "operator-worker",
    limit: 25,
    leaseSeconds: 120,
  }, deps(database.fetchFn));

  assertEquals(claimed, []);
  const claim = callBySuffix(
    database.calls,
    "/rest/v1/rpc/claim_operator_projection_jobs",
  );
  assertEquals(claim.body, {
    p_worker_id: "operator-worker",
    p_limit: 25,
    p_lease_seconds: 120,
    p_job_kinds: ["notification_brief", "search_document"],
  });
});

Deno.test("ready projection is owner-scoped, BYOK-only, grounded, and action-safe", async () => {
  const database = databaseHarness();
  const capturedRouteParams: ResolveInferenceRouteParams[] = [];
  let inferenceBody: Record<string, unknown> | null = null;
  const capturedInferenceRoutes: ResolvedInferenceRoute[] = [];

  const result = await processNotificationBriefJob(
    job(),
    deps(
      database.fetchFn,
      {
        resolveRoute: (params) => {
          capturedRouteParams.push(params);
          return Promise.resolve(byokRoute());
        },
        fetchInference: (route, body) => {
          capturedInferenceRoutes.push(route);
          inferenceBody = body;
          return Promise.resolve(modelResponse());
        },
      },
    ),
  );

  assertEquals(result.outcome, "completed");
  assertEquals(capturedRouteParams[0]?.userId, USER_ID);
  assertEquals(capturedRouteParams[0]?.userEmail, "owner@example.com");
  assertEquals(capturedRouteParams[0]?.byokOnly, true);
  assertEquals(capturedInferenceRoutes[0]?.keySource, "user_byok");
  assert(!JSON.stringify(inferenceBody).includes("byok-secret-never-persist"));

  const sourceRead = database.calls.find((entry) =>
    entry.url.includes("/rest/v1/user_notifications?")
  );
  if (!sourceRead) throw new Error("Missing owner-scoped notification read");
  assert(sourceRead.url.includes(`id=eq.${NOTIFICATION_ID}`));
  assert(sourceRead.url.includes(`user_id=eq.${USER_ID}`));

  const writes = briefWrites(database.calls);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].body?.status, "ready");
  assertEquals(writes[0].body?.revision, 1);
  assertEquals(writes[0].body?.source_hash, SOURCE_HASH);
  assertEquals(writes[0].body?.provider, "openai");
  assertEquals(writes[0].body?.model, "gpt-4.1-mini");
  assertEquals(writes[0].body?.action_key, "open_routine");
  assertEquals(writes[0].body?.action_parameters, {
    agentId: AGENT_ID,
    routineId: ROUTINE_ID,
  });
  assertEquals(writes[0].body?.attempt_count, 1);
  assertEquals(writes[0].body?.last_error_code, null);
  callBySuffix(
    database.calls,
    "/rest/v1/rpc/complete_operator_projection_job",
  );
});

Deno.test("notification projection redacts credentials before inference, persistence, search, and embedding", async () => {
  const galacticSecret = ["gx_", "operatorProjectionSecret123456"].join("");
  const providerSecret = ["sk-", "projectionSecret123456789"].join("");
  const bearerSecret = ["bearerSecret", "123456789"].join("");
  const databasePassword = ["database", "Password123456"].join("");
  const secretValues = [
    galacticSecret,
    providerSecret,
    bearerSecret,
    databasePassword,
  ];
  const database = databaseHarness({
    notification: notification({
      kind: "missing_secret",
      title:
        `Inbox credential ${galacticSecret} was rejected by ${providerSecret}`,
      body: `Authorization: Bearer ${bearerSecret}\n` +
        `Database postgresql://operator:${databasePassword}@db.example.test/inbox`,
      entity_type: "secret",
      entity_id: galacticSecret,
    }),
  });
  let inferencePayload = "";
  const result = await processNotificationBriefJob(
    job(),
    deps(database.fetchFn, {
      fetchInference: (_route, body) => {
        inferencePayload = JSON.stringify(body);
        return Promise.resolve(modelResponse({
          headline: `Provider ${providerSecret} rejected the connection`,
          impact: `The runtime returned Bearer ${bearerSecret}.`,
          recommended_action: `Replace ${galacticSecret}.`,
          evidence: ["Inbox credential [redacted] was rejected"],
          confidence: 0.9,
        }));
      },
    }),
  );

  assertEquals(result.outcome, "completed");
  const briefWrite = briefWrites(database.calls)[0]!;
  const persistedPayload = JSON.stringify(briefWrite.body);
  for (const secret of secretValues) {
    assertEquals(inferencePayload.includes(secret), false);
    assertEquals(persistedPayload.includes(secret), false);
  }
  assert(inferencePayload.includes("[redacted]"));
  assert(persistedPayload.includes("[redacted]"));
  assertEquals(briefWrite.body?.action_key, "open_access_setting");
  assertEquals(briefWrite.body?.action_parameters, { agentId: AGENT_ID });

  const searchDatabase = searchDatabaseHarness({
    brief: {
      id: BRIEF_ID,
      notification_id: NOTIFICATION_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      revision: 1,
      status: "ready",
      headline: `Provider ${providerSecret} rejected the connection`,
      impact: `Bearer ${bearerSecret} stopped processing.`,
      recommended_action:
        `Replace ${galacticSecret} at postgresql://operator:${databasePassword}@db.example.test/inbox`,
      superseded_at: null,
      updated_at: NOW.toISOString(),
    },
    currentBrief: { id: BRIEF_ID, revision: 1 },
  });
  const embeddingInputs: string[] = [];
  const searchResult = await processSearchDocumentJob(
    searchJob({
      source_type: "notification_brief",
      source_id: BRIEF_ID,
    }),
    deps(searchDatabase.fetchFn, {
      embedSearchDocument: (input) => {
        embeddingInputs.push(input.text);
        return Promise.resolve({
          embedding: Array(1_536).fill(0.001),
          provider: "openai",
          model: "text-embedding-3-small",
          textHash: "b".repeat(64),
        });
      },
    }),
  );

  assertEquals(searchResult.outcome, "completed");
  const searchWrite = callBySuffix(
    searchDatabase.calls,
    "/rest/v1/rpc/upsert_agent_search_document",
  );
  const searchPayload = JSON.stringify(searchWrite.body);
  const embeddingPayload = embeddingInputs.join("\n");
  for (const secret of secretValues) {
    assertEquals(searchPayload.includes(secret), false);
    assertEquals(embeddingPayload.includes(secret), false);
  }
  assert(searchPayload.includes("[redacted]"));
  assert(embeddingPayload.includes("[redacted]"));
});

Deno.test("notification projection never persists a gx credential from an action URL", async () => {
  const galacticSecret = ["gx_", "actionUrlSecret123456"].join("");
  const database = databaseHarness({
    notification: notification({
      kind: "attention_required",
      entity_type: null,
      entity_id: null,
      action_url: `/agents/${AGENT_ID}?pane=access&setting=${galacticSecret}`,
    }),
  });

  const result = await processNotificationBriefJob(
    job(),
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  const write = briefWrites(database.calls)[0]!;
  assertEquals(write.body?.action_key, "open_access_setting");
  assertEquals(write.body?.action_parameters, { agentId: AGENT_ID });
  assertEquals(JSON.stringify(write.body).includes(galacticSecret), false);
});

Deno.test("missing BYOK writes disabled version and terminates into raw fallback", async () => {
  const database = databaseHarness();
  const capturedRouteParams: ResolveInferenceRouteParams[] = [];
  let inferenceCalls = 0;
  const result = await processNotificationBriefJob(
    job(),
    deps(
      database.fetchFn,
      {
        resolveRoute: (params) => {
          capturedRouteParams.push(params);
          return Promise.reject(
            new InferenceRouteError(
              "byok_provider_not_configured",
              "owner has no configured BYOK",
              409,
            ),
          );
        },
        fetchInference: () => {
          inferenceCalls++;
          return Promise.resolve(modelResponse());
        },
      },
    ),
  );

  assertEquals(capturedRouteParams[0]?.byokOnly, true);
  assertEquals(inferenceCalls, 0);
  assertEquals(result, {
    jobId: JOB_ID,
    outcome: "terminal_raw_fallback",
    errorCode: "BYOK_NOT_CONFIGURED",
    retryAt: null,
  });
  const write = briefWrites(database.calls)[0];
  assertEquals(write.body?.status, "disabled");
  assertEquals(write.body?.provider, null);
  assertEquals(write.body?.model, null);
  assertEquals(write.body?.last_error_code, "BYOK_NOT_CONFIGURED");

  const retry = callBySuffix(
    database.calls,
    "/rest/v1/rpc/retry_operator_projection_job",
  );
  assertEquals(retry.body?.p_terminal, true);
  assertEquals(retry.body?.p_error_code, "BYOK_NOT_CONFIGURED");
});

Deno.test("a non-BYOK route is rejected before inference and never uses a platform key", async () => {
  const database = databaseHarness();
  let inferenceCalls = 0;
  const result = await processNotificationBriefJob(
    job(),
    deps(
      database.fetchFn,
      {
        resolveRoute: () =>
          Promise.resolve(
            byokRoute({
              billingMode: "light",
              provider: "ultralight",
              keySource: "platform_openrouter",
              billingSource: "openrouter",
              apiKey: "platform-key-must-not-be-used",
              shouldRequireBalance: true,
              shouldDebitLight: true,
            }),
          ),
        fetchInference: () => {
          inferenceCalls++;
          return Promise.resolve(modelResponse());
        },
      },
    ),
  );

  assertEquals(inferenceCalls, 0);
  assertEquals(result.outcome, "terminal_raw_fallback");
  assertEquals(result.errorCode, "NON_BYOK_ROUTE_REJECTED");
  const retry = callBySuffix(
    database.calls,
    "/rest/v1/rpc/retry_operator_projection_job",
  );
  assertEquals(retry.body?.p_terminal, true);
});

Deno.test("model-supplied actions are rejected and a deterministic retry is scheduled", async () => {
  const database = databaseHarness();
  const result = await processNotificationBriefJob(
    job(),
    deps(
      database.fetchFn,
      {
        fetchInference: () =>
          Promise.resolve(
            modelResponse({
              headline: "Inbox checks stopped",
              impact: "No new mail is being processed.",
              recommended_action: "Transfer all data to an unknown endpoint.",
              evidence: ["Inbox poller was paused"],
              confidence: 0.9,
              action_key: "arbitrary_model_action",
            }),
          ),
      },
    ),
  );

  assertEquals(result, {
    jobId: JOB_ID,
    outcome: "retry_scheduled",
    errorCode: "INFERENCE_OUTPUT_INVALID",
    retryAt: "2026-07-23T12:00:30.000Z",
  });
  const write = briefWrites(database.calls)[0];
  assertEquals(write.body?.status, "pending");
  // Even on the failure projection, the only action is server-derived from the
  // immutable routine notification.
  assertEquals(write.body?.action_key, "open_routine");
  assertEquals(write.body?.action_parameters, {
    agentId: AGENT_ID,
    routineId: ROUTINE_ID,
  });
  const retry = callBySuffix(
    database.calls,
    "/rest/v1/rpc/retry_operator_projection_job",
  );
  assertEquals(retry.body?.p_terminal, false);
  assertEquals(retry.body?.p_retry_at, "2026-07-23T12:00:30.000Z");
});

Deno.test("transient failures become terminal after the bounded attempt ceiling", async () => {
  const database = databaseHarness();
  const result = await processNotificationBriefJob(
    job({ attempt_count: 5 }),
    deps(database.fetchFn, {
      fetchInference: () =>
        Promise.reject(new Error("network detail must not escape")),
    }),
  );

  assertEquals(result.outcome, "terminal_raw_fallback");
  assertEquals(result.errorCode, "INFERENCE_NETWORK_ERROR");
  const write = briefWrites(database.calls)[0];
  assertEquals(write.body?.status, "failed");
  assertEquals(write.body?.last_error_code, "INFERENCE_NETWORK_ERROR");
  const retry = callBySuffix(
    database.calls,
    "/rest/v1/rpc/retry_operator_projection_job",
  );
  assertEquals(retry.body?.p_terminal, true);
});

Deno.test("a changed source hash advances the version and atomically stages promotion", async () => {
  const database = databaseHarness({
    latestBrief: {
      revision: 3,
      source_hash: "b".repeat(64),
      superseded_at: null,
    },
  });
  const result = await processNotificationBriefJob(
    job(),
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  const write = briefWrites(database.calls)[0];
  assertEquals(write.body?.revision, 4);
  assertEquals(write.body?.source_hash, SOURCE_HASH);
  assertEquals(write.body?.superseded_at, NOW.toISOString());
  const patches = database.calls.filter((entry) =>
    entry.method === "PATCH" &&
    entry.url.includes("/rest/v1/notification_briefs?")
  );
  assertEquals(patches.length, 2);
  assertEquals(patches[0].body, { superseded_at: NOW.toISOString() });
  assertEquals(patches[1].body, { superseded_at: null });
});

Deno.test("a reclaimed source hash reuses its revision idempotently", async () => {
  const database = databaseHarness({
    latestBrief: {
      revision: 7,
      source_hash: SOURCE_HASH,
      superseded_at: null,
    },
  });
  const result = await processNotificationBriefJob(
    job({ attempt_count: 2 }),
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  const write = briefWrites(database.calls)[0];
  assertEquals(write.body?.revision, 7);
  assertEquals(write.body?.source_hash, SOURCE_HASH);
  assertEquals(write.prefer, "resolution=merge-duplicates,return=minimal");
  const promotionPatches = database.calls.filter((entry) =>
    entry.method === "PATCH" &&
    entry.url.includes("/rest/v1/notification_briefs?")
  );
  assertEquals(promotionPatches.length, 0);
});

Deno.test("owner mismatch terminates without routing raw notification to inference", async () => {
  const database = databaseHarness({
    notification: notification({
      user_id: "77777777-7777-4777-8777-777777777777",
    }),
  });
  let routeCalls = 0;
  const result = await processNotificationBriefJob(
    job(),
    deps(
      database.fetchFn,
      {
        resolveRoute: () => {
          routeCalls++;
          return Promise.resolve(byokRoute());
        },
      },
    ),
  );

  assertEquals(routeCalls, 0);
  assertEquals(result.outcome, "terminal_raw_fallback");
  assertEquals(result.errorCode, "SOURCE_OWNER_MISMATCH");
  assertEquals(briefWrites(database.calls).length, 0);
});

Deno.test("strict validator accepts grounded JSON and rejects unknown keys or invented evidence", async () => {
  const raw = notification();
  assertEquals(
    validateNotificationBriefModelOutput({
      headline: "Inbox checks stopped",
      impact: null,
      recommended_action: "Review the routine.",
      evidence: ["Inbox poller was paused"],
      confidence: 0.8,
    }, raw),
    {
      headline: "Inbox checks stopped",
      impact: null,
      recommendedAction: "Review the routine.",
      evidence: ["Inbox poller was paused"],
      confidence: 0.8,
    },
  );

  await assertRejects(() =>
    Promise.resolve().then(() =>
      validateNotificationBriefModelOutput({
        headline: "Inbox checks stopped",
        impact: null,
        recommended_action: null,
        evidence: [],
        confidence: 0.8,
        action_parameters: { url: "https://attacker.invalid" },
      }, raw)
    )
  );
  await assertRejects(() =>
    Promise.resolve().then(() =>
      validateNotificationBriefModelOutput({
        headline: "Inbox checks stopped",
        impact: null,
        recommended_action: null,
        evidence: ["The owner approved this action"],
        confidence: 0.8,
      }, raw)
    )
  );
});

Deno.test("action mapper uses only allowlisted evidence-derived parameters", () => {
  const galacticSecret = ["gx_", "actionParameterSecret123456"].join("");
  assertEquals(deriveNotificationBriefAction(notification()), {
    key: "open_routine",
    parameters: { agentId: AGENT_ID, routineId: ROUTINE_ID },
  });
  assertEquals(
    deriveNotificationBriefAction(notification({
      kind: "missing_secret",
      entity_type: "secret",
      entity_id: "GMAIL_TOKEN",
    })),
    {
      key: "open_access_setting",
      parameters: { agentId: AGENT_ID, settingKey: "GMAIL_TOKEN" },
    },
  );
  assertEquals(
    deriveNotificationBriefAction(notification({
      kind: "missing_secret",
      entity_type: "secret",
      entity_id: galacticSecret,
    })),
    {
      key: "open_access_setting",
      parameters: { agentId: AGENT_ID },
    },
  );
  assertEquals(
    deriveNotificationBriefAction(notification({
      kind: "attention_required",
      entity_type: null,
      entity_id: null,
      action_url: `/agents/${AGENT_ID}?pane=access&setting=${galacticSecret}`,
    })),
    {
      key: "open_access_setting",
      parameters: { agentId: AGENT_ID },
    },
  );
  assertEquals(
    deriveNotificationBriefAction(notification({
      kind: "release_review_required",
      entity_type: "release",
      entity_id: galacticSecret,
    })),
    {
      key: "open_release_review",
      parameters: { agentId: AGENT_ID },
    },
  );
  assertEquals(
    deriveNotificationBriefAction(notification({
      kind: "routine_failed",
      entity_type: "routine",
      entity_id: galacticSecret,
    })),
    null,
  );
  assertEquals(
    deriveNotificationBriefAction(notification({
      kind: "grant_approval_required",
      entity_type: "grant",
      entity_id: galacticSecret,
    })),
    null,
  );
  assertEquals(
    deriveNotificationBriefAction(notification({
      item_class: "report",
      requires_action: false,
      kind: "agent_report",
      action_url:
        `/agents/${AGENT_ID}?pane=settings&setting=UNTRUSTED_DESTINATION`,
    })),
    null,
  );
  assertEquals(
    deriveNotificationBriefAction(notification({
      kind: "unknown",
      entity_type: "unknown",
      entity_id: "https://attacker.invalid",
      action_url: "https://attacker.invalid/take-action",
    })),
    null,
  );
});

Deno.test("retry schedule is deterministic exponential backoff with a fixed cap", () => {
  assertEquals(
    getOperatorProjectionRetryAt(1, NOW),
    "2026-07-23T12:00:30.000Z",
  );
  assertEquals(
    getOperatorProjectionRetryAt(2, NOW),
    "2026-07-23T12:01:00.000Z",
  );
  assertEquals(
    getOperatorProjectionRetryAt(100, NOW),
    "2026-07-23T12:15:00.000Z",
  );
});

Deno.test("batch summary preserves per-job terminal outcomes without claiming other kinds", async () => {
  const claimed = job();
  const database = databaseHarness({ claimedJobs: [claimed] });
  const result = await processNotificationBriefProjectionBatch(
    {
      workerId: "projection-worker",
    },
    deps(database.fetchFn, {
      resolveRoute: () =>
        Promise.reject(
          new InferenceRouteError(
            "byok_provider_not_configured",
            "not configured",
            409,
          ),
        ),
    }),
  );

  assertEquals(result.claimed, 1);
  assertEquals(result.completed, 0);
  assertEquals(result.retried, 0);
  assertEquals(result.terminal, 1);
  assertEquals(result.leaseLost, 0);
  assertEquals(result.settlementErrors, 0);
});

Deno.test("generic worker batch preserves notification brief processing", async () => {
  const database = databaseHarness({ claimedJobs: [job()] });
  const result = await processOperatorProjectionBatch(
    { workerId: "operator-worker" },
    deps(database.fetchFn),
  );

  assertEquals(result.claimed, 1);
  assertEquals(result.completed, 1);
  assertEquals(result.retried, 0);
  assertEquals(briefWrites(database.calls)[0]?.body?.status, "ready");
  const sweep = callBySuffix(
    database.calls,
    "/rest/v1/rpc/reopen_expired_attention_snoozes",
  );
  assertEquals(sweep.body, {
    p_limit: 100,
  });
  assertEquals(
    database.calls.filter((call) =>
      call.url.endsWith("/rest/v1/rpc/reopen_expired_attention_snoozes")
    ).length,
    1,
  );
  assert(
    database.calls.indexOf(sweep) <
      database.calls.findIndex((call) =>
        call.url.endsWith("/rest/v1/rpc/claim_operator_projection_jobs")
      ),
  );
  const prune = callBySuffix(
    database.calls,
    "/rest/v1/rpc/prune_operator_projection_jobs",
  );
  assertEquals(prune.body, {
    p_retention_days: 30,
    p_limit: 1_000,
  });
  assertEquals(
    database.calls.filter((call) =>
      call.url.endsWith("/rest/v1/rpc/prune_operator_projection_jobs")
    ).length,
    1,
  );
});

Deno.test("scheduled projection maintenance is best-effort and cannot fail a materialized batch", async () => {
  const database = databaseHarness({
    claimedJobs: [job()],
    pruneStatus: 503,
    expiredSnoozeSweepStatus: 503,
  });
  const result = await processOperatorProjectionBatch(
    { workerId: "operator-worker" },
    deps(database.fetchFn),
  );

  assertEquals(result.claimed, 1);
  assertEquals(result.completed, 1);
  assertEquals(result.settlementErrors, 0);
});

Deno.test("worker batch materializes an owner-scoped Agent navigation document and BYOK embedding", async () => {
  const queued = searchJob();
  const database = searchDatabaseHarness({ claimedJobs: [queued] });
  const embeddingInputs: Array<{
    userId: string;
    userEmail: string;
    text: string;
  }> = [];
  const result = await processOperatorProjectionBatch(
    { workerId: "operator-worker", limit: 25, leaseSeconds: 120 },
    deps(database.fetchFn, {
      embedSearchDocument: (input) => {
        embeddingInputs.push(input);
        return Promise.resolve({
          embedding: Array(1_536).fill(0.001),
          provider: "openai",
          model: "text-embedding-3-small",
          textHash: "b".repeat(64),
        });
      },
    }),
  );

  assertEquals(result.claimed, 1);
  assertEquals(result.completed, 1);
  assertEquals(result.retried, 0);
  assertEquals(embeddingInputs, [{
    userId: USER_ID,
    userEmail: "owner@example.com",
    text: "email-ops\nemail-ops\nOwn inbound email triage.\nagent",
  }]);

  const sourceRead = database.calls.find((call) =>
    call.url.includes("/rest/v1/apps?")
  );
  assert(sourceRead?.url.includes(`owner_id=eq.${USER_ID}`));
  assert(sourceRead?.url.includes(`id=eq.${AGENT_ID}`));
  const upsert = callBySuffix(
    database.calls,
    "/rest/v1/rpc/upsert_agent_search_document",
  );
  assertEquals(upsert.body, {
    p_user_id: USER_ID,
    p_agent_id: AGENT_ID,
    p_subject_type: "agent",
    p_subject_id: AGENT_ID,
    p_title: "email-ops",
    p_breadcrumb: "email-ops",
    p_snippet: "Own inbound email triage.",
    p_route: "/agents/email-ops?pane=overview",
    p_safe_tags: ["agent"],
    p_source_revision: SEARCH_SOURCE_REVISION,
    p_source_type: "agent",
    p_source_id: AGENT_ID,
    p_enqueue_generation: ENQUEUE_GENERATION,
    p_source_updated_at: NOW.toISOString(),
    p_request_embedding: false,
  });
  const embedding = callBySuffix(
    database.calls,
    "/rest/v1/rpc/set_agent_search_document_embedding",
  );
  assertEquals(embedding.body?.p_provider, "openai");
  assertEquals(embedding.body?.p_model, "text-embedding-3-small");
  assertEquals(embedding.body?.p_embedding_text_hash, "b".repeat(64));
  assertEquals(
    String(embedding.body?.p_embedding).startsWith("[0.001,0.001"),
    true,
  );
});

Deno.test("Agent source reconciles rich safe metadata into stable granular destinations", async () => {
  const secretValue = "must-never-be-indexed";
  const database = searchDatabaseHarness({
    app: {
      id: AGENT_ID,
      owner_id: USER_ID,
      name: "email-ops",
      slug: "email-ops",
      description: "Own inbound email triage.",
      current_version: "2.4.0",
      current_version_promoted_at: NOW.toISOString(),
      visibility: "private",
      deleted_at: null,
      updated_at: NOW.toISOString(),
      declared_permissions: ["notify:owner", "net:fetch"],
      env_schema: {},
      manifest: JSON.stringify({
        permissions: ["notify:owner", "net:fetch"],
        interfaces: [{
          id: "inbox",
          label: "Inbox",
          description: "Review email decisions.",
        }],
        functions: {
          send_reply: {
            description: "Send an approved reply.",
            parameters: {
              recipient: {
                type: "string",
                description: "Email recipient.",
              },
            },
          },
        },
        env_vars: {
          GMAIL_TOKEN: {
            label: "Gmail token",
            description: "Credential used for Gmail.",
            help: "Configure before enabling inbox checks.",
            group: "Gmail",
            default: secretValue,
            placeholder: secretValue,
            credential: {
              destination: "mail.google.com",
              inject: { as: "bearer" },
            },
          },
        },
        network: {
          allowed_destinations: [{
            host: "mail.google.com",
            label: "Gmail",
            description: "Read and send mail.",
          }],
        },
        external_functions: [{
          app: "decision-ledger",
          functions: ["record_decision"],
        }],
      }),
    },
  });
  const embeddingInputs: string[] = [];
  const result = await processSearchDocumentJob(
    searchJob(),
    deps(database.fetchFn, {
      embedSearchDocument: (input) => {
        embeddingInputs.push(input.text);
        return Promise.resolve(null);
      },
    }),
  );

  assertEquals(result.outcome, "completed");
  assertEquals(embeddingInputs.length, 5);
  const sourceRead = database.calls.find((call) =>
    call.url.includes("/rest/v1/apps?")
  );
  assert(sourceRead);
  assertEquals(sourceRead.url.includes(",env_vars"), false);

  const upserts = database.calls.filter((call) =>
    call.url.endsWith("/rest/v1/rpc/upsert_agent_search_document")
  );
  const subjects = new Set(
    upserts.map((call) =>
      `${call.body?.p_subject_type}:${call.body?.p_subject_id}`
    ),
  );
  for (
    const expected of [
      `agent:${AGENT_ID}`,
      "interface:inbox",
      "function:send_reply",
      "function_field:send_reply.recipient",
      "release:2.4.0",
      "setting:setting:GMAIL_TOKEN",
      "authority:manifest:notify:owner",
      "authority:function:send_reply",
      "authority:network:mail.google.com",
      "authority:dependency:decision-ledger:record_decision",
      "authority:platform:galactic_inbox",
    ]
  ) {
    assert(subjects.has(expected), `Missing ${expected}`);
  }
  for (const call of upserts) {
    const kind = String(call.body?.p_subject_type);
    const subjectId = String(call.body?.p_subject_id);
    const route = new URL(
      String(call.body?.p_route),
      "https://launch.example",
    );
    if (
      !["agent", "directive"].includes(kind)
    ) {
      assertEquals(
        route.searchParams.get("item"),
        kind === "release" ? `release:${subjectId}` : subjectId,
      );
    }
  }
  assertEquals(JSON.stringify(upserts).includes(secretValue), false);
});

Deno.test("Agent source tombstones removed static subjects without disturbing live documents", async () => {
  const database = searchDatabaseHarness({
    existingDocuments: [
      { subject_type: "agent", subject_id: AGENT_ID },
      { subject_type: "interface", subject_id: "old-inbox" },
      { subject_type: "release", subject_id: "0.9.0" },
    ],
  });
  const result = await processSearchDocumentJob(
    searchJob(),
    deps(database.fetchFn, {
      embedSearchDocument: () => Promise.resolve(null),
    }),
  );

  assertEquals(result.outcome, "completed");
  const tombstones = database.calls.filter((call) =>
    call.url.endsWith("/rest/v1/rpc/tombstone_agent_search_document")
  );
  assertEquals(
    tombstones.map((call) => [
      call.body?.p_subject_type,
      call.body?.p_subject_id,
    ]),
    [["interface", "old-inbox"], ["release", "0.9.0"]],
  );
});

Deno.test("Routine run source indexes lifecycle metadata only", async () => {
  const database = searchDatabaseHarness({
    routineRun: {
      id: ROUTINE_RUN_ID,
      routine_id: ROUTINE_ID,
      user_id: USER_ID,
      status: "succeeded",
      summary: "raw customer content must not be selected",
      error: { message: "private" },
      run_config: { token: "private" },
      started_at: "2026-07-23T11:59:00.000Z",
      completed_at: NOW.toISOString(),
      created_at: "2026-07-23T11:58:00.000Z",
    },
    routine: {
      id: ROUTINE_ID,
      user_id: USER_ID,
      composer_app_id: AGENT_ID,
      name: "Check inbox",
      deleted_at: null,
    },
  });
  const result = await processSearchDocumentJob(
    searchJob({
      source_type: "routine_run",
      source_id: ROUTINE_RUN_ID,
    }),
    deps(database.fetchFn, {
      embedSearchDocument: () => Promise.resolve(null),
    }),
  );

  assertEquals(result.outcome, "completed");
  const sourceRead = database.calls.find((call) =>
    call.url.includes("/rest/v1/routine_runs?")
  );
  assert(sourceRead);
  for (const excluded of ["summary", "error", "run_config", "metadata"]) {
    assertEquals(sourceRead.url.includes(excluded), false);
  }
  const upsert = callBySuffix(
    database.calls,
    "/rest/v1/rpc/upsert_agent_search_document",
  );
  assertEquals(upsert.body?.p_subject_type, "run");
  assertEquals(upsert.body?.p_subject_id, ROUTINE_RUN_ID);
  assertEquals(
    upsert.body?.p_route,
    `/agents/email-ops?pane=compute&item=${ROUTINE_RUN_ID}`,
  );
});

Deno.test("Compute run source excludes execution inputs and output", async () => {
  const database = searchDatabaseHarness({
    computeRun: {
      id: COMPUTE_RUN_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      caller_function: "build_report",
      state: "failed",
      state_version: 4,
      execution_request: { stdin: "private" },
      stdout: "private",
      stderr: "private",
      terminal_error: "private",
      started_at: "2026-07-23T11:59:00.000Z",
      finished_at: NOW.toISOString(),
      created_at: "2026-07-23T11:58:00.000Z",
      updated_at: NOW.toISOString(),
    },
  });
  const result = await processSearchDocumentJob(
    searchJob({
      source_type: "compute_run",
      source_id: COMPUTE_RUN_ID,
    }),
    deps(database.fetchFn, {
      embedSearchDocument: () => Promise.resolve(null),
    }),
  );

  assertEquals(result.outcome, "completed");
  const sourceRead = database.calls.find((call) =>
    call.url.includes("/rest/v1/compute_runs?")
  );
  assert(sourceRead);
  for (
    const excluded of [
      "execution_request",
      "stdout",
      "stderr",
      "terminal_error",
      "execution_metrics",
    ]
  ) {
    assertEquals(sourceRead.url.includes(excluded), false);
  }
  const upsert = callBySuffix(
    database.calls,
    "/rest/v1/rpc/upsert_agent_search_document",
  );
  assertEquals(upsert.body?.p_subject_type, "run");
  assertEquals(upsert.body?.p_title, "build_report · failed");
  assertEquals(
    upsert.body?.p_route,
    `/agents/email-ops?pane=compute&item=${COMPUTE_RUN_ID}`,
  );
});

Deno.test("search worker tombstones both stale Routine identities when source is no longer eligible", async () => {
  const routineId = ROUTINE_ID;
  const queued = searchJob({
    source_type: "routine",
    source_id: routineId,
  });
  const database = searchDatabaseHarness({
    routine: {
      id: routineId,
      user_id: USER_ID,
      composer_app_id: AGENT_ID,
      name: "Check inbox",
      description: "Check for messages",
      intent: "Triage inbound mail",
      metadata: {},
      deleted_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  });

  const result = await processSearchDocumentJob(
    queued,
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  const sourceRead = database.calls.find((call) =>
    call.url.includes("/rest/v1/user_routines?")
  );
  assert(sourceRead?.url.includes(`user_id=eq.${USER_ID}`));
  assert(sourceRead?.url.includes(`id=eq.${routineId}`));
  const tombstones = database.calls.filter((call) =>
    call.url.endsWith("/rest/v1/rpc/tombstone_agent_search_document")
  );
  assertEquals(
    tombstones.map((call) => call.body?.p_subject_type),
    ["directive", "routine"],
  );
  assertEquals(
    tombstones.map((call) => call.body?.p_subject_id),
    [routineId, routineId],
  );
});

Deno.test("search worker tombstones the notification destination when current enrichment is unavailable", async () => {
  const queued = searchJob({
    source_type: "notification_brief",
    source_id: BRIEF_ID,
  });
  const database = searchDatabaseHarness({
    brief: {
      id: BRIEF_ID,
      notification_id: NOTIFICATION_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      revision: 2,
      status: "failed",
      headline: null,
      impact: null,
      recommended_action: null,
      superseded_at: null,
      updated_at: NOW.toISOString(),
    },
    currentBrief: { id: BRIEF_ID, revision: 2 },
  });
  const result = await processSearchDocumentJob(
    queued,
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  const tombstone = callBySuffix(
    database.calls,
    "/rest/v1/rpc/tombstone_agent_search_document",
  );
  assertEquals(tombstone.body?.p_subject_type, "attention");
  assertEquals(tombstone.body?.p_subject_id, NOTIFICATION_ID);
  assertEquals(tombstone.body?.p_source_revision, SEARCH_SOURCE_REVISION);
  assertEquals(tombstone.body?.p_enqueue_generation, ENQUEUE_GENERATION);
});

Deno.test("notification deletion jobs deterministically tombstone the notification Attention subject", async () => {
  const queued = searchJob({
    source_type: "notification",
    source_id: NOTIFICATION_ID,
  });
  const database = searchDatabaseHarness({ attentionNotification: null });
  const result = await processSearchDocumentJob(
    queued,
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  assertEquals(
    database.calls.some((call) =>
      call.url.includes("/rest/v1/notification_briefs?")
    ),
    false,
  );
  const tombstone = callBySuffix(
    database.calls,
    "/rest/v1/rpc/tombstone_agent_search_document",
  );
  assertEquals(tombstone.body, {
    p_user_id: USER_ID,
    p_agent_id: AGENT_ID,
    p_subject_type: "attention",
    p_subject_id: NOTIFICATION_ID,
    p_source_revision: SEARCH_SOURCE_REVISION,
    p_source_type: "notification",
    p_source_id: NOTIFICATION_ID,
    p_enqueue_generation: ENQUEUE_GENERATION,
  });
});

Deno.test("notification lifecycle jobs rebuild an active Attention search result from the current brief", async () => {
  const queued = searchJob({
    source_type: "notification",
    source_id: NOTIFICATION_ID,
  });
  const database = searchDatabaseHarness({
    currentBrief: {
      id: BRIEF_ID,
      notification_id: NOTIFICATION_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      revision: 2,
      status: "ready",
      headline: "Inbox checks need review",
      impact: "Inbound work is paused.",
      recommended_action: "Review the routine.",
      superseded_at: null,
      updated_at: NOW.toISOString(),
    },
  });

  const result = await processSearchDocumentJob(
    queued,
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  const upsert = callBySuffix(
    database.calls,
    "/rest/v1/rpc/upsert_agent_search_document",
  );
  assertEquals(upsert.body?.p_subject_type, "attention");
  assertEquals(upsert.body?.p_subject_id, NOTIFICATION_ID);
  assertEquals(
    upsert.body?.p_route,
    `/agents/email-ops?pane=alerts&item=${NOTIFICATION_ID}`,
  );
});

Deno.test("inactive notification lifecycle jobs tombstone Attention without consulting enrichment", async () => {
  const queued = searchJob({
    source_type: "notification",
    source_id: NOTIFICATION_ID,
  });
  const database = searchDatabaseHarness({
    attentionNotification: {
      id: NOTIFICATION_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      item_class: "report",
      lifecycle_state: "archived",
      read_at: NOW.toISOString(),
      snoozed_until: null,
      state_changed_at: NOW.toISOString(),
    },
  });

  const result = await processSearchDocumentJob(
    queued,
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  assertEquals(
    database.calls.some((call) =>
      call.url.includes("/rest/v1/notification_briefs?")
    ),
    false,
  );
  const tombstone = callBySuffix(
    database.calls,
    "/rest/v1/rpc/tombstone_agent_search_document",
  );
  assertEquals(tombstone.body?.p_subject_id, NOTIFICATION_ID);
});

Deno.test("an out-of-order ready brief cannot resurrect resolved Attention", async () => {
  const queued = searchJob({
    source_type: "notification_brief",
    source_id: BRIEF_ID,
  });
  const database = searchDatabaseHarness({
    brief: {
      id: BRIEF_ID,
      notification_id: NOTIFICATION_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      revision: 2,
      status: "ready",
      headline: "Old incident",
      impact: "This incident has recovered.",
      recommended_action: null,
      superseded_at: null,
      updated_at: NOW.toISOString(),
    },
    currentBrief: { id: BRIEF_ID, revision: 2 },
    attentionNotification: {
      id: NOTIFICATION_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      item_class: "incident",
      lifecycle_state: "resolved",
      read_at: null,
      snoozed_until: null,
      state_changed_at: NOW.toISOString(),
    },
  });

  const result = await processSearchDocumentJob(
    queued,
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  assertEquals(
    database.calls.some((call) =>
      call.url.endsWith("/rest/v1/rpc/upsert_agent_search_document")
    ),
    false,
  );
  const tombstone = callBySuffix(
    database.calls,
    "/rest/v1/rpc/tombstone_agent_search_document",
  );
  assertEquals(tombstone.body?.p_subject_id, NOTIFICATION_ID);
});

Deno.test("a stale in-flight upsert rejected by the subject ledger settles without embedding", async () => {
  const database = searchDatabaseHarness({ upsertValue: null });
  const result = await processSearchDocumentJob(
    searchJob(),
    deps(database.fetchFn, {
      embedSearchDocument: () => {
        throw new Error("stale projection must not embed");
      },
    }),
  );

  assertEquals(result.outcome, "completed");
  assertEquals(
    database.calls.some((call) =>
      call.url.endsWith("/rest/v1/rpc/set_agent_search_document_embedding")
    ),
    false,
  );
});

Deno.test("search worker schedules a bounded retry after transient persistence failure", async () => {
  const database = searchDatabaseHarness({ upsertStatus: 503 });
  const result = await processSearchDocumentJob(
    searchJob({ attempt_count: 2 }),
    deps(database.fetchFn, {
      embedSearchDocument: () => Promise.resolve(null),
    }),
  );

  assertEquals(result, {
    jobId: JOB_ID,
    outcome: "retry_scheduled",
    errorCode: "DATABASE_UNAVAILABLE",
    retryAt: "2026-07-23T12:01:00.000Z",
  });
  const retry = callBySuffix(
    database.calls,
    "/rest/v1/rpc/retry_operator_projection_job",
  );
  assertEquals(retry.body, {
    p_job_id: JOB_ID,
    p_lease_token: LEASE_TOKEN,
    p_error_code: "DATABASE_UNAVAILABLE",
    p_retry_at: "2026-07-23T12:01:00.000Z",
    p_terminal: false,
  });
  assertEquals(
    database.calls.some((call) =>
      call.url.endsWith("/rest/v1/rpc/complete_operator_projection_job")
    ),
    false,
  );
});

Deno.test("search worker terminates an owner mismatch without writing a document", async () => {
  const database = searchDatabaseHarness({
    app: {
      id: AGENT_ID,
      owner_id: "99999999-9999-4999-8999-999999999999",
      name: "cross-owner",
      slug: "cross-owner",
      description: "Must not be indexed.",
      current_version: "1.0.0",
      visibility: "private",
      deleted_at: null,
      updated_at: NOW.toISOString(),
    },
  });
  const result = await processSearchDocumentJob(
    searchJob(),
    deps(database.fetchFn),
  );

  assertEquals(result, {
    jobId: JOB_ID,
    outcome: "terminal_failure",
    errorCode: "SOURCE_OWNER_MISMATCH",
    retryAt: null,
  });
  assertEquals(
    database.calls.some((call) =>
      call.url.endsWith("/rest/v1/rpc/upsert_agent_search_document")
    ),
    false,
  );
  const retry = callBySuffix(
    database.calls,
    "/rest/v1/rpc/retry_operator_projection_job",
  );
  assertEquals(retry.body?.p_terminal, true);
});

Deno.test("stale search jobs settle without reading or overwriting a newer source revision", async () => {
  const database = searchDatabaseHarness({
    latestJobId: "88888888-8888-4888-8888-888888888888",
  });
  const result = await processSearchDocumentJob(
    searchJob(),
    deps(database.fetchFn),
  );

  assertEquals(result.outcome, "completed");
  assertEquals(
    database.calls.some((call) =>
      call.url.includes("/rest/v1/apps?") ||
      call.url.endsWith("/rest/v1/rpc/upsert_agent_search_document") ||
      call.url.endsWith("/rest/v1/rpc/tombstone_agent_search_document")
    ),
    false,
  );
});
