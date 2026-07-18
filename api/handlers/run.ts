// Run Handler
// Executes user code in sandbox

import { error, json } from "./response.ts";
import type { AIRequest, AIResponse } from "../../shared/contracts/ai.ts";
import type {
  LogEntry,
  RunRequest,
  RunResponse,
} from "../../shared/types/index.ts";
import { createAppsService } from "../services/apps.ts";
import {
  createAppDataService,
  createWorkerAppDataService,
} from "../services/appdata.ts";
import { createMeteredAppDataService } from "../services/appdata-metered.ts";
import {
  createRuntimeAIContext,
  createUnavailableAIService,
} from "../services/runtime-ai.ts";
import { resolveFunctionInferenceOverride } from "../services/function-inference-overrides.ts";
import { executeGpuFunction } from "../services/gpu/executor.ts";
import { acquireGpuSlot } from "../services/gpu/concurrency.ts";
import { buildGpuNotReadyMessage } from "../services/gpu/status.ts";
import {
  getGpuSupportDisabledMessage,
  isGpuSupportEnabled,
} from "../services/gpu/feature-flag.ts";
import {
  buildMissingAppSecretsErrorDetails,
  buildMissingAppSecretsMessage,
  createAppD1Resources,
  fetchAppEntryCode,
  resolveAppRuntimeEnvVars,
  resolveAppSupabaseConfig,
  resolveFunctionExecutionPolicy,
  resolveRuntimeAppCallDependencies,
  resolveStrictManifestPermissions,
  SupabaseConfigMigrationRequiredError,
} from "../services/app-runtime-resources.ts";
import { getManifestAllowedDestinations } from "../services/trust.ts";
import { buildGpuStatusDiagnostics } from "../services/gpu/status.ts";
import {
  callerCanUseLegacyExecutionRoute,
  callerHasAppAccess,
  callerHasFunctionAccess,
  callerHasRequiredScope,
  callerUsesApiToken,
  callerUsesRoutineActorToken,
  callerUsesSandboxActorToken,
  type RequestCallerContext,
  resolveRequestCallerContext,
} from "../services/request-caller-context.ts";
import { routineTraceContextFromCaller } from "../services/routine-trace.ts";
import {
  createRuntimeOperationMeteringContext,
  preflightRuntimeCloudHold,
  settleAndLogAppExecution,
  settleAndLogGpuExecution,
  settleRuntimeCloudPreflight,
} from "../services/execution-settlement.ts";
import {
  ACCOUNT_CAPACITY_ADMISSION_EXPOSURE_LIGHT,
  accountCapacityErrorDetails,
  accountCapacityErrorMessage,
  releaseAccountCapacity,
  reserveAccountCapacity,
} from "../services/account-capacity.ts";
import {
  countCapacityWorkerRequests,
  settleOrDeferCapacityAfterExecution,
  shouldReleaseUnstartedCapacityReservation,
} from "../services/capacity-settlement-recovery.ts";
import { createCapacityResourceMeter } from "../services/cloud-usage.ts";
import { createExecutionReceiptId } from "../services/call-logger.ts";
import {
  createMemoryService,
  type MemoryService as MemoryServiceImpl,
} from "../services/memory.ts";
import { getEnv, getExecQueue } from "../lib/env.ts";
import {
  buildCallerPermissionConfigureUrl,
  enforceCallerFunctionPermission,
} from "../services/caller-function-permissions.ts";
import { mintCallerContextToken } from "../services/agent-caller-context.ts";
import { classifyRuntimeExecution } from "../services/execution-classification.ts";

function toLogEntries(lines: string[]): LogEntry[] {
  return lines.map((message) => ({
    time: new Date().toISOString(),
    level: "log",
    message,
  }));
}

let memoryService: MemoryServiceImpl | null | undefined;

function getRuntimeMemoryService(): MemoryServiceImpl | null {
  if (memoryService !== undefined) return memoryService;
  try {
    memoryService = createMemoryService();
  } catch (err) {
    console.error("[RUN] Failed to create memory service:", err);
    memoryService = null;
  }
  return memoryService;
}

function createRuntimeMemoryAdapter(userId: string, appId: string) {
  const service = getRuntimeMemoryService();
  if (!service) return null;
  return {
    remember: async (key: string, value: unknown) => {
      await service.remember(userId, `app:${appId}`, key, value);
    },
    recall: async (key: string) => {
      return await service.recall(userId, `app:${appId}`, key);
    },
  };
}

