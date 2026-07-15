// HTTP Endpoints Handler
// Enables apps to receive HTTP requests from external services (webhooks, APIs, etc.)

import { json } from "./response.ts";
import type { UserContext } from "../runtime/sandbox.ts";
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
import { checkAndIncrementWeeklyCalls } from "../services/weekly-calls.ts";
import { getManifestAllowedDestinations } from "../services/trust.ts";
import { parseAppManifest } from "../services/app-settings.ts";
import { executeGpuFunction } from "../services/gpu/executor.ts";
import { acquireGpuSlot } from "../services/gpu/concurrency.ts";
import { buildGpuNotReadyMessage } from "../services/gpu/status.ts";
import {
  getGpuSupportDisabledMessage,
  isGpuSupportEnabled,
} from "../services/gpu/feature-flag.ts";
import { getUserTier } from "../services/tier-enforcement.ts";
import {
  applyRouteCorsHeaders,
  buildCorsHeaders,
  buildCorsPreflightResponse,
  buildRouteCorsPreflightResponse,
  isRouteCorsMethodAllowed,
  type RouteCorsPolicyInput,
} from "../services/cors.ts";
import {
  calculateExpectedRuntimeHoldAmount,
  createRuntimeOperationMeteringContext,
  preflightRuntimeCloudHold,
  settleAndLogAppExecution,
  settleAndLogGpuExecution,
  settleRuntimeCloudPreflight,
} from "../services/execution-settlement.ts";
import {
  accountCapacityErrorDetails,
  releaseAccountCapacity,
  reserveAccountCapacity,
  settleAccountCapacity,
} from "../services/account-capacity.ts";
import { createExecutionReceiptId } from "../services/call-logger.ts";
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
  callerCanUseLegacyExecutionRoute,
  callerHasAppAccess,
  callerHasFunctionAccess,
  callerHasRequiredScope,
  type RequestCallerContext,
  resolveRequestCallerContext,
} from "../services/request-caller-context.ts";
import {
  type ResolvedHttpRoutePolicy,
  resolveHttpRoutePolicy,
} from "../services/http-policy.ts";
import {
  type HttpRuntimeCallContext,
  resolveHttpCallerAuthOptions,
  resolveHttpRuntimeCallContext,
  validateHttpRouteExecutionPolicy,
} from "../services/http-execution-policy.ts";
import {
  buildHttpRateLimitHeaders,
  checkHttpRouteRateLimit,
  createHttpRateLimitIdentityHash,
} from "../services/http-rate-limit.ts";
import {
  type HttpAuditParams,
  recordHttpRequest,
  sanitizeHttpRequestForLogs,
} from "../services/http-telemetry.ts";
import { createUserService, type UserProfile } from "../services/user.ts";
import { routineTraceContextFromCaller } from "../services/routine-trace.ts";
import {
  createMemoryService,
  type MemoryService as MemoryServiceImpl,
} from "../services/memory.ts";
import { getEnv } from "../lib/env.ts";

let memoryService: MemoryServiceImpl | null | undefined;

