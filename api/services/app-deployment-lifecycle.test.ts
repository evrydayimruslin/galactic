import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  AppDeploymentExecutionError,
  assertAppDeploymentRunnable,
} from "./app-deployment-lifecycle.ts";

const RELEASE_DIGEST = "a".repeat(64);

Deno.test("app deployment lifecycle: explicitly runnable states remain runnable", () => {
  for (const deploymentState of ["legacy", "ready"] as const) {
    assertAppDeploymentRunnable({
      deployment_state: deploymentState,
      hosting_suspended: false,
      active_release_digest: deploymentState === "ready"
        ? RELEASE_DIGEST
        : null,
    });
  }
});

Deno.test("app deployment lifecycle: runnable states still honor suspension", () => {
  for (const deploymentState of ["legacy", "ready"] as const) {
    const error = assertThrows(
      () =>
        assertAppDeploymentRunnable({
          deployment_state: deploymentState,
          hosting_suspended: true,
          active_release_digest: deploymentState === "ready"
            ? RELEASE_DIGEST
            : null,
        }),
      AppDeploymentExecutionError,
    );
    assertEquals(error.code, "APP_DEPLOYMENT_SUSPENDED");
    assertEquals(error.status, 403);
    assertEquals(error.deploymentState, deploymentState);
  }
});

Deno.test("app deployment lifecycle: incomplete suspension projections fail closed", () => {
  for (const hostingSuspended of [undefined, null]) {
    const error = assertThrows(
      () =>
        assertAppDeploymentRunnable({
          deployment_state: "ready",
          hosting_suspended: hostingSuspended,
          active_release_digest: RELEASE_DIGEST,
        }),
      AppDeploymentExecutionError,
    );
    assertEquals(error.code, "APP_DEPLOYMENT_STATE_INVALID");
    assertEquals(error.status, 503);
    assertEquals(error.deploymentState, "ready");
  }
});

Deno.test("app deployment lifecycle: ready state requires a canonical release digest", () => {
  for (const activeReleaseDigest of [
    undefined,
    null,
    "",
    "not-a-digest",
    "A".repeat(64),
  ]) {
    const error = assertThrows(
      () =>
        assertAppDeploymentRunnable({
          deployment_state: "ready",
          hosting_suspended: false,
          active_release_digest: activeReleaseDigest,
        }),
      AppDeploymentExecutionError,
    );
    assertEquals(error.code, "APP_DEPLOYMENT_STATE_INVALID");
    assertEquals(error.status, 503);
  }
});

Deno.test("app deployment lifecycle: non-runnable states expose stable errors", () => {
  const cases = [
    {
      state: "materializing",
      code: "APP_DEPLOYMENT_MATERIALIZING",
      status: 409,
    },
    {
      state: "setup_required",
      code: "APP_DEPLOYMENT_SETUP_REQUIRED",
      status: 409,
    },
    {
      state: "disabled",
      code: "APP_DEPLOYMENT_DISABLED",
      status: 403,
    },
  ] as const;

  for (const testCase of cases) {
    const error = assertThrows(
      () =>
        assertAppDeploymentRunnable({
          deployment_state: testCase.state,
          hosting_suspended: true,
        }),
      AppDeploymentExecutionError,
    );
    assertEquals(error.code, testCase.code);
    assertEquals(error.status, testCase.status);
    assertEquals(error.deploymentState, testCase.state);
  }
});

Deno.test("app deployment lifecycle: unknown states fail closed", () => {
  const error = assertThrows(
    () => assertAppDeploymentRunnable({ deployment_state: "future_state" }),
    AppDeploymentExecutionError,
  );
  assertEquals(error.code, "APP_DEPLOYMENT_STATE_INVALID");
  assertEquals(error.status, 503);
  assertEquals(error.deploymentState, "future_state");
});

Deno.test("app deployment lifecycle: incomplete projections fail closed", () => {
  for (const deploymentState of [undefined, null]) {
    const error = assertThrows(
      () => assertAppDeploymentRunnable({ deployment_state: deploymentState }),
      AppDeploymentExecutionError,
    );
    assertEquals(error.code, "APP_DEPLOYMENT_STATE_INVALID");
    assertEquals(error.status, 503);
    assertEquals(error.deploymentState, "missing");
  }
});
