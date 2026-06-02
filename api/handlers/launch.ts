// Launch API facade
// Thin MVP-facing endpoints for the external-agent-first website.

import { authenticate } from './auth.ts';
import { error, json } from './response.ts';
import { getEnv } from '../lib/env.ts';
import {
  getFeeWaiverLeaderboard,
  parseFeeWaiverLeaderboardQuery,
} from '../services/fee-waivers.ts';
import { isGpuSupportEnabled, sanitizeGpuTrustCard } from '../services/gpu/feature-flag.ts';
import { buildAppTrustCard } from '../services/trust.ts';
import { RequestValidationError } from '../services/request-validation.ts';
import { createEmbeddingService } from '../services/embedding.ts';
import {
  LAUNCH_API_ROUTES,
  LAUNCH_DEFERRED_CAPABILITIES,
  LAUNCH_INCLUDED_CAPABILITIES,
  LAUNCH_INSTALL_TARGETS,
  LAUNCH_MVP_VERSION,
  LAUNCH_PLATFORM_PRIMITIVES,
  LAUNCH_PUBLIC_ROUTES,
  LAUNCH_SCOPE_CONTRACT,
  type LaunchApiRoute,
  type LaunchDiscoveryRetrievalSummary,
  type LaunchDiscoverySource,
  type LaunchInstallInstruction,
  type LaunchLeaderboardEntry,
  type LaunchLeaderboardKind,
  type LaunchLeaderboardResponse,
  type LaunchMoneyAmount,
  type LaunchPayoutStatus,
  type LaunchPlatformPrimitive,
  type LaunchPlatformPrimitiveSuggestion,
  type LaunchPricingSummary,
  type LaunchPublicRoute,
  type LaunchRelevanceSummary,
  type LaunchToolAdminSummary,
  type LaunchToolKind,
  type LaunchToolOwnerSummary,
  type LaunchToolRelationship,
  type LaunchToolSummary,
  type LaunchToolVisibility,
  type LaunchWalletSummary,
  type LaunchWidgetSummary,
} from '../../shared/contracts/launch.ts';
import type { AppManifest } from '../../shared/contracts/manifest.ts';
import type { WidgetDeclaration } from '../../shared/contracts/widget.ts';

const APP_SELECT = [
  'id',
  'owner_id',
  'slug',
  'name',
  'description',
  'icon_url',
  'visibility',
  'download_access',
  'current_version',
  'manifest',
  'exports',
  'pricing_config',
  'gpu_pricing_config',
  'runtime',
  'gpu_status',
  'gpu_type',
  'version_metadata',
  'env_schema',
  'tags',
  'category',
  'likes',
  'dislikes',
  'weighted_likes',
  'weighted_dislikes',
  'total_runs',
  'runs_30d',
  'hosting_suspended',
  'updated_at',
  'created_at',
].join(',');

const OWNER_SELECT = 'id,display_name,profile_slug,avatar_url';
const USER_BALANCE_SELECT =
  'id,balance_light,deposit_balance_light,earned_balance_light,escrow_light,' +
  'stripe_connect_account_id,stripe_connect_onboarded,stripe_connect_payouts_enabled';
const MAX_DISCOVERY_LIMIT = 100;
const DEFAULT_DISCOVERY_LIMIT = 24;

interface AuthUser {
  id: string;
  email?: string;
}

interface LaunchAppRow {
  id: string;
  owner_id: string;
  slug: string | null;
  name: string | null;
  description: string | null;
  icon_url?: string | null;
  visibility: string | null;
  download_access?: string | null;
  current_version?: string | null;
  manifest?: unknown;
  exports?: string[] | null;
  pricing_config?: unknown;
  gpu_pricing_config?: unknown;
  runtime?: string | null;
  gpu_status?: string | null;
  gpu_type?: string | null;
  version_metadata?: unknown;
  env_schema?: Record<string, unknown> | null;
  tags?: string[] | null;
  category?: string | null;
  likes?: number | null;
  dislikes?: number | null;
  weighted_likes?: number | null;
  weighted_dislikes?: number | null;
  total_runs?: number | null;
  runs_30d?: number | null;
  hosting_suspended?: boolean | null;
  updated_at?: string | null;
  created_at?: string | null;
}

interface OwnerRow {
  id: string;
  display_name: string | null;
  profile_slug: string | null;
  avatar_url: string | null;
}

interface LibraryRow {
  app_id: string;
}

interface WalletRow {
  balance_light: number | null;
  deposit_balance_light: number | null;
  earned_balance_light: number | null;
  escrow_light: number | null;
  stripe_connect_account_id?: string | null;
  stripe_connect_onboarded?: boolean | null;
  stripe_connect_payouts_enabled?: boolean | null;
}

interface BuilderLeaderboardRpcRow {
  rank?: number | null;
  user_id?: string | null;
  owner_id?: string | null;
  publisher_user_id?: string | null;
  display_name?: string | null;
  profile_slug?: string | null;
  avatar_url?: string | null;
  earnings_light?: number | null;
  score?: number | null;
  weighted_likes?: number | null;
  total_likes?: number | null;
  total_runs?: number | null;
  event_count?: number | null;
  app_id?: string | null;
  app_slug?: string | null;
  app_name?: string | null;
  featured_app_slug?: string | null;
  featured_app_name?: string | null;
}

interface SemanticAppMatchRow {
  id: string;
  similarity?: number | null;
}

interface LaunchQueryEmbedding {
  embedding: number[];
  model: string;
}

interface RankedLaunchAppRow extends LaunchAppRow {
  launchRelevance?: LaunchRelevanceSummary;
}

interface PrimitiveEmbeddingCache {
  model: string;
  entries: Array<{
    primitive: LaunchPlatformPrimitive;
    embedding: number[];
  }>;
}

type DbHeaders = Record<string, string>;

interface DbConfig {
  baseUrl: string;
  headers: DbHeaders;
}

interface ToolMapOptions {
  owners: Map<string, LaunchToolOwnerSummary>;
  viewerId?: string | null;
  installedIds?: Set<string>;
  includeWidgets?: boolean;
}

interface PrimitiveMetadata {
  label: string;
  description: string;
  route?: LaunchPublicRoute;
  apiRoute?: LaunchApiRoute;
}

class LaunchServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchServiceUnavailableError';
  }
}