function getRuntimeMemoryService(): MemoryServiceImpl | null {
  if (memoryService !== undefined) return memoryService;
  try {
    memoryService = createMemoryService();
  } catch (err) {
    console.error("[HTTP] Failed to create memory service:", err);
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

export function callerCanUseHttpExecutionRoute(
  caller: Pick<RequestCallerContext, "authSource" | "authState">,
): boolean {
  return callerCanUseLegacyExecutionRoute(caller);
}

/**
 * Handle HTTP endpoint requests to apps
 * Route: /http/:appId/:functionName
 *
 * Apps export functions that receive a Request object and return a Response.
 * Example app code:
 *
 * export async function webhook(request: UltralightRequest) {
 *   const body = await request.json();
 *   await ultralight.store('webhooks/' + Date.now(), body);
 *   return { received: true };
 * }
 */
export async function handleHttpEndpoint(
  request: Request,
  appId: string,
  path: string,
): Promise<Response> {
  const startTime = Date.now();
  const { functionName, subPath } = parseHttpFunctionPath(path);
  const requestUrl = new URL(request.url);
  let auditBase:
    | Omit<
      HttpAuditParams,
      "statusCode" | "durationMs" | "authState" | "rateLimited" | "receiptId"
    >
    | null = null;
  let auditAuthState: HttpAuditParams["authState"] = null;
  let auditRateLimited = false;
  let auditReceiptId: string | null = null;
  let activeRouteCorsPolicy: RouteCorsPolicyInput = {};
  let capacityReservation: { id: string; userId: string } | null = null;
  let capacityOperationLight = 0;

  function finalize(response: Response): Response {
    applyRouteCorsHeaders(response.headers, request, activeRouteCorsPolicy);

    if (auditBase) {
      void recordHttpRequest({
        ...auditBase,
        statusCode: response.status,
        durationMs: Date.now() - startTime,
        authState: auditAuthState,
        rateLimited: auditRateLimited,
        receiptId: auditReceiptId,
      });
    }
    return response;
  }

  try {
    console.log(
      `[HTTP] ${request.method} /http/${appId}/${functionName}${subPath}`,
    );

    // Get app
    const appsService = createAppsService();
    const app = await appsService.findById(appId);

    if (!app) {
      return finalize(json({ error: "App not found" }, 404));
    }

    const identityHash = await createHttpRateLimitIdentityHash(request);
    auditBase = {
      appId: app.id,
      functionName,
      endpoint: requestUrl.pathname,
      method: request.method,
      identityHash,
      userAgent: request.headers.get("user-agent"),
      origin: request.headers.get("origin"),
    };
    const routePolicy = resolveHttpRoutePolicy(app, functionName);
    activeRouteCorsPolicy = routePolicyToCorsInput(routePolicy);

    // Check if HTTP endpoints are enabled for this app
    const httpEnabled = app.http_enabled !== false;
    if (!httpEnabled) {
      return finalize(
        json({ error: "HTTP endpoints are disabled for this app" }, 403),
      );
    }

    const routePolicyIssue = validateHttpRouteExecutionPolicy(routePolicy, app);
    if (routePolicyIssue) {
      return finalize(
        json({
          error: routePolicyIssue.message,
          type: routePolicyIssue.type,
        }, routePolicyIssue.status),
      );
    }

    const appRateLimit = (routePolicy.rateLimit?.rpm ?? app.http_rate_limit) ||
      1000;
    const httpRateResult = await checkHttpRouteRateLimit({
      appId: app.id,
      functionName,
      identityHash,
      limitPerMinute: appRateLimit,
    });

    if (!httpRateResult.allowed) {
      auditRateLimited = true;
      return finalize(
        new Response(
          JSON.stringify({ error: "Rate limit exceeded for this app" }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              ...buildHttpRateLimitHeaders(httpRateResult),
            },
          },
        ),
      );
    }

    if (!isRouteCorsMethodAllowed(request.method, activeRouteCorsPolicy)) {
      return finalize(
        new Response(
          JSON.stringify({
            error:
              `Method ${request.method.toUpperCase()} not allowed for this HTTP route`,
          }),
          {
            status: 405,
            headers: {
              "Content-Type": "application/json",
              "Allow": buildRouteAllowHeader(routePolicy),
            },
          },
        ),
      );
    }

    let caller: RequestCallerContext;
    try {
      const authOptions = resolveHttpCallerAuthOptions(routePolicy);
      caller = await resolveRequestCallerContext(request, {
        authSourcePolicy: "bearer_or_cookie",
        allowAnonymous: authOptions.allowAnonymous,
        invalidAuthPolicy: authOptions.invalidAuthPolicy,
        loadUserApiKey: false,
      });
    } catch (err) {
      return finalize(
        json({
          error: err instanceof Error ? err.message : "Authentication required",
          type: "AUTH_REQUIRED",
        }, 401),
      );
    }
    if (!callerCanUseHttpExecutionRoute(caller)) {
      return finalize(
        json({
          error:
            "Signed routine and sandbox actors must execute Agent functions through MCP so capability ceilings, attribution, and hard budgets remain intact.",
          type: "ACTOR_ROUTE_UNSUPPORTED",
        }, 403),
      );
    }
    const { user } = caller;
    const routineContext = routineTraceContextFromCaller(caller);
    auditAuthState = caller.authState;
    const httpRuntime = resolveHttpRuntimeCallContext(
      routePolicy,
      app,
      caller,
    );

    if (httpRuntime.enforceTokenScopes) {
      if (!callerHasAppAccess(caller, [app.id, app.slug, appId])) {
        return finalize(
          json({
            error: `Token not authorized for this app. Scoped to: ${
              (caller.tokenAppIds || []).join(", ")
            }`,
          }, 403),
        );
      }

      if (!callerHasFunctionAccess(caller, [functionName])) {
        return finalize(
          json({
            error:
              `Token not authorized for function "${functionName}". Scoped to: ${
                (caller.tokenFunctionNames || []).join(", ")
              }`,
          }, 403),
        );
      }

      if (
        caller.authState === "authenticated" &&
        !callerHasRequiredScope(caller, "apps:call")
      ) {
        return finalize(
          json({ error: "Token missing required scope: apps:call" }, 403),
        );
      }
    }

    if (app.runtime === "gpu" && !isGpuSupportEnabled()) {
      return finalize(
        json({
          error: "GPU support disabled",
          type: "GPU_SUPPORT_DISABLED",
          message: getGpuSupportDisabledMessage("GPU runtime execution"),
        }, 503),
      );
    }

    // Weekly call limit check (counts against app owner)
    const ownerTier = await getUserTier(app.owner_id);
    const weeklyResult = await checkAndIncrementWeeklyCalls(
      app.owner_id,
      ownerTier,
      {
        mode: "fail_closed",
        resource: "HTTP endpoint weekly call limit",
      },
    );
    if (!weeklyResult.allowed) {
      if (weeklyResult.reason === "service_unavailable") {
        return finalize(
          json({
            error:
              "Usage controls are temporarily unavailable for this app. Please try again shortly.",
          }, 503),
        );
      }
      return finalize(
        json({
          error:
            "Weekly call limit exceeded for this app's owner. Try again next week.",
        }, 429),
      );
    }

    const code = await fetchAppEntryCode(app);

    if (!code) {
      return finalize(json({ error: "App code not found" }, 404));
    }

    // Check if the function exists in exports
    const exports = app.exports || [];
    if (
      !exports.includes(functionName) && functionName !== "handler" &&
      functionName !== "default"
    ) {
      return finalize(
        json({
          error: `Function "${functionName}" not found`,
          available_functions: exports.filter((e) => !e.startsWith("_")),
        }, 404),
      );
    }

    let envResolution;
    let supabaseConfig;
    let d1DataService;
    try {
      [envResolution, supabaseConfig, { d1DataService }] = await Promise
        .all([
          resolveAppRuntimeEnvVars(app, httpRuntime.envUserId),
          resolveAppSupabaseConfig(app),
          createAppD1Resources(app),
        ]);
    } catch (err) {
      if (err instanceof SupabaseConfigMigrationRequiredError) {
        return finalize(json({ error: err.message }, 409));
      }
      throw err;
    }
    const { envVars, credentials, missingRequiredSecrets } = envResolution;

    if (missingRequiredSecrets.length > 0) {
      return finalize(
        json({
          error: buildMissingAppSecretsMessage(missingRequiredSecrets),
          details: buildMissingAppSecretsErrorDetails(
            app.id,
            missingRequiredSecrets,
          ),
        }, 400),
      );
    }

    // Build the UltralightRequest object to pass to the function
    // This is a simplified Request-like object with useful properties
    const ultralightRequest = {
      method: request.method,
      url: requestUrl.pathname + requestUrl.search,
      path: subPath || "/",
      query: Object.fromEntries(requestUrl.searchParams),
      headers: Object.fromEntries(request.headers),
      // Body helpers
      json: async () => {
        try {
          return await request.clone().json();
        } catch {
          return null;
        }
      },
      text: async () => {
        try {
          return await request.clone().text();
        } catch {
          return "";
        }
      },
      formData: async () => {
        try {
          return Object.fromEntries(await request.clone().formData());
        } catch {
          return {};
        }
      },
    };
    const loggedInputArgs = {
      request: sanitizeHttpRequestForLogs(ultralightRequest),
    };

    // ── GPU Runtime Branch ──
    if (app.runtime === "gpu") {
      if (routineContext) {
        return finalize(
          json(
            {
              error: "Routine GPU budget admission unavailable",
              type: "ROUTINE_GPU_BUDGET_UNAVAILABLE",
              message:
                "GPU functions are unavailable to routines until hard pre-execution GPU budget admission is configured.",
            },
            409,
          ),
        );
      }

      if (!isGpuSupportEnabled()) {
        return finalize(
          json({
            error: "GPU support disabled",
            type: "GPU_SUPPORT_DISABLED",
            message: getGpuSupportDisabledMessage("GPU runtime execution"),
          }, 503),
        );
      }

      if (app.gpu_status !== "live") {
        return finalize(
          json(
            {
              error: "GPU function not ready",
              status: app.gpu_status,
              message: buildGpuNotReadyMessage(app.gpu_status),
              details: buildGpuStatusDiagnostics(app.gpu_status, {
                appId: app.id,
              }),
            },
            503,
          ),
        );
      }

      let gpuSlot;
      try {
        gpuSlot = await acquireGpuSlot(
          app.gpu_endpoint_id!,
          app.gpu_concurrency_limit || 5,
        );
      } catch {
        return finalize(json({ error: "GPU function at capacity" }, 429));
      }

      try {
        const receiptId = createExecutionReceiptId();
        auditReceiptId = receiptId;
        const gpuResult = await executeGpuFunction({
          app,
          functionName,
          args: { request: ultralightRequest },
          executionId: crypto.randomUUID(),
        });
        const gpuDurationMs = Date.now() - startTime;

        const { settlement } = await settleAndLogGpuExecution({
          receiptId,
          userId: httpRuntime.payerUserId,
          user: httpRuntime.payerUserId === user?.id ? user : null,
          app,
          functionName,
          inputArgs: loggedInputArgs,
          method: "http",
          gpuResult,
          durationMs: gpuDurationMs,
          routineContext,
        });

        if (settlement?.insufficientBalance) {
          return finalize(
            json({ error: settlement.insufficientBalanceMessage }, 402),
          );
        }

        console.log(
          `[HTTP-GPU] ${request.method} /http/${appId}/${functionName} - ${
            gpuResult.success ? "OK" : gpuResult.exitCode
          } - ${gpuDurationMs}ms`,
        );

        if (!gpuResult.success) {
          return finalize(
            new Response(
              JSON.stringify({
                error: gpuResult.error?.message || "GPU execution failed",
                type: gpuResult.error?.type,
                logs: gpuResult.logs,
                receipt_id: receiptId,
              }),
              {
                status: 500,
                headers: {
                  "Content-Type": "application/json",
                  "X-Light-Receipt-Id": receiptId,
                  ...buildCorsHeaders(request),
                },
              },
            ),
          );
        }

        // Handle the response (same formatting as Deno path below)
        const gpuFnResult = gpuResult.result;

        if (gpuFnResult instanceof Response) {
          return finalize(withReceiptHeader(gpuFnResult, receiptId));
        }

        if (gpuFnResult && typeof gpuFnResult === "object") {
          const resConfig = gpuFnResult as Record<string, unknown>;
          if ("statusCode" in resConfig || "status" in resConfig) {
            const status =
              (resConfig.statusCode || resConfig.status || 200) as number;
            const headers = new Headers(
              resConfig.headers as Record<string, string> || {},
            );
            const body = resConfig.body;
            if (!headers.has("Content-Type")) {
              headers.set("Content-Type", "application/json");
            }
            return finalize(
              new Response(
                typeof body === "string" ? body : JSON.stringify(body),
                { status, headers },
              ),
            );
          }
        }

        return finalize(
          new Response(
            JSON.stringify(attachHttpReceipt(gpuFnResult, receiptId)),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "X-Light-Receipt-Id": receiptId,
                ...buildCorsHeaders(request),
              },
            },
          ),
        );
      } finally {
        gpuSlot.release();
      }
    }

    if (!app.manifest) {
      return finalize(
        json(
          { error: "App manifest required for runtime execution" },
          422,
        ),
      );
    }

    // Execute the function in sandbox — AI-capable apps get 120s timeout
    const httpPermissions = resolveStrictManifestPermissions(app).permissions;
    const usesModel = httpPermissions.includes("ai:call") ||
      httpPermissions.includes("ai:embed");
    const billingRuntimeUser = usesModel
      ? await resolveHttpBillingRuntimeUser(app.owner_id, caller, httpRuntime)
      : (httpRuntime.payerUserId === user?.id ? user : null);
    // Per-function override keyed on the INSTALLER/payer (not the billing user,
    // which may be the app owner). The selection is the installer's choice; the
    // route still resolves keys/balance for billingRuntimeUser.
    const inferenceSelection = httpPermissions.includes("ai:call")
      ? await resolveFunctionInferenceOverride({
        userId: httpRuntime.payerUserId,
        appId: app.id,
        functionName,
      })
      : null;
    const subscriptionCapacityMode =
      getEnv("SUBSCRIPTION_CAPACITY_ENABLED") === "1" &&
      app.visibility === "private" &&
      app.owner_id === httpRuntime.payerUserId;
    const runtimeAI = usesModel
      ? await createRuntimeAIContext(billingRuntimeUser, {
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
    // Dynamic Worker sandbox — avoids `new Function()` restriction on CF Workers
    const { executeInDynamicSandbox } = await import(
      "../runtime/dynamic-sandbox.ts"
    );
    const receiptId = createExecutionReceiptId();
    auditReceiptId = receiptId;
    const timeoutMs = usesModel ? 120_000 : 30_000;
    const inputArgs = loggedInputArgs;
    const cloudPreflight = await preflightRuntimeCloudHold({
      app,
      userId: httpRuntime.payerUserId,
      functionName,
      inputArgs,
      receiptId,
      method: "http",
      timeoutMs,
      callerAuthState: caller.authState,
      routineContext,
      freeMode: caller.freeMode,
      byokPresent: caller.byokPresent,
      subscriptionCapacity: subscriptionCapacityMode,
    });
    if (cloudPreflight.insufficientBalance) {
      return finalize(
        new Response(
          JSON.stringify({
            error: cloudPreflight.insufficientBalanceMessage ||
              "Credits balance required to call this app.",
            type: cloudPreflight.insufficientBalanceCode || "LIGHT_REQUIRED",
            receipt_id: receiptId,
            details: cloudPreflight.metadata,
          }),
          {
            status: 402,
            headers: {
              "Content-Type": "application/json",
              "X-Light-Receipt-Id": receiptId,
              ...buildCorsHeaders(request),
            },
          },
        ),
      );
    }
    if (subscriptionCapacityMode) {
      const admission = await reserveAccountCapacity({
        userId: httpRuntime.payerUserId,
        idempotencyKey: `http:${receiptId}`,
        reserveLight: calculateExpectedRuntimeHoldAmount(
          timeoutMs,
          cloudPreflight.billingConfig,
        ),
        expiresAt: new Date(Date.now() + timeoutMs + 120_000).toISOString(),
        metadata: {
          surface: "http",
          app_id: app.id,
          function_name: functionName,
          receipt_id: receiptId,
        },
      });
      if (!admission.allowed || !admission.reservationId) {
        return finalize(
          new Response(
            JSON.stringify({
              error: `Account capacity is ${admission.state}. Work can resume at ${admission.nextEligibleAt}.`,
              type: "CAPACITY_WAITING",
              receipt_id: receiptId,
              details: accountCapacityErrorDetails(admission),
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": admission.nextEligibleAt
                  ? String(Math.max(1, Math.ceil(
                    (Date.parse(admission.nextEligibleAt) - Date.now()) / 1000,
                  )))
                  : "300",
                "X-Light-Receipt-Id": receiptId,
                ...buildCorsHeaders(request),
              },
            },
          ),
        );
      }
      capacityReservation = {
        id: admission.reservationId,
        userId: httpRuntime.payerUserId,
      };
    }
    const cloudOperationMetering = createRuntimeOperationMeteringContext({
      preflight: cloudPreflight,
      app,
      userId: httpRuntime.payerUserId,
      functionName,
      receiptId,
      method: "http",
      metadata: { surface: "http" },
      routineContext,
      ...(subscriptionCapacityMode
        ? {
          capacityMeter: {
            addLight: (amountLight: number) => {
              capacityOperationLight += Math.max(0, amountLight);
            },
          },
        }
        : {}),
    });
    const workerDataUrl = getEnv("WORKER_DATA_URL");
    const workerSecret = getEnv("WORKER_SECRET");
    const rawAppDataService = workerDataUrl && workerSecret
      ? createWorkerAppDataService(
        app.id,
        httpRuntime.appDataUserId,
        workerDataUrl,
        workerSecret,
        {
          operationMetering: cloudOperationMetering,
          billingConfig: cloudPreflight.billingConfig,
        },
      )
      : createAppDataService(app.id, httpRuntime.appDataUserId, {
        operationMetering: cloudOperationMetering,
        billingConfig: cloudPreflight.billingConfig,
      });
    const appDataService = httpRuntime.appDataUserId
      ? createMeteredAppDataService(
        rawAppDataService,
        httpRuntime.appDataUserId,
      )
      : rawAppDataService;
    const baseUrl = getEnv("BASE_URL") || undefined;
    const appCallDependencies = resolveRuntimeAppCallDependencies(app, caller);
    const memoryAdapter = caller.authState === "authenticated" &&
        (httpPermissions.includes("memory:read") ||
          httpPermissions.includes("memory:write"))
      ? createRuntimeMemoryAdapter(caller.userId, app.id)
      : null;
    const result = await executeInDynamicSandbox(
      {
        appId: app.id,
        userId: httpRuntime.sandboxUserId,
        ownerId: app.owner_id,
        expectedVersion: app.current_version || undefined,
        executionId: crypto.randomUUID(),
        code,
        permissions: httpPermissions,
        // Read-back only on the HTTP surface: runs.recent works for the
        // authenticated caller; nothing is recorded here (no routine context).
        flightRecorder:
          parseAppManifest(app.manifest)?.flight_recorder === true,
        allowedDestinations: getManifestAllowedDestinations(app.manifest),
        userApiKey: runtimeAI.userApiKey,
        aiUnavailableReason: runtimeAI.unavailableReason,
        aiRoute: runtimeAI.route,
        user,
        appDataService,
        d1DataService,
        memoryService: memoryAdapter,
        aiService: runtimeAI.aiService as {
          call: (
            request: import("../../shared/types/index.ts").AIRequest,
            apiKey: string,
          ) => Promise<import("../../shared/types/index.ts").AIResponse>;
        },
        envVars,
        credentials,
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
      [ultralightRequest],
    );

    const durationMs = Date.now() - startTime;
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
    let subscriptionCapacityLight: number | undefined;
    if (capacityReservation) {
      subscriptionCapacityLight = calculateExpectedRuntimeHoldAmount(
        result.durationMs,
        cloudPreflight.billingConfig,
      ) + capacityOperationLight;
      await settleAccountCapacity({
        reservationId: capacityReservation.id,
        userId: capacityReservation.userId,
        actualLight: subscriptionCapacityLight,
      });
    }

    const { settlement } = await settleAndLogAppExecution({
      receiptId,
      userId: httpRuntime.payerUserId,
      user: billingRuntimeUser,
      app,
      functionName,
      method: "http",
      success: result.success,
      durationMs,
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
      return finalize(
        new Response(
          JSON.stringify({
            error: settlement.insufficientBalanceMessage ||
              "Credits balance required to call this app.",
            type: settlement.insufficientBalanceCode || "LIGHT_REQUIRED",
            receipt_id: receiptId,
            details: settlement.metadata,
          }),
          {
            status: 402,
            headers: {
              "Content-Type": "application/json",
              "X-Light-Receipt-Id": receiptId,
              ...buildCorsHeaders(request),
            },
          },
        ),
      );
    }

    console.log(
      `[HTTP] ${request.method} /http/${appId}/${functionName} - ${
        result.success ? "OK" : "ERROR"
      } - ${durationMs}ms`,
    );

    if (!result.success) {
      return finalize(
        json({
          error: result.error?.message || "Execution failed",
          type: result.error?.type,
          logs: result.logs,
          receipt_id: receiptId,
        }, 500),
      );
    }

    // Handle the response
    const fnResult = result.result;

    // If the result is already a Response object, return it
    if (fnResult instanceof Response) {
      return finalize(withReceiptHeader(fnResult, receiptId));
    }

    // If the result has statusCode/status and body, treat it as a response config
    if (fnResult && typeof fnResult === "object") {
      const resConfig = fnResult as Record<string, unknown>;

      // Check for explicit response format
      if ("statusCode" in resConfig || "status" in resConfig) {
        const status =
          (resConfig.statusCode || resConfig.status || 200) as number;
        const headers = new Headers(
          resConfig.headers as Record<string, string> || {},
        );
        const body = resConfig.body;

        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        headers.set("X-Light-Receipt-Id", receiptId);

        return finalize(
          new Response(
            typeof body === "string" ? body : JSON.stringify(body),
            { status, headers },
          ),
        );
      }
    }

    // Default: wrap result as JSON response with CORS headers
    return finalize(
      new Response(
        JSON.stringify(attachHttpReceipt(fnResult, receiptId)),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Execution-Time": `${durationMs}ms`,
            "X-Light-Receipt-Id": receiptId,
            ...buildCorsHeaders(request),
          },
        },
      ),
    );
  } catch (err) {
    if (capacityReservation) {
      await releaseAccountCapacity({
        reservationId: capacityReservation.id,
        userId: capacityReservation.userId,
      }).catch(() => false);
    }
    console.error("[HTTP] Error:", err);
    return finalize(
      json({
        error: "Internal server error",
        message: err instanceof Error ? err.message : String(err),
      }, 500),
    );
  }
}

function attachHttpReceipt(result: unknown, receiptId: string): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), receipt_id: receiptId };
  }
  return { result, receipt_id: receiptId };
}

