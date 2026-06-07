import type { ResolvedInferenceRoute } from "./inference-route.ts";
import { BYOK_PROVIDERS, isActiveBYOKProvider } from "../../shared/types/index.ts";
import { resolvePlatformInferenceModel } from "./platform-inference-models.ts";

const DEFAULT_REFERER = "https://ultralight-api.rgn4jz429m.workers.dev";
const INTERNAL_WEB_SEARCH_FLAG = "web_search_enabled";
const OPENAI_CHAT_WEB_SEARCH_MODEL = "gpt-5-search-api";

export interface InferenceFetchOptions {
  title?: string;
  referer?: string;
  signal?: AbortSignal;
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

export function supportsInferenceWebSearch(
  route: Pick<ResolvedInferenceRoute, "upstreamProvider">,
): boolean {
  return isActiveBYOKProvider(route.upstreamProvider) &&
    BYOK_PROVIDERS[route.upstreamProvider].capabilities.webSearch === true;
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
  const requestBody: Record<string, unknown> = {
    ...body,
    model,
    ...(route.requestDefaults ?? {}),
  };
  const webSearchRequested = requestBody[INTERNAL_WEB_SEARCH_FLAG] === true;
  delete requestBody[INTERNAL_WEB_SEARCH_FLAG];

  if (!webSearchRequested || !supportsInferenceWebSearch(route)) {
    return requestBody;
  }

  if (route.upstreamProvider === "openrouter") {
    const plugins = Array.isArray(requestBody.plugins)
      ? [...requestBody.plugins]
      : [];
    if (!plugins.some((plugin) =>
      !!plugin && typeof plugin === "object" &&
      (plugin as Record<string, unknown>).id === "web"
    )) {
      plugins.push({ id: "web" });
    }
    return { ...requestBody, plugins };
  }

  if (route.upstreamProvider === "openai") {
    const existingOptions = requestBody.web_search_options;
    return {
      ...requestBody,
      model: OPENAI_CHAT_WEB_SEARCH_MODEL,
      web_search_options: existingOptions && typeof existingOptions === "object"
        ? existingOptions
        : {},
    };
  }

  return requestBody;
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
    signal: options.signal,
  });
}
