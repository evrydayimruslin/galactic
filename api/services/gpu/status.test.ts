import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  buildGpuNotReadyMessage,
  buildGpuPublishBlockerMessage,
  buildGpuStatusDiagnostics,
  resolveGpuStatusDetails,
} from "./status.ts";

Deno.test("gpu status: explains invalid build configuration clearly", () => {
  assertEquals(resolveGpuStatusDetails("build_config_invalid"), {
    status: "build_config_invalid",
    phase: "misconfigured",
    ready: false,
    transient: false,
    requires_reupload: false,
    requires_platform_fix: true,
    detail: "The platform GPU build configuration is invalid.",
    remediation:
      "Fix the platform GPU environment or template configuration, then re-upload to retry.",
  });

  assertEquals(
    buildGpuNotReadyMessage("build_config_invalid"),
    "GPU function is not ready (status: build_config_invalid). The platform GPU build configuration is invalid. Fix the platform GPU environment or template configuration, then re-upload to retry.",
  );
});

Deno.test("gpu status: exposes structured diagnostics for inspect and runtime errors", () => {
  assertEquals(
    buildGpuStatusDiagnostics("building", { appId: "app-123" }),
    {
      type: "GPU_STATUS",
      status: "building",
      phase: "building",
      ready: false,
      transient: true,
      requires_reupload: false,
      requires_platform_fix: false,
      detail: "Container build is still in progress.",
      remediation: "Wait for the build to finish, then try again.",
      app_id: "app-123",
      inspect_command:
        'gx.discover({ scope: "inspect", app_id: "app-123" })',
    },
  );
});

Deno.test("gpu status: explains publish blockers for transient and unknown states", () => {
  assertEquals(
    buildGpuPublishBlockerMessage("building"),
    "Cannot publish GPU app until gpu_status is 'live' (current: building). Container build is still in progress. Wait for the build to finish, then try again.",
  );

  assertEquals(
    buildGpuPublishBlockerMessage(null),
    "Cannot publish GPU app until gpu_status is 'live' (current: null). The GPU function has not been built yet. Upload or re-upload the GPU app after the GPU build configuration is fixed.",
  );
});
