import { classifyPublicAuthenticationError } from "../services/auth-errors.ts";

type McpAuthJsonRpcId = string | number | null | undefined;

interface McpAuthenticationErrorResponseInput {
  request: Request;
  id: McpAuthJsonRpcId;
  error: unknown;
  authRequiredCode: number;
  internalErrorCode: number;
}

/**
 * Shared API-token failure envelope for both MCP surfaces. Returning null
 * leaves non-API-token authentication errors to each handler's existing
 * compatibility logic.
 */
export function mcpAuthenticationErrorResponse(
  input: McpAuthenticationErrorResponseInput,
): Response | null {
  const classified = classifyPublicAuthenticationError(input.error);
  if (!classified) return null;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: input.id ?? null,
    error: {
      code: classified.status === 503
        ? input.internalErrorCode
        : input.authRequiredCode,
      message: classified.message,
      data: { type: classified.type },
    },
  });
  const headers = new Headers({ "Content-Type": "application/json" });
  if (classified.status === 401) {
    const requestUrl = new URL(input.request.url);
    const host = input.request.headers.get("host") || requestUrl.host;
    const proto = input.request.headers.get("x-forwarded-proto") ||
      (host.includes("localhost") ? "http" : "https");
    headers.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`,
    );
  }
  return new Response(body, { status: classified.status, headers });
}
