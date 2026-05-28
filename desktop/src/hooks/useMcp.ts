// MCP tool execution helper hook.
// Bridges the useChat tool-use loop to the Ultralight MCP platform.

import { useCallback, useMemo } from 'react';
import { executeMcpTool, type ChatTool } from '../lib/api';

// ── Platform Tools (Traditional Mode) ──

/** Full tool set for traditional mode — discover + call + memory */
const TRADITIONAL_TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'ul_discover',
      description:
        'Find and explore apps on the Ultralight platform. ' +
        'scope="desk": last 5 used apps (check first). ' +
        'scope="inspect": deep introspection of one app (requires app_id). ' +
        'scope="library": your owned+saved apps. ' +
        'scope="appstore": all published apps (use query/task for search). ' +
        'Add surfaces=["widget","command_card"] for dashboard-ready surfaces.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['desk', 'inspect', 'library', 'appstore'],
            description: 'Discovery scope.',
          },
          app_id: {
            type: 'string',
            description: 'Required for scope="inspect".',
          },
          query: {
            type: 'string',
            description: 'Semantic search query. For library + appstore.',
          },
          task: {
            type: 'string',
            description: 'Task description for context-aware search. For appstore.',
          },
          surfaces: {
            type: 'array',
            items: { type: 'string', enum: ['function', 'widget', 'command_card'] },
            description: 'Optional dashboard surface filter.',
          },
          limit: {
            type: 'number',
            description: 'Max results. For appstore.',
          },
        },
        required: ['scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_call',
      description:
        "Call any app's function through the Ultralight platform. " +
        'No separate per-app connection needed. Uses your auth context.',
      parameters: {
        type: 'object',
        properties: {
          app_id: {
            type: 'string',
            description: 'App ID or slug of the target app.',
          },
          function_name: {
            type: 'string',
            description: 'Function to call (e.g. "search").',
          },
          args: {
            type: 'object',
            description: 'Arguments to pass to the function.',
          },
        },
        required: ['app_id', 'function_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_memory',
      description:
        'Persistent cross-session memory. ' +
        'action="read": read memory.md. ' +
        'action="write": overwrite/append memory.md. ' +
        'action="recall": get/set a KV key. ' +
        'action="query": list/delete KV keys.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'recall', 'query'],
            description: 'Memory operation.',
          },
          content: { type: 'string', description: 'Markdown content. For write.' },
          append: { type: 'boolean', description: 'Append instead of overwrite. For write.' },
          key: { type: 'string', description: 'KV key. For recall.' },
          value: { type: 'string', description: 'JSON value to store. Omit to retrieve. For recall.' },
          prefix: { type: 'string', description: 'Key prefix filter. For query.' },
        },
        required: ['action'],
      },
    },
  },
];

// ── Platform Tools (Code Mode) ──

/** Minimal tool set for code mode — codemode + memory only.
 *  All app functions are typed and available as `codemode.functionName()` inside recipes.
 *  Discovery via `codemode.discover_library()`. This forces the agent to write recipes. */
const CODE_MODE_TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'ul_codemode',
      description:
        'Write JavaScript to interact with your apps. ' +
        'All functions are typed and available on the `codemode` object. ' +
        'Write an async function body using `await codemode.functionName(args)` and return a result. ' +
        'Use `await codemode.discover_library({ query: "..." })` to find apps dynamically.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'JavaScript async function body. Use `await codemode.functionName(args)` to call tools. ' +
              'Example: const items = await codemode.email_ops_approvals_list({ status: "pending" }); return items;',
          },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_memory',
      description:
        'Persistent cross-session memory. ' +
        'action="read": read memory.md. ' +
        'action="write": overwrite/append memory.md. ' +
        'action="recall": get/set a KV key. ' +
        'action="query": list/delete KV keys.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'recall', 'query'],
            description: 'Memory operation.',
          },
          content: { type: 'string', description: 'Markdown content. For write.' },
          append: { type: 'boolean', description: 'Append instead of overwrite. For write.' },
          key: { type: 'string', description: 'KV key. For recall.' },
          value: { type: 'string', description: 'JSON value to store. Omit to retrieve. For recall.' },
          prefix: { type: 'string', description: 'Key prefix filter. For query.' },
        },
        required: ['action'],
      },
    },
  },
];

