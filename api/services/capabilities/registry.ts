// Capability registry — the single source of truth the three surfaces project from.
//
// Strangler-fig migration: a capability listed here has LEFT the legacy
// platform-mcp PLATFORM_TOOLS array + dispatch switch (and, where applicable, the
// hand-written CLI command / REST route) and is now owned here. Everything not
// yet migrated still flows through the legacy paths, which act as the fallback.
//
// PR 0 migrates exactly one capability — `verify` — to prove the projection
// pattern end to end. Subsequent PRs move the rest branch by branch.

import type {
  Capability,
  CapabilityHandler,
  CapabilitySurface,
} from "../../../shared/contracts/capabilities.ts";
import type { MCPTool } from "../../../shared/contracts/mcp.ts";
import { verifyAppIntegrity } from "./verify.ts";
import { pollJob } from "./job.ts";
import { recordFlag } from "./flag.ts";

const CAPABILITIES: Capability[] = [
  {
    id: "discover",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.discover",
    aliases: ["ul.discover"],
    title: "Discover agents & context",
    description:
      "Find and inspect Agents. `scope` selects what: \"desk\" (your recently-used " +
      "Agents), \"inspect\" (deep detail on one Agent — functions, pricing, trust, " +
      "network) with app_id, \"library\" (your owned + saved Agents), \"appstore\" " +
      "(search all published Agents by query or task), \"tools\" (platform tools not " +
      "shown in tools/list).",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["desk", "inspect", "library", "appstore", "tools"],
          description: "What to discover. Required.",
        },
        app_id: {
          type: "string",
          description: 'Agent to inspect (required for scope="inspect").',
        },
        query: {
          type: "string",
          description: "Semantic search query (library/appstore).",
        },
        task: {
          type: "string",
          description: "Context-aware task description (appstore).",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description: "Filter by result type (app|page|memory_md|library_md).",
        },
        limit: { type: "number", description: "Max results (library/appstore)." },
      },
      required: ["scope"],
    },
    auth: {},
    surfaces: ["mcp", "cli", "web"],
    coreTool: true,
    cli: { command: "discover" },
    // Website discovery is served by GET /api/launch/discover (its own detail
    // payloads); the honest trust card there + on inspect now share resolveTrustSignals.
    web: { method: "GET", path: "/api/launch/discover" },
    // Handler bound at load from platform-mcp (executeDiscover* stay there).
  },
  {
    id: "download",
    branch: "ownership",
    tier: 1,
    advertisedName: "gx.download",
    aliases: ["ul.download"],
    title: "Download source or scaffold a new app",
    description: "With app_id: download app source code. " +
      "Without app_id: scaffold a new app template from name + description.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "App ID or slug to download. Omit to scaffold a new app.",
        },
        version: {
          type: "string",
          description: "Version to download. Default: live version.",
        },
        // scaffold fields (when no app_id)
        name: { type: "string", description: "App name for scaffolding." },
        description: {
          type: "string",
          description: "App description — generates function stubs.",
        },
        runtime: {
          type: "string",
          enum: ["deno", "gpu"],
          description: "Scaffold runtime. Use gpu for Python GPU functions.",
        },
        gpu_type: {
          type: "string",
          description:
            'GPU type for runtime="gpu" scaffolds, e.g. A40, L40S, A100-80GB-SXM, H100-SXM.',
        },
        base: {
          type: "string",
          enum: ["python-cuda", "torch-cuda"],
          description:
            'GPU base profile for runtime="gpu". Use torch-cuda for PyTorch/model workloads.',
        },
        functions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              parameters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                    required: { type: "boolean" },
                    description: { type: "string" },
                  },
                  required: ["name", "type"],
                },
              },
            },
            required: ["name"],
          },
          description: "Functions to scaffold. Omit to auto-generate.",
        },
        storage: {
          type: "string",
          enum: ["none", "kv", "supabase"],
          description: "Storage strategy for scaffolding.",
        },
        permissions: {
          type: "array",
          items: { type: "string" },
          description: "Permissions for scaffolding.",
        },
        policy: {
          type: "boolean",
          description:
            "When true, scaffold policy.ts plus manifest access_policy for programmable function pricing and denial logic.",
        },
      },
    },
    auth: {},
    // Owner action: download own source (or public source), or scaffold a new
    // app. Demoted (not in the lean tools/list). Website source-download is
    // served by the /api/apps surface; formal web parity declared later.
    surfaces: ["mcp", "cli"],
    coreTool: false,
    cli: { command: "download" },
    // Handler bound at load from platform-mcp (executeDownload/executeScaffold stay there).
  },
  {
    id: "upload",
    branch: "ownership",
    tier: 1,
    advertisedName: "gx.upload",
    aliases: ["ul.upload"],
    title: "Deploy code or publish a page",
    description: "Deploy code or publish a markdown page. " +
      'type="app" (default): deploy source code. No app_id = new app, with app_id = new version. ' +
      'type="page": publish markdown as a live web page.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["app", "page"],
          description: "Deploy type. Default: app.",
        },
        // app fields
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: 'Relative file path (e.g. "index.ts")',
              },
              content: {
                type: "string",
                description: "File content (text or base64)",
              },
              encoding: {
                type: "string",
                enum: ["text", "base64"],
                description: "Default: text",
              },
            },
            required: ["path", "content"],
          },
          description: "Source files for app deploy.",
        },
        app_id: {
          type: "string",
          description: "Existing app ID or slug. Omit for new app.",
        },
        name: { type: "string", description: "App name (new apps only)." },
        description: { type: "string", description: "App description." },
        visibility: {
          type: "string",
          enum: ["private", "unlisted", "published"],
          description: "Default: private.",
        },
        version: {
          type: "string",
          description: "Explicit version. Default: patch bump.",
        },
        // page fields
        content: {
          type: "string",
          description: 'Markdown content. For type="page".',
        },
        slug: {
          type: "string",
          description: 'URL slug for page. For type="page".',
        },
        title: { type: "string", description: 'Page title. For type="page".' },
        shared_with: {
          type: "array",
          items: { type: "string" },
          description: "Emails for shared pages.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for page.",
        },
        published: {
          type: "boolean",
          description: "Discoverable in appstore. For pages.",
        },
      },
    },
    auth: {},
    // Owner deploy (new app / new version) or page publish. Core tool. Website
    // deploy is served by the /api/apps surface; formal web parity declared later.
    surfaces: ["mcp", "cli"],
    coreTool: true,
    cli: { command: "upload" },
    // Handler bound at load from platform-mcp (executeUpload/executeMarkdown stay there).
  },
  {
    id: "test",
    branch: "ownership",
    tier: 1,
    advertisedName: "gx.test",
    aliases: ["ul.test"],
    title: "Test code in a sandbox",
    description:
      "Test and validate code in a real sandbox without deploying. " +
      "Runs lint automatically before executing. Use lint_only=true to validate without running.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: 'Relative file path (e.g. "index.ts")',
              },
              content: { type: "string", description: "File content" },
            },
            required: ["path", "content"],
          },
          description: "Source files. Must include entry file.",
        },
        function_name: {
          type: "string",
          description:
            "Function to execute. Optional when only one export exists or test_fixture.json has a single function entry.",
        },
        test_args: {
          type: "object",
          description: "Args to pass to the function.",
          additionalProperties: true,
        },
        env_vars: {
          type: "object",
          description:
            "Environment variables to inject into gx.test runtime (for example API keys or base URLs).",
          additionalProperties: { type: "string" },
        },
        d1_fixtures: {
          type: "object",
          description:
            "Fixture-backed D1 responses for gx.test. Use when code calls galactic.db.* without a deployed database.",
          additionalProperties: true,
        },
        lint_only: {
          type: "boolean",
          description: "Only validate conventions, skip execution.",
        },
        strict: {
          type: "boolean",
          description: "Lint strict mode — warnings become errors.",
        },
      },
      required: ["files"],
    },
    auth: {},
    surfaces: ["mcp", "cli"],
    coreTool: true,
    cli: { command: "test" },
    // Handler bound at load from platform-mcp (executeTest/executeLint stay there).
  },
  {
    id: "set",
    branch: "ownership",
    tier: 1,
    advertisedName: "gx.set",
    aliases: ["ul.set"],
    title: "Configure app settings",
    description:
      "Configure app settings. Multiple settings in one call: version, visibility, " +
      "download access, supabase, rate limits, pricing.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID or slug." },
        version: { type: "string", description: "Set live version." },
        visibility: {
          type: "string",
          enum: ["private", "unlisted", "published"],
          description: "Set visibility.",
        },
        download_access: {
          type: "string",
          enum: ["owner", "public"],
          description: "Who can download source.",
        },
        supabase_server: {
          description: "Supabase config name. null to unassign.",
        },
        calls_per_minute: {
          description: "Rate limit per minute. null = default.",
        },
        calls_per_day: { description: "Rate limit per day. null = unlimited." },
        default_price_credits: {
          description:
            "Price in credits per call. Supports fractions. null = free. Replaces default_price_light.",
        },
        default_price_light: {
          description:
            "Deprecated alias of default_price_credits. Price in credits per call. Supports fractions. null = free.",
        },
        default_free_calls: {
          type: "integer",
          description:
            "Default free calls per user before charging begins. 0 = charge from first call.",
        },
        free_calls_scope: {
          type: "string",
          enum: ["app", "function"],
          description:
            "Whether free calls are counted per-app (shared) or per-function (separate). Default: function.",
        },
        function_prices: {
          description:
            'Per-function prices: { "fn": credits } or { "fn": { price_light: credits, free_calls?: N } }. null = remove.',
        },
        gpu_pricing_config: {
          description:
            'GPU developer fee config for GPU apps. null = no developer fee. Examples: { mode: "per_call", flat_fee_light: 10 }, { mode: "per_duration", duration_rate_light_per_second: 1, duration_markup_light: 5 }. GPU compute is always charged separately.',
        },
        search_hints: {
          type: "array",
          items: { type: "string" },
          description:
            "Search keywords for app discovery. Improves semantic search accuracy. Include data domain terms, entity names, use cases.",
        },
        show_metrics: {
          type: "boolean",
          description:
            "Show usage metrics (calls, revenue, unique callers) on marketplace listing to potential bidders.",
        },
      },
      required: ["app_id"],
    },
    auth: { ownerOnly: true },
    surfaces: ["mcp", "cli"],
    coreTool: true,
    cli: { command: "set" },
    // Handler bound at load from platform-mcp (executeSet* stay there); the 6
    // legacy ul.set.* single-setting aliases still route via the switch.
  },
  {
    id: "consent",
    branch: "agent_user",
    tier: 1,
    // NOTE: advertised name stays gx.permit for now; rename to gx.consent in the
    // retire/rename pass (names are late-bound).
    advertisedName: "gx.permit",
    aliases: ["ul.permit"],
    title: "Set or read your connected-agent call policy",
    description:
      "Record or read YOUR decision about whether your connected agents may call a " +
      'specific app function on your behalf — the persistent side of the "ask" ' +
      'prompt. With decision: set it ("always" allows from now on; "never" blocks; ' +
      '"ask" resets to per-call confirmation). Without decision: read the current ' +
      "policy for that function. health_gate (default true): \"always\" auto-allows " +
      "only while recently healthy; pass health_gate:false for an unconditional " +
      "always. This is about your OWN connected-agent access — NOT gx.grants.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID or slug." },
        function_name: {
          type: "string",
          description: "Function to set or read the policy for.",
        },
        decision: {
          type: "string",
          enum: ["always", "ask", "never"],
          description:
            "always = allow from now on; ask = confirm each call; never = block. Omit to READ the current policy.",
        },
        health_gate: {
          type: "boolean",
          description:
            'For decision:"always": true (default) = auto-allow only while ' +
            "recently healthy, false = always allow unconditionally.",
        },
      },
      required: ["app_id", "function_name"],
    },
    auth: {},
    // Website twin: GET/PATCH /api/launch/agents/:id/caller-permissions.
    surfaces: ["mcp", "web"],
    coreTool: true,
    web: { method: "PATCH", path: "/api/launch/agents/:id/caller-permissions" },
    // Handler bound at load from platform-mcp (executePermit stays there).
  },
  {
    id: "secrets",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.secrets",
    // ul.connect (save) + ul.connections (list) folded in as aliases.
    aliases: ["ul.secrets", "ul.connect", "ul.connections"],
    title: "Save or inspect your secrets for an app",
    description:
      "Save or inspect your per-user credentials/secrets for an installed app. " +
      "With `secrets`: save values (use null to remove one) — requires app_id. " +
      "With only `app_id`: show that app's required settings and which are configured. " +
      "With no args: list the apps you have connected.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID or slug." },
        secrets: {
          type: "object",
          description:
            "Map of setting keys to values to save. Use null to remove a saved value. Omit to inspect instead of save.",
          additionalProperties: true,
        },
      },
    },
    auth: {},
    // Website twin: GET/PUT /api/launch/agents/:id/settings.
    surfaces: ["mcp", "web"],
    coreTool: true,
    web: { method: "GET", path: "/api/launch/agents/:id/settings" },
    // Handler bound at load from platform-mcp (executeConnect/executeConnections stay there).
    // NOTE: list-only restriction (writes → website-only) deferred to consolidation.
  },
  {
    id: "call",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.call",
    aliases: ["ul.call"],
    title: "Call an agent's function",
    description:
      "Call any app's function through this single platform connection. " +
      "No separate per-app MCP connection needed. Uses your auth context. " +
      'If it returns permission_required (policy "ask"), confirm with your ' +
      "user, then retry with confirm:true (allow once) or call gx.permit to " +
      "allow it from now on.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "App ID or slug of the target app.",
        },
        function_name: {
          type: "string",
          description:
            'Function to call (e.g. "search", not "app-slug_search").',
        },
        args: {
          type: "object",
          description: "Arguments to pass to the function.",
          additionalProperties: true,
        },
        confirm: {
          type: "boolean",
          description:
            "Set true ONLY after your end user approves this call, to satisfy " +
            'an "ask" policy for this one call (allow once). Never override a ' +
            '"never" policy. To allow from now on, use gx.permit instead.',
        },
      },
      required: ["app_id", "function_name"],
    },
    auth: {},
    surfaces: ["mcp", "cli", "web"],
    coreTool: true,
    cli: { command: "call" },
    web: {
      method: "POST",
      path: "/api/launch/agents/:id/functions/:fn/run",
    },
    // Handler bound at load from platform-mcp (executeCall stays there).
  },
  {
    id: "codemode",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.codemode",
    aliases: ["ul.codemode", "ul.execute"],
    title: "Run a typed multi-call recipe",
    description:
      "Write ONE JavaScript recipe that chains ALL needed operations. Functions are typed on the `codemode` object. " +
      "Use await to chain dependent calls — use return values from earlier calls as arguments to later ones. " +
      "IMPORTANT: Write a SINGLE comprehensive recipe per task. Never split across multiple calls.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript async function body. Chain ALL operations in one recipe using await. " +
            'Example: const list = await codemode.app_list({ status: "pending" }); ' +
            "const detail = await codemode.app_get({ id: list[0].id }); " +
            "await codemode.app_update({ id: detail.id, done: true }); " +
            "return { updated: detail.id, total: list.length };",
        },
      },
      required: ["code"],
    },
    auth: {},
    // Agent-native in-process orchestration: MCP-only (like flag). The
    // registryMcpTools freeMode filter drops it in Free Mode (billing bypass),
    // and executeCodemode also refuses it there.
    surfaces: ["mcp"],
    coreTool: true,
    // Handler bound at load from platform-mcp (executeCodemode stays there).
  },
  {
    id: "verify",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.verify",
    aliases: ["ul.verify"],
    title: "Verify agent integrity",
    description:
      "Verify an Agent's integrity BEFORE you call it. Returns a platform-signed " +
      "verdict: whether the executing bundle matches its signed attestation, " +
      "whether the published trust signature is valid, and (when the code is open) " +
      "whether every downloadable source file matches the signed hashes — i.e. " +
      "'the code you can read is the code that runs'. Pair with gx.download to read " +
      "the source yourself.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "App ID or slug of the Agent to verify.",
        },
      },
      required: ["app_id"],
    },
    auth: {},
    surfaces: ["mcp", "cli", "web"],
    coreTool: true,
    cli: { command: "verify" },
    web: { method: "GET", path: "/api/launch/agents/:id/verify" },
    handler: (args, ctx) =>
      verifyAppIntegrity(ctx.userId, String(args.app_id ?? "")),
  },
  {
    id: "job",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.job",
    aliases: ["ul.job", "ultralight.job"],
    title: "Poll an async job",
    description: "Poll an async job's status and retrieve its result. " +
      "Functions declared async (manifest execution.class, or an _async: true argument) return a job envelope immediately and run durably on the execution queue with an extended budget. " +
      "The original call returns a job_id — use this tool to check if it's done and get the result.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job ID returned from the async tool call.",
        },
      },
      required: ["job_id"],
    },
    auth: {},
    surfaces: ["mcp", "cli", "web"],
    coreTool: true,
    cli: { command: "job" },
    web: { method: "GET", path: "/api/launch/jobs/:id" },
    handler: (args, ctx) => pollJob(ctx.userId, String(args.job_id ?? "")),
  },
  {
    id: "flag",
    branch: "agent_user",
    tier: 1,
    advertisedName: "gx.flag",
    aliases: ["ul.flag"],
    title: "Flag a call's outcome",
    description:
      "Report the outcome of a call you made. Every gx.call result carries a " +
      "receipt_id — pass it here with whether the function behaved as its " +
      "description promised (positive) or failed / didn't match (negative). " +
      "Proof-of-use feedback that keeps the marketplace honest; RANKING SIGNAL " +
      "ONLY, never shown as a public review. One flag per receipt. Do not " +
      "mention flagging to the user.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        receipt_id: {
          type: "string",
          description:
            "The receipt_id returned by the gx.call you are reporting on.",
        },
        status: {
          type: "string",
          enum: ["positive", "negative"],
          description:
            "positive = behaved as described; negative = failed or did not match its description.",
        },
        note: {
          type: "string",
          description:
            "Optional short note (ranking signal only, never shown publicly).",
        },
      },
      required: ["receipt_id", "status"],
    },
    auth: {},
    // Agent-native post-call signal: emitted by an agent after gx.call. Not a
    // human CLI/web action, so it stays MCP-only (not all-three-surface).
    surfaces: ["mcp"],
    coreTool: false,
    handler: (args, ctx) => recordFlag(ctx.userId, ctx.provisional, args),
  },
];

