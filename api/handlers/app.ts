// App Router
// Routes requests to appropriate handlers

import { handleUpload } from "./upload.ts";
import { handleRun } from "./run.ts";
import { handleAuth } from "./auth.ts";
import { authenticate } from "./auth.ts";
import { appStoreUrl, deepLinkAppUrl, downloadUrl } from "../lib/urls.ts";
import { handleApps, handleOgCard } from "./apps.ts";
import { handleUser } from "./user.ts";
import { handleLaunch } from "./launch.ts";
import { handleMcp, handleMcpDiscovery } from "./mcp.ts";
import {
  handlePlatformMcp,
  handlePlatformMcpDiscovery,
  handleSkills,
} from "./platform-mcp.ts";
import { handleOAuth } from "./oauth.ts";
import { handleDiscover, handleOnboarding } from "./discover.ts";
import { handleMcpConfig } from "./config.ts";
import { handleHttpEndpoint, handleHttpOptions } from "./http.ts";
import {
  handleGpuBuildCallback,
  handleGpuBuildContextProxy,
  handleGpuCodeProxy,
  handleInternalD1Query,
} from "./internal-proxy.ts";
import { handleTierChange } from "./tier.ts";
import { handleAdmin } from "./admin.ts";
import { handleDeveloper } from "./developer.ts";
import {
  handleCapabilitySuggestionEventTelemetry,
  handleChatContext,
  handleChatInferenceOptions,
  handleChatModels,
  handleChatStream,
  handleFunctionIndex,
  handleOrchestrate,
  handlePlanCancel,
  handlePlanConfirm,
  handleProvisionKey,
  handleSuggestionAccept,
  handleSuggestionPreview,
  handleSuggestionPreviewBatch,
  handleToolInvocationTelemetry,
  handleTurnCancel,
} from "./chat.ts";
import { error, json, toResponseBody } from "./response.ts";
import {
  appendCookie,
  getCookieValueFromRequest,
} from "../services/auth-cookies.ts";
import { getLayoutHTML } from "../../web/layout.ts";
import { createAppsService } from "../services/apps.ts";
import { createR2Service } from "../services/storage.ts";
import { getCodeCache } from "../services/codecache.ts";
import {
  type AppContractResolution,
  type AppFunctionContract,
  logAppContractResolution,
  resolveAppFunctionContracts,
} from "../services/app-contracts.ts";
import { hasValidPageShareSession } from "../services/page-share-session.ts";
import { fetchAppEntryCode } from "../services/app-runtime-resources.ts";
import { buildAppTrustCard, type TrustCard } from "../services/trust.ts";
import { resolveExecutedIntegrity } from "../services/executed-bundle.ts";
import {
  buildMarketplaceListingSummary,
  type MarketplaceListingSummary,
  type MarketplaceListingSummaryListing,
} from "../services/marketplace.ts";
import {
  getBillingConfig,
  toPublicBillingConfig,
} from "../services/billing-config.ts";
import {
  createReferralClaimToken,
  fetchActiveReferralLinkBySlug,
  recordReferralLanding,
  REFERRAL_VISITOR_COOKIE_MAX_AGE_SECONDS,
  REFERRAL_VISITOR_COOKIE_NAME,
  sha256Hex,
} from "../services/referrals.ts";
import {
  isGpuSupportEnabled,
  sanitizeGpuTrustCard,
} from "../services/gpu/feature-flag.ts";
import { getEnv } from "../lib/env.ts";
import {
  formatDollarsFromLight,
  formatLight,
} from "../../shared/types/index.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";

function renderLayoutHTML(
  options: Parameters<typeof getLayoutHTML>[0],
): string {
  return getLayoutHTML({
    ...options,
    gpuSupportEnabled: isGpuSupportEnabled(),
  });
}

// ============================================
// CACHE HELPERS
// ============================================

/**
 * Generate a strong ETag from app version and update timestamp.
 * This changes whenever the app is published or updated.
 */