// ── System Agent Tools (full platform access) ──

/** All platform tools available for system agents.
 *  System agents get a filtered subset based on their toolScope config. */
const ALL_PLATFORM_TOOLS: ChatTool[] = [
  ...TRADITIONAL_TOOLS, // ul_discover, ul_call, ul_memory
  ...CODE_MODE_TOOLS.filter(t => t.function.name === 'ul_codemode'), // ul_codemode (without duplicate ul_memory)
  {
    type: 'function',
    function: {
      name: 'ul_command',
      description:
        'Inspect and configure Command dashboards and draft generated agentic interfaces from installed widgets/cards, context, and MCP functions.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'inventory',
              'blueprint',
              'interface',
              'interface_data',
              'interface_action',
              'save_interface',
              'list_interfaces',
              'get_interface',
              'delete_interface',
              'save',
              'list',
              'get',
            ],
          },
          query: { type: 'string', description: 'Search installed command surfaces.' },
          prompt: { type: 'string', description: 'Natural-language dashboard/interface goal.' },
          surfaces: { type: 'array', items: { type: 'string', enum: ['widget', 'command_card'] } },
          limit: { type: 'number', description: 'Max cards/surfaces.' },
          max_components: { type: 'number', description: 'Max generated interface components.' },
          mode: { type: 'string', enum: ['temporary', 'saved'], description: 'Desired interface mode.' },
          include_data_preview: { type: 'boolean', description: 'Include safe read-only D1/context preview.' },
          spec: { type: 'object', description: 'Verified AgenticInterfaceSpec for data, action, or save operations.' },
          action_id: { type: 'string', description: 'Generated interface action id.' },
          args: { type: 'object', description: 'Generated interface action args.' },
          confirmed: { type: 'boolean', description: 'True after explicit user confirmation for write actions.' },
          binding_ids: { type: 'array', items: { type: 'string' }, description: 'Specific generated interface binding ids to refresh.' },
          app_id: { type: 'string', description: 'Optional app ID scope.' },
          app_slug: { type: 'string', description: 'Optional app slug scope.' },
          app_scope: { type: 'object', description: 'Optional app scope for interface planning.' },
          dashboard_key: { type: 'string', description: 'Saved dashboard key.' },
          interface_key: { type: 'string', description: 'Saved generated interface key.' },
          title: { type: 'string', description: 'Dashboard or generated interface title.' },
          description: { type: 'string', description: 'Dashboard or generated interface description.' },
          icon: { type: 'string', description: 'Small icon token for dashboard or interface switchers.' },
          source_prompt: { type: 'string', description: 'Original prompt for a saved generated interface.' },
          status: { type: 'string', enum: ['active', 'archived'], description: 'Saved generated interface status.' },
          layout: { type: 'object', description: 'CommandDashboardLayout to save.' },
          blueprint: { type: 'object', description: 'Blueprint returned by action="blueprint".' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_upload',
      description:
        'Deploy code or publish a markdown page. ' +
        'type="app" (default): deploy source code. No app_id = new app, with app_id = new version. ' +
        'type="page": publish markdown as a live web page.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['app', 'page'], description: 'Deploy type. Default: app.' },
          files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Source files for app deploy.' },
          app_id: { type: 'string', description: 'Existing app ID or slug. Omit for new app.' },
          name: { type: 'string', description: 'App name (new apps only).' },
          description: { type: 'string', description: 'App description.' },
          visibility: { type: 'string', enum: ['private', 'unlisted', 'published'] },
          content: { type: 'string', description: 'Markdown content. For type="page".' },
          slug: { type: 'string', description: 'URL slug for page.' },
          title: { type: 'string', description: 'Page title.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_download',
      description:
        'Download app source code (with app_id), or scaffold a new app template (without app_id).',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: 'App ID or slug to download. Omit to scaffold.' },
          name: { type: 'string', description: 'App name for scaffolding.' },
          description: { type: 'string', description: 'App description for scaffolding.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_test',
      description: 'Test code in a real sandbox without deploying. Runs lint automatically.',
      parameters: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Source files.' },
          function_name: { type: 'string', description: 'Function to execute.' },
          test_args: { type: 'object', description: 'Args to pass.' },
          lint_only: { type: 'boolean', description: 'Only validate, skip execution.' },
        },
        required: ['files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_set',
      description: 'Configure app settings: version, visibility, pricing, rate limits.',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: 'App ID or slug.' },
          version: { type: 'string', description: 'Set live version.' },
          visibility: { type: 'string', enum: ['private', 'unlisted', 'published'] },
          default_price_light: { description: 'Price in Light per call. null = free.' },
          default_free_calls: { type: 'number', description: 'Free calls before charging.' },
          calls_per_minute: { description: 'Rate limit per minute.' },
          calls_per_day: { description: 'Rate limit per day.' },
          search_hints: { type: 'array', items: { type: 'string' }, description: 'Keywords for discovery.' },
        },
        required: ['app_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_permissions',
      description: 'Manage app access: grant, revoke, list, export audit log.',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: 'App ID or slug.' },
          action: { type: 'string', enum: ['grant', 'revoke', 'list', 'export'] },
          email: { type: 'string', description: 'Target user email.' },
          functions: { type: 'array', items: { type: 'string' }, description: 'Function names.' },
        },
        required: ['app_id', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_logs',
      description: 'View call logs and health events for an app.',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: 'App ID or slug.' },
          health: { type: 'boolean', description: 'View health events instead.' },
          since: { type: 'string', description: 'ISO timestamp filter.' },
          limit: { type: 'number', description: 'Max results.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_marketplace',
      description:
        'Query the app marketplace: browse published apps, search by keyword or category, ' +
        'get trending tools, check pricing. Returns app listings with descriptions and metrics.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          category: { type: 'string', description: 'Filter by category.' },
          sort: { type: 'string', enum: ['popular', 'newest', 'price_low', 'price_high'] },
          limit: { type: 'number', description: 'Max results.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_rate',
      description:
        'Rate an app: "like" saves to library, "dislike" hides, "none" removes. ' +
        'Include shortcoming to report a platform issue.',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: 'App ID or slug.' },
          rating: { type: 'string', enum: ['like', 'dislike', 'none'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ul_auth_link',
      description: 'Link third-party accounts (OAuth). Manages external service connections.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'Service provider to link.' },
          action: { type: 'string', enum: ['link', 'unlink', 'status'] },
        },
        required: ['provider', 'action'],
      },
    },
  },
];

