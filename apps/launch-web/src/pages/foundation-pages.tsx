import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  AgentCallerTrustSummary,
  AgentGrantSummary,
  AgentImportSlot,
  AgentWiringTarget,
  AgentWiringView,
} from "../../../../shared/contracts/agent-grants.ts";
import { DEFAULT_GRANT_MONTHLY_CAP_CREDITS } from "../../../../shared/contracts/agent-grants.ts";
import {
  LAUNCH_SCOPE_CONTRACT,
  type LaunchCallerFunctionPermissionsResponse,
  type LaunchApiKeySummary,
  type LaunchByokProviderOption,
  type LaunchDeferredCapability,
  type LaunchFunctionSummary,
  type LaunchIncludedCapability,
  type LaunchInferenceOptionsResponse,
  type LaunchInstallInstruction,
  type LaunchLeaderboardEntry,
  type LaunchMoneyAmount,
  type LaunchPublisherPublishRequirement,
  type LaunchAgentRelationship,
  type LaunchAgentSummary,
  type LaunchTrustCard,
  type LaunchWalletEarningSummary,
  type LaunchWalletReceiptSummary,
  type LaunchWalletSummary,
  type LaunchWalletTransaction,
} from "../../../../shared/contracts/launch.ts";
import type { LaunchPageProps } from "../App";
import {
  getLaunchAuthDiagnostic,
  hasLaunchAuthToken,
  signOutLaunch,
} from "../lib/auth";
import { launchApi } from "../lib/api";
import {
  Avatar,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Icon,
  Metric,
  Mono,
  PageHeader,
  Pill,
  RouteButton,
  RouteLink,
  Section,
} from "../components/launch-chrome";
import agentClaudeUrl from "../assets/agents/agent-claude.png";
import agentCodexUrl from "../assets/agents/agent-codex.png";
import agentCursorUrl from "../assets/agents/agent-cursor.png";
import agentOpenclawUrl from "../assets/agents/agent-openclaw.png";

interface AgentFixture {
  author: string;
  callPrice: number;
  category: string;
  color: string;
  free?: boolean;
  growth: number;
  id: string;
  installs: number;
  kind: "gpu" | "http" | "markdown" | "mcp";
  name: string;
  slug: string;
  spark: number[];
  summary: string;
}

interface InstallTarget {
  config: (key: string) => string;
  description: string;
  group: "MCP" | "Direct";
  label: string;
  requiresApiKey: boolean;
  steps: string[];
  target: string;
}

interface LeaderboardRow {
  color: string;
  eventCount: number;
  featured?: string;
  name: string;
  rank: number;
  value: number;
}

interface AgentCapability {
  kind: "read" | "write" | "net";
  text: string;
}

interface AgentFunctionFixture {
  args: string[];
  description: string;
  name: string;
  p50: number;
  permission: "always" | "ask" | "never";
  price: number;
}

interface AgentDetailFixture extends AgentFixture {
  callsPerDay: number;
  capabilities: AgentCapability[];
  functions: AgentFunctionFixture[];
  relationship: LaunchAgentRelationship;
  runtime: string;
  signer: string;
  title: string;
  updatedAt: string;
  version: string;
  visibility: "public" | "private" | "unlisted";
}

const apiKeyMask = "ulk_live_••••••••••••4xN4";
const apiKeyPlaceholder = "$ULTRALIGHT_API_KEY";
const mcpUrl = "https://api.ultralight.dev/mcp/platform";

function agentPreviewPath(tool: Pick<AgentDetailFixture, "slug">): string {
  return `/agents/${encodeURIComponent(tool.slug)}`;
}

const orbitAgents = [
  { alt: "Codex", className: "agent-one", src: agentCodexUrl },
  { alt: "Cursor", className: "agent-two", src: agentCursorUrl },
  { alt: "OpenClaw", className: "agent-three", src: agentOpenclawUrl },
  { alt: "Claude", className: "agent-four", src: agentClaudeUrl },
] as const;

const discoverAgents: AgentFixture[] = [
  {
    author: "@kepler",
    callPrice: 0.012,
    category: "Weather",
    color: "#7c3aed",
    growth: 0.18,
    id: "tool_8fa21c",
    installs: 24803,
    kind: "mcp",
    name: "get_weather",
    slug: "get_weather",
    spark: [11, 13, 16, 12, 17, 21, 28],
    summary: "Hyper-local weather, forecasts, and severe-weather alerts.",
  },
  {
    author: "@anchor",
    callPrice: 0.003,
    category: "Finance",
    color: "#0891b2",
    growth: 0.06,
    id: "tool_3b90de",
    installs: 19402,
    kind: "http",
    name: "currency_convert",
    slug: "currency_convert",
    spark: [14, 15, 16, 15, 17, 18, 19],
    summary: "Live FX across 180+ pairs with spot and historical rates.",
  },
  {
    author: "stripe",
    callPrice: 0.024,
    category: "Payments",
    color: "#635bff",
    growth: 0.31,
    id: "tool_st",
    installs: 18204,
    kind: "http",
    name: "stripe.subscribe",
    slug: "stripe_subscribe",
    spark: [10, 9, 12, 16, 18, 22, 30],
    summary: "Create subscriptions, meter usage, and return receipts.",
  },
  {
    author: "@vellum",
    callPrice: 0.018,
    category: "Docs",
    color: "#ea580c",
    growth: 0.12,
    id: "tool_pd",
    installs: 15211,
    kind: "mcp",
    name: "pdf.parse",
    slug: "pdf_parse",
    spark: [12, 13, 14, 15, 16, 17, 19],
    summary: "Layout-aware PDF text, table, and citation extraction.",
  },
  {
    author: "@octo",
    callPrice: 0.005,
    category: "Code",
    color: "#0a0a0a",
    free: true,
    growth: 0.09,
    id: "tool_gh",
    installs: 14093,
    kind: "mcp",
    name: "github.diff",
    slug: "github_diff",
    spark: [13, 14, 14, 15, 16, 16, 17],
    summary: "Branch diff, review comments, and CI status summaries.",
  },
  {
    author: "@cartography",
    callPrice: 0.008,
    category: "Maps",
    color: "#10b981",
    free: true,
    growth: 0.21,
    id: "tool_mp",
    installs: 12705,
    kind: "http",
    name: "maps.route",
    slug: "maps_route",
    spark: [9, 10, 11, 12, 13, 15, 16],
    summary: "Driving, walking, and transit ETAs for agent plans.",
  },
];

const primitives = [
  [
    "install",
    "Install Ultralight",
    "Connect the MCP/API layer to an existing agent.",
    "/install",
  ],
  [
    "discover",
    "Discover Agents",
    "Find public Agents your connected agent can call.",
    "/store",
  ],
  [
    "wallet",
    "Credits wallet",
    "Spendable credits for installs, calls, hosting.",
    "/wallet",
  ],
] as const;

const builderLeaders: LeaderboardRow[] = [
  {
    rank: 1,
    name: "@kepler",
    color: "#7c3aed",
    value: 4820.4,
    eventCount: 268000,
    featured: "get_weather",
  },
  {
    rank: 2,
    name: "stripe",
    color: "#635bff",
    value: 3910.2,
    eventCount: 142000,
    featured: "stripe.subscribe",
  },
  {
    rank: 3,
    name: "@anchor",
    color: "#0891b2",
    value: 2740.8,
    eventCount: 198000,
    featured: "currency_convert",
  },
  {
    rank: 4,
    name: "@vellum",
    color: "#ea580c",
    value: 1690.0,
    eventCount: 64000,
    featured: "pdf.parse",
  },
  {
    rank: 5,
    name: "@cartography",
    color: "#10b981",
    value: 1120.5,
    eventCount: 88000,
    featured: "maps.route",
  },
];

const feeLeaders: LeaderboardRow[] = [
  {
    rank: 1,
    name: "stripe",
    color: "#635bff",
    value: 1284.0,
    eventCount: 5120,
  },
  {
    rank: 2,
    name: "@kepler",
    color: "#7c3aed",
    value: 942.6,
    eventCount: 4380,
  },
  { rank: 3, name: "@octo", color: "#0a0a0a", value: 770.2, eventCount: 2010 },
  {
    rank: 4,
    name: "@anchor",
    color: "#0891b2",
    value: 615.4,
    eventCount: 3160,
  },
  { rank: 5, name: "@hex", color: "#22c55e", value: 402.1, eventCount: 1890 },
];

const installTargets: InstallTarget[] = [
  {
    config: (key) => genericMcpConfig(key),
    description:
      "Add Ultralight as a remote MCP server for an existing Claude Code workspace.",
    group: "MCP",
    label: "Claude Code",
    requiresApiKey: true,
    steps: [
      "Create an Ultralight API token from Settings.",
      "Set ULTRALIGHT_API_KEY in your shell or Claude Code environment.",
      "Add the remote MCP server with an Authorization header.",
    ],
    target: "claude_code",
  },
  {
    config: (key) => genericMcpConfig(key),
    description:
      "Install the Ultralight MCP server in Cursor's MCP configuration.",
    group: "MCP",
    label: "Cursor",
    requiresApiKey: true,
    steps: [
      "Open Cursor MCP settings.",
      "Add the ultralight server entry below.",
      "Reload Cursor so your connected agent can discover Ultralight Agents.",
    ],
    target: "cursor",
  },
  {
    config: (key) =>
      `[mcp_servers.ultralight]\nurl = "${mcpUrl}"\nheaders = { Authorization = "Bearer ${key}" }`,
    description:
      "Connect Codex to the same remote MCP endpoint used by other agents.",
    group: "MCP",
    label: "Codex",
    requiresApiKey: true,
    steps: [
      "Create an Ultralight API token.",
      "Add a remote MCP server named ultralight.",
      "Use the platform MCP endpoint and Authorization header below.",
    ],
    target: "codex",
  },
  {
    config: (key) =>
      JSON.stringify(
        { server_url: mcpUrl, authorization: `Bearer ${key}` },
        null,
        2,
      ),
    description:
      "Register Ultralight as a remote MCP server for OpenAI agent runtimes that support MCP tools.",
    group: "MCP",
    label: "OpenAI Remote MCP",
    requiresApiKey: true,
    steps: [
      "Use the platform MCP endpoint as the server URL.",
      "Pass your Ultralight API token as a bearer Authorization header.",
      "Allow your connected agent to list available Agents before calling specific ones.",
    ],
    target: "openai_remote_mcp",
  },
  {
    config: (key) => genericMcpConfig(key),
    description:
      "Use the standard remote MCP server declaration for any compatible agent.",
    group: "MCP",
    label: "Generic MCP",
    requiresApiKey: true,
    steps: [
      "Copy the server configuration into your agent's MCP config.",
      "Replace the API token placeholder with an Ultralight API token.",
      "Restart the agent or refresh its tool registry.",
    ],
    target: "generic_mcp",
  },
  {
    config: (key) =>
      `npm install -g ultralightpro\nultralight login --token ${key}\nultralight upload .`,
    description:
      "Use the Ultralight CLI to login, upload, test, and run deployed Agents.",
    group: "Direct",
    label: "CLI",
    requiresApiKey: true,
    steps: [
      "Install the ultralightpro package.",
      "Run ultralight login --token <your-token>.",
      "Run ultralight upload . from a deployable Agent directory.",
    ],
    target: "cli",
  },
  {
    config: (key) =>
      `curl "https://api.ultralight.dev/api/launch/status"\ncurl -H "Authorization: Bearer ${key}" \\\n  "https://api.ultralight.dev/api/launch/library"`,
    description:
      "Call launch and platform endpoints directly with an Ultralight API token.",
    group: "Direct",
    label: "Direct API",
    requiresApiKey: true,
    steps: [
      "Create an API token from Settings.",
      "Send Authorization: Bearer <token> on authenticated requests.",
      "Read /api/launch/status and /openapi.json before calling.",
    ],
    target: "api",
  },
];

const externalLoop = [
  "Install MCP / CLI / API",
  "Discover Agents + primitives",
  "Inspect pricing + trust",
  "Call through MCP / API",
  "Return results + receipts",
];

const defaultCapabilities: AgentCapability[] = [
  { kind: "read", text: "public source data" },
  { kind: "net", text: "outbound HTTPS" },
];

const agentDetails: Record<string, AgentDetailFixture> = Object.fromEntries(
  discoverAgents.map((tool) => {
    const detail = createAgentDetail(tool);
    return [detail.slug, detail];
  }),
);

const installedLibrarySlugs = [
  "currency_convert",
  "pdf_parse",
  "maps_route",
  "github_diff",
];
const ownedLibrarySlugs = ["get_weather"];

const adminTabs = [
  ["edit", "Edit"],
  ["pricing", "Pricing"],
  ["secrets", "Secrets"],
  ["trust", "Trust"],
  ["receipts", "Receipts"],
  ["logs", "Logs"],
] as const;

type AdminTabId = typeof adminTabs[number][0];
type LibraryView = "installed" | "owned";
type StoreKindFilter = "all" | AgentFixture["kind"];
type AgentPageTabId = "details" | "functions" | "wiring";

const visibilityOptions = [
  [
    "public",
    "Public",
    "Listed in the Store, installable by anyone.",
  ],
  [
    "unlisted",
    "Unlisted",
    "Reachable by direct link only. Not indexed in the Store.",
  ],
  [
    "private",
    "Private",
    "Only you can see and call it. Hidden everywhere else.",
  ],
] as const;

const adminSecrets = [
  { key: "OPENWEATHER_API_KEY", set: true },
  { key: "NOAA_TOKEN", set: true },
  { key: "CACHE_TTL_SECONDS", set: false },
] as const;

const adminReceipts = [
  {
    caller: "@arbiter",
    fn: "forecast",
    light: 0.012,
    status: "ok",
    when: "1m",
  },
  { caller: "agent_7f", fn: "now", light: 0.004, status: "ok", when: "3m" },
  {
    caller: "@nimbus",
    fn: "historical",
    light: 0.018,
    status: "ok",
    when: "12m",
  },
  {
    caller: "agent_2b",
    fn: "alerts",
    light: 0.006,
    status: "error",
    when: "28m",
  },
] as const;

const adminLogs = [
  { fn: "forecast", ms: 142, status: "ok", when: "1m" },
  { fn: "now", ms: 68, status: "ok", when: "3m" },
  {
    fn: "alerts",
    ms: 0,
    note: "upstream 503 · api.openweather.com",
    status: "error",
    when: "28m",
  },
  { fn: "historical", ms: 280, status: "ok", when: "1h" },
] as const;

type WalletTabId = "balance" | "earnings" | "receipts" | "topup";
type PaymentMethod = "ach" | "card" | "earnings";

interface LedgerRow {
  amount: number;
  detail: string;
  kind: "call" | "earning" | "payout" | "topup" | "transfer";
  when: string;
}

interface ReceiptRowFixture {
  fn: string;
  latency: number;
  light: number;
  status: "error" | "ok";
  tool: string;
  when: string;
}

interface ApiKeyFixture {
  created: string;
  id?: string;
  lastUsed: string;
  name: string;
  prefix: string;
  scopes: string;
}

const walletSummary = {
  deposited: 815.0,
  earned: 4820.402,
  escrow: 26.0,
  spendable: 1240.402,
};

const walletLedger: LedgerRow[] = [
  {
    amount: -0.012,
    detail: "get_weather · forecast",
    kind: "call",
    when: "2m",
  },
  {
    amount: -0.002,
    detail: "currency_convert · convert",
    kind: "call",
    when: "14m",
  },
  { amount: 2500, detail: "Top up · card", kind: "topup", when: "3h" },
  { amount: -0.018, detail: "pdf.parse · extract", kind: "call", when: "6h" },
  { amount: 2500, detail: "Earnings → Balance", kind: "transfer", when: "1d" },
  { amount: -0.008, detail: "maps.route · route", kind: "call", when: "1d" },
  {
    amount: -50000,
    detail: "Payout · Bank (ACH) ···4821",
    kind: "payout",
    when: "4d",
  },
];

const walletEarnings: LedgerRow[] = [
  {
    amount: 248.0,
    detail: "get_weather · forecast",
    kind: "earning",
    when: "5h",
  },
  {
    amount: 120.4,
    detail: "tweet.draft · compose",
    kind: "earning",
    when: "8h",
  },
  { amount: 40.0, detail: "radar.tile · render", kind: "earning", when: "1d" },
  { amount: 192.0, detail: "get_weather · now", kind: "earning", when: "1d" },
  { amount: 40.0, detail: "radar.tile · render", kind: "earning", when: "3d" },
];