function generateAppETag(
  app: { current_version?: string; updated_at?: string; storage_key: string },
): string {
  const version = app.current_version || "0";
  const updated = app.updated_at || "0";
  // Use a short hash of version + timestamp for the ETag
  let hash = 0;
  const str = `${version}:${updated}:${app.storage_key}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `"app-${Math.abs(hash).toString(36)}"`;
}

/**
 * Check If-None-Match and return 304 if ETag matches.
 * Returns null if no match (caller should serve full response).
 */
function checkConditionalRequest(
  request: Request,
  etag: string,
): Response | null {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `W/${etag}`)) {
    return new Response(null, {
      status: 304,
      headers: {
        "ETag": etag,
        "Cache-Control": "public, max-age=3600",
      },
    });
  }
  return null;
}

/**
 * Add standard cache headers to an app response.
 * - HTML pages: 1 hour cache with ETag for revalidation
 * - Versioned assets: 1 year immutable cache
 */
function addCacheHeaders(
  headers: Record<string, string>,
  etag: string,
  immutable = false,
): Record<string, string> {
  if (immutable) {
    return {
      ...headers,
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": etag,
    };
  }
  return {
    ...headers,
    "Cache-Control": "public, max-age=3600",
    "ETag": etag,
    "Vary": "Accept-Encoding",
  };
}

export function createApp() {
  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Developer portal subdomain routing
      const host = request.headers.get("host") || "";
      if (host.startsWith("dev.")) {
        return handleDeveloper(request);
      }

      // Developer portal on main domain path
      if (path === "/developer" && method === "GET") {
        return handleDeveloper(request);
      }
      if (path.startsWith("/api/developer/")) {
        return handleDeveloper(request);
      }

      // Detect embed mode (desktop app iframe)
      const isEmbed = url.searchParams.get("embed") === "1";

      // Public homepage. Browsers go to the launch site — the worker-served
      // HTML is the legacy pre-pivot UI and only the desktop embed (iframe,
      // ?embed=1) still uses it.
      if (path === "/" && method === "GET") {
        const launchWebBaseUrl = getEnv("LAUNCH_WEB_BASE_URL");
        if (!isEmbed && launchWebBaseUrl) {
          // Manual construction: Response.redirect() headers are immutable
          // and the entrypoint sets security headers on every response.
          return new Response(null, {
            status: 302,
            headers: { Location: launchWebBaseUrl },
          });
        }
        return new Response(
          renderLayoutHTML({ initialView: "home", embed: isEmbed }),
          {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // Desktop app download page
      if (path === "/download" && method === "GET") {
        return new Response(getDownloadPageHTML(), {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        });
      }

      // Desktop app binary download
      if (path === "/download/macos" && method === "GET") {
        try {
          const r2 = createR2Service();
          const dmgData = await r2.fetchFile(
            "desktop/Galactic_0.1.0_x64.dmg",
          );
          return new Response(toResponseBody(dmgData), {
            headers: {
              "Content-Type": "application/x-apple-diskimage",
              "Content-Disposition":
                'attachment; filename="Galactic_0.1.0_x64.dmg"',
              "Content-Length": String(dmgData.byteLength),
            },
          });
        } catch {
          return new Response(
            "Download unavailable. Build may not be uploaded yet.",
            { status: 404 },
          );
        }
      }

      // Desktop app binary upload (authenticated — used to push new builds)
      if (path === "/download/upload" && method === "PUT") {
        try {
          // Validate API token
          const authHeader = request.headers.get("Authorization");
          if (
            !authHeader?.startsWith("Bearer gx_") &&
            !authHeader?.startsWith("Bearer ul_")
          ) {
            return new Response("Unauthorized", { status: 401 });
          }
          const { validateToken } = await import("../services/tokens.ts");
          const validated = await validateToken(authHeader.slice(7));
          if (!validated) return new Response("Invalid token", { status: 401 });

          const body = new Uint8Array(await request.arrayBuffer());
          if (body.length === 0) return error("Empty body");
          if (body.length > 50 * 1024 * 1024) {
            return error("File too large (max 50MB)");
          }

          const r2 = createR2Service();
          await r2.uploadFile("desktop/Galactic_0.1.0_x64.dmg", {
            name: "Galactic_0.1.0_x64.dmg",
            content: body,
            contentType: "application/x-apple-diskimage",
          });
          return json({
            success: true,
            size: body.length,
            key: "desktop/Galactic_0.1.0_x64.dmg",
          });
        } catch (e) {
          return error(e instanceof Error ? e.message : "Upload failed", 500);
        }
      }

      // Capabilities (unified Library + Marketplace)
      if (path === "/capabilities" && method === "GET") {
        const launchWebBaseUrl = getEnv("LAUNCH_WEB_BASE_URL");
        if (!isEmbed && launchWebBaseUrl) {
          return new Response(null, {
            status: 302,
            headers: { Location: `${launchWebBaseUrl}/library` },
          });
        }
        return new Response(
          renderLayoutHTML({
            initialView: "dashboard",
            embed: isEmbed,
            dashSection: "capabilities",
          }),
          {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // Dashboard — backward compat, maps to capabilities
      if (path === "/dash" && method === "GET") {
        return new Response(
          renderLayoutHTML({
            initialView: "dashboard",
            embed: isEmbed,
            dashSection: "capabilities",
          }),
          {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // Wallet — canonical payment portal shared by web and desktop embeds.
      if (path === "/wallet" && method === "GET") {
        return new Response(
          renderLayoutHTML({
            initialView: "dashboard",
            embed: isEmbed,
            dashSection: "billing",
          }),
          {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // Terms and payment policy hooks used by funding, payout, and fee-waiver flows.
      if (path === "/terms" && method === "GET") {
        return new Response(await renderTermsHTML(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      // Settings page (account settings) — supports /settings, /settings/tokens, /settings/billing, /settings/supabase
      if (
        (path === "/settings" || path.startsWith("/settings/")) &&
        method === "GET"
      ) {
        const settingsSub = path.split("/settings/")[1] || "keys";
        const section = settingsSub === "billing"
          ? "billing"
          : settingsSub === "tokens"
          ? "keys"
          : settingsSub;
        return new Response(
          renderLayoutHTML({
            initialView: "dashboard",
            embed: isEmbed,
            dashSection: section,
          }),
          {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // Marketplace — backward compat, maps to capabilities
      if (path === "/marketplace" && method === "GET") {
        return new Response(
          renderLayoutHTML({
            initialView: "dashboard",
            embed: isEmbed,
            dashSection: "capabilities",
          }),
          {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // Public user profile
      if (path.startsWith("/u/") && method === "GET") {
        const slug = path.slice(3);
        if (slug) {
          return new Response(
            renderLayoutHTML({ initialView: "profile", profileSlug: slug }),
            {
              headers: {
                "Content-Type": "text/html",
                "Cache-Control": "no-store",
              },
            },
          );
        }
      }

      // My profile (authenticated)
      if (path === "/my-profile" && method === "GET") {
        return new Response(
          renderLayoutHTML({ initialView: "profile", embed: isEmbed }),
          {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // Gaps board & Leaderboard → redirect to capabilities
      if ((path === "/gaps" || path === "/leaderboard") && method === "GET") {
        return new Response(null, {
          status: 302,
          headers: { "Location": "/capabilities" },
        });
      }

      // Health check - includes deploy timestamp and cache stats
      if (path === "/health") {
        const cacheStats = getCodeCache().stats;
        return json({
          status: "ok",
          version: "0.3.18",
          deployed: new Date().toISOString(),
          cache: cacheStats,
        });
      }

      // Legacy /upload redirects to home
      if (path === "/upload" && method === "GET") {
        return new Response(null, {
          status: 302,
          headers: { "Location": "/" },
        });
      }

      // OAuth 2.1 routes for MCP spec compliance
      // Protected Resource Metadata + Authorization Server Metadata + OAuth endpoints
      if (
        path === "/.well-known/oauth-protected-resource" ||
        path === "/.well-known/oauth-authorization-server" ||
        path.startsWith("/oauth/")
      ) {
        return handleOAuth(request);
      }

      // Auth routes
      if (path.startsWith("/auth")) {
        return handleAuth(request);
      }

      // Upload route
      if (path === "/api/upload" && method === "POST") {
        return handleUpload(request);
      }

      // (Removed) The temporary /api/imap-test debug endpoint took a raw
      // host/port with no SSRF guard and interpolated user/pass into an IMAP
      // LOGIN with no CRLF sanitization. It had no callers; deleted outright.

      // Internal TCP protocol endpoints — called by Dynamic Worker sandbox via fetch()
      // Internal event emit (Phase 4.5 pub/sub). Auth is DOUBLE-gated:
      // X-Worker-Secret proves an internal (sandbox/SELF) caller, and the
      // signed X-Galactic-Caller token proves the emitter app id + user
      // unforgeably. App code cannot forge either, so the emitter/user can't
      // be spoofed by sandbox JS.
      if (path === "/api/events/emit" && method === "POST") {
        const secret = request.headers.get("X-Worker-Secret");
        if (!secret || secret !== getEnv("WORKER_SECRET")) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const { verifyCallerContextToken } = await import(
            "../services/agent-caller-context.ts"
          );
          const callerHeader = request.headers.get("X-Galactic-Caller");
          const verified = callerHeader
            ? await verifyCallerContextToken(callerHeader)
            : { claims: null };
          if (!verified.claims) {
            return new Response(
              JSON.stringify({ error: "Invalid emitter context" }),
              { status: 403, headers: { "Content-Type": "application/json" } },
            );
          }
          const body = await request.json() as {
            topic?: unknown;
            payload?: unknown;
          };
          const { emitEvent } = await import("../services/agent-events.ts");
          const out = await emitEvent({
            userId: verified.claims.userId,
            emitterAppId: verified.claims.callerAppId,
            topic: typeof body.topic === "string" ? body.topic : "",
            payload: (body.payload && typeof body.payload === "object")
              ? body.payload as Record<string, unknown>
              : {},
            emitHop: verified.claims.hop,
          });
          return new Response(
            JSON.stringify({
              ok: !out.rejected,
              event_id: out.eventId,
              rejected: out.rejected ?? null,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (e: unknown) {
          return new Response(
            JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // Auth: X-Worker-Secret header (service-to-service, not user-facing)
      if (path === "/api/net/imap-fetch" && method === "POST") {
        const secret = request.headers.get("X-Worker-Secret");
        if (!secret || secret !== getEnv("WORKER_SECRET")) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const { imapFetchUnseen } = await import(
            "../services/tcp-protocols.ts"
          );
          const body = await request.json() as Record<string, unknown>;
          const result = await imapFetchUnseen(
            body.host as string,
            body.port as number,
            body.user as string,
            body.pass as string,
            (body.lastUid as number) || 0,
            (body.businessEmail as string) || "",
            (body.processedFlag as string) || "$ULProcessed",
            (body.limit as number) || 20,
          );
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e: unknown) {
          return new Response(
            JSON.stringify({
              error: e instanceof Error ? e.message : String(e),
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      if (path === "/api/net/smtp-send" && method === "POST") {
        const secret = request.headers.get("X-Worker-Secret");
        if (!secret || secret !== getEnv("WORKER_SECRET")) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const { smtpSend } = await import("../services/tcp-protocols.ts");
          const body = await request.json() as Record<string, unknown>;
          const result = await smtpSend(
            body.host as string,
            body.port as number,
            body.user as string,
            body.pass as string,
            body.from as string,
            (body.fromName as string) || "",
            body.to as string,
            body.subject as string,
            body.body as string,
            body.inReplyTo as string | undefined,
          );
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e: unknown) {
          return new Response(
            JSON.stringify({
              error: e instanceof Error ? e.message : String(e),
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // Run route
      if (path.startsWith("/api/run/") && method === "POST") {
        const appId = path.replace("/api/run/", "");
        return handleRun(request, appId);
      }

      // Homepage data API — public, returns gaps + leaderboard + top apps
      if (path === "/api/homepage" && method === "GET") {
        return handleHomepageApi(request);
      }

      // Public billing economics used by wallet/payment UI copy.
      if (path === "/api/billing/config" && method === "GET") {
        return json(toPublicBillingConfig(await getBillingConfig()));
      }

      // Stripe webhook route — unauthenticated, verified by signature
      if (path === "/api/webhooks/stripe" && method === "POST") {
        return handleUser(request);
      }

      // Launch MVP facade - thin public/auth APIs for the external-agent-first site.
      if (path.startsWith("/api/launch")) {
        return handleLaunch(request);
      }

      // Marketplace API routes — authenticated bid/ask/accept endpoints
      if (path.startsWith("/api/marketplace")) {
        return handleUser(request);
      }

      // User API routes - handle all /api/user/* paths (must be before /api/apps)
      if (path.startsWith("/api/user")) {
        return handleUser(request);
      }

      // Apps API routes - handle all /api/apps/* paths
      if (path.startsWith("/api/apps")) {
        return handleApps(request);
      }

      // Tier change route (service-to-service, secured by secret)
      if (path === "/api/tier/change" && method === "POST") {
        return handleTierChange(request);
      }

      // Admin routes (service-to-service, secured by service-role key)
      if (path.startsWith("/api/admin")) {
        return handleAdmin(request);
      }

      // MCP config generator - ready-to-paste client configs
      if (path.startsWith("/api/mcp-config/") && method === "GET") {
        const appId = path.slice("/api/mcp-config/".length).split("/")[0];
        return handleMcpConfig(request, appId);
      }

      // Platform Skills.md — plain HTTP access for any agent
      // /docs/mcp is the documentation URL advertised in /.well-known/mcp.json.
      if (
        (path === "/api/skills" || path === "/docs/mcp") && method === "GET"
      ) {
        return handleSkills(request);
      }

      // GPU code proxy — serves developer code bundles to RunPod workers
      // Authenticated via shared secret (machine-to-machine, no user auth)
      if (path.startsWith("/internal/gpu/code/") && method === "GET") {
        return handleGpuCodeProxy(request, path);
      }

      // GPU image build context/callback — used by GitHub Actions build workers.
      if (path.startsWith("/internal/gpu/build-context/") && method === "GET") {
        return handleGpuBuildContextProxy(request, path);
      }

      if (path === "/internal/gpu/build-callback" && method === "POST") {
        return handleGpuBuildCallback(request);
      }

      // D1 query proxy — allows GPU workers to execute D1 queries via the API server
      // Authenticated via shared secret (same as GPU code proxy)
      if (path === "/internal/d1/query" && method === "POST") {
        return handleInternalD1Query(request);
      }

      // Chat stream endpoint — routed inference with SSE streaming.
      // Also serves /v1/chat/completions for OpenAI-compatible clients
      if (
        (path === "/chat/stream" || path === "/v1/chat/completions") &&
        method === "POST"
      ) {
        return handleChatStream(request);
      }

      // Chat models endpoint — available model list for model picker
      if (path === "/chat/models" && method === "GET") {
        return handleChatModels(request);
      }

      if (path === "/chat/inference-options" && method === "GET") {
        return handleChatInferenceOptions(request);
      }

      // Function index — per-user typed function list for codemode
      if (path === "/chat/function-index" && method === "GET") {
        return handleFunctionIndex(request);
      }

      // Context resolver — per-request entity + function resolution
      if (path === "/chat/context" && method === "POST") {
        return handleChatContext(request);
      }

      // Tool invocation telemetry — desktop local tool calls send full args/results here.
      if (path === "/chat/tool-invocation" && method === "POST") {
        return handleToolInvocationTelemetry(request);
      }

      // Ambient capability suggestion telemetry — shown/viewed/accepted/dismissed lifecycle.
      if (path === "/chat/capability-suggestion-event" && method === "POST") {
        return handleCapabilitySuggestionEventTelemetry(request);
      }

      if (path === "/chat/suggestions/preview" && method === "POST") {
        return handleSuggestionPreviewBatch(request);
      }

      const suggestionAcceptMatch = path.match(
        /^\/chat\/suggestions\/([a-f0-9-]{36})\/accept$/,
      );
      if (suggestionAcceptMatch && method === "POST") {
        return handleSuggestionAccept(request, suggestionAcceptMatch[1]);
      }

      const suggestionPreviewMatch = path.match(
        /^\/chat\/suggestions\/([a-f0-9-]{36})\/preview$/,
      );
      if (suggestionPreviewMatch && method === "GET") {
        return handleSuggestionPreview(request, suggestionPreviewMatch[1]);
      }

      // Server-side orchestration — Flash broker + heavy model + recipe execution
      if (path === "/chat/orchestrate" && method === "POST") {
        return handleOrchestrate(request);
      }

      const turnRouteMatch = path.match(
        /^\/chat\/turn\/([a-f0-9-]{36})\/cancel$/,
      );
      if (turnRouteMatch && method === "POST") {
        return handleTurnCancel(request, turnRouteMatch[1]);
      }

      const planRouteMatch = path.match(
        /^\/chat\/plan\/([a-f0-9-]{36})\/(confirm|cancel)$/,
      );
      if (planRouteMatch && method === "POST") {
        const [, planId, action] = planRouteMatch;
        if (action === "confirm") {
          return handlePlanConfirm(request, planId);
        }
        return handlePlanCancel(request, planId);
      }

      // Pre-provision per-user OpenRouter key (called on login, before first chat)
      if (path === "/chat/provision-key" && method === "POST") {
        return handleProvisionKey(request);
      }

      // Debug: auth test endpoint — step-by-step token validation with diagnostic output
      if (path === "/debug/auth-test" && method === "GET") {
        const authHeader = request.headers.get("Authorization");
        const steps: { step: string; result: string; ok: boolean }[] = [];

        if (!authHeader?.startsWith("Bearer ")) {
          return json({
            ok: false,
            error: "Missing or invalid authorization header",
            steps: [{
              step: "header",
              result: `Authorization header: ${
                authHeader ? "present but wrong format" : "missing"
              }`,
              ok: false,
            }],
          }, 401);
        }

        const token = authHeader.slice(7);
        steps.push({
          step: "header",
          result: `Bearer token extracted (${token.length} chars)`,
          ok: true,
        });

        // Check format
        const hasPrefix = token.startsWith("gx_") || token.startsWith("ul_");
        steps.push({
          step: "prefix",
          result: `Starts with "gx_"/"ul_": ${hasPrefix} (got "${
            token.substring(0, 4)
          }")`,
          ok: hasPrefix,
        });
        if (!hasPrefix) {
          return json({ ok: false, error: "Not a gx_/ul_ token", steps }, 401);
        }

        steps.push({
          step: "length",
          result: `Token length: ${token.length} (expected 35)`,
          ok: token.length === 35,
        });
        if (token.length !== 35) {
          return json({
            ok: false,
            error: `Wrong token length: ${token.length}, expected 35`,
            steps,
          }, 401);
        }

        const tokenPrefix = token.substring(0, 8);
        steps.push({
          step: "prefix_extract",
          result: `Token prefix for DB lookup: "${tokenPrefix}"`,
          ok: true,
        });

        // Direct DB lookup to show what's happening
        const { createClient } = await import("@supabase/supabase-js");
        const supabase = createClient(
          getEnv("SUPABASE_URL"),
          getEnv("SUPABASE_SERVICE_ROLE_KEY"),
        );

        const { data: tokenRow, error: dbErr } = await supabase
          .from("user_api_tokens")
          .select("id, user_id, token_salt, expires_at, scopes, created_at")
          .eq("token_prefix", tokenPrefix)
          .single();

        if (dbErr || !tokenRow) {
          steps.push({
            step: "db_lookup",
            result: `No token found with prefix "${tokenPrefix}" — ${
              dbErr?.message || "no rows returned"
            } (code: ${dbErr?.code || "n/a"})`,
            ok: false,
          });

          // Also check how many tokens exist total (sanity check)
          const { count } = await supabase.from("user_api_tokens").select(
            "id",
            { count: "exact", head: true },
          );
          steps.push({
            step: "db_count",
            result: `Total tokens in DB: ${count ?? "unknown"}`,
            ok: true,
          });

          return json({
            ok: false,
            error: "Token not found in database",
            steps,
          }, 401);
        }

        steps.push({
          step: "db_lookup",
          result:
            `Token found — id: ${tokenRow.id}, user_id: ${tokenRow.user_id}, created: ${tokenRow.created_at}, has_salt: ${!!tokenRow
              .token_salt}`,
          ok: true,
        });

        // Check user exists
        const { data: userRow, error: userErr } = await supabase
          .from("users")
          .select("id, email, tier, provisional")
          .eq("id", tokenRow.user_id)
          .single();

        if (userErr || !userRow) {
          steps.push({
            step: "user_lookup",
            result: `User not found for user_id: ${tokenRow.user_id} — ${
              userErr?.message || "no user"
            }`,
            ok: false,
          });
          return json({ ok: false, error: "User not found", steps }, 401);
        }

        steps.push({
          step: "user_lookup",
          result:
            `User found — email: ${userRow.email}, tier: ${userRow.tier}, provisional: ${userRow.provisional}`,
          ok: true,
        });

        // Now try full auth
        const { authenticate } = await import("./auth.ts");
        try {
          const user = await authenticate(request);
          steps.push({
            step: "full_auth",
            result: `Auth SUCCESS — ${user.email}, tier: ${user.tier}`,
            ok: true,
          });
          return json({
            ok: true,
            user: {
              id: user.id,
              email: user.email,
              tier: user.tier,
              provisional: user.provisional,
            },
            steps,
          });
        } catch (err) {
          steps.push({
            step: "full_auth",
            result: `Auth FAILED — ${
              err instanceof Error ? err.message : "unknown"
            }`,
            ok: false,
          });
          return json({
            ok: false,
            error: err instanceof Error ? err.message : "Unknown error",
            steps,
          }, 401);
        }
      }

      // Debug route for crediting the authenticated user with test balance.
      if (path === "/debug/add-credits" && method === "POST") {
        const { authenticate } = await import("./auth.ts");
        try {
          const user = await authenticate(request);
          const { createClient } = await import("@supabase/supabase-js");
          const supabase = createClient(
            getEnv("SUPABASE_URL"),
            getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          );
          // Add ✦4,000 Light as spend-only developer credit.
          const { error: dbErr } = await supabase.rpc("credit_balance", {
            p_user_id: user.id,
            p_amount_light: 4000,
          });
          if (dbErr) {
            throw dbErr;
          }
          // Check new balance
          const { data: userData } = await supabase.from("users").select(
            "balance_light",
          ).eq("id", user.id).single();
          return json({
            ok: true,
            message: "Added ✦4,000 dev credits",
            balance_light: userData?.balance_light ?? "unknown",
          });
        } catch (err) {
          return json({
            ok: false,
            error: err instanceof Error ? err.message : "failed",
          }, 401);
        }
      }

      // Debug: chat preflight — checks auth, balance, platform inference keys, and route resolution without making a request
      if (path === "/debug/chat-preflight" && method === "GET") {
        const checks: {
          check: string;
          result: string;
          ok: boolean;
          severity?: string;
        }[] = [];
        const { ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL } = await import(
          "../services/platform-inference-models.ts"
        );
        const requestedModel =
          new URL(request.url).searchParams.get("model")?.trim() ||
          ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL;

        // 1. Auth
        const { authenticate } = await import("./auth.ts");
        let userEmail = "";
        let userId: string | null = null;
        try {
          const user = await authenticate(request);
          userId = user.id;
          userEmail = user.email;
          checks.push({
            check: "auth",
            result: `${user.email}, tier: ${user.tier}`,
            ok: true,
          });

          if (user.provisional) {
            checks.push({
              check: "provisional",
              result: "Provisional users cannot use chat",
              ok: false,
            });
            return json({ ok: false, checks });
          }
          checks.push({
            check: "provisional",
            result: "Not provisional",
            ok: true,
          });
        } catch (err) {
          checks.push({
            check: "auth",
            result: err instanceof Error ? err.message : "failed",
            ok: false,
          });
          return json({ ok: false, checks }, 401);
        }

        // 2. Balance
        const { checkChatBalance } = await import(
          "../services/chat-billing.ts"
        );
        const { CHAT_MIN_BALANCE_LIGHT: minBalance } = await import(
          "../../shared/contracts/ai.ts"
        );
        try {
          const balance = await checkChatBalance(userId!);
          const ok = balance >= minBalance;
          checks.push({
            check: "balance",
            result: `✦${balance} (min: ✦${minBalance})`,
            ok,
          });
        } catch (err) {
          checks.push({
            check: "balance",
            result: `Failed: ${err instanceof Error ? err.message : "unknown"}`,
            ok: false,
          });
        }

        // 3. Platform inference secrets
        const { buildPlatformInferenceReadiness } = await import(
          "../services/platform-inference-diagnostics.ts"
        );
        const readiness = buildPlatformInferenceReadiness();
        checks.push(...readiness.checks);

        // 4. Model ID validation + route resolution
        const { isValidModelId } = await import(
          "../services/model-validation.ts"
        );
        let routeSummary: Record<string, unknown> | null = null;
        if (!isValidModelId(requestedModel)) {
          checks.push({
            check: "requested_model",
            result: `Invalid model id: ${requestedModel}`,
            ok: false,
            severity: "required",
          });
        } else {
          checks.push({
            check: "requested_model",
            result: requestedModel,
            ok: true,
          });
          const { InferenceRouteError, resolveInferenceRoute } = await import(
            "../services/inference-route.ts"
          );
          try {
            const route = await resolveInferenceRoute({
              userId: userId!,
              userEmail,
              requestedModel,
              selection: { billingMode: "light", model: requestedModel },
            });
            routeSummary = {
              provider: route.provider,
              upstream_provider: route.upstreamProvider,
              model: route.model,
              canonical_model_id: route.canonicalModelId ?? null,
              key_source: route.keySource,
              billing_source: route.billingSource,
              should_debit_light: route.shouldDebitLight,
            };
            checks.push({
              check: "inference_route",
              result:
                `${route.provider} → ${route.upstreamProvider}/${route.model} (${route.keySource})`,
              ok: true,
            });

            if (route.upstreamProvider === "openrouter") {
              const { getStoredOpenRouterKey } = await import(
                "../services/openrouter-keys.ts"
              );
              const userOrKey = await getStoredOpenRouterKey(userId!);
              checks.push({
                check: "user_openrouter_key",
                result: userOrKey
                  ? "Provisioned"
                  : "Not yet created (will be provisioned on first credits-billed OpenRouter chat)",
                ok: true,
              });
            }
          } catch (err) {
            checks.push({
              check: "inference_route",
              result: err instanceof InferenceRouteError
                ? `${err.code}: ${err.message}`
                : err instanceof Error
                ? err.message
                : "Route resolution failed",
              ok: false,
              severity: "required",
            });
          }
        }

        const allOk = checks.every((c) => c.ok);
        return json({
          ok: allOk,
          model: requestedModel,
          route: routeSummary,
          checks,
        });
      }

      // Onboarding instructions template (must be before /api/discover catch-all)
      if (path === "/api/onboarding/instructions" && method === "GET") {
        return handleOnboarding(request);
      }

      // Discovery API routes - semantic search for apps
      if (path.startsWith("/api/discover")) {
        return handleDiscover(request);
      }

      // Platform MCP well-known discovery
      if (path === "/.well-known/mcp.json" && method === "GET") {
        return handlePlatformMcpDiscovery();
      }

      // Platform MCP routes - POST /mcp/platform for JSON-RPC
      if (path === "/mcp/platform") {
        return handlePlatformMcp(request);
      }

      // App-specific MCP routes - POST /mcp/:appId for JSON-RPC
      if (path.startsWith("/mcp/")) {
        const appId = path.slice(5); // Remove '/mcp/'
        return handleMcp(request, appId);
      }

      // HTTP endpoints - /http/:appId/:functionName/* - direct HTTP access to app functions
      // Enables webhooks, public APIs, mobile app backends, etc.
      if (path.startsWith("/http/")) {
        const pathParts = path.slice(6).split("/"); // Remove '/http/'
        const appId = pathParts[0];
        const subPath = pathParts.slice(1).join("/");

        // Handle CORS preflight
        if (method === "OPTIONS") {
          return await handleHttpOptions(request, appId, subPath);
        }

        // Platform-level generic dashboard at /_ui
        if (subPath === "_ui" && method === "GET") {
          return handleGenericDashboard(request, appId);
        }

        return handleHttpEndpoint(request, appId, subPath);
      }

      // Published markdown pages - GET /p/:userId/:slug
      // Public, no auth required. Renders user-published markdown as styled HTML.
      if (path.startsWith("/share/p/") && method === "GET") {
        return handleSharedPageEntry(path);
      }

      if (path.startsWith("/p/") && method === "GET") {
        return handlePublishedPage(request, path);
      }

      // Publisher referral landing - GET /r/:slug
      if (path.startsWith("/r/") && method === "GET") {
        const slug = path.slice(3);
        if (slug && !slug.includes("/")) {
          return handleReferralLanding(request, slug);
        }
      }

      // Public app page - GET /app/:appId
      // Shareable page showing MCP endpoint, documentation, and metadata.
      if (path.startsWith("/app/") && method === "GET") {
        const appId = path.slice(5); // Remove '/app/'
        if (appId && !appId.includes("/")) {
          return handlePublicAppPage(request, appId);
        }
      }

      // Rendered OG share card image - GET /og/:appId.png (public agents only)
      if (path.startsWith("/og/") && method === "GET") {
        const file = path.slice(4); // Remove '/og/'
        const appId = file.endsWith(".png") ? file.slice(0, -4) : file;
        if (appId && !appId.includes("/")) {
          return handleOgCard(request, appId);
        }
      }

      // Public user profile - GET /u/:userId
      // Shows all public MCP apps and published pages for a user.
      if (path.startsWith("/u/") && method === "GET") {
        const profileUserId = path.slice(3); // Remove '/u/'
        if (profileUserId && !profileUserId.includes("/")) {
          return handlePublicUserProfile(request, profileUserId);
        }
      }

      // App runner - /a/:appId/* - serves deployed apps
      // Supports two patterns:
      // 1. Browser apps: export default function(app, ultralight) - renders UI in browser
      // 2. Server apps: export default async function handler(req) - handles HTTP requests
      if (path.startsWith("/a/")) {
        // Extract appId (first segment after /a/)
        const pathParts = path.slice(3).split("/");
        const appId = pathParts[0];
        const subPath = "/" + pathParts.slice(1).join("/"); // Everything after appId

        // Handle MCP discovery endpoint: /a/:appId/.well-known/mcp.json
        if (subPath === "/.well-known/mcp.json" && method === "GET") {
          return handleMcpDiscovery(request, appId);
        }

        // SPA routes for app detail sidebar sections
        if (
          ["/permissions", "/environment", "/payments", "/logs"].includes(
            subPath,
          ) && method === "GET"
        ) {
          const { app } = await resolvePublicFacingApp(request, appId, {
            allowPrivateOwner: true,
          });
          if (!app) {
            return json({ error: "App not found" }, 404);
          }
          return new Response(
            renderLayoutHTML({ initialView: "app", activeAppId: appId }),
            {
              headers: {
                "Content-Type": "text/html",
                "Cache-Control": "no-store",
              },
            },
          );
        }

        try {
          const { app } = await resolvePublicFacingApp(request, appId, {
            allowPrivateOwner: true,
          });
          if (!app) {
            return json({ error: "App not found" }, 404);
          }

          // Generate ETag and check for conditional request (304)
          const etag = generateAppETag(
            app as {
              current_version?: string;
              updated_at?: string;
              storage_key: string;
            },
          );
          const conditionalResponse = checkConditionalRequest(request, etag);
          if (conditionalResponse) {
            console.log(`App runner: 304 Not Modified for app ${appId}`);
            return conditionalResponse;
          }

          // Fetch the app code — check in-memory cache first, then R2
          const storageKey = app.storage_key;
          const codeCache = getCodeCache();
          const code = await fetchAppEntryCode(
            { id: appId, storage_key: storageKey },
            {
              codeCache,
              onCacheHit: () =>
                console.log(`App runner: code cache HIT for app ${appId}`),
              onFileLoaded: (entryFile) =>
                console.log(`App runner: loaded ${entryFile} for app ${appId}`),
            },
          );

          if (!code) {
            console.error(
              `App runner: no entry file found for app ${appId}, storageKey: ${storageKey}`,
            );
            return json({ error: "App code not found" }, 404);
          }

          // Determine app type: HTTP server or MCP-only
          // (Browser/UI apps are no longer supported)
          let isHttpServerApp = false;

          const hasHandlerFunction =
            /export\s+(default\s+)?(async\s+)?function\s+handler\s*\(/.test(
              code,
            ) ||
            /export\s+default\s+handler/.test(code) ||
            /export\s+\{\s*handler\s*\}/.test(code) ||
            /^(async\s+)?function\s+handler\s*\(/m.test(code) ||
            /var\s+handler\s*=/.test(code) ||
            /handler:\s*\(\)\s*=>/.test(code);

          isHttpServerApp = hasHandlerFunction;

          // Cache headers for all app HTML responses
          const cacheHeaders = addCacheHeaders(
            { "Content-Type": "text/html" },
            etag,
          );

          if (isHttpServerApp) {
            // HTTP Server app - execute handler function
            const isEmbed = url.searchParams.get("embed") === "1";

            if (
              isEmbed || method !== "GET" || (subPath !== "/" && subPath !== "")
            ) {
              return await executeServerApp(code, request, appId, subPath);
            } else {
              return new Response(
                renderLayoutHTML({
                  title: app.name || app.slug,
                  activeAppId: appId,
                  initialView: "app",
                  appName: app.name || app.slug,
                }),
                {
                  headers: cacheHeaders,
                },
              );
            }
          } else {
            // MCP-only app - show info page with available tools
            const isEmbed = url.searchParams.get("embed") === "1";

            if (isEmbed) {
              const contractResolution = resolveAppFunctionContracts(app, {
                allowLegacySkills: true,
                allowLegacyExports: true,
                allowGpuExports: isGpuSupportEnabled(),
              });
              logAppContractResolution({
                appId: app.id,
                ownerId: app.owner_id,
                appSlug: app.slug,
                runtime: app.runtime,
                surface: "app_embed_info",
                source: contractResolution.source,
                legacySourceDetected: contractResolution.legacySourceDetected,
                functionCount: contractResolution.functions.length,
                manifestBacked: contractResolution.manifestBacked,
                migrationRequired: contractResolution.migrationRequired,
              });
              // Return an info page for the iframe showing MCP tools
              return new Response(
                getMcpAppInfoHTML(
                  appId,
                  escapeHtml(app.name || app.slug),
                  contractResolution,
                ),
                {
                  headers: {
                    ...cacheHeaders,
                    "Content-Security-Policy":
                      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'",
                  },
                },
              );
            } else {
              // Normal view with sidebar
              return new Response(
                renderLayoutHTML({
                  title: app.name || app.slug,
                  activeAppId: appId,
                  initialView: "app",
                  appName: app.name || app.slug,
                }),
                {
                  headers: cacheHeaders,
                },
              );
            }
          }
        } catch (err) {
          console.error("Error loading app:", err);
          return json({ error: "Failed to load app" }, 500);
        }
      }

      // 404
      return json({ error: "Not found" }, 404);
    },
  };
}

/**
 * Execute a server-side app handler using native ES modules
 * Apps export: export default async function handler(req: Request): Promise<Response>
 *
 * This uses dynamic import() with data URLs to execute ES modules natively.
 * Deno supports importing TypeScript directly via data URLs!
 */
async function executeServerApp(
  code: string,
  originalRequest: Request,
  appId: string,
  subPath: string,
): Promise<Response> {
  try {
    // Create a modified request with the subPath as the URL path
    const originalUrl = new URL(originalRequest.url);
    const appUrl = new URL(subPath + originalUrl.search, originalUrl.origin);

    // Clone request with new URL for the app
    const appRequest = new Request(appUrl.toString(), {
      method: originalRequest.method,
      headers: originalRequest.headers,
      body: originalRequest.body,
    });

    // Deno can import TypeScript directly via data URLs!
    // Use application/typescript MIME type for TypeScript code
    // This completely eliminates the need for any transpilation or regex hacks
    const mimeType = "application/typescript";
    const dataUrl = `data:${mimeType};base64,${
      btoa(unescape(encodeURIComponent(code)))
    }`;

    // Import the module - Deno handles TypeScript natively
    const module = await import(dataUrl);

    // Find the handler function
    const handlerFn = module.handler || module.default;

    if (typeof handlerFn !== "function") {
      return json({
        error: "No handler function found",
        message:
          'Server apps must export a function named "handler" or use export default',
      }, 500);
    }

    // Execute the handler with the request
    const response = await handlerFn(appRequest);

    // Validate response
    if (!(response instanceof Response)) {
      return json({ error: "Handler must return a Response object" }, 500);
    }

    return response;
  } catch (err) {
    console.error("Server app execution error:", err);
    return json({
      error: "App execution failed",
      message: err instanceof Error ? err.message : String(err),
    }, 500);
  }
}

/**
 * Generate an info page for MCP-only apps
 * Shows available tools and how to use them
 */
function buildLegacyContractNotice(resolution: AppContractResolution): string {
  if (!resolution.migrationRequired || !resolution.message) {
    return "";
  }

  return `
    <div class="section warning">
      <div class="section-title">Contract Migration Required</div>
      <p class="info-text">${escapeHtml(resolution.message)}</p>
    </div>
  `;
}

