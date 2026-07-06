import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";

import {
  buildTargetImageRef,
  generateGpuImageDockerfile,
  resolveBaseImage,
  resolveGpuImageBuildReadiness,
} from "./image-builder.ts";
import type { GpuConfig } from "./types.ts";

Deno.test("gpu image builder: resolves readiness from GitHub token config", () => {
  const originalEnv = globalThis.__env;
  try {
    globalThis.__env = {
      GITHUB_ACTIONS_TOKEN: "token",
      GPU_BUILD_CALLBACK_SECRET: "callback",
      GHCR_IMAGE_NAMESPACE: "ghcr.io/ultralight/gpu-apps/",
    } as typeof globalThis.__env;

    const readiness = resolveGpuImageBuildReadiness();
    assertEquals(readiness.ok, true);
    assertEquals(
      readiness.config?.imageNamespace,
      "ghcr.io/ultralight/gpu-apps",
    );
    assertEquals(readiness.config?.authMode, "token");
  } finally {
    globalThis.__env = originalEnv;
  }
});

Deno.test("gpu image builder: target image refs are normalized", () => {
  assertEquals(
    buildTargetImageRef(
      "APP_123",
      "Version 1.0",
      "ghcr.io/Galactic/GPU-Apps/",
    ),
    "ghcr.io/galactic/gpu-apps/app_123:version-1.0",
  );
});

Deno.test("gpu image builder: base image follows selected profile", () => {
  const originalEnv = globalThis.__env;
  try {
    globalThis.__env = {
      GITHUB_ACTIONS_TOKEN: "token",
      GPU_BUILD_CALLBACK_SECRET: "callback",
      GPU_BASE_IMAGE_PYTHON_CUDA: "ghcr.io/base/python:cuda",
      GPU_BASE_IMAGE_TORCH_CUDA: "ghcr.io/base/torch:cuda",
    } as typeof globalThis.__env;

    const config: GpuConfig = {
      runtime: "gpu",
      gpu_type: "A40",
      base: "torch-cuda",
    };
    assertEquals(resolveBaseImage(config), "ghcr.io/base/torch:cuda");
  } finally {
    globalThis.__env = originalEnv;
  }
});

Deno.test("gpu image builder: generated Dockerfile installs requirements at build time", () => {
  const dockerfile = generateGpuImageDockerfile({
    baseImage: "ghcr.io/base/python:cuda",
    appId: "app-123",
    version: "1.0.0",
  });

  assertStringIncludes(dockerfile, "FROM ghcr.io/base/python:cuda");
  assertStringIncludes(dockerfile, "ULTRALIGHT_BAKED_IMAGE=1");
  assertStringIncludes(
    dockerfile,
    "pip install --no-cache-dir -r /tmp/requirements.txt",
  );
  assertStringIncludes(dockerfile, 'CMD ["python", "-u", "/app/harness.py"]');
});