function withReceiptHeader(response: Response, receiptId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Light-Receipt-Id", receiptId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function userProfileToRuntimeUser(profile: UserProfile): UserContext {
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    avatarUrl: profile.avatar_url,
    tier: profile.tier,
    provisional: false,
  };
}

async function resolveHttpBillingRuntimeUser(
  ownerId: string,
  caller: RequestCallerContext,
  runtimeContext: HttpRuntimeCallContext,
): Promise<UserContext | null> {
  if (runtimeContext.payerUserId === caller.user?.id) {
    return caller.user;
  }

  if (runtimeContext.payerUserId !== ownerId) {
    return null;
  }

  if (caller.user?.id === ownerId) {
    return caller.user;
  }

  try {
    const ownerProfile = await createUserService().getUser(ownerId);
    return ownerProfile ? userProfileToRuntimeUser(ownerProfile) : null;
  } catch (err) {
    console.error("[HTTP] Failed to load owner runtime user:", err);
    return null;
  }
}

function parseHttpFunctionPath(path: string): {
  functionName: string;
  subPath: string;
} {
  const pathParts = path.split("/").filter(Boolean);
  return {
    functionName: pathParts[0] || "handler",
    subPath: "/" + pathParts.slice(1).join("/"),
  };
}

function routePolicyToCorsInput(
  policy: ResolvedHttpRoutePolicy,
): RouteCorsPolicyInput {
  return {
    origins: policy.cors?.origins,
    credentials: policy.cors?.credentials,
    headers: policy.cors?.headers,
    methods: policy.methods ?? undefined,
    maxAgeSeconds: policy.cors?.maxAgeSeconds,
  };
}

function buildRouteAllowHeader(policy: ResolvedHttpRoutePolicy): string {
  const methods = policy.methods && policy.methods.length > 0
    ? policy.methods
    : ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
  return [
    ...new Set([...methods.map((method) => method.toUpperCase()), "OPTIONS"]),
  ]
    .join(", ");
}

/**
 * Handle CORS preflight requests
 */
export async function handleHttpOptions(
  request: Request,
  appId: string,
  path = "",
): Promise<Response> {
  try {
    const { functionName } = parseHttpFunctionPath(path);
    const appsService = createAppsService();
    const app = await appsService.findById(appId);

    if (!app) {
      return buildCorsPreflightResponse(request);
    }

    if (app.http_enabled === false) {
      return new Response(null, { status: 403 });
    }

    const policy = resolveHttpRoutePolicy(app, functionName);
    return buildRouteCorsPreflightResponse(
      request,
      routePolicyToCorsInput(policy),
    );
  } catch (err) {
    console.error("[HTTP] CORS preflight error:", err);
    return buildCorsPreflightResponse(request);
  }
}