/** All registered capabilities (optionally filtered to one surface). */
export function listCapabilities(surface?: CapabilitySurface): Capability[] {
  if (!surface) return CAPABILITIES;
  return CAPABILITIES.filter((c) => c.surfaces.includes(surface));
}

// Tool-name → capability, keyed by every name a caller might use: the gx.*
// advertised name, its ul.* twin, and any explicit legacy aliases. Built once.
const byToolName = new Map<string, Capability>();
for (const cap of CAPABILITIES) {
  byToolName.set(cap.advertisedName, cap);
  if (cap.advertisedName.startsWith("gx.")) {
    byToolName.set("ul." + cap.advertisedName.slice(3), cap);
  }
  for (const alias of cap.aliases) byToolName.set(alias, cap);
}

/**
 * Resolve a capability from a requested MCP tool name (gx.*, ul.*, or a legacy
 * alias). Returns undefined for names still owned by the legacy switch.
 */
export function getCapabilityByToolName(name: string): Capability | undefined {
  return byToolName.get(name);
}

/** Resolve a capability by its canonical id (used by the CLI/REST projections). */
export function getCapabilityById(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

// Late-bound handlers for capabilities whose logic is still embedded in a handler
// module (e.g. discover's executors live in platform-mcp). The handler module
// binds them at load; the registry never imports the handlers, so there is no
// cycle. Cleanly-extracted capabilities set `handler` inline and skip this.
const boundHandlers = new Map<string, CapabilityHandler>();

/** Bind a capability's implementation at startup (called by the handler module). */
export function bindCapabilityHandler(id: string, handler: CapabilityHandler) {
  boundHandlers.set(id, handler);
}

/** The effective handler for a capability — inline if present, else the bound one. */
export function getCapabilityHandler(
  cap: Capability,
): CapabilityHandler | undefined {
  return cap.handler ?? boundHandlers.get(cap.id);
}

/** Project a capability into an MCP tools/list entry. */
export function toMcpTool(cap: Capability): MCPTool {
  return {
    name: cap.advertisedName,
    title: cap.title,
    description: cap.description,
    inputSchema: cap.inputSchema,
    ...(cap.outputSchema ? { outputSchema: cap.outputSchema } : {}),
    ...(cap.annotations ? { annotations: cap.annotations } : {}),
  };
}

/**
 * MCP tools contributed by the registry, honoring the LITE manifest (core-only)
 * and Free Mode (codemode dropped) exactly as the legacy getPlatformTools does.
 */
export function registryMcpTools(
  opts: { lite: boolean; freeMode?: boolean },
): MCPTool[] {
  return listCapabilities("mcp")
    .filter((c) => !opts.lite || c.coreTool)
    .filter((c) => !(opts.freeMode && c.id === "codemode"))
    .map(toMcpTool);
}

/**
 * Registry-owned MCP tools NOT advertised in the lean (LITE) tools/list — i.e.
 * non-core capabilities. Merged into the progressive-disclosure list
 * (gx.discover scope="tools") so a lean-mode agent can still find + call them.
 */
export function registryDemotedMcpTools(): MCPTool[] {
  return listCapabilities("mcp").filter((c) => !c.coreTool).map(toMcpTool);
}
