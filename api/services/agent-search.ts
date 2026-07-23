import { getEnv } from "../lib/env.ts";
import type {
  LaunchAgentPane,
  LaunchAgentSearchRequest,
  LaunchAgentSearchResponse,
  LaunchAgentSearchResult,
  LaunchAgentSearchSubjectKind,
  LaunchNavigationTarget,
} from "../../shared/contracts/launch.ts";
import {
  type ResolvedInferenceRoute,
  resolveInferenceRoute,
  type ResolveInferenceRouteParams,
} from "./inference-route.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 300;
const MAX_DATABASE_RESPONSE_BYTES = 1_000_000;
const MAX_PROVIDER_RESPONSE_BYTES = 128_000;
const EMBEDDING_DIMENSIONS = 1536;
const MIN_HYBRID_SIMILARITY = 0.25;
const MAX_DOCUMENT_EMBEDDING_TEXT_LENGTH = 8_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SEARCH_KINDS = [
  "agent",
  "directive",
  "interface",
  "routine",
  "function",
  "function_field",
  "attention",
  "run",
  "release",
  "setting",
  "authority",
] as const satisfies readonly LaunchAgentSearchSubjectKind[];

const SEARCH_KIND_SET = new Set<string>(SEARCH_KINDS);
const REQUEST_KEYS = new Set(["query", "agentId", "kinds", "limit"]);

const ALLOWED_PANES_BY_KIND: Readonly<
  Record<LaunchAgentSearchSubjectKind, readonly LaunchAgentPane[]>
> = {
  agent: ["overview"],
  directive: ["overview"],
  interface: ["interfaces"],
  routine: ["routines"],
  function: ["functions"],
  function_field: ["functions"],
  attention: ["alerts"],
  run: ["compute"],
  release: ["settings"],
  setting: ["settings", "access"],
  authority: ["access"],
};

const ITEM_REQUIRED_KINDS = new Set<LaunchAgentSearchSubjectKind>([
  "interface",
  "routine",
  "function",
  "function_field",
  "attention",
  "run",
  "release",
  "setting",
  "authority",
]);

const EMBEDDING_PROVIDERS = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/text-embedding-3-small",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
  },
} as const;

export type AgentSearchServiceErrorCode =
  | "INVALID_REQUEST"
  | "SERVICE_UNAVAILABLE";

export class AgentSearchServiceError extends Error {
  readonly code: AgentSearchServiceErrorCode;
  readonly status: number;

  constructor(
    code: AgentSearchServiceErrorCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "AgentSearchServiceError";
    this.code = code;
    this.status = status;
  }
}

export interface AgentSearchDependencies {
  /** Database transport. It never receives a BYOK provider credential. */
  fetchFn?: typeof fetch;
  /** Provider transport. It never receives the Supabase service-role key. */
  providerFetchFn?: typeof fetch;
  resolveRoute?: (
    params: ResolveInferenceRouteParams,
  ) => Promise<ResolvedInferenceRoute>;
  embedQuery?: (
    query: string,
    route: ResolvedInferenceRoute,
  ) => Promise<number[]>;
  clock?: () => Date;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  /** Semantic retrieval is best-effort and defaults on. */
  semanticEnabled?: boolean;
}

export interface AgentSearchDocumentEmbedding {
  embedding: number[];
  provider: "openrouter" | "openai";
  model: string;
  textHash: string;
}

interface ValidatedRequest {
  query: string;
  agentId: string | null;
  kinds: LaunchAgentSearchSubjectKind[] | null;
  limit: number;
}

interface DatabaseConfig {
  baseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
}

interface SearchRow {
  documentId: string;
  agentId: string;
  agentSlug: string;
  kind: LaunchAgentSearchSubjectKind;
  subjectId: string;
  title: string;
  breadcrumb: string;
  snippet: string | null;
  route: string;
  score: number;
}

interface OwnerAgent {
  id: string;
  slug: string;
  name: string;
}