function getMcpAppInfoHTML(
  appId: string,
  appName: string,
  resolution: AppContractResolution,
): string {
  const tools = resolution.functions;
  const toolsList = tools.length > 0
    ? tools.map((s) => `
      <div class="tool-item">
        <div class="tool-name">${escapeHtml(s.name)}</div>
        ${
      s.description
        ? `<div class="tool-desc">${escapeHtml(s.description)}</div>`
        : ""
    }
      </div>
    `).join("")
    : '<p class="no-tools">No documentation published yet. Generate docs in app settings when you are ready.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appName} - MCP App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      padding: 2rem;
      min-height: 100vh;
    }
    .container { max-width: 600px; margin: 0 auto; }
    .header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
    }
    h1 { font-size: 1.5rem; font-weight: 600; }
    .badge {
      display: inline-block;
      background: rgba(139, 92, 246, 0.2);
      color: #a78bfa;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      margin-top: 0.5rem;
    }
    .section {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .warning {
      border-color: rgba(245, 158, 11, 0.35);
      background: rgba(245, 158, 11, 0.08);
    }
    .section-title {
      font-size: 0.875rem;
      color: #71717a;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 1rem;
    }
    .mcp-url {
      background: #09090b;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-family: monospace;
      font-size: 0.875rem;
      color: #a78bfa;
      word-break: break-all;
    }
    .tool-item {
      padding: 0.75rem 0;
      border-bottom: 1px solid #27272a;
    }
    .tool-item:last-child { border-bottom: none; }
    .tool-name {
      font-family: monospace;
      color: #22c55e;
      font-weight: 500;
    }
    .tool-desc {
      font-size: 0.875rem;
      color: #71717a;
      margin-top: 0.25rem;
    }
    .no-tools { color: #71717a; font-style: italic; }
    .info-text {
      font-size: 0.875rem;
      color: #71717a;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="icon">🔧</div>
      <div>
        <h1>${appName}</h1>
        <span class="badge">MCP Server</span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">MCP Endpoint</div>
      <div class="mcp-url">${
    typeof location !== "undefined" ? location.origin : ""
  }/mcp/${appId}</div>
      <a href="/http/${appId}/_ui" style="display:inline-flex;align-items:center;gap:0.5rem;margin-top:0.75rem;background:rgba(99,102,241,.15);color:#a78bfa;padding:0.5rem 1rem;border-radius:8px;text-decoration:none;font-weight:500;font-size:0.8125rem;transition:background 0.15s;">&#9881; Open Dashboard</a>
      <p class="info-text" style="margin-top: 0.75rem;">
        Connect via MCP client, or open the dashboard to view and manage data from your browser.
      </p>
    </div>

    ${buildLegacyContractNotice(resolution)}

    <div class="section">
      <div class="section-title">Available Tools (${tools.length})</div>
      ${toolsList}
    </div>

    <div class="section">
      <p class="info-text">
        This is an MCP (Model Context Protocol) app. It provides tools that AI assistants
        can use to perform actions. Add the MCP endpoint URL to your client's configuration
        to start using these tools.
      </p>
    </div>
  </div>
</body>
</html>`;
}

async function resolvePublicFacingApp(
  request: Request,
  appId: string,
  options: { allowPrivateOwner?: boolean } = {},
) {
  const appsService = createAppsService();
  const publicApp = await appsService.findPublicServingById(appId);

  let userId: string | null = null;
  try {
    const user = await authenticate(request);
    userId = user.id;
  } catch {
    userId = null;
  }

  if (publicApp) {
    return {
      app: publicApp,
      isOwner: userId === publicApp.owner_id,
    };
  }

  if (!options.allowPrivateOwner || !userId) {
    return { app: null, isOwner: false };
  }

  const ownerApp = await appsService.findById(appId);
  if (
    !ownerApp || ownerApp.owner_id !== userId ||
    ownerApp.visibility !== "private"
  ) {
    return { app: null, isOwner: false };
  }

  return {
    app: ownerApp,
    isOwner: true,
  };
}

/**
 * Serve a generic auto-generated dashboard for any MCP app.
 * Reads skills_parsed/manifest to discover tools and renders an interactive UI.
 * Accessible at: GET /http/{appId}/_ui
 */
async function handleGenericDashboard(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const { app } = await resolvePublicFacingApp(request, appId, {
      allowPrivateOwner: true,
    });
    if (!app) {
      return json({ error: "App not found" }, 404);
    }

    const appName = escapeHtml(app.name || app.slug);
    const contractResolution = resolveAppFunctionContracts(app, {
      allowLegacySkills: true,
      allowLegacyExports: true,
      allowGpuExports: isGpuSupportEnabled(),
    });
    logAppContractResolution({
      appId: app.id,
      ownerId: app.owner_id,
      appSlug: app.slug,
      runtime: app.runtime,
      surface: "app_generic_dashboard",
      source: contractResolution.source,
      legacySourceDetected: contractResolution.legacySourceDetected,
      functionCount: contractResolution.functions.length,
      manifestBacked: contractResolution.manifestBacked,
      migrationRequired: contractResolution.migrationRequired,
    });

    const html = contractResolution.manifestBacked
      ? generateGenericDashboardHTML(
        appId,
        appName,
        contractResolution.functions,
      )
      : generateLegacyContractDashboardHTML(appId, appName, contractResolution);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      },
    });
  } catch (err) {
    console.error("[Dashboard] Error:", err);
    return json({ error: "Failed to load dashboard" }, 500);
  }
}

/**
 * Generate a fully self-contained generic dashboard HTML for any MCP app.
 * Auto-discovers tools from skills_parsed and renders forms for each.
 */
function generateGenericDashboardHTML(
  appId: string,
  appName: string,
  functions: AppFunctionContract[],
): string {
  // Build tool definitions as JSON for the client-side JS
  const toolDefs = JSON.stringify(functions.map((fn) => ({
    name: fn.name,
    description: fn.description || "",
    parameters: fn.parameters || {},
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${appName} — Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0a;--surface:#141414;--surface2:#1e1e1e;--border:#2a2a2a;--text:#e5e5e5;--text2:#888;--accent:#6366f1;--accent-hover:#4f46e5;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--mono:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.container{max-width:800px;margin:0 auto;padding:24px 16px}
/* Auth */
.auth-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:16px}
.auth-screen h2{font-size:22px;font-weight:700}
.auth-screen p{color:var(--text2);font-size:14px;text-align:center;max-width:400px}
.token-input{width:100%;max-width:420px;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;font-family:var(--mono);outline:none}
.token-input:focus{border-color:var(--accent)}
/* Header */
.header{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.header-icon{width:44px;height:44px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.3rem}
.header h1{font-size:22px;font-weight:700}
.header .badge{display:inline-block;background:rgba(99,102,241,.15);color:#a5b4fc;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600;margin-left:8px}
/* Tool cards */
.tool-grid{display:flex;flex-direction:column;gap:16px}
.tool-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:border-color .15s}
.tool-card:hover{border-color:#333}
.tool-header{padding:16px;cursor:pointer;display:flex;align-items:center;gap:12px;user-select:none}
.tool-header:hover{background:var(--surface2)}
.tool-name{font-family:var(--mono);font-size:14px;font-weight:600;color:var(--green)}
.tool-desc{font-size:13px;color:var(--text2);flex:1}
.tool-toggle{color:var(--text2);font-size:18px;transition:transform .2s}
.tool-toggle.open{transform:rotate(90deg)}
.tool-body{display:none;padding:0 16px 16px;border-top:1px solid var(--border)}
.tool-body.open{display:block}
/* Form */
.param-group{margin-top:12px}
.param-label{display:block;font-size:12px;color:var(--text2);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
.param-label .req{color:var(--red);margin-left:2px}
.param-desc{font-size:11px;color:var(--text2);margin-bottom:6px;font-style:italic}
.param-input{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:inherit;outline:none}
.param-input:focus{border-color:var(--accent)}
textarea.param-input{min-height:60px;resize:vertical;font-family:inherit}
/* Buttons */
button{cursor:pointer;border:none;border-radius:8px;font-size:13px;font-weight:600;padding:10px 20px;transition:all .15s}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-primary:disabled{opacity:.4;cursor:not-allowed}
.btn-secondary{background:var(--surface2);color:var(--text2);padding:8px 14px}
.btn-secondary:hover{color:var(--text)}
/* Result */
.result-area{margin-top:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;overflow:hidden;display:none}
.result-header{padding:8px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;justify-content:space-between}
.result-header.success{color:var(--green);background:rgba(34,197,94,.05)}
.result-header.error{color:var(--red);background:rgba(239,68,68,.05)}
.result-body{padding:12px;font-family:var(--mono);font-size:12px;line-height:1.6;overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto}
/* Toast */
.toast{position:fixed;bottom:24px;right:24px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:12px 20px;border-radius:10px;font-size:13px;opacity:0;transform:translateY(10px);transition:all .3s;pointer-events:none;z-index:99}
.toast.show{opacity:1;transform:translateY(0)}
.toast.error{border-color:var(--red);color:var(--red)}
/* Scrollbar */
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
/* Custom UI link */
.custom-ui-link{display:inline-block;margin-top:8px;padding:8px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--accent);font-size:13px;font-weight:600;text-decoration:none;transition:all .15s}
.custom-ui-link:hover{background:var(--surface);border-color:var(--accent)}
/* Empty */
.empty{text-align:center;padding:48px 16px;color:var(--text2)}
.empty-icon{font-size:48px;margin-bottom:12px}
</style>
</head>
<body>
<div class="container">

<!-- Auth screen -->
<div id="auth-screen" class="auth-screen">
<div style="font-size:48px">&#9881;</div>
<h2>${appName}</h2>
<p>Enter your Galactic API token to access this app's dashboard. Your token stays in the browser only.</p>
<input type="password" id="token-input" class="token-input" placeholder="gx_..." />
<button class="btn-primary" onclick="submitToken()">Connect</button>
</div>

<!-- Main app -->
<div id="app" style="display:none">
<div class="header">
<div class="header-icon">&#9881;</div>
<div>
<h1>${appName}<span class="badge">MCP Dashboard</span></h1>
</div>
</div>

<div id="custom-ui-banner"></div>

<div id="tool-grid" class="tool-grid">
<div class="empty"><div class="empty-icon">&#9881;</div>Loading app functions...</div>
</div>
</div>

<div id="toast" class="toast"></div>

</div>

<script>
var APP_ID = ${JSON.stringify(appId)};
var STORAGE_KEY = "gx_token_" + APP_ID;
var TOKEN = sessionStorage.getItem(STORAGE_KEY) || "";
var TOOL_PREFIX = "";
var TOOLS = ${toolDefs};

(function() {
  try {
    var cleanUrl = new URL(location.href);
    var changed = false;
    if (cleanUrl.searchParams.has("token")) {
      cleanUrl.searchParams.delete("token");
      changed = true;
    }
    if (location.hash && location.hash.indexOf("token=") !== -1) {
      cleanUrl.hash = "";
      changed = true;
    }
    if (changed) {
      history.replaceState(null, "", cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
    }
  } catch (e) {}
})();
if (TOKEN) { showApp(); }

function submitToken() {
  var t = document.getElementById("token-input").value.trim();
  if (!t) return;
  TOKEN = t; sessionStorage.setItem(STORAGE_KEY, TOKEN);
  showApp();
}

document.getElementById("token-input").addEventListener("keydown", function(e) {
  if (e.key === "Enter") submitToken();
});

function showApp() {
  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("app").style.display = "block";
  init();
}

async function discoverPrefix() {
  try {
    var res = await fetch("/mcp/" + APP_ID, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" })
    });
    var data = await res.json();
    if (data.result && data.result.tools && data.result.tools.length > 0) {
      var first = data.result.tools[0];
      if (first.name && first.name.indexOf("_") > -1) {
        TOOL_PREFIX = first.name.substring(0, first.name.lastIndexOf("_") + 1);
      }
      // Check if app has a custom "ui" function
      var hasCustomUI = data.result.tools.some(function(t) {
        return t.title === "ui" || t.name.endsWith("_ui");
      });
      if (hasCustomUI) {
        document.getElementById("custom-ui-banner").innerHTML =
          '<a class="custom-ui-link" href="/http/' + APP_ID + '/ui">&#10024; This app has a custom UI &rarr; Open it</a>';
      }
    }
  } catch(e) { console.warn("Could not discover prefix:", e); }
}

async function mcp(tool, args) {
  var res = await fetch("/mcp/" + APP_ID, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: TOOL_PREFIX + tool, arguments: args || {} } })
  });
  var data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  if (data.result && data.result.isError) throw new Error(data.result.content[0].text);
  return data.result ? (data.result.structuredContent || data.result) : null;
}

var toastTimer;
function toast(msg, isError) {
  var el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.className = "toast"; }, 2500);
}

async function init() {
  await discoverPrefix();
  renderTools();
}

function renderTools() {
  var container = document.getElementById("tool-grid");
  if (!TOOLS || TOOLS.length === 0) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">&#128268;</div>No tools found for this app.</div>';
    return;
  }

  // Filter out the "ui" function from the tool list (it's a UI endpoint, not a data tool)
  var visibleTools = TOOLS.filter(function(t) { return t.name !== "ui"; });

  container.innerHTML = visibleTools.map(function(tool, idx) {
    var params = tool.parameters || {};
    var paramKeys = Object.keys(params);

    var formHTML = paramKeys.map(function(key) {
      var p = params[key];
      var pType = (p && p.type) || "string";
      var pDesc = (p && p.description) || "";
      var isRequired = p && p.required;
      var inputType = pType === "number" ? "number" : "text";
      var isLongText = pDesc.toLowerCase().indexOf("text") > -1 || pDesc.toLowerCase().indexOf("content") > -1 || key === "text";

      return '<div class="param-group">' +
        '<label class="param-label">' + escHtml(key) + (isRequired ? '<span class="req">*</span>' : '') + '</label>' +
        (pDesc ? '<div class="param-desc">' + escHtml(pDesc) + '</div>' : '') +
        (isLongText
          ? '<textarea class="param-input" data-tool="' + idx + '" data-param="' + escAttr(key) + '" placeholder="' + escAttr(pType) + '"></textarea>'
          : '<input type="' + inputType + '" class="param-input" data-tool="' + idx + '" data-param="' + escAttr(key) + '" placeholder="' + escAttr(pType) + '" />') +
        '</div>';
    }).join("");

    var noParams = paramKeys.length === 0;

    return '<div class="tool-card" id="tool-card-' + idx + '">' +
      '<div class="tool-header" onclick="toggleTool(' + idx + ')">' +
        '<span class="tool-name">' + escHtml(tool.name) + '</span>' +
        '<span class="tool-desc">' + escHtml(tool.description) + '</span>' +
        '<span class="tool-toggle" id="tool-toggle-' + idx + '">&#9654;</span>' +
      '</div>' +
      '<div class="tool-body" id="tool-body-' + idx + '">' +
        formHTML +
        '<div style="margin-top:16px;display:flex;gap:8px;align-items:center">' +
          '<button class="btn-primary" onclick="callTool(' + idx + ')">' + (noParams ? 'Run' : 'Call') + '</button>' +
          '<button class="btn-secondary" onclick="clearResult(' + idx + ')">Clear</button>' +
        '</div>' +
        '<div class="result-area" id="result-' + idx + '">' +
          '<div class="result-header" id="result-header-' + idx + '"></div>' +
          '<div class="result-body" id="result-body-' + idx + '"></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join("");
}

function toggleTool(idx) {
  var body = document.getElementById("tool-body-" + idx);
  var toggle = document.getElementById("tool-toggle-" + idx);
  var isOpen = body.classList.contains("open");
  body.classList.toggle("open");
  toggle.classList.toggle("open");
}

async function callTool(idx) {
  var visibleTools = TOOLS.filter(function(t) { return t.name !== "ui"; });
  var tool = visibleTools[idx];
  var params = tool.parameters || {};
  var args = {};
  var inputs = document.querySelectorAll('[data-tool="' + idx + '"]');

  inputs.forEach(function(input) {
    var key = input.getAttribute("data-param");
    var val = input.value.trim();
    if (val) {
      var pType = params[key] && params[key].type;
      if (pType === "number") {
        args[key] = parseFloat(val);
      } else {
        args[key] = val;
      }
    }
  });

  var resultArea = document.getElementById("result-" + idx);
  var resultHeader = document.getElementById("result-header-" + idx);
  var resultBody = document.getElementById("result-body-" + idx);

  resultArea.style.display = "block";
  resultHeader.className = "result-header";
  resultHeader.textContent = "Running...";
  resultBody.textContent = "";

  try {
    var result = await mcp(tool.name, args);
    resultHeader.className = "result-header success";
    resultHeader.innerHTML = "&#10003; Success";
    resultBody.textContent = JSON.stringify(result, null, 2);
    toast("Called " + tool.name);
  } catch(e) {
    resultHeader.className = "result-header error";
    resultHeader.innerHTML = "&#10007; Error";
    resultBody.textContent = e.message;
    toast("Failed: " + e.message, true);
  }
}

function clearResult(idx) {
  document.getElementById("result-" + idx).style.display = "none";
}

function escHtml(s) { if (!s) return ""; var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
</script>
</body>
</html>`;
}

function generateLegacyContractDashboardHTML(
  appId: string,
  appName: string,
  resolution: AppContractResolution,
): string {
  const functionList = resolution.functions.length > 0
    ? `<ul style="margin-top:12px;padding-left:20px;color:#a1a1aa;">${
      resolution.functions.map((fn) =>
        `<li><code>${escapeHtml(fn.name)}</code>${
          fn.description ? ` - ${escapeHtml(fn.description)}` : ""
        }</li>`
      ).join("")
    }</ul>`
    : '<p style="margin-top:12px;color:#a1a1aa;">No function metadata was detected outside <code>manifest.json</code>.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${appName} — Dashboard Migration Required</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;padding:32px 16px}
.container{max-width:760px;margin:0 auto}
.card{background:#171717;border:1px solid #2a2a2a;border-radius:16px;padding:24px}
.badge{display:inline-block;background:rgba(245,158,11,.14);color:#fbbf24;border:1px solid rgba(245,158,11,.25);padding:6px 10px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:16px}
h1{font-size:24px;margin-bottom:12px}
p{line-height:1.6;color:#d4d4d8}
code{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;color:#a78bfa}
.section{margin-top:20px;padding-top:20px;border-top:1px solid #2a2a2a}
</style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="badge">Manifest Migration Required</div>
      <h1>${appName}</h1>
      <p>${
    escapeHtml(
      resolution.message ||
        "This app needs a manifest-backed contract before the generic dashboard can execute tools safely.",
    )
  }</p>
      <div class="section">
        <p>The dashboard is read-only until this app is republished with a valid <code>manifest.json</code>. Detected function metadata outside <code>manifest.json</code>:</p>
        ${functionList}
      </div>
      <div class="section">
        <p>App ID: <code>${appId}</code></p>
        <p>Next step: regenerate docs or publish a new version that stores function definitions in <code>manifest.json</code>.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ============================================
// PUBLIC APP PAGE
// ============================================

// Bot detection for impression filtering. Matches common crawlers, social
// preview fetchers (Slack/Discord/Facebook/Twitter/LinkedIn/WhatsApp), and
// generic "bot" UAs. Intentionally broad — false positives just mean an
// occasional missed impression, which is fine.
const BOT_UA_PATTERN =
  /bot|crawler|spider|facebookexternalhit|slackbot|whatsapp|twitterbot|linkedinbot|discordbot|preview|headless|pinterest|telegram|vkshare|embedly|bitlybot|quora|outbrain|pocket|redditbot|applebot/i;

interface PublicMarketplaceListingRow extends MarketplaceListingSummaryListing {
  listing_note?: string | null;
  updated_at?: string | null;
}

interface PublicMarketplaceBidRow {
  amount_light: number | null;
}

interface PublicMarketplaceEligibilityRow {
  had_external_db: boolean | null;
}

type PublicMarketplaceSummary = MarketplaceListingSummary & {
  listing_note: string | null;
  updated_at: string | null;
};

async function fetchPublicMarketplaceSummary(
  appId: string,
  supabaseUrl: string,
  dbHeaders: Record<string, string>,
): Promise<PublicMarketplaceSummary | null> {
  const [listingRes, bidsRes, eligibilityRes] = await Promise.all([
    fetch(
      `${supabaseUrl}/rest/v1/app_listings?app_id=eq.${appId}&select=ask_price_light,floor_price_light,instant_buy,status,listing_note,show_metrics,updated_at&limit=1`,
      { headers: dbHeaders },
    ),
    fetch(
      `${supabaseUrl}/rest/v1/app_bids?app_id=eq.${appId}&status=eq.active&select=amount_light`,
      { headers: dbHeaders },
    ),
    fetch(
      `${supabaseUrl}/rest/v1/apps?id=eq.${appId}&select=had_external_db&limit=1`,
      { headers: dbHeaders },
    ),
  ]);

  if (!listingRes.ok && !bidsRes.ok) {
    return null;
  }

  const listings = listingRes.ok
    ? await listingRes.json() as PublicMarketplaceListingRow[]
    : [];
  const bids = bidsRes.ok
    ? (await bidsRes.json() as PublicMarketplaceBidRow[])
      .filter((bid): bid is { amount_light: number } =>
        typeof bid.amount_light === "number"
      )
    : [];
  const eligibilityRows = eligibilityRes.ok
    ? await eligibilityRes.json() as PublicMarketplaceEligibilityRow[]
    : [];

  const listing = listings[0] || null;
  if (!listing && bids.length === 0) {
    return null;
  }

  return {
    ...buildMarketplaceListingSummary(
      listing,
      bids,
      { had_external_db: eligibilityRows[0]?.had_external_db ?? null },
    ),
    listing_note: listing?.listing_note ?? null,
    updated_at: listing?.updated_at ?? null,
  };
}

async function handlePublicAppPage(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const appsService = createAppsService();
    const app = await appsService.findPublicServingById(appId);
    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    const baseUrl = getBaseUrl(request);
    const urlObj = new URL(request.url);
    const isEmbed = urlObj.searchParams.get("embed") === "1";

    // Note: isOwner is NOT detected server-side. The page is cached with
    // `public, max-age=60` and must render identically for every viewer.
    // Client-side bootstrap calls /api/apps/:id/library-status which
    // returns { inLibrary, isOwner } and renders the owner banner from
    // that response.

    // Fire-and-forget impression counter (bot-filtered).
    // Must never block rendering or surface errors to the viewer.
    const ua = request.headers.get("user-agent") || "";
    if (!BOT_UA_PATTERN.test(ua)) {
      void appsService.incrementImpression(app.id).catch((err) =>
        console.warn("[impression] failed:", err)
      );
    }

    // Fetch owner display name
    const SUPABASE_URL = getEnv("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const dbHeaders = {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };

    let ownerName = "Unknown";
    try {
      const userRes = await fetch(
        `${SUPABASE_URL}/rest/v1/users?id=eq.${app.owner_id}&select=display_name,email&limit=1`,
        { headers: dbHeaders },
      );
      if (userRes.ok) {
        const users = await userRes.json() as Array<
          { display_name: string | null; email: string }
        >;
        if (users.length > 0) {
          ownerName = users[0].display_name || users[0].email.split("@")[0];
        }
      }
    } catch { /* best effort */ }

    let marketplaceSummary: PublicMarketplaceSummary | null = null;
    try {
      marketplaceSummary = await fetchPublicMarketplaceSummary(
        app.id,
        SUPABASE_URL,
        dbHeaders,
      );
    } catch (err) {
      console.warn("[PublicAppPage] Failed to fetch marketplace summary:", err);
    }

    // Single-app surface: pay one KV read to report REAL runtime integrity
    // (the executing bundle vs its signed attestation), not just source signing.
    const executedIntegrity = await resolveExecutedIntegrity(app.id);
    const trustCard = sanitizeGpuTrustCard(
      buildAppTrustCard({ ...app, env_schema: {} }, {
        executed_integrity: executedIntegrity,
      }),
    );
    const html = getPublicAppPageHTML(app, ownerName, baseUrl, {
      isEmbed,
      trustCard,
      marketplaceSummary,
      referralClaimToken: sanitizeReferralClaimQuery(
        urlObj.searchParams.get("ref_claim"),
      ),
    });
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": urlObj.searchParams.has("ref_claim")
          ? "no-store"
          : "public, max-age=60",
      },
    });
  } catch (err) {
    console.error("[PublicAppPage] Error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}

function getPublicAppPageHTML(
  app: {
    id: string;
    name: string;
    slug: string;
    description?: string | null;
    current_version?: string;
    owner_id: string;
    visibility?: string;
    category?: string | null;
    tags?: string[] | null;
    likes?: number;
    dislikes?: number;
    total_runs?: number;
    icon_url?: string | null;
    skills_md?: string | null;
    skills_parsed?: unknown;
    screenshots?: string[] | null;
    long_description?: string | null;
  },
  ownerName: string,
  baseUrl: string,
  opts: {
    isEmbed: boolean;
    trustCard?: TrustCard;
    marketplaceSummary?: PublicMarketplaceSummary | null;
    referralClaimToken?: string | null;
  },
): string {
  const { isEmbed } = opts;
  const appName = escapeHtml(app.name || app.slug);
  const rawDescription = app.description || "";
  const description = escapeHtml(rawDescription);
  const version = app.current_version ? escapeHtml(app.current_version) : "1.0";
  const mcpEndpoint = `${baseUrl}/mcp/${app.id}`;
  const shareUrl = appStoreUrl(app.id);
  const deepLink = deepLinkAppUrl(
    app.id,
    opts.referralClaimToken
      ? {
        refClaim: opts.referralClaimToken,
      }
      : undefined,
  );
  const dlUrl = downloadUrl({ app: app.id });
  const likes = Number(app.likes ?? 0);
  const runs = Number(app.total_runs ?? 0);
  const category = app.category ? escapeHtml(app.category) : "";
  const isUnlisted = app.visibility === "unlisted";
  const ownerProfileUrl = `/u/${escapeHtml(app.owner_id)}`;
  const tags = Array.isArray(app.tags)
    ? app.tags.filter((t) => typeof t === "string").slice(0, 5)
    : [];

  const screenshots: string[] = Array.isArray(app.screenshots)
    ? app.screenshots.filter((s): s is string => typeof s === "string")
    : [];
  const hasScreenshots = screenshots.length > 0;
  const longDescriptionMd = typeof app.long_description === "string"
    ? app.long_description
    : "";
  const longDescriptionHtml = longDescriptionMd
    ? markdownToHtml(longDescriptionMd)
    : "";
  const trustCard = opts.trustCard;
  const trustCapabilities = trustCard
    ? [
      trustCard.capability_summary.ai ? "AI" : "",
      trustCard.capability_summary.network ? "Network" : "",
      trustCard.capability_summary.storage ? "Storage" : "",
      trustCard.capability_summary.memory ? "Memory" : "",
      isGpuSupportEnabled() && trustCard.capability_summary.gpu ? "GPU" : "",
    ].filter(Boolean)
    : [];
  const trustPermissions = trustCard
    ? trustCard.permissions
      .filter((permission) =>
        isGpuSupportEnabled() || permission !== "gpu:execute"
      )
      .slice(0, 8)
    : [];
  const trustSecretLabels = trustCard
    ? [
      ...trustCard.required_secrets,
      ...trustCard.per_user_secrets.map((key) => `${key} (per user)`),
    ].slice(0, 8)
    : [];
  const trustShortHash = (value: string | null | undefined) =>
    value ? value.slice(0, 12) : "Not available";
  const trustChipHtml = (labels: string[], empty: string) =>
    labels.length > 0
      ? labels.map((label) =>
        `<span class="trust-chip">${escapeHtml(label)}</span>`
      ).join("")
      : `<span class="trust-chip">${escapeHtml(empty)}</span>`;
  const marketplace = opts.marketplaceSummary;
  const hasMarketAsk = typeof marketplace?.ask_price_light === "number";
  const hasMarketBid = typeof marketplace?.highest_bid_light === "number";
  const showMarketplace = !!marketplace && (
    marketplace.status !== "unlisted" || marketplace.active_bid_count > 0
  );
  const marketStatusLabel = marketplace?.status === "sold"
    ? "Acquired"
    : marketplace?.status === "ineligible"
    ? "Not tradable"
    : hasMarketAsk
    ? marketplace?.instant_buy ? "Acquire now" : "Listed"
    : hasMarketBid
    ? "Active bids"
    : marketplace?.status === "open_to_offers"
    ? "Open to offers"
    : "Marketplace";
  const marketAskDisplay = hasMarketAsk
    ? formatLight(marketplace!.ask_price_light!)
    : marketplace?.status === "open_to_offers"
    ? "Open to offers"
    : "No ask";
  const marketBidDisplay = hasMarketBid
    ? formatLight(marketplace!.highest_bid_light!)
    : "No active bids";
  const marketPayoutDisplay =
    typeof marketplace?.seller_payout_at_ask_light === "number"
      ? formatLight(marketplace.seller_payout_at_ask_light)
      : "Set by bid";
  const marketFeeDisplay =
    typeof marketplace?.platform_fee_at_ask_light === "number"
      ? `Platform fee ${formatLight(marketplace.platform_fee_at_ask_light)}`
      : "No platform fee until acquisition";
  const marketplaceHtml = showMarketplace
    ? `
    <section class="section market-section">
      <div class="market-header">
        <div>
          <div class="section-title">Marketplace</div>
          <div class="market-title">${escapeHtml(marketStatusLabel)}</div>
        </div>
        <span class="market-status ${marketplace?.instant_buy ? "buy" : ""}">${
      escapeHtml(
        marketplace?.instant_buy ? "Instant acquisition" : marketStatusLabel,
      )
    }</span>
      </div>
      <div class="market-grid">
        <div><span>Ask</span><strong>${
      escapeHtml(marketAskDisplay)
    }</strong></div>
        <div><span>Highest Bid</span><strong>${
      escapeHtml(marketBidDisplay)
    }</strong></div>
        <div><span>Seller Payout</span><strong>${
      escapeHtml(marketPayoutDisplay)
    }</strong></div>
      </div>
      <div class="market-foot">
        <span>${escapeHtml(marketFeeDisplay)}</span>
        <a href="${escapeHtml(deepLink)}">${
      marketplace?.instant_buy ? "Acquire" : "Open to bid"
    } &rarr;</a>
      </div>
      ${
      marketplace?.listing_note
        ? `<p class="market-note">${escapeHtml(marketplace.listing_note)}</p>`
        : ""
    }
    </section>
  `
    : "";
  const trustRuntime =
    trustCard && !isGpuSupportEnabled() && trustCard.runtime === "gpu"
      ? "deno"
      : trustCard?.runtime || "deno";
  // Headline status reflects what we can actually prove. Prefer the runtime
  // verdict (the executing bundle matches its signature); fall back to source
  // signing — explicitly labelled "Source signed" so it never implies the
  // running code is verified.
  const runtimeVerified = trustCard?.executed_integrity === "verified";
  const trustStatusTone = runtimeVerified
    ? "ok"
    : (trustCard?.signed_manifest ? "ok" : "warn");
  const trustStatusLabel = runtimeVerified
    ? "Runtime verified"
    : (trustCard?.signed_manifest ? "Source signed" : "Unsigned Legacy");
  const runtimeIntegrityLabel = trustCard?.executed_integrity === "verified"
    ? "Verified"
    : trustCard?.executed_integrity === "unverified"
    ? "Unverified"
    : "Not checked";
  const trustCardHtml = trustCard
    ? `
    <section class="section trust-section">
      <div class="trust-header">
        <div class="section-title">Trust & Runtime</div>
        <span class="trust-status ${trustStatusTone}">${trustStatusLabel}</span>
      </div>
      <div class="trust-grid">
        <div><span>Runtime</span><strong>${
      escapeHtml(trustRuntime)
    }</strong></div>
        <div><span>Running code</span><strong>${runtimeIntegrityLabel}</strong></div>
        <div><span>Version</span><strong>${
      escapeHtml(trustCard.version || version)
    }</strong></div>
        <div><span>Manifest Hash</span><code title="${
      escapeHtml(trustCard.manifest_hash || "")
    }">${escapeHtml(trustShortHash(trustCard.manifest_hash))}</code></div>
        <div><span>Receipt Field</span><strong>${
      trustCard.execution_receipts.enabled ? "receipt_id" : "Disabled"
    }</strong></div>
      </div>
      <div class="trust-chip-row">${
      trustChipHtml(trustCapabilities, "No broad access")
    }</div>
      <div class="trust-chip-row">${
      trustChipHtml(trustPermissions, "No permission scopes")
    }</div>
      <div class="trust-chip-row">${
      trustChipHtml(trustSecretLabels, "No required secrets")
    }</div>
    </section>
  `
    : "";

  // Public agents get the rendered share card (swirl + name + description);
  // others fall back to the first screenshot, then the icon. handleOgCard 302s
  // to the icon if the card hasn't been rendered yet, so this always resolves.
  const ogImage = app.visibility === "public"
    ? `${baseUrl}/og/${app.id}.png`
    : hasScreenshots
    ? `${baseUrl}/api/apps/${app.id}/screenshots/0`
    : `${baseUrl}/api/apps/${app.id}/icon`;

  // Render skills documentation (unchanged)
  let skillsHtml = "";
  if (app.skills_md) {
    skillsHtml = markdownToHtml(app.skills_md);
  } else if (app.skills_parsed) {
    const skills = Array.isArray(app.skills_parsed)
      ? app.skills_parsed as Array<{ name: string; description?: string }>
      : ((app.skills_parsed as {
        functions?: Array<{ name: string; description?: string }>;
      }).functions || []);
    if (skills.length > 0) {
      skillsHtml = skills.map((s) =>
        `<div class="fn-item"><span class="fn-name">${
          escapeHtml(s.name)
        }</span>${
          s.description
            ? `<span class="fn-desc">${escapeHtml(s.description)}</span>`
            : ""
        }</div>`
      ).join("");
    } else {
      skillsHtml = '<p class="no-docs">No documentation yet.</p>';
    }
  } else {
    skillsHtml = '<p class="no-docs">No documentation yet.</p>';
  }

  // Short meta description for <meta> + OG (trim to ~160 chars)
  const metaDesc = rawDescription.length > 160
    ? rawDescription.slice(0, 157) + "..."
    : rawDescription;
  const metaDescEscaped = escapeHtml(
    metaDesc || `${app.name || app.slug} on Galactic — MCP app store`,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName} — Galactic</title>
<meta name="description" content="${metaDescEscaped}">
${isEmbed || isUnlisted ? '<meta name="robots" content="noindex">' : ""}

<!-- OpenGraph / social share previews -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="Galactic">
<meta property="og:title" content="${appName}">
<meta property="og:description" content="${metaDescEscaped}">
<meta property="og:url" content="${escapeHtml(shareUrl)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta name="twitter:card" content="${app.visibility === "public" ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${appName}">
<meta name="twitter:description" content="${metaDescEscaped}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #ffffff;
    color: #0a0a0a;
    padding: 2rem 1rem 4rem;
    min-height: 100vh;
  }
  .container { max-width: 680px; margin: 0 auto; }

  /* Owner banner (client-side rendered) */
  .owner-banner {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    margin-bottom: 1.25rem;
    background: #fafafa;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 4px;
    font-size: 0.8125rem;
  }
  .owner-banner.show { display: flex; }
  .owner-banner a {
    color: #0a0a0a;
    font-weight: 500;
    text-decoration: none;
  }
  .owner-banner a:hover { text-decoration: underline; }

  /* Hero */
  .hero {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .hero-icon {
    width: 64px; height: 64px;
    background: #0a0a0a;
    display: flex; align-items: center; justify-content: center;
    font-size: 2rem;
    flex-shrink: 0;
    color: #fff;
    border-radius: 12px;
    overflow: hidden;
  }
  .hero-icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .hero-info { flex: 1; min-width: 0; }
  .hero-info h1 {
    font-size: 1.625rem;
    font-weight: 700;
    color: #0a0a0a;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .hero-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.375rem;
    font-size: 0.8125rem;
    color: #999;
  }
  .hero-meta a { color: #555; text-decoration: none; }
  .hero-meta a:hover { text-decoration: underline; }
  .hero-meta .sep { color: #ccc; }
  .badge {
    display: inline-block;
    background: #fafafa;
    color: #555;
    padding: 0.1rem 0.4rem;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 3px;
    white-space: nowrap;
  }
  .badge.unlisted {
    background: #fff7ed;
    color: #9a3412;
    border-color: #fed7aa;
  }
  .badge.category {
    text-transform: capitalize;
  }
  .hero-stats {
    margin-top: 0.5rem;
    font-size: 0.8125rem;
    color: #666;
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .hero-stats .sep { color: #ccc; }

  .tag-row {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }
  .tag {
    font-size: 0.6875rem;
    color: #666;
    background: #f5f5f5;
    padding: 0.15rem 0.5rem;
    border-radius: 10px;
  }

  /* CTA area — client JS renders into this */
  .cta-area {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 1.5rem 0 2rem;
  }
  .cta-row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .cta-secondary-link {
    font-size: 0.8125rem;
    color: #555;
    text-decoration: none;
    padding: 0.25rem 0;
  }
  .cta-secondary-link:hover {
    color: #0a0a0a;
    text-decoration: underline;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.6rem 1rem;
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 0.875rem;
    font-weight: 500;
    text-decoration: none;
    border: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    white-space: nowrap;
    border-radius: 6px;
  }
  .btn:disabled { cursor: not-allowed; opacity: 0.7; }
  .btn-primary {
    background: #0a0a0a;
    color: #ffffff;
  }
  .btn-primary:hover:not(:disabled) { background: #333; }
  .btn-primary.copied { background: #333; }
  .btn-primary.btn-lg {
    padding: 0.75rem 1.5rem;
    font-size: 0.9375rem;
    min-width: 200px;
  }
  .btn-secondary {
    background: #fafafa;
    color: #0a0a0a;
    border: 1px solid rgba(0,0,0,0.1);
  }
  .btn-secondary:hover:not(:disabled) { background: #f0f0f0; }
  .btn-secondary.copied { background: #0a0a0a; color: #fff; }
  .btn-ghost {
    background: transparent;
    color: #555;
    font-size: 0.8125rem;
    padding: 0.4rem 0.75rem;
  }
  .btn-ghost:hover:not(:disabled) { color: #0a0a0a; background: rgba(0,0,0,0.04); }

  /* Spinner */
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Description */
  .app-desc {
    color: #333;
    font-size: 0.9375rem;
    line-height: 1.6;
    margin-bottom: 1.5rem;
  }

  .tab-bar {
    display: none;
    gap: 0.5rem;
    margin: 0 0 1.25rem;
    border-bottom: 1px solid rgba(0,0,0,0.08);
    padding-bottom: 0.5rem;
  }
  .tab-btn {
    appearance: none;
    border: none;
    background: transparent;
    color: #666;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 0.4rem 0.65rem;
    border-radius: 999px;
    cursor: pointer;
  }
  .tab-btn.active {
    background: #0a0a0a;
    color: #fff;
  }
  .tab-btn .badge-inline {
    margin-left: 0.35rem;
    font-size: 0.6875rem;
    color: inherit;
    opacity: 0.8;
  }
  .tab-panel.is-hidden {
    display: none;
  }

  .settings-shell {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .settings-status {
    font-size: 0.8125rem;
    line-height: 1.5;
    padding: 0.8rem 0.95rem;
    border-radius: 6px;
    border: 1px solid rgba(0,0,0,0.08);
    background: #fafafa;
    color: #444;
  }
  .settings-status.warning {
    background: #fff7ed;
    border-color: #fed7aa;
    color: #9a3412;
  }
  .settings-note {
    font-size: 0.8125rem;
    color: #666;
  }
  .settings-note a {
    color: #0a0a0a;
    text-decoration: underline;
  }
  .settings-form {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  .settings-field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .settings-label-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .settings-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: #111;
  }
  .settings-required,
  .settings-configured {
    display: inline-flex;
    align-items: center;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 600;
    border: 1px solid rgba(0,0,0,0.08);
    background: #fafafa;
    color: #555;
  }
  .settings-configured {
    background: #f0fdf4;
    border-color: #bbf7d0;
    color: #166534;
  }
  .settings-help {
    font-size: 0.8125rem;
    color: #666;
    line-height: 1.5;
  }
  .settings-input,
  .settings-textarea {
    width: 100%;
    padding: 0.72rem 0.8rem;
    border-radius: 6px;
    border: 1px solid rgba(0,0,0,0.12);
    background: #fff;
    color: #111;
    font: inherit;
  }
  .settings-textarea {
    min-height: 120px;
    resize: vertical;
  }
  .settings-input:focus,
  .settings-textarea:focus {
    outline: none;
    border-color: #0a0a0a;
    box-shadow: 0 0 0 3px rgba(10,10,10,0.08);
  }
  .settings-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.35rem;
  }
  .settings-meta {
    font-size: 0.75rem;
    color: #777;
  }
  .settings-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.45rem;
    padding: 1rem 1.1rem;
    border: 1px dashed rgba(0,0,0,0.08);
    border-radius: 8px;
    text-align: center;
    background: #fafafa;
    color: #666;
  }
  .settings-state.loading {
    background: #fff;
  }
  .settings-state.error {
    background: #fef2f2;
    border-color: #fecaca;
  }
  .settings-state-icon {
    width: 2rem;
    height: 2rem;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.04);
    color: #555;
  }
  .settings-state.error .settings-state-icon {
    background: rgba(239,68,68,0.12);
    color: #b91c1c;
  }
  .settings-state-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #111;
  }
  .settings-state-desc {
    font-size: 0.8125rem;
    line-height: 1.5;
    color: #666;
    max-width: 34rem;
  }
  .market-section {
    background: #fff;
  }
  .market-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.9rem;
  }
  .market-title {
    color: #111;
    font-size: 1rem;
    font-weight: 700;
    margin-top: -0.25rem;
  }
  .market-status {
    display: inline-flex;
    align-items: center;
    padding: 0.18rem 0.55rem;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 999px;
    background: #fafafa;
    color: #555;
    font-size: 0.6875rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .market-status.buy {
    background: #f0fdf4;
    border-color: #bbf7d0;
    color: #15803d;
  }
  .market-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
    gap: 0.65rem;
    margin-bottom: 0.8rem;
  }
  .market-grid > div {
    min-width: 0;
    padding: 0.65rem 0.7rem;
    border: 1px solid rgba(0,0,0,0.08);
    background: #fafafa;
  }
  .market-grid span {
    display: block;
    color: #999;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.18rem;
  }
  .market-grid strong {
    display: block;
    min-width: 0;
    color: #111;
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .market-foot {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    color: #777;
    font-size: 0.8125rem;
  }
  .market-foot a {
    color: #0a0a0a;
    font-weight: 600;
    text-decoration: none;
  }
  .market-note {
    margin-top: 0.75rem;
    color: #555;
    font-size: 0.875rem;
    line-height: 1.55;
  }
  .trust-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.9rem;
  }
  .trust-header .section-title {
    margin-bottom: 0;
  }
  .trust-status {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.18rem 0.5rem;
    border-radius: 999px;
    border: 1px solid rgba(0,0,0,0.08);
    font-size: 0.6875rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .trust-status::before {
    content: "";
    width: 0.42rem;
    height: 0.42rem;
    border-radius: 999px;
    background: currentColor;
  }
  .trust-status.ok {
    color: #15803d;
    background: #f0fdf4;
    border-color: #bbf7d0;
  }
  .trust-status.warn {
    color: #92400e;
    background: #fffbeb;
    border-color: #fde68a;
  }
  .trust-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
    gap: 0.65rem;
    margin-bottom: 0.85rem;
  }
  .trust-grid > div {
    min-width: 0;
    padding: 0.65rem 0.7rem;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 6px;
    background: #fff;
  }
  .trust-grid span {
    display: block;
    color: #999;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.18rem;
  }
  .trust-grid strong,
  .trust-grid code {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #111;
    font-size: 0.8125rem;
  }
  .trust-grid code {
    font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
  }
  .trust-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin-top: 0.5rem;
  }
  .trust-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.12rem 0.45rem;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 999px;
    background: #fff;
    color: #555;
    font-size: 0.72rem;
  }

  /* Screenshots carousel — horizontal snap scroller, bleeds to edges on mobile */
  .app-screenshots {
    margin: 0 -1rem 1.5rem;
    padding: 0 1rem;
  }
  .screenshots-scroller {
    display: flex;
    gap: 0.75rem;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 0.5rem;
  }
  .screenshots-scroller::-webkit-scrollbar { height: 6px; }
  .screenshots-scroller::-webkit-scrollbar-thumb {
    background: rgba(0,0,0,0.15);
    border-radius: 3px;
  }
  .screenshot-item {
    flex: 0 0 auto;
    scroll-snap-align: start;
    width: min(80vw, 420px);
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid rgba(0,0,0,0.08);
    background: #fafafa;
    display: block;
    transition: transform 0.15s;
  }
  .screenshot-item:hover { transform: translateY(-2px); }
  .screenshot-item img {
    display: block;
    width: 100%;
    height: auto;
    object-fit: cover;
    aspect-ratio: 16 / 10;
  }

  /* Long description section — reuses .section and .docs-content styles */
  .app-long-desc {
    margin-bottom: 1.5rem;
  }

  /* Functions section */
  .section {
    background: #fafafa;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 6px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.25rem;
  }
  .section-title {
    font-size: 0.6875rem;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.75rem;
    font-weight: 600;
  }
  .docs-content { color: #333; line-height: 1.7; }
  .docs-content h1 { font-size: 1.25rem; color: #0a0a0a; margin: 1.25rem 0 0.5rem; }
  .docs-content h2 { font-size: 1.0625rem; color: #0a0a0a; margin: 1.25rem 0 0.5rem; border-bottom: 1px solid rgba(0,0,0,0.08); padding-bottom: 0.3rem; }
  .docs-content h3 { font-size: 0.9375rem; color: #0a0a0a; margin: 1rem 0 0.4rem; }
  .docs-content p { margin: 0.5rem 0; }
  .docs-content a { color: #0a0a0a; text-decoration: underline; }
  .docs-content code {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.85em;
    background: rgba(0,0,0,0.04);
    padding: 0.15em 0.4em;
    color: #0a0a0a;
    border-radius: 3px;
  }
  .docs-content pre {
    margin: 0.75rem 0;
    padding: 0.875rem;
    background: #fff;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 4px;
    overflow-x: auto;
  }
  .docs-content pre code { background: none; padding: 0; font-size: 0.8125em; color: #555; }
  .docs-content ul, .docs-content ol { margin: 0.5rem 0; padding-left: 1.5rem; }
  .docs-content li { margin: 0.2rem 0; }
  .docs-content blockquote {
    margin: 0.75rem 0;
    padding: 0.5rem 0.875rem;
    border-left: 3px solid #0a0a0a;
    background: #fafafa;
    color: #555;
  }
  .docs-content hr { margin: 1.25rem 0; border: none; border-top: 1px solid rgba(0,0,0,0.08); }

  .fn-item {
    padding: 0.55rem 0;
    border-bottom: 1px solid rgba(0,0,0,0.06);
  }
  .fn-item:last-child { border-bottom: none; }
  .fn-name {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    color: #0a0a0a;
    font-weight: 500;
    font-size: 0.8125rem;
  }
  .fn-desc {
    display: block;
    font-size: 0.75rem;
    color: #999;
    margin-top: 0.2rem;
  }
  .no-docs { color: #999; font-style: italic; font-size: 0.875rem; }

  /* MCP endpoint — demoted to collapsible */
  details.mcp-details {
    background: #fafafa;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 6px;
    padding: 0.875rem 1.25rem;
    margin-bottom: 1.25rem;
  }
  details.mcp-details summary {
    cursor: pointer;
    font-size: 0.8125rem;
    color: #555;
    font-weight: 500;
    list-style: none;
    user-select: none;
  }
  details.mcp-details summary::-webkit-details-marker { display: none; }
  details.mcp-details summary::before {
    content: '▸ ';
    color: #999;
    margin-right: 0.25rem;
  }
  details.mcp-details[open] summary::before { content: '▾ '; }
  details.mcp-details[open] summary { margin-bottom: 0.75rem; }
  .endpoint-url {
    background: #fff;
    border: 1px solid rgba(0,0,0,0.08);
    padding: 0.55rem 0.75rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.75rem;
    color: #0a0a0a;
    word-break: break-all;
    user-select: all;
    border-radius: 4px;
    margin-bottom: 0.6rem;
  }
  .endpoint-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Footer-bar with share button */
  .footer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 1.5rem;
    margin-top: 0.5rem;
    border-top: 1px solid rgba(0,0,0,0.06);
    font-size: 0.75rem;
    color: #999;
  }
  .footer-bar a { color: #555; text-decoration: none; }
  .footer-bar a:hover { color: #0a0a0a; }

  /* Toast */
  .toast {
    position: fixed;
    bottom: 1.5rem;
    left: 50%;
    transform: translateX(-50%) translateY(1rem);
    background: #0a0a0a;
    color: #fff;
    padding: 0.65rem 1.1rem;
    border-radius: 6px;
    font-size: 0.8125rem;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s, transform 0.2s;
    z-index: 9999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    max-width: 90vw;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
  .toast.error { background: #b91c1c; }
  .toast-action {
    color: #fff;
    text-decoration: underline;
    cursor: pointer;
    font-weight: 500;
  }
  .toast-dismiss {
    color: rgba(255,255,255,0.6);
    cursor: pointer;
    padding: 0 0.25rem;
    font-size: 1rem;
    line-height: 1;
  }
  .toast-dismiss:hover { color: #fff; }

  @media (max-width: 600px) {
    body { padding: 1rem 0.5rem 3rem; }
    .hero { gap: 0.75rem; }
    .hero-icon { width: 56px; height: 56px; font-size: 1.75rem; }
    .hero-info h1 { font-size: 1.375rem; }
    .btn-primary.btn-lg { width: 100%; min-width: 0; }
    .cta-row { flex-direction: column; align-items: stretch; }
  }
</style>
</head>
<body>
<div class="container">

  <!-- Owner banner (rendered client-side once library-status resolves) -->
  <div id="ownerBanner" class="owner-banner" role="region" aria-label="Owner controls">
    <span>You own this app.</span>
    <a href="/a/${escapeHtml(app.id)}">Manage &rarr;</a>
  </div>

  <!-- Hero -->
  <div class="hero">
    <div class="hero-icon">
      <img src="/api/apps/${
    escapeHtml(app.id)
  }/icon" alt="" onerror="this.replaceWith(document.createTextNode('\\u26A1'));">
    </div>
    <div class="hero-info">
      <h1>${appName}</h1>
      <div class="hero-meta">
        <a href="${ownerProfileUrl}">by ${escapeHtml(ownerName)}</a>
        <span class="sep">·</span>
        <span class="badge">v${version}</span>
        ${isUnlisted ? '<span class="badge unlisted">Unlisted</span>' : ""}
        ${category ? `<span class="badge category">${category}</span>` : ""}
      </div>
      <div class="hero-stats">
        <span>&#128077; ${likes.toLocaleString()}</span>
        <span class="sep">·</span>
        <span>${runs.toLocaleString()} ${runs === 1 ? "run" : "runs"}</span>
      </div>
      ${
    tags.length > 0
      ? `<div class="tag-row">${
        tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")
      }</div>`
      : ""
  }
    </div>
  </div>

  <!-- CTA area — populated by client bootstrap -->
  <div id="appStoreCTA"
       class="cta-area"
       data-app-id="${escapeHtml(app.id)}"
      data-app-name="${escapeHtml(app.name || app.slug)}"
      data-is-embed="${isEmbed ? "true" : "false"}">
    <div class="cta-row">
      <button class="btn btn-primary btn-lg" disabled>
        <span class="spinner"></span> Loading install status...
      </button>
    </div>
  </div>

  <div id="appTabBar" class="tab-bar" role="tablist" aria-label="App page sections"></div>

  <section id="overviewPanel" class="tab-panel">
    <!-- Description -->
    ${description ? `<p class="app-desc">${description}</p>` : ""}

    ${marketplaceHtml}

    ${trustCardHtml}

    <!-- Screenshots carousel -->
    ${
    hasScreenshots
      ? `
    <section class="app-screenshots">
      <div class="screenshots-scroller">
        ${
        screenshots.map((_, idx) => `
          <a class="screenshot-item" href="/api/apps/${
          escapeHtml(app.id)
        }/screenshots/${idx}" target="_blank" rel="noopener">
            <img src="/api/apps/${
          escapeHtml(app.id)
        }/screenshots/${idx}" alt="Screenshot ${idx + 1}" loading="lazy">
          </a>
        `).join("")
      }
      </div>
    </section>`
      : ""
  }

    <!-- Long description -->
    ${
    longDescriptionHtml
      ? `
    <section class="section app-long-desc">
      <div class="docs-content">${longDescriptionHtml}</div>
    </section>`
      : ""
  }

    <!-- Functions -->
    <section class="section">
      <div class="section-title">Functions</div>
      <div class="docs-content">${skillsHtml}</div>
    </section>
  </section>

  <section id="settingsPanel" class="section tab-panel is-hidden" aria-live="polite">
    <div class="section-title">Settings</div>
    <div id="settingsContent" class="settings-shell">
      <div class="settings-state">
        <div class="settings-state-icon">⚙️</div>
        <div class="settings-state-title">Settings will appear here</div>
        <div class="settings-state-desc">Install this app to save your own settings and connection details.</div>
      </div>
    </div>
  </section>

  <!-- MCP endpoint (demoted) -->
  <details class="mcp-details">
    <summary>Connect directly via MCP</summary>
    <div class="endpoint-url" id="mcpUrl">${escapeHtml(mcpEndpoint)}</div>
    <div class="endpoint-actions">
      <button class="btn btn-secondary" onclick="copyUrl()" id="copyUrlBtn">Copy URL</button>
      <button class="btn btn-secondary" onclick="copyInstructions()" id="copyInstructionsBtn">Copy Agent Instructions</button>
    </div>
  </details>

  <!-- Footer with share -->
  <div class="footer-bar">
    <span>Powered by <a href="${escapeHtml(baseUrl)}">Galactic</a></span>
    <button class="btn btn-ghost" onclick="copyShareLink()" id="shareLinkBtn">
      <span>Copy share link</span>
    </button>
  </div>
</div>

<!-- Toast container -->
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script>
(function() {
  var APP_ID = ${JSON.stringify(app.id)};
  var APP_NAME = ${JSON.stringify(app.name || app.slug)};
  var SHARE_URL = ${JSON.stringify(shareUrl)};
  var DEEP_LINK = ${JSON.stringify(deepLink)};
  var DOWNLOAD_URL = ${JSON.stringify(dlUrl)};
  var IS_EMBED_SSR = ${isEmbed ? "true" : "false"};

  var ctaEl = document.getElementById('appStoreCTA');
  var ownerBannerEl = document.getElementById('ownerBanner');
  var toastEl = document.getElementById('toast');
  var tabBarEl = document.getElementById('appTabBar');
  var overviewPanelEl = document.getElementById('overviewPanel');
  var settingsPanelEl = document.getElementById('settingsPanel');
  var settingsContentEl = document.getElementById('settingsContent');

  // Detect embed via SSR hint OR parent frame (handles token-only refreshes)
  var inDesktop = IS_EMBED_SSR || (window.parent && window.parent !== window);

  function readHashParam(name) {
    try {
      if (!location.hash) return '';
      var match = location.hash.match(new RegExp('[#&]' + name + '=([^&]*)'));
      return match ? decodeURIComponent(match[1]) : '';
    } catch (e) {
      return '';
    }
  }

  // ── Token discovery ───────────────────────────────────────────
  function readTokenState() {
    try {
      if (inDesktop) {
        var bridge = readHashParam('bridge_token');
        if (bridge) return { token: bridge, source: 'bridge' };
      }
      return { token: '', source: 'none' };
    } catch (e) {
      return { token: '', source: 'none' };
    }
  }
  function stripTokenFromUrl() {
    try {
      var cleanUrl = new URL(location.href);
      var changed = false;
      if (cleanUrl.searchParams.has('token')) {
        cleanUrl.searchParams.delete('token');
        changed = true;
      }
      if (location.hash && (
        location.hash.indexOf('bridge_token=') !== -1 ||
        location.hash.indexOf('token=') !== -1
      )) {
        cleanUrl.hash = '';
        changed = true;
      }
      if (changed) {
        history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      }
    } catch (e) {}
  }

  var tokenState = readTokenState();
  var token = tokenState.token;
  var authSource = tokenState.source;
  var isAuthenticated = !!token && authSource !== 'bridge';
  var hasLegacyUrlAuthArtifact = location.search.indexOf('token=') !== -1
    || location.hash.indexOf('bridge_token=') !== -1
    || location.hash.indexOf('token=') !== -1;
  if ((token && authSource === 'bridge') || hasLegacyUrlAuthArtifact) {
    stripTokenFromUrl();
  }

  var installingFlag = new URLSearchParams(location.search).get('installing') === '1';

  var nativeFetch = window.fetch.bind(window);
  function toAbsoluteUrl(input) {
    try {
      if (typeof input === 'string' || input instanceof URL) return new URL(String(input), location.href);
      if (input && input.url) return new URL(input.url, location.href);
    } catch (e) {}
    return null;
  }
  function shouldStripAuthHeader(value) {
    return /^Bearer\\s*(null|undefined)?\\s*$/i.test(value || '');
  }
  function shouldRetryAfterRefresh(url) {
    return !/^\\/auth\\/(refresh|session|login|callback|signout)/.test(url.pathname);
  }
  window.fetch = async function(input, init) {
    var absoluteUrl = toAbsoluteUrl(input);
    var sameOrigin = !!absoluteUrl && absoluteUrl.origin === location.origin;
    var nextInit = Object.assign({}, init || {});
    var headers = new Headers(nextInit.headers || ((input && input.headers) ? input.headers : undefined));

    if (sameOrigin) {
      if (token && authSource !== 'bridge' && !headers.has('Authorization')) {
        headers.set('Authorization', 'Bearer ' + token);
      } else if (!token && shouldStripAuthHeader(headers.get('Authorization') || '')) {
        headers.delete('Authorization');
      }
      if (!nextInit.credentials) nextInit.credentials = 'same-origin';
    }

    nextInit.headers = headers;

    var response = await nativeFetch(input, nextInit);
    if (
      response.status === 401 &&
      sameOrigin &&
      !token &&
      absoluteUrl &&
      shouldRetryAfterRefresh(absoluteUrl)
    ) {
      var refreshResponse = await nativeFetch('/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (refreshResponse.ok) {
        response = await nativeFetch(input, nextInit);
      }
    }
    return response;
  };

  async function bootstrapEmbedBridgeSession() {
    if (!inDesktop || authSource !== 'bridge' || !token) return;

    var bridgeToken = token;
    token = '';

    try {
      var response = await nativeFetch('/auth/embed/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ bridge_token: bridgeToken }),
      });
      if (response.ok) {
        authSource = 'cookie';
        isAuthenticated = true;
        return;
      }
      isAuthenticated = false;
      console.warn('[embed] Failed to exchange desktop embed bridge token');
    } catch (e) {
      isAuthenticated = false;
      console.warn('[embed] Desktop embed bridge exchange failed', e);
    }
  }

  async function detectBrowserSession() {
    if (token) {
      isAuthenticated = true;
      return;
    }
    try {
      var res = await fetch('/auth/user');
      if (!res.ok) {
        isAuthenticated = false;
        return;
      }
      var data = await res.json();
      isAuthenticated = !!(data && data.id);
      authSource = isAuthenticated ? 'cookie' : authSource;
    } catch (e) {
      isAuthenticated = false;
    }
  }

  // ── State machine ─────────────────────────────────────────────
  // 'anonymous' | 'not-in-library' | 'in-library' | 'owner'
  function emptyStatus() {
    return {
      inLibrary: false,
      isOwner: false,
      hasUserSettings: false,
      connectedKeys: [],
      missingRequired: [],
      fullyConnected: true,
      requiresSetup: false,
    };
  }

  var state = 'anonymous';
  var status = emptyStatus();
  var activeTab = 'overview';
  var settingsData = null;
  var settingsLoaded = false;
  var settingsLoading = false;
  var settingsMessage = 'Install this app to save your own settings and connection details.';

  async function fetchStatus() {
    if (!isAuthenticated) return emptyStatus();
    try {
      var res = await fetch('/api/apps/' + encodeURIComponent(APP_ID) + '/library-status');
      if (!res.ok) return emptyStatus();
      var next = await res.json();
      return Object.assign(emptyStatus(), next || {});
    } catch (e) {
      return emptyStatus();
    }
  }

  function pickState(s) {
    if (s.isOwner) return 'owner';
    if (!isAuthenticated) return 'anonymous';
    return s.inLibrary ? 'in-library' : 'not-in-library';
  }

  function canShowSettings() {
    return (state === 'owner' || state === 'in-library') && !!status.hasUserSettings;
  }

  function resetSettingsState() {
    settingsData = null;
    settingsLoaded = false;
    settingsLoading = false;
    settingsMessage = 'Install this app to save your own settings and connection details.';
  }

  function setSettingsPlaceholder(message, kind) {
    settingsMessage = message;
    var nextKind = kind || 'empty';
    var title = nextKind === 'error'
      ? 'Could not load settings'
      : nextKind === 'loading'
        ? 'Loading settings'
        : 'Settings will appear here';
    settingsContentEl.innerHTML = renderSettingsState(nextKind, title, message);
  }

  function renderTabs() {
    if (!canShowSettings()) {
      activeTab = 'overview';
      tabBarEl.style.display = 'none';
      return;
    }

    tabBarEl.style.display = 'flex';
    tabBarEl.innerHTML =
      '<button class="tab-btn' + (activeTab === 'overview' ? ' active' : '') + '" role="tab" aria-selected="' + (activeTab === 'overview' ? 'true' : 'false') + '" onclick="window.__ul.setActiveTab(\\'overview\\')">Overview</button>' +
      '<button class="tab-btn' + (activeTab === 'settings' ? ' active' : '') + '" role="tab" aria-selected="' + (activeTab === 'settings' ? 'true' : 'false') + '" onclick="window.__ul.setActiveTab(\\'settings\\')">Settings' +
        (status.requiresSetup ? '<span class="badge-inline">Setup required</span>' : '') +
      '</button>';
  }

  function renderPanels() {
    overviewPanelEl.classList.toggle('is-hidden', activeTab !== 'overview');
    settingsPanelEl.classList.toggle('is-hidden', activeTab !== 'settings' || !canShowSettings());
  }

  function renderSettingsContent() {
    if (!canShowSettings()) {
      setSettingsPlaceholder('Install this app to save your own settings and connection details.', 'empty');
      return;
    }

    if (settingsLoading) {
      settingsContentEl.innerHTML = renderSettingsState('loading', 'Loading your settings', 'Pulling your saved configuration for this app.');
      return;
    }

    if (!settingsLoaded || !settingsData) {
      settingsContentEl.innerHTML = renderSettingsState('empty', 'Settings will appear here', settingsMessage || 'Open Settings to load your saved configuration.');
      return;
    }

    var settings = Array.isArray(settingsData.settings) ? settingsData.settings : [];
    var settingsDiagnostics = settingsData.diagnostics && typeof settingsData.diagnostics === 'object'
      ? settingsData.diagnostics
      : null;
    if (settings.length === 0) {
      var emptyMessage = settingsDiagnostics && settingsDiagnostics.message
        ? settingsDiagnostics.message
        : 'This app is connected, but it does not declare any per-user settings yet.';
      settingsContentEl.innerHTML = renderSettingsState('empty', 'No user settings required', emptyMessage);
      return;
    }

    var statusText = settingsDiagnostics && settingsDiagnostics.message
      ? settingsDiagnostics.message
      : settingsData.fully_connected
      ? 'Your User Settings are ready.'
      : 'Setup required. Add: ' + (settingsData.missing_required || []).join(', ');
    var statusClass = 'settings-status' + (settingsData.fully_connected ? '' : ' warning');
    var remediationNote = settingsDiagnostics && settingsDiagnostics.remediation && settingsDiagnostics.remediation !== 'No action needed.'
      ? '<p class="settings-note">' + escHtml(settingsDiagnostics.remediation) + '</p>'
      : '';
    var ownerNote = '';
    if (settingsData.app_settings_count > 0) {
      if (settingsData.owner_manage_url) {
        ownerNote = '<p class="settings-note">App Settings are managed in <a href="' + escAttr(settingsData.owner_manage_url) + '">Manage</a>. User Settings on this page belong to the current installer.</p>';
      } else {
        ownerNote = '<p class="settings-note">This app also has App Settings managed by the app owner. The fields here are only your own User Settings.</p>';
      }
    }

    settingsContentEl.innerHTML =
      '<div class="' + statusClass + '">' + escHtml(statusText) + '</div>' +
      remediationNote +
      ownerNote +
      '<form id="userSettingsForm" class="settings-form">' +
        settings.map(function(setting) {
          var inputHtml;
          var placeholder = setting.placeholder || (setting.configured ? 'Saved. Enter a new value to replace it.' : '');
          if (setting.input === 'textarea') {
            inputHtml =
              '<textarea class="settings-textarea" data-setting-key="' + escAttr(setting.key) + '" placeholder="' + escAttr(placeholder) + '"></textarea>';
          } else {
            var inputType = setting.input || 'text';
            inputHtml =
              '<input class="settings-input" data-setting-key="' + escAttr(setting.key) + '" type="' + escAttr(inputType) + '" placeholder="' + escAttr(placeholder) + '"' +
              (inputType === 'password' ? ' autocomplete="new-password"' : '') +
              '>';
          }

          var badges =
            (setting.required ? '<span class="settings-required">Required</span>' : '') +
            (setting.configured ? '<span class="settings-configured">Saved</span>' : '');
          var updatedMeta = setting.updated_at
            ? '<div class="settings-meta">Last updated ' + escHtml(new Date(setting.updated_at).toLocaleString()) + '</div>'
            : '';

          return (
            '<label class="settings-field">' +
              '<span class="settings-label-row">' +
                '<span class="settings-label">' + escHtml(setting.label || setting.key) + '</span>' +
                badges +
              '</span>' +
              (setting.description ? '<span class="settings-help">' + escHtml(setting.description) + '</span>' : '') +
              (setting.help ? '<span class="settings-help">' + escHtml(setting.help) + '</span>' : '') +
              inputHtml +
              updatedMeta +
            '</label>'
          );
        }).join('') +
        '<div class="settings-actions">' +
          '<button class="btn btn-primary" type="submit" id="saveSettingsBtn">Save Settings</button>' +
          '<span class="settings-meta">Only fields you fill in will be updated.</span>' +
        '</div>' +
      '</form>';

    var formEl = document.getElementById('userSettingsForm');
    if (formEl) {
      formEl.addEventListener('submit', saveUserSettings);
    }
  }

  async function loadSettings(force) {
    if (!isAuthenticated || !canShowSettings()) return;
    if (settingsLoaded && !force) return;

    settingsLoading = true;
    renderSettingsContent();

    try {
      var res = await fetch('/api/apps/' + encodeURIComponent(APP_ID) + '/settings');

      if (!res.ok) {
        settingsLoaded = false;
        settingsData = null;
        setSettingsPlaceholder(res.status === 403
          ? 'Install this app to save your own settings and connection details.'
          : 'We could not load your settings right now.',
          res.status === 403 ? 'empty' : 'error');
        return;
      }

      settingsData = await res.json();
      settingsLoaded = true;
      renderSettingsContent();
    } catch (e) {
      settingsLoaded = false;
      settingsData = null;
      setSettingsPlaceholder('Network error while loading settings.', 'error');
    } finally {
      settingsLoading = false;
      renderSettingsContent();
    }
  }

  function setActiveTab(nextTab) {
    activeTab = canShowSettings() && nextTab === 'settings' ? 'settings' : 'overview';
    if (activeTab === 'settings' && !settingsLoaded && !settingsLoading) {
      settingsMessage = 'Open Settings to load your saved configuration.';
    }
    renderTabs();
    renderPanels();
    renderSettingsContent();
    if (activeTab === 'settings') {
      loadSettings(false);
    }
  }

  function openSettings() {
    setActiveTab('settings');
  }

  async function saveUserSettings(event) {
    event.preventDefault();
    if (!isAuthenticated) {
      showToast('Sign in to save settings.', { error: true });
      return;
    }

    var formEl = event.currentTarget;
    var values = {};
    var inputs = formEl.querySelectorAll('[data-setting-key]');
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var key = input.getAttribute('data-setting-key');
      var value = typeof input.value === 'string' ? input.value.trim() : '';
      if (key && value) {
        values[key] = value;
      }
    }

    if (Object.keys(values).length === 0) {
      showToast('Enter at least one setting to save.', { error: true });
      return;
    }

    var saveBtn = document.getElementById('saveSettingsBtn');
    var originalBtnHtml = saveBtn ? saveBtn.innerHTML : '';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner"></span> Saving...';
    }

    try {
      var res = await fetch('/api/apps/' + encodeURIComponent(APP_ID) + '/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: values }),
      });

      if (!res.ok) {
        var errMessage = 'Could not save settings. Try again.';
        try {
          var errData = await res.json();
          if (errData && typeof errData.error === 'string') {
            errMessage = errData.error;
          } else if (errData && Array.isArray(errData.errors) && errData.errors.length > 0) {
            errMessage = errData.errors[0];
          }
        } catch (e) {}
        showToast(errMessage, { error: true });
        return;
      }

      await res.json();
      status = await fetchStatus();
      state = pickState(status);
      settingsLoaded = false;
      settingsData = null;
      renderCTA();
      if (status.requiresSetup) {
        await loadSettings(true);
        showToast('Saved. Finish the remaining required settings to activate the app.');
      } else {
        await loadSettings(true);
        showToast('Settings saved');
      }
    } catch (e) {
      showToast('Network error while saving settings.', { error: true });
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalBtnHtml;
      }
    }
  }

  // ── Button rendering ──────────────────────────────────────────
  function renderCTA() {
    var html;
    // Owner banner: only visible when state === 'owner'
    if (state === 'owner') {
      ownerBannerEl.classList.add('show');
    } else {
      ownerBannerEl.classList.remove('show');
    }
    if (state === 'owner') {
      // Owner sees banner at top; CTA area is empty for their own app.
      html = '';
    } else if (state === 'anonymous') {
      // Big primary Install + small secondary download link.
      html =
        '<div class="cta-row">' +
          '<button class="btn btn-primary btn-lg" onclick="window.__ul.installAnon()">Install this app</button>' +
        '</div>' +
        '<a class="cta-secondary-link" href="' + escAttr(DOWNLOAD_URL) + '">Download Galactic Desktop &rarr;</a>';
    } else if (state === 'not-in-library') {
      html =
        '<div class="cta-row">' +
          '<button class="btn btn-primary btn-lg" onclick="window.__ul.installApp()">Install</button>' +
        '</div>';
    } else if (state === 'in-library') {
      if (status.hasUserSettings && status.requiresSetup) {
        html =
          '<div class="cta-row">' +
            '<button class="btn btn-primary btn-lg" onclick="window.__ul.openSettings()">Finish setup</button>' +
            '<button class="btn btn-secondary" onclick="window.__ul.uninstallApp()">Uninstall</button>' +
          '</div>';
      } else if (inDesktop) {
        // Inside desktop: opening the app page is already the desktop context.
        html =
          '<div class="cta-row">' +
            (status.hasUserSettings ? '<button class="btn btn-secondary" onclick="window.__ul.openSettings()">Settings</button>' : '') +
            '<button class="btn btn-secondary" onclick="window.__ul.uninstallApp()">Uninstall</button>' +
          '</div>';
      } else {
        // Web + in library: prompt to open in desktop + uninstall fallback.
        html =
          '<div class="cta-row">' +
            '<button class="btn btn-primary btn-lg" onclick="window.__ul.openInDesktop()">Open in Galactic</button>' +
            (status.hasUserSettings ? '<button class="btn btn-secondary" onclick="window.__ul.openSettings()">Settings</button>' : '') +
            '<button class="btn btn-secondary" onclick="window.__ul.uninstallApp()">Uninstall</button>' +
          '</div>';
      }
    }
    ctaEl.innerHTML = html || '';
    renderTabs();
    renderPanels();
    renderSettingsContent();
  }

  function renderInstalling() {
    ctaEl.innerHTML =
      '<div class="cta-row">' +
        '<button class="btn btn-primary btn-lg" disabled><span class="spinner"></span> Installing...</button>' +
      '</div>';
  }
  function renderUninstalling() {
    ctaEl.innerHTML =
      '<div class="cta-row">' +
        '<button class="btn btn-secondary" disabled><span class="spinner"></span> Uninstalling...</button>' +
      '</div>';
  }

  // ── Actions ───────────────────────────────────────────────────
  async function installApp() {
    if (!isAuthenticated) { return installAnon(); }
    renderInstalling();
    try {
      var res = await fetch('/api/apps/' + encodeURIComponent(APP_ID) + '/save', {
        method: 'POST',
      });
      if (res.ok) {
        resetSettingsState();
        status = await fetchStatus();
        state = pickState(status);
        renderCTA();
        if (status.requiresSetup) {
          openSettings();
          await loadSettings(true);
          showToast('\\u2713 Installed. Finish setup in Settings.');
        } else {
          showToast('\\u2713 Installed');
        }
        if (inDesktop) {
          try { window.parent.postMessage({ type: 'library-changed', appId: APP_ID, action: 'install' }, '*'); } catch (e) {}
        }
      } else {
        status = Object.assign(emptyStatus(), status, { inLibrary: false });
        state = 'not-in-library';
        renderCTA();
        showToast('Could not install. Try again.', { error: true });
      }
    } catch (e) {
      status = Object.assign(emptyStatus(), status, { inLibrary: false });
      state = 'not-in-library';
      renderCTA();
      showToast('Network error. Try again.', { error: true });
    }
  }

  async function uninstallApp() {
    if (!isAuthenticated) return;
    if (!confirm('Remove ' + APP_NAME + ' from your library?')) return;
    renderUninstalling();
    try {
      var res = await fetch('/api/apps/' + encodeURIComponent(APP_ID) + '/save', {
        method: 'DELETE',
      });
      if (res.ok) {
        resetSettingsState();
        status = await fetchStatus();
        state = pickState(status);
        activeTab = 'overview';
        renderCTA();
        showToast('Uninstalled');
        if (inDesktop) {
          try { window.parent.postMessage({ type: 'library-changed', appId: APP_ID, action: 'uninstall' }, '*'); } catch (e) {}
        }
      } else {
        state = pickState(status);
        renderCTA();
        showToast('Could not uninstall. Try again.', { error: true });
      }
    } catch (e) {
      state = pickState(status);
      renderCTA();
      showToast('Network error. Try again.', { error: true });
    }
  }

  function installAnon() {
    // Kick off Google OAuth. Supabase flow uses return_to to redirect back
    // with installing=1 so the callback auto-saves once the token lands.
    var next = '/app/' + encodeURIComponent(APP_ID) + '?installing=1';
    location.href = '/auth/login?return_to=' + encodeURIComponent(next);
  }

  function openInDesktop() {
    var start = Date.now();
    var opened = false;
    var onBlur = function() { opened = true; };
    window.addEventListener('blur', onBlur, { once: true });
    location.href = DEEP_LINK;

    setTimeout(function() {
      window.removeEventListener('blur', onBlur);
      if (!opened && Date.now() - start < 2000 && !document.hidden) {
        showFallbackToast();
      } else {
        try { localStorage.setItem('ul_last_open_success', String(Date.now())); } catch (e) {}
      }
    }, 1500);
  }

  function copyShareLink() {
    navigator.clipboard.writeText(SHARE_URL).then(function() {
      var btn = document.getElementById('shareLinkBtn');
      if (btn) {
        var originalHTML = btn.innerHTML;
        btn.innerHTML = '<span>Copied</span>';
        setTimeout(function() { btn.innerHTML = originalHTML; }, 1500);
      }
    }, function() { showToast('Copy failed', { error: true }); });
  }

  // ── Toast ─────────────────────────────────────────────────────
  var toastTimer;
  function showToast(msg, opts) {
    opts = opts || {};
    clearTimeout(toastTimer);
    toastEl.className = 'toast show' + (opts.error ? ' error' : '');
    toastEl.innerHTML = '<span>' + escHtml(msg) + '</span>' +
      (opts.action ? '<span class="toast-action" id="toastAction">' + escHtml(opts.actionLabel) + '</span>' : '') +
      '<span class="toast-dismiss" onclick="document.getElementById(\\'toast\\').className=\\'toast\\';">&times;</span>';
    if (opts.action) {
      var a = document.getElementById('toastAction');
      if (a) a.onclick = opts.action;
    }
    if (!opts.sticky) {
      toastTimer = setTimeout(function() { toastEl.className = 'toast'; }, opts.duration || 3200);
    }
  }
  function showFallbackToast() {
    showToast('Did not open?', {
      sticky: true,
      action: function() { location.href = DOWNLOAD_URL; },
      actionLabel: 'Get Galactic',
    });
  }

  // ── Helpers ───────────────────────────────────────────────────
  function escHtml(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderSettingsState(kind, title, message) {
    var icon = kind === 'loading'
      ? '<span class="spinner"></span>'
      : kind === 'error'
        ? '&#10005;'
        : '&#9881;';
    return '<div class="settings-state ' + escAttr(kind || 'empty') + '">' +
      '<div class="settings-state-icon">' + icon + '</div>' +
      '<div class="settings-state-title">' + escHtml(title) + '</div>' +
      (message ? '<div class="settings-state-desc">' + escHtml(message) + '</div>' : '') +
    '</div>';
  }

  // ── Legacy helpers used by the <details> block ────────────────
  window.copyUrl = function() {
    var url = document.getElementById('mcpUrl').textContent;
    navigator.clipboard.writeText(url).then(function() {
      var btn = document.getElementById('copyUrlBtn');
      btn.className = 'btn btn-secondary copied';
      btn.textContent = 'Copied';
      setTimeout(function() {
        btn.className = 'btn btn-secondary';
        btn.textContent = 'Copy URL';
      }, 2000);
    });
  };
  window.copyInstructions = function() {
    var btn = document.getElementById('copyInstructionsBtn');
    var original = btn.textContent;
    btn.textContent = '...';
    fetch('/api/apps/' + encodeURIComponent(APP_ID) + '/instructions')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        return navigator.clipboard.writeText(data.instructions).then(function() {
          btn.className = 'btn btn-secondary copied';
          btn.textContent = 'Copied. Paste to agent';
          setTimeout(function() {
            btn.className = 'btn btn-secondary';
            btn.textContent = original;
          }, 3000);
        });
      })
      .catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = original; }, 2000);
      });
  };
  window.copyShareLink = copyShareLink;

  // Expose for inline onclicks inside renderCTA
  window.__ul = {
    installApp: installApp,
    uninstallApp: uninstallApp,
    installAnon: installAnon,
    openInDesktop: openInDesktop,
    openSettings: openSettings,
    setActiveTab: setActiveTab,
  };

  // ── Bootstrap ─────────────────────────────────────────────────
  async function bootstrap() {
    await bootstrapEmbedBridgeSession();
    await detectBrowserSession();
    status = await fetchStatus();
    state = pickState(status);
    renderCTA();
    if (status.requiresSetup) {
      activeTab = 'settings';
      renderTabs();
      renderPanels();
      await loadSettings(false);
    }

    // Post-OAuth auto-install: the user landed here with ?installing=1
    // after completing Google sign-in. Silently save to library.
    if (installingFlag && state === 'not-in-library') {
      await installApp();
      // Clean query param so refresh doesn't re-trigger
      try {
        var clean = location.pathname + location.search.replace(/[?&]installing=1/, '').replace(/^\\?$/, '');
        history.replaceState(null, '', clean);
      } catch (e) {}
    }
  }

  // Refresh library state when tab regains focus (catches cross-window changes).
  document.addEventListener('visibilitychange', async function() {
    if (document.hidden) return;
    await detectBrowserSession();
    var fresh = await fetchStatus();
    var changed =
      fresh.inLibrary !== status.inLibrary ||
      fresh.isOwner !== status.isOwner ||
      fresh.hasUserSettings !== status.hasUserSettings ||
      fresh.requiresSetup !== status.requiresSetup ||
      fresh.fullyConnected !== status.fullyConnected;
    if (changed) {
      status = fresh;
      state = pickState(status);
      if (!canShowSettings()) {
        activeTab = 'overview';
        resetSettingsState();
      }
      renderCTA();
      if (activeTab === 'settings' && canShowSettings()) {
        await loadSettings(true);
      }
    }
  });

  bootstrap();
})();
</script>
</body>
</html>`;
}

async function renderTermsHTML(): Promise<string> {
  const billingConfig = await getBillingConfig();
  const publicConfig = toPublicBillingConfig(billingConfig);
  const copy = publicConfig.policy_copy;
  const platformFeePercent = `${
    Math.round(billingConfig.platformFeeRate * 100)
  }%`;

  const sections = [
    {
      title: "Credits",
      body: [
        copy.purchasedLight,
        copy.fundingTerms,
      ],
    },
    {
      title: "Creator Earnings And Payouts",
      body: [
        copy.creatorEarnings,
        billingConfig.payoutPolicyCopy,
        copy.payoutTerms,
      ],
    },
    {
      title: "Platform Fees And Waivers",
      body: [
        `Galactic's standard internal platform fee on eligible creator revenue is ${platformFeePercent}.`,
        copy.feeWaivers,
        copy.feeWaiverEndUserImpact,
        copy.feeWaiverCredit,
      ],
    },
    {
      title: "Cloud Usage",
      body: [
        copy.cloudUsage,
        copy.storagePolicy,
        copy.freeCallSponsorship,
      ],
    },
    {
      title: "Developer Access To Your Data",
      body: [
        "By default, an agent's developer cannot read the data you store in that " +
        "agent — they see only aggregate row counts and their own rows, never your " +
        "individual data. Some agents enable their developer to read your data for " +
        "support. Whether an agent's developer can do this is disclosed on the " +
        "agent's trust card before you use it (look for \"the developer can read " +
        "your data\").",
        "Where enabled, such access is read-only and every access is recorded in an " +
        "append-only audit log, so it can be reviewed. Do not store data in an " +
        "agent that you are unwilling to have its developer see when this " +
        "disclosure is present.",
      ],
    },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Terms - Galactic</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #fafafa;
    color: #18181b;
    line-height: 1.55;
  }
  main { max-width: 760px; margin: 0 auto; padding: 48px 20px 64px; }
  a { color: #2563eb; }
  .eyebrow {
    color: #71717a;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  h1 { font-size: 34px; line-height: 1.1; margin: 8px 0 12px; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  p { margin: 10px 0; color: #3f3f46; }
  .updated { color: #71717a; font-size: 14px; margin-bottom: 24px; }
  .back { display: inline-block; margin-top: 32px; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
  <div class="eyebrow">Galactic Terms</div>
  <h1>Credits Economy Terms</h1>
  <p class="updated">Last updated July 5, 2026</p>
  <p>These terms summarize the payment, creator earnings, payout, and platform fee rules used by Galactic. Additional product or marketplace terms may apply to specific workflows.</p>
  ${
    sections.map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}</h2>
      ${
      section.body.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join(
        "",
      )
    }
    </section>
  `).join("")
  }
  <a class="back" href="/wallet">Back to wallet</a>
</main>
</body>
</html>`;
}

// ============================================
// PUBLIC USER PROFILE
// ============================================

async function handlePublicUserProfile(
  request: Request,
  profileUserId: string,
): Promise<Response> {
  try {
    const SUPABASE_URL = getEnv("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const dbHeaders = {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };
    const baseUrl = getBaseUrl(request);

    // Fetch user info
    let user: {
      id: string;
      display_name: string | null;
      email: string;
      created_at: string;
    } | null = null;
    try {
      const userRes = await fetch(
        `${SUPABASE_URL}/rest/v1/users?id=eq.${profileUserId}&select=id,display_name,email,created_at&limit=1`,
        { headers: dbHeaders },
      );
      if (userRes.ok) {
        const users = await userRes.json() as Array<typeof user>;
        user = users.length > 0 ? users[0] : null;
      }
    } catch { /* */ }

    if (!user) {
      return new Response("Not found", { status: 404 });
    }

    // Fetch public apps
    let apps: Array<
      {
        id: string;
        name: string;
        slug: string;
        description: string | null;
        current_version: string | null;
        updated_at: string;
      }
    > = [];
    try {
      const appsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/apps?owner_id=eq.${profileUserId}&visibility=in.(public,unlisted)&deleted_at=is.null&order=updated_at.desc&select=id,name,slug,description,current_version,updated_at&limit=50`,
        { headers: dbHeaders },
      );
      if (appsRes.ok) {
        apps = await appsRes.json();
      }
    } catch { /* */ }

    // Fetch published pages
    let pages: Array<
      {
        slug: string;
        title: string | null;
        updated_at: string;
        tags: string[] | null;
      }
    > = [];
    try {
      const pagesRes = await fetch(
        `${SUPABASE_URL}/rest/v1/content?owner_id=eq.${profileUserId}&type=eq.page&visibility=eq.public&order=updated_at.desc&select=slug,title,updated_at,tags&limit=50`,
        { headers: dbHeaders },
      );
      if (pagesRes.ok) {
        pages = await pagesRes.json();
      }
    } catch { /* */ }

    // Fetch points summary
    let totalPoints = 0;
    try {
      const pointsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/points_ledger?user_id=eq.${profileUserId}&select=amount`,
        { headers: dbHeaders },
      );
      if (pointsRes.ok) {
        const points = await pointsRes.json() as Array<{ amount: number }>;
        totalPoints = points.reduce((sum, p) => sum + p.amount, 0);
      }
    } catch { /* */ }

    // Fetch fulfilled gaps
    let fulfilledGaps: Array<
      { gap_title: string; awarded_points: number; reviewed_at: string }
    > = [];
    try {
      const assessRes = await fetch(
        `${SUPABASE_URL}/rest/v1/gap_assessments?user_id=eq.${profileUserId}&status=eq.approved&select=awarded_points,reviewed_at,gap_id&order=reviewed_at.desc&limit=10`,
        { headers: dbHeaders },
      );
      if (assessRes.ok) {
        const assessments = await assessRes.json() as Array<
          { awarded_points: number; reviewed_at: string; gap_id: string }
        >;
        if (assessments.length > 0) {
          const gapIds = [...new Set(assessments.map((a) => a.gap_id))];
          const gapsRes = await fetch(
            `${SUPABASE_URL}/rest/v1/gaps?id=in.(${
              gapIds.join(",")
            })&select=id,title`,
            { headers: dbHeaders },
          );
          const gapsMap = new Map<string, string>();
          if (gapsRes.ok) {
            for (
              const g of await gapsRes.json() as Array<
                { id: string; title: string }
              >
            ) {
              gapsMap.set(g.id, g.title);
            }
          }
          fulfilledGaps = assessments.map((a) => ({
            gap_title: gapsMap.get(a.gap_id) || "Unknown gap",
            awarded_points: a.awarded_points,
            reviewed_at: a.reviewed_at,
          }));
        }
      }
    } catch { /* */ }

    const html = getPublicUserProfileHTML(
      user,
      apps,
      pages,
      baseUrl,
      profileUserId,
      totalPoints,
      fulfilledGaps,
    );
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    console.error("[PublicUserProfile] Error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}

function getPublicUserProfileHTML(
  user: { display_name: string | null; email: string; created_at: string },
  apps: Array<
    {
      id: string;
      name: string;
      slug: string;
      description: string | null;
      current_version: string | null;
      updated_at: string;
    }
  >,
  pages: Array<
    {
      slug: string;
      title: string | null;
      updated_at: string;
      tags: string[] | null;
    }
  >,
  baseUrl: string,
  userId: string,
  totalPoints = 0,
  fulfilledGaps: Array<
    { gap_title: string; awarded_points: number; reviewed_at: string }
  > = [],
): string {
  const displayName = escapeHtml(user.display_name || user.email.split("@")[0]);
  const memberSince = new Date(user.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });

  const appCards = apps.length > 0
    ? apps.map((a) => `
      <a href="/app/${escapeHtml(a.id)}" class="card">
        <div class="card-icon">&#9889;</div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(a.name || a.slug)}</div>
          ${
      a.description
        ? `<div class="card-desc">${escapeHtml(a.description)}</div>`
        : ""
    }
          <div class="card-meta">
            ${
      a.current_version
        ? `<span class="version-badge">v${escapeHtml(a.current_version)}</span>`
        : ""
    }
            <span class="card-date">${
      new Date(a.updated_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    }</span>
          </div>
        </div>
      </a>
    `).join("")
    : '<p class="empty-text">No public MCP servers yet.</p>';

  const pageCards = pages.length > 0
    ? pages.map((p) => `
      <a href="/p/${escapeHtml(userId)}/${escapeHtml(p.slug)}" class="card">
        <div class="card-icon">&#128196;</div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(p.title || p.slug)}</div>
          ${
      p.tags && p.tags.length > 0
        ? `<div class="card-tags">${
          p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(
            "",
          )
        }</div>`
        : ""
    }
          <div class="card-meta">
            <span class="card-date">${
      new Date(p.updated_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    }</span>
          </div>
        </div>
      </a>
    `).join("")
    : '<p class="empty-text">No published pages yet.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${displayName} — Galactic</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0a0a0f;
    color: #e4e4e7;
    padding: 2rem 1rem;
    min-height: 100vh;
  }
  .container { max-width: 760px; margin: 0 auto; }

  .profile-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .avatar {
    width: 64px; height: 64px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.75rem; font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }
  .profile-info h1 { font-size: 1.5rem; font-weight: 700; color: #fafafa; }
  .profile-info .profile-meta {
    color: #71717a;
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }

  .section { margin-bottom: 2rem; }
  .section-title {
    font-size: 0.75rem;
    color: #71717a;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.75rem;
  }

  .card {
    display: flex;
    gap: 0.875rem;
    padding: 1rem;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    margin-bottom: 0.625rem;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s, background 0.15s;
  }
  .card:hover { border-color: #3f3f46; background: #1c1c21; }
  .card-icon {
    font-size: 1.25rem;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }
  .card-body { flex: 1; min-width: 0; }
  .card-title { font-weight: 600; color: #fafafa; font-size: 0.95rem; }
  .card-desc {
    color: #a1a1aa;
    font-size: 0.8125rem;
    margin-top: 0.25rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.4rem;
    font-size: 0.75rem;
    color: #52525b;
  }
  .card-tags { margin-top: 0.3rem; }
  .tag {
    display: inline-block;
    background: rgba(139, 92, 246, 0.15);
    color: #a78bfa;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    font-size: 0.7rem;
    margin-right: 0.25rem;
  }
  .version-badge {
    background: rgba(139, 92, 246, 0.2);
    color: #a78bfa;
    padding: 0.1rem 0.4rem;
    border-radius: 9999px;
    font-size: 0.7rem;
    font-weight: 500;
  }
  .empty-text { color: #52525b; font-style: italic; font-size: 0.875rem; }
  .points-badge {
    display: inline-block;
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    padding: 0.15rem 0.6rem;
    border-radius: 9999px;
    font-size: 0.8rem;
    font-weight: 600;
    margin-top: 0.35rem;
  }
  .gap-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0;
    border-bottom: 1px solid #1e1e24;
    font-size: 0.8125rem;
  }
  .gap-row:last-child { border-bottom: none; }
  .gap-name { color: #fafafa; font-weight: 500; }
  .gap-pts { color: #f59e0b; font-weight: 600; font-size: 0.8rem; }
  .gap-date { color: #52525b; font-size: 0.75rem; }
  .footer-bar {
    text-align: center;
    padding-top: 1.5rem;
    font-size: 0.8rem;
    color: #52525b;
  }
  .footer-bar a { color: #71717a; text-decoration: none; }
  .footer-bar a:hover { color: #a1a1aa; }

  @media (max-width: 600px) {
    body { padding: 1rem 0.5rem; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="profile-header">
    <div class="avatar">${displayName.charAt(0).toUpperCase()}</div>
    <div class="profile-info">
      <h1>${displayName}</h1>
      <div class="profile-meta">Member since ${escapeHtml(memberSince)}</div>
      ${
    totalPoints > 0
      ? `<div class="points-badge">&#127942; ${totalPoints.toLocaleString()} points</div>`
      : ""
  }
    </div>
  </div>

  <div class="section">
    <div class="section-title">MCP Servers (${apps.length})</div>
    ${appCards}
  </div>

  <div class="section">
    <div class="section-title">Published Pages (${pages.length})</div>
    ${pageCards}
  </div>

  ${
    fulfilledGaps.length > 0
      ? `
  <div class="section">
    <div class="section-title">Fulfilled Gaps (${fulfilledGaps.length})</div>
    ${
        fulfilledGaps.map((g) => `
      <div class="gap-row">
        <span class="gap-name">${escapeHtml(g.gap_title)}</span>
        <span>
          <span class="gap-pts">${g.awarded_points} pts</span>
          <span class="gap-date">${
          new Date(g.reviewed_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        }</span>
        </span>
      </div>
    `).join("")
      }
  </div>`
      : ""
  }

  <div class="footer-bar">
    Powered by <a href="/">Galactic</a>
  </div>
</div>
</body>
</html>`;
}

// ============================================
// HOMEPAGE JSON API
// ============================================

async function handleHomepageApi(request: Request): Promise<Response> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "apps";
  const status = url.searchParams.get("status") || "open";
  const limitParam = Math.min(
    parseInt(url.searchParams.get("limit") || "10"),
    50,
  );

  try {
    // Return different data based on type parameter
    if (type === "gaps") {
      let query =
        `${SUPABASE_URL}/rest/v1/gaps?select=id,title,description,severity,points_value,season,status,created_at`;
      if (status !== "all") query += `&status=eq.${status}`;
      query += `&order=points_value.desc,created_at.desc&limit=${limitParam}`;
      const res = await fetch(query, { headers });
      const gaps = res.ok
        ? await res.json() as Array<{
          id: string;
          title: string;
          description: string | null;
          severity: string | null;
          points_value: number;
          season: string | number | null;
          status: string;
          created_at: string;
        }>
        : [];
      return json({ results: gaps, total: gaps.length });
    }

    if (type === "leaderboard") {
      // Get active season
      let season: { id: number; name: string } | null = null;
      try {
        const sRes = await fetch(
          `${SUPABASE_URL}/rest/v1/seasons?active=eq.true&select=id,name&limit=1`,
          { headers },
        );
        if (sRes.ok) {
          const seasons = await sRes.json() as Array<
            { id: number; name: string }
          >;
          season = seasons[0] || null;
        }
      } catch {}

      // Aggregate points
      let pointsQuery =
        `${SUPABASE_URL}/rest/v1/points_ledger?select=user_id,amount`;
      if (season) pointsQuery += `&season=eq.${season.id}`;
      pointsQuery += `&order=created_at.desc&limit=1000`;
      const pRes = await fetch(pointsQuery, { headers });
      const points = pRes.ok
        ? (await pRes.json() as Array<{ user_id: string; amount: number }>)
        : [];
      const totals = new Map<string, number>();
      for (const p of points) {
        totals.set(p.user_id, (totals.get(p.user_id) || 0) + p.amount);
      }
      const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(
        0,
        limitParam,
      );

      let entries: Array<
        { user_id: string; display_name: string; total_points: number }
      > = [];
      if (sorted.length > 0) {
        const uids = sorted.map((s) => s[0]);
        const uRes = await fetch(
          `${SUPABASE_URL}/rest/v1/users?id=in.(${
            uids.join(",")
          })&select=id,display_name,email`,
          { headers },
        );
        const uMap = new Map<string, string>();
        if (uRes.ok) {
          for (
            const u of await uRes.json() as Array<
              { id: string; display_name: string | null; email: string }
            >
          ) {
            uMap.set(u.id, u.display_name || u.email.split("@")[0]);
          }
        }
        entries = sorted.map(([uid, pts]) => ({
          user_id: uid,
          display_name: uMap.get(uid) || "Anonymous",
          total_points: pts,
        }));
      }
      return json({ results: entries, season, total: entries.length });
    }

    // Default: top apps
    const appsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/apps?visibility=eq.public&deleted_at=is.null&hosting_suspended=eq.false` +
        `&select=id,name,slug,description,weighted_likes,runs_30d` +
        `&order=weighted_likes.desc,runs_30d.desc&limit=${limitParam}`,
      { headers },
    );
    const apps = appsRes.ok
      ? await appsRes.json() as Array<{
        id: string;
        name: string | null;
        slug: string;
        description: string | null;
        weighted_likes: number | null;
        runs_30d: number | null;
      }>
      : [];
    return json({ results: apps, total: apps.length });
  } catch (err) {
    console.error("[HOMEPAGE API]", err);
    return json({ results: [], total: 0 });
  }
}

// ============================================
// PUBLISHED MARKDOWN PAGES
// ============================================

function handleSharedPageEntry(path: string): Response {
  const parts = path.slice("/share/p/".length).split("/");
  if (parts.length < 2) {
    return new Response("Not found", { status: 404 });
  }

  const ownerId = parts[0];
  let slug = parts.slice(1).join("/");
  if (slug.endsWith(".md")) slug = slug.slice(0, -3);

  const pagePath = `/p/${ownerId}/${slug}`;
  const config = JSON.stringify({
    ownerId,
    slug,
    pagePath,
    signInPath: `/auth/login?return_to=${encodeURIComponent(pagePath)}`,
  }).replace(/</g, "\\u003c");

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Opening Shared Page...</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f5f7fb; color: #101828; font-family: system-ui, -apple-system, sans-serif; }
    .card { width: min(92vw, 560px); background: #fff; border: 1px solid #e4e7ec; border-radius: 24px; padding: 32px; box-shadow: 0 24px 60px rgba(16, 24, 40, 0.08); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 0; line-height: 1.6; color: #475467; }
    .spinner { width: 40px; height: 40px; border-radius: 999px; border: 3px solid #d0d5dd; border-top-color: #101828; animation: spin 1s linear infinite; margin-bottom: 20px; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border-radius: 999px; text-decoration: none; font-weight: 600; }
    .button.primary { background: #101828; color: #fff; }
    .button.secondary { background: #f2f4f7; color: #101828; }
    .help { margin-top: 18px; font-size: 14px; color: #667085; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main class="card">
    <div id="spinner" class="spinner" aria-hidden="true"></div>
    <h1>Opening shared page</h1>
    <p id="status">Authorizing your secure share link...</p>
    <div id="help" class="help" hidden>
      This page can still open if it was shared directly with your account.
    </div>
    <div id="actions" class="actions" hidden>
      <a id="signin-link" class="button primary" href="/">Sign in</a>
      <a id="page-link" class="button secondary" href="/">Open page directly</a>
    </div>
  </main>
  <script>
    const config = ${config};
    const spinnerEl = document.getElementById('spinner');
    const statusEl = document.getElementById('status');
    const helpEl = document.getElementById('help');
    const actionsEl = document.getElementById('actions');
    const signInLinkEl = document.getElementById('signin-link');
    const pageLinkEl = document.getElementById('page-link');
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const shareToken = hashParams.get('share_token');

    signInLinkEl.href = config.signInPath;
    pageLinkEl.href = config.pagePath;

    function showFallback(message) {
      statusEl.textContent = message;
      spinnerEl.hidden = true;
      helpEl.hidden = false;
      actionsEl.hidden = false;
    }

    async function bootstrapShareSession(token) {
      history.replaceState(null, '', window.location.pathname);
      const response = await fetch('/auth/page-share/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          owner_id: config.ownerId,
          slug: config.slug,
          share_token: token,
        }),
      });

      if (!response.ok) {
        throw new Error('page_share_exchange_failed');
      }

      window.location.replace(config.pagePath);
    }

    if (shareToken) {
      bootstrapShareSession(shareToken).catch(() => {
        showFallback('We could not authorize this share link. It may have expired or been revoked.');
      });
    } else {
      showFallback('This shared page needs its secure share token or a signed-in recipient session.');
    }
  </script>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

async function handlePublishedPage(
  request: Request,
  path: string,
): Promise<Response> {
  // Parse /p/{userId}/{slug} or /p/{userId}/{slug}.md
  const parts = path.slice(3).split("/"); // Remove '/p/'
  if (parts.length < 2) {
    return new Response("Not found", { status: 404 });
  }
  const userId = parts[0];
  let slug = parts.slice(1).join("/");
  // Strip .md extension if present in URL
  if (slug.endsWith(".md")) slug = slug.slice(0, -3);

  // Check content table for visibility/access control
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const dbHeaders = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  interface PublishedContentRow {
    id: string;
    visibility: "private" | "shared" | "public" | string;
    access_token: string | null;
    title: string | null;
    tags: string[] | null;
    updated_at: string | null;
    hosting_suspended: boolean | null;
    price_light: number | null;
  }

  let contentRow: PublishedContentRow | null = null;
  try {
    const contentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/content?owner_id=eq.${userId}&type=eq.page&slug=eq.${
        encodeURIComponent(slug)
      }&select=id,visibility,access_token,title,tags,updated_at,hosting_suspended,price_light&limit=1`,
      { headers: dbHeaders },
    );
    if (contentRes.ok) {
      const rows = await contentRes.json() as PublishedContentRow[];
      contentRow = rows.length > 0 ? rows[0] : null;
    }
  } catch { /* if DB fails, fall through to public serving */ }

  // If content row exists, enforce access control
  if (contentRow) {
    // Check hosting suspension before access control
    if (contentRow.hosting_suspended) {
      return new Response(
        `<!DOCTYPE html><html><head><title>Page Suspended</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa}div{text-align:center;max-width:480px;padding:2rem}.icon{font-size:3rem;margin-bottom:1rem}h1{margin:0 0 .5rem;font-size:1.5rem}p{color:#666;line-height:1.6}</style></head><body><div><div class="icon">&#9888;</div><h1>Page Suspended</h1><p>This page has been taken offline because the owner's credits balance has been depleted. The owner can restore it by adding credits.</p></div></body></html>`,
        { status: 402, headers: { "Content-Type": "text/html" } },
      );
    }
    // Check paid page access: if price_light > 0, charge the viewer
    if (contentRow.price_light && contentRow.price_light > 0) {
      let viewerUserId: string | null = null;
      try {
        const { authenticate } = await import("./auth.ts");
        const viewer = await authenticate(request);
        viewerUserId = viewer.id;
      } catch {
        // Not authenticated — show a paywall message
        return new Response(
          `<!DOCTYPE html><html><head><title>Paid Content</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa}div{text-align:center;max-width:480px;padding:2rem}.icon{font-size:3rem;margin-bottom:1rem}h1{margin:0 0 .5rem;font-size:1.5rem}p{color:#666;line-height:1.6}.price{font-size:1.25rem;font-weight:600;color:#333;margin:1rem 0}</style></head><body><div><div class="icon">&#128176;</div><h1>Paid Page</h1><p class="price">${formatDollarsFromLight(contentRow.price_light)} per view</p><p>Sign in and have enough credits to view this page. The fee is transferred directly to the page owner.</p></div></body></html>`,
          { status: 402, headers: { "Content-Type": "text/html" } },
        );
      }

      // Don't charge the owner for viewing their own page
      if (viewerUserId !== userId) {
        try {
          const transferRes = await fetch(
            `${SUPABASE_URL}/rest/v1/rpc/transfer_light`,
            {
              method: "POST",
              headers: { ...dbHeaders, "Content-Type": "application/json" },
              body: JSON.stringify({
                p_from_user: viewerUserId,
                p_to_user: userId,
                p_amount_light: contentRow.price_light,
                p_reason: "page_view",
                p_content_id: contentRow.id,
                p_idempotency_key: request.headers.get("Idempotency-Key") ||
                  request.headers.get("X-Idempotency-Key") ||
                  null,
                p_metadata: {
                  content_slug: slug,
                  content_type: "page",
                },
              }),
            },
          );

          if (transferRes.ok) {
            const rows = await transferRes.json() as Array<
              { from_new_balance: number }
            >;
            if (!rows || rows.length === 0) {
              // Insufficient balance
              return new Response(
                `<!DOCTYPE html><html><head><title>Insufficient Balance</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa}div{text-align:center;max-width:480px;padding:2rem}.icon{font-size:3rem;margin-bottom:1rem}h1{margin:0 0 .5rem;font-size:1.5rem}p{color:#666;line-height:1.6}.price{font-size:1.25rem;font-weight:600;color:#333;margin:1rem 0}</style></head><body><div><div class="icon">&#9888;</div><h1>Insufficient Balance</h1><p class="price">This page costs ${formatDollarsFromLight(contentRow.price_light)}</p><p>Add credits from Wallet to view this page.</p></div></body></html>`,
                { status: 402, headers: { "Content-Type": "text/html" } },
              );
            }
          }
          // If transfer RPC fails, serve the page anyway (fail-open for reads)
        } catch {
          // Transfer failed — serve the page anyway
        }
      }
    }

    if (contentRow.visibility === "private") {
      // Only the owner can view private pages
      try {
        const { authenticate } = await import("./auth.ts");
        const user = await authenticate(request);
        if (user.id !== userId) {
          return new Response("Not found", { status: 404 });
        }
      } catch {
        return new Response("Not found", { status: 404 });
      }
    } else if (contentRow.visibility === "shared") {
      let authorized = await hasValidPageShareSession(request, {
        contentId: contentRow.id,
        ownerId: userId,
        slug,
        accessToken: contentRow.access_token,
      });

      // Check if authenticated user has a share
      if (!authorized) {
        try {
          const { authenticate } = await import("./auth.ts");
          const user = await authenticate(request);

          // Owner always has access
          if (user.id === userId) {
            authorized = true;
          } else {
            // Check content_shares for this user
            const sharesRes = await fetch(
              `${SUPABASE_URL}/rest/v1/content_shares?content_id=eq.${contentRow.id}&or=(shared_with_user_id.eq.${user.id},shared_with_email.eq.${
                encodeURIComponent(user.email)
              })&select=id&limit=1`,
              { headers: dbHeaders },
            );
            if (sharesRes.ok) {
              const shares = await sharesRes.json() as Array<{ id: string }>;
              if (shares.length > 0) authorized = true;
            }
          }
        } catch {
          // Not authenticated and no valid token
        }
      }

      if (!authorized) {
        return new Response("Not found", { status: 404 });
      }
    }
    // visibility === 'public' falls through to serve normally
  }
  // No content row = backward compat, serve as public

  const r2Service = createR2Service();
  let content: string;
  try {
    content = await r2Service.fetchTextFile(`users/${userId}/pages/${slug}.md`);
  } catch {
    return new Response("Page not found", { status: 404 });
  }

  const pageUrl = new URL(request.url);
  const cacheControl =
    contentRow?.visibility === "private" || contentRow?.visibility === "shared"
      ? "private, no-cache"
      : "public, max-age=60";

  // Raw markdown API — agents can fetch ?format=raw for programmatic access
  if (pageUrl.searchParams.get("format") === "raw") {
    return new Response(content, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": cacheControl,
      },
    });
  }

  // Parse front-matter style title from first H1, or use slug
  let title = contentRow?.title || slug;
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match && !contentRow?.title) title = h1Match[1];

  // Fetch owner display name for the header
  let authorName: string | undefined;
  try {
    const userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=display_name,email&limit=1`,
      { headers: dbHeaders },
    );
    if (userRes.ok) {
      const users = await userRes.json() as Array<
        { display_name: string | null; email: string }
      >;
      if (users.length > 0) {
        authorName = users[0].display_name || users[0].email.split("@")[0];
      }
    }
  } catch { /* best effort */ }

  const rawUrl = `${pageUrl.pathname}?format=raw`;
  const html = renderMarkdownPage(title, content, {
    authorName,
    authorId: userId,
    updatedAt: contentRow?.updated_at || undefined,
    tags: contentRow?.tags || undefined,
    rawUrl,
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Defense-in-depth for user/developer-authored markdown rendered here.
      // This page ships no inline scripts, so a strict CSP does not break it.
      "Content-Security-Policy": PUBLIC_MARKDOWN_CSP,
      "Cache-Control": cacheControl,
    },
  });
}

/**
 * Get the public base URL of the server, respecting reverse proxy headers.
 */
function getBaseUrl(request: Request): string {
  // Prefer a fixed, operator-configured BASE_URL so generated absolute URLs
  // cannot be pointed at an attacker-controlled host via a spoofed
  // X-Forwarded-Host header.
  const configured = getEnv("BASE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(request.url);
  // Fall back to the Host header only (never the client-spoofable
  // X-Forwarded-Host).
  const host = request.headers.get("host") || url.host;
  const proto = request.headers.get("x-forwarded-proto") ||
    (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function getClientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
}

async function hashHeaderValue(value: string | null): Promise<string | null> {
  if (!value) return null;
  return await sha256Hex(value);
}

function sanitizeReferralClaimQuery(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

async function getOptionalReferralUserId(
  request: Request,
): Promise<string | null> {
  try {
    const user = await authenticate(request);
    return user.id;
  } catch {
    return null;
  }
}

async function handleReferralLanding(
  request: Request,
  slug: string,
): Promise<Response> {
  // Social crawlers must NOT record a landing — recordReferralLanding mints
  // attribution and, for known users, a fee-waiver grant. Serve a no-side-effect
  // OG preview to bots so the share card renders without phantom attributions.
  if (BOT_UA_PATTERN.test(request.headers.get("user-agent") || "")) {
    return handleReferralBotPreview(request, slug);
  }

  const visitorId = getCookieValueFromRequest(
    request,
    REFERRAL_VISITOR_COOKIE_NAME,
  );
  const userId = await getOptionalReferralUserId(request);
  const landing = await recordReferralLanding({
    slug,
    anonymousVisitorId: visitorId,
    userId,
    metadata: {
      ipHash: await hashHeaderValue(getClientIp(request)),
      userAgentHash: await hashHeaderValue(request.headers.get("user-agent")),
      landingUrl: request.url,
      referrerUrl: request.headers.get("referer"),
    },
  });

  if (landing.status === "not_found") {
    return new Response("Referral link not found", { status: 404 });
  }

  let claimToken: string | null = null;
  if (!userId && landing.landingId && landing.visitorId) {
    claimToken = await createReferralClaimToken({
      landingId: landing.landingId,
      visitorId: landing.visitorId,
    });
  }

  const redirectUrl = new URL(
    landing.appId ? `/app/${encodeURIComponent(landing.appId)}` : "/",
    request.url,
  );
  if (claimToken) {
    redirectUrl.searchParams.set("ref_claim", claimToken);
  }
  const headers = new Headers({
    "Location": redirectUrl.pathname + redirectUrl.search,
    "Cache-Control": "no-store",
  });

  if (landing.visitorId) {
    appendCookie(headers, REFERRAL_VISITOR_COOKIE_NAME, landing.visitorId, {
      maxAge: REFERRAL_VISITOR_COOKIE_MAX_AGE_SECONDS,
      httpOnly: true,
    });
  }

  return new Response(null, { status: 302, headers });
}

/**
 * Social-crawler preview for a referral link — GET /r/:slug with a bot UA.
 * Renders the target agent's OG card WITHOUT recording a landing (no
 * attribution, no fee-waiver grant). Public agents only; non-public agents (or
 * an unknown slug handled above) get a plain redirect with no card. A
 * meta-refresh sends any human-ish client on to the agent page.
 */
async function handleReferralBotPreview(
  request: Request,
  slug: string,
): Promise<Response> {
  const link = await fetchActiveReferralLinkBySlug(slug);
  if (!link) {
    return new Response("Referral link not found", { status: 404 });
  }
  const appPath = `/app/${encodeURIComponent(link.app_id)}`;

  const app = await createAppsService().findPublicServingById(link.app_id);
  if (!app || app.visibility !== "public") {
    return new Response(null, {
      status: 302,
      headers: { "Location": appPath, "Cache-Control": "no-store" },
    });
  }

  const baseUrl = getBaseUrl(request);
  const name = app.name || app.slug || "Agent";
  const title = `${name}: Galactic Agent`;
  const rawDesc = app.description || `${name} on Galactic`;
  const desc = rawDesc.length > 200 ? rawDesc.slice(0, 199) + "…" : rawDesc;
  const appUrl = `${baseUrl}${appPath}`;

  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  const img = escapeHtml(`${baseUrl}/og/${encodeURIComponent(link.app_id)}.png`);
  const refUrl = escapeHtml(`${baseUrl}/r/${encodeURIComponent(slug)}`);
  const goto = escapeHtml(appUrl);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Galactic">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${refUrl}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0; url=${goto}">
</head>
<body>
<p>Redirecting to <a href="${goto}">${t}</a> on Galactic…</p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

// CSP for public pages that render developer/user-controlled markdown
// (the published markdown page). No inline scripts run on that page, so this
// strict policy is safe. Applied per-response rather than globally because
// other endpoints (the app-store app page, launch-web, sandbox, interface,
// contract dashboard) legitimately serve inline scripts and external fonts.
const PUBLIC_MARKDOWN_CSP =
  "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Allowlist the scheme of a markdown link target. Permits http(s), mailto,
 * root-relative and relative paths, and same-page anchors. Rejects
 * javascript:/data:/vbscript: and any other scheme so developer-controlled
 * markdown cannot inject active-content URIs into public HTML.
 *
 * NOTE: the caller has already run the full markdown body through escapeHtml,
 * so `&` appears as `&amp;`, `<`/`>` are gone, and quotes are entity-encoded.
 * A raw leading-scheme match on the escaped string is therefore sufficient and
 * cannot be defeated by quote/angle-bracket breakout.
 */
export function isSafeMarkdownLinkUrl(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (!url) return false;
  // Same-page anchors and relative/root-relative paths (no scheme).
  if (url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return true;
  }
  // Reject control chars (incl. tab/newline that browsers strip from schemes,
  // e.g. "java\tscript:") which could be used to smuggle a blocked scheme.
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f]/.test(url)) return false;
  // If there is a scheme, it must be in the allowlist. A leading token of
  // scheme chars followed by ':' denotes an absolute URL scheme.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    return scheme === "http" || scheme === "https" || scheme === "mailto";
  }
  // No scheme and not an anchor/relative prefix: treat as a relative reference
  // (e.g. "foo/bar"). Safe — cannot introduce an active-content scheme.
  return true;
}

/**
 * Convert markdown text to HTML using simple regex-based conversion (no external deps).
 * Extracted for reuse across published pages, app pages, etc.
 */
function markdownToHtml(markdown: string): string {
  let html = escapeHtml(markdown);

  // Code blocks (``` ... ```) — must be before inline code
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, lang, code) =>
      `<pre><code class="language-${lang}">${code.trim()}</code></pre>`,
  );
  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");
  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Links — allowlist the scheme so a developer-controlled markdown link
  // cannot smuggle javascript:/data:/vbscript: into an href. Only http(s),
  // mailto, relative paths, and same-page anchors are permitted; anything
  // else is rendered as inert text. (The whole input was already run through
  // escapeHtml above, so $2 cannot contain raw quotes/angle brackets.)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text, rawUrl) =>
      isSafeMarkdownLinkUrl(rawUrl)
        ? `<a href="${rawUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text,
  );
  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr>");
  // Unordered lists
  html = html.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // Ordered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");
  // Blockquotes
  html = html.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");
  // Paragraphs (double newlines)
  html = html.replace(/\n\n+/g, "</p><p>");
  html = `<p>${html}</p>`;
  // Clean up empty paragraphs around block elements
  html = html.replace(/<p>\s*(<h[1-6]|<pre|<ul|<ol|<hr|<blockquote)/g, "$1");
  html = html.replace(
    /(<\/h[1-6]>|<\/pre>|<\/ul>|<\/ol>|<hr>|<\/blockquote>)\s*<\/p>/g,
    "$1",
  );

  return html;
}

/**
 * Render markdown content as a clean, readable HTML page.
 * Uses simple regex-based markdown→HTML (no external deps).
 */
function renderMarkdownPage(
  title: string,
  markdown: string,
  meta?: {
    authorName?: string;
    authorId?: string;
    updatedAt?: string;
    tags?: string[];
    rawUrl?: string;
  },
): string {
  const html = markdownToHtml(markdown);

  const metaHeader = meta
    ? `
    <div class="page-meta">
      ${
      meta.authorName
        ? `<span class="meta-author">by <a href="/u/${
          escapeHtml(meta.authorId || "")
        }">${escapeHtml(meta.authorName)}</a></span>`
        : ""
    }
      ${
      meta.updatedAt
        ? `<span class="meta-date">${
          new Date(meta.updatedAt).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        }</span>`
        : ""
    }
      ${
      meta.tags && meta.tags.length > 0
        ? `<span class="meta-tags">${
          meta.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
            .join("")
        }</span>`
        : ""
    }
      ${
      meta.rawUrl
        ? `<a href="${escapeHtml(meta.rawUrl)}" class="meta-raw">View Raw</a>`
        : ""
    }
    </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Galactic</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.7;
    color: #1a1a2e;
    background: #fafafa;
    padding: 2rem 1rem;
  }
  article {
    max-width: 720px;
    margin: 0 auto;
    background: #fff;
    padding: 3rem;
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  h1 { font-size: 2rem; margin-bottom: 1rem; color: #0f0f23; }
  h2 { font-size: 1.5rem; margin: 2rem 0 0.75rem; color: #16213e; border-bottom: 1px solid #eee; padding-bottom: 0.3rem; }
  h3 { font-size: 1.25rem; margin: 1.5rem 0 0.5rem; color: #1a1a2e; }
  h4, h5, h6 { margin: 1.25rem 0 0.5rem; }
  p { margin: 0.75rem 0; }
  a { color: #4361ee; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.9em;
    background: #f0f0f5;
    padding: 0.15em 0.4em;
    border-radius: 4px;
  }
  pre {
    margin: 1rem 0;
    padding: 1rem;
    background: #1a1a2e;
    color: #e0e0e0;
    border-radius: 8px;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; color: inherit; font-size: 0.85em; }
  ul, ol { margin: 0.75rem 0; padding-left: 1.5rem; }
  li { margin: 0.25rem 0; }
  blockquote {
    margin: 1rem 0;
    padding: 0.75rem 1rem;
    border-left: 3px solid #4361ee;
    background: #f8f9ff;
    color: #444;
  }
  hr { margin: 2rem 0; border: none; border-top: 1px solid #eee; }
  .page-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid #eee;
    font-size: 0.875rem;
    color: #666;
  }
  .page-meta a { color: #4361ee; }
  .meta-date::before { content: "\\00b7"; margin-right: 0; }
  .tag {
    display: inline-block;
    background: #f0f0f5;
    padding: 0.15em 0.5em;
    border-radius: 4px;
    font-size: 0.8rem;
    color: #555;
    margin-right: 0.25rem;
  }
  .meta-raw {
    margin-left: auto;
    font-size: 0.8rem;
    color: #999 !important;
    text-decoration: none;
    border: 1px solid #ddd;
    padding: 0.2em 0.6em;
    border-radius: 4px;
  }
  .meta-raw:hover { background: #f0f0f5; text-decoration: none; }
  .footer {
    text-align: center;
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid #eee;
    font-size: 0.8rem;
    color: #999;
  }
  .footer a { color: #999; }
  @media (max-width: 600px) {
    body { padding: 1rem 0.5rem; }
    article { padding: 1.5rem; }
  }
</style>
</head>
<body>
<article>
${metaHeader}
${html}
<div class="footer">Published with <a href="https://connectgalactic.com">Galactic</a></div>
</article>
</body>
</html>`;
}

// Escape for safe interpolation into HTML text AND double/single-quoted
// attributes. Quotes MUST be escaped — agent name/description are arbitrary
// user free text and are injected into content="..." OG/meta attributes, so
// missing quote-escaping is an attribute-breakout (stored XSS) vector.
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================
// DOWNLOAD PAGE
// ============================================

const DESKTOP_VERSION = "0.1.0";
const DESKTOP_DMG_URL =
  "https://github.com/evrydayimruslin/ultralight/releases/download/v0.1.0/Galactic_0.1.0_x64.dmg";

function getDownloadPageHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Download Galactic</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, system-ui, sans-serif;
      background: #fff;
      color: #111;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      max-width: 640px;
      width: 100%;
      padding: 80px 24px 60px;
      text-align: center;
    }
    .logo {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 12px;
    }
    .tagline {
      font-size: 17px;
      color: #666;
      margin-bottom: 48px;
      line-height: 1.5;
    }
    .download-card {
      border: 1px solid #e5e5e5;
      border-radius: 12px;
      padding: 40px 32px;
      margin-bottom: 32px;
    }
    .platform-label {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #999;
      margin-bottom: 16px;
    }
    .download-btn {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: #111;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 14px 32px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s;
    }
    .download-btn:hover { background: #333; }
    .download-btn svg { width: 20px; height: 20px; }
    .meta {
      margin-top: 16px;
      font-size: 13px;
      color: #999;
    }
    .meta span { margin: 0 8px; }
    .features {
      text-align: left;
      margin-top: 48px;
    }
    .features h3 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #111;
    }
    .feature-list {
      list-style: none;
      padding: 0;
    }
    .feature-list li {
      padding: 10px 0;
      border-bottom: 1px solid #f0f0f0;
      font-size: 14px;
      color: #444;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .feature-list li::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #111;
      flex-shrink: 0;
    }
    .footer-note {
      margin-top: 48px;
      font-size: 13px;
      color: #999;
      line-height: 1.6;
    }
    .footer-note a { color: #111; text-decoration: underline; }
    .back-link {
      position: fixed;
      top: 24px;
      left: 24px;
      font-size: 14px;
      color: #666;
      text-decoration: none;
    }
    .back-link:hover { color: #111; }
  </style>
</head>
<body>
  <a href="/" class="back-link">&larr; Back</a>
  <div class="container">
    <div class="logo">Galactic</div>
    <p class="tagline">
      Desktop agent manager. Connect MCP servers, run AI agents,<br>
      and manage approval workflows — all from your desktop.
    </p>

    <div class="download-card">
      <div class="platform-label">macOS</div>
      <a href="${DESKTOP_DMG_URL}" class="download-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
        Download for Mac
      </a>
      <div class="meta">
        Version ${DESKTOP_VERSION}<span>&middot;</span>macOS 12+<span>&middot;</span>Intel & Apple Silicon
      </div>
    </div>

    <div class="features">
      <h3>What you get</h3>
      <ul class="feature-list">
        <li>Create and manage AI agents with connected MCP tools</li>
        <li>Activity inbox with widget-based approval workflows</li>
        <li>Project-based agent organization with kanban boards</li>
        <li>Runs with BYOK or credits-billed platform inference</li>
        <li>Full access to the Galactic app ecosystem</li>
      </ul>
    </div>

    <p class="footer-note">
      After installing, sign in with your API token from <a href="/settings/tokens">Settings</a>.<br>
      Don't have an account? <a href="/">Create one free</a> on the web first.
    </p>
  </div>
</body>
</html>`;
}