export function callerCanUseRunAsyncDispatch(
  caller: Pick<RequestCallerContext, "authSource" | "authState">,
): boolean {
  // Defense in depth behind the route-level actor rejection below. Durable
  // jobs persist only account/app/function arguments and cannot reconstruct a
  // signed routine budget/authority context if branch ordering ever changes.
  return callerCanUseLegacyExecutionRoute(caller);
}

export async function handleRun(
  request: Request,
  appId: string,
): Promise<Response> {
  let capacityReservation: { id: string; userId: string } | null = null;
  let tenantExecutionAttempted = false;
  const capacityResourceMeter = createCapacityResourceMeter();
  try {
    const body: RunRequest = await request.json();
    const { function: functionName, args = [] } = body;

    if (!functionName) {
      return error("Function name required");
    }

    let caller: RequestCallerContext;
    try {
      caller = await resolveRequestCallerContext(request, {
        authSourcePolicy: "bearer_or_cookie",
        allowAnonymous: false,
      });
    } catch (authErr) {
      return json(
        {
          success: false,
          result: null,
          logs: [],
          duration_ms: 0,
          error: {
            type: "AUTH_REQUIRED",
            message: authErr instanceof Error
              ? authErr.message
              : "Authentication required",
          },
        } as RunResponse,
        401,
      );
    }
    if (!callerCanUseLegacyExecutionRoute(caller)) {
      return json(
        {
          success: false,
          result: null,
          logs: [],
          duration_ms: 0,
          error: {
            type: "ACTOR_ROUTE_UNSUPPORTED",
            message:
              "Signed routine and sandbox actors must execute Agent functions through MCP so capability ceilings, attribution, and hard budgets remain intact.",
          },
        } as RunResponse,
        403,
      );
    }
    const { userId, user } = caller;
    const routineContext = routineTraceContextFromCaller(caller);

    // Initialize services
    const appsService = createAppsService();

    // Fetch app from database
    const app = await appsService.findById(appId);
    if (!app) {
      return error("App not found", 404);
    }

    // Check visibility permissions
    if (app.visibility === "private" && app.owner_id !== userId) {
      return error("Unauthorized", 403);
    }

    if (!callerHasAppAccess(caller, [app.id, app.slug, appId])) {
      return error(
        `Token not authorized for this app. Scoped to: ${
          (caller.tokenAppIds || []).join(", ")
        }`,
        403,
      );
    }

    if (!callerHasFunctionAccess(caller, [functionName])) {
      return error(
        `Token not authorized for function "${functionName}". Scoped to: ${
          (caller.tokenFunctionNames || []).join(", ")
        }`,
        403,
      );
    }

    if (
      caller.authState === "authenticated" &&
      !callerHasRequiredScope(caller, "apps:call")
    ) {
      return error("Token missing required scope: apps:call", 403);
    }

    if (
      callerUsesApiToken(caller) || callerUsesRoutineActorToken(caller) ||
      callerUsesSandboxActorToken(caller)
    ) {
      const permission = await enforceCallerFunctionPermission({
        userId,
        appId: app.id,
        functionName,
        configureUrl: buildCallerPermissionConfigureUrl(
          requestBaseUrl(request),
          app.id,
          functionName,
        ),
      });
      if (!permission.allowed) {
        return json(
          {
            success: false,
            result: null,
            logs: [],
            duration_ms: 0,
            error: {
              type: permission.errorType,
              message: permission.message,
              details: permission.details,
            },
          } as RunResponse,
          permission.httpStatus,
        );
      }
    }

    // The reserved _async argument is platform routing, never function input —
    // strip it before ANY execution branch (GPU included) sees the args.
    let asyncOptIn = false;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const argsRecord = args as Record<string, unknown>;
      asyncOptIn = argsRecord._async === true;
      if ("_async" in argsRecord) delete argsRecord._async;
    }

    // ── GPU Runtime Branch ──
    if (app.runtime === "gpu") {
      if (routineContext) {
        return json(
          {
            success: false,
            result: null,
            logs: [],
            duration_ms: 0,
            error: {
              type: "ROUTINE_GPU_BUDGET_UNAVAILABLE",
              message:
                "GPU functions are unavailable to routines until hard pre-execution GPU budget admission is configured.",
            },
          } as RunResponse,
          409,
        );
      }

      if (!isGpuSupportEnabled()) {
        return json(
          {
            success: false,
            result: null,
            logs: [],
            duration_ms: 0,
            error: {
              type: "GPU_SUPPORT_DISABLED",
              message: getGpuSupportDisabledMessage("GPU runtime execution"),
            },
          } as RunResponse,
          503,
        );
      }

      if (app.gpu_status !== "live") {
        return json(
          {
            success: false,
            result: null,
            logs: [],
            duration_ms: 0,
            error: {
              type: "GPU_NOT_READY",
              message: buildGpuNotReadyMessage(app.gpu_status),
              details: buildGpuStatusDiagnostics(app.gpu_status, {
                appId: app.id,
              }),
            },
          } as RunResponse,
          503,
        );
      }

      // Acquire concurrency slot (429 if full after 5s wait)
      let gpuSlot;
      try {
        gpuSlot = await acquireGpuSlot(
          app.gpu_endpoint_id!,
          app.gpu_concurrency_limit || 5,
        );
      } catch {
        return json(
          {
            success: false,
            error: { message: "GPU function at capacity. Try again shortly." },
          } as RunResponse,
          429,
        );
      }

      try {
        const receiptId = createExecutionReceiptId();
        const gpuStartTime = Date.now();
        const gpuResult = await executeGpuFunction({
          app,
          functionName,
          args: typeof args === "object" && !Array.isArray(args)
            ? args as Record<string, unknown>
            : { _args: args },
          executionId: crypto.randomUUID(),
        });
        const gpuDurationMs = Date.now() - gpuStartTime;
        const gpuInputArgs = typeof args === "object" && !Array.isArray(args)
          ? args as Record<string, unknown>
          : {};
        const settlementUserId = caller.authState === "authenticated"
          ? userId
          : app.owner_id;
        const { settlement } = await settleAndLogGpuExecution({
          receiptId,
          userId: settlementUserId,
          user,
          app,
          functionName,
          inputArgs: gpuInputArgs,
          method: "run",
          gpuResult,
          durationMs: gpuDurationMs,
          routineContext,
        });
        if (settlement?.insufficientBalance) {
          return json(
            {
              success: false,
              error: { message: settlement.insufficientBalanceMessage! },
            } as RunResponse,
            402,
          );
        }

        const gpuResponse: RunResponse = {
          success: gpuResult.success,
          result: gpuResult.result,
          logs: toLogEntries(gpuResult.logs),
          duration_ms: gpuResult.durationMs,
          receipt_id: receiptId,
          error: gpuResult.error,
        };
        return json(gpuResponse);
      } finally {
        gpuSlot.release();
      }
    }

    // ── Durable async dispatch ──
    // Declared-async functions (and explicit _async opt-ins) are enqueued:
    // the caller gets { _async, job_id } immediately and polls
    // GET /api/launch/jobs/:id (or ul.job). Mirrors the per-app MCP dispatch;
    // the queue consumer runs the full pipeline with the extended budget.
    if (
      args && typeof args === "object" && !Array.isArray(args) &&
      callerCanUseRunAsyncDispatch(caller)
    ) {
      const argsRecord = args as Record<string, unknown>;
      const executionPolicy = resolveFunctionExecutionPolicy(app, functionName);
      if (executionPolicy.async || asyncOptIn) {
        const queue = getExecQueue();
        if (queue) {
          const { createQueuedJob, reclaimJobForSyncFallback } = await import(
            "../services/async-jobs.ts"
          );
          const jobId = await createQueuedJob({
            appId: app.id,
            userId,
            ownerId: app.owner_id,
            functionName,
            args: argsRecord,
            meta: { executionTimeoutMs: executionPolicy.timeoutMs },
          });
          let enqueued = false;
          try {
            await queue.send({ jobId });
            enqueued = true;
          } catch (err) {
            // A send() throw does NOT prove non-delivery. Only run
            // synchronously if we win the row back through the same 'queued'
            // status filter the consumer claims through; otherwise the
            // consumer owns the execution and running here would double it.
            console.error("[RUN] EXEC_QUEUE send failed:", err);
            const reclaimed = await reclaimJobForSyncFallback(jobId, {
              type: "QueueError",
              message: err instanceof Error ? err.message : String(err),
            }).catch(() => false);
            if (!reclaimed) enqueued = true;
          }
          if (enqueued) {
            return json({
              success: true,
              result: { _async: true, job_id: jobId, status: "queued" },
              logs: [],
              duration_ms: 0,
            } as RunResponse);
          }
        }
        // No queue bound (local dev/tests): execute synchronously below.
      }
    }

    let code;
    let envResolution;
    let supabaseConfig;
    let d1DataService;
    try {
      [code, envResolution, supabaseConfig, { d1DataService }] = await Promise
        .all([
          fetchAppEntryCode(app),
          resolveAppRuntimeEnvVars(app, userId),
          resolveAppSupabaseConfig(app),
          createAppD1Resources(app),
        ]);
    } catch (err) {
      if (err instanceof SupabaseConfigMigrationRequiredError) {
        return error(err.message, 409);
      }
      throw err;
    }

    if (!code) {
      console.error("No entry file found in R2");
      return error(
        "No entry file found (index.tsx, index.ts, index.jsx, or index.js)",
        404,
      );
    }

    const { envVars, credentials, missingRequiredSecrets } = envResolution;
    if (missingRequiredSecrets.length > 0) {
      return json(
        {
          success: false,
          result: null,
          logs: [],
          duration_ms: 0,
          error: {
            type: "MISSING_SECRETS",
            message: buildMissingAppSecretsMessage(missingRequiredSecrets),
            details: buildMissingAppSecretsErrorDetails(
              app.id,
              missingRequiredSecrets,
            ),
          },
        } satisfies RunResponse,
        400,
      );
    }

    if (!app.manifest) {
      return error("App manifest required for runtime execution", 422);
    }

    // ── Deno Sandbox Path ──
    const permissions = resolveStrictManifestPermissions(app).permissions;
    const canUseAi = permissions.includes("ai:call") ||
      permissions.includes("ai:embed");
    const executionClassification = classifyRuntimeExecution({
      manifest: app.manifest,
      functionName,
    });
    // Per-function provider/model override for this installer's galactic.ai().
    const inferenceSelection = permissions.includes("ai:call")
      ? await resolveFunctionInferenceOverride({
        userId,
        appId: app.id,
        functionName,
      })
      : null;
    const subscriptionCapacityMode =
      getEnv("SUBSCRIPTION_CAPACITY_ENABLED") === "1" &&
      app.visibility === "private" && app.owner_id === userId;
    // App permissions authorize the capability. The upload-derived function
    // classification below controls scheduling/timeout only; it never grants
    // an undeclared capability.
    const runtimeAI = canUseAi
      ? await createRuntimeAIContext(user, {
        freeMode: caller.freeMode,
        byokOnly: subscriptionCapacityMode,
        inferenceSelection,
        attribution: { appId: app.id, functionName },
        routineContext,
      })
      : {
        route: null,
        resolvedRoute: null,
        userApiKey: null,
        aiService: createUnavailableAIService(
          "ai:call permission not granted.",
        ),
        unavailableReason: "ai:call permission not granted.",
      };

    // Execute in sandbox — only functions whose upload-derived call graph uses
    // inference receive the longer interactive window. An AI-capable Agent's
    // unrelated read functions remain ordinary 30-second calls.
    // Dynamic Worker sandbox — avoids `new Function()` restriction on CF Workers
    const { executeInDynamicSandbox } = await import(
      "../runtime/dynamic-sandbox.ts"
    );
    const argsArray = Array.isArray(args) ? args : [args];
    const receiptId = createExecutionReceiptId();
    const timeoutMs = executionClassification.timeoutMs;
    const inputArgs =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? args as Record<string, unknown>
        : { _args: args };
    const cloudPreflight = await preflightRuntimeCloudHold({
      app,
      userId,
      functionName,
      inputArgs,
      receiptId,
      method: "run",
      timeoutMs,
      callerAuthState: caller.authState,
      routineContext,
      freeMode: caller.freeMode,
      byokPresent: caller.byokPresent,
      subscriptionCapacity: subscriptionCapacityMode,
    });
    if (cloudPreflight.insufficientBalance) {
      return json(
        {
          success: false,
          result: null,
          logs: [],
          duration_ms: 0,
          receipt_id: receiptId,
          error: {
            type: cloudPreflight.insufficientBalanceCode || "LIGHT_REQUIRED",
            message: cloudPreflight.insufficientBalanceMessage ||
              "Credits balance required to call this app.",
            details: cloudPreflight.metadata,
          },
        } as RunResponse,
        402,
      );
    }
    if (subscriptionCapacityMode) {
      const admission = await reserveAccountCapacity({
        userId,
        // Legacy /run rejects actor tokens above, so this is a direct call and
        // the target Agent starts the capacity-attribution chain.
        capacityAgentId: app.id,
        idempotencyKey: `run:${receiptId}`,
        reserveLight: ACCOUNT_CAPACITY_ADMISSION_EXPOSURE_LIGHT,
        expiresAt: new Date(Date.now() + timeoutMs + 120_000).toISOString(),
        usesInference: executionClassification.usesInference,
        routineId: routineContext?.routineId ?? null,
        routineRunId: routineContext?.routineRunId ?? null,
        metadata: {
          surface: "run",
          app_id: app.id,
          capacity_agent_id: app.id,
          function_name: functionName,
          receipt_id: receiptId,
          uses_inference: executionClassification.usesInference,
          execution_class: "interactive",
          routine_id: routineContext?.routineId ?? null,
          routine_run_id: routineContext?.routineRunId ?? null,
        },
      });
      if (!admission.allowed || !admission.reservationId) {
        return json(
          {
            success: false,
            result: null,
            logs: [],
            duration_ms: 0,
            receipt_id: receiptId,
            error: {
              type: admission.code.toUpperCase(),
              message: accountCapacityErrorMessage(admission),
              details: accountCapacityErrorDetails(admission),
            },
          } as RunResponse,
          429,
        );
      }
      capacityReservation = { id: admission.reservationId, userId };
    }
    const cloudOperationMetering = createRuntimeOperationMeteringContext({
      preflight: cloudPreflight,
      app,
      userId,
      functionName,
      receiptId,
      method: "run",
      metadata: { surface: "run" },
      routineContext,
      ...(subscriptionCapacityMode
        ? {
          capacityMeter: capacityResourceMeter,
        }
        : {}),
    });
    const workerDataUrl = getEnv("WORKER_DATA_URL");
    const workerSecret = getEnv("WORKER_SECRET");
    const rawAppDataService = workerDataUrl && workerSecret
      ? createWorkerAppDataService(
        app.id,
        userId,
        workerDataUrl,
        workerSecret,
        {
          operationMetering: cloudOperationMetering,
          billingConfig: cloudPreflight.billingConfig,
        },
      )
      : createAppDataService(app.id, userId, {
        operationMetering: cloudOperationMetering,
        billingConfig: cloudPreflight.billingConfig,
      });
    const appDataService = createMeteredAppDataService(
      rawAppDataService,
      userId,
    );
    const baseUrl = getEnv("BASE_URL") || undefined;
    const appCallDependencies = resolveRuntimeAppCallDependencies(app, caller);
    let callerContextToken: string | undefined;
    try {
      callerContextToken = await mintCallerContextToken({
        callerAppId: app.id,
        capacityAgentId: app.id,
        userId,
        callerFunction: functionName,
        incomingHop: 0,
        ttlSeconds: Math.ceil(timeoutMs / 1000) + 120,
      });
    } catch (err) {
      // Match MCP's fail-closed behavior: this execution may continue, but an
      // outbound Agent call cannot authenticate if signing is unavailable.
      console.warn("[RUN] Failed to mint caller context token:", err);
    }
    const memoryAdapter = permissions.includes("memory:read") ||
        permissions.includes("memory:write")
      ? createRuntimeMemoryAdapter(userId, app.id)
      : null;

    const executionId = crypto.randomUUID();
    const capacityExecutedAt = new Date().toISOString();
    tenantExecutionAttempted = true;
    const result = await executeInDynamicSandbox(
      {
        appId: app.id,
        userId,
        ownerId: app.owner_id,
        expectedVersion: app.current_version || undefined,
        executionId,
        capacityReceiptId: capacityReservation ? receiptId : undefined,
        code,
        permissions,
        allowedDestinations: getManifestAllowedDestinations(app.manifest),
        userApiKey: runtimeAI.userApiKey,
        aiUnavailableReason: runtimeAI.unavailableReason,
        aiRoute: runtimeAI.route,
        user,
        appDataService,
        d1DataService,
        memoryService: memoryAdapter,
        aiService: runtimeAI.aiService as {
          call: (request: AIRequest, apiKey: string) => Promise<AIResponse>;
        },
        envVars,
        credentials,
        supabase: supabaseConfig,
        baseUrl,
        authToken: caller.authToken,
        appCallDependencies,
        callerContextToken,
        workerSecret: workerSecret || undefined,
        timeoutMs,
        cloudOperationMetering,
        cloudOperationBillingConfig: cloudPreflight.billingConfig,
      },
      functionName,
      argsArray,
    );

    let subscriptionCapacityLight: number | undefined;
    if (capacityReservation) {
      const capacityResult = await settleOrDeferCapacityAfterExecution({
        reservationId: capacityReservation.id,
        userId: capacityReservation.userId,
        receiptId,
        executionId,
        executedAt: capacityExecutedAt,
        resourceFacts: capacityResourceMeter.snapshot(),
        workerRequestCount: countCapacityWorkerRequests({
          dynamicWorkerInvoked: result.dynamicWorkerInvoked === true,
        }),
        dynamicWorkerIdentityCreated:
          result.dynamicWorkerIdentityCreated === true,
        dynamicWorkerInvoked: result.dynamicWorkerInvoked === true,
        reuseKeyHash: result.reuseKeyHash,
        billingConfig: cloudPreflight.billingConfig,
        surface: "run",
      });
      // A safely queued settlement still remains subscription-capacity work;
      // zero is the temporary call-log value and prevents legacy wallet
      // settlement while the exact resource intent is retried.
      subscriptionCapacityLight = capacityResult.settlement?.totalLight ?? 0;
    }
    const cloudSettlement = await settleRuntimeCloudPreflight(
      cloudPreflight,
      result.durationMs,
      {
        success: result.success,
        error_message: result.success ? null : result.error?.message,
        ...(routineContext
          ? {
            routine_id: routineContext.routineId,
            routine_run_id: routineContext.routineRunId,
            trace_id: routineContext.traceId ?? null,
          }
          : {}),
      },
      undefined,
      result.reuseKeyHash,
    );
    const { settlement } = await settleAndLogAppExecution({
      receiptId,
      userId,
      user,
      app,
      functionName,
      method: "run",
      success: result.success,
      durationMs: result.durationMs,
      errorMessage: result.success
        ? undefined
        : (result.error?.message || "Execution failed"),
      outputResult: result.success ? result.result : result.error,
      runtimeLogs: result.logs,
      aiCostLight: result.aiCostLight || 0,
      inputArgs,
      callerAuthState: caller.authState,
      runtimePricingPreflight: cloudPreflight.pricing,
      runtimeCloudSettlement: cloudSettlement,
      ...(subscriptionCapacityLight !== undefined
        ? { subscriptionCapacityLight }
        : {}),
      routineContext,
    });

    if (result.success && settlement.insufficientBalance) {
      return json(
        {
          success: false,
          result: null,
          logs: result.logs,
          duration_ms: result.durationMs,
          receipt_id: receiptId,
          error: {
            type: settlement.insufficientBalanceCode || "LIGHT_REQUIRED",
            message: settlement.insufficientBalanceMessage ||
              "Credits balance required to call this app.",
            details: settlement.metadata,
          },
        } as RunResponse,
        402,
      );
    }

    const response: RunResponse = {
      success: result.success,
      result: result.result,
      logs: result.logs,
      duration_ms: result.durationMs,
      receipt_id: receiptId,
      error: result.error,
    };

    return json(response);
  } catch (err) {
    if (
      capacityReservation &&
      shouldReleaseUnstartedCapacityReservation(tenantExecutionAttempted)
    ) {
      await releaseAccountCapacity({
        reservationId: capacityReservation.id,
        userId: capacityReservation.userId,
      }).catch(() => false);
    }
    console.error("Run error:", err);
    return error(err instanceof Error ? err.message : "Execution failed", 500);
  }
}

function requestBaseUrl(request: Request): string {
  const configured = getEnv("BASE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const proto = request.headers.get("x-forwarded-proto") ||
    (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