// ── Tool Name Mapping ──

/** Map from chat tool names (underscored) to MCP tool names (dotted) */
const TOOL_NAME_MAP: Record<string, string> = {
  'ul_discover': 'ul.discover',
  'ul_call': 'ul.call',
  'ul_codemode': 'ul.codemode',
  'ul_memory': 'ul.memory',
  'ul_command': 'ul.command',
  'ul_rate': 'ul.rate',
  'ul_upload': 'ul.upload',
  'ul_download': 'ul.download',
  'ul_test': 'ul.test',
  'ul_set': 'ul.set',
  'ul_permissions': 'ul.permissions',
  'ul_logs': 'ul.logs',
  'ul_marketplace': 'ul.marketplace',
  'ul_auth_link': 'ul.auth.link',
};

// ── Hook ──

export interface UseMcpReturn {
  /** Tools to pass to useChat (code mode default) */
  tools: ChatTool[];
  /** All platform tools — system agents filter from this set */
  allPlatformTools: ChatTool[];
  /** Tool execution handler for useChat's onToolCall */
  executeToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export function useMcp(): UseMcpReturn {
  const executeToolCall = useCallback(async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    // Map underscored names to dotted MCP names
    const mcpName = TOOL_NAME_MAP[name] || name;

    try {
      const result = await executeMcpTool(mcpName, args);

      if (result.isError) {
        return `Error: ${result.content.map(c => c.text).join('\n')}`;
      }

      return result.content.map(c => c.text).join('\n');
    } catch (err) {
      return `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }, []);

  // Code mode is the default for all models
  const tools = useMemo(() => CODE_MODE_TOOLS, []);

  // All platform tools — for system agents to filter from
  const allPlatformTools = useMemo(() => ALL_PLATFORM_TOOLS, []);

  return { tools, allPlatformTools, executeToolCall };
}