const PRIMITIVE_METADATA: Record<LaunchPlatformPrimitive, PrimitiveMetadata> = {
  install: {
    label: 'Install Ultralight',
    description: 'Connect the Ultralight MCP/API layer to an existing agent.',
    route: '/install',
    apiRoute: 'GET /api/launch/install',
  },
  deploy: {
    label: 'Deploy a tool',
    description: 'Ship deployable tool code onto hosted Ultralight runtime.',
    route: '/install',
    apiRoute: 'GET /api/launch/install',
  },
  publish: {
    label: 'Publish for discovery',
    description: 'Make a deployed tool public or unlisted for agent installs.',
    route: '/admin/tools/:id',
    apiRoute: 'GET /api/launch/admin/tools/:id',
  },
  discover: {
    label: 'Discover tools',
    description: 'Find public agent-native tools and widget surfaces.',
    route: '/discover',
    apiRoute: 'GET /api/launch/discover',
  },
  wallet: {
    label: 'Light wallet',
    description: 'Manage spendable Light for installs, calls, and hosting.',
    route: '/wallet',
    apiRoute: 'GET /api/launch/wallet',
  },
  pricing: {
    label: 'Tool pricing',
    description: 'Inspect per-call pricing and free-call configuration.',
    route: '/admin/tools/:id',
    apiRoute: 'GET /api/launch/admin/tools/:id',
  },
  receipts: {
    label: 'Receipts',
    description: 'Track monetized tool usage and marketplace receipts.',
    route: '/admin/tools/:id',
    apiRoute: 'GET /api/launch/admin/tools/:id',
  },
  api_keys: {
    label: 'API keys',
    description: 'Create API tokens for MCP, CLI, and direct API access.',
    route: '/settings',
    apiRoute: 'GET /api/launch/install',
  },
  owner_admin: {
    label: 'Owner admin',
    description: 'Manage visibility, pricing, widgets, logs, and receipts.',
    route: '/admin/tools/:id',
    apiRoute: 'GET /api/launch/admin/tools/:id',
  },
  widgets: {
    label: 'Widgets',
    description: 'Open public UI surfaces attached to tools.',
    route: '/tools/:slug',
    apiRoute: 'GET /api/launch/tools/:id/widgets',
  },
};

const PUBLIC_SEARCH_USER_ID = '00000000-0000-0000-0000-000000000000';
const SEMANTIC_DISCOVERY_THRESHOLD = 0.35;
let primitiveEmbeddingCache: PrimitiveEmbeddingCache | null = null;

export async function handleLaunch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method !== 'GET') {
    return error('Launch API is read-only in this MVP facade', 405);
  }

  try {
    if (path === '/api/launch/status') {
      return json(buildLaunchStatus(request));
    }

    if (path === '/api/launch/openapi.json') {
      return json(buildLaunchOpenApiSpec(request));
    }

    if (path === '/api/launch/install') {
      return json({ instructions: buildInstallInstructions(request) });
    }

    if (path === '/api/launch/platform-primitives') {
      return json({
        suggestions: await buildPrimitiveSuggestions(
          url.searchParams.get('q'),
        ),
        generatedAt: new Date().toISOString(),
      });
    }

    if (path === '/api/launch/discover') {
      return await handleLaunchDiscover(request, url);
    }

    if (path === '/api/launch/library') {
      return await handleLaunchLibrary(request);
    }

    if (path === '/api/launch/wallet') {
      return await handleLaunchWallet(request);
    }

    if (path === '/api/launch/leaderboard') {
      return await handleLaunchLeaderboard(url);
    }

    const adminToolMatch = path.match(/^\/api\/launch\/admin\/tools\/([^/]+)$/);
    if (adminToolMatch) {
      return await handleLaunchToolAdmin(request, adminToolMatch[1]);
    }

    const widgetsMatch = path.match(/^\/api\/launch\/tools\/([^/]+)\/widgets$/);
    if (widgetsMatch) {
      return await handleLaunchToolWidgets(request, widgetsMatch[1]);
    }

    const toolMatch = path.match(/^\/api\/launch\/tools\/([^/]+)$/);
    if (toolMatch) {
      return await handleLaunchTool(request, toolMatch[1]);
    }

    return error('Launch endpoint not found', 404);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    if (err instanceof LaunchServiceUnavailableError) {
      return error(err.message, 503);
    }
    console.error('[LAUNCH] API facade failed:', err);
    return error('Launch API request failed', 500);
  }
}

function buildLaunchStatus(request: Request): Record<string, unknown> {
  const baseUrl = publicBaseUrl(request);
  return {
    available: true,
    version: LAUNCH_MVP_VERSION,
    thesis: LAUNCH_SCOPE_CONTRACT.thesis,
    timestamp: new Date().toISOString(),
    baseUrl,
    publicRoutes: LAUNCH_PUBLIC_ROUTES,
    apiRoutes: LAUNCH_API_ROUTES,
    installTargets: LAUNCH_INSTALL_TARGETS,
    capabilities: {
      included: LAUNCH_INCLUDED_CAPABILITIES,
      deferred: LAUNCH_DEFERRED_CAPABILITIES,
    },
    endpoints: {
      status: '/api/launch/status',
      openapi: '/api/launch/openapi.json',
      install: '/api/launch/install',
      discover: '/api/launch/discover?query={query}',
      platformPrimitives: '/api/launch/platform-primitives?q={query}',
      leaderboard: '/api/launch/leaderboard?kind=builder&period=30d',
      mcpPlatform: '/mcp/platform',
      mcpDiscovery: '/.well-known/mcp.json',
      website: '/',
    },
    externalAgentLoop: [
      'Install Ultralight MCP, CLI, or direct API access.',
      'Discover relevant tools and platform primitives.',
      'Inspect tool capabilities, pricing, trust, and widgets.',
      'Call tools through MCP/API and return widget links when UI matters.',
      'Preserve Light receipts and errors in the final response.',
    ],
  };
}

