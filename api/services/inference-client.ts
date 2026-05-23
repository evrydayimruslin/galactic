import type { ResolvedInferenceRoute } from "./inference-route.ts";
import { BYOK_PROVIDERS, isActiveBYOKProvider } from "../../shared/types/index.ts";
import { resolvePlatformInferenceModel } from "./platform-inference-models.ts";

const DEFAULT_REFERER = "https://ultralight-api.rgn4jz429m.workers.dev";

export interface InferenceFetchOptions {
  title?: string;
  referer?: string;
}

export function selectInferenceModel(
  route: ResolvedInferenceRoute,
  requestedModel?: string | null,
): string {
  if (route.billingMode === "byok") {
    return route.model;
  }

  const requested = requestedModel?.trim();
  if (!requested) return route.model;

  if (route.provider === "ultralight") {
    const platformModel = resolvePlatformInferenceModel(requested);
    if (platformModel && platformModel.upstreamProvider === route.upstreamProvider) {
      return platformModel.upstreamModel;
    }

    if (route.upstreamProvider === "openrouter") {
      if (platformModel) {
        return platformModel.aliases.find((alias) => alias.includes("/")) ?? requested;
      }
      return requested;
    }

    return route.model;
  }

  return requested;
}

export function getInferenceChatCompletionsUrl(route: ResolvedInferenceRoute): string {
  return `${route.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export function supportsInferenceRealtime(route: ResolvedInferenceRoute): boolean {
  return route.billingMode === "byok" &&
    isActiveBYOKProvider(route.provider) &&
    BYOK_PROVIDERS[route.provider].capabilities.realtime === true;
}

export function buildInferenceHeaders(
  route: ResolvedInferenceRoute,
  options: InferenceFetchOptions = {},
): Record<string, string> {
  return {
    "Authorization": `Bearer ${route.apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": options.referer || DEFAULT_REFERER,
    "X-Title": options.title || "Ultralight",
  };
}

export function buildInferenceRequestBody(
  route: ResolvedInferenceRoute,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const requestedModel = typeof body.model === "string" ? body.model : null;
  const model = selectInferenceModel(route, requestedModel);
  return {
    ...body,
    model,
    ...(route.requestDefaults ?? {}),
  };
}

export function fetchInferenceChatCompletion(
  route: ResolvedInferenceRoute,
  body: Record<string, unknown>,
  options: InferenceFetchOptions = {},
): Promise<Response> {
  return fetch(getInferenceChatCompletionsUrl(route), {
    method: "POST",
    headers: buildInferenceHeaders(route, options),
    body: JSON.stringify(buildInferenceRequestBody(route, body)),
  });
}
