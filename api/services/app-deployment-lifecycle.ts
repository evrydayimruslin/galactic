type AppDeploymentExecutionErrorCode =
  | "APP_DEPLOYMENT_MATERIALIZING"
  | "APP_DEPLOYMENT_SETUP_REQUIRED"
  | "APP_DEPLOYMENT_NATIVE_ROUTE_UNAVAILABLE"
  | "APP_DEPLOYMENT_SUSPENDED"
  | "APP_DEPLOYMENT_DISABLED"
  | "APP_DEPLOYMENT_STATE_INVALID";

export interface AppDeploymentLifecycleSource {
  deployment_state?: unknown;
  hosting_suspended?: unknown;
  active_release_digest?: unknown;
}

export class AppDeploymentExecutionError extends Error {
  readonly code: AppDeploymentExecutionErrorCode;
  readonly status: number;
  readonly deploymentState: string;

  constructor(input: {
    code: AppDeploymentExecutionErrorCode;
    message: string;
    status: number;
    deploymentState: string;
  }) {
    super(input.message);
    this.name = "AppDeploymentExecutionError";
    this.code = input.code;
    this.status = input.status;
    this.deploymentState = input.deploymentState;
  }
}

/**
 * Enforces the durable deployment lifecycle at every runtime entry point.
 *
 * The deployment migration backfills every existing row to `legacy`, so an
 * absent state means an execution query returned an incomplete projection.
 * Missing, unknown, and corrupt states all fail closed.
 */
export function assertAppDeploymentRunnable(
  app: AppDeploymentLifecycleSource,
): void {
  const rawState = app.deployment_state;
  if (rawState === "legacy" || rawState === "ready") {
    if (
      app.hosting_suspended === false &&
      (
        rawState === "legacy" ||
        (
          typeof app.active_release_digest === "string" &&
          /^[a-f0-9]{64}$/.test(app.active_release_digest)
        )
      )
    ) {
      return;
    }
    if (app.hosting_suspended === true) {
      throw new AppDeploymentExecutionError({
        code: "APP_DEPLOYMENT_SUSPENDED",
        message: "This Agent is suspended and cannot run.",
        status: 403,
        deploymentState: rawState,
      });
    }
    if (rawState === "ready") {
      throw new AppDeploymentExecutionError({
        code: "APP_DEPLOYMENT_STATE_INVALID",
        message:
          "This Agent's active release identity is unavailable, so it cannot run.",
        status: 503,
        deploymentState: rawState,
      });
    }
    throw new AppDeploymentExecutionError({
      code: "APP_DEPLOYMENT_STATE_INVALID",
      message:
        "This Agent's suspension state is unavailable, so it cannot run.",
      status: 503,
      deploymentState: rawState,
    });
  }

  if (rawState === "materializing") {
    throw new AppDeploymentExecutionError({
      code: "APP_DEPLOYMENT_MATERIALIZING",
      message: "This Agent is still being deployed and cannot run yet.",
      status: 409,
      deploymentState: rawState,
    });
  }

  if (rawState === "setup_required") {
    throw new AppDeploymentExecutionError({
      code: "APP_DEPLOYMENT_SETUP_REQUIRED",
      message: "This Agent must finish setup before it can run.",
      status: 409,
      deploymentState: rawState,
    });
  }

  if (rawState === "disabled") {
    throw new AppDeploymentExecutionError({
      code: "APP_DEPLOYMENT_DISABLED",
      message: "This Agent is disabled and cannot run.",
      status: 403,
      deploymentState: rawState,
    });
  }

  throw new AppDeploymentExecutionError({
    code: "APP_DEPLOYMENT_STATE_INVALID",
    message:
      "This Agent's deployment state is unavailable or unsupported, so it cannot run.",
    status: 503,
    deploymentState: typeof rawState === "string" ? rawState : "missing",
  });
}

/**
 * The `/a/:appId/*` data-URL executor is retained solely for pre-M7 Agents.
 * Canonical releases must execute from their immutable release bundle through
 * the hardened Dynamic Worker surfaces instead of mutable source in R2.
 */
export function assertAppNativeRouteRunnable(
  app: AppDeploymentLifecycleSource,
): void {
  assertAppDeploymentRunnable(app);
  if (app.deployment_state === "legacy") return;

  throw new AppDeploymentExecutionError({
    code: "APP_DEPLOYMENT_NATIVE_ROUTE_UNAVAILABLE",
    message: "This Agent release cannot run through the legacy native route.",
    status: 409,
    deploymentState: String(app.deployment_state),
  });
}