function fail(
  code: AgentSearchServiceErrorCode,
  message: string,
): AgentSearchServiceError {
  return new AgentSearchServiceError(
    code,
    message,
    code === "INVALID_REQUEST" ? 400 : 503,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  let sanitized = "";
  for (const character of value) {
    sanitized += hasControlCharacter(character) ? " " : character;
  }
  return sanitized;
}

function requireUuid(
  value: unknown,
  label: string,
  code: AgentSearchServiceErrorCode,
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw fail(code, `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function requireDatabaseString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      `Search persistence returned an invalid ${label}.`,
    );
  }
  return value;
}

function validateRequest(
  userId: string,
  request: LaunchAgentSearchRequest,
): ValidatedRequest {
  requireUuid(userId, "User ID", "INVALID_REQUEST");
  if (!isRecord(request)) {
    throw fail("INVALID_REQUEST", "Search request must be an object.");
  }
  if (Object.keys(request).some((key) => !REQUEST_KEYS.has(key))) {
    throw fail("INVALID_REQUEST", "Search request contains an unknown field.");
  }

  if (typeof request.query !== "string") {
    throw fail("INVALID_REQUEST", "Search query must be a string.");
  }
  const query = request.query.trim();
  if (
    query.length < 1 ||
    query.length > MAX_QUERY_LENGTH ||
    hasControlCharacter(query)
  ) {
    throw fail(
      "INVALID_REQUEST",
      `Search query must contain 1-${MAX_QUERY_LENGTH} visible characters.`,
    );
  }

  let agentId: string | null = null;
  if (request.agentId !== undefined && request.agentId !== null) {
    agentId = requireUuid(
      request.agentId,
      "Agent ID",
      "INVALID_REQUEST",
    );
  }

  let kinds: LaunchAgentSearchSubjectKind[] | null = null;
  if (request.kinds !== undefined) {
    if (
      !Array.isArray(request.kinds) ||
      request.kinds.length < 1 ||
      request.kinds.length > SEARCH_KINDS.length
    ) {
      throw fail(
        "INVALID_REQUEST",
        "Search kinds must be a non-empty supported list.",
      );
    }
    const seen = new Set<string>();
    kinds = request.kinds.map((kind) => {
      if (typeof kind !== "string" || !SEARCH_KIND_SET.has(kind)) {
        throw fail("INVALID_REQUEST", "Search kind is unsupported.");
      }
      if (seen.has(kind)) {
        throw fail("INVALID_REQUEST", "Search kinds must be unique.");
      }
      seen.add(kind);
      return kind as LaunchAgentSearchSubjectKind;
    });
  }

  const limit = request.limit === undefined ? DEFAULT_LIMIT : request.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw fail(
      "INVALID_REQUEST",
      `Search limit must be an integer from 1-${MAX_LIMIT}.`,
    );
  }

  return { query, agentId, kinds, limit };
}

function databaseConfig(deps: AgentSearchDependencies): DatabaseConfig {
  const baseUrl = (deps.supabaseUrl ?? getEnv("SUPABASE_URL")).replace(
    /\/+$/,
    "",
  );
  const serviceRoleKey = deps.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence is not configured.",
    );
  }
  return {
    baseUrl,
    serviceRoleKey,
    fetchFn: deps.fetchFn ?? fetch,
  };
}

async function readJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("response_too_large");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new Error("response_too_large");
  }
  return text ? JSON.parse(text) : null;
}

async function databaseRequest(
  config: DatabaseConfig,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await config.fetchFn(
      `${config.baseUrl}/rest/v1/${path}`,
      {
        ...init,
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          ...init.headers,
        },
      },
    );
  } catch {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence is unavailable.",
    );
  }

  if (!response.ok) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence is unavailable.",
    );
  }
  try {
    return await readJsonResponse(response, MAX_DATABASE_RESPONSE_BYTES);
  } catch {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned invalid data.",
    );
  }
}

function rpcBody(
  userId: string,
  request: ValidatedRequest,
): Record<string, unknown> {
  return {
    p_user_id: userId,
    p_query: request.query,
    p_limit: request.limit,
    p_agent_id: request.agentId,
    p_subject_types: request.kinds,
  };
}

function callRpc(
  config: DatabaseConfig,
  name: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return databaseRequest(config, `rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requireRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned invalid data.",
    );
  }
  return value;
}

function readFiniteScore(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned an invalid score.",
    );
  }
  return value;
}

function readKind(value: unknown): LaunchAgentSearchSubjectKind {
  if (typeof value !== "string" || !SEARCH_KIND_SET.has(value)) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned an invalid result kind.",
    );
  }
  return value as LaunchAgentSearchSubjectKind;
}

function safeSnippet(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 4000) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned an invalid summary.",
    );
  }
  const normalized = replaceControlCharacters(value)
    .replace(/\s+/gu, " ")
    .trim();
  return normalized || null;
}

