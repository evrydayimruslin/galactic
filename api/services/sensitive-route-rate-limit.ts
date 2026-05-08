import { checkRateLimit, type RateLimitResult } from "./ratelimit.ts";

export type SensitiveRoute =
  | "user:hosting_auto_topup_update"
  | "user:hosting_checkout"
  | "user:wallet_express_checkout"
  | "user:wallet_wire_transfer"
  | "user:earnings_convert"
  | "user:earnings_auto_add"
  | "user:billing_address_update"
  | "user:connect_onboard"
  | "user:connect_withdraw"
  | "user:marketplace_bid"
  | "user:marketplace_ask"
  | "user:marketplace_accept"
  | "user:marketplace_reject"
  | "user:marketplace_cancel"
  | "user:marketplace_buy"
  | "user:marketplace_metrics_visibility"
  | "user:byok_create"
  | "user:byok_update"
  | "user:byok_delete"
  | "user:byok_primary"
  | "user:token_create"
  | "user:token_delete"
  | "user:token_delete_all"
  | "user:supabase_create"
  | "user:supabase_delete"
  | "user:supabase_oauth_authorize"
  | "user:supabase_oauth_callback"
  | "user:supabase_oauth_connect"
  | "user:supabase_oauth_disconnect"
  | "developer:app_create"
  | "developer:app_update"
  | "developer:app_delete"
  | "developer:app_rotate_secret"
  | "config:mcp_config"
  | "apps:update_app"
  | "apps:user_settings_update"
  | "apps:env_set"
  | "apps:env_update"
  | "apps:env_delete"
  | "apps:supabase_set"
  | "apps:supabase_delete"
  | "upload:create"
  | "upload:draft"
  | "admin:gaps_create"
  | "admin:gaps_update"
  | "admin:assess"
  | "admin:approve"
  | "admin:reject"
  | "admin:balance_topup"
  | "admin:billing_config_update"
  | "admin:cleanup_provisionals"
  | "admin:app_category"
  | "admin:app_featured"
  | "admin:payout_process";

interface SensitiveRoutePolicy {
  endpoint: string;
  limit: number;
  windowMinutes: number;
  resource: string;
  limitMessage: string;
  unavailableMessage: string;
}

export const SENSITIVE_ROUTE_RATE_LIMITS: Record<
  SensitiveRoute,
  SensitiveRoutePolicy
