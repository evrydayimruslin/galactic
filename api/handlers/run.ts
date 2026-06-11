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
  resolveRuntimeAppCallDependencies,
  resolveStrictManifestPermissions,
  SupabaseConfigMigrationRequiredError,
} from "../services/app-runtime-resources.ts";
import { buildGpuStatusDiagnostics } from "../services/gpu/status.ts";
import {
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
import { createExecutionReceiptId } from "../services/call-logger.ts";
import {
  createMemoryService,
  type MemoryService as MemoryServiceImpl,
} from "../services/memory.ts";
import { getEnv } from "../lib/env.ts";
import {
  buildCallerPermissionConfigureUrl,
  enforceCallerFunctionPermission,
} from "../services/caller-function-permissions.ts";

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

export async function handleRun(
  request: Request,
  appId: string,
): Promise<Response> {
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

    // ── GPU Runtime Branch ──
    if (app.runtime === "gpu") {
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

    const { envVars, missingRequiredSecrets } = envResolution;
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
    const runtimeAI = permissions.includes("ai:call")
      ? await createRuntimeAIContext(user)
      : {
        route: null,
        resolvedRoute: null,
        userApiKey: null,
        aiService: createUnavailableAIService(
          "ai:call permission not granted.",
        ),
        unavailableReason: "ai:call permission not granted.",
      };

    // Execute in sandbox — AI-capable apps get 120s timeout
    // Dynamic Worker sandbox — avoids `new Function()` restriction on CF Workers
    const { executeInDynamicSandbox } = await import(
      "../runtime/dynamic-sandbox.ts"
    );
    const argsArray = Array.isArray(args) ? args : [args];
    const receiptId = createExecutionReceiptId();
    const timeoutMs = permissions.includes("ai:call") ? 120_000 : 30_000;
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
    const cloudOperationMetering = createRuntimeOperationMeteringContext({
      preflight: cloudPreflight,
      app,
      userId,
      functionName,
      receiptId,
      method: "run",
      metadata: { surface: "run" },
      routineContext,
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
    const memoryAdapter = permissions.includes("memory:read") ||
        permissions.includes("memory:write")
      ? createRuntimeMemoryAdapter(userId, app.id)
      : null;

    const result = await executeInDynamicSandbox(
      {
        appId: app.id,
        userId,
        ownerId: app.owner_id,
        executionId: crypto.randomUUID(),
        code,
        permissions,
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
        supabase: supabaseConfig,
        baseUrl,
        authToken: caller.authToken,
        appCallDependencies,
        workerSecret: workerSecret || undefined,
        timeoutMs,
        cloudOperationMetering,
        cloudOperationBillingConfig: cloudPreflight.billingConfig,
      },
      functionName,
      argsArray,
    );

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
      aiCostLight: result.aiCostLight || 0,
      inputArgs,
      callerAuthState: caller.authState,
      runtimePricingPreflight: cloudPreflight.pricing,
      runtimeCloudSettlement: cloudSettlement,
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
