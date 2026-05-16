import type { App } from "../../shared/types/index.ts";
import type { ResolvedHttpRoutePolicy } from "./http-policy.ts";
import type { RequestCallerContext } from "./request-caller-context.ts";

export type HttpInvalidAuthPolicy = "ignore" | "throw";

export interface HttpCallerAuthOptions {
  allowAnonymous: boolean;
  invalidAuthPolicy: HttpInvalidAuthPolicy;
}

export interface HttpRouteExecutionPolicyIssue {
  status: number;
  type: "INVALID_HTTP_ROUTE_POLICY" | "HTTP_ROUTE_UNSUPPORTED";
  message: string;
}

export interface HttpRuntimeCallContext {
  publicRoute: boolean;
  ownerBilled: boolean;
  enforceTokenScopes: boolean;
  payerUserId: string;
  envUserId: string | null;
  appDataUserId?: string;
  sandboxUserId: string;
}

type HttpExecutionApp = Pick<App, "owner_id" | "runtime">;

export function resolveHttpCallerAuthOptions(
  policy: ResolvedHttpRoutePolicy,
): HttpCallerAuthOptions {
  if (policy.auth === "public") {
    return {
      allowAnonymous: true,
      invalidAuthPolicy: "ignore",
    };
  }

  return {
    allowAnonymous: false,
    invalidAuthPolicy: "throw",
  };
}

export function validateHttpRouteExecutionPolicy(
  policy: ResolvedHttpRoutePolicy,
  app: HttpExecutionApp,
): HttpRouteExecutionPolicyIssue | null {
  if (policy.auth === "public" && policy.billing !== "owner") {
    return {
      status: 422,
      type: "INVALID_HTTP_ROUTE_POLICY",
      message: "Public HTTP routes must use owner billing.",
    };
  }

  if (policy.auth === "public" && policy.dataScope !== "app") {
    return {
      status: 422,
      type: "INVALID_HTTP_ROUTE_POLICY",
      message: "Public HTTP routes must use app data scope.",
    };
  }

  if ((app.runtime ?? "deno") === "gpu" && policy.billing === "owner") {
    return {
      status: 422,
      type: "HTTP_ROUTE_UNSUPPORTED",
      message: "Owner-billed HTTP routes are not yet supported for GPU apps.",
    };
  }

  return null;
}

export function resolveHttpRuntimeCallContext(
  policy: ResolvedHttpRoutePolicy,
  app: HttpExecutionApp,
  caller: RequestCallerContext,
): HttpRuntimeCallContext {
  const publicRoute = policy.auth === "public";
  const authenticatedUserId = caller.authState === "authenticated"
    ? caller.userId
    : null;
  const ownerBilled = policy.billing === "owner";
  const payerUserId = ownerBilled
    ? app.owner_id
    : (authenticatedUserId ?? app.owner_id);

  return {
    publicRoute,
    ownerBilled,
    enforceTokenScopes: !publicRoute,
    payerUserId,
    envUserId: publicRoute ? null : authenticatedUserId,
    appDataUserId: policy.dataScope === "user"
      ? authenticatedUserId ?? undefined
      : undefined,
    sandboxUserId: authenticatedUserId ?? "anonymous",
  };
}