function mapSearchRows(
  value: unknown,
  scoreColumn: "rank" | "combined_rank",
): SearchRow[] {
  return requireRows(value).map((row) => {
    const agentSlug = requireDatabaseString(
      row.agent_slug,
      "Agent slug",
      200,
    );
    if (!SLUG_PATTERN.test(agentSlug)) {
      throw fail(
        "SERVICE_UNAVAILABLE",
        "Agent search persistence returned an invalid Agent slug.",
      );
    }
    return {
      documentId: requireUuid(
        row.document_id,
        "Document ID",
        "SERVICE_UNAVAILABLE",
      ),
      agentId: requireUuid(
        row.agent_id,
        "Agent ID",
        "SERVICE_UNAVAILABLE",
      ),
      agentSlug,
      kind: readKind(row.subject_type),
      subjectId: requireDatabaseString(
        row.subject_id,
        "subject ID",
        240,
      ),
      title: requireDatabaseString(row.title, "title", 240),
      breadcrumb: requireDatabaseString(
        row.breadcrumb,
        "breadcrumb",
        500,
      ),
      snippet: safeSnippet(row.snippet),
      route: requireDatabaseString(row.route, "route", 1200),
      score: readFiniteScore(row[scoreColumn]),
    };
  });
}

async function loadOwnerAgents(
  config: DatabaseConfig,
  userId: string,
  agentIds: string[],
): Promise<Map<string, OwnerAgent>> {
  if (agentIds.length === 0) return new Map();
  const parameters = new URLSearchParams({
    owner_id: `eq.${userId}`,
    visibility: "eq.private",
    deleted_at: "is.null",
    id: `in.(${agentIds.join(",")})`,
    select: "id,slug,name",
  });
  const payload = await databaseRequest(
    config,
    `apps?${parameters.toString()}`,
    { method: "GET" },
  );
  const agents = new Map<string, OwnerAgent>();
  for (const row of requireRows(payload)) {
    const id = requireUuid(row.id, "Agent ID", "SERVICE_UNAVAILABLE");
    const slug = requireDatabaseString(row.slug, "Agent slug", 200);
    const name = requireDatabaseString(row.name, "Agent name", 240);
    if (!SLUG_PATTERN.test(slug) || agents.has(id)) {
      throw fail(
        "SERVICE_UNAVAILABLE",
        "Agent search persistence returned invalid Agent metadata.",
      );
    }
    agents.set(id, { id, slug, name });
  }
  return agents;
}

function destinationFor(
  row: SearchRow,
  agent: OwnerAgent,
): LaunchNavigationTarget {
  let parsed: URL;
  try {
    parsed = new URL(row.route, "https://galactic.internal");
  } catch {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned an invalid destination.",
    );
  }

  const expectedPath = `/agents/${encodeURIComponent(agent.slug)}`;
  if (
    parsed.origin !== "https://galactic.internal" ||
    parsed.pathname !== expectedPath ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned an unsafe destination.",
    );
  }

  const entries = [...parsed.searchParams.entries()];
  if (
    entries.some(([key]) => key !== "pane" && key !== "item") ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  ) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned an invalid destination.",
    );
  }

  const pane = parsed.searchParams.get("pane");
  if (
    !pane ||
    !ALLOWED_PANES_BY_KIND[row.kind].includes(pane as LaunchAgentPane)
  ) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned a mismatched destination.",
    );
  }

  const itemId = parsed.searchParams.get("item");
  const canonicalItemId = row.kind === "release"
    ? `release:${row.subjectId}`
    : row.subjectId;
  const itemMatchesSubject = row.kind === "release"
    ? itemId === canonicalItemId || itemId === row.subjectId
    : itemId === row.subjectId;
  if (
    (ITEM_REQUIRED_KINDS.has(row.kind) && !itemMatchesSubject) ||
    (!ITEM_REQUIRED_KINDS.has(row.kind) && itemId !== null)
  ) {
    throw fail(
      "SERVICE_UNAVAILABLE",
      "Agent search persistence returned a mismatched destination item.",
    );
  }

  const canonical = new URLSearchParams({ pane });
  const destinationItemId = itemId === null
    ? null
    : row.kind === "release"
    ? canonicalItemId
    : itemId;
  if (destinationItemId !== null) canonical.set("item", destinationItemId);
  return {
    href: `${expectedPath}?${canonical.toString()}`,
    agentId: agent.id,
    pane: pane as LaunchAgentPane,
    ...(destinationItemId === null ? {} : { itemId: destinationItemId }),
  };
}