function buildLaunchOpenApiSpec(request: Request): Record<string, unknown> {
  const baseUrl = publicBaseUrl(request);
  const jsonContent = (schema: Record<string, unknown>) => ({
    'application/json': { schema },
  });
  const queryParam = (
    name: string,
    schema: Record<string, unknown>,
    description: string,
    required = false,
  ) => ({ name, in: 'query', required, schema, description });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Ultralight Launch API',
      description:
        'Launch-scoped API facade for existing agents to install, discover, inspect, compose, and pay for Ultralight tools.',
      version: LAUNCH_MVP_VERSION,
      contact: { name: 'Ultralight', url: baseUrl },
    },
    servers: [{ url: baseUrl, description: 'Configured launch API origin' }],
    security: [{ bearerAuth: [] }, {}],
    paths: {
      '/api/launch/status': {
        get: {
          operationId: 'getLaunchStatus',
          summary: 'Inspect launch API capabilities and links',
          responses: {
            '200': {
              description: 'Launch API health, endpoints, and agent loop',
              content: jsonContent({
                type: 'object',
                required: ['available', 'version', 'apiRoutes', 'endpoints'],
                properties: {
                  available: { type: 'boolean' },
                  version: { type: 'string' },
                  thesis: { type: 'string' },
                  timestamp: { type: 'string', format: 'date-time' },
                  apiRoutes: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  endpoints: { type: 'object' },
                },
              }),
            },
          },
        },
      },
      '/api/launch/install': {
        get: {
          operationId: 'getLaunchInstallInstructions',
          summary: 'Get MCP, CLI, and direct API install instructions',
          responses: {
            '200': {
              description: 'Copyable launch install instructions',
              content: jsonContent({
                type: 'object',
                properties: {
                  instructions: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/InstallInstruction' },
                  },
                },
              }),
            },
          },
        },
      },
      '/api/launch/discover': {
        get: {
          operationId: 'discoverLaunchTools',
          summary: 'Discover public launch tools and platform primitives',
          description:
            'Semantic-first launch discovery with lexical fallback. Results expose public tool pages, widget surfaces, pricing, owner, and retrieval metadata.',
          parameters: [
            queryParam(
              'query',
              { type: 'string', maxLength: 200 },
              'Natural language query for public tools and primitives',
            ),
            queryParam(
              'kind',
              {
                type: 'string',
                enum: ['all', 'mcp', 'http', 'markdown', 'gpu'],
                default: 'all',
              },
              'Optional tool kind filter',
            ),
            queryParam(
              'includeWidgets',
              { type: 'boolean', default: true },
              'Include widget summaries in tool results',
            ),
            queryParam(
              'limit',
              { type: 'integer', minimum: 1, maximum: 100, default: 24 },
              'Maximum tool results to return',
            ),
          ],
          responses: {
            '200': {
              description: 'Launch discovery results',
              content: jsonContent({
                type: 'object',
                properties: {
                  query: { type: ['string', 'null'] },
                  results: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ToolSummary' },
                  },
                  platformPrimitives: {
                    type: 'array',
                    items: {
                      $ref: '#/components/schemas/PlatformPrimitiveSuggestion',
                    },
                  },
                  retrieval: {
                    $ref: '#/components/schemas/DiscoveryRetrieval',
                  },
                  generatedAt: { type: 'string', format: 'date-time' },
                },
              }),
            },
          },
        },
      },
      '/api/launch/tools/{id}': {
        get: {
          operationId: 'getLaunchTool',
          summary: 'Inspect a public tool by id or slug',
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Tool id or slug',
          }],
          responses: {
            '200': {
              description: 'Public tool profile and trust metadata',
              content: jsonContent({
                type: 'object',
                properties: {
                  tool: { $ref: '#/components/schemas/ToolSummary' },
                  trustCard: { type: 'object' },
                },
              }),
            },
            '404': { description: 'Tool not found' },
          },
        },
      },
      '/api/launch/tools/{id}/widgets': {
        get: {
          operationId: 'getLaunchToolWidgets',
          summary: 'List public widget surfaces for a tool',
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Tool id or slug',
          }],
          responses: {
            '200': {
              description: 'Widget surface summaries',
              content: jsonContent({
                type: 'object',
                properties: {
                  tool: { type: 'object' },
                  widgets: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/WidgetSummary' },
                  },
                },
              }),
            },
          },
        },
      },
      '/api/launch/library': {
        get: {
          operationId: 'getLaunchLibrary',
          summary: 'List authenticated owned and installed tools',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Owned and installed launch tools',
              content: jsonContent({
                type: 'object',
                properties: {
                  owned: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ToolSummary' },
                  },
                  installed: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ToolSummary' },
                  },
                },
              }),
            },
            '401': { description: 'Authentication required' },
          },
        },
      },
      '/api/launch/admin/tools/{id}': {
        get: {
          operationId: 'getLaunchToolAdmin',
          summary: 'Inspect owner-only launch-safe tool administration',
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Owned tool id or slug',
          }],
          responses: {
            '200': { description: 'Tool admin summary' },
            '401': { description: 'Authentication required' },
            '404': { description: 'Tool not found or not owned' },
          },
        },
      },
      '/api/launch/wallet': {
        get: {
          operationId: 'getLaunchWallet',
          summary: 'Get authenticated Light balance and payout status',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Light wallet summary' },
            '401': { description: 'Authentication required' },
          },
        },
      },
      '/api/launch/leaderboard': {
        get: {
          operationId: 'getLaunchLeaderboard',
          summary: 'Get builder or fee-credit launch leaderboard',
          parameters: [
            queryParam(
              'kind',
              { type: 'string', enum: ['builder', 'fee_credit'], default: 'builder' },
              'Leaderboard kind',
            ),
            queryParam(
              'period',
              { type: 'string', enum: ['30d', '90d', 'all'], default: '30d' },
              'Ranking period',
            ),
            queryParam(
              'limit',
              { type: 'integer', minimum: 1, maximum: 100, default: 50 },
              'Maximum entries',
            ),
          ],
          responses: {
            '200': { description: 'Launch leaderboard entries' },
          },
        },
      },
      '/api/launch/platform-primitives': {
        get: {
          operationId: 'getLaunchPlatformPrimitives',
          summary: 'Suggest platform primitives for an agent task',
          parameters: [
            queryParam(
              'q',
              { type: 'string', maxLength: 200 },
              'Optional natural language query',
            ),
          ],
          responses: {
            '200': {
              description: 'Platform primitive suggestions',
              content: jsonContent({
                type: 'object',
                properties: {
                  suggestions: {
                    type: 'array',
                    items: {
                      $ref: '#/components/schemas/PlatformPrimitiveSuggestion',
                    },
                  },
                },
              }),
            },
          },
        },
      },
      '/mcp/platform': {
        post: {
          operationId: 'callPlatformMcp',
          summary: 'Call the Ultralight platform MCP JSON-RPC endpoint',
          description:
            'Use JSON-RPC 2.0 methods such as initialize, tools/list, and tools/call. Requires bearer auth for user-specific tools.',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'JSON-RPC response' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        InstallInstruction: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' } },
            configText: { type: 'string' },
            requiresApiKey: { type: 'boolean' },
          },
        },
        ToolSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            slug: { type: 'string' },
            name: { type: 'string' },
            description: { type: ['string', 'null'] },
            kind: { type: 'string', enum: ['mcp', 'http', 'markdown', 'gpu'] },
            visibility: {
              type: 'string',
              enum: ['public', 'private', 'unlisted'],
            },
            publicUrl: { type: ['string', 'null'] },
            adminUrl: { type: ['string', 'null'] },
            installUrl: { type: ['string', 'null'] },
            widgets: {
              type: 'array',
              items: { $ref: '#/components/schemas/WidgetSummary' },
            },
            relevance: { $ref: '#/components/schemas/Relevance' },
          },
        },
        WidgetSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: ['string', 'null'] },
            public: { type: 'boolean' },
            previewAvailable: { type: 'boolean' },
            openUrl: { type: ['string', 'null'] },
          },
        },
        PlatformPrimitiveSuggestion: {
          type: 'object',
          properties: {
            primitive: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            route: { type: 'string' },
            apiRoute: { type: 'string' },
            similarity: { type: ['number', 'null'] },
            relevance: { $ref: '#/components/schemas/Relevance' },
          },
        },
        DiscoveryRetrieval: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['browse', 'lexical', 'semantic', 'hybrid'],
            },
            embeddedSources: { type: 'array', items: { type: 'string' } },
            fallbackSources: { type: 'array', items: { type: 'string' } },
            embeddingModel: { type: ['string', 'null'] },
            fallbackReason: { type: ['string', 'null'] },
          },
        },
        Relevance: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['semantic', 'lexical', 'curated'] },
            score: { type: ['number', 'null'] },
            signals: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    'x-launch-scope': {
      version: LAUNCH_MVP_VERSION,
      thesis: LAUNCH_SCOPE_CONTRACT.thesis,
      includedCapabilities: LAUNCH_INCLUDED_CAPABILITIES,
      deferredCapabilities: LAUNCH_DEFERRED_CAPABILITIES,
    },
  };
}

