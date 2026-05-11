import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { resolveRunPodTemplateResolution } from "./runpod.ts";

Deno.test("runpod template resolution: baked images bypass runtime code injection", () => {
  const result = resolveRunPodTemplateResolution({
    appId: "app-123",
    version: "1.2.3",
    imageRef: "ghcr.io/ultralight/gpu-apps/app-123:1.2.3",
    imageDigest: "sha256:abc",
  });

  assertEquals(result, {
    mode: "image",
    imageName: "ghcr.io/ultralight/gpu-apps/app-123:1.2.3@sha256:abc",
    env: {
      ULTRALIGHT_BAKED_IMAGE: "1",
      ULTRALIGHT_APP_ID: "app-123",
      ULTRALIGHT_VERSION: "1.2.3",
    },
  });
});

Deno.test("runpod template resolution: prefers per-app template injection when fully configured", () => {
  const result = resolveRunPodTemplateResolution({
    appId: "app-123",
    version: "1.2.3",
    baseImage: "ghcr.io/example/base:latest",
    platformUrl: "https://platform.example/",
    gpuSecret: "gpu-secret",
  });

  assertEquals(result, {
    mode: "per_app",
    imageName: "ghcr.io/example/base:latest",
    codeUrl: "https://platform.example/internal/gpu/code/app-123/1.2.3",
    env: {
      ULTRALIGHT_CODE_URL:
        "https://platform.example/internal/gpu/code/app-123/1.2.3",
      ULTRALIGHT_PLATFORM_SECRET: "gpu-secret",
      ULTRALIGHT_APP_ID: "app-123",
      ULTRALIGHT_VERSION: "1.2.3",
    },
  });
});

Deno.test("runpod template resolution: fails closed when per-app injection is unavailable", async () => {
  await assertRejects(
    async () => {
      resolveRunPodTemplateResolution({
        appId: "app-123",
        version: "1.2.3",
        baseImage: "",
        platformUrl: "https://platform.example",
        gpuSecret: "",
      });
    },
    Error,
    "GPU build requires per-app template injection",
  );
});

Deno.test("runpod template resolution: shared fallback requires an explicit opt-in", () => {
  const result = resolveRunPodTemplateResolution({
    appId: "app-123",
    version: "1.2.3",
    sharedTemplateId: "template-123",
    allowSharedTemplateFallback: true,
  });

  assertEquals(result, {
    mode: "shared",
    templateId: "template-123",
    warning:
      "Using legacy shared template fallback because per-app template injection is unavailable. Missing: RUNPOD_BASE_IMAGE, PLATFORM_URL or APP_URL, GPU_INTERNAL_SECRET.",
  });
});