> = {
  "user:hosting_auto_topup_update": {
    endpoint: "user:hosting_auto_topup_update",
    limit: 20,
    windowMinutes: 10,
    resource: "PATCH /api/user/hosting/auto-topup",
    limitMessage:
      "Too many auto top-up update attempts. Please wait and try again.",
    unavailableMessage:
      "Auto top-up updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:hosting_checkout": {
    endpoint: "user:hosting_checkout",
    limit: 10,
    windowMinutes: 10,
    resource: "POST /api/user/hosting/checkout",
    limitMessage:
      "Too many hosting checkout attempts. Please wait and try again.",
    unavailableMessage:
      "Hosting checkout is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:wallet_express_checkout": {
    endpoint: "user:wallet_express_checkout",
    limit: 10,
    windowMinutes: 10,
    resource: "POST /api/user/wallet/express-checkout-intent",
    limitMessage:
      "Too many wallet funding attempts. Please wait and try again.",
    unavailableMessage:
      "Wallet funding is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:wallet_wire_transfer": {
    endpoint: "user:wallet_wire_transfer",
    limit: 10,
    windowMinutes: 10,
    resource: "POST /api/user/wallet/wire-transfer-intent",
    limitMessage: "Too many wire funding attempts. Please wait and try again.",
    unavailableMessage:
      "Wire funding is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:earnings_convert": {
    endpoint: "user:earnings_convert",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/user/earnings/convert-to-balance",
    limitMessage:
      "Too many earnings conversion attempts. Please wait and try again.",
    unavailableMessage:
      "Earnings conversion is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:earnings_auto_add": {
    endpoint: "user:earnings_auto_add",
    limit: 20,
    windowMinutes: 10,
    resource: "PATCH /api/user/earnings/auto-add",
    limitMessage:
      "Too many earnings auto-add updates. Please wait and try again.",
    unavailableMessage:
      "Earnings auto-add updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:billing_address_update": {
    endpoint: "user:billing_address_update",
    limit: 20,
    windowMinutes: 10,
    resource: "PUT /api/user/billing-address",
    limitMessage:
      "Too many billing address updates. Please wait and try again.",
    unavailableMessage:
      "Billing address updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:connect_onboard": {
    endpoint: "user:connect_onboard",
    limit: 10,
    windowMinutes: 10,
    resource: "POST /api/user/connect/onboard",
    limitMessage:
      "Too many Stripe Connect onboarding attempts. Please wait and try again.",
    unavailableMessage:
      "Stripe Connect onboarding is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:connect_withdraw": {
    endpoint: "user:connect_withdraw",
    limit: 10,
    windowMinutes: 60,
    resource: "POST /api/user/connect/withdraw",
    limitMessage: "Too many withdrawal attempts. Please wait and try again.",
    unavailableMessage:
      "Withdrawals are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:marketplace_bid": {
    endpoint: "user:marketplace_bid",
    limit: 30,
    windowMinutes: 10,
    resource: "POST /api/marketplace/bid",
    limitMessage: "Too many bid attempts. Please wait and try again.",
    unavailableMessage:
      "Bid placement is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:marketplace_ask": {
    endpoint: "user:marketplace_ask",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/marketplace/ask",
    limitMessage: "Too many listing price updates. Please wait and try again.",
    unavailableMessage:
      "Listing price updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:marketplace_accept": {
    endpoint: "user:marketplace_accept",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/marketplace/accept",
    limitMessage:
      "Too many bid acceptance attempts. Please wait and try again.",
    unavailableMessage:
      "Bid acceptance is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:marketplace_reject": {
    endpoint: "user:marketplace_reject",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/marketplace/reject",
    limitMessage: "Too many bid rejection attempts. Please wait and try again.",
    unavailableMessage:
      "Bid rejection is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:marketplace_cancel": {
    endpoint: "user:marketplace_cancel",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/marketplace/cancel",
    limitMessage:
      "Too many bid cancellation attempts. Please wait and try again.",
    unavailableMessage:
      "Bid cancellation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:marketplace_buy": {
    endpoint: "user:marketplace_buy",
    limit: 10,
    windowMinutes: 10,
    resource: "POST /api/marketplace/acquire",
    limitMessage:
      "Too many instant acquisition attempts. Please wait and try again.",
    unavailableMessage:
      "Instant acquisition is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:marketplace_metrics_visibility": {
    endpoint: "user:marketplace_metrics_visibility",
    limit: 20,
    windowMinutes: 10,
    resource: "PATCH /api/marketplace/metrics-visibility",
    limitMessage:
      "Too many marketplace visibility updates. Please wait and try again.",
    unavailableMessage:
      "Marketplace visibility updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:byok_create": {
    endpoint: "user:byok_create",
    limit: 10,
    windowMinutes: 10,
    resource: "POST /api/user/byok",
    limitMessage: "Too many BYOK setup attempts. Please wait and try again.",
    unavailableMessage:
      "BYOK setup is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:byok_update": {
    endpoint: "user:byok_update",
    limit: 20,
    windowMinutes: 10,
    resource: "PATCH /api/user/byok/:provider",
    limitMessage: "Too many BYOK update attempts. Please wait and try again.",
    unavailableMessage:
      "BYOK updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:byok_delete": {
    endpoint: "user:byok_delete",
    limit: 20,
    windowMinutes: 10,
    resource: "DELETE /api/user/byok/:provider",
    limitMessage: "Too many BYOK removal attempts. Please wait and try again.",
    unavailableMessage:
      "BYOK removal is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:byok_primary": {
    endpoint: "user:byok_primary",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/user/byok/primary",
    limitMessage:
      "Too many BYOK primary-provider changes. Please wait and try again.",
    unavailableMessage:
      "Primary provider changes are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:token_create": {
    endpoint: "user:token_create",
    limit: 20,
    windowMinutes: 60,
    resource: "POST /api/user/tokens",
    limitMessage:
      "Too many token creation attempts. Please wait and try again.",
    unavailableMessage:
      "Token creation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:token_delete": {
    endpoint: "user:token_delete",
    limit: 30,
    windowMinutes: 10,
    resource: "DELETE /api/user/tokens/:id",
    limitMessage:
      "Too many token revocation attempts. Please wait and try again.",
    unavailableMessage:
      "Token revocation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:token_delete_all": {
    endpoint: "user:token_delete_all",
    limit: 10,
    windowMinutes: 10,
    resource: "DELETE /api/user/tokens",
    limitMessage:
      "Too many bulk token revocation attempts. Please wait and try again.",
    unavailableMessage:
      "Bulk token revocation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:supabase_create": {
    endpoint: "user:supabase_create",
    limit: 10,
    windowMinutes: 60,
    resource: "POST /api/user/supabase",
    limitMessage:
      "Too many Supabase server creation attempts. Please wait and try again.",
    unavailableMessage:
      "Supabase server creation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:supabase_delete": {
    endpoint: "user:supabase_delete",
    limit: 20,
    windowMinutes: 10,
    resource: "DELETE /api/user/supabase/:id",
    limitMessage:
      "Too many Supabase server deletion attempts. Please wait and try again.",
    unavailableMessage:
      "Supabase server deletion is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:supabase_oauth_authorize": {
    endpoint: "user:supabase_oauth_authorize",
    limit: 20,
    windowMinutes: 10,
    resource: "GET /api/user/supabase/oauth/authorize",
    limitMessage:
      "Too many Supabase OAuth initiation attempts. Please wait and try again.",
    unavailableMessage:
      "Supabase OAuth initiation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:supabase_oauth_callback": {
    endpoint: "user:supabase_oauth_callback",
    limit: 20,
    windowMinutes: 10,
    resource: "GET /api/user/supabase/oauth/callback",
    limitMessage:
      "Too many Supabase OAuth callback attempts. Please wait and try again.",
    unavailableMessage:
      "Supabase OAuth callback processing is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:supabase_oauth_connect": {
    endpoint: "user:supabase_oauth_connect",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/user/supabase/oauth/connect",
    limitMessage:
      "Too many Supabase project wiring attempts. Please wait and try again.",
    unavailableMessage:
      "Supabase project wiring is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "user:supabase_oauth_disconnect": {
    endpoint: "user:supabase_oauth_disconnect",
    limit: 20,
    windowMinutes: 10,
    resource: "DELETE /api/user/supabase/oauth/disconnect",
    limitMessage:
      "Too many Supabase disconnect attempts. Please wait and try again.",
    unavailableMessage:
      "Supabase disconnect is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "developer:app_create": {
    endpoint: "developer:app_create",
    limit: 20,
    windowMinutes: 60,
    resource: "POST /api/developer/apps",
    limitMessage:
      "Too many developer app creation attempts. Please wait and try again.",
    unavailableMessage:
      "Developer app creation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "developer:app_update": {
    endpoint: "developer:app_update",
    limit: 30,
    windowMinutes: 10,
    resource: "PATCH /api/developer/apps/:clientId",
    limitMessage:
      "Too many developer app update attempts. Please wait and try again.",
    unavailableMessage:
      "Developer app updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "developer:app_delete": {
    endpoint: "developer:app_delete",
    limit: 10,
    windowMinutes: 10,
    resource: "DELETE /api/developer/apps/:clientId",
    limitMessage:
      "Too many developer app deletion attempts. Please wait and try again.",
    unavailableMessage:
      "Developer app deletion is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "developer:app_rotate_secret": {
    endpoint: "developer:app_rotate_secret",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/developer/apps/:clientId/rotate-secret",
    limitMessage:
      "Too many client secret rotation attempts. Please wait and try again.",
    unavailableMessage:
      "Client secret rotation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "config:mcp_config": {
    endpoint: "config:mcp_config",
    limit: 60,
    windowMinutes: 10,
    resource: "GET /api/mcp-config/:appId",
    limitMessage:
      "Too many MCP config generation requests. Please wait and try again.",
    unavailableMessage:
      "MCP config generation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "apps:update_app": {
    endpoint: "apps:update_app",
    limit: 30,
    windowMinutes: 10,
    resource: "PATCH /api/apps/:appId",
    limitMessage: "Too many app update attempts. Please wait and try again.",
    unavailableMessage:
      "App updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "apps:user_settings_update": {
    endpoint: "apps:user_settings_update",
    limit: 30,
    windowMinutes: 10,
    resource: "PUT /api/apps/:appId/settings",
    limitMessage: "Too many app settings updates. Please wait and try again.",
    unavailableMessage:
      "App settings updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "apps:env_set": {
    endpoint: "apps:env_set",
    limit: 20,
    windowMinutes: 10,
    resource: "PUT /api/apps/:appId/env",
    limitMessage:
      "Too many environment replacement attempts. Please wait and try again.",
    unavailableMessage:
      "Environment replacement is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "apps:env_update": {
    endpoint: "apps:env_update",
    limit: 40,
    windowMinutes: 10,
    resource: "PATCH /api/apps/:appId/env",
    limitMessage:
      "Too many environment update attempts. Please wait and try again.",
    unavailableMessage:
      "Environment updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "apps:env_delete": {
    endpoint: "apps:env_delete",
    limit: 40,
    windowMinutes: 10,
    resource: "DELETE /api/apps/:appId/env/:key",
    limitMessage:
      "Too many environment deletion attempts. Please wait and try again.",
    unavailableMessage:
      "Environment deletion is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "apps:supabase_set": {
    endpoint: "apps:supabase_set",
    limit: 20,
    windowMinutes: 10,
    resource: "PUT /api/apps/:appId/supabase",
    limitMessage:
      "Too many app Supabase assignment attempts. Please wait and try again.",
    unavailableMessage:
      "App Supabase assignment is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "apps:supabase_delete": {
    endpoint: "apps:supabase_delete",
    limit: 20,
    windowMinutes: 10,
    resource: "DELETE /api/apps/:appId/supabase",
    limitMessage:
      "Too many app Supabase removal attempts. Please wait and try again.",
    unavailableMessage:
      "App Supabase removal is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "upload:create": {
    endpoint: "upload:create",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/upload",
    limitMessage: "Too many upload attempts. Please wait and try again.",
    unavailableMessage:
      "Uploads are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "upload:draft": {
    endpoint: "upload:draft",
    limit: 30,
    windowMinutes: 10,
    resource: "POST /api/apps/:appId/draft",
    limitMessage: "Too many draft upload attempts. Please wait and try again.",
    unavailableMessage:
      "Draft uploads are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:gaps_create": {
    endpoint: "admin:gaps_create",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/admin/gaps",
    limitMessage: "Too many gap creation attempts. Please wait and try again.",
    unavailableMessage:
      "Gap creation is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:gaps_update": {
    endpoint: "admin:gaps_update",
    limit: 40,
    windowMinutes: 10,
    resource: "PATCH /api/admin/gaps/:id",
    limitMessage: "Too many gap update attempts. Please wait and try again.",
    unavailableMessage:
      "Gap updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:assess": {
    endpoint: "admin:assess",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/admin/assess/:id",
    limitMessage:
      "Too many assessment update attempts. Please wait and try again.",
    unavailableMessage:
      "Assessment updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:approve": {
    endpoint: "admin:approve",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/admin/approve/:id",
    limitMessage:
      "Too many assessment approval attempts. Please wait and try again.",
    unavailableMessage:
      "Assessment approvals are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:reject": {
    endpoint: "admin:reject",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/admin/reject/:id",
    limitMessage:
      "Too many assessment rejection attempts. Please wait and try again.",
    unavailableMessage:
      "Assessment rejections are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:balance_topup": {
    endpoint: "admin:balance_topup",
    limit: 20,
    windowMinutes: 10,
    resource: "POST /api/admin/balance/:userId",
    limitMessage:
      "Too many balance top-up attempts. Please wait and try again.",
    unavailableMessage:
      "Balance top-ups are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:billing_config_update": {
    endpoint: "admin:billing_config_update",
    limit: 20,
    windowMinutes: 10,
    resource: "PATCH /api/admin/billing-config",
    limitMessage:
      "Too many billing config update attempts. Please wait and try again.",
    unavailableMessage:
      "Billing config updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:cleanup_provisionals": {
    endpoint: "admin:cleanup_provisionals",
    limit: 10,
    windowMinutes: 60,
    resource: "POST /api/admin/cleanup-provisionals",
    limitMessage:
      "Too many provisional cleanup attempts. Please wait and try again.",
    unavailableMessage:
      "Provisional cleanup is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:app_category": {
    endpoint: "admin:app_category",
    limit: 30,
    windowMinutes: 10,
    resource: "PATCH /api/admin/apps/:appId/category",
    limitMessage:
      "Too many app category update attempts. Please wait and try again.",
    unavailableMessage:
      "App category updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:app_featured": {
    endpoint: "admin:app_featured",
    limit: 30,
    windowMinutes: 10,
    resource: "PATCH /api/admin/apps/:appId/featured",
    limitMessage:
      "Too many app featured-state update attempts. Please wait and try again.",
    unavailableMessage:
      "App featured-state updates are temporarily unavailable while protection controls recover. Please try again shortly.",
  },
  "admin:payout_process": {
    endpoint: "admin:payout_process",
    limit: 10,
    windowMinutes: 60,
    resource: "POST /api/admin/payouts/process",
    limitMessage:
      "Too many payout processing attempts. Please wait and try again.",
    unavailableMessage:
      "Payout processing is temporarily unavailable while protection controls recover. Please try again shortly.",
  },
};

interface SensitiveRouteOptions {
  limit?: number;
  windowMinutes?: number;
}

function getPolicy(route: SensitiveRoute, options?: SensitiveRouteOptions) {
  const policy = SENSITIVE_ROUTE_RATE_LIMITS[route];
  return {
    ...policy,
    limit: options?.limit ?? policy.limit,
    windowMinutes: options?.windowMinutes ?? policy.windowMinutes,
  };
}

export function getSensitiveRouteClientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anonymous";
}

function getRetryAfterSeconds(resetAt: Date): string {
  const seconds = Math.ceil((resetAt.getTime() - Date.now()) / 1000);
  return String(Math.max(1, seconds));
}

export function buildSensitiveRouteRateLimitHeaders(
  route: SensitiveRoute,
  result: RateLimitResult,
  options?: SensitiveRouteOptions,
): Record<string, string> {
  const policy = getPolicy(route, options);
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(policy.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.floor(result.resetAt.getTime() / 1000)),
  };

  if (!result.allowed) {
    headers["Retry-After"] = getRetryAfterSeconds(result.resetAt);
  }

  return headers;
}

export function applySensitiveRouteRateLimitHeaders(
  response: Response,
  route: SensitiveRoute,
  result: RateLimitResult,
  options?: SensitiveRouteOptions,
): Response {
  const headers = buildSensitiveRouteRateLimitHeaders(route, result, options);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

export function buildSensitiveRouteRateLimitResponse(
  route: SensitiveRoute,
  result: RateLimitResult,
  options?: SensitiveRouteOptions,
): Response {
  const policy = getPolicy(route, options);
  const blockedByServiceFailure = result.reason === "service_unavailable";
  const status = blockedByServiceFailure ? 503 : 429;
  const message = blockedByServiceFailure
    ? policy.unavailableMessage
    : policy.limitMessage;

  return new Response(
    JSON.stringify({
      error: message,
      resetAt: result.resetAt.toISOString(),
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...buildSensitiveRouteRateLimitHeaders(route, result, options),
      },
    },
  );
}

export async function enforceSensitiveRouteRateLimit(
  key: string,
  route: SensitiveRoute,
  options?: SensitiveRouteOptions,
): Promise<{ result: RateLimitResult; response: Response | null }> {
  const policy = getPolicy(route, options);
  const result = await checkRateLimit(
    key,
    policy.endpoint,
    policy.limit,
    policy.windowMinutes,
    {
      mode: "fail_closed",
      resource: policy.resource,
    },
  );

  if (result.allowed) {
    return { result, response: null };
  }

  return {
    result,
    response: buildSensitiveRouteRateLimitResponse(route, result, options),
  };
}

export async function withSensitiveRouteRateLimit(
  key: string,
  route: SensitiveRoute,
  handler: () => Promise<Response> | Response,
  options?: SensitiveRouteOptions,
): Promise<Response> {
  const { result, response } = await enforceSensitiveRouteRateLimit(
    key,
    route,
    options,
  );
  if (response) {
    return response;
  }

  return applySensitiveRouteRateLimitHeaders(
    await handler(),
    route,
    result,
    options,
  );
}