const walletReceipts: ReceiptRowFixture[] = [
  {
    fn: "forecast",
    latency: 142,
    light: 0.012,
    status: "ok",
    tool: "get_weather",
    when: "2m",
  },
  {
    fn: "convert",
    latency: 84,
    light: 0.002,
    status: "ok",
    tool: "currency_convert",
    when: "14m",
  },
  {
    fn: "extract",
    latency: 480,
    light: 0.018,
    status: "ok",
    tool: "pdf.parse",
    when: "1d",
  },
  {
    fn: "route",
    latency: 195,
    light: 0.008,
    status: "error",
    tool: "maps.route",
    when: "2d",
  },
];

const apiKeys: ApiKeyFixture[] = [
  {
    created: "12 Apr",
    lastUsed: "2m",
    name: "Claude Code · laptop",
    prefix: "ulk_live_••••4xN4",
    scopes: "mcp · api",
  },
  {
    created: "3 Mar",
    lastUsed: "1d",
    name: "CI deploy",
    prefix: "ulk_live_••••9aQ2",
    scopes: "cli",
  },
  {
    created: "28 Feb",
    lastUsed: "6d",
    name: "Cursor",
    prefix: "ulk_live_••••7bX1",
    scopes: "mcp",
  },
];

const byokProviderFixtures: LaunchByokProviderOption[] = [
  {
    apiKeyPrefix: "sk-or-",
    apiKeyUrl: "https://openrouter.ai/keys",
    configured: false,
    defaultModel: "deepseek/deepseek-v4-flash",
    description: "Access 100+ models from one API key",
    id: "openrouter",
    name: "OpenRouter",
    primary: false,
  },
  {
    apiKeyPrefix: "sk-",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    configured: false,
    description: "Use GPT models with your own OpenAI key",
    id: "openai",
    name: "OpenAI",
    primary: false,
  },
];

const livePalette = [
  "#7c3aed",
  "#0891b2",
  "#635bff",
  "#ea580c",
  "#0a0a0a",
  "#10b981",
];

function liveAgentFixture(
  tool: LaunchAgentSummary,
  options: {
    functions?: LaunchFunctionSummary[];
    permissions?: LaunchCallerFunctionPermissionsResponse;
    trustCard?: LaunchTrustCard;
  } = {},
): AgentDetailFixture {
  const base = agentDetails[tool.slug] || createAgentDetail({
    author: liveOwnerLabel(tool.owner),
    callPrice: creditsValue(tool.pricing?.defaultCallPrice),
    category: tool.tags?.[0] || tool.kind.toUpperCase(),
    color: stableColor(tool.id),
    free: creditsValue(tool.pricing?.defaultCallPrice) === 0,
    growth: Math.max(0.03, Number(tool.relevance?.score || 0.08)),
    id: tool.id,
    installs: 0,
    kind: tool.kind,
    name: tool.name,
    slug: tool.slug,
    spark: stableSpark(tool.id),
    summary: tool.description || "Agent published on Ultralight.",
  });
  const permissions = new Map(
    (options.permissions?.permissions || []).map((
      entry,
    ) => [entry.functionName, entry.policy]),
  );
  const functions = options.functions && options.functions.length > 0
    ? options.functions.map((fn, index) => ({
      args: inputArgs(fn.inputSchema),
      description: fn.description || `Run ${fn.name}.`,
      name: fn.name,
      p50: base.functions[index]?.p50 || 120,
      permission: permissions.get(fn.name) || fn.callerPermission?.policy ||
        fn.agentPermission?.policy ||
        base.functions[index]?.permission || "ask",
      price: creditsValue(fn.pricing?.defaultCallPrice),
    }))
    : base.functions;
  const trust = options.trustCard;
  const paidFunctionPrices = functions.map((fn) => fn.price).filter((price) =>
    price > 0
  );
  const callPrice = creditsValue(tool.pricing?.defaultCallPrice) ||
    (paidFunctionPrices.length > 0
      ? Math.min(...paidFunctionPrices)
      : base.callPrice);

  return {
    ...base,
    author: liveOwnerLabel(tool.owner),
    callPrice,
    category: tool.tags?.[0] || base.category,
    color: base.color || stableColor(tool.id),
    free: callPrice === 0,
    functions,
    id: tool.id,
    kind: tool.kind,
    name: tool.name,
    relationship: tool.relationship,
    runtime: trust?.runtime || base.runtime,
    signer: trust?.signer || base.signer,
    slug: tool.slug,
    summary: tool.description || base.summary,
    title: titleizeAgentName(tool.name),
    updatedAt: relativeTime(tool.updatedAt) || base.updatedAt,
    version: trust?.version || base.version,
    visibility: tool.visibility,
  };
}

function liveStoreAgents(tools?: LaunchAgentSummary[]): AgentFixture[] {
  if (!tools || tools.length === 0) return discoverAgents;
  return tools.map((tool) => liveAgentFixture(tool));
}

function liveDetailAgent(
  tool?: LaunchAgentSummary,
  functions?: LaunchFunctionSummary[],
  permissions?: LaunchCallerFunctionPermissionsResponse,
  trustCard?: LaunchTrustCard,
): AgentDetailFixture | null {
  return tool
    ? liveAgentFixture(tool, { functions, permissions, trustCard })
    : null;
}

function liveOwnerLabel(owner: LaunchAgentSummary["owner"]): string {
  if (owner.profileSlug) {
    return owner.profileSlug.startsWith("@")
      ? owner.profileSlug
      : `@${owner.profileSlug}`;
  }
  if (owner.displayName) {
    return owner.displayName.startsWith("@")
      ? owner.displayName
      : `@${owner.displayName}`;
  }
  return `@${owner.userId.slice(0, 6)}`;
}

function creditsValue(amount?: LaunchMoneyAmount | null): number {
  // Credits-first with a fallback to the deprecated `light` alias while older
  // API deployments are still in the rename window.
  return Number(amount?.credits ?? amount?.light ?? 0);
}

function inputArgs(schema?: Record<string, unknown> | null): string[] {
  const props = asRecord(schema?.properties);
  return props ? Object.keys(props).slice(0, 8) : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableColor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return livePalette[hash % livePalette.length];
}

function stableSpark(seed: string): number[] {
  let hash = 0;
  for (const char of seed) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return Array.from(
    { length: 7 },
    (_, index) => 8 + ((hash >> (index * 3)) & 15),
  );
}

function liveInstallTargets(
  instructions?: LaunchInstallInstruction[],
): InstallTarget[] {
  if (!instructions || instructions.length === 0) return installTargets;
  return instructions.map((instruction) => ({
    config: () => instruction.configText || "",
    description: instruction.description,
    group: instruction.target === "cli" || instruction.target === "api"
      ? "Direct"
      : "MCP",
    label: instruction.label,
    requiresApiKey: instruction.requiresApiKey,
    steps: instruction.steps,
    target: instruction.target,
  }));
}

function liveApiKeyFixtures(
  keys?: LaunchApiKeySummary[],
  useFallback = true,
): ApiKeyFixture[] {
  if (!keys || keys.length === 0) return useFallback ? apiKeys : [];
  return keys.map((key) => ({
    created: shortDate(key.createdAt),
    id: key.id,
    lastUsed: relativeTime(key.lastUsedAt) || "never",
    name: key.name,
    prefix: key.tokenPrefix,
    scopes: key.scopes.join(" · ") || "all",
  }));
}

function liveLeaderboardRows(
  entries?: LaunchLeaderboardEntry[],
): LeaderboardRow[] {
  if (!entries || entries.length === 0) return [];
  return entries.map((entry) => ({
    color: stableColor(entry.userId),
    eventCount: entry.eventCount || 0,
    featured: entry.featuredTool?.name,
    name: entry.profileSlug
      ? `@${entry.profileSlug}`
      : entry.displayName || `@${entry.userId.slice(0, 6)}`,
    rank: entry.rank,
    value: creditsValue(entry.value),
  }));
}

function liveWalletTotals(wallet?: LaunchWalletSummary): typeof walletSummary {
  if (!wallet) return walletSummary;
  return {
    deposited: creditsValue(wallet.depositBalance),
    earned: creditsValue(wallet.earnedBalance),
    escrow: creditsValue(wallet.escrowBalance),
    spendable: creditsValue(wallet.spendableBalance || wallet.balance),
  };
}

function liveLedgerRows(transactions?: LaunchWalletTransaction[]): LedgerRow[] {
  if (!transactions || transactions.length === 0) return walletLedger;
  return transactions.map((entry) => ({
    amount: creditsValue(entry.amount),
    detail: entry.appName
      ? `${entry.appName} · ${entry.description}`
      : entry.description,
    kind: ledgerKind(entry.category, entry.type),
    when: relativeTime(entry.createdAt) || "now",
  }));
}

function liveEarningRows(earnings?: LaunchWalletEarningSummary[]): LedgerRow[] {
  if (!earnings || earnings.length === 0) return walletEarnings;
  return earnings.map((entry) => ({
    amount: creditsValue(entry.amount),
    detail: `${entry.appId || "agent"} · ${entry.functionName || entry.reason}`,
    kind: "earning",
    when: relativeTime(entry.createdAt) || "now",
  }));
}

function liveReceiptRows(
  receipts?: LaunchWalletReceiptSummary[],
): ReceiptRowFixture[] {
  if (!receipts || receipts.length === 0) return walletReceipts;
  return receipts.map((receipt) => ({
    fn: receipt.functionName || "run",
    latency: 0,
    light: creditsValue(receipt.total),
    status: receipt.success ? "ok" : "error",
    tool: receipt.appName || receipt.appId || "agent",
    when: relativeTime(receipt.createdAt) || "now",
  }));
}

function ledgerKind(category: string, type: string): LedgerRow["kind"] {
  const value = `${category} ${type}`.toLowerCase();
  if (value.includes("earning")) return "earning";
  if (value.includes("payout")) return "payout";
  if (value.includes("top") || value.includes("deposit")) return "topup";
  if (value.includes("transfer")) return "transfer";
  return "call";
}

function relativeTime(value?: string | null): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds || 1}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function shortDate(value?: string | null): string {
  if (!value) return "now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function ApiNotice({
  live,
  noun,
}: {
  live: LaunchPageProps["live"];
  noun: string;
}): ReactElement | null {
  if (live.status === "ready") return null;
  if (live.status === "loading") {
    return <div className="api-notice">Loading live {noun}...</div>;
  }
  if (live.status === "error") {
    const diagnostic = getLaunchAuthDiagnostic();
    return (
      <div className="api-notice warning">
        Live {noun} unavailable. {live.error}
        {diagnostic
          ? (
            <small>
              Last sign-in: {diagnostic.status}
              {diagnostic.message ? ` (${diagnostic.message})` : ""}
            </small>
          )
          : null}
      </div>
    );
  }
  return null;
}

export function HomeFoundationPage(
  { live, navigate }: LaunchPageProps,
): ReactElement {
  const homeTools = liveStoreAgents(live.data.store?.results).slice(0, 6);
  return (
    <div className="launch-page-narrow home-page">
      <ApiNotice live={live} noun="launch data" />
      <section className="home-hero">
        <div className="home-hero-copy">
          <h1>
            Many agents?<br />One Agent layer.
          </h1>
          <p>
            Connected agents now inherit every published Agent, with unified
            auth and payments. Or deploy your own.
          </p>
          <div className="hero-actions left">
            <RouteButton
              icon="copy"
              navigate={navigate}
              size="lg"
              to="/install"
            >
              Add to agent
            </RouteButton>
            <RouteButton
              navigate={navigate}
              size="lg"
              to="/store"
              variant="secondary"
            >
              Browse Store
            </RouteButton>
          </div>
        </div>
        <AgentOrbit />
      </section>

      <ValueProps />

      <section className="shared-core-section">
        <h2>Thousands have given Ultralight to their agents</h2>
        <p>
          Every connected agent draws from one core: the same context, Agents,
          auth, and payments.
        </p>
        <SharedCore />
      </section>

      <Section
        action={
          <RouteLink navigate={navigate} to="/store">Browse all</RouteLink>
        }
        title="Agents shipping now"
      >
        <div className="home-tool-grid">
          {homeTools.map((tool) => (
            <CompactAgentCard
              key={tool.id}
              tool={tool}
            />
          ))}
        </div>
      </Section>

      <section className="endpoint-section">
        <div>
          <h2>One endpoint. Every capability.</h2>
          <p>
            Point your connected agent at a single MCP server. It discovers the
            whole catalog, calls any Agent, and settles in credits.
          </p>
          <RouteButton icon="copy" navigate={navigate} size="lg" to="/install">
            Add to agent
          </RouteButton>
        </div>
        <ConfigPreview />
      </section>

      <section className="closing-band">
        <div>
          <h2>Give your connected agent the Agent layer.</h2>
          <p>
            One endpoint for every capability: discover, call, and settle in
            credits.
          </p>
        </div>
        <div className="hero-actions left">
          <RouteButton
            icon="copy"
            navigate={navigate}
            size="lg"
            to="/install"
            variant="secondary"
          >
            Add to agent
          </RouteButton>
          <RouteButton
            navigate={navigate}
            size="lg"
            to="/store"
            variant="ghost"
          >
            Browse Store
          </RouteButton>
        </div>
      </section>
    </div>
  );
}

export function InstallFoundationPage({ live }: LaunchPageProps): ReactElement {
  const targets = liveInstallTargets(live.data.install?.instructions);
  const firstTarget = targets[0]?.target || "claude_code";
  const [target, setTarget] = useState(firstTarget);
  const signedIn = Boolean(live.data.apiKeys?.apiKeys?.length);
  const selected = targets.find((item) => item.target === target) ||
    targets[0] || installTargets[0];
  const firstKey = live.data.apiKeys?.apiKeys[0]?.tokenPrefix || apiKeyMask;
  const key = signedIn ? firstKey : apiKeyPlaceholder;

  useEffect(() => {
    if (!targets.some((item) => item.target === target)) {
      setTarget(firstTarget);
    }
  }, [firstTarget, target, targets]);

  return (
    <div className="launch-page install-page">
      <PageHeader
        actions={
          <Button
            icon="key"
            size="lg"
            variant={signedIn ? "secondary" : "primary"}
          >
            {signedIn ? "Key loaded" : "Sign in"}
          </Button>
        }
        eyebrow="Install"
        intro="One remote MCP endpoint, or the CLI and API, lets any existing agent discover, call, and pay for Agents."
        title="Connect Ultralight to your agent."
      />
      <ApiNotice live={live} noun="install instructions" />

      <div className="install-loop">
        {externalLoop.map((step, index) => (
          <span key={step}>
            <Mono>{index + 1}</Mono>
            {step}
          </span>
        ))}
      </div>

      <KeyBanner signedIn={signedIn} />

      <div className="install-grid">
        <aside className="target-sidebar">
          <TargetPicker active={target} onPick={setTarget} targets={targets} />
        </aside>
        <section className="target-panel">
          <div className="target-heading">
            <div>
              <h2>{selected.label}</h2>
              <p>{selected.description}</p>
            </div>
            {selected.requiresApiKey ? <Pill>requires API key</Pill> : null}
          </div>
          <ol className="install-steps">
            {selected.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <ConfigPreview code={selected.config(key)} highlight={key} />
        </section>
      </div>
    </div>
  );
}

export function StoreFoundationPage(
  { live, location, navigate }: LaunchPageProps,
): ReactElement {
  const [query, setQuery] = useState(storeQueryFromSearch());
  const [kind, setKind] = useState<StoreKindFilter>(storeKindFromSearch());
  useEffect(() => {
    setQuery(storeQueryFromSearch());
    setKind(storeKindFromSearch());
  }, [location.search]);

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    syncSearchParams({ q: nextQuery.trim() || null });
  };
  const updateKind = (nextKind: StoreKindFilter) => {
    setKind(nextKind);
    syncSearchParams({ kind: nextKind === "all" ? null : nextKind });
  };
  const storeTools = liveStoreAgents(live.data.store?.results);
  const builderRows = liveLeaderboardRows(
    live.data.builderLeaderboard?.entries,
  );
  const feeRows = liveLeaderboardRows(live.data.feeLeaderboard?.entries);
  const filteredTools = storeTools.filter((tool) =>
    (kind === "all" || tool.kind === kind) &&
    (!query ||
      `${tool.name} ${tool.summary} ${tool.category}`.toLowerCase().includes(
        query.toLowerCase(),
      ))
  );

  return (
    <div className="launch-page-narrow store-page">
      <ApiNotice live={live} noun="store Agents" />
      <section className="store-heading">
        <h1>Agents your connected agent can call.</h1>
        <SearchControls query={query} setQuery={updateQuery} />
        <div className="kind-tabs" aria-label="Agent kinds">
          {(["all", "mcp", "http"] as const).map((option) => (
            <button
              className={kind === option ? "active" : ""}
              key={option}
              onClick={() => updateKind(option)}
              type="button"
            >
              {option === "all" ? "All" : option.toUpperCase()}
            </button>
          ))}
        </div>
      </section>

      <div className="store-layout">
        <section className="store-results">
          <RetrievalNote
            mode={live.data.store?.retrieval?.mode}
            query={query}
          />
          <div className="store-tool-grid">
            {filteredTools.length > 0
              ? filteredTools.map((tool) => (
                <button
                  className="tool-card-button"
                  key={tool.id}
                  onClick={() => navigate(`/agents/${tool.slug}`)}
                  type="button"
                >
                  <StoreAgentCard tool={tool} />
                </button>
              ))
              : <NoResults onClear={() => updateQuery("")} />}
          </div>
        </section>
        <aside className="store-sidebar">
          <PrimitivesRail navigate={navigate} />
          <Leaderboard
            title="Top builders"
            subtitle="By earned credits"
            rows={builderRows.length > 0 ? builderRows : builderLeaders}
          />
          <Leaderboard
            title="Fee credit"
            subtitle="Fee-waiver program"
            rows={feeRows.length > 0 ? feeRows : feeLeaders}
          />
        </aside>
      </div>
    </div>
  );
}