function mergeRows(
  lexical: SearchRow[],
  hybrid: SearchRow[] | null,
): SearchRow[] {
  const merged = new Map<string, SearchRow>();
  for (const row of lexical) merged.set(row.documentId, row);
  for (const row of hybrid ?? []) {
    const existing = merged.get(row.documentId);
    if (!existing || row.score > existing.score) {
      merged.set(row.documentId, row);
    }
  }
  return [...merged.values()].sort((left, right) => {
    const scoreOrder = right.score - left.score;
    if (scoreOrder !== 0) return scoreOrder;
    const leftTitle = left.title.toLowerCase();
    const rightTitle = right.title.toLowerCase();
    if (leftTitle < rightTitle) return -1;
    if (leftTitle > rightTitle) return 1;
    if (left.documentId < right.documentId) return -1;
    if (left.documentId > right.documentId) return 1;
    return 0;
  });
}

function mapResults(
  rows: SearchRow[],
  agents: Map<string, OwnerAgent>,
  limit: number,
): LaunchAgentSearchResult[] {
  const results: LaunchAgentSearchResult[] = [];
  for (const row of rows) {
    const agent = agents.get(row.agentId);
    // The RPC is authoritative for owner filtering before rank/page. This
    // hydration check is defense in depth against stale or malformed rows.
    if (!agent || agent.slug !== row.agentSlug) continue;
    results.push({
      id: row.documentId,
      kind: row.kind,
      agent: {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
      },
      title: row.title,
      summary: row.snippet,
      destination: destinationFor(row, agent),
      score: row.score,
    });
    if (results.length === limit) break;
  }
  return results;
}

async function loadOwnerEmail(
  config: DatabaseConfig,
  userId: string,
): Promise<string> {
  const parameters = new URLSearchParams({
    id: `eq.${userId}`,
    select: "id,email",
    limit: "1",
  });
  const payload = await databaseRequest(
    config,
    `users?${parameters.toString()}`,
    { method: "GET" },
  );
  const rows = requireRows(payload);
  if (rows.length !== 1) throw new Error("owner_unavailable");
  if (
    requireUuid(rows[0].id, "User ID", "SERVICE_UNAVAILABLE") !== userId ||
    typeof rows[0].email !== "string"
  ) {
    throw new Error("owner_unavailable");
  }
  const email = rows[0].email.trim();
  if (
    email.length < 3 ||
    email.length > 320 ||
    hasControlCharacter(email)
  ) {
    throw new Error("owner_unavailable");
  }
  return email;
}

function isSupportedByokRoute(
  route: ResolvedInferenceRoute,
): route is ResolvedInferenceRoute & {
  provider: keyof typeof EMBEDDING_PROVIDERS;
} {
  return route.billingMode === "byok" &&
    route.keySource === "user_byok" &&
    (route.provider === "openrouter" || route.provider === "openai") &&
    route.apiKey.length > 0;
}

async function resolveEmbeddingRoute(
  userId: string,
  userEmail: string,
  deps: AgentSearchDependencies,
): Promise<ResolvedInferenceRoute | null> {
  const resolver = deps.resolveRoute ?? resolveInferenceRoute;
  const attempts: ResolveInferenceRouteParams[] = [
    { userId, userEmail, byokOnly: true },
    {
      userId,
      userEmail,
      byokOnly: true,
      selection: { billingMode: "byok", provider: "openrouter" },
    },
    {
      userId,
      userEmail,
      byokOnly: true,
      selection: { billingMode: "byok", provider: "openai" },
    },
  ];
  const attemptedProviders = new Set<string>();
  for (const params of attempts) {
    const selectedProvider = params.selection?.provider;
    if (selectedProvider && attemptedProviders.has(selectedProvider)) continue;
    try {
      const route = await resolver(params);
      if (isSupportedByokRoute(route)) return route;
      attemptedProviders.add(String(route.provider));
    } catch {
      if (selectedProvider) attemptedProviders.add(selectedProvider);
    }
  }
  return null;
}

function validateEmbedding(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== EMBEDDING_DIMENSIONS ||
    value.some((item) =>
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      Math.abs(item) > 1_000_000
    )
  ) {
    throw new Error("invalid_embedding");
  }
  return value;
}

