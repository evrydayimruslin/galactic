import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  LAUNCH_SCOPE_CONTRACT,
  type LaunchAgentFunctionPermissionsResponse,
  type LaunchApiKeySummary,
  type LaunchDeferredCapability,
  type LaunchFunctionSummary,
  type LaunchIncludedCapability,
  type LaunchInstallInstruction,
  type LaunchLeaderboardEntry,
  type LaunchMoneyAmount,
  type LaunchPublisherPublishRequirement,
  type LaunchToolSummary,
  type LaunchTrustCard,
  type LaunchWalletEarningSummary,
  type LaunchWalletReceiptSummary,
  type LaunchWalletSummary,
  type LaunchWalletTransaction,
} from "../../../../shared/contracts/launch.ts";
import type { LaunchPageProps } from "../App";
import { signOutLaunch } from "../lib/auth";
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

interface ToolFixture {
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
  widgets: number;
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

interface ToolCapability {
  kind: "read" | "write" | "net";
  text: string;
}

interface ToolFunctionFixture {
  args: string[];
  description: string;
  name: string;
  p50: number;
  permission: "always" | "ask" | "never";
  price: number;
}

interface ToolWidgetFixture {
  description: string;
  id: string;
  label: string;
}

interface ToolDetailFixture extends ToolFixture {
  callsPerDay: number;
  capabilities: ToolCapability[];
  functions: ToolFunctionFixture[];
  runtime: string;
  signer: string;
  title: string;
  updatedAt: string;
  version: string;
  visibility: "public" | "private" | "unlisted";
  widgetList: ToolWidgetFixture[];
}

const apiKeyMask = "ulk_live_••••••••••••4xN4";
const apiKeyPlaceholder = "$ULTRALIGHT_API_KEY";
const mcpUrl = "https://api.ultralight.dev/mcp/platform";

const orbitAgents = [
  { alt: "Codex", className: "agent-one", src: agentCodexUrl },
  { alt: "Cursor", className: "agent-two", src: agentCursorUrl },
  { alt: "OpenClaw", className: "agent-three", src: agentOpenclawUrl },
  { alt: "Claude", className: "agent-four", src: agentClaudeUrl },
] as const;

const discoverTools: ToolFixture[] = [
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
    summary: "Hyper-local weather, forecasts, and severe-weather widgets.",
    widgets: 2,
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
    widgets: 0,
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
    widgets: 1,
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
    widgets: 0,
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
    widgets: 0,
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
    widgets: 1,
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
    "Discover tools",
    "Find public agent-native tools and widgets.",
    "/store",
  ],
  [
    "wallet",
    "Light wallet",
    "Spendable Light for installs, calls, hosting.",
    "/wallet",
  ],
  [
    "widgets",
    "Widgets",
    "Open public UI surfaces attached to tools.",
    "/tools/:slug",
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
      "Reload Cursor so agents can discover Ultralight tools.",
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
      "Allow the agent to list tools before calling specific tools.",
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
      "Use the Ultralight CLI to login, upload, test, and run deployed tools.",
    group: "Direct",
    label: "CLI",
    requiresApiKey: true,
    steps: [
      "Install the ultralightpro package.",
      "Run ultralight login --token <your-token>.",
      "Run ultralight upload . from a deployable tool directory.",
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
  "Discover tools + primitives",
  "Inspect pricing, trust, widgets",
  "Call through MCP / API",
  "Return widget links + receipts",
];

const defaultCapabilities: ToolCapability[] = [
  { kind: "read", text: "public source data" },
  { kind: "net", text: "outbound HTTPS" },
];

const toolDetails: Record<string, ToolDetailFixture> = Object.fromEntries(
  discoverTools.map((tool) => {
    const detail = createToolDetail(tool);
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
  ["widgets", "Widgets"],
  ["secrets", "Secrets"],
  ["trust", "Trust"],
  ["receipts", "Receipts"],
  ["logs", "Logs"],
] as const;

type AdminTabId = typeof adminTabs[number][0];
type LibraryView = "installed" | "owned";
type StoreKindFilter = "all" | ToolFixture["kind"];
type ToolPageTabId = "details" | "functions" | "widgets";

const visibilityOptions = [
  [
    "public",
    "Public",
    "Listed in the Store, embeddable widgets, installable by anyone.",
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

const livePalette = [
  "#7c3aed",
  "#0891b2",
  "#635bff",
  "#ea580c",
  "#0a0a0a",
  "#10b981",
];

function liveToolFixture(
  tool: LaunchToolSummary,
  options: {
    functions?: LaunchFunctionSummary[];
    permissions?: LaunchAgentFunctionPermissionsResponse;
    trustCard?: LaunchTrustCard;
  } = {},
): ToolDetailFixture {
  const base = toolDetails[tool.slug] || createToolDetail({
    author: liveOwnerLabel(tool.owner),
    callPrice: lightValue(tool.pricing?.defaultCallPrice),
    category: tool.tags?.[0] || tool.kind.toUpperCase(),
    color: stableColor(tool.id),
    free: lightValue(tool.pricing?.defaultCallPrice) === 0,
    growth: Math.max(0.03, Number(tool.relevance?.score || 0.08)),
    id: tool.id,
    installs: 0,
    kind: tool.kind,
    name: tool.name,
    slug: tool.slug,
    spark: stableSpark(tool.id),
    summary: tool.description || "Agent-callable Ultralight tool.",
    widgets: tool.widgets.length,
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
      permission: permissions.get(fn.name) || fn.agentPermission?.policy ||
        base.functions[index]?.permission || "ask",
      price: lightValue(fn.pricing?.defaultCallPrice),
    }))
    : base.functions;
  const widgets = tool.widgets.length > 0
    ? tool.widgets.map((widget) => ({
      description: widget.description || "Public tool UI preview.",
      id: widget.id,
      label: widget.label,
    }))
    : base.widgetList;
  const trust = options.trustCard;
  const paidFunctionPrices = functions.map((fn) => fn.price).filter((price) =>
    price > 0
  );
  const callPrice = lightValue(tool.pricing?.defaultCallPrice) ||
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
    runtime: trust?.runtime || base.runtime,
    signer: trust?.signer || base.signer,
    slug: tool.slug,
    summary: tool.description || base.summary,
    title: titleizeToolName(tool.name),
    updatedAt: relativeTime(tool.updatedAt) || base.updatedAt,
    version: trust?.version || base.version,
    visibility: tool.visibility,
    widgetList: widgets,
    widgets: widgets.length,
  };
}

function liveStoreTools(tools?: LaunchToolSummary[]): ToolFixture[] {
  if (!tools || tools.length === 0) return discoverTools;
  return tools.map((tool) => liveToolFixture(tool));
}

function liveDetailTool(
  tool?: LaunchToolSummary,
  functions?: LaunchFunctionSummary[],
  permissions?: LaunchAgentFunctionPermissionsResponse,
  trustCard?: LaunchTrustCard,
): ToolDetailFixture | null {
  return tool
    ? liveToolFixture(tool, { functions, permissions, trustCard })
    : null;
}

function liveOwnerLabel(owner: LaunchToolSummary["owner"]): string {
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

function lightValue(amount?: LaunchMoneyAmount | null): number {
  return Number(amount?.light || 0);
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

function liveApiKeyFixtures(keys?: LaunchApiKeySummary[]): ApiKeyFixture[] {
  if (!keys || keys.length === 0) return apiKeys;
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
    value: lightValue(entry.value),
  }));
}

function liveWalletTotals(wallet?: LaunchWalletSummary): typeof walletSummary {
  if (!wallet) return walletSummary;
  return {
    deposited: lightValue(wallet.depositBalance),
    earned: lightValue(wallet.earnedBalance),
    escrow: lightValue(wallet.escrowBalance),
    spendable: lightValue(wallet.spendableBalance || wallet.balance),
  };
}

function liveLedgerRows(transactions?: LaunchWalletTransaction[]): LedgerRow[] {
  if (!transactions || transactions.length === 0) return walletLedger;
  return transactions.map((entry) => ({
    amount: lightValue(entry.amount),
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
    amount: lightValue(entry.amount),
    detail: `${entry.appId || "tool"} · ${entry.functionName || entry.reason}`,
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
    light: lightValue(receipt.total),
    status: receipt.success ? "ok" : "error",
    tool: receipt.appName || receipt.appId || "tool",
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
    return (
      <div className="api-notice warning">
        Showing design fallback. {live.error}
      </div>
    );
  }
  return null;
}

export function HomeFoundationPage(
  { live, navigate }: LaunchPageProps,
): ReactElement {
  const homeTools = liveStoreTools(live.data.store?.results).slice(0, 6);
  return (
    <div className="launch-page-narrow home-page">
      <ApiNotice live={live} noun="launch data" />
      <section className="home-hero">
        <div className="home-hero-copy">
          <h1>
            Many agents?<br />One tool layer.
          </h1>
          <p>
            Connected agents now inherit every published tool, with unified auth
            and payments. Or deploy your own.
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
          Every agent draws from one core: the same context, tools, auth, and
          payments.
        </p>
        <SharedCore />
      </section>

      <Section
        action={
          <RouteLink navigate={navigate} to="/store">Browse all</RouteLink>
        }
        title="Tools shipping now"
      >
        <div className="home-tool-grid">
          {homeTools.map((tool) => (
            <CompactToolCard
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
            Point your agent at a single MCP server. It discovers the whole
            catalog, calls any tool, and settles in Light.
          </p>
          <RouteButton icon="copy" navigate={navigate} size="lg" to="/install">
            Add to agent
          </RouteButton>
        </div>
        <ConfigPreview />
      </section>

      <section className="closing-band">
        <div>
          <h2>Give your agent the tool layer.</h2>
          <p>
            One endpoint for every capability: discover, call, and settle in
            Light.
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
        intro="One remote MCP endpoint, or the CLI and API, lets any existing agent discover, call, and pay for tools."
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
  const storeTools = liveStoreTools(live.data.store?.results);
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
      <ApiNotice live={live} noun="store tools" />
      <section className="store-heading">
        <h1>Tools your agent can call.</h1>
        <SearchControls query={query} setQuery={updateQuery} />
        <div className="kind-tabs" aria-label="Tool kinds">
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
                  onClick={() => navigate(`/tools/${tool.slug}`)}
                  type="button"
                >
                  <StoreToolCard tool={tool} />
                </button>
              ))
              : <NoResults onClear={() => updateQuery("")} />}
          </div>
        </section>
        <aside className="store-sidebar">
          <PrimitivesRail navigate={navigate} />
          <Leaderboard
            title="Top builders"
            subtitle="By earned Light"
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

export function ToolFoundationPage(
  { live, location, navigate, route }: LaunchPageProps,
): ReactElement {
  const slug = route.params.slug || "get_weather";
  const tool = liveDetailTool(
    live.data.tool?.tool,
    live.data.toolFunctions?.functions,
    live.data.toolAgentPermissions,
    live.data.tool?.trustCard,
  ) || toolDetails[slug];
  const widgetId = new URLSearchParams(location.search).get("widget");

  if (!tool) return <ToolNotFoundPage navigate={navigate} slug={slug} />;
  if (widgetId) {
    return (
      <WidgetOpenSurface
        locationSearch={location.search}
        live={live}
        navigate={navigate}
        tool={tool}
        widgetId={widgetId}
      />
    );
  }
  return (
    <ToolDetailSurface
      live={live}
      locationSearch={location.search}
      navigate={navigate}
      tool={tool}
    />
  );
}

function ToolDetailSurface({
  live,
  locationSearch,
  navigate,
  tool,
}: {
  live: LaunchPageProps["live"];
  locationSearch: string;
  navigate: (to: string) => void;
  tool: ToolDetailFixture;
}): ReactElement {
  const hasWidgets = tool.widgetList.length > 0;
  const [installed, setInstalled] = useState(false);
  const [tab, setTab] = useState<ToolPageTabId>(() =>
    toolTabFromSearch(hasWidgets)
  );
  const [selectedWidgetId, setSelectedWidgetId] = useState(
    tool.widgetList[0]?.id || "",
  );
  const [selectedFunctionName, setSelectedFunctionName] = useState(
    tool.functions[0]?.name || "",
  );
  useEffect(() => {
    setTab(toolTabFromSearch(hasWidgets));
  }, [hasWidgets, locationSearch]);

  const activateToolTab = (nextTab: ToolPageTabId) => {
    setTab(nextTab);
    syncSearchParams({
      tab: nextTab === (hasWidgets ? "widgets" : "functions") ? null : nextTab,
    });
  };

  return (
    <div className="launch-page-narrow tool-page">
      <ApiNotice live={live} noun="tool details" />
      <button
        className="back-link"
        onClick={() => navigate("/store")}
        type="button"
      >
        Store / <Mono>{tool.slug}</Mono>
      </button>

      <section className="public-tool-header">
        <Avatar color={tool.color} name={tool.author} />
        <div>
          <div className="tool-title-row">
            <h1>{tool.title}</h1>
            <Pill>{tool.kind}</Pill>
            <Pill tone="green">{tool.visibility}</Pill>
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
            {hasWidgets
              ? (
                <Button
                  icon="grid"
                  onClick={() =>
                    navigate(`/tools/${tool.slug}?widget=${selectedWidgetId}`)}
                  size="lg"
                  variant="secondary"
                >
                  Open widget
                </Button>
              )
              : (
                <RouteButton
                  icon="copy"
                  navigate={navigate}
                  size="lg"
                  to="/install"
                  variant="secondary"
                >
                  Copy MCP config
                </RouteButton>
              )}
          </div>
        </div>
      </section>

      <div className="tool-tabs" role="tablist" aria-label="Tool page sections">
        {hasWidgets
          ? (
            <button
              className={tab === "widgets" ? "active" : ""}
              onClick={() => activateToolTab("widgets")}
              type="button"
            >
              Widgets
            </button>
          )
          : null}
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
      </div>

      <div className="tool-detail-layout">
        <main className="tool-main-panel">
          {tab === "widgets"
            ? (
              <ToolWidgetsPanel
                navigate={navigate}
                selectedWidgetId={selectedWidgetId}
                setSelectedWidgetId={setSelectedWidgetId}
                tool={tool}
              />
            )
            : null}
          {tab === "functions"
            ? (
              <ToolFunctionsPanel
                live={live}
                selectedFunctionName={selectedFunctionName}
                setSelectedFunctionName={setSelectedFunctionName}
                tool={tool}
              />
            )
            : null}
          {tab === "details" ? <ToolDetailsPanel tool={tool} /> : null}
        </main>
        <aside className="tool-rail">
          <ToolTrustRail tool={tool} />
        </aside>
      </div>
    </div>
  );
}

function ToolWidgetsPanel({
  navigate,
  selectedWidgetId,
  setSelectedWidgetId,
  tool,
}: {
  navigate: (to: string) => void;
  selectedWidgetId: string;
  setSelectedWidgetId: (id: string) => void;
  tool: ToolDetailFixture;
}): ReactElement {
  const [state, setState] = useState<WidgetState>("ready");
  const widget = tool.widgetList.find((item) => item.id === selectedWidgetId) ||
    tool.widgetList[0];

  if (!widget) {
    return (
      <EmptyState icon="grid" title="No public widget">
        This tool exposes functions only. Agents can still install and call it
        through MCP or API.
      </EmptyState>
    );
  }

  return (
    <Card className="widget-surface-card">
      <div className="widget-panel-top">
        <div>
          <p className="section-label">Developer-authored UI</p>
          <h2>{widget.label}</h2>
          <p>{widget.description}</p>
        </div>
        <Button
          icon="grid"
          onClick={() => navigate(`/tools/${tool.slug}?widget=${widget.id}`)}
          variant="secondary"
        >
          Open widget
        </Button>
      </div>
      <WidgetSelector
        selected={widget.id}
        setSelected={setSelectedWidgetId}
        widgets={tool.widgetList}
      />
      <WidgetStateSelector state={state} setState={setState} />
      <WidgetSandboxShell state={state} tool={tool} widget={widget} />
    </Card>
  );
}

function ToolFunctionsPanel({
  live,
  selectedFunctionName,
  setSelectedFunctionName,
  tool,
}: {
  live: LaunchPageProps["live"];
  selectedFunctionName: string;
  setSelectedFunctionName: (name: string) => void;
  tool: ToolDetailFixture;
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
            <Mono>{formatToolPrice(fn.price)}</Mono>
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
  fn: ToolFunctionFixture;
  live: LaunchPageProps["live"];
  tool: ToolDetailFixture;
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
      const result = await launchApi.runToolFunction(tool.id, fn.name, {
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
        <Pill>{formatToolPrice(fn.price)}/call</Pill>
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
          Manual website runs create receipts; external agents still obey saved
          permission.
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
  fn: ToolFunctionFixture;
  live: LaunchPageProps["live"];
  tool: ToolDetailFixture;
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
        <strong>External-agent permission</strong>
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
              await launchApi.updateToolAgentPermissions(tool.id, {
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

function ToolDetailsPanel({ tool }: { tool: ToolDetailFixture }): ReactElement {
  return (
    <div className="details-panel">
      <Card>
        <p className="section-label">Signed manifest</p>
        <h3>{tool.signer}</h3>
        <p>
          The public manifest advertises runtime, capabilities, widget surfaces,
          pricing, receipts, and setup needs before any agent calls the tool.
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
            <ToolCapabilityPill
              capability={capability}
              key={`${capability.kind}-${capability.text}`}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function ToolTrustRail({ tool }: { tool: ToolDetailFixture }): ReactElement {
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
            value={minPrice > 0 ? `✦${formatLight(minPrice)}` : "Free"}
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

type WidgetState = "ready" | "loading" | "error" | "setup";

function WidgetOpenSurface({
  live,
  locationSearch,
  navigate,
  tool,
  widgetId,
}: {
  live: LaunchPageProps["live"];
  locationSearch: string;
  navigate: (to: string) => void;
  tool: ToolDetailFixture;
  widgetId: string;
}): ReactElement {
  const widget = tool.widgetList.find((item) => item.id === widgetId) ||
    tool.widgetList[0];
  const [state, setState] = useState<WidgetState>("ready");

  if (!widget) {
    return (
      <ToolDetailSurface
        live={live}
        locationSearch={locationSearch}
        navigate={navigate}
        tool={tool}
      />
    );
  }

  return (
    <div className="launch-page-narrow widget-open-page">
      <ApiNotice live={live} noun="widget details" />
      <button
        className="back-link"
        onClick={() => navigate(`/tools/${tool.slug}`)}
        type="button"
      >
        <Mono>{tool.slug}</Mono> / {widget.label}
      </button>
      <div className="widget-open-grid">
        <main>
          <div className="widget-open-head">
            <div>
              <p className="section-label">Open widget</p>
              <h1>{widget.label}</h1>
              <p>{widget.description}</p>
            </div>
            <WidgetStateSelector state={state} setState={setState} />
          </div>
          <WidgetSandboxShell state={state} tool={tool} widget={widget} />
        </main>
        <aside>
          <ToolTrustRail tool={tool} />
        </aside>
      </div>
    </div>
  );
}

function WidgetSelector({
  selected,
  setSelected,
  widgets,
}: {
  selected: string;
  setSelected: (id: string) => void;
  widgets: ToolWidgetFixture[];
}): ReactElement {
  return (
    <div className="widget-selector">
      {widgets.map((widget) => (
        <button
          className={selected === widget.id ? "active" : ""}
          key={widget.id}
          onClick={() => setSelected(widget.id)}
          type="button"
        >
          <Mono>{widget.id}</Mono>
          <span>{widget.label}</span>
        </button>
      ))}
    </div>
  );
}

function WidgetStateSelector({
  setState,
  state,
}: {
  setState: (state: WidgetState) => void;
  state: WidgetState;
}): ReactElement {
  const options = [
    ["ready", "Ready"],
    ["loading", "Loading"],
    ["error", "Error"],
    ["setup", "Setup"],
  ] as const;

  return (
    <div className="widget-state-selector" aria-label="Widget render state">
      {options.map(([id, label]) => (
        <button
          className={state === id ? "active" : ""}
          key={id}
          onClick={() => setState(id)}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function WidgetSandboxShell({
  state,
  tool,
  widget,
}: {
  state: WidgetState;
  tool: ToolDetailFixture;
  widget: ToolWidgetFixture;
}): ReactElement {
  return (
    <div className="widget-shell">
      <div className="widget-shell-top">
        <Avatar color={tool.color} name={tool.author} />
        <div>
          <strong>{widget.label}</strong>
          <Mono>{tool.name} · widget</Mono>
        </div>
        <Pill tone="green">relayed · no key</Pill>
      </div>
      <div className="widget-iframe-body">
        <span className="iframe-label">iframe · sandboxed</span>
        <WidgetBody state={state} tool={tool} widget={widget} />
      </div>
      <div className="widget-relay-footer">
        <Icon name="shield" size={13} />
        <span>
          Calls relay through Ultralight; the widget never sees your API key.
        </span>
        <Mono>ulAction("{primaryFunctionFor(tool).name}")</Mono>
        {state === "ready" ? <Mono>session 4:58</Mono> : null}
      </div>
    </div>
  );
}

function WidgetBody({
  state,
  tool,
  widget,
}: {
  state: WidgetState;
  tool: ToolDetailFixture;
  widget: ToolWidgetFixture;
}): ReactElement {
  if (state === "loading") {
    return (
      <div className="widget-state-body">
        <span className="widget-spinner" />
        <h3>Starting widget session...</h3>
        <Mono>POST /api/widget-session · {widget.id}</Mono>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="widget-state-body">
        <span className="state-icon error">
          <Icon name="shield" />
        </span>
        <h3>Could not load this widget</h3>
        <p>
          The widget UI function failed to render. Your balance was not charged.
        </p>
        <div className="card-row">
          <Button size="sm">Retry</Button>
          <Button size="sm" variant="secondary">Report</Button>
        </div>
      </div>
    );
  }
  if (state === "setup") {
    return (
      <div className="widget-state-body">
        <span className="state-icon setup">
          <Icon name="shield" />
        </span>
        <h3>Finish setup to run this widget</h3>
        <p>
          {tool.name}{" "}
          needs one connection before this widget can run. Your API key is never
          shared.
        </p>
        <div className="card-row">
          <Button size="sm">Go to setup</Button>
          <Button size="sm" variant="ghost">Why?</Button>
        </div>
      </div>
    );
  }

  if (tool.slug === "get_weather" && widget.id === "now_badge") {
    return <WeatherNowBadge />;
  }
  if (tool.slug === "get_weather") return <WeatherForecastWidget />;
  if (tool.slug === "stripe_subscribe") return <SubscriptionWidget />;
  if (tool.slug === "maps_route") return <RouteWidget />;
  return <GenericToolWidget tool={tool} />;
}

function WeatherForecastWidget(): ReactElement {
  const days = [
    ["Mon", 24, 17],
    ["Tue", 23, 16],
    ["Wed", 21, 15],
    ["Thu", 22, 16],
    ["Fri", 25, 18],
  ] as const;

  return (
    <div className="weather-widget-card">
      <div className="weather-widget-search">
        <span>Tokyo</span>
        <button type="button">↻</button>
      </div>
      <div className="weather-widget-main">
        <span>Tokyo</span>
        <strong>17°</strong>
        <small>H:24° L:15° · partly cloudy</small>
      </div>
      <div className="weather-day-grid">
        {days.map(([day, high, low]) => (
          <div key={day}>
            <Mono>{day}</Mono>
            <span />
            <strong>{high}°</strong>
            <small>{low}°</small>
          </div>
        ))}
      </div>
      <Mono>powered by get_weather</Mono>
    </div>
  );
}

function WeatherNowBadge(): ReactElement {
  return (
    <div className="weather-now-badge">
      <span />
      <strong>Tokyo 17°</strong>
      <Mono>partly cloudy</Mono>
    </div>
  );
}

function SubscriptionWidget(): ReactElement {
  return (
    <div className="subscription-widget">
      <p className="section-label">Checkout action</p>
      <h3>Agent Pro Seat</h3>
      <div className="pricing-line">
        <strong>✦2.400/call</strong>
        <Mono>receipt required</Mono>
      </div>
      <Button size="sm">Create subscription</Button>
    </div>
  );
}

function RouteWidget(): ReactElement {
  return (
    <div className="route-widget">
      <div>
        <span />
        <strong>Brooklyn</strong>
      </div>
      <div>
        <span />
        <strong>SoHo</strong>
      </div>
      <Mono>42 min · transit</Mono>
    </div>
  );
}

function GenericToolWidget(
  { tool }: { tool: ToolDetailFixture },
): ReactElement {
  return (
    <div className="generic-widget">
      <Avatar color={tool.color} name={tool.author} />
      <h3>{tool.title}</h3>
      <p>{tool.summary}</p>
      <Mono>{primaryFunctionFor(tool).name} ready</Mono>
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

function ToolCapabilityPill(
  { capability }: { capability: ToolCapability },
): ReactElement {
  return (
    <div className={`tool-capability tool-capability-${capability.kind}`}>
      <Mono>{capability.kind}</Mono>
      <span>{capability.text}</span>
    </div>
  );
}

function ToolNotFoundPage({
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
        eyebrow="Public tool page"
        intro="This public tool is not available in the launch fixture set yet."
        title={slug}
      />
      <EmptyState icon="search" title="Tool not found">
        Public tool pages will load from the launch tool contract when the live
        store API is connected.
      </EmptyState>
    </>
  );
}

export function LibraryFoundationPage(
  { live, location, navigate }: LaunchPageProps,
): ReactElement {
  const [view, setView] = useState<LibraryView>(libraryViewFromSearch());
  const installedTools = live.data.library?.installed?.length
    ? live.data.library.installed.map((tool) => liveToolFixture(tool))
    : installedLibrarySlugs.map((slug) => toolDetails[slug]).filter(Boolean);
  const ownedTools = live.data.library?.owned?.length
    ? live.data.library.owned.map((tool) => liveToolFixture(tool))
    : ownedLibrarySlugs.map((slug) => toolDetails[slug]).filter(Boolean);
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
            Installed tools
          </button>
          <button
            className={view === "owned" ? "active" : ""}
            onClick={() => selectView("owned")}
            type="button"
          >
            Tools you own
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
            {installedTools.map((tool) => (
              <button
                className="tool-card-button"
                key={tool.id}
                onClick={() => navigate(`/tools/${tool.slug}`)}
                type="button"
              >
                <StoreToolCard tool={tool} />
              </button>
            ))}
          </div>
        )
        : (
          <div className="owned-tool-list">
            {ownedTools.map((tool) => (
              <OwnedToolCard key={tool.id} navigate={navigate} tool={tool} />
            ))}
          </div>
        )}

      {installedTools.length === 0 && ownedTools.length === 0
        ? (
          <div className="library-empty-grid">
            <LibraryEmptyCard
              action="Deploy docs"
              body="Ship your first tool from the CLI and it appears here with installs, calls, widgets, and earnings."
              title="Tools you own"
            />
            <LibraryEmptyCard
              action="Browse Store"
              body="Tools you install from the Store appear here, ready to configure and call from agents."
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
  const tool = liveDetailTool(
    live.data.adminTool?.admin.tool,
    live.data.toolFunctions?.functions,
    live.data.toolAgentPermissions,
    live.data.adminTool?.trustCard,
  ) || adminToolFromRoute(route.params.id);
  const initialTab = adminTabFromSearch();
  const [tab, setTab] = useState<AdminTabId>(initialTab);
  const [visibility, setVisibility] = useState<ToolDetailFixture["visibility"]>(
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
      <ApiNotice live={live} noun="tool admin" />
      <AdminHeader navigate={navigate} tool={tool} visibility={visibility} />
      <div
        className="admin-tabs"
        role="tablist"
        aria-label="Tool admin sections"
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

function OwnedToolCard({
  navigate,
  tool,
}: {
  navigate: (to: string) => void;
  tool: ToolDetailFixture;
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
          to={`/admin/tools/${tool.id}`}
          variant="primary"
        >
          Manage
        </RouteButton>
        <RouteButton
          navigate={navigate}
          to={`/tools/${tool.slug}`}
          variant="secondary"
        >
          Public page
        </RouteButton>
        {tool.widgetList.length > 0
          ? (
            <RouteButton
              icon="grid"
              navigate={navigate}
              to={`/tools/${tool.slug}?widget=${tool.widgetList[0].id}`}
              variant="ghost"
            >
              {tool.widgetList.length} widgets
            </RouteButton>
          )
          : null}
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
        variant={title === "Tools you own" ? "primary" : "secondary"}
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
  tool: ToolDetailFixture;
  visibility: ToolDetailFixture["visibility"];
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
          to={`/tools/${tool.slug}`}
          variant="secondary"
        >
          View public page
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
  setVisibility: (visibility: ToolDetailFixture["visibility"]) => void;
  tab: AdminTabId;
  tool: ToolDetailFixture;
  visibility: ToolDetailFixture["visibility"];
}): ReactElement {
  switch (tab) {
    case "pricing":
      return <AdminPricingPanel tool={tool} />;
    case "widgets":
      return <AdminWidgetsPanel navigate={navigate} tool={tool} />;
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
  setVisibility: (visibility: ToolDetailFixture["visibility"]) => void;
  tool: ToolDetailFixture;
  visibility: ToolDetailFixture["visibility"];
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
  { tool }: { tool: ToolDetailFixture },
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

function AdminWidgetsPanel({
  navigate,
  tool,
}: {
  navigate: (to: string) => void;
  tool: ToolDetailFixture;
}): ReactElement {
  if (tool.widgetList.length === 0) {
    return (
      <div className="admin-panel">
        <EmptyState icon="grid" title="No widgets yet">
          Widgets deployed by the tool runtime will appear here with visibility
          controls.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="admin-panel admin-widget-list">
      {tool.widgetList.map((widget) => (
        <Card className="admin-widget-row" key={widget.id}>
          <span className="target-icon">
            <Icon name="grid" />
          </span>
          <div>
            <h3>
              {widget.label} <Mono>{widget.id}</Mono>
            </h3>
            <p>{widget.description}</p>
          </div>
          <select
            defaultValue="public"
            aria-label={`${widget.label} visibility`}
          >
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
          <Button
            onClick={() =>
              navigate(`/tools/${tool.slug}?widget=${widget.id}`)}
            size="sm"
            variant="secondary"
          >
            Open
          </Button>
        </Card>
      ))}
    </div>
  );
}

function AdminSecretsPanel(): ReactElement {
  return (
    <div className="admin-panel">
      <div className="secret-note">
        <Icon name="shield" />
        <span>
          Secrets are encrypted and never leave the runtime. Agents and widgets
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

function AdminTrustPanel({ tool }: { tool: ToolDetailFixture }): ReactElement {
  return (
    <div className="admin-panel">
      <Card>
        <div className="trust-card-head">
          <Icon name="shield" />
          <div>
            <h3>Signed manifest · receipts on</h3>
            <p>
              Trust fields are what public tool pages and external agents
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
            <ToolCapabilityPill
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
  { tool }: { tool: ToolDetailFixture },
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
          label={showEarnings ? "Earned Light" : "Spendable Light"}
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
                Add Light
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
        ? <WalletTopUpPanel earnedLight={totals.earned} />
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
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [newToolPermission, setNewToolPermission] = useState<
    "always" | "ask" | "never"
  >("ask");
  const [installedPermission, setInstalledPermission] = useState<
    "always" | "ask" | "never"
  >("ask");
  const [visibleKeys, setVisibleKeys] = useState<ApiKeyFixture[]>(() =>
    liveApiKeyFixtures(live.data.apiKeys?.apiKeys)
  );

  useEffect(() => {
    setVisibleKeys(liveApiKeyFixtures(live.data.apiKeys?.apiKeys));
  }, [live.data.apiKeys]);

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
          <h1>Ada Lovelace</h1>
          <p>ada@analytical.engine · @you</p>
        </div>
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
      </div>

      <SettingsCard
        action={
          <Button onClick={() => setNewKeyVisible(true)} size="sm">
            Create key
          </Button>
        }
        subtitle="Tokens your agents use to call Ultralight. New keys reveal once."
        title="API keys"
      >
        <div className="api-key-primary">
          <Icon name="key" />
          <Mono>{apiKeyMask}</Mono>
          <Button size="sm" variant="secondary">Copy</Button>
          <Button
            onClick={() => setNewKeyVisible(true)}
            size="sm"
            variant="secondary"
          >
            Rotate & copy
          </Button>
        </div>
        <p className="settings-help">
          Rotating issues a new key and revokes the old one. Connected agents
          must be updated.
        </p>
        <div className="api-key-list">
          {visibleKeys.map((key) => (
            <ApiKeyRow
              key={key.id || key.prefix}
              apiKey={key}
              onRevoke={revokeKey}
            />
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        subtitle="Launch-safe defaults only. No BYOK or web-search controls in this MVP."
        title="Preferences"
      >
        <PreferenceRow
          control={
            <PermissionSelect
              onChange={setNewToolPermission}
              value={newToolPermission}
            />
          }
          description="How agents may call functions on tools you deploy."
          title="Default new tool permissions"
        />
        <PreferenceRow
          control={
            <PermissionSelect
              onChange={setInstalledPermission}
              value={installedPermission}
            />
          }
          description="How agents may call functions on tools you install."
          title="Default installed tool permissions"
        />
      </SettingsCard>

      <div className="connect-agent-callout">
        <span className="target-icon">
          <Icon name="copy" />
        </span>
        <div>
          <strong>Connecting an agent?</strong>
          <p>
            Use Add to agent. It bundles your API key into install instructions
            without passing it to widgets.
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
                formatNumber(lightValue(publishRequirement.requiredBalance))
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
  { earnedLight }: { earnedLight: number },
): ReactElement {
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [lightAmount, setLightAmount] = useState(10000);
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
  const quote = liveQuote || quoteTopUp(lightAmount, method);
  const presets = method === "earnings"
    ? [1000, 2500, 10000, 25000, Math.floor(earnedLight)]
    : [1000, 2500, 10000, 25000, 50000];

  useEffect(() => {
    if (method === "earnings") {
      setLiveQuote(null);
      return;
    }
    let cancelled = false;
    launchApi.walletTopUpQuote({ amountLight: lightAmount, method })
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
  }, [lightAmount, method]);

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
        amountLight: lightAmount,
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
        <p className="section-label">Light amount</p>
        <div className="light-input-shell">
          <span>✦</span>
          <strong>{lightAmount.toLocaleString()}</strong>
          <small>Light</small>
        </div>
        <div className="amount-presets">
          {presets.map((amount) => (
            <button
              className={lightAmount === amount ? "active" : ""}
              key={amount}
              onClick={() => setLightAmount(amount)}
              type="button"
            >
              {amount === Math.floor(earnedLight) && method === "earnings"
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
          <strong>✦{lightAmount.toLocaleString()}</strong>
        </div>
        <Button onClick={createTopUpIntent} size="lg">
          {checkoutState === "creating"
            ? "Creating checkout"
            : method === "earnings"
            ? `Transfer ✦${lightAmount.toLocaleString()}`
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
        <Pill>tool calls</Pill>
      </div>
      <div className="wallet-receipt-table">
        <div className="wallet-table-head">
          <span>Tool</span>
          <span>Light</span>
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
            Stripe Connect payouts are enabled. Withdraw earned Light to your
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
      <span className="widget-spinner" />
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
      "Plug in and inherit context, tools, balance, and preferences.",
    ],
    ["02", "No subscriptions", "Agents pay per call, only for what they use."],
    [
      "03",
      "Open marketplace",
      "Every published tool is discoverable and callable by any agent.",
    ],
    [
      "04",
      "Inherited power",
      "Every deployed tool inherits composability and distribution.",
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
      {["Context", "Tools", "Auth", "Payments"].map((item) => (
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

function CompactToolCard({ tool }: { tool: ToolFixture }): ReactElement {
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
          : <span>{formatLight(tool.callPrice)}/call</span>}
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
        aria-label="Search tools"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search tools, capabilities, widgets..."
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
        Browsing all public tools · {mode || "top by install"}
      </div>
    );
  }
  return (
    <div className="retrieval-note active">
      <span /> {mode || "hybrid"} retrieval · semantic + lexical fallback
    </div>
  );
}

function StoreToolCard({ tool }: { tool: ToolFixture }): ReactElement {
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
        {tool.widgets > 0
          ? (
            <span>
              <Icon name="grid" size={12} /> {tool.widgets} widgets
            </span>
          )
          : <span>functions only</span>}
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
          onClick={() =>
            navigate(route === "/tools/:slug" ? "/tools/get_weather" : route)}
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
            <Mono>{formatLight(row.value)}</Mono>
          </div>
        ))}
      </div>
    </Card>
  );
}

function NoResults({ onClear }: { onClear: () => void }): ReactElement {
  return (
    <div className="store-empty">
      <EmptyState icon="search" title="No tools match that yet">
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

function createToolDetail(tool: ToolFixture): ToolDetailFixture {
  const base: ToolDetailFixture = {
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
    runtime: tool.kind === "mcp" ? "deno · edge" : "worker · http",
    signer: `${tool.author.replace("@", "")}.studio`,
    title: titleizeToolName(tool.name),
    updatedAt: "4d",
    version: "1.0.0",
    visibility: "public",
    widgetList: tool.widgets > 0
      ? [{
        id: "overview",
        label: "Overview",
        description: "Public tool UI preview.",
      }]
      : [],
  };

  const overrides: Record<string, Partial<ToolDetailFixture>> = {
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
      widgetList: [],
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
      widgetList: [
        {
          id: "forecast_card",
          label: "Forecast card",
          description:
            "Five-day outlook with highs, lows, and current conditions.",
        },
        {
          id: "now_badge",
          label: "Now badge",
          description:
            "Compact current-conditions chip for quick agent responses.",
        },
      ],
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
      widgetList: [],
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
      widgetList: [
        {
          id: "route_card",
          label: "Route card",
          description: "Visual route summary for travel planning agents.",
        },
      ],
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
      widgetList: [],
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
      widgetList: [
        {
          id: "checkout_action",
          label: "Checkout action",
          description:
            "Small UI for creating and confirming subscription actions.",
        },
      ],
    },
  };

  return { ...base, ...overrides[tool.slug] };
}

function adminToolFromRoute(id?: string): ToolDetailFixture {
  if (!id) return toolDetails.get_weather;
  return Object.values(toolDetails).find((tool) =>
    tool.id === id || tool.slug === id
  ) || toolDetails.get_weather;
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

function toolTabFromSearch(hasWidgets: boolean): ToolPageTabId {
  const tab = queryParam("tab");
  if (tab === "details" || tab === "functions") return tab;
  if (tab === "widgets" && hasWidgets) return tab;
  return hasWidgets ? "widgets" : "functions";
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

function quoteTopUp(lightAmount: number, method: PaymentMethod): {
  baseDollars: number;
  feeDollars: number;
  feeNote: string;
  totalDollars: number;
} {
  const baseDollars = lightAmount / 100;
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

function formatToolPrice(value: number): string {
  return value > 0 ? `✦${formatLight(value)}` : "Free";
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

function primaryFunctionFor(tool: ToolDetailFixture): ToolFunctionFixture {
  return tool.functions[0] || {
    args: [],
    description: "Run the tool.",
    name: "run",
    p50: 100,
    permission: "ask",
    price: tool.callPrice,
  };
}

function titleizeToolName(value: string): string {
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

function formatLight(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(3);
}