export function AgentFoundationPage(
  { live, location, navigate, route }: LaunchPageProps,
): ReactElement {
  const slug = route.params.slug || "get_weather";
  const tool = liveDetailAgent(
    live.data.agent?.agent ?? live.data.agent?.tool,
    live.data.agentFunctions?.functions,
    live.data.agentCallerPermissions,
    live.data.agent?.trustCard,
  ) || agentDetails[slug];

  if (!tool) return <AgentNotFoundPage navigate={navigate} slug={slug} />;
  return (
    <AgentDetailSurface
      live={live}
      locationSearch={location.search}
      navigate={navigate}
      tool={tool}
    />
  );
}

function AgentDetailSurface({
  live,
  locationSearch,
  navigate,
  tool,
}: {
  live: LaunchPageProps["live"];
  locationSearch: string;
  navigate: (to: string) => void;
  tool: AgentDetailFixture;
}): ReactElement {
  const [installed, setInstalled] = useState(false);
  const [tab, setTab] = useState<AgentPageTabId>(() => agentTabFromSearch());
  const [selectedFunctionName, setSelectedFunctionName] = useState(
    tool.functions[0]?.name || "",
  );
  useEffect(() => {
    setTab(agentTabFromSearch());
  }, [locationSearch]);

  // Wiring is meaningful only when signed in and the Agent is the user's own
  // (owner) or one they've installed. Public, signed-out views hide the tab.
  const signedIn = hasLaunchAuthToken();
  const wiringRelevant = signedIn &&
    (tool.relationship === "owner" || tool.relationship === "installed");
  const pendingCount = live.data.agentWiring?.pendingRequests.length ?? 0;

  const activateToolTab = (nextTab: AgentPageTabId) => {
    setTab(nextTab);
    syncSearchParams({ tab: nextTab === "functions" ? null : nextTab });
  };

  return (
    <div className="launch-page-narrow tool-page">
      <ApiNotice live={live} noun="Agent details" />
      <button
        className="back-link"
        onClick={() =>
          navigate(
            tool.relationship === "owner" ? "/library?view=owned" : "/store",
          )}
        type="button"
      >
        {tool.relationship === "owner" ? "Library" : "Store"} /{" "}
        <Mono>{tool.slug}</Mono>
      </button>

      <section className="public-tool-header">
        <Avatar color={tool.color} name={tool.author} />
        <div>
          <div className="tool-title-row">
            <h1>{tool.title}</h1>
            <Pill>{tool.kind}</Pill>
            <Pill tone={tool.visibility === "public" ? "green" : "amber"}>
              {tool.visibility}
            </Pill>
          </div>
          <p>{tool.summary}</p>
          <div className="tool-meta-row">
            <span>{tool.author.replace("@", "")}</span>
            <span>{formatNumber(tool.installs)} installs</span>
            <span>{formatNumber(tool.callsPerDay)} calls/day</span>
            <span>updated {tool.updatedAt}</span>
          </div>
          <div className="tool-header-actions">
            <Button
              icon={installed ? "check" : undefined}
              onClick={() => setInstalled((value) => !value)}
              size="lg"
              variant={installed ? "secondary" : "primary"}
            >
              {installed ? "Installed" : "Install"}
            </Button>
            <RouteButton
              icon="copy"
              navigate={navigate}
              size="lg"
              to="/install"
              variant="secondary"
            >
              Copy MCP config
            </RouteButton>
          </div>
        </div>
      </section>

      <div className="tool-tabs" role="tablist" aria-label="Agent page sections">
        <button
          className={tab === "functions" ? "active" : ""}
          onClick={() => activateToolTab("functions")}
          type="button"
        >
          Functions
        </button>
        <button
          className={tab === "details" ? "active" : ""}
          onClick={() => activateToolTab("details")}
          type="button"
        >
          Details
        </button>
        {wiringRelevant
          ? (
            <button
              className={tab === "wiring" ? "active" : ""}
              onClick={() => activateToolTab("wiring")}
              type="button"
            >
              Wiring
              {pendingCount > 0 ? <Pill tone="amber">{pendingCount}</Pill> : null}
            </button>
          )
          : null}
      </div>

      <div className="tool-detail-layout">
        <main className="tool-main-panel">
          {tab === "functions"
            ? (
              <AgentFunctionsPanel
                live={live}
                selectedFunctionName={selectedFunctionName}
                setSelectedFunctionName={setSelectedFunctionName}
                tool={tool}
              />
            )
            : null}
          {tab === "details" ? <AgentDetailsPanel tool={tool} /> : null}
          {tab === "wiring" && wiringRelevant
            ? <AgentWiringPanel live={live} tool={tool} />
            : null}
        </main>
        <aside className="tool-rail">
          <AgentTrustRail tool={tool} />
        </aside>
      </div>
    </div>
  );
}

function AgentFunctionsPanel({
  live,
  selectedFunctionName,
  setSelectedFunctionName,
  tool,
}: {
  live: LaunchPageProps["live"];
  selectedFunctionName: string;
  setSelectedFunctionName: (name: string) => void;
  tool: AgentDetailFixture;
}): ReactElement {
  const selectedFunction =
    tool.functions.find((fn) => fn.name === selectedFunctionName) ||
    tool.functions[0];

  return (
    <div className="functions-panel">
      <div className="function-list">
        <p className="section-label">Functions ({tool.functions.length})</p>
        {tool.functions.map((fn) => (
          <button
            className={selectedFunction.name === fn.name ? "active" : ""}
            key={fn.name}
            onClick={() => setSelectedFunctionName(fn.name)}
            type="button"
          >
            <span>
              <Mono>{fn.name}</Mono>
              <small>{fn.description}</small>
            </span>
            <Mono>{formatAgentPrice(fn.price)}</Mono>
          </button>
        ))}
      </div>
      <FunctionSandboxCard fn={selectedFunction} live={live} tool={tool} />
    </div>
  );
}

function FunctionSandboxCard({
  fn,
  live,
  tool,
}: {
  fn: AgentFunctionFixture;
  live: LaunchPageProps["live"];
  tool: AgentDetailFixture;
}): ReactElement {
  const formRef = useRef<HTMLFormElement>(null);
  const [response, setResponse] = useState<Record<string, unknown> | null>(
    null,
  );
  const [runState, setRunState] = useState<
    "idle" | "running" | "success" | "error"
  >("idle");

  const runFunction = async () => {
    setRunState("running");
    const data = new FormData(formRef.current || undefined);
    const args = Object.fromEntries(
      fn.args.map((arg) => [arg, data.get(arg) || argDefault(arg)]),
    );
    try {
      const result = await launchApi.runAgentFunction(tool.id, fn.name, {
        args,
      });
      setResponse({
        ...(result.result && typeof result.result === "object" &&
            !Array.isArray(result.result)
          ? result.result as Record<string, unknown>
          : { result: result.result ?? null }),
        receiptId: result.receiptId || null,
        success: result.success,
      });
      setRunState(result.success ? "success" : "error");
    } catch (err) {
      setResponse({
        error: err instanceof Error ? err.message : String(err),
      });
      setRunState("error");
    }
  };

  return (
    <Card className="function-sandbox-card">
      <div className="function-sandbox-head">
        <div>
          <Mono>{fn.name}</Mono>
          <p>{fn.description}</p>
        </div>
        <Pill>{formatAgentPrice(fn.price)}/call</Pill>
      </div>
      <form className="arg-grid" ref={formRef}>
        {fn.args.length > 0
          ? fn.args.map((arg) => (
            <label key={arg}>
              <span>{arg}</span>
              <input
                defaultValue={argDefault(arg)}
                name={arg}
                placeholder={argHint(arg)}
              />
            </label>
          ))
          : <p className="muted-note">No arguments.</p>}
      </form>
      <div className="manual-run-row">
        <Button icon="arrow" onClick={runFunction} size="sm">
          {runState === "running" ? "Running" : "Run"}
        </Button>
        <span>
          Manual website runs create receipts; your connected agent still obeys
          the saved permission.
        </span>
      </div>
      {response || runState === "running"
        ? (
          <div className="function-response">
            <p className="section-label">
              {runState === "running"
                ? "requesting..."
                : runState === "error"
                ? "response · error"
                : "response · receipt queued"}
            </p>
            <pre>{JSON.stringify(response || functionResponse(tool.slug, fn.name), null, 2)}</pre>
          </div>
        )
        : null}
      <PermissionControl fn={fn} live={live} tool={tool} />
    </Card>
  );
}