async function handleLaunchDiscover(
  request: Request,
  url: URL,
): Promise<Response> {
  const query = normalizeQuery(
    url.searchParams.get('q') ?? url.searchParams.get('query'),
  );
  const kind = parseKind(url.searchParams.get('kind'));
  const limit = clampLimit(
    url.searchParams.get('limit'),
    DEFAULT_DISCOVERY_LIMIT,
  );
  const includeWidgets = url.searchParams.get('includeWidgets') !== 'false';
  const viewer = await tryAuthenticate(request);
  const installedIds = viewer ? await fetchInstalledIds(viewer.id) : new Set<string>();
  const embedding = query ? await tryEmbedLaunchQuery(query) : null;
  let rows: RankedLaunchAppRow[] = [];
  let toolFallbackReason: string | null = null;

  if (embedding) {
    try {
      rows = await fetchSemanticPublicApps({
        embedding: embedding.embedding,
        kind,
        limit,
      });
      if (rows.length === 0) {
        toolFallbackReason = 'semantic tool search returned no launch-safe rows';
      }
    } catch (err) {
      toolFallbackReason = err instanceof Error
        ? `semantic tool search failed: ${err.message}`
        : 'semantic tool search failed';
    }
  } else if (query) {
    toolFallbackReason = 'embedding service unavailable';
  }

  if (rows.length < limit) {
    const lexicalRows = await fetchPublicApps({
      query,
      kind,
      limit,
      excludeIds: new Set(rows.map((row) => row.id)),
    });
    rows = [
      ...rows,
      ...lexicalRows,
    ].slice(0, limit);
  }

  if (rows.length === 0 && query) {
    toolFallbackReason ||= 'lexical search returned no launch-safe rows';
  }

  const platformPrimitives = await buildPrimitiveSuggestions(query, embedding);
  const owners = await fetchOwnerMap(rows.map((row) => row.owner_id));
  const retrieval = buildDiscoveryRetrieval({
    hasQuery: Boolean(query),
    embedding,
    toolRows: rows,
    primitiveSuggestions: platformPrimitives,
    fallbackReason: toolFallbackReason,
  });

  return json({
    query,
    results: rows.map((row) =>
      withToolRelevance(
        toLaunchToolSummary(row, {
          owners,
          viewerId: viewer?.id,
          installedIds,
          includeWidgets,
        }),
        row.launchRelevance,
      )
    ),
    platformPrimitives,
    retrieval,
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchLibrary(request: Request): Promise<Response> {
  const user = await requireLaunchUser(request);
  const [ownedRows, installedIds] = await Promise.all([
    fetchOwnedApps(user.id),
    fetchInstalledIds(user.id),
  ]);
  const installedRows = await fetchAppsByIds(
    Array.from(installedIds).filter((appId) => !ownedRows.some((row) => row.id === appId)),
  );
  const owners = await fetchOwnerMap([
    ...ownedRows.map((row) => row.owner_id),
    ...installedRows.map((row) => row.owner_id),
  ]);

  return json({
    owned: ownedRows.map((row) =>
      toLaunchToolSummary(row, {
        owners,
        viewerId: user.id,
        installedIds,
      })
    ),
    installed: installedRows.map((row) =>
      toLaunchToolSummary(row, {
        owners,
        viewerId: user.id,
        installedIds,
      })
    ),
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchTool(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const locator = parseLocator(encodedLocator);
  const viewer = await tryAuthenticate(request);
  const row = await fetchToolByLocator(locator, { publicOnly: true });
  if (!row) return error('Tool not found', 404);
  if (shouldHideGpu(row)) return error('Tool not found', 404);

  const installedIds = viewer ? await fetchInstalledIds(viewer.id) : new Set<string>();
  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchToolSummary(row, {
    owners,
    viewerId: viewer?.id,
    installedIds,
  });

  return json({
    tool,
    trustCard: buildLaunchTrustCard(row),
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchToolWidgets(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const locator = parseLocator(encodedLocator);
  const viewer = await tryAuthenticate(request);
  const row = await fetchToolByLocator(locator, { publicOnly: true });
  if (!row) return error('Tool not found', 404);
  if (shouldHideGpu(row)) return error('Tool not found', 404);

  const installedIds = viewer ? await fetchInstalledIds(viewer.id) : new Set<string>();
  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchToolSummary(row, {
    owners,
    viewerId: viewer?.id,
    installedIds,
  });

  return json({
    tool: {
      id: tool.id,
      slug: tool.slug,
      name: tool.name,
      relationship: tool.relationship,
      publicUrl: tool.publicUrl,
      adminUrl: tool.adminUrl,
    },
    widgets: tool.widgets,
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchToolAdmin(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  const locator = parseLocator(encodedLocator);
  const row = await fetchToolByLocator(locator, { ownerId: user.id });
  if (!row) return error('Tool not found', 404);

  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchToolSummary(row, {
    owners,
    viewerId: user.id,
    installedIds: new Set<string>(),
  });
  const admin: LaunchToolAdminSummary = {
    tool,
    editableFields: [
      'name',
      'description',
      'visibility',
      'pricing',
      'widgets',
      'secrets',
      'trust',
    ],
    receiptsUrl: `/admin/tools/${encodeURIComponent(row.id)}?tab=receipts`,
    logsUrl: `/admin/tools/${encodeURIComponent(row.id)}?tab=logs`,
  };

  return json({
    admin,
    trustCard: buildLaunchTrustCard(row),
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchWallet(request: Request): Promise<Response> {
  const user = await requireLaunchUser(request);
  const db = getDbConfig();
  const rows = await dbGet<WalletRow>(
    db,
    'users',
    {
      id: `eq.${user.id}`,
      select: USER_BALANCE_SELECT,
      limit: '1',
    },
  );
  const row = rows[0] || {
    balance_light: 0,
    deposit_balance_light: 0,
    earned_balance_light: 0,
    escrow_light: 0,
  };
  const balance = numeric(row.balance_light);
  const wallet: LaunchWalletSummary = {
    balance: money(balance),
    spendableBalance: money(balance),
    depositBalance: money(numeric(row.deposit_balance_light)),
    earnedBalance: money(numeric(row.earned_balance_light)),
    escrowBalance: money(numeric(row.escrow_light)),
    canTopUp: true,
    topUpUrl: '/wallet?tab=topup',
    transactionsUrl: '/wallet?tab=transactions',
    receiptsUrl: '/wallet?tab=receipts',
    earningsUrl: '/wallet?tab=earnings',
    payoutsUrl: '/wallet?tab=payouts',
    payoutStatus: payoutStatusFor(row),
  };

  return json({
    wallet,
    generatedAt: new Date().toISOString(),
  });
}

function payoutStatusFor(row: WalletRow): LaunchPayoutStatus {
  if (row.stripe_connect_payouts_enabled === true) {
    return {
      kind: 'ready',
      label: 'Payouts ready',
      description: 'Stripe Connect payouts are enabled for creator earnings.',
      actionUrl: '/wallet?tab=payouts',
    };
  }
  if (row.stripe_connect_account_id || row.stripe_connect_onboarded) {
    return {
      kind: 'onboarding',
      label: 'Payout setup incomplete',
      description: 'Complete Stripe onboarding before requesting bank payouts.',
      actionUrl: '/wallet?tab=payouts',
    };
  }
  return {
    kind: 'not_connected',
    label: 'Payouts not connected',
    description: 'Creator earnings can accrue as Light before a payout account is connected.',
    actionUrl: '/wallet?tab=payouts',
  };
}

async function handleLaunchLeaderboard(url: URL): Promise<Response> {
  const kind = parseLeaderboardKind(url.searchParams.get('kind'));
  if (kind === 'fee_credit') {
    const leaderboard = await getFeeWaiverLeaderboard(
      parseFeeWaiverLeaderboardQuery(normalizeLeaderboardUrl(url)),
    );
    const response: LaunchLeaderboardResponse = {
      kind,
      period: leaderboard.period,
      generatedAt: leaderboard.generated_at,
      entries: leaderboard.entries.map((entry) => ({
        rank: entry.rank,
        userId: entry.publisher_user_id,
        displayName: entry.display_name,
        profileSlug: entry.profile_slug,
        avatarUrl: entry.avatar_url,
        value: money(entry.fee_waived_light),
        eventCount: entry.event_count,
      })),
    };
    return json(response);
  }

  return json(await fetchBuilderLeaderboard(url));
}

function buildInstallInstructions(
  request: Request,
): LaunchInstallInstruction[] {
  const baseUrl = publicBaseUrl(request);
  const mcpUrl = `${baseUrl}/mcp/platform`;
  const bearer = 'Bearer $ULTRALIGHT_API_KEY';
  const genericConfig = {
    mcpServers: {
      ultralight: {
        url: mcpUrl,
        headers: { Authorization: bearer },
      },
    },
  };

  return [
    {
      target: 'claude_code',
      label: 'Claude Code',
      description: 'Add Ultralight as a remote MCP server for an existing Claude Code workspace.',
      steps: [
        'Create an Ultralight API token from Settings.',
        'Set ULTRALIGHT_API_KEY in your shell or Claude Code environment.',
        `Add ${mcpUrl} as the ultralight remote MCP server with an Authorization header.`,
      ],
      configText: JSON.stringify(genericConfig, null, 2),
      requiresApiKey: true,
    },
    {
      target: 'cursor',
      label: 'Cursor',
      description: "Install the Ultralight MCP server in Cursor's MCP configuration.",
      steps: [
        'Open Cursor MCP settings.',
        'Add the ultralight server entry below.',
        'Reload Cursor so agents can discover Ultralight tools.',
      ],
      configText: JSON.stringify(genericConfig, null, 2),
      requiresApiKey: true,
    },
    {
      target: 'codex',
      label: 'Codex',
      description: 'Connect Codex to the same remote MCP endpoint used by other agents.',
      steps: [
        'Create an Ultralight API token.',
        'Add a remote MCP server named ultralight.',
        'Use the platform MCP endpoint and Authorization header below.',
      ],
      configText:
        `[mcp_servers.ultralight]\nurl = "${mcpUrl}"\nheaders = { Authorization = "${bearer}" }`,
      requiresApiKey: true,
    },
    {
      target: 'openai_remote_mcp',
      label: 'OpenAI Remote MCP',
      description:
        'Register Ultralight as a remote MCP server for OpenAI agent runtimes that support MCP tools.',
      steps: [
        'Use the platform MCP endpoint as the server URL.',
        'Pass your Ultralight API token as a bearer Authorization header.',
        'Allow the agent to list tools before calling specific tools.',
      ],
      configText: JSON.stringify(
        { server_url: mcpUrl, authorization: bearer },
        null,
        2,
      ),
      requiresApiKey: true,
    },
    {
      target: 'generic_mcp',
      label: 'Generic MCP',
      description: 'Use the standard remote MCP server declaration for any compatible agent.',
      steps: [
        "Copy the server configuration into your agent's MCP config.",
        'Replace the API token placeholder with an Ultralight API token.',
        'Restart the agent or refresh its tool registry.',
      ],
      configText: JSON.stringify(genericConfig, null, 2),
      requiresApiKey: true,
    },
    {
      target: 'cli',
      label: 'CLI',
      description:
        'Use the existing Ultralight CLI to login, upload, test, and run deployed tools.',
      steps: [
        'Install the ultralightpro package or use the local CLI during development.',
        'Run ultralight login --token <your-token>.',
        'Run ultralight upload . from a deployable tool directory.',
      ],
      configText:
        'npm install -g ultralightpro\nultralight login --token <your-token>\nultralight upload .',
      requiresApiKey: true,
    },
    {
      target: 'api',
      label: 'Direct API',
      description: 'Call launch and platform endpoints directly with an Ultralight API token.',
      steps: [
        'Create an API token from Settings.',
        'Send Authorization: Bearer <token> on authenticated API requests.',
        'Read /api/launch/status and /api/launch/openapi.json before calling authenticated launch endpoints.',
        'Use /api/launch/discover for public discovery and /mcp/platform for MCP tools.',
      ],
      configText: `curl "${baseUrl}/api/launch/status"\n` +
        `curl "${baseUrl}/api/launch/openapi.json"\n` +
        `curl -H "Authorization: ${bearer}" "${baseUrl}/api/launch/library"`,
      requiresApiKey: true,
    },
  ];
}

async function fetchPublicApps(options: {
  query: string | null;
  kind: LaunchToolKind | 'all';
  limit: number;
  excludeIds?: Set<string>;
}): Promise<RankedLaunchAppRow[]> {
  const db = getDbConfig();
  const candidateLimit = Math.min(
    MAX_DISCOVERY_LIMIT,
    Math.max(options.limit * 4, 40),
  );
  const rows = await dbGet<LaunchAppRow>(
    db,
    'apps',
    {
      visibility: 'eq.public',
      deleted_at: 'is.null',
      select: APP_SELECT,
      order: 'weighted_likes.desc,total_runs.desc,updated_at.desc',
      limit: String(candidateLimit),
    },
  );
  return rows
    .filter((row) => !shouldHideGpu(row))
    .filter((row) => !options.excludeIds?.has(row.id))
    .filter((row) => matchesKind(row, options.kind))
    .filter((row) => matchesQuery(row, options.query))
    .slice(0, options.limit)
    .map((row) => annotateLexicalRow(row, options.query));
}

async function tryEmbedLaunchQuery(
  query: string,
): Promise<LaunchQueryEmbedding | null> {
  const embeddingService = createEmbeddingService();
  if (!embeddingService) return null;
  try {
    const result = await embeddingService.embed(query);
    return {
      embedding: result.embedding,
      model: result.model,
    };
  } catch (err) {
    console.warn('[LAUNCH] Query embedding failed:', err);
    return null;
  }
}

async function fetchSemanticPublicApps(options: {
  embedding: number[];
  kind: LaunchToolKind | 'all';
  limit: number;
}): Promise<RankedLaunchAppRow[]> {
  const db = getDbConfig();
  const response = await fetch(`${db.baseUrl}/rest/v1/rpc/search_apps`, {
    method: 'POST',
    headers: db.headers,
    body: JSON.stringify({
      p_query_embedding: vectorString(options.embedding),
      p_user_id: PUBLIC_SEARCH_USER_ID,
      p_limit: Math.min(MAX_DISCOVERY_LIMIT, Math.max(options.limit * 4, 40)),
      p_offset: 0,
    }),
  });
  const matches = await readRows<SemanticAppMatchRow>(
    response,
    'Failed to search launch app embeddings',
  );
  const similarityById = new Map(
    matches.map((match) => [match.id, numeric(match.similarity)]),
  );
  const rowsById = new Map(
    (await fetchAppsByIds(matches.map((match) => match.id)))
      .map((row) => [row.id, row]),
  );
  return matches
    .map((match) => rowsById.get(match.id))
    .filter((row): row is LaunchAppRow => Boolean(row))
    .filter((row) => !shouldHideGpu(row))
    .filter((row) => matchesKind(row, options.kind))
    .map((row) => ({
      ...row,
      launchRelevance: {
        source: 'semantic',
        score: roundScore(similarityById.get(row.id)),
        signals: ['skills_embedding'],
      },
    } satisfies RankedLaunchAppRow))
    .filter((row) => numeric(row.launchRelevance?.score) >= SEMANTIC_DISCOVERY_THRESHOLD)
    .slice(0, options.limit);
}

async function fetchOwnedApps(userId: string): Promise<LaunchAppRow[]> {
  const db = getDbConfig();
  return await dbGet<LaunchAppRow>(
    db,
    'apps',
    {
      owner_id: `eq.${userId}`,
      deleted_at: 'is.null',
      select: APP_SELECT,
      order: 'updated_at.desc',
      limit: '100',
    },
  );
}

async function fetchInstalledIds(userId: string): Promise<Set<string>> {
  const db = getDbConfig();
  const rows = await dbGet<LibraryRow>(
    db,
    'user_app_library',
    {
      user_id: `eq.${userId}`,
      select: 'app_id',
      limit: '500',
    },
  );
  return new Set(rows.map((row) => row.app_id).filter(Boolean));
}

async function fetchAppsByIds(appIds: string[]): Promise<LaunchAppRow[]> {
  const ids = Array.from(new Set(appIds)).filter(Boolean).slice(0, 100);
  if (ids.length === 0) return [];
  const db = getDbConfig();
  return await dbGet<LaunchAppRow>(
    db,
    'apps',
    {
      id: `in.(${ids.join(',')})`,
      deleted_at: 'is.null',
      select: APP_SELECT,
      order: 'updated_at.desc',
      limit: String(ids.length),
    },
  );
}

async function fetchToolByLocator(
  locator: string,
  options: { publicOnly?: boolean; ownerId?: string },
): Promise<LaunchAppRow | null> {
  const db = getDbConfig();
  const params: Record<string, string> = {
    or: `(id.eq.${locator},slug.eq.${locator})`,
    deleted_at: 'is.null',
    select: APP_SELECT,
    limit: '1',
  };
  if (options.publicOnly) params.visibility = 'in.(public,unlisted)';
  if (options.ownerId) params.owner_id = `eq.${options.ownerId}`;
  const rows = await dbGet<LaunchAppRow>(db, 'apps', params);
  return rows[0] || null;
}

async function fetchOwnerMap(
  ownerIds: string[],
): Promise<Map<string, LaunchToolOwnerSummary>> {
  const ids = Array.from(new Set(ownerIds)).filter(Boolean);
  const map = new Map<string, LaunchToolOwnerSummary>();
  for (const id of ids) {
    map.set(id, { userId: id });
  }
  if (ids.length === 0) return map;

  const db = getDbConfig();
  const rows = await dbGet<OwnerRow>(
    db,
    'users',
    {
      id: `in.(${ids.join(',')})`,
      select: OWNER_SELECT,
      limit: String(ids.length),
    },
  );
  for (const row of rows) {
    map.set(row.id, {
      userId: row.id,
      displayName: row.display_name,
      profileSlug: row.profile_slug,
      avatarUrl: row.avatar_url,
    });
  }
  return map;
}

async function fetchBuilderLeaderboard(
  url: URL,
): Promise<LaunchLeaderboardResponse> {
  const db = getDbConfig();
  const period = parseLeaderboardPeriod(url.searchParams.get('period'));
  const limit = clampLimit(url.searchParams.get('limit'), 50);
  const response = await fetch(`${db.baseUrl}/rest/v1/rpc/get_leaderboard`, {
    method: 'POST',
    headers: db.headers,
    body: JSON.stringify({
      p_interval: period === 'all' ? 'at' : period,
      p_limit: limit,
    }),
  });
  const rows = await readRows<BuilderLeaderboardRpcRow>(
    response,
    'Failed to fetch builder leaderboard',
  );
  const generatedAt = new Date().toISOString();
  return {
    kind: 'builder',
    period,
    generatedAt,
    entries: rows.map((row, index) => toBuilderLeaderboardEntry(row, index)),
  };
}

function toBuilderLeaderboardEntry(
  row: BuilderLeaderboardRpcRow,
  index: number,
): LaunchLeaderboardEntry {
  const userId = row.user_id || row.owner_id || row.publisher_user_id || '';
  const value = numeric(
    row.earnings_light ?? row.score ?? row.weighted_likes ?? row.total_likes ??
      row.total_runs,
  );
  const featuredSlug = row.app_slug || row.featured_app_slug || row.app_id;
  const featuredName = row.app_name || row.featured_app_name || featuredSlug;
  return {
    rank: numeric(row.rank) || index + 1,
    userId,
    displayName: row.display_name ?? null,
    profileSlug: row.profile_slug ?? null,
    avatarUrl: row.avatar_url ?? null,
    value: money(value),
    eventCount: numeric(row.event_count ?? row.total_runs),
    featuredTool: featuredSlug
      ? {
        id: row.app_id || featuredSlug,
        slug: featuredSlug,
        name: featuredName || featuredSlug,
      }
      : null,
  };
}

function toLaunchToolSummary(
  row: LaunchAppRow,
  options: ToolMapOptions,
): LaunchToolSummary {
  const slug = row.slug || row.id;
  const installed = options.installedIds?.has(row.id) || false;
  const relationship = relationshipFor(row, options.viewerId, installed);
  return {
    id: row.id,
    slug,
    name: row.name || slug,
    description: row.description,
    kind: inferToolKind(row),
    visibility: normalizeVisibility(row.visibility),
    relationship,
    owner: options.owners.get(row.owner_id) || { userId: row.owner_id },
    installed,
    installUrl: `/install?tool=${encodeURIComponent(slug)}`,
    publicUrl: `/tools/${encodeURIComponent(slug)}`,
    adminUrl: relationship === 'owner' ? `/admin/tools/${encodeURIComponent(row.id)}` : null,
    pricing: pricingSummary(row),
    widgets: options.includeWidgets === false ? [] : extractWidgets(row),
    tags: row.tags || [],
    updatedAt: row.updated_at || row.created_at || null,
  };
}

function extractWidgets(row: LaunchAppRow): LaunchWidgetSummary[] {
  const manifest = parseManifest(row.manifest);
  const widgets = manifest?.widgets;
  if (!Array.isArray(widgets)) return [];
  const slug = row.slug || row.id;
  return widgets
    .filter((widget): widget is WidgetDeclaration =>
      Boolean(widget && typeof widget.id === 'string' && widget.id.trim())
    )
    .map((widget) => ({
      id: widget.id,
      label: widget.label || widget.id,
      description: widget.description || null,
      public: normalizeVisibility(row.visibility) !== 'private',
      previewAvailable: Boolean(
        widget.ui_function || widget.data_function || widget.data_tool,
      ),
      openUrl: `/tools/${encodeURIComponent(slug)}?widget=${encodeURIComponent(widget.id)}`,
    }));
}

function pricingSummary(row: LaunchAppRow): LaunchPricingSummary {
  const pricingConfig = asRecord(row.pricing_config);
  const defaultPrice = numeric(pricingConfig?.default_price_light);
  const functionPrices = asRecord(pricingConfig?.functions);
  const paidFunctionsCount = functionPrices
    ? Object.values(functionPrices).filter((value) => functionPrice(value) > 0)
      .length
    : 0;

  return {
    defaultCallPrice: defaultPrice > 0 ? money(defaultPrice) : null,
    freeToInstall: true,
    paidFunctionsCount,
  };
}

function functionPrice(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const record = asRecord(value);
  return numeric(record?.price_light);
}

function inferToolKind(row: LaunchAppRow): LaunchToolKind {
  if (row.runtime === 'gpu') return 'gpu';
  const manifest = parseManifest(row.manifest);
  if (manifest?.http) return 'http';
  if (Array.isArray(row.exports) && row.exports.length > 0) return 'mcp';
  return 'mcp';
}

function relationshipFor(
  row: LaunchAppRow,
  viewerId: string | null | undefined,
  installed: boolean,
): LaunchToolRelationship {
  if (viewerId && row.owner_id === viewerId) return 'owner';
  if (installed) return 'installed';
  return 'public';
}

function normalizeVisibility(
  value: string | null | undefined,
): LaunchToolVisibility {
  if (value === 'private' || value === 'unlisted' || value === 'public') {
    return value;
  }
  return 'private';
}

function buildLaunchTrustCard(row: LaunchAppRow): unknown {
  return sanitizeGpuTrustCard(buildAppTrustCard({
    current_version: row.current_version || '',
    runtime: row.runtime === 'gpu' && !isGpuSupportEnabled() ? 'deno' : row.runtime || 'deno',
    manifest: typeof row.manifest === 'string'
      ? row.manifest
      : row.manifest
      ? JSON.stringify(row.manifest)
      : null,
    version_metadata: Array.isArray(row.version_metadata) ? row.version_metadata as never : [],
    visibility: normalizeVisibility(row.visibility),
    download_access: row.download_access || 'owner',
    env_schema: row.env_schema || {},
  } as never));
}

function shouldHideGpu(row: LaunchAppRow): boolean {
  return row.runtime === 'gpu' && !isGpuSupportEnabled();
}

function matchesKind(row: LaunchAppRow, kind: LaunchToolKind | 'all'): boolean {
  return kind === 'all' || inferToolKind(row) === kind;
}

function matchesQuery(row: LaunchAppRow, query: string | null): boolean {
  if (!query) return true;
  const haystack = [
    row.name,
    row.slug,
    row.description,
    row.category,
    ...(row.tags || []),
    ...extractWidgets(row).flatMap((widget) => [
      widget.label,
      widget.description || '',
    ]),
  ].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function annotateLexicalRow(
  row: LaunchAppRow,
  query: string | null,
): RankedLaunchAppRow {
  return {
    ...row,
    launchRelevance: {
      source: query ? 'lexical' : 'curated',
      score: query ? lexicalRowScore(row, query) : null,
      signals: query ? ['tool_metadata', 'widget_metadata'] : [
        'community_signal',
      ],
    },
  };
}

function withToolRelevance(
  tool: LaunchToolSummary,
  relevance?: LaunchRelevanceSummary,
): LaunchToolSummary {
  return relevance ? { ...tool, relevance } : tool;
}

function lexicalRowScore(row: LaunchAppRow, query: string | null): number {
  const normalized = normalizeQuery(query);
  if (!normalized) return 0;
  const terms = normalized.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const haystack = [
    row.name,
    row.slug,
    row.description,
    row.category,
    ...(row.tags || []),
    ...extractWidgets(row).flatMap((widget) => [
      widget.label,
      widget.description || '',
    ]),
  ].join(' ').toLowerCase();
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return roundScore(matches / terms.length);
}

function buildDiscoveryRetrieval(options: {
  hasQuery: boolean;
  embedding: LaunchQueryEmbedding | null;
  toolRows: RankedLaunchAppRow[];
  primitiveSuggestions: LaunchPlatformPrimitiveSuggestion[];
  fallbackReason: string | null;
}): LaunchDiscoveryRetrievalSummary {
  if (!options.hasQuery) {
    return {
      mode: 'browse',
      embeddedSources: [],
      fallbackSources: ['tools', 'widgets', 'platform_primitives'],
      embeddingModel: null,
      fallbackReason: null,
    };
  }

  const embeddedSources = new Set<LaunchDiscoverySource>();
  const fallbackSources = new Set<LaunchDiscoverySource>();
  if (
    options.toolRows.some((row) => row.launchRelevance?.source === 'semantic')
  ) {
    embeddedSources.add('tools');
  }
  if (
    options.toolRows.some((row) =>
      row.launchRelevance?.source === 'lexical' ||
      row.launchRelevance?.source === 'curated'
    )
  ) {
    fallbackSources.add('tools');
    fallbackSources.add('widgets');
  }
  if (
    options.primitiveSuggestions.some((suggestion) => suggestion.relevance?.source === 'semantic')
  ) {
    embeddedSources.add('platform_primitives');
    embeddedSources.add('install_docs');
  }
  if (
    options.primitiveSuggestions.some((suggestion) => suggestion.relevance?.source !== 'semantic')
  ) {
    fallbackSources.add('platform_primitives');
    fallbackSources.add('install_docs');
  }

  const mode = embeddedSources.size > 0 && fallbackSources.size > 0
    ? 'hybrid'
    : embeddedSources.size > 0
    ? 'semantic'
    : 'lexical';

  return {
    mode,
    embeddedSources: Array.from(embeddedSources),
    fallbackSources: Array.from(fallbackSources),
    embeddingModel: options.embedding?.model || null,
    fallbackReason: options.fallbackReason,
  };
}

async function buildPrimitiveSuggestions(
  query: string | null,
  embedding?: LaunchQueryEmbedding | null,
): Promise<LaunchPlatformPrimitiveSuggestion[]> {
  const normalized = normalizeQuery(query);
  if (normalized && embedding) {
    const semantic = await buildSemanticPrimitiveSuggestions(
      normalized,
      embedding,
    );
    if (semantic.length > 0) return semantic;
  }

  return buildLexicalPrimitiveSuggestions(normalized);
}

async function buildSemanticPrimitiveSuggestions(
  query: string,
  queryEmbedding: LaunchQueryEmbedding,
): Promise<LaunchPlatformPrimitiveSuggestion[]> {
  try {
    const cache = await getPrimitiveEmbeddingCache(queryEmbedding.model);
    return cache.entries
      .map((entry) => {
        const metadata = PRIMITIVE_METADATA[entry.primitive];
        const similarity = cosineSimilarity(
          queryEmbedding.embedding,
          entry.embedding,
        );
        return {
          primitive: entry.primitive,
          label: metadata.label,
          description: metadata.description,
          route: metadata.route,
          apiRoute: metadata.apiRoute,
          similarity: roundScore(similarity),
          relevance: {
            source: 'semantic',
            score: roundScore(similarity),
            signals: ['platform_primitive_embedding'],
          },
        } satisfies LaunchPlatformPrimitiveSuggestion;
      })
      .filter((suggestion) => numeric(suggestion.similarity) > 0)
      .sort((a, b) => numeric(b.similarity) - numeric(a.similarity));
  } catch (err) {
    console.warn('[LAUNCH] Primitive embeddings failed:', err);
    return buildLexicalPrimitiveSuggestions(query);
  }
}

async function getPrimitiveEmbeddingCache(
  model: string,
): Promise<PrimitiveEmbeddingCache> {
  if (primitiveEmbeddingCache?.model === model) return primitiveEmbeddingCache;
  const embeddingService = createEmbeddingService();
  if (!embeddingService) {
    throw new Error('embedding service unavailable');
  }
  const results = await embeddingService.embedBatch(
    LAUNCH_PLATFORM_PRIMITIVES.map((primitive) =>
      primitiveEmbeddingText(primitive, PRIMITIVE_METADATA[primitive])
    ),
  );
  primitiveEmbeddingCache = {
    model,
    entries: LAUNCH_PLATFORM_PRIMITIVES.map((primitive, index) => ({
      primitive,
      embedding: results[index]?.embedding || [],
    })).filter((entry) => entry.embedding.length > 0),
  };
  return primitiveEmbeddingCache;
}

function buildLexicalPrimitiveSuggestions(
  normalized: string | null,
): LaunchPlatformPrimitiveSuggestion[] {
  return LAUNCH_PLATFORM_PRIMITIVES
    .map((primitive) => {
      const metadata = PRIMITIVE_METADATA[primitive];
      const similarity = normalized ? primitiveSimilarity(primitive, metadata, normalized) : null;
      const relevanceSource: LaunchRelevanceSummary['source'] = normalized ? 'lexical' : 'curated';
      return {
        primitive,
        label: metadata.label,
        description: metadata.description,
        route: metadata.route,
        apiRoute: metadata.apiRoute,
        similarity,
        relevance: {
          source: relevanceSource,
          score: similarity,
          signals: normalized ? ['primitive_text'] : ['launch_catalog'],
        },
      } satisfies LaunchPlatformPrimitiveSuggestion;
    })
    .filter((suggestion) => suggestion.similarity === null || suggestion.similarity > 0)
    .sort((a, b) => numeric(b.similarity) - numeric(a.similarity));
}

function primitiveEmbeddingText(
  primitive: LaunchPlatformPrimitive,
  metadata: PrimitiveMetadata,
): string {
  return [
    `Ultralight platform primitive: ${primitive}`,
    metadata.label,
    metadata.description,
    metadata.route ? `Website route ${metadata.route}` : '',
    metadata.apiRoute ? `API route ${metadata.apiRoute}` : '',
    'External agents can discover and call this platform function.',
  ].filter(Boolean).join('. ');
}

function primitiveSimilarity(
  primitive: LaunchPlatformPrimitive,
  metadata: PrimitiveMetadata,
  query: string,
): number {
  const text = `${primitive} ${metadata.label} ${metadata.description}`
    .toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const matches = terms.filter((term) => text.includes(term)).length;
  return matches / terms.length;
}

function parseManifest(value: unknown): AppManifest | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as AppManifest;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value as AppManifest;
  return null;
}

function parseKind(value: string | null): LaunchToolKind | 'all' {
  if (!value || value === 'all') return 'all';
  if (
    value === 'mcp' || value === 'http' || value === 'markdown' ||
    value === 'gpu'
  ) {
    return value;
  }
  throw new RequestValidationError(
    'kind must be one of: all, mcp, http, markdown, gpu',
  );
}

function parseLeaderboardKind(value: string | null): LaunchLeaderboardKind {
  if (!value || value === 'builder') return 'builder';
  if (value === 'fee_credit') return 'fee_credit';
  throw new RequestValidationError('kind must be one of: builder, fee_credit');
}

function parseLeaderboardPeriod(value: string | null): '30d' | '90d' | 'all' {
  if (!value || value === '30d') return '30d';
  if (value === '90d' || value === 'all') return value;
  throw new RequestValidationError('period must be one of: 30d, 90d, all');
}

function normalizeLeaderboardUrl(url: URL): URL {
  const normalized = new URL(url.toString());
  normalized.searchParams.delete('kind');
  return normalized;
}

function normalizeQuery(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

function clampLimit(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new RequestValidationError('limit must be an integer');
  }
  if (parsed < 1 || parsed > MAX_DISCOVERY_LIMIT) {
    throw new RequestValidationError(
      `limit must be between 1 and ${MAX_DISCOVERY_LIMIT}`,
    );
  }
  return parsed;
}

function parseLocator(encodedLocator: string): string {
  const locator = decodeURIComponent(encodedLocator).trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(locator)) {
    throw new RequestValidationError('Invalid tool id');
  }
  return locator;
}

async function tryAuthenticate(request: Request): Promise<AuthUser | null> {
  try {
    return await authenticate(request) as AuthUser;
  } catch {
    return null;
  }
}

async function requireLaunchUser(request: Request): Promise<AuthUser> {
  try {
    return await authenticate(request) as AuthUser;
  } catch {
    throw new RequestValidationError('Authentication required', 401);
  }
}

function getDbConfig(): DbConfig {
  const baseUrl = getEnv('SUPABASE_URL');
  const key = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!baseUrl || !key) {
    throw new LaunchServiceUnavailableError('Launch data service unavailable');
  }
  return {
    baseUrl,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  };
}

async function dbGet<T>(
  db: DbConfig,
  table: string,
  params: Record<string, string>,
): Promise<T[]> {
  const url = new URL(`${db.baseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), { headers: db.headers });
  return await readRows<T>(response, `Failed to fetch ${table}`);
}

async function readRows<T>(response: Response, message: string): Promise<T[]> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail ? `${message}: ${detail}` : message);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload as T[] : [payload as T];
}

function publicBaseUrl(request: Request): string {
  const configured = getEnv('BASE_URL');
  const origin = configured || new URL(request.url).origin;
  return origin.replace(/\/+$/, '');
}

function money(light: number): LaunchMoneyAmount {
  const normalized = Number.isFinite(light) ? light : 0;
  return {
    light: normalized,
    display: `${normalized.toLocaleString('en-US')} Light`,
  };
}

function vectorString(embedding: number[]): string {
  return `[${embedding.filter(Number.isFinite).join(',')}]`;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index++) {
    const a = left[index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function roundScore(value: unknown): number {
  const number = numeric(value);
  return Math.round(number * 10_000) / 10_000;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