async function embedByokQuery(
  query: string,
  route: ResolvedInferenceRoute,
  providerFetchFn: typeof fetch,
): Promise<number[]> {
  if (!isSupportedByokRoute(route)) throw new Error("unsupported_route");
  const provider = EMBEDDING_PROVIDERS[route.provider];
  let response: Response;
  try {
    response = await providerFetchFn(`${provider.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${route.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        input: query,
        encoding_format: "float",
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });
  } catch {
    throw new Error("embedding_unavailable");
  }
  if (!response.ok) throw new Error("embedding_unavailable");

  let payload: unknown;
  try {
    payload = await readJsonResponse(response, MAX_PROVIDER_RESPONSE_BYTES);
  } catch {
    throw new Error("embedding_unavailable");
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("embedding_unavailable");
  }
  const first = payload.data[0];
  if (!isRecord(first)) throw new Error("embedding_unavailable");
  return validateEmbedding(first.embedding);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Best-effort semantic materialization for an already-safe navigation
 * document. It deliberately returns null for missing/rejected BYOK or provider
 * failures so lexical navigation remains authoritative and available. The
 * resolved credential never leaves the provider transport.
 */
export async function embedOwnerAgentSearchDocument(
  input: {
    userId: string;
    userEmail: string;
    text: string;
  },
  deps: AgentSearchDependencies = {},
): Promise<AgentSearchDocumentEmbedding | null> {
  const text = input.text.replace(/\s+/gu, " ").trim();
  if (
    !UUID_PATTERN.test(input.userId) ||
    input.userEmail.trim().length < 3 ||
    input.userEmail.length > 320 ||
    hasControlCharacter(input.userEmail) ||
    text.length < 1 ||
    text.length > MAX_DOCUMENT_EMBEDDING_TEXT_LENGTH ||
    hasControlCharacter(text)
  ) {
    return null;
  }

  const route = await resolveEmbeddingRoute(
    input.userId.toLowerCase(),
    input.userEmail.trim(),
    deps,
  );
  if (!route || !isSupportedByokRoute(route)) return null;

  try {
    const embedding = validateEmbedding(
      deps.embedQuery
        ? await deps.embedQuery(text, route)
        : await embedByokQuery(
          text,
          route,
          deps.providerFetchFn ?? fetch,
        ),
    );
    return {
      embedding,
      provider: route.provider,
      model: EMBEDDING_PROVIDERS[route.provider].model,
      textHash: await sha256Hex(text),
    };
  } catch {
    return null;
  }
}

function pgVector(value: number[]): string {
  return `[${value.join(",")}]`;
}

async function tryHybridRows(
  config: DatabaseConfig,
  userId: string,
  request: ValidatedRequest,
  deps: AgentSearchDependencies,
): Promise<SearchRow[] | null> {
  if (deps.semanticEnabled === false) return null;
  try {
    const ownerEmail = await loadOwnerEmail(config, userId);
    const route = await resolveEmbeddingRoute(userId, ownerEmail, deps);
    if (!route) return null;
    const embedding = validateEmbedding(
      deps.embedQuery
        ? await deps.embedQuery(request.query, route)
        : await embedByokQuery(
          request.query,
          route,
          deps.providerFetchFn ?? fetch,
        ),
    );
    const payload = await callRpc(
      config,
      "search_agent_documents_hybrid",
      {
        ...rpcBody(userId, request),
        p_query_embedding: pgVector(embedding),
        p_min_similarity: MIN_HYBRID_SIMILARITY,
      },
    );
    return mapSearchRows(payload, "combined_rank");
  } catch {
    // Search navigation must remain available if BYOK, an embedding provider,
    // or the optional vector index is unavailable.
    return null;
  }
}

/**
 * Owner-private, navigation-only search. The lexical RPC is always executed
 * first. A BYOK embedding may augment its ranking, but can never replace the
 * lexical result set or fall back to a Galactic/platform inference key.
 */
export async function searchOwnerAgentNavigation(
  userId: string,
  request: LaunchAgentSearchRequest,
  deps: AgentSearchDependencies = {},
): Promise<LaunchAgentSearchResponse> {
  const validated = validateRequest(userId, request);
  const normalizedUserId = userId.toLowerCase();
  const config = databaseConfig(deps);

  const lexicalPayload = await callRpc(
    config,
    "search_agent_documents",
    rpcBody(normalizedUserId, validated),
  );
  const lexicalRows = mapSearchRows(lexicalPayload, "rank");
  const hybridRows = await tryHybridRows(
    config,
    normalizedUserId,
    validated,
    deps,
  );
  const merged = mergeRows(lexicalRows, hybridRows);
  const agentIds = [...new Set(merged.map((row) => row.agentId))];
  const agents = await loadOwnerAgents(
    config,
    normalizedUserId,
    agentIds,
  );

  return {
    query: validated.query,
    results: mapResults(merged, agents, validated.limit),
    generatedAt: (deps.clock ?? (() => new Date()))().toISOString(),
  };
}

export const searchAgentDocuments = searchOwnerAgentNavigation;