function PermissionControl({
  fn,
  live,
  tool,
}: {
  fn: AgentFunctionFixture;
  live: LaunchPageProps["live"];
  tool: AgentDetailFixture;
}): ReactElement {
  const [permission, setPermission] = useState(fn.permission);
  const [savedPermission, setSavedPermission] = useState(fn.permission);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const dirty = permission !== savedPermission;
  const options = [
    ["always", "Always"],
    ["ask", "Ask"],
    ["never", "Never"],
  ] as const;

  return (
    <div className="permission-control">
      <div>
        <strong>Connected agent permission</strong>
        <span>Default is ask. Manual website runs are separate.</span>
      </div>
      <div className="permission-actions">
        <div className="mini-segments">
          {options.map(([id, label]) => (
            <button
              className={permission === id ? "active" : ""}
              key={id}
              onClick={() => setPermission(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <Button
          onClick={async () => {
            if (!dirty) return;
            setSaveState("saving");
            try {
              await launchApi.updateAgentCallerPermissions(tool.id, {
                permissions: [{ functionName: fn.name, policy: permission }],
              });
              setSavedPermission(permission);
              setSaveState("idle");
              live.reload();
            } catch {
              setSaveState("error");
            }
          }}
          size="sm"
          variant={dirty ? "primary" : "secondary"}
        >
          {saveState === "saving"
            ? "Saving"
            : saveState === "error"
            ? "Retry"
            : dirty
            ? "Save"
            : "Saved"}
        </Button>
      </div>
    </div>
  );
}

function grantAppLabel(
  app: { slug: string | null; name: string | null; id: string },
): string {
  return app.name || app.slug || `${app.id.slice(0, 8)}…`;
}

function CallerTrustChip(
  { trust }: { trust?: AgentCallerTrustSummary | null },
): ReactElement | null {
  if (!trust) return null;
  return (
    <div className="caller-trust">
      {trust.hasNetworkEgress
        ? (
          <Pill tone="amber">
            This Agent can send data off-platform
          </Pill>
        )
        : <Pill tone="green">No declared network egress</Pill>}
      <Pill tone={trust.ownedByUser ? "green" : "default"}>
        {trust.ownedByUser ? "Owned by you" : trust.visibility}
      </Pill>
      {trust.declaredPermissions.length > 0
        ? (
          <span className="caller-trust-perms">
            {trust.declaredPermissions.map((perm) => (
              <Mono key={perm}>{perm}</Mono>
            ))}
          </span>
        )
        : null}
    </div>
  );
}

// One-click default-deny inbox: pending cross-Agent requests awaiting the
// user's approval. This is the heart of the wiring UX.
function PendingInbox({
  callerTrustByApp,
  live,
  pending,
}: {
  // Trust keyed by CALLER app id — the inbox warns about the agent that
  // receives the data, which for inbound requests is NOT the page agent.
  callerTrustByApp: Record<string, AgentCallerTrustSummary>;
  live: LaunchPageProps["live"];
  pending: AgentGrantSummary[];
}): ReactElement {
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (
    grantId: string,
    run: () => Promise<unknown>,
  ) => {
    setBusyId(grantId);
    try {
      await run();
      live.reload();
    } catch {
      // Surface nothing destructive; the row stays so the user can retry.
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="wiring-inbox-card">
      <div className="wiring-section-head">
        <div>
          <h3>Pending approvals</h3>
          <p>
            A call was denied by default and is waiting for you. Approve once to
            wire it; deny to keep it blocked.
          </p>
        </div>
        {pending.length > 0 ? <Pill tone="amber">{pending.length}</Pill> : null}
      </div>
      {pending.length === 0
        ? (
          <EmptyState icon="shield" title="No pending requests">
            When another Agent tries to call this one without a grant, the
            request lands here for one-click approval.
          </EmptyState>
        )
        : (
          <div className="wiring-row-list">
            {pending.map((request) => (
              <div className="wiring-pending-row" key={request.id}>
                <div className="wiring-pending-main">
                  <strong>
                    <Mono>{grantAppLabel(request.callerApp)}</Mono>
                    {" → "}
                    <Mono>
                      {grantAppLabel(request.targetApp)}.{request.targetFunction}
                    </Mono>
                  </strong>
                  {request.callerFunction
                    ? (
                      <span className="muted-note">
                        only while <Mono>{request.callerFunction}</Mono> runs
                      </span>
                    )
                    : null}
                  <CallerTrustChip
                    trust={callerTrustByApp[request.callerApp.id] ?? null}
                  />
                </div>
                <div className="wiring-row-actions">
                  <Button
                    onClick={() =>
                      act(request.id, () => launchApi.approveGrant(request.id))}
                    size="sm"
                  >
                    {busyId === request.id ? "Working" : "Approve"}
                  </Button>
                  <Button
                    onClick={() =>
                      act(request.id, () => launchApi.revokeGrant(request.id))}
                    size="sm"
                    variant="secondary"
                  >
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
    </Card>
  );
}

// A monthly-cap display with inline edit (updateGrant). null cap = uncapped.
function GrantCapControl({
  grant,
  live,
}: {
  grant: AgentGrantSummary;
  live: LaunchPageProps["live"];
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    grant.monthlyCapCredits != null ? String(grant.monthlyCapCredits) : "",
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const trimmed = draft.trim();
    const cap = trimmed === "" ? null : Number(trimmed);
    try {
      await launchApi.updateGrant(grant.id, {
        monthlyCapCredits: cap != null && Number.isFinite(cap) ? cap : null,
      });
      setEditing(false);
      live.reload();
    } catch {
      // Keep the editor open so the user can retry.
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="wiring-cap">
        <span className="muted-note">
          {grant.monthlyCapCredits != null
            ? `✦${formatCredits(grant.spentCreditsPeriod)} / ✦${
              formatCredits(grant.monthlyCapCredits)
            } this month`
            : `✦${formatCredits(grant.spentCreditsPeriod)} spent · uncapped`}
        </span>
        <button
          className="route-link"
          onClick={() => setEditing(true)}
          type="button"
        >
          Edit cap
        </button>
      </div>
    );
  }

  return (
    <div className="wiring-cap editing">
      <input
        inputMode="numeric"
        onChange={(event) => setDraft(event.target.value)}
        placeholder={`uncapped (default ✦${
          formatCredits(DEFAULT_GRANT_MONTHLY_CAP_CREDITS)
        })`}
        value={draft}
      />
      <Button onClick={save} size="sm">
        {saving ? "Saving" : "Save cap"}
      </Button>
      <button
        className="route-link"
        onClick={() => setEditing(false)}
        type="button"
      >
        Cancel
      </button>
    </div>
  );
}

// Bind a declared slot to an eligible target Agent + one of its functions.
function SlotBindControl({
  callerAppId,
  callerTrust,
  live,
  slot,
  targets,
}: {
  callerAppId: string;
  // The slot owner (= this page's Agent) is the caller that will receive the
  // target's data — show its egress trust before the user wires it.
  callerTrust?: AgentCallerTrustSummary | null;
  live: LaunchPageProps["live"];
  slot: AgentImportSlot;
  targets: AgentWiringTarget[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [targetAppId, setTargetAppId] = useState("");
  const [targetFunction, setTargetFunction] = useState("");
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTarget = targets.find((entry) => entry.app.id === targetAppId);
  const eligibleTargets = slot.expectedFunctions.length > 0
    ? targets.filter((entry) =>
      entry.functions.some((fn) => slot.expectedFunctions.includes(fn.name))
    )
    : targets;

  const bind = async () => {
    if (!targetAppId || !targetFunction) return;
    setBinding(true);
    setError(null);
    try {
      await launchApi.createGrant({
        callerAppId,
        targetAppId,
        targetFunction,
        slot: slot.name,
      });
      setOpen(false);
      setTargetAppId("");
      setTargetFunction("");
      live.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBinding(false);
    }
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm" variant="secondary">
        Bind slot
      </Button>
    );
  }

  return (
    <div className="slot-bind">
      <label>
        <span>Target Agent</span>
        <select
          onChange={(event) => {
            setTargetAppId(event.target.value);
            setTargetFunction("");
          }}
          value={targetAppId}
        >
          <option value="">Pick an Agent…</option>
          {eligibleTargets.map((entry) => (
            <option key={entry.app.id} value={entry.app.id}>
              {grantAppLabel(entry.app)} · {entry.relationship}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Function</span>
        <select
          disabled={!selectedTarget}
          onChange={(event) => setTargetFunction(event.target.value)}
          value={targetFunction}
        >
          <option value="">Pick a function…</option>
          {(selectedTarget?.functions ?? []).map((fn) => (
            <option key={fn.name} value={fn.name}>{fn.name}</option>
          ))}
        </select>
      </label>
      {selectedTarget && selectedTarget.visibility === "private"
        ? (
          <Pill tone="amber">
            Binds a published Agent to your private Agent
          </Pill>
        )
        : null}
      <CallerTrustChip trust={callerTrust} />
      {error ? <p className="api-notice warning">{error}</p> : null}
      <div className="wiring-row-actions">
        <Button
          onClick={bind}
          size="sm"
        >
          {binding ? "Binding" : "Bind"}
        </Button>
        <button
          className="route-link"
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SlotCard({
  callerAppId,
  callerTrust,
  live,
  slot,
  targets,
}: {
  callerAppId: string;
  callerTrust?: AgentCallerTrustSummary | null;
  live: LaunchPageProps["live"];
  slot: AgentImportSlot;
  targets: AgentWiringTarget[];
}): ReactElement {
  const unbind = async () => {
    if (!slot.binding) return;
    try {
      await launchApi.revokeGrant(slot.binding.id);
      live.reload();
    } catch {
      // Leave the binding visible; the user can retry the unbind.
    }
  };

  return (
    <div className="wiring-slot">
      <div className="wiring-slot-head">
        <div>
          <strong>
            <Mono>{slot.name}</Mono>
          </strong>
          {slot.description ? <span>{slot.description}</span> : null}
          {slot.signature
            ? <code className="wiring-slot-sig">{slot.signature}</code>
            : null}
          {slot.expectedFunctions.length > 0
            ? (
              <span className="muted-note">
                expects {slot.expectedFunctions.join(", ")}
              </span>
            )
            : null}
        </div>
        {slot.binding
          ? (
            <Button onClick={unbind} size="sm" variant="secondary">
              Unbind
            </Button>
          )
          : (
            <SlotBindControl
              callerAppId={callerAppId}
              callerTrust={callerTrust}
              live={live}
              slot={slot}
              targets={targets}
            />
          )}
      </div>
      {slot.binding
        ? (
          <div className="wiring-slot-binding">
            <span>
              bound to{" "}
              <Mono>
                {grantAppLabel(slot.binding.targetApp)}.{slot.binding
                  .targetFunction}
              </Mono>
            </span>
            <GrantCapControl grant={slot.binding} live={live} />
          </div>
        )
        : <span className="muted-note">Not bound yet.</span>}
    </div>
  );
}

// A raw outbound/inbound grant row (slot === null) with revoke + cap edit.
function GrantRow({
  direction,
  grant,
  live,
}: {
  direction: "outbound" | "inbound";
  grant: AgentGrantSummary;
  live: LaunchPageProps["live"];
}): ReactElement {
  const revoke = async () => {
    try {
      await launchApi.revokeGrant(grant.id);
      live.reload();
    } catch {
      // Keep the row; revoke can be retried.
    }
  };

  const counterparty = direction === "outbound"
    ? grant.targetApp
    : grant.callerApp;

  return (
    <div className="wiring-grant-row">
      <div className="wiring-grant-main">
        <strong>
          {direction === "inbound"
            ? <Mono>{grantAppLabel(counterparty)}</Mono>
            : null}
          {direction === "inbound" ? " → " : ""}
          <Mono>
            {grantAppLabel(grant.targetApp)}.{grant.targetFunction}
          </Mono>
        </strong>
        {grant.callerFunction
          ? (
            <span className="muted-note">
              only while <Mono>{grant.callerFunction}</Mono> runs
            </span>
          )
          : null}
        <GrantCapControl grant={grant} live={live} />
      </div>
      <Button onClick={revoke} size="sm" variant="secondary">
        Revoke
      </Button>
    </div>
  );
}

// One subscribe-grant row. A "subscription" is inbound (this Agent's function
// reacts to an emitter's event); a "publication" is outbound (this Agent's
// event triggers a subscriber). Both carry a cap + revoke.
function SubscriptionRow({
  kind,
  grant,
  live,
}: {
  kind: "subscription" | "publication";
  grant: AgentGrantSummary;
  live: LaunchPageProps["live"];
}): ReactElement {
  const revoke = async () => {
    try {
      await launchApi.revokeGrant(grant.id);
      live.reload();
    } catch {
      // Keep the row; revoke can be retried.
    }
  };

  return (
    <div className="wiring-grant-row">
      <div className="wiring-grant-main">
        <strong>
          {/* caller is always the emitter, target always the subscriber — only
              the framing copy differs between the two lists. */}
          <Mono>{grantAppLabel(grant.callerApp)}</Mono>
          {" emits "}
          <Mono>{grant.topic ?? "—"}</Mono>
          {" → "}
          <Mono>
            {grantAppLabel(grant.targetApp)}.{grant.targetFunction}
          </Mono>
        </strong>
        {kind === "subscription"
          ? (
            <CallerTrustChip
              trust={live.data.agentWiring?.callerTrustByApp[grant.callerApp.id]}
            />
          )
          : null}
        <GrantCapControl grant={grant} live={live} />
      </div>
      <Button onClick={revoke} size="sm" variant="secondary">
        Revoke
      </Button>
    </div>
  );
}

// Build a subscription: pick an emitter + one of its declared topics, then a
// handler function on THIS Agent. The resulting subscribe grant means "when the
// emitter publishes the topic, call this Agent's handler".
function SubscribeBuilder({
  subscriberAppId,
  subscriberFunctions,
  emitters,
  live,
}: {
  subscriberAppId: string;
  subscriberFunctions: { name: string; description: string | null }[];
  emitters: AgentWiringTarget[];
  live: LaunchPageProps["live"];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [emitterAppId, setEmitterAppId] = useState("");
  const [topic, setTopic] = useState("");
  const [handler, setHandler] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedEmitter = emitters.find((e) => e.app.id === emitterAppId);

  const subscribe = async () => {
    if (!emitterAppId || !topic || !handler) return;
    setSaving(true);
    setError(null);
    try {
      await launchApi.createGrant({
        callerAppId: emitterAppId,
        targetAppId: subscriberAppId,
        targetFunction: handler,
        mode: "subscribe",
        topic,
      });
      setOpen(false);
      setEmitterAppId("");
      setTopic("");
      setHandler("");
      live.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (emitters.length === 0) {
    return (
      <p className="muted-note">
        No Agent you control declares emitted events yet. An Agent advertises
        topics with a manifest <Mono>emits</Mono> list.
      </p>
    );
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm" variant="secondary">
        Add subscription
      </Button>
    );
  }

  return (
    <div className="slot-bind">
      <label>
        <span>Emitter Agent</span>
        <select
          onChange={(event) => {
            setEmitterAppId(event.target.value);
            setTopic("");
          }}
          value={emitterAppId}
        >
          <option value="">Pick an Agent…</option>
          {emitters.map((entry) => (
            <option key={entry.app.id} value={entry.app.id}>
              {grantAppLabel(entry.app)} · {entry.relationship}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Topic</span>
        <select
          disabled={!selectedEmitter}
          onChange={(event) => setTopic(event.target.value)}
          value={topic}
        >
          <option value="">Pick a topic…</option>
          {(selectedEmitter?.emits ?? []).map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Handler function</span>
        <select
          onChange={(event) => setHandler(event.target.value)}
          value={handler}
        >
          <option value="">Pick a function…</option>
          {subscriberFunctions.map((fn) => (
            <option key={fn.name} value={fn.name}>{fn.name}</option>
          ))}
        </select>
      </label>
      {error ? <p className="api-notice warning">{error}</p> : null}
      <div className="wiring-row-actions">
        <Button onClick={subscribe} size="sm">
          {saving ? "Subscribing" : "Subscribe"}
        </Button>
        <button
          className="route-link"
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function AgentWiringPanel({
  live,
  tool,
}: {
  live: LaunchPageProps["live"];
  tool: AgentDetailFixture;
}): ReactElement {
  const wiring = live.data.agentWiring;
  // The page Agent IS the caller for every outbound bind / raw grant, so its
  // own trust summary is the right one to show in the bind flow.
  const pageCallerTrust = live.data.agentCallerTrust;
  const [targets, setTargets] = useState<AgentWiringTarget[]>([]);

  useEffect(() => {
    let cancelled = false;
    launchApi.wiringTargets()
      .then((response) => {
        if (!cancelled) setTargets(response.targets);
      })
      .catch(() => {
        if (!cancelled) setTargets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tool.id]);

  if (!wiring) {
    return (
      <div className="wiring-panel">
        <EmptyState icon="shield" title="Wiring needs a live session">
          Sign in and reload to bind this Agent's slots, review the grants it
          holds, and approve pending requests.
        </EmptyState>
      </div>
    );
  }

  // For the subscription builder: any controlled Agent that declares emitted
  // topics is an eligible event source, and this page Agent's own functions are
  // the handler candidates.
  const emitters = targets.filter((t) => t.emits.length > 0);
  const subscriberFunctions =
    targets.find((t) => t.app.id === wiring.app.id)?.functions ?? [];

  return (
    <div className="wiring-panel">
      <PendingInbox
        callerTrustByApp={wiring.callerTrustByApp ?? {}}
        live={live}
        pending={wiring.pendingRequests}
      />

      <Card>
        <div className="wiring-section-head">
          <div>
            <h3>Outbound — this Agent's slots</h3>
            <p>
              Bind each declared slot to a target Agent + function. Binding a
              slot is a grant: it lets this Agent call the target on your behalf.
            </p>
          </div>
        </div>
        {wiring.slots.length === 0
          ? (
            <p className="muted-note">
              This Agent declares no import slots.
            </p>
          )
          : (
            <div className="wiring-slot-list">
              {wiring.slots.map((slot) => (
                <SlotCard
                  callerAppId={wiring.app.id}
                  callerTrust={pageCallerTrust}
                  key={slot.name}
                  live={live}
                  slot={slot}
                  targets={targets}
                />
              ))}
            </div>
          )}

        <div className="wiring-subsection">
          <p className="section-label">Raw outbound grants</p>
          {wiring.outboundGrants.length === 0
            ? (
              <p className="muted-note">
                No raw grants — this Agent only calls through bound slots.
              </p>
            )
            : (
              <div className="wiring-row-list">
                {wiring.outboundGrants.map((grant) => (
                  <GrantRow
                    direction="outbound"
                    grant={grant}
                    key={grant.id}
                    live={live}
                  />
                ))}
              </div>
            )}
        </div>
      </Card>

      <Card>
        <div className="wiring-section-head">
          <div>
            <h3>Inbound — Agents that call this one</h3>
            <p>
              Active grants letting other Agents call <Mono>{tool.slug}</Mono>.
              Adjust the monthly cap or revoke access.
            </p>
          </div>
        </div>
        {wiring.inboundGrants.length === 0
          ? (
            <p className="muted-note">
              No other Agent is wired to call this one.
            </p>
          )
          : (
            <div className="wiring-row-list">
              {wiring.inboundGrants.map((grant) => (
                <GrantRow
                  direction="inbound"
                  grant={grant}
                  key={grant.id}
                  live={live}
                />
              ))}
            </div>
          )}
      </Card>

      <Card>
        <div className="wiring-section-head">
          <div>
            <h3>Reactive events</h3>
            <p>
              Subscriptions let this Agent's functions react to events other
              Agents emit. Each subscription is grant-gated and capped — only the
              sources you wire here can trigger it.
            </p>
          </div>
        </div>

        {(wiring.emits ?? []).length > 0
          ? (
            <div className="wiring-subsection">
              <p className="section-label">Topics this Agent emits</p>
              <div className="capability-list">
                {(wiring.emits ?? []).map((topic) => (
                  <Pill key={topic} tone="default">{topic}</Pill>
                ))}
              </div>
            </div>
          )
          : null}

        <div className="wiring-subsection">
          <div className="wiring-section-head">
            <p className="section-label">
              Subscriptions — events this Agent reacts to
            </p>
            <SubscribeBuilder
              emitters={emitters}
              live={live}
              subscriberAppId={wiring.app.id}
              subscriberFunctions={subscriberFunctions}
            />
          </div>
          {(wiring.subscriptions ?? []).length === 0
            ? (
              <p className="muted-note">
                This Agent reacts to no events yet.
              </p>
            )
            : (
              <div className="wiring-row-list">
                {(wiring.subscriptions ?? []).map((grant) => (
                  <SubscriptionRow
                    grant={grant}
                    key={grant.id}
                    kind="subscription"
                    live={live}
                  />
                ))}
              </div>
            )}
        </div>

        <div className="wiring-subsection">
          <p className="section-label">
            Publications — this Agent's events that trigger others
          </p>
          {(wiring.publications ?? []).length === 0
            ? (
              <p className="muted-note">
                No other Agent reacts to this one's events.
              </p>
            )
            : (
              <div className="wiring-row-list">
                {(wiring.publications ?? []).map((grant) => (
                  <SubscriptionRow
                    grant={grant}
                    key={grant.id}
                    kind="publication"
                    live={live}
                  />
                ))}
              </div>
            )}
        </div>
      </Card>
    </div>
  );
}

function AgentDetailsPanel({ tool }: { tool: AgentDetailFixture }): ReactElement {
  return (
    <div className="details-panel">
      <Card>
        <p className="section-label">Signed manifest</p>
        <h3>{tool.signer}</h3>
        <p>
          The public manifest advertises runtime, capabilities, pricing,
          receipts, and setup needs before any connected agent calls the Agent.
        </p>
        <div className="manifest-grid">
          <MetaPair label="version" value={tool.version} />
          <MetaPair label="runtime" value={tool.runtime} />
          <MetaPair label="receipts" value="enabled" />
          <MetaPair label="visibility" value={tool.visibility} />
        </div>
      </Card>
      <Card>
        <p className="section-label">Capabilities</p>
        <div className="capability-list">
          {tool.capabilities.map((capability) => (
            <AgentCapabilityPill
              capability={capability}
              key={`${capability.kind}-${capability.text}`}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function AgentTrustRail({ tool }: { tool: AgentDetailFixture }): ReactElement {
  const paidFunctions = tool.functions.filter((fn) => fn.price > 0);
  const minPrice = paidFunctions.length > 0
    ? Math.min(...paidFunctions.map((fn) => fn.price))
    : 0;

  return (
    <div className="tool-rail-stack">
      <Card className="trust-card">
        <div className="trust-card-head">
          <Icon name="shield" />
          <div>
            <h3>Ready to call</h3>
            <p>
              Signed manifest, receipts, and capability disclosure are live.
            </p>
          </div>
        </div>
        <div className="trust-meta">
          <MetaPair label="signer" value={tool.signer} />
          <MetaPair label="version" value={tool.version} />
          <MetaPair label="runtime" value={tool.runtime} />
        </div>
      </Card>
      <Card>
        <p className="section-label">Pricing</p>
        <div className="pricing-line">
          <strong>Free to install</strong>
          <Mono>{paidFunctions.length} paid functions</Mono>
        </div>
        <div className="trust-meta">
          <MetaPair label="metering" value="per call" />
          <MetaPair
            label="from"
            value={minPrice > 0 ? `✦${formatCredits(minPrice)}` : "Free"}
          />
          <MetaPair label="calls/day" value={formatNumber(tool.callsPerDay)} />
        </div>
      </Card>
      <Card>
        <p className="section-label">Owner</p>
        <div className="owner-row">
          <Avatar color={tool.color} name={tool.author} />
          <div>
            <strong>{tool.author}</strong>
            <span>Builder rank #{builderRankFor(tool.author)}</span>
          </div>
        </div>
      </Card>
      <div className="works-with">
        <p className="section-label">Works with</p>
        <div>
          {["Claude Code", "Cursor", "Codex", "MCP", "CLI", "API"].map((
            label,
          ) => <span key={label}>{label}</span>)}
        </div>
      </div>
    </div>
  );
}

function MetaPair(
  { label, value }: { label: string; value: string },
): ReactElement {
  return (
    <div className="meta-pair">
      <span>{label}</span>
      <Mono>{value}</Mono>
    </div>
  );
}

function AgentCapabilityPill(
  { capability }: { capability: AgentCapability },
): ReactElement {
  return (
    <div className={`tool-capability tool-capability-${capability.kind}`}>
      <Mono>{capability.kind}</Mono>
      <span>{capability.text}</span>
    </div>
  );
}

function AgentNotFoundPage({
  navigate,
  slug,
}: {
  navigate: (to: string) => void;
  slug: string;
}): ReactElement {
  return (
    <>
      <PageHeader
        actions={
          <RouteButton navigate={navigate} size="lg" to="/store">
            Back to Store
          </RouteButton>
        }
        eyebrow="Agent preview"
        intro="This Agent is not available to the current session."
        title={slug}
      />
      <EmptyState icon="search" title="Agent not found">
        Sign in with an account that owns or installed this Agent, or use a
        public Agent URL.
      </EmptyState>
    </>
  );
}

export function LibraryFoundationPage(
  { live, location, navigate }: LaunchPageProps,
): ReactElement {
  const [view, setView] = useState<LibraryView>(libraryViewFromSearch());
  const useFixtureFallback = live.status !== "ready" && live.status !== "error";
  const installedTools = live.data.library?.installed?.length
    ? live.data.library.installed.map((tool) => liveAgentFixture(tool))
    : useFixtureFallback
    ? installedLibrarySlugs.map((slug) => agentDetails[slug]).filter(Boolean)
    : [];
  const ownedTools = live.data.library?.owned?.length
    ? live.data.library.owned.map((tool) => liveAgentFixture(tool))
    : useFixtureFallback
    ? ownedLibrarySlugs.map((slug) => agentDetails[slug]).filter(Boolean)
    : [];
  const count = view === "installed"
    ? installedTools.length
    : ownedTools.length;
  useEffect(() => {
    setView(libraryViewFromSearch());
  }, [location.search]);

  const selectView = (nextView: LibraryView) => {
    setView(nextView);
    syncSearchParams({ view: nextView === "installed" ? null : nextView });
  };

  return (
    <div className="launch-page-narrow library-page">
      <ApiNotice live={live} noun="library" />
      <div className="library-toolbar">
        <div className="library-picker">
          <button
            className={view === "installed" ? "active" : ""}
            onClick={() => selectView("installed")}
            type="button"
          >
            Installed Agents
          </button>
          <button
            className={view === "owned" ? "active" : ""}
            onClick={() => selectView("owned")}
            type="button"
          >
            Agents you own
          </button>
        </div>
        <Mono>{count}</Mono>
        <RouteButton
          icon="grid"
          navigate={navigate}
          to="/store"
          variant="secondary"
        >
          Browse Store
        </RouteButton>
      </div>

      {view === "installed"
        ? (
          <div className="library-installed-grid">
            {installedTools.length > 0
              ? installedTools.map((tool) => (
                <button
                  className="tool-card-button"
                  key={tool.id}
                  onClick={() => navigate(`/agents/${tool.slug}`)}
                  type="button"
                >
                  <StoreAgentCard tool={tool} />
                </button>
              ))
              : (
                <EmptyState icon="key" title="Sign in to load your library">
                  The live library endpoint needs an account session before it
                  can show installed Agents.
                </EmptyState>
              )}
          </div>
        )
        : (
          <div className="owned-tool-list">
            {ownedTools.length > 0
              ? ownedTools.map((tool) => (
                <OwnedAgentCard key={tool.id} navigate={navigate} tool={tool} />
              ))
              : (
                <EmptyState icon="key" title="Sign in to load owned Agents">
                  The live library endpoint needs an account session before it
                  can show Agents you own.
                </EmptyState>
              )}
          </div>
        )}

      {useFixtureFallback && installedTools.length === 0 &&
          ownedTools.length === 0
        ? (
          <div className="library-empty-grid">
            <LibraryEmptyCard
              action="Deploy docs"
              body="Ship your first Agent from the CLI and it appears here with installs, calls, and earnings."
              title="Agents you own"
            />
            <LibraryEmptyCard
              action="Browse Store"
              body="Agents you install from the Store appear here, ready for your connected agent to call."
              title="Installed"
            />
          </div>
        )
        : null}
    </div>
  );
}

export function AdminFoundationPage(
  { live, location, navigate, route }: LaunchPageProps,
): ReactElement {
  const tool = liveDetailAgent(
    live.data.adminAgent?.admin.agent ?? live.data.adminAgent?.admin.tool,
    live.data.agentFunctions?.functions,
    live.data.agentCallerPermissions,
    live.data.adminAgent?.trustCard,
  ) || adminAgentFromRoute(route.params.id);
  const initialTab = adminTabFromSearch();
  const [tab, setTab] = useState<AdminTabId>(initialTab);
  const [visibility, setVisibility] = useState<AgentDetailFixture["visibility"]>(
    tool.visibility,
  );
  useEffect(() => {
    setTab(adminTabFromSearch());
  }, [location.search, route.params.id]);
  useEffect(() => {
    setVisibility(tool.visibility);
  }, [tool.id, tool.visibility]);

  const selectTab = (nextTab: AdminTabId) => {
    setTab(nextTab);
    syncSearchParams({ tab: nextTab === "edit" ? null : nextTab });
  };

  return (
    <div className="launch-page-narrow admin-page">
      <ApiNotice live={live} noun="Agent admin" />
      <AdminHeader navigate={navigate} tool={tool} visibility={visibility} />
      <div
        className="admin-tabs"
        role="tablist"
        aria-label="Agent admin sections"
      >
        {adminTabs.map(([id, label]) => (
          <button
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => selectTab(id)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      <AdminTabPanel
        navigate={navigate}
        setVisibility={setVisibility}
        tab={tab}
        tool={tool}
        visibility={visibility}
      />
    </div>
  );
}

function OwnedAgentCard({
  navigate,
  tool,
}: {
  navigate: (to: string) => void;
  tool: AgentDetailFixture;
}): ReactElement {
  return (
    <Card className="owned-tool-card">
      <div className="owned-tool-main">
        <Avatar color={tool.color} name={tool.author} />
        <div>
          <h3>{tool.title}</h3>
          <p>{tool.summary}</p>
        </div>
      </div>
      <div className="owned-tool-metrics">
        <MetricTile label="Installs" value={formatNumber(tool.installs)} />
        <MetricTile label="Calls/day" value={formatNumber(tool.callsPerDay)} />
        <MetricTile label="Earned 30d" value="✦297.6" />
      </div>
      <div className="owned-tool-actions">
        <RouteButton
          navigate={navigate}
          to={`/admin/agents/${tool.id}`}
          variant="primary"
        >
          Manage
        </RouteButton>
        <RouteButton
          navigate={navigate}
          to={agentPreviewPath(tool)}
          variant="secondary"
        >
          Preview
        </RouteButton>
      </div>
    </Card>
  );
}

function MetricTile(
  { label, value }: { label: string; value: string },
): ReactElement {
  return (
    <div className="metric-tile">
      <p className="section-label">{label}</p>
      <Mono>{value}</Mono>
    </div>
  );
}

function LibraryEmptyCard({
  action,
  body,
  title,
}: {
  action: string;
  body: string;
  title: string;
}): ReactElement {
  return (
    <div className="library-empty-card">
      <strong>{title}: nothing yet</strong>
      <p>{body}</p>
      <Button
        size="sm"
        variant={title === "Agents you own" ? "primary" : "secondary"}
      >
        {action}
      </Button>
    </div>
  );
}

function AdminHeader({
  navigate,
  tool,
  visibility,
}: {
  navigate: (to: string) => void;
  tool: AgentDetailFixture;
  visibility: AgentDetailFixture["visibility"];
}): ReactElement {
  return (
    <section className="admin-header">
      <div className="admin-title-row">
        <Avatar color={tool.color} name={tool.author} />
        <div>
          <div className="admin-title-line">
            <h1>{tool.title}</h1>
            <Pill tone={visibility === "public" ? "green" : "amber"}>
              {visibility}
            </Pill>
          </div>
          <p>
            {formatNumber(tool.installs)} installs ·{" "}
            {formatNumber(tool.callsPerDay)} calls/day
          </p>
        </div>
      </div>
      <div className="admin-header-actions">
        <RouteButton
          navigate={navigate}
          to={agentPreviewPath(tool)}
          variant="secondary"
        >
          Preview
        </RouteButton>
        <Button>Save changes</Button>
      </div>
    </section>
  );
}

function AdminTabPanel({
  navigate,
  setVisibility,
  tab,
  tool,
  visibility,
}: {
  navigate: (to: string) => void;
  setVisibility: (visibility: AgentDetailFixture["visibility"]) => void;
  tab: AdminTabId;
  tool: AgentDetailFixture;
  visibility: AgentDetailFixture["visibility"];
}): ReactElement {
  switch (tab) {
    case "pricing":
      return <AdminPricingPanel tool={tool} />;
    case "secrets":
      return <AdminSecretsPanel />;
    case "trust":
      return <AdminTrustPanel tool={tool} />;
    case "receipts":
      return <AdminReceiptsPanel tool={tool} />;
    case "logs":
      return <AdminLogsPanel />;
    case "edit":
    default:
      return (
        <AdminEditPanel
          setVisibility={setVisibility}
          tool={tool}
          visibility={visibility}
        />
      );
  }
}

function AdminEditPanel({
  setVisibility,
  tool,
  visibility,
}: {
  setVisibility: (visibility: AgentDetailFixture["visibility"]) => void;
  tool: AgentDetailFixture;
  visibility: AgentDetailFixture["visibility"];
}): ReactElement {
  return (
    <div className="admin-panel admin-edit-panel">
      <AdminField label="Name">
        <div className="admin-input mono">{tool.name}</div>
      </AdminField>
      <AdminField label="Description">
        <div className="admin-textarea">{tool.summary}</div>
      </AdminField>
      <div className="admin-split-fields">
        <AdminField label="Category">
          <div className="admin-input">{tool.category}</div>
        </AdminField>
        <AdminField label="Tags">
          <div className="admin-tags">
            {["weather", "forecast", "noaa"].map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </AdminField>
      </div>
      <AdminField label="Visibility">
        <div className="visibility-list">
          {visibilityOptions.map(([id, label, description]) => (
            <button
              className={visibility === id ? "active" : ""}
              key={id}
              onClick={() => setVisibility(id)}
              type="button"
            >
              <span />
              <div>
                <strong>{label}</strong>
                <small>{description}</small>
              </div>
            </button>
          ))}
        </div>
      </AdminField>
    </div>
  );
}

function AdminPricingPanel(
  { tool }: { tool: AgentDetailFixture },
): ReactElement {
  return (
    <div className="admin-panel">
      <div className="admin-table admin-pricing-table">
        <div className="admin-table-head">
          <span>Function</span>
          <span>Price / call</span>
          <span>p50</span>
        </div>
        {tool.functions.map((fn) => (
          <div className="admin-table-row" key={fn.name}>
            <Mono>{fn.name}</Mono>
            <label>
              <span>✦</span>
              <input defaultValue={fn.price.toFixed(3)} />
            </label>
            <Mono>{fn.p50}ms</Mono>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminSecretsPanel(): ReactElement {
  return (
    <div className="admin-panel">
      <div className="secret-note">
        <Icon name="shield" />
        <span>
          Secrets are encrypted and never leave the runtime. Connected agents
          cannot read them.
        </span>
      </div>
      <div className="secret-list">
        {adminSecrets.map((secret) => (
          <Card className="secret-row" key={secret.key}>
            <Icon name="key" />
            <Mono>{secret.key}</Mono>
            <span>{secret.set ? "•••••••• set" : "not set"}</span>
            <Button size="sm" variant="secondary">
              {secret.set ? "Rotate" : "Add"}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

function AdminTrustPanel({ tool }: { tool: AgentDetailFixture }): ReactElement {
  return (
    <div className="admin-panel">
      <Card>
        <div className="trust-card-head">
          <Icon name="shield" />
          <div>
            <h3>Signed manifest · receipts on</h3>
            <p>
              Trust fields are what public Agent pages and connected agents
              inspect before calling.
            </p>
          </div>
        </div>
        <div className="manifest-grid">
          <MetaPair label="signer" value={tool.signer} />
          <MetaPair label="version" value={`v${tool.version}`} />
          <MetaPair label="runtime" value={tool.runtime} />
          <MetaPair label="updated" value={`${tool.updatedAt} ago`} />
        </div>
      </Card>
      <Card>
        <p className="section-label">Declared capabilities</p>
        <div className="capability-list">
          {tool.capabilities.map((capability) => (
            <AgentCapabilityPill
              capability={capability}
              key={`${capability.kind}-${capability.text}`}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function AdminReceiptsPanel(
  { tool }: { tool: AgentDetailFixture },
): ReactElement {
  return (
    <div className="admin-panel">
      <div className="admin-receipt-metrics">
        <MetricTile label="Revenue · 30d" value="✦297.6" />
        <MetricTile
          label="Calls · 30d"
          value={formatNumber(tool.callsPerDay * 30)}
        />
      </div>
      <div className="admin-table admin-receipts-table">
        <div className="admin-table-head">
          <span>Caller</span>
          <span>Function</span>
          <span>Earned</span>
          <span>Status</span>
          <span>When</span>
        </div>
        {adminReceipts.map((receipt) => (
          <div
            className="admin-table-row"
            key={`${receipt.caller}-${receipt.when}`}
          >
            <span className="status-cell">
              <span className={receipt.status === "error" ? "error" : ""} />
              {receipt.caller}
            </span>
            <Mono>{receipt.fn}</Mono>
            <span>✦{receipt.light.toFixed(3)}</span>
            <Mono>{receipt.status}</Mono>
            <Mono>{receipt.when}</Mono>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminLogsPanel(): ReactElement {
  return (
    <div className="admin-panel admin-log-list">
      <p className="section-label">Recent runs</p>
      {adminLogs.map((log) => (
        <div className="admin-log-row" key={`${log.fn}-${log.when}`}>
          <span className={log.status === "error" ? "error" : ""} />
          <Mono>{log.fn}</Mono>
          {"note" in log && log.note ? <small>{log.note}</small> : <small />}
          <Mono>{log.ms}ms</Mono>
          <Mono>{log.when}</Mono>
        </div>
      ))}
    </div>
  );
}

function AdminField({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}): ReactElement {
  return (
    <label className="admin-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function WalletFoundationPage(
  { live, location }: LaunchPageProps,
): ReactElement {
  const [tab, setTab] = useState<WalletTabId>(walletTabFromSearch());
  const showEarnings = tab === "earnings";
  const totals = liveWalletTotals(live.data.wallet?.wallet);
  const wallet = live.data.wallet?.wallet;
  const transactions = live.data.walletDetail?.kind === "transactions"
    ? live.data.walletDetail.items
    : wallet?.recentTransactions;
  const receipts = live.data.walletDetail?.kind === "receipts"
    ? live.data.walletDetail.items
    : wallet?.recentReceipts;
  const earnings = live.data.walletDetail?.kind === "earnings"
    ? live.data.walletDetail.items
    : wallet?.recentEarnings;
  useEffect(() => {
    setTab(walletTabFromSearch());
  }, [location.search]);

  const selectTab = (nextTab: WalletTabId) => {
    setTab(nextTab);
    syncSearchParams({ tab: nextTab === "balance" ? null : nextTab });
  };

  return (
    <div className="launch-page-narrow wallet-page">
      <ApiNotice live={live} noun="wallet" />
      <div className="wallet-hero">
        <WalletAmount
          label={showEarnings ? "Earned credits" : "Spendable credits"}
          value={showEarnings ? totals.earned : totals.spendable}
        />
        <div className="wallet-hero-actions">
          {showEarnings
            ? (
              <>
                <Button variant="secondary">Withdraw</Button>
                <Button>Transfer to Balance</Button>
              </>
            )
            : tab === "topup"
            ? null
            : (
              <Button icon="wallet" onClick={() => selectTab("topup")}>
                Add credits
              </Button>
            )}
        </div>
      </div>

      <div className="wallet-tabs" role="tablist" aria-label="Wallet sections">
        {[
          ["balance", "Balance"],
          ["topup", "Top up"],
          ["receipts", "Receipts"],
          ["earnings", "Earnings"],
        ].map(([id, label]) => (
          <button
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => selectTab(id as WalletTabId)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "balance"
        ? (
          <WalletBalancePanel
            ledger={liveLedgerRows(transactions)}
            publishRequirement={wallet?.publishRequirement}
            totals={totals}
          />
        )
        : null}
      {tab === "topup"
        ? <WalletTopUpPanel earnedCredits={totals.earned} />
        : null}
      {tab === "receipts"
        ? <WalletReceiptsPanel receipts={liveReceiptRows(receipts)} />
        : null}
      {tab === "earnings"
        ? <WalletEarningsPanel earnings={liveEarningRows(earnings)} />
        : null}
    </div>
  );
}

export function SettingsFoundationPage(
  { live, navigate }: LaunchPageProps,
): ReactElement {
  const canManageKeys = live.status !== "error";
  const useKeyFixtureFallback = live.status !== "ready" &&
    live.status !== "error";
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [newAgentPermission, setNewAgentPermission] = useState<
    "always" | "ask" | "never"
  >("ask");
  const [installedPermission, setInstalledPermission] = useState<
    "always" | "ask" | "never"
  >("ask");
  const [visibleKeys, setVisibleKeys] = useState<ApiKeyFixture[]>(() =>
    liveApiKeyFixtures(live.data.apiKeys?.apiKeys, useKeyFixtureFallback)
  );

  useEffect(() => {
    setVisibleKeys(
      liveApiKeyFixtures(live.data.apiKeys?.apiKeys, useKeyFixtureFallback),
    );
  }, [live.data.apiKeys, useKeyFixtureFallback]);

  const revokeKey = async (apiKey: ApiKeyFixture) => {
    if (!apiKey.id) return;
    try {
      await launchApi.revokeApiKey(apiKey.id);
      setVisibleKeys((keys) => keys.filter((key) => key.id !== apiKey.id));
      live.reload();
    } catch {
      // Keep the row visible; the fallback state remains usable without auth.
    }
  };

  return (
    <div className="launch-page-narrow settings-page">
      <ApiNotice live={live} noun="settings" />
      <div className="profile-strip">
        <Avatar color="#0a0a0a" name="@you" />
        <div>
          <h1>{canManageKeys ? "Account" : "Not signed in"}</h1>
          <p>
            {canManageKeys
              ? "Launch account session"
              : "Complete Google sign-in to manage keys"}
          </p>
        </div>
        {canManageKeys
          ? (
            <Button
              onClick={() => {
                void signOutLaunch().finally(() => {
                  window.location.href = "/";
                });
              }}
              size="sm"
              variant="secondary"
            >
              Sign out
            </Button>
          )
          : null}
      </div>

      <SettingsCard
        action={canManageKeys
          ? (
            <Button onClick={() => setNewKeyVisible(true)} size="sm">
              Create key
            </Button>
          )
          : null}
        subtitle="Tokens your connected agents use to call Ultralight. New keys reveal once."
        title="API keys"
      >
        <div className="api-key-primary">
          <Icon name="key" />
          <Mono>{canManageKeys ? apiKeyMask : "No account session"}</Mono>
          {canManageKeys
            ? (
              <>
                <Button size="sm" variant="secondary">Copy</Button>
                <Button
                  onClick={() => setNewKeyVisible(true)}
                  size="sm"
                  variant="secondary"
                >
                  Rotate & copy
                </Button>
              </>
            )
            : null}
        </div>
        <p className="settings-help">
          {canManageKeys
            ? "Rotating issues a new key and revokes the old one. Connected agents must be updated."
            : "The live settings endpoint needs an account session before it can show or create API keys."}
        </p>
        <div className="api-key-list">
          {visibleKeys.length > 0
            ? visibleKeys.map((key) => (
              <ApiKeyRow
                key={key.id || key.prefix}
                apiKey={key}
                onRevoke={revokeKey}
              />
            ))
            : (
              <EmptyState icon="key" title="Sign in to load API keys">
                Once the launch session is active, your real agent keys will
                appear here.
              </EmptyState>
            )}
        </div>
      </SettingsCard>

      <ByokSettingsCard live={live} navigate={navigate} />

      <SettingsCard
        subtitle="Launch-safe defaults for how your connected agent may call Agent functions."
        title="Preferences"
      >
        <PreferenceRow
          control={
            <PermissionSelect
              onChange={setNewAgentPermission}
              value={newAgentPermission}
            />
          }
          description="How your connected agent may call functions on Agents you deploy."
          title="Default permissions for new Agents"
        />
        <PreferenceRow
          control={
            <PermissionSelect
              onChange={setInstalledPermission}
              value={installedPermission}
            />
          }
          description="How your connected agent may call functions on Agents you install."
          title="Default permissions for installed Agents"
        />
        <AgentGrantApprovalRow canManage={canManageKeys} live={live} />
      </SettingsCard>

      <div className="connect-agent-callout">
        <span className="target-icon">
          <Icon name="copy" />
        </span>
        <div>
          <strong>Connecting an agent?</strong>
          <p>
            Use Add to agent. It bundles your API key into install instructions
            without exposing it in the page.
          </p>
        </div>
        <RouteButton
          icon="copy"
          navigate={navigate}
          to="/install"
          variant="secondary"
        >
          Add to agent
        </RouteButton>
      </div>

      {newKeyVisible
        ? (
          <NewApiKeyModal
            onClose={() => setNewKeyVisible(false)}
            onCreated={(apiKey) => {
              setVisibleKeys((keys) => [apiKey, ...keys]);
              live.reload();
            }}
          />
        )
        : null}
    </div>
  );
}

function WalletAmount(
  { label, value }: { label: string; value: number },
): ReactElement {
  const [whole, fraction] = value.toFixed(3).split(".");
  return (
    <div className="wallet-amount">
      <span>{label}</span>
      <strong>
        <small>✦</small>
        {Number(whole).toLocaleString()}
        <em>.{fraction}</em>
      </strong>
    </div>
  );
}

function WalletBalancePanel({
  ledger,
  publishRequirement,
  totals,
}: {
  ledger: LedgerRow[];
  publishRequirement?: LaunchPublisherPublishRequirement | null;
  totals: typeof walletSummary;
}): ReactElement {
  return (
    <div className="wallet-panel">
      <div className="wallet-metric-grid">
        <MetricTile
          label="Deposited"
          value={`✦${formatNumber(totals.deposited)}`}
        />
        <MetricTile label="Earned" value={`✦${formatNumber(totals.earned)}`} />
        <MetricTile label="Escrow" value={`✦${formatNumber(totals.escrow)}`} />
        {publishRequirement?.enabled
          ? (
            <MetricTile
              label={publishRequirement.met
                ? "Publish ready"
                : "Publish minimum"}
              value={`✦${
                formatNumber(creditsValue(publishRequirement.requiredBalance))
              }`}
            />
          )
          : null}
      </div>
      <Card className="wallet-ledger-card">
        <div className="wallet-section-head">
          <h2>Balance ledger</h2>
          <Pill>infinite scroll</Pill>
        </div>
        <div className="wallet-ledger">
          {ledger.map((row, index) => (
            <WalletLedgerRow
              first={index === 0}
              key={`${row.detail}-${row.when}-${index}`}
              row={row}
            />
          ))}
          <WalletLoadingFooter />
        </div>
      </Card>
    </div>
  );
}

function WalletTopUpPanel(
  { earnedCredits }: { earnedCredits: number },
): ReactElement {
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [creditsAmount, setCreditsAmount] = useState(10000);
  const [checkoutState, setCheckoutState] = useState<
    "idle" | "creating" | "ready" | "error"
  >("idle");
  const [checkoutMessage, setCheckoutMessage] = useState("");
  const [liveQuote, setLiveQuote] = useState<
    {
      baseDollars: number;
      feeDollars: number;
      feeNote: string;
      totalDollars: number;
    } | null
  >(null);
  const quote = liveQuote || quoteTopUp(creditsAmount, method);
  const presets = method === "earnings"
    ? [1000, 2500, 10000, 25000, Math.floor(earnedCredits)]
    : [1000, 2500, 10000, 25000, 50000];

  useEffect(() => {
    if (method === "earnings") {
      setLiveQuote(null);
      return;
    }
    let cancelled = false;
    launchApi.walletTopUpQuote({ amountCredits: creditsAmount, method })
      .then((response) => {
        if (cancelled) return;
        setLiveQuote({
          baseDollars: response.quote.baseAmountCents / 100,
          feeDollars: response.quote.processingFeeCents / 100,
          feeNote: response.quote.feeFormula,
          totalDollars: response.quote.totalAmountCents / 100,
        });
      })
      .catch(() => {
        if (!cancelled) setLiveQuote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [creditsAmount, method]);

  const createTopUpIntent = async () => {
    if (method === "earnings") {
      setCheckoutState("ready");
      setCheckoutMessage(
        "Earnings transfer is not wired into the launch API yet.",
      );
      return;
    }
    setCheckoutState("creating");
    try {
      const response = await launchApi.createWalletTopUpIntent({
        amountCredits: creditsAmount,
        method,
        termsAccepted: true,
      });
      setCheckoutState("ready");
      setCheckoutMessage(`PaymentIntent ${response.paymentIntentId} created.`);
    } catch (err) {
      setCheckoutState("error");
      setCheckoutMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="wallet-topup-grid">
      <Card className="wallet-topup-card">
        <p className="section-label">Credits amount</p>
        <div className="light-input-shell">
          <span>✦</span>
          <strong>{creditsAmount.toLocaleString()}</strong>
          <small>credits</small>
        </div>
        <div className="amount-presets">
          {presets.map((amount) => (
            <button
              className={creditsAmount === amount ? "active" : ""}
              key={amount}
              onClick={() => setCreditsAmount(amount)}
              type="button"
            >
              {amount === Math.floor(earnedCredits) && method === "earnings"
                ? "Max"
                : amount.toLocaleString()}
            </button>
          ))}
        </div>
        <div className="payment-methods">
          <button
            className={method === "card" ? "active" : ""}
            onClick={() => setMethod("card")}
            type="button"
          >
            <strong>Card</strong>
            <span>2.9% + $0.30 gross-up</span>
          </button>
          <button
            className={method === "ach" ? "active" : ""}
            onClick={() => setMethod("ach")}
            type="button"
          >
            <strong>Bank (ACH)</strong>
            <span>0.8% gross-up, capped at $5</span>
          </button>
          <button
            className={method === "earnings" ? "active" : ""}
            onClick={() => setMethod("earnings")}
            type="button"
          >
            <strong>Transfer from earnings</strong>
            <span>Instant, no fee</span>
          </button>
        </div>
      </Card>

      <Card className="wallet-quote-card">
        <p className="section-label">
          {method === "earnings" ? "Transfer summary" : "Order summary"}
        </p>
        <QuoteLine
          label={method === "earnings" ? "From earnings" : "Base value"}
          value={formatCurrency(quote.baseDollars)}
        />
        <QuoteLine
          label="Processing fee"
          muted={quote.feeNote}
          value={formatCurrency(quote.feeDollars)}
        />
        <QuoteLine
          label="Rate"
          value={method === "earnings" ? "1:1 · no fee" : "✦100 / $1"}
        />
        <div className="quote-total">
          <span>{method === "earnings" ? "Transfer" : "Total"}</span>
          <strong>{formatCurrency(quote.totalDollars)}</strong>
        </div>
        <div className="quote-receive">
          <span>You receive</span>
          <strong>✦{creditsAmount.toLocaleString()}</strong>
        </div>
        <Button onClick={createTopUpIntent} size="lg">
          {checkoutState === "creating"
            ? "Creating checkout"
            : method === "earnings"
            ? `Transfer ✦${creditsAmount.toLocaleString()}`
            : `Pay ${formatCurrency(quote.totalDollars)}`}
        </Button>
        {checkoutMessage
          ? (
            <p
              className={checkoutState === "error"
                ? "settings-help error"
                : "settings-help"}
            >
              {checkoutMessage}
            </p>
          )
          : null}
        <div className="secure-note">
          <Icon name="shield" size={12} />
          <span>
            {method === "earnings"
              ? "Instant internal transfer"
              : "Secure checkout · Stripe"}
          </span>
        </div>
      </Card>
    </div>
  );
}

function WalletReceiptsPanel(
  { receipts }: { receipts: ReceiptRowFixture[] },
): ReactElement {
  return (
    <Card className="wallet-table-card">
      <div className="wallet-section-head">
        <h2>Receipts</h2>
        <Pill>Agent calls</Pill>
      </div>
      <div className="wallet-receipt-table">
        <div className="wallet-table-head">
          <span>Agent</span>
          <span>Credits</span>
          <span>Latency</span>
          <span>Status</span>
          <span>When</span>
        </div>
        {receipts.map((receipt, index) => (
          <WalletReceiptRow
            key={`${receipt.tool}-${receipt.when}-${index}`}
            receipt={receipt}
          />
        ))}
      </div>
    </Card>
  );
}

function WalletEarningsPanel(
  { earnings }: { earnings: LedgerRow[] },
): ReactElement {
  return (
    <div className="wallet-panel">
      <Card className="payout-banner">
        <span className="target-icon">
          <Icon name="shield" />
        </span>
        <div>
          <h3>Payouts ready</h3>
          <p>
            Stripe Connect payouts are enabled. Withdraw earned credits to your
            bank or transfer to spendable balance.
          </p>
        </div>
        <Button size="sm">Withdraw earnings</Button>
      </Card>
      <Card className="wallet-ledger-card">
        <div className="wallet-section-head">
          <h2>Earnings ledger</h2>
          <Pill>creator income</Pill>
        </div>
        <div className="wallet-ledger">
          {earnings.map((row, index) => (
            <WalletLedgerRow
              first={index === 0}
              key={`${row.detail}-${row.when}-${index}`}
              row={row}
            />
          ))}
          <WalletLoadingFooter />
        </div>
      </Card>
    </div>
  );
}

function WalletLedgerRow(
  { first, row }: { first: boolean; row: LedgerRow },
): ReactElement {
  const positive = row.amount > 0;
  const glyphs: Record<LedgerRow["kind"], string> = {
    call: "→",
    earning: "✦",
    payout: "↑",
    topup: "+",
    transfer: "⇄",
  };
  return (
    <div className={first ? "wallet-ledger-row first" : "wallet-ledger-row"}>
      <Mono>{glyphs[row.kind]}</Mono>
      <span>{row.detail}</span>
      <Mono>{row.when}</Mono>
      <span className={positive ? "mono positive" : "mono"}>
        {positive ? "+" : "-"}✦{Math.abs(row.amount).toLocaleString(undefined, {
          maximumFractionDigits: 3,
          minimumFractionDigits: 3,
        })}
      </span>
    </div>
  );
}

function WalletReceiptRow(
  { receipt }: { receipt: ReceiptRowFixture },
): ReactElement {
  return (
    <div className="wallet-receipt-row">
      <span className="status-cell">
        <span className={receipt.status === "error" ? "error" : ""} />
        <Mono>
          {receipt.tool}
          <em>·{receipt.fn}</em>
        </Mono>
      </span>
      <Mono>✦{receipt.light.toFixed(3)}</Mono>
      <Mono>{receipt.latency}ms</Mono>
      <span
        className={receipt.status === "error" ? "mono error" : "mono positive"}
      >
        {receipt.status}
      </span>
      <Mono>{receipt.when}</Mono>
    </div>
  );
}

function WalletLoadingFooter(): ReactElement {
  return (
    <div className="wallet-loading-footer">
      <span className="launch-spinner" />
      <span>Loading more...</span>
    </div>
  );
}

function QuoteLine(
  { label, muted, value }: { label: string; muted?: string; value: string },
): ReactElement {
  return (
    <div className="quote-line">
      <span>{label}{muted ? <small>· {muted}</small> : null}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingsCard({
  action,
  children,
  subtitle,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  subtitle?: string;
  title: string;
}): ReactElement {
  return (
    <Card className="settings-card">
      <div className="settings-card-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action}
      </div>
      <div className="settings-card-body">{children}</div>
    </Card>
  );
}

function ApiKeyRow({
  apiKey,
  onRevoke,
}: {
  apiKey: ApiKeyFixture;
  onRevoke?: (apiKey: ApiKeyFixture) => void;
}): ReactElement {
  return (
    <div className="api-key-row">
      <Icon name="key" />
      <div>
        <strong>{apiKey.name}</strong>
        <Mono>{apiKey.prefix} · {apiKey.scopes}</Mono>
      </div>
      <div>
        <span>Last used</span>
        <Mono>{apiKey.lastUsed}</Mono>
      </div>
      <button onClick={() => onRevoke?.(apiKey)} type="button">Revoke</button>
    </div>
  );
}

function PreferenceRow({
  control,
  description,
  title,
}: {
  control: ReactNode;
  description: string;
  title: string;
}): ReactElement {
  return (
    <div className="preference-row">
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      {control}
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): ReactElement {
  return (
    <button
      aria-checked={checked}
      aria-disabled={disabled}
      className={`launch-toggle${checked ? " on" : ""}`}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      role="switch"
      type="button"
    >
      <span className="launch-toggle-knob" />
    </button>
  );
}

// Whether the user's connected agent may APPROVE cross-Agent wiring grants on
// their behalf. Off by default: when off, approvals happen here on the website.
function AgentGrantApprovalRow({
  canManage,
  live,
}: {
  canManage: boolean;
  live: LaunchPageProps["live"];
}): ReactElement {
  const [autoApprove, setAutoApprove] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    launchApi.getLaunchSettings()
      .then((settings) => {
        if (cancelled) return;
        setAutoApprove(Boolean(settings.agentGrantAutoApprove));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, live]);

  const toggle = async (next: boolean) => {
    if (saving) return;
    const previous = autoApprove;
    setAutoApprove(next);
    setSaving(true);
    try {
      const settings = await launchApi.updateLaunchSettings({
        agentGrantAutoApprove: next,
      });
      setAutoApprove(Boolean(settings.agentGrantAutoApprove));
    } catch {
      setAutoApprove(previous);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PreferenceRow
      control={
        <Toggle
          checked={autoApprove}
          disabled={!canManage || !loaded || saving}
          onChange={toggle}
        />
      }
      description="Let your connected agent approve cross-Agent wiring grants — off by default; when off, approvals happen here on the website."
      title="Agent grant approval"
    />
  );
}

function PermissionSelect({
  onChange,
  value,
}: {
  onChange: (value: "always" | "ask" | "never") => void;
  value: "always" | "ask" | "never";
}): ReactElement {
  const labels = {
    always: "Always",
    ask: "Always ask",
    never: "Never",
  } as const;
  return (
    <div className="permission-select">
      {(["always", "ask", "never"] as const).map((option) => (
        <button
          className={value === option ? "active" : ""}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

function ByokSettingsCard({
  live,
  navigate,
}: {
  live: LaunchPageProps["live"];
  navigate: (to: string) => void;
}): ReactElement {
  const canManageKeys = live.status !== "error";
  // Fixtures only stand in while live data is absent; a live response is
  // authoritative even if empty (matches the API-keys card pattern).
  const providers = live.data.byok
    ? live.data.byok.providers
    : byokProviderFixtures;
  const [selectedProvider, setSelectedProvider] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [validateOnSave, setValidateOnSave] = useState(true);
  const [formState, setFormState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const [formMessage, setFormMessage] = useState("");
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const providerId = providers.some((option) => option.id === selectedProvider)
    ? selectedProvider
    : providers[0]?.id || "";
  const activeOption = providers.find((option) => option.id === providerId);

  const saveProviderKey = async () => {
    if (formState === "saving") return;
    if (!providerId || !apiKeyDraft.trim()) {
      setFormState("error");
      setFormMessage("Pick a provider and paste an API key first.");
      return;
    }
    setFormState("saving");
    setFormMessage("");
    try {
      const response = await launchApi.upsertByokProvider(providerId, {
        apiKey: apiKeyDraft.trim(),
        ...(modelDraft.trim() ? { model: modelDraft.trim() } : {}),
        validate: validateOnSave,
      });
      // Stored keys are never displayed again; drop the draft immediately.
      setApiKeyDraft("");
      setModelDraft("");
      setFormState("idle");
      setFormMessage(response.message);
      live.reload();
    } catch (err) {
      setFormState("error");
      setFormMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const runProviderAction = async (
    provider: string,
    action: () => Promise<{ message: string }>,
  ) => {
    if (busyProvider) return;
    setBusyProvider(provider);
    setFormState("idle");
    setFormMessage("");
    try {
      const response = await action();
      setFormMessage(response.message);
      live.reload();
    } catch (err) {
      setFormState("error");
      setFormMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <SettingsCard
      subtitle="Bring your own inference key, or let platform runs bill credits. Stored keys are encrypted and never shown again."
      title="Model keys (BYOK)"
    >
      <ByokBillingBanner
        inference={live.data.inferenceOptions}
        navigate={navigate}
        providers={providers}
      />
      {canManageKeys
        ? (
          <>
            <div className="byok-provider-list">
              {providers.map((option) => (
                <ByokProviderRow
                  busy={busyProvider === option.id}
                  key={option.id}
                  onRemove={() =>
                    runProviderAction(
                      option.id,
                      () => launchApi.deleteByokProvider(option.id),
                    )}
                  onSetPrimary={() =>
                    runProviderAction(
                      option.id,
                      () => launchApi.setByokPrimary(option.id),
                    )}
                  option={option}
                />
              ))}
            </div>
            <form
              className="arg-grid byok-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveProviderKey();
              }}
            >
              <label>
                <span>provider</span>
                <select
                  onChange={(event) =>
                    setSelectedProvider(event.currentTarget.value)}
                  value={providerId}
                >
                  {providers.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>API key</span>
                <input
                  autoComplete="new-password"
                  onChange={(event) =>
                    setApiKeyDraft(event.currentTarget.value)}
                  placeholder={activeOption?.apiKeyPrefix
                    ? `${activeOption.apiKeyPrefix}...`
                    : "paste key"}
                  type="password"
                  value={apiKeyDraft}
                />
              </label>
              <label>
                <span>model (optional)</span>
                <input
                  onChange={(event) => setModelDraft(event.currentTarget.value)}
                  placeholder={activeOption?.defaultModel || "provider default"}
                  value={modelDraft}
                />
              </label>
            </form>
            <div className="byok-form-footer">
              <label className="byok-validate">
                <input
                  checked={validateOnSave}
                  onChange={(event) =>
                    setValidateOnSave(event.currentTarget.checked)}
                  type="checkbox"
                />
                Validate key on save
              </label>
              <Button onClick={() => void saveProviderKey()} size="sm">
                {formState === "saving"
                  ? "Saving"
                  : activeOption?.configured
                  ? "Update key"
                  : "Add key"}
              </Button>
            </div>
            <p className="settings-help">
              Keys are sent once, stored encrypted, and used server-side only.
              {activeOption?.apiKeyUrl
                ? (
                  <>
                    {" "}
                    <a
                      href={activeOption.apiKeyUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Get a {activeOption.name} key
                    </a>
                  </>
                )
                : null}
            </p>
          </>
        )
        : (
          <EmptyState icon="key" title="Sign in to manage model keys">
            The live BYOK endpoint needs an account session before it can show
            configured providers.
          </EmptyState>
        )}
      {formMessage
        ? (
          <p
            className={formState === "error"
              ? "settings-help error"
              : "settings-help"}
          >
            {formMessage}
          </p>
        )
        : null}
    </SettingsCard>
  );
}

function ByokProviderRow({
  busy,
  onRemove,
  onSetPrimary,
  option,
}: {
  busy: boolean;
  onRemove: () => void;
  onSetPrimary: () => void;
  option: LaunchByokProviderOption;
}): ReactElement {
  const configuredModel = option.model || option.defaultModel;
  return (
    <div className="preference-row byok-provider-row">
      <div>
        <strong>{option.name}</strong>
        <span>
          {option.configured
            ? `Key saved${configuredModel ? ` · ${configuredModel}` : ""}`
            : option.description || "No key saved"}
        </span>
      </div>
      {option.primary ? <Pill tone="green">primary</Pill> : null}
      <Pill tone={option.configured ? "green" : "default"}>
        {option.configured ? "configured" : "not configured"}
      </Pill>
      {option.configured && !option.primary
        ? (
          <Button onClick={onSetPrimary} size="sm" variant="secondary">
            {busy ? "Working" : "Set primary"}
          </Button>
        )
        : null}
      {option.configured
        ? (
          <Button onClick={onRemove} size="sm" variant="ghost">
            {busy ? "Working" : "Remove"}
          </Button>
        )
        : null}
    </div>
  );
}

function ByokBillingBanner({
  inference,
  navigate,
  providers,
}: {
  inference?: LaunchInferenceOptionsResponse;
  navigate: (to: string) => void;
  providers: LaunchByokProviderOption[];
}): ReactElement {
  if (!inference) {
    // Auth-neutral: this branch covers both signed-out visitors and
    // signed-in users whose inference-options fetch failed.
    return (
      <div className="byok-banner">
        <Icon name="spark" />
        <span>
          Runs bill platform credits unless a primary BYOK provider key is
          configured.
        </span>
      </div>
    );
  }
  if (inference.billingMode === "byok") {
    const primaryName =
      providers.find((option) => option.id === inference.primaryProvider)
        ?.name || inference.primaryProvider || "provider";
    return (
      <div className="byok-banner">
        <Icon name="key" />
        <span>Runs use your {primaryName} key — no credits are charged.</span>
      </div>
    );
  }
  return (
    <div className="byok-banner">
      <Icon name="wallet" />
      <span>
        Platform inference is billed in credits. {inference.credits.display}
        {" "}
        spendable
        {inference.credits.usable
          ? "."
          : ` — below the ✦${inference.credits.minimumForPlatformInference} minimum for platform inference.`}
        {" "}
        <RouteLink navigate={navigate} to="/wallet">Manage wallet</RouteLink>
      </span>
    </div>
  );
}

function NewApiKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (apiKey: ApiKeyFixture) => void;
}): ReactElement {
  const [plaintextToken, setPlaintextToken] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(true);
  const onCreatedRef = useRef(onCreated);

  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  useEffect(() => {
    let cancelled = false;
    launchApi.createApiKey({
      expiresInDays: 90,
      name: `Launch web ${new Date().toLocaleDateString()}`,
      scopes: ["apps:call"],
    })
      .then((response) => {
        if (cancelled) return;
        setPlaintextToken(response.plaintextToken);
        onCreatedRef.current({
          created: shortDate(response.apiKey.createdAt),
          id: response.apiKey.id,
          lastUsed: "never",
          name: response.apiKey.name,
          prefix: response.apiKey.tokenPrefix,
          scopes: response.apiKey.scopes.join(" · ") || "all",
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setCreating(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copyToken = () => {
    const token = plaintextToken || apiKeyMask;
    navigator.clipboard?.writeText(token).catch(() => {});
  };

  return (
    <div className="settings-modal-backdrop">
      <Card className="new-key-modal">
        <div className="modal-title-row">
          <span className="target-icon">
            <Icon name="key" />
          </span>
          <h2>
            {creating
              ? "Creating API key"
              : errorMessage
              ? "Could not create key"
              : "API key created"}
          </h2>
        </div>
        <p>
          {errorMessage
            ? "Sign in with an account session or set a launch auth token before creating a key."
            : "Copy it now. For your security, you will not be able to see it again."}
        </p>
        <div className="new-key-value">
          <Mono>
            {creating
              ? "issuing..."
              : errorMessage || plaintextToken || apiKeyMask}
          </Mono>
          <Button icon="copy" onClick={copyToken} size="sm" variant="secondary">
            Copy
          </Button>
        </div>
        <div className="modal-actions">
          <Button onClick={onClose} size="sm" variant="secondary">
            Add to install config
          </Button>
          <Button onClick={onClose} size="sm">Done</Button>
        </div>
      </Card>
    </div>
  );
}

function ValueProps(): ReactElement {
  const items = [
    [
      "01",
      "One core",
      "Plug in and inherit context, Agents, balance, and preferences.",
    ],
    ["02", "No subscriptions", "Agents pay per call, only for what they use."],
    [
      "03",
      "Open marketplace",
      "Every published Agent is discoverable and callable by any connected agent.",
    ],
    [
      "04",
      "Inherited power",
      "Every deployed Agent inherits composability and distribution.",
    ],
  ] as const;
  return (
    <section className="value-grid">
      {items.map(([number, title, body]) => (
        <div className="value-item" key={number}>
          <span>{number}</span>
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
      ))}
    </section>
  );
}

function SharedCore(): ReactElement {
  return (
    <div className="shared-core">
      {["Context", "Agents", "Auth", "Payments"].map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

function AgentOrbit(): ReactElement {
  return (
    <div className="agent-orbit" aria-hidden="true">
      <svg className="orbit-lines" viewBox="0 0 440 440" aria-hidden="true">
        <ellipse cx="220" cy="220" rx="204" ry="102" />
        <ellipse cx="220" cy="220" rx="170" ry="85" />
        <ellipse cx="220" cy="220" rx="136" ry="68" />
        <ellipse cx="220" cy="220" rx="96" ry="48" />
      </svg>
      <span className="orbit-node node-center">
        <Icon name="spark" size={34} />
      </span>
      {orbitAgents.map((agent) => (
        <img
          alt={agent.alt}
          className={`orbit-agent ${agent.className}`}
          height={34}
          key={agent.alt}
          src={agent.src}
          width={34}
        />
      ))}
    </div>
  );
}

function ConfigPreview({
  code,
  highlight,
}: {
  code?: string;
  highlight?: string;
}): ReactElement {
  const config = code ?? genericMcpConfig("$KEY");
  return (
    <div className="config-preview">
      <div className="config-titlebar">
        <span style={{ background: "#ec6a5e" }} />
        <span style={{ background: "#f4bf4f" }} />
        <span style={{ background: "#61c554" }} />
        <Mono>mcp.json</Mono>
      </div>
      <pre>
        <code>{highlight ? highlightSnippet(config, highlight) : config}</code>
      </pre>
    </div>
  );
}

function highlightSnippet(text: string, highlight: string): ReactNode {
  if (!highlight || !text.includes(highlight)) return text;
  const parts = text.split(highlight);
  return parts.map((part, index) => (
    <span key={`${part}-${index}`}>
      {part}
      {index < parts.length - 1 ? <mark>{highlight}</mark> : null}
    </span>
  ));
}

function CompactAgentCard({ tool }: { tool: AgentFixture }): ReactElement {
  const free = tool.free || tool.callPrice === 0;
  return (
    <Card className="compact-tool-card">
      <div className="compact-tool-title">
        <Avatar color={tool.color} name={tool.author} />
        <Mono>{tool.name}</Mono>
      </div>
      <p>{tool.summary}</p>
      <div className="compact-tool-footer">
        <Mono>{formatNumber(tool.installs)} installs</Mono>
        {free
          ? <span>Free</span>
          : <span>{formatCredits(tool.callPrice)}/call</span>}
      </div>
    </Card>
  );
}

function KeyBanner({ signedIn }: { signedIn: boolean }): ReactElement {
  return (
    <section className={signedIn ? "key-banner signed-in" : "key-banner"}>
      <span className="target-icon">
        <Icon name="key" />
      </span>
      <div>
        <h2>
          {signedIn
            ? "Your API key is included below"
            : "Sign in to drop your key into these snippets"}
        </h2>
        <p>
          {signedIn
            ? (
              <>
                Copy any snippet and it is ready to run:{" "}
                <Mono>{apiKeyMask}</Mono>.
              </>
            )
            : (
              <>
                Until then they show{" "}
                <Mono>{apiKeyPlaceholder}</Mono>; replace it with your own
                token.
              </>
            )}
        </p>
      </div>
      <Button size="sm" variant={signedIn ? "secondary" : "primary"}>
        {signedIn ? "Copy key" : "Sign in"}
      </Button>
    </section>
  );
}

function TargetPicker({
  active,
  onPick,
  targets = installTargets,
}: {
  active: string;
  onPick: (target: string) => void;
  targets?: InstallTarget[];
}): ReactElement {
  return (
    <div className="target-picker">
      {(["MCP", "Direct"] as const).map((group) => (
        <div key={group}>
          <p className="section-label">
            {group === "MCP" ? "Remote MCP servers" : "CLI and API"}
          </p>
          <div className="target-list">
            {targets.filter((target) => target.group === group).map((
              target,
            ) => (
              <button
                className={active === target.target ? "active" : ""}
                key={target.target}
                onClick={() => onPick(target.target)}
                type="button"
              >
                <Icon name={group === "MCP" ? "spark" : "terminal"} />
                {target.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchControls({
  query,
  setQuery,
}: {
  query: string;
  setQuery: (query: string) => void;
}): ReactElement {
  return (
    <label className="search-control">
      <Icon name="search" />
      <input
        aria-label="Search Agents"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search Agents, capabilities, functions..."
        type="search"
        value={query}
      />
      {query
        ? <button onClick={() => setQuery("")} type="button">Clear</button>
        : null}
    </label>
  );
}

function RetrievalNote(
  { mode, query }: { mode?: string; query: string },
): ReactElement {
  if (!query) {
    return (
      <div className="retrieval-note">
        Browsing all public Agents · {mode || "top by install"}
      </div>
    );
  }
  return (
    <div className="retrieval-note active">
      <span /> {mode || "hybrid"} retrieval · semantic + lexical fallback
    </div>
  );
}

function StoreAgentCard({ tool }: { tool: AgentFixture }): ReactElement {
  return (
    <Card className="store-tool-card">
      <div className="store-card-title">
        <Avatar color={tool.color} name={tool.author} />
        <div>
          <h3>{tool.name}</h3>
          <span>{tool.author}</span>
        </div>
        <Pill>{tool.kind}</Pill>
      </div>
      <p>{tool.summary}</p>
      <div className="store-card-meta">
        <Mono>{formatNumber(tool.installs)} installs</Mono>
        {tool.free || tool.callPrice === 0
          ? <span>Free</span>
          : <span>{formatCredits(tool.callPrice)}/call</span>}
      </div>
      <Sparkline points={tool.spark} growth={tool.growth} />
    </Card>
  );
}

function Sparkline(
  { growth, points }: { growth: number; points: number[] },
): ReactElement {
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const polyline = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 74;
    const y = 24 - ((value - min) / range) * 24;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg
      className={growth > 0.1 ? "sparkline growing" : "sparkline"}
      viewBox="0 0 74 28"
      aria-hidden="true"
    >
      <polyline points={polyline} />
    </svg>
  );
}

function PrimitivesRail(
  { navigate }: { navigate: (to: string) => void },
): ReactElement {
  return (
    <Card className="primitives-rail">
      <p className="section-label">For agents · platform primitives</p>
      {primitives.map(([key, label, description, route]) => (
        <button
          key={key}
          onClick={() => navigate(route)}
          type="button"
        >
          <span>
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
          <Mono>{route}</Mono>
        </button>
      ))}
    </Card>
  );
}

function Leaderboard({
  rows,
  subtitle,
  title,
}: {
  rows: LeaderboardRow[];
  subtitle: string;
  title: string;
}): ReactElement {
  const [period, setPeriod] = useState("30d");
  return (
    <Card className="leaderboard-card">
      <div className="leaderboard-head">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div className="mini-segments">
          {["30d", "90d", "all"].map((option) => (
            <button
              className={period === option ? "active" : ""}
              key={option}
              onClick={() => setPeriod(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div className="leaderboard-list">
        {rows.map((row) => (
          <div className="leader-row" key={`${title}-${row.rank}`}>
            <Mono>{row.rank}</Mono>
            <Avatar color={row.color} name={row.name} />
            <span>
              <strong>{row.name}</strong>
              {row.featured ? <small>{row.featured}</small> : null}
            </span>
            <Mono>{formatCredits(row.value)}</Mono>
          </div>
        ))}
      </div>
    </Card>
  );
}

function NoResults({ onClear }: { onClear: () => void }): ReactElement {
  return (
    <div className="store-empty">
      <EmptyState icon="search" title="No Agents match that yet">
        Semantic search would fall back to lexical results here. Try broader
        terms, or browse by kind.
      </EmptyState>
      <Button onClick={onClear} size="sm" variant="secondary">
        Clear search
      </Button>
    </div>
  );
}

export function CapabilityTags(): ReactElement {
  return (
    <div className="capability-tags">
      {LAUNCH_SCOPE_CONTRACT.includedCapabilities.map((capability) => (
        <CapabilityTag capability={capability} key={capability} />
      ))}
    </div>
  );
}

export function DeferredTags(): ReactElement {
  return (
    <div className="capability-tags">
      {LAUNCH_SCOPE_CONTRACT.deferredCapabilities.map((capability) => (
        <CapabilityTag capability={capability} deferred key={capability} />
      ))}
    </div>
  );
}

function CapabilityTag({
  capability,
  deferred = false,
}: {
  capability: LaunchDeferredCapability | LaunchIncludedCapability;
  deferred?: boolean;
}): ReactElement {
  return (
    <Pill tone={deferred ? "amber" : "green"}>
      {capability.replaceAll("_", " ")}
    </Pill>
  );
}

export function FoundationNotice(
  { children }: { children: ReactNode },
): ReactElement {
  return <EmptyState title="Ready for page port">{children}</EmptyState>;
}

function createAgentDetail(tool: AgentFixture): AgentDetailFixture {
  const base: AgentDetailFixture = {
    ...tool,
    callsPerDay: Math.round(tool.installs * 1.48),
    capabilities: defaultCapabilities,
    functions: [
      {
        args: ["input"],
        description: `Run the primary ${tool.name} action.`,
        name: "run",
        p50: 120,
        permission: "ask",
        price: tool.free ? 0 : tool.callPrice,
      },
    ],
    relationship: "public",
    runtime: tool.kind === "mcp" ? "deno · edge" : "worker · http",
    signer: `${tool.author.replace("@", "")}.studio`,
    title: titleizeAgentName(tool.name),
    updatedAt: "4d",
    version: "1.0.0",
    visibility: "public",
  };

  const overrides: Record<string, Partial<AgentDetailFixture>> = {
    currency_convert: {
      callsPerDay: 9200,
      capabilities: [
        { kind: "read", text: "reference FX rates" },
        { kind: "read", text: "user-supplied currency pair and amount" },
        { kind: "net", text: "outbound HTTPS to rate provider" },
      ],
      functions: [
        {
          args: ["from", "to", "amount"],
          description: "Spot-rate conversion between any pair.",
          name: "convert",
          p50: 84,
          permission: "ask",
          price: 0.002,
        },
        {
          args: ["from", "to", "date"],
          description: "End-of-day historical rate for a given date.",
          name: "historical",
          p50: 120,
          permission: "ask",
          price: 0.003,
        },
        {
          args: [],
          description: "List all supported currency pairs.",
          name: "list_pairs",
          p50: 40,
          permission: "always",
          price: 0,
        },
      ],
      signer: "anchor.studio",
      title: "Currency Convert",
      updatedAt: "2d",
      version: "1.12.0",
    },
    get_weather: {
      callsPerDay: 38200,
      capabilities: [
        { kind: "read", text: "public weather data" },
        { kind: "read", text: "user-supplied city or coordinates" },
        { kind: "net", text: "outbound HTTPS to weather providers" },
      ],
      functions: [
        {
          args: ["city", "days"],
          description: "Five-day hyperlocal forecast.",
          name: "forecast",
          p50: 142,
          permission: "ask",
          price: 0.012,
        },
        {
          args: ["city"],
          description: "Current temperature and conditions.",
          name: "now",
          p50: 68,
          permission: "always",
          price: 0.004,
        },
        {
          args: ["city"],
          description: "Active severe-weather alerts.",
          name: "alerts",
          p50: 92,
          permission: "ask",
          price: 0.006,
        },
        {
          args: ["city", "date"],
          description: "Look up any past day.",
          name: "historical",
          p50: 280,
          permission: "ask",
          price: 0.018,
        },
      ],
      signer: "kepler.studio",
      title: "Get Weather",
      updatedAt: "4d",
      version: "2.4.1",
    },
    github_diff: {
      capabilities: [
        { kind: "read", text: "repository branch metadata" },
        { kind: "read", text: "CI status and pull request comments" },
        { kind: "net", text: "outbound HTTPS to GitHub" },
      ],
      functions: [
        {
          args: ["repo", "base", "head"],
          description: "Summarize changes between two refs.",
          name: "diff",
          p50: 210,
          permission: "ask",
          price: 0,
        },
        {
          args: ["repo", "pull_request"],
          description: "Read recent review comments and CI status.",
          name: "review_context",
          p50: 160,
          permission: "ask",
          price: 0,
        },
      ],
      signer: "octo.tools",
      title: "GitHub Diff",
      updatedAt: "1d",
      version: "0.9.4",
    },
    maps_route: {
      capabilities: [
        { kind: "read", text: "origin and destination text" },
        { kind: "net", text: "outbound HTTPS to route provider" },
      ],
      functions: [
        {
          args: ["origin", "destination", "mode"],
          description: "Return ETA, route distance, and transit mode.",
          name: "route",
          p50: 120,
          permission: "ask",
          price: 0,
        },
      ],
      signer: "cartography.tools",
      title: "Maps Route",
      updatedAt: "3d",
      version: "1.3.0",
    },
    pdf_parse: {
      capabilities: [
        { kind: "read", text: "uploaded PDF files" },
        { kind: "read", text: "text, tables, and citations" },
      ],
      functions: [
        {
          args: ["file_url"],
          description: "Extract layout-aware text and tables.",
          name: "parse",
          p50: 420,
          permission: "ask",
          price: 0.018,
        },
        {
          args: ["file_url", "query"],
          description: "Find cited spans that match a query.",
          name: "cite",
          p50: 300,
          permission: "ask",
          price: 0.012,
        },
      ],
      signer: "vellum.tools",
      title: "PDF Parse",
      updatedAt: "5d",
      version: "1.7.2",
    },
    stripe_subscribe: {
      capabilities: [
        { kind: "write", text: "create Stripe subscriptions" },
        { kind: "read", text: "subscription and metering status" },
        { kind: "net", text: "outbound HTTPS to Stripe" },
      ],
      functions: [
        {
          args: ["customer", "price_id"],
          description: "Create a subscription and return a receipt.",
          name: "create_subscription",
          p50: 190,
          permission: "ask",
          price: 0.024,
        },
        {
          args: ["subscription", "quantity"],
          description: "Record metered usage for an active subscription.",
          name: "meter_usage",
          p50: 110,
          permission: "ask",
          price: 0.008,
        },
      ],
      signer: "stripe.com",
      title: "Stripe Subscribe",
      updatedAt: "1d",
      version: "3.2.0",
    },
  };

  return { ...base, ...overrides[tool.slug] };
}

function adminAgentFromRoute(id?: string): AgentDetailFixture {
  if (!id) return agentDetails.get_weather;
  return Object.values(agentDetails).find((tool) =>
    tool.id === id || tool.slug === id
  ) || agentDetails.get_weather;
}

function queryParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) || "";
}

function syncSearchParams(updates: Record<string, string | null>): void {
  const next = new URL(window.location.href);
  Object.entries(updates).forEach(([key, value]) => {
    if (value) next.searchParams.set(key, value);
    else next.searchParams.delete(key);
  });
  window.history.replaceState(
    null,
    "",
    `${next.pathname}${next.search}${next.hash}`,
  );
}

function storeQueryFromSearch(): string {
  return queryParam("q");
}

function storeKindFromSearch(): StoreKindFilter {
  const kind = queryParam("kind");
  return kind === "http" || kind === "mcp" ? kind : "all";
}

function libraryViewFromSearch(): LibraryView {
  return queryParam("view") === "owned" ? "owned" : "installed";
}

function agentTabFromSearch(): AgentPageTabId {
  const tab = queryParam("tab");
  if (tab === "details" || tab === "functions" || tab === "wiring") return tab;
  return "functions";
}

function adminTabFromSearch(): AdminTabId {
  const tab = queryParam("tab");
  return adminTabs.some(([id]) => id === tab) ? tab as AdminTabId : "edit";
}

function walletTabFromSearch(): WalletTabId {
  const tab = queryParam("tab");
  return ["balance", "earnings", "receipts", "topup"].includes(tab)
    ? tab as WalletTabId
    : "balance";
}

function quoteTopUp(creditsAmount: number, method: PaymentMethod): {
  baseDollars: number;
  feeDollars: number;
  feeNote: string;
  totalDollars: number;
} {
  const baseDollars = creditsAmount / 100;
  if (method === "earnings") {
    return {
      baseDollars,
      feeDollars: 0,
      feeNote: "none",
      totalDollars: baseDollars,
    };
  }
  if (method === "ach") {
    const uncappedTotal = baseDollars / 0.992;
    const totalDollars = uncappedTotal > 625 ? baseDollars + 5 : uncappedTotal;
    return {
      baseDollars,
      feeDollars: totalDollars - baseDollars,
      feeNote: "0.8%, max $5",
      totalDollars,
    };
  }
  const totalDollars = (baseDollars + 0.3) / 0.971;
  return {
    baseDollars,
    feeDollars: totalDollars - baseDollars,
    feeNote: "2.9% + $0.30",
    totalDollars,
  };
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function argDefault(arg: string): string {
  const defaults: Record<string, string> = {
    amount: "100",
    base: "main",
    city: "Tokyo",
    customer: "cus_launch",
    date: "2026-05-01",
    days: "5",
    destination: "SoHo",
    file_url: "https://example.com/report.pdf",
    from: "USD",
    head: "feature",
    input: "demo",
    mode: "transit",
    origin: "Brooklyn",
    price_id: "price_agent_pro",
    pull_request: "42",
    quantity: "1",
    query: "risk factors",
    repo: "owner/repo",
    subscription: "sub_launch",
    to: "EUR",
  };
  return defaults[arg] || "";
}

function argHint(arg: string): string {
  const hints: Record<string, string> = {
    amount: "number",
    city: "city name",
    date: "YYYY-MM-DD",
    days: "1-14",
    from: "ISO 4217",
    mode: "driving, walking, transit",
    to: "ISO 4217",
  };
  return hints[arg] || "value";
}

function builderRankFor(author: string): string {
  const row = builderLeaders.find((leader) => leader.name === author);
  return row ? String(row.rank) : "12";
}

function formatAgentPrice(value: number): string {
  return value > 0 ? `✦${formatCredits(value)}` : "Free";
}

function functionResponse(slug: string, name: string): Record<string, unknown> {
  const responses: Record<string, Record<string, unknown>> = {
    "currency_convert.convert": {
      amount: 100,
      asOf: "2026-06-02T14:00Z",
      from: "USD",
      rate: 0.924,
      result: 92.4,
      to: "EUR",
    },
    "currency_convert.historical": {
      date: "2026-05-01",
      from: "USD",
      rate: 0.918,
      to: "EUR",
    },
    "currency_convert.list_pairs": {
      count: 182,
      sample: ["USD/EUR", "USD/JPY", "GBP/USD", "EUR/JPY"],
    },
    "get_weather.alerts": {
      active: false,
      alerts: [],
      city: "Tokyo",
    },
    "get_weather.forecast": {
      city: "Tokyo",
      days: 5,
      forecast: [
        { day: "Mon", hi: 24, lo: 17, sky: "cloudy" },
        { day: "Tue", hi: 23, lo: 16, sky: "rain" },
      ],
      unit: "C",
    },
    "get_weather.historical": {
      city: "Tokyo",
      conditions: "clear",
      date: "2026-05-01",
      tempC: 19,
    },
    "get_weather.now": {
      city: "Tokyo",
      conditions: "partly cloudy",
      hi: 24,
      lo: 15,
      tempC: 17,
    },
  };
  return responses[`${slug}.${name}`] ||
    { ok: true, receipt: "rec_launch_demo" };
}

function titleizeAgentName(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function genericMcpConfig(key: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        ultralight: {
          headers: { Authorization: `Bearer ${key}` },
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );
}

function formatNumber(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatCredits(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(3);
}
