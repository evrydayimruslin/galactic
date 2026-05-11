import { json } from "./response.ts";
import { getEnv } from "../lib/env.ts";
import { createR2Service } from "../services/storage.ts";
import { createD1DataService } from "../services/d1-data.ts";
import { getD1DatabaseId } from "../services/d1-provisioning.ts";
import {
  fetchGpuBuildContext,
  verifyGpuBuildCallbackSecret,
} from "../services/gpu/image-builder.ts";
import { completeGpuImageBuild } from "../services/gpu/builder.ts";

/**
 * GPU Code Proxy — serves developer code bundles to RunPod workers.
 *
 * Route: GET /internal/gpu/code/:appId/:version
 * Auth: X-GPU-Secret header must match GPU_INTERNAL_SECRET env var.
 * Returns: JSON code bundle { files: { "main.py": "...", ... }, version: "..." }
 */
export async function handleGpuCodeProxy(
  request: Request,
  path: string,
): Promise<Response> {
  const expectedSecret = getEnv("GPU_INTERNAL_SECRET");
  const providedSecret = request.headers.get("X-GPU-Secret") || "";

  if (!expectedSecret || providedSecret !== expectedSecret) {
    console.error(
      "[GPU-CODE-PROXY] Auth failed — invalid or missing X-GPU-Secret",
    );
    return json({ error: "Unauthorized" }, 401);
  }

  const parts = path.replace("/internal/gpu/code/", "").split("/");
  const appId = parts[0];
  const version = parts[1];

  if (!appId || !version) {
    return json({ error: "Missing appId or version" }, 400);
  }

  try {
    const r2 = createR2Service();
    const bundleKey = `apps/${appId}/${version}/_bundle.json`;
    const content = await r2.fetchTextFile(bundleKey);
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error(
      `[GPU-CODE-PROXY] Failed to fetch bundle for ${appId}@${version}:`,
      err,
    );
    return json({ error: "Code bundle not found" }, 404);
  }
}

/**
 * GPU Build Context Proxy - serves one-time-ish Docker build contexts to GitHub Actions.
 *
 * Route: GET /internal/gpu/build-context/:appId/:version/:token
 * Auth: unguessable 256-bit token in path, with server-side expiry metadata.
 * Returns: application/x-tar Docker build context.
 */
export async function handleGpuBuildContextProxy(
  _request: Request,
  path: string,
): Promise<Response> {
  const parts = path.replace("/internal/gpu/build-context/", "").split("/");
  const appId = parts[0];
  const version = parts[1];
  const token = parts[2];

  if (!appId || !version || !token) {
    return json({ error: "Missing appId, version, or token" }, 400);
  }

  try {
    const { content, metadata } = await fetchGpuBuildContext(
      appId,
      version,
      token,
    );
    const body = new ArrayBuffer(content.byteLength);
    new Uint8Array(body).set(content);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/x-tar",
        "Cache-Control": "no-store",
        "X-Ultralight-Build-Id": metadata.build_id,
      },
    });
  } catch (err) {
    console.error(`[GPU-BUILD-CONTEXT] Failed for ${appId}@${version}:`, err);
    return json({ error: "Build context not found" }, 404);
  }
}

/**
 * GPU Build Callback - GitHub Actions calls this after GHCR image build.
 *
 * Route: POST /internal/gpu/build-callback
 * Auth: X-GPU-Build-Secret or Bearer token must match GPU_BUILD_CALLBACK_SECRET.
 */
export async function handleGpuBuildCallback(
  request: Request,
): Promise<Response> {
  if (!verifyGpuBuildCallbackSecret(request)) {
    console.error("[GPU-BUILD-CALLBACK] Auth failed");
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const payload = await request
      .json() as import("../services/gpu/image-builder.ts").GpuImageBuildCallbackPayload;
    const result = await completeGpuImageBuild(payload);
    return json(result, result.ok ? 200 : 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GPU-BUILD-CALLBACK] Failed:", err);
    return json({ ok: false, status: "error", message }, 500);
  }
}

/**
 * Internal D1 Query Proxy — allows GPU workers to execute D1 queries.
 *
 * Route: POST /internal/d1/query
 * Auth: X-GPU-Secret header must match GPU_INTERNAL_SECRET env var.
 * Body: { appId, userId, sql, params?, mode?: 'all' | 'first' | 'run' }
 * Returns: { results } or { result } or { row }
 */
export async function handleInternalD1Query(
  request: Request,
): Promise<Response> {
  const expectedSecret = getEnv("GPU_INTERNAL_SECRET");
  const providedSecret = request.headers.get("X-GPU-Secret") || "";

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await request.json() as {
      appId: string;
      userId: string;
      sql: string;
      params?: unknown[];
      mode?: "all" | "first" | "run";
    };

    if (!body.appId || !body.sql) {
      return json({ error: "Missing appId or sql" }, 400);
    }

    const databaseId = await getD1DatabaseId(body.appId);
    if (!databaseId) {
      return json({ error: "D1 database not provisioned for this app" }, 404);
    }

    const d1 = createD1DataService(body.appId, databaseId);
    const mode = body.mode || "all";

    if (mode === "run") {
      const result = await d1.run(body.sql, body.params);
      return json({ result });
    }
    if (mode === "first") {
      const row = await d1.first(body.sql, body.params);
      return json({ row });
    }

    const results = await d1.all(body.sql, body.params);
    return json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
}
