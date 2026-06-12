import {
  Fragment,
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
  type LaunchApiKeyCreateResponse,
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
  type LaunchAgentInstallContext,
  type LaunchAgentRelationship,
  type LaunchAgentSummary,
  type LaunchTrustCard,
  type LaunchPayoutStatus,
  type LaunchWalletEarningSummary,
  type LaunchWalletReceiptSummary,
  type LaunchWalletSummary,
  type LaunchWalletTransaction,
} from "../../../../shared/contracts/launch.ts";
import {
} from "../../../../shared/types/index.ts";
import type { LaunchPageProps } from "../App";
import {
  getLaunchAuthDiagnostic,
  hasLaunchAuthToken,
  signOutLaunch,
  buildLaunchSignInUrl,
} from "../lib/auth";
import { useSignInModal } from "../components/sign-in-modal";
import {
  launchApi,
  LaunchApiAuthenticationError,
  launchApiOrigin,
  LaunchApiRequestError,
} from "../lib/api";
import { getStripe, type Stripe, type StripeElements } from "../lib/stripe";
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

// `null` metric fields mean "no real data" — the platform doesn't report this
// stat (yet). Render an honest gap (omit/—), never a fabricated number.
interface AgentFixture {
  author: string;
  callPrice: number;
  category: string;
  color: string;
  free?: boolean;
  growth: number;
  id: string;
  installs: number | null;
  kind: "gpu" | "http" | "markdown" | "mcp";
  name: string;
  slug: string;
  spark: number[] | null;
  summary: string;
}

interface InstallTarget {
  config: (key: string) => string;
  description: string;
  group: "Prompt" | "MCP" | "Direct";
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

const capabilityGlyphs: Record<AgentCapability["kind"], string> = {
  net: "⇄",
  read: "↘",
  write: "↗",
};

interface AgentFunctionFixture {
  args: string[];
  description: string;
  name: string;
  p50: number | null;
  permission: "always" | "ask" | "never";
  price: number;
}

interface AgentDetailFixture extends AgentFixture {
  callsPerDay: number | null;
  capabilities: AgentCapability[];
  functions: AgentFunctionFixture[];
  relationship: LaunchAgentRelationship;
  // Trust fields are null until the Agent publishes a signed trust card.
  runtime: string | null;
  signer: string | null;
  title: string;
  updatedAt: string | null;
  version: string | null;
  visibility: "public" | "private" | "unlisted";
}

const apiKeyPlaceholder = "$ULTRALIGHT_API_KEY";
// The MCP host is the API worker itself — derive it so snippets can never
// drift to a stale hardcoded domain.
const apiOrigin = launchApiOrigin();
const mcpUrl = `${apiOrigin}/mcp/platform`;

// Local fallback mirroring the BE `prompt` install instruction
// (buildInstallInstructions in api/handlers/launch.ts) for when the live
// instructions are unavailable.
function buildConnectPrompt(key: string): string {
  const claudeCodeAdd =
    `claude mcp add --transport http --scope user ultralight ${mcpUrl} --header "Authorization: Bearer ${key}"`;
  const genericConfig = JSON.stringify({
    mcpServers: {
      ultralight: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } },
    },
  });
  return [
    "Set up Ultralight for me, then start using it.",
    "",
    "Ultralight is one MCP server that gives you a library of Agents (apps) you can discover, call, and deploy, with unified auth and per-call payments.",
    "",
    "1. Install the MCP server (pick whichever works in your environment):",
    `   - Claude Code: ${claudeCodeAdd}`,
    `   - Any MCP config file: ${genericConfig}`,
    `   - Automated installer: npx ultralightpro setup --token ${key}`,
    "",
    "2. Connect, then learn the platform: the server's initialize response carries the full platform guide. The same docs live at the ultralight://platform/skills.md MCP resource" +
    ` and ${apiOrigin}/api/skills.`,
    "",
    '3. Prove it works: call ul.discover with {"scope":"library"} to list the Agents already installed on this account, then tell me in a few lines what you can now do for me.',
    "",
    "Treat the API key in this prompt as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");
}

// Key names are unique per user; the suffix keeps repeat connects from 409ing.
function connectKeyName(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `Agent connect ${stamp} ${suffix}`;
}

// Full-capability key (scopes omitted defaults to all): what a connected agent
// may actually do at runtime stays governed by the user's per-Agent
// permission policies, not the token.
function mintConnectKey(): Promise<string> {
  return launchApi.createApiKey({
    expiresInDays: 90,
    name: connectKeyName(),
  }).then((response) => response.plaintextToken);
}

// Per-agent connect key: scoped to one Agent (appIds), so it can call that
// Agent's dedicated MCP endpoint and nothing else.
function mintAgentConnectKey(
  agent: { id: string; slug: string },
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const suffix = Math.random().toString(36).slice(2, 6);
  return launchApi.createApiKey({
    appIds: [agent.id],
    expiresInDays: 90,
    name: `${agent.slug} connect ${stamp} ${suffix}`,
    scopes: ["apps:call"],
  }).then((response) => response.plaintextToken);
}

// Local fallback mirroring the BE connectPrompt (buildToolInstallContext in
// api/handlers/launch.ts) for when the live install context is unavailable.
function buildAgentConnectPrompt(
  agent: { id: string; slug: string; title: string },
  key: string,
): string {
  const agentMcpUrl = `${apiOrigin}/mcp/${agent.id}`;
  const config = JSON.stringify({
    mcpServers: {
      [agent.slug]: {
        url: agentMcpUrl,
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  });
  const publicUrl = `${window.location.origin}/agents/${
    encodeURIComponent(agent.slug)
  }`;
  return [
    `Set up the "${agent.title}" Agent from Ultralight for me, then start using it.`,
    "",
    `"${agent.title}" is an Agent hosted on Ultralight. Connect to it as a standalone MCP server; the API key below is scoped to this Agent only.`,
    "",
    "1. Install the MCP server (pick whichever works in your environment):",
    `   - Claude Code: claude mcp add --transport http --scope user ${agent.slug} ${agentMcpUrl} --header "Authorization: Bearer ${key}"`,
    `   - Any MCP config file: ${config}`,
    "",
    `2. Connect, then run tools/list to see what "${agent.title}" can do. ${publicUrl} documents pricing and trust.`,
    "",
    `3. Prove it works: pick its most representative read-only function and call it, then tell me in a few lines how you can use "${agent.title}" for me going forward.`,
    "",
    "Calls may spend credits from my Ultralight wallet: preserve receipt_id values and surface any credits-balance errors. Treat the API key as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");
}

function agentPreviewPath(tool: Pick<AgentDetailFixture, "slug">): string {
  return `/agents/${encodeURIComponent(tool.slug)}`;
}

const orbitAgents = [
  { alt: "Codex", className: "agent-one", src: agentCodexUrl },
  { alt: "Cursor", className: "agent-two", src: agentCursorUrl },
  { alt: "OpenClaw", className: "agent-three", src: agentOpenclawUrl },
  { alt: "Claude", className: "agent-four", src: agentClaudeUrl },
] as const;

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

const installTargets: InstallTarget[] = [
  {
    config: (key) => buildConnectPrompt(key),
    description:
      "One prompt that makes any agent install Ultralight itself and start using it.",
    group: "Prompt",
    label: "Agent prompt",
    requiresApiKey: true,
    steps: [
      "Create an API key so the prompt carries a real credential.",
      "Paste the prompt into any agent: Claude Code, Cursor, or anything MCP-capable.",
      "The agent installs the MCP server, reads the platform guide, and reports what it can do.",
    ],
    target: "prompt",
  },
  {
    config: (key) =>
      `claude mcp add --transport http --scope user ultralight ${mcpUrl} --header "Authorization: Bearer ${key}"`,
    description:
      "Add Ultralight as a remote MCP server for an existing Claude Code workspace.",
    group: "MCP",
    label: "Claude Code",
    requiresApiKey: true,
    steps: [
      "Create an Ultralight API token from Settings.",
      "Run the command below with your token in place of the placeholder.",
      "Run /mcp (or restart) so Claude Code picks up the ultralight server.",
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
      `curl "${apiOrigin}/api/launch/status"\ncurl -H "Authorization: Bearer ${key}" \\\n  "${apiOrigin}/api/launch/library"`,
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

type WalletTabId = "balance" | "earnings" | "receipts" | "topup";
type PaymentMethod = "ach" | "card" | "earnings";

interface LedgerRow {
  amount: number;
  detail: string;
  kind: "call" | "earning" | "payout" | "topup" | "transfer";
  tool?: string;
  when: string;
}

interface ReceiptRowFixture {
  fn: string;
  latency: number | null;
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

// Zero-valued shape used until the live wallet loads — never demo numbers.
const walletSummary = {
  deposited: 0,
  earned: 0,
  escrow: 0,
  spendable: 0,
};

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
  const permissions = new Map(
    (options.permissions?.permissions || []).map((
      entry,
    ) => [entry.functionName, entry.policy]),
  );
  // Only real data: functions come from the live endpoint (or stay empty),
  // metrics the platform doesn't report are null, and trust fields exist only
  // when the Agent ships a trust card. Nothing here is fabricated.
  const functions = (options.functions || []).map((fn) => ({
    args: inputArgs(fn.inputSchema),
    description: fn.description || `Run ${fn.name}.`,
    name: fn.name,
    p50: null,
    permission: permissions.get(fn.name) || fn.callerPermission?.policy ||
      fn.agentPermission?.policy || "ask" as const,
    price: creditsValue(fn.pricing?.defaultCallPrice),
  }));
  const trust = options.trustCard;
  const paidFunctionPrices = functions.map((fn) => fn.price).filter((price) =>
    price > 0
  );
  const callPrice = creditsValue(tool.pricing?.defaultCallPrice) ||
    (paidFunctionPrices.length > 0 ? Math.min(...paidFunctionPrices) : 0);

  return {
    author: liveOwnerLabel(tool.owner),
    callPrice,
    callsPerDay: null,
    capabilities: trustCapabilities(trust),
    category: tool.tags?.[0] || tool.kind.toUpperCase(),
    color: stableColor(tool.id),
    free: callPrice === 0,
    functions,
    growth: 0,
    id: tool.id,
    installs: null,
    kind: tool.kind,
    name: tool.name,
    relationship: tool.relationship,
    runtime: trust?.runtime || null,
    signer: trust?.signer || null,
    slug: tool.slug,
    spark: null,
    summary: tool.description || "Agent published on Ultralight.",
    title: titleizeAgentName(tool.name),
    updatedAt: relativeTime(tool.updatedAt) || null,
    version: trust?.version || null,
    visibility: tool.visibility,
  };
}

// Declared permissions from the signed trust card — the only honest source
// for the capabilities list on a live Agent page.
function trustCapabilities(trust?: LaunchTrustCard): AgentCapability[] {
  return (trust?.permissions || []).map((permission) => ({
    kind: permission.startsWith("net")
      ? "net" as const
      : permission.includes("write")
      ? "write" as const
      : "read" as const,
    text: permission,
  }));
}

function liveStoreAgents(tools?: LaunchAgentSummary[]): AgentFixture[] {
  if (!tools || tools.length === 0) return [];
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

function liveInstallTargets(
  instructions?: LaunchInstallInstruction[],
): InstallTarget[] {
  if (!instructions || instructions.length === 0) return installTargets;
  return instructions.map((instruction) => ({
    // Snippets arrive with the $ULTRALIGHT_API_KEY placeholder; substituting
    // the caller's key lets a freshly minted token flow into every snippet.
    config: (key) =>
      (instruction.configText || "").replaceAll(apiKeyPlaceholder, key),
    description: instruction.description,
    group: instruction.target === "prompt"
      ? "Prompt"
      : instruction.target === "cli" || instruction.target === "api"
      ? "Direct"
      : "MCP",
    label: instruction.label,
    requiresApiKey: instruction.requiresApiKey,
    steps: instruction.steps,
    target: instruction.target,
  }));
}

function liveApiKeyFixtures(keys?: LaunchApiKeySummary[]): ApiKeyFixture[] {
  if (!keys || keys.length === 0) return [];
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
  if (!transactions || transactions.length === 0) return [];
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
  if (!earnings || earnings.length === 0) return [];
  return earnings.map((entry) => ({
    amount: creditsValue(entry.amount),
    detail: `${entry.appId || "agent"} · ${entry.functionName || entry.reason}`,
    kind: "earning",
    tool: entry.appId || undefined,
    when: relativeTime(entry.createdAt) || "now",
  }));
}

function liveReceiptRows(
  receipts?: LaunchWalletReceiptSummary[],
): ReceiptRowFixture[] {
  if (!receipts || receipts.length === 0) return [];
  return receipts.map((receipt) => ({
    fn: receipt.functionName || "run",
    // The wallet receipts endpoint doesn't report latency.
    latency: null,
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

function AddToAgentButton({
  instructions,
  navigate,
  size = "lg",
  variant,
}: {
  instructions?: LaunchInstallInstruction[];
  navigate: (to: string) => void;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost";
}): ReactElement {
  const [open, setOpen] = useState(false);
  // Signed out there is no key to mint — route to the install page, which
  // carries the sign-in CTA.
  if (!hasLaunchAuthToken()) {
    return (
      <RouteButton
        icon="copy"
        navigate={navigate}
        size={size}
        to="/install"
        variant={variant}
      >
        Add to agent
      </RouteButton>
    );
  }
  const buildPrompt = (key: string) => {
    const promptTarget = liveInstallTargets(instructions)
      .find((target) => target.target === "prompt") ?? installTargets[0];
    return promptTarget.config(key);
  };
  return (
    <>
      <Button
        icon="copy"
        onClick={() => setOpen(true)}
        size={size}
        variant={variant}
      >
        Add to agent
      </Button>
      {open
        ? (
          <ConnectPromptModal
            buildPrompt={buildPrompt}
            intro="This created a 90-day API key (full capability — your per-Agent permissions still govern every call) and baked it into the prompt below. The key is shown only here."
            mint={mintConnectKey}
            navigate={navigate}
            onClose={() => setOpen(false)}
          />
        )
        : null}
    </>
  );
}

function ConnectPromptModal({
  buildPrompt,
  intro,
  mint,
  navigate,
  onClose,
}: {
  buildPrompt: (key: string) => string;
  intro: string;
  mint: () => Promise<string>;
  navigate: (to: string) => void;
  onClose: () => void;
}): ReactElement {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [autoCopied, setAutoCopied] = useState(false);
  // Both StrictMode dev mounts must share ONE mint — a key is a server-side
  // credential, so the effect cannot simply re-run.
  const mintOnce = useRef<Promise<string> | null>(null);

  // Mint exactly once per modal open; the click that opened the modal is the
  // consent to create a key.
  useEffect(() => {
    let cancelled = false;
    if (!mintOnce.current) mintOnce.current = mint();
    mintOnce.current
      .then(async (token) => {
        if (cancelled) return;
        const text = buildPrompt(token);
        setPrompt(text);
        try {
          await navigator.clipboard?.writeText(text);
          if (!cancelled) setAutoCopied(true);
        } catch {
          // Manual copy via the snippet button still works.
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mint once per open
  }, []);

  return (
    <div className="settings-modal-backdrop">
      <Card className="new-key-modal connect-modal">
        <div className="modal-title-row">
          <span className="target-icon">
            <Icon name={errorMessage ? "key" : autoCopied ? "check" : "copy"} />
          </span>
          <h2>
            {errorMessage
              ? "Could not create a key"
              : prompt
              ? autoCopied
                ? "Prompt copied — paste it into your agent"
                : "Your agent prompt is ready"
              : "Creating your agent prompt"}
          </h2>
        </div>
        <p>{errorMessage ?? intro}</p>
        {prompt
          ? <ConfigPreview code={prompt} title="agent-prompt.txt" wrap />
          : null}
        <div className="modal-actions">
          <Button
            onClick={() => {
              onClose();
              navigate("/install");
            }}
            size="sm"
            variant="secondary"
          >
            Full install guide
          </Button>
          <Button onClick={onClose} size="sm">Done</Button>
        </div>
      </Card>
    </div>
  );
}

export function HomeFoundationPage(
  { live, navigate }: LaunchPageProps,
): ReactElement {
  const homeTools = liveStoreAgents(live.data.store?.results).slice(0, 6);
  const installInstructions = live.data.install?.instructions;
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
            <AddToAgentButton
              instructions={installInstructions}
              navigate={navigate}
            />
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

      {homeTools.length > 0
        ? (
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
        )
        : null}

      <section className="endpoint-section">
        <div>
          <h2>One endpoint. Every capability.</h2>
          <p>
            Point your connected agent at a single MCP server. It discovers the
            whole catalog, calls any Agent, and settles in credits.
          </p>
          <AddToAgentButton
            instructions={installInstructions}
            navigate={navigate}
          />
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
          <AddToAgentButton
            instructions={installInstructions}
            navigate={navigate}
            variant="secondary"
          />
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
  const firstTarget = targets[0]?.target || "prompt";
  const [target, setTarget] = useState(firstTarget);
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const signedIn = hasLaunchAuthToken();
  const openSignInModal = useSignInModal();
  const selected = targets.find((item) => item.target === target) ||
    targets[0] || installTargets[0];
  // The API only exposes key PREFIXES after creation, so snippets show the
  // placeholder until a key is minted on this page — then the real token
  // (held only in memory) flows into every snippet.
  const key = mintedKey ?? apiKeyPlaceholder;
  const promptTarget = targets.find((item) => item.target === "prompt") ??
    installTargets[0];

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
            onClick={signedIn ? undefined : openSignInModal}
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
          <Fragment key={step}>
            <span>
              <Mono>{index + 1}</Mono>
              {step}
            </span>
            {index < externalLoop.length - 1
              ? <Icon name="arrow" size={13} />
              : null}
          </Fragment>
        ))}
      </div>

      <ConnectCta
        keyLive={Boolean(mintedKey)}
        onMinted={setMintedKey}
        promptText={(value) => promptTarget.config(value)}
        signedIn={signedIn}
      />

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
            {selected.requiresApiKey && !mintedKey
              ? <Pill>requires API key</Pill>
              : null}
            {mintedKey ? <Pill>key filled in</Pill> : null}
          </div>
          <ol className="install-steps">
            {selected.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <ConfigPreview
            code={selected.config(key)}
            highlight={key}
            title={snippetTitle(selected)}
            wrap={selected.target === "prompt"}
          />
        </section>
      </div>
    </div>
  );
}

function snippetTitle(target: InstallTarget): string {
  if (target.target === "prompt") return "agent-prompt.txt";
  if (target.target === "claude_code" || target.group === "Direct") {
    return "shell";
  }
  return "mcp.json";
}

function ConnectCta({
  keyLive,
  onMinted,
  promptText,
  signedIn,
}: {
  keyLive: boolean;
  onMinted: (token: string) => void;
  promptText: (key: string) => string;
  signedIn: boolean;
}): ReactElement {
  const [status, setStatus] = useState<"idle" | "working" | "copied" | "ready" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const connect = () => {
    if (status === "working") return;
    setStatus("working");
    setErrorMessage(null);
    mintConnectKey()
      .then(async (token) => {
        onMinted(token);
        try {
          await navigator.clipboard?.writeText(promptText(token));
          setStatus("copied");
        } catch {
          setStatus("ready");
        }
      })
      .catch((err) => {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  };

  if (!signedIn) {
    return (
      <section className="key-banner connect-cta">
        <span className="target-icon">
          <Icon name="key" />
        </span>
        <div>
          <h2>Connect your agent in one paste</h2>
          <p>
            Sign in, and one click creates an API key and copies a
            ready-to-paste prompt that sets up your agent.
          </p>
        </div>
        <Button href={buildLaunchSignInUrl("/install")} size="lg">
          Sign in to connect
        </Button>
      </section>
    );
  }

  if (keyLive) {
    return (
      <section className="key-banner signed-in connect-cta">
        <span className="target-icon">
          <Icon name="check" />
        </span>
        <div>
          <h2>
            {status === "copied"
              ? "Prompt copied — paste it into your agent"
              : "API key created"}
          </h2>
          <p>
            Your new key is filled into every snippet below. It is shown only
            on this page — copy what you need before leaving.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="key-banner signed-in connect-cta">
      <span className="target-icon">
        <Icon name="key" />
      </span>
      <div>
        <h2>Connect your agent in one paste</h2>
        <p>
          One click creates a 90-day API key (full capability — your per-Agent
          permissions still govern every call) and copies a ready-to-paste
          prompt.
          {errorMessage ? ` Could not create a key: ${errorMessage}` : ""}
        </p>
      </div>
      <Button
        disabled={status === "working"}
        icon="copy"
        onClick={connect}
        size="lg"
      >
        {status === "working" ? "Creating key…" : "Create key & copy prompt"}
      </Button>
    </section>
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
              : live.status === "idle" || live.status === "loading"
              ? null
              : <NoResults onClear={() => updateQuery("")} query={query} />}
          </div>
        </section>
        <aside className="store-sidebar">
          <PrimitivesRail navigate={navigate} />
          <Leaderboard
            title="Top builders"
            subtitle="By earned credits"
            rows={builderRows}
          />
          <Leaderboard
            title="Fee credit"
            subtitle="Fee-waiver program"
            rows={feeRows}
          />
        </aside>
      </div>
    </div>
  );
}

export function AgentFoundationPage(
  { live, location, navigate, route }: LaunchPageProps,
): ReactElement {
  const slug = route.params.slug || "";
  // Live data only — an unavailable Agent renders the not-found state, never
  // a demo fixture that could be mistaken for the real page.
  const tool = liveDetailAgent(
    live.data.agent?.agent ?? live.data.agent?.tool,
    live.data.agentFunctions?.functions,
    live.data.agentCallerPermissions,
    live.data.agent?.trustCard,
  );

  if (!tool) {
    // Don't flash "not found" while the fetch is still in flight.
    if (live.status === "idle" || live.status === "loading") {
      return (
        <div className="launch-page-narrow tool-page">
          <ApiNotice live={live} noun="Agent details" />
        </div>
      );
    }
    return <AgentNotFoundPage navigate={navigate} slug={slug} />;
  }
  return (
    <AgentDetailSurface
      // Reset per-agent UI state (tab, selected function) when navigating
      // between agent pages.
      key={tool.id}
      live={live}
      locationSearch={location.search}
      navigate={navigate}
      tool={tool}
    />
  );
}

function AgentConnectButton({
  agentInstall,
  navigate,
  tool,
}: {
  agentInstall?: LaunchAgentInstallContext | null;
  navigate: (to: string) => void;
  tool: AgentDetailFixture;
}): ReactElement {
  const [open, setOpen] = useState(false);
  // Signed out there is no key to mint — sign in and land back on this page.
  if (!hasLaunchAuthToken()) {
    return (
      <Button
        href={buildLaunchSignInUrl(`/agents/${tool.slug}`)}
        icon="copy"
        size="lg"
      >
        Add to your agent
      </Button>
    );
  }
  const buildPrompt = (key: string) =>
    agentInstall?.connectPrompt
      ? agentInstall.connectPrompt.replaceAll(apiKeyPlaceholder, key)
      : buildAgentConnectPrompt(tool, key);
  return (
    <>
      <Button icon="copy" onClick={() => setOpen(true)} size="lg">
        Add to your agent
      </Button>
      {open
        ? (
          <ConnectPromptModal
            buildPrompt={buildPrompt}
            intro={`This created a 90-day API key scoped to ${tool.title} only and baked it into the prompt below. The key is shown only here.`}
            mint={() => mintAgentConnectKey(tool)}
            navigate={navigate}
            onClose={() => setOpen(false)}
          />
        )
        : null}
    </>
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

      {tool.visibility === "unlisted"
        ? (
          <div className="unlisted-banner">
            <Icon name="shield" size={13} />
            Unlisted — visible only to people with the link. Not indexed in the
            Store.
          </div>
        )
        : null}

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
            {tool.installs !== null
              ? <span>{formatNumber(tool.installs)} installs</span>
              : null}
            {tool.callsPerDay !== null
              ? <span>{formatNumber(tool.callsPerDay)} calls/day</span>
              : null}
            {tool.updatedAt
              ? <span>updated {tool.updatedAt}</span>
              : null}
          </div>
          <div className="tool-header-actions">
            <AgentConnectButton
              agentInstall={live.data.install?.agentInstall}
              navigate={navigate}
              tool={tool}
            />
            <RouteButton
              navigate={navigate}
              size="lg"
              to="/install"
              variant="secondary"
            >
              Install guide
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

  // Live agents expose only the functions the API reports — none yet means an
  // honest empty state, not a synthesized placeholder function.
  if (!selectedFunction) {
    return (
      <div className="functions-panel">
        <EmptyState icon="grid" title="No callable functions yet">
          This Agent has not published any functions, or they are still
          loading.
        </EmptyState>
      </div>
    );
  }

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
    "idle" | "running" | "queued" | "success" | "error"
  >("idle");
  const pollTimerRef = useRef<number | null>(null);
  // Bumped on re-run and unmount: an in-flight poll fetch resolving after
  // either event must not touch state or schedule another tick.
  const pollGenRef = useRef(0);

  useEffect(() => () => {
    pollGenRef.current++;
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
  }, []);

  // A durable async run returned { _async, job_id }: poll the job until it
  // finishes (or a 5-minute client cap — the job keeps running server-side).
  const pollJob = (jobId: string, startedAt: number, gen: number) => {
    pollTimerRef.current = window.setTimeout(async () => {
      try {
        const job = await launchApi.launchJob(jobId);
        if (pollGenRef.current !== gen) return;
        if (job.status === "completed") {
          setResponse({
            ...(job.result && typeof job.result === "object" &&
                !Array.isArray(job.result)
              ? job.result as Record<string, unknown>
              : { result: job.result ?? null }),
            success: true,
          });
          setRunState("success");
          return;
        }
        if (job.status === "failed") {
          setResponse({ error: job.error ?? "Execution failed" });
          setRunState("error");
          return;
        }
      } catch (err) {
        if (pollGenRef.current !== gen) return;
        // Definitive rejections (job not found, bad id, expired session) end
        // the poll; only network/server blips merit another tick.
        const terminal = err instanceof LaunchApiAuthenticationError ||
          (err instanceof LaunchApiRequestError && err.status < 500);
        if (terminal) {
          setResponse({
            job_id: jobId,
            error: err instanceof Error ? err.message : String(err),
          });
          setRunState("error");
          return;
        }
      }
      if (Date.now() - startedAt > 5 * 60_000) {
        setResponse({
          job_id: jobId,
          note:
            "Still running. The job continues server-side — check back or poll ul.job from your agent.",
        });
        setRunState("queued");
        return;
      }
      pollJob(jobId, startedAt, gen);
    }, 3000);
  };

  const runFunction = async () => {
    // A re-run supersedes any in-flight poll chain from a previous async run.
    // Capture the bumped generation NOW: a re-run or unmount during the run
    // POST below bumps it again, and this invocation must notice.
    const gen = ++pollGenRef.current;
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setRunState("running");
    const data = new FormData(formRef.current || undefined);
    // Send exactly what the form contains — never silently substitute demo
    // values into a real (possibly paid) call.
    const args = Object.fromEntries(
      fn.args.map((arg) => [arg, data.get(arg) ?? ""]),
    );
    try {
      const result = await launchApi.runAgentFunction(tool.id, fn.name, {
        args,
      });
      // Superseded (re-run) or unmounted while the POST was in flight.
      if (pollGenRef.current !== gen) return;
      const resultRecord = result.result && typeof result.result === "object" &&
          !Array.isArray(result.result)
        ? result.result as Record<string, unknown>
        : null;
      if (
        resultRecord?._async === true &&
        typeof resultRecord.job_id === "string" &&
        resultRecord.status === "queued"
      ) {
        setResponse({
          job_id: resultRecord.job_id,
          status: "queued",
          note: "Queued for durable execution — waiting for the result…",
        });
        setRunState("queued");
        pollJob(resultRecord.job_id, Date.now(), gen);
        return;
      }
      setResponse({
        ...(resultRecord ?? { result: result.result ?? null }),
        receiptId: result.receiptId || null,
        success: result.success,
      });
      setRunState(result.success ? "success" : "error");
    } catch (err) {
      if (pollGenRef.current !== gen) return;
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
              <input name={arg} placeholder={argHint(arg)} />
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
            {response
              ? <pre>{JSON.stringify(response, null, 2)}</pre>
              : null}
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
        <h3>{tool.signer ?? "Not signed yet"}</h3>
        <p>
          The public manifest advertises runtime, capabilities, pricing,
          receipts, and setup needs before any connected agent calls the Agent.
        </p>
        <div className="manifest-grid">
          <MetaPair label="version" value={tool.version ?? "—"} />
          <MetaPair label="runtime" value={tool.runtime ?? "—"} />
          <MetaPair label="receipts" value="enabled" />
          <MetaPair label="visibility" value={tool.visibility} />
        </div>
      </Card>
      <Card>
        <p className="section-label">Capabilities</p>
        {tool.capabilities.length > 0
          ? (
            <div className="capability-list">
              {tool.capabilities.map((capability) => (
                <AgentCapabilityPill
                  capability={capability}
                  key={`${capability.kind}-${capability.text}`}
                />
              ))}
            </div>
          )
          : (
            <p className="muted-note">
              This Agent has not published a trust card declaring its
              capabilities yet.
            </p>
          )}
      </Card>
    </div>
  );
}

function AgentTrustRail({ tool }: { tool: AgentDetailFixture }): ReactElement {
  const paidFunctions = tool.functions.filter((fn) => fn.price > 0);
  const minPrice = paidFunctions.length > 0
    ? Math.min(...paidFunctions.map((fn) => fn.price))
    : 0;
  const signed = tool.signer !== null;

  return (
    <div className="tool-rail-stack">
      <Card className="trust-card">
        <div className="trust-card-head">
          <Icon name="shield" />
          <div>
            <h3>{signed ? "Ready to call" : "No trust card yet"}</h3>
            <p>
              {signed
                ? "Signed manifest, receipts, and capability disclosure are live."
                : "This Agent has not published a signed trust card. Receipts still apply to every call."}
            </p>
          </div>
        </div>
        <div className="trust-meta">
          <MetaPair label="signer" value={tool.signer ?? "—"} />
          <MetaPair label="version" value={tool.version ?? "—"} />
          <MetaPair label="runtime" value={tool.runtime ?? "—"} />
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
          {tool.callsPerDay !== null
            ? (
              <MetaPair
                label="calls/day"
                value={formatNumber(tool.callsPerDay)}
              />
            )
            : null}
        </div>
      </Card>
      <Card>
        <p className="section-label">Owner</p>
        <div className="owner-row">
          <Avatar color={tool.color} name={tool.author} />
          <div>
            <strong>{tool.author}</strong>
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
  const loading = live.status !== "ready" && live.status !== "error";
  const installedTools = (live.data.library?.installed ?? []).map((tool) =>
    liveAgentFixture(tool)
  );
  const ownedTools = (live.data.library?.owned ?? []).map((tool) =>
    liveAgentFixture(tool)
  );
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
        <select
          aria-label="Library view"
          className="picker-select"
          onChange={(event) => selectView(event.target.value as LibraryView)}
          value={view}
        >
          <option value="installed">Installed tools</option>
          <option value="owned">Tools you own</option>
        </select>
        <span className="library-count">{count}</span>
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
              : loading
              ? null
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
              : loading
              ? null
              : (
                <EmptyState icon="key" title="Sign in to load owned Agents">
                  The live library endpoint needs an account session before it
                  can show Agents you own.
                </EmptyState>
              )}
          </div>
        )}

      {loading && installedTools.length === 0 &&
          ownedTools.length === 0
        ? (
          <div className="library-empty-grid">
            <LibraryEmptyCard
              body="Ship your first Agent from the CLI and it appears here."
              title="Agents you own"
            />
            <LibraryEmptyCard
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
  // Live data only — an inaccessible Agent shows an honest empty state, never
  // a demo fixture posing as a manageable Agent.
  const tool = liveDetailAgent(
    live.data.adminAgent?.admin.agent ?? live.data.adminAgent?.admin.tool,
    live.data.agentFunctions?.functions,
    live.data.agentCallerPermissions,
    live.data.adminAgent?.trustCard,
  );
  if (!tool) {
    return (
      <div className="launch-page-narrow admin-page">
        <ApiNotice live={live} noun="Agent admin" />
        {live.status === "idle" || live.status === "loading" ? null : (
          <EmptyState icon="shield" title="Agent admin needs a live session">
            Sign in as this Agent's owner to manage it. Nothing is shown here
            without live data.
          </EmptyState>
        )}
      </div>
    );
  }
  return (
    <AdminSurface
      live={live}
      locationSearch={location.search}
      navigate={navigate}
      routeId={route.params.id}
      tool={tool}
    />
  );
}

function AdminSurface({
  live,
  locationSearch,
  navigate,
  routeId,
  tool,
}: {
  live: LaunchPageProps["live"];
  locationSearch: string;
  navigate: (to: string) => void;
  routeId?: string;
  tool: AgentDetailFixture;
}): ReactElement {
  const initialTab = adminTabFromSearch();
  const [tab, setTab] = useState<AdminTabId>(initialTab);
  const [visibility, setVisibility] = useState<AgentDetailFixture["visibility"]>(
    tool.visibility,
  );
  useEffect(() => {
    setTab(adminTabFromSearch());
  }, [locationSearch, routeId]);
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
        <MetricTile
          label="Installs"
          value={tool.installs !== null ? formatNumber(tool.installs) : "—"}
        />
        <MetricTile
          label="Calls/day"
          value={tool.callsPerDay !== null
            ? formatNumber(tool.callsPerDay)
            : "—"}
        />
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
          icon="external"
          navigate={navigate}
          to={agentPreviewPath(tool)}
          variant="secondary"
        >
          Public page
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
  body,
  title,
}: {
  body: string;
  title: string;
}): ReactElement {
  return (
    <div className="library-empty-card">
      <strong>{title} — nothing yet</strong>
      <p>{body}</p>
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
            {tool.installs !== null && tool.callsPerDay !== null
              ? `${formatNumber(tool.installs)} installs · ${
                formatNumber(tool.callsPerDay)
              } calls/day`
              : `${tool.kind} agent · ${tool.visibility}`}
          </p>
        </div>
      </div>
      <div className="admin-header-actions">
        <RouteButton
          icon="external"
          navigate={navigate}
          to={agentPreviewPath(tool)}
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
      return <AdminReceiptsPanel />;
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
            {/* category falls back to the agent kind when no tags exist —
                don't present "MCP" as an authored tag. */}
            {tool.category.toLowerCase() !== tool.kind
              ? <span>{tool.category.toLowerCase()}</span>
              : <span className="muted-note">no tags</span>}
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
              <span>$</span>
              <input defaultValue={(fn.price / 100).toFixed(4)} />
            </label>
            <Mono>{fn.p50 !== null ? `${fn.p50}ms` : "—"}</Mono>
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
      <EmptyState icon="key" title="Secrets are managed from your agent">
        The website does not read or edit App Settings yet. Use{" "}
        <Mono>ul.set</Mono> from a connected agent (or the CLI) to manage this
        Agent's secrets.
      </EmptyState>
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
            <h3>
              {tool.signer !== null
                ? "Signed manifest · receipts on"
                : "No trust card yet"}
            </h3>
            <p>
              Trust fields are what public Agent pages and connected agents
              inspect before calling.
            </p>
          </div>
        </div>
        <div className="manifest-grid">
          <MetaPair label="signer" value={tool.signer ?? "—"} />
          <MetaPair
            label="version"
            value={tool.version ? `v${tool.version}` : "—"}
          />
          <MetaPair label="runtime" value={tool.runtime ?? "—"} />
          <MetaPair
            label="updated"
            value={tool.updatedAt ? `${tool.updatedAt} ago` : "—"}
          />
        </div>
      </Card>
      <Card>
        <p className="section-label">Declared capabilities</p>
        {tool.capabilities.length > 0
          ? (
            <div className="capability-list">
              {tool.capabilities.map((capability) => (
                <AgentCapabilityPill
                  capability={capability}
                  key={`${capability.kind}-${capability.text}`}
                />
              ))}
            </div>
          )
          : (
            <p className="muted-note">
              No trust card published yet — declared permissions appear here
              after the next upload.
            </p>
          )}
      </Card>
    </div>
  );
}

function AdminReceiptsPanel(): ReactElement {
  return (
    <div className="admin-panel">
      <EmptyState icon="wallet" title="Receipts live in your wallet">
        Per-call earnings for this Agent appear on the Wallet page's Earnings
        tab once calls come in. A per-Agent receipts view is not on the website
        yet.
      </EmptyState>
    </div>
  );
}

function AdminLogsPanel(): ReactElement {
  return (
    <div className="admin-panel admin-log-list">
      <EmptyState icon="grid" title="Logs are available from your agent">
        The website does not stream run logs yet. Use <Mono>ul.logs</Mono>{" "}
        from a connected agent to inspect this Agent's recent runs and errors.
      </EmptyState>
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
          value={wallet ? (showEarnings ? totals.earned : totals.spendable) : null}
        />
        <div className="wallet-hero-actions">
          {showEarnings
            ? null
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
        ? <WalletTopUpPanel earnedCredits={totals.earned} live={live} />
        : null}
      {tab === "receipts"
        ? <WalletReceiptsPanel receipts={liveReceiptRows(receipts)} />
        : null}
      {tab === "earnings"
        ? (
          <WalletEarningsPanel
            earnings={liveEarningRows(earnings)}
            payoutStatus={wallet?.payoutStatus}
          />
        )
        : null}
    </div>
  );
}

export function SettingsFoundationPage(
  { live, navigate }: LaunchPageProps,
): ReactElement {
  const canManageKeys = live.status !== "error";
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [newAgentPermission, setNewAgentPermission] = useState<
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
      // Keep the row visible so the revoke can be retried.
    }
  };

  return (
    <div className="launch-page-narrow settings-page">
      <ApiNotice live={live} noun="settings" />
      <div className="profile-strip">
        <Avatar color="#0a0a0a" name="@you" />
        <div>
          <h1>Profile</h1>
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
        <p className="settings-help">
          {canManageKeys
            ? "Keys are shown by prefix only — the full token is revealed once, at creation."
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
  { label, value }: { label: string; value: number | null },
): ReactElement {
  // null = wallet not loaded yet; never show a fabricated ✦0.000 balance.
  if (value === null) {
    return (
      <div className="wallet-amount">
        <span>{label}</span>
        <strong>—</strong>
      </div>
    );
  }
  const [whole, fraction] = value.toFixed(3).split(".");
  return (
    <div className="wallet-amount">
      <span>{label}</span>
      <strong>
        <small>$</small>
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
          value={formatCreditFromLight(totals.deposited)}
        />
        <MetricTile
          label="Earned"
          value={formatCreditFromLight(totals.earned)}
        />
        <MetricTile
          label="Escrow"
          value={formatCreditFromLight(totals.escrow)}
        />
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
          <Pill>{ledger.length} entries</Pill>
        </div>
        <div className="wallet-ledger">
          {ledger.length > 0
            ? ledger.map((row, index) => (
              <WalletLedgerRow
                first={index === 0}
                key={`${row.detail}-${row.when}-${index}`}
                row={row}
              />
            ))
            : (
              <EmptyState icon="wallet" title="No transactions yet">
                Deposits, agent calls, and transfers appear here as they
                happen.
              </EmptyState>
            )}
        </div>
      </Card>
    </div>
  );
}

// Checkout lifecycle for the top-up flow. The PaymentIntent (created at
// "creating") locks the charged amount, so any amount/method change discards
// the in-flight checkout back to "idle". Credits land asynchronously — the
// Stripe webhook settles the deposit — so success states refetch the wallet on
// a short schedule instead of assuming an instant balance bump.
type TopUpPhase =
  | "idle"
  | "creating"
  | "collecting"
  | "confirming"
  | "succeeded"
  | "processing";

const TOPUP_SUCCESS_MESSAGE =
  "Payment received. Credits are added once Stripe confirms the charge — usually within seconds.";
const TOPUP_PROCESSING_MESSAGE =
  "Bank transfer initiated. Credits are added when the transfer settles (ACH can take a few business days).";
const TOPUP_VERIFY_MESSAGE =
  "Bank verification needed. Stripe will send two small deposits to your account — follow the emailed instructions to verify, and the transfer completes after that.";

// Captured synchronously on first render — before any effect can reset state
// or strip the URL — and replayed from state so a dev StrictMode remount
// re-applies it after the amount-reset effect runs. Stripe appends these
// params to the return_url on redirect-based flows.
function readStripeRedirectOutcome():
  | "succeeded"
  | "processing"
  | "failed"
  | null {
  const params = new URLSearchParams(window.location.search);
  const redirectStatus = params.get("redirect_status");
  if (!params.get("payment_intent_client_secret") || !redirectStatus) {
    return null;
  }
  for (
    const key of [
      "payment_intent",
      "payment_intent_client_secret",
      "redirect_status",
    ]
  ) {
    params.delete(key);
  }
  const remaining = params.toString();
  window.history.replaceState(
    {},
    "",
    window.location.pathname + (remaining ? `?${remaining}` : ""),
  );
  if (redirectStatus === "succeeded") return "succeeded";
  if (redirectStatus === "processing") return "processing";
  return "failed";
}

// A confirm can complete after the panel unmounts (tab switch, navigation
// mid-payment). Record the in-flight/terminal state in sessionStorage so a
// remounted panel restores the outcome — or warns that a charge may have
// happened — instead of offering a fresh checkout as if nothing did.
const TOPUP_PENDING_RESULT_KEY = "ul-topup-pending-result";

function readPendingTopUpResult(): string | null {
  try {
    return sessionStorage.getItem(TOPUP_PENDING_RESULT_KEY);
  } catch {
    return null;
  }
}

function writePendingTopUpResult(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(TOPUP_PENDING_RESULT_KEY);
    else sessionStorage.setItem(TOPUP_PENDING_RESULT_KEY, value);
  } catch {
    // Storage unavailable (private mode): the in-place UI still works.
  }
}

function WalletTopUpPanel(
  { earnedCredits, live }: {
    earnedCredits: number;
    live: LaunchPageProps["live"];
  },
): ReactElement {
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [creditsAmount, setCreditsAmount] = useState(10000);
  const [phase, setPhase] = useState<TopUpPhase>("idle");
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  // ACH microdeposit fallback: Stripe's hosted page for verifying the bank.
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [redirectOutcome] = useState(readStripeRedirectOutcome);
  const [checkout, setCheckout] = useState<
    {
      clientSecret: string;
      publishableKey: string;
      // The server-computed quote locked into the PaymentIntent — the ONLY
      // amount the Pay button may display once a checkout exists.
      quote: {
        baseDollars: number;
        feeDollars: number;
        feeNote: string;
        totalDollars: number;
      };
    } | null
  >(null);
  const [liveQuote, setLiveQuote] = useState<
    {
      baseDollars: number;
      feeDollars: number;
      feeNote: string;
      totalDollars: number;
    } | null
  >(null);
  const quote = liveQuote || quoteTopUp(creditsAmount, method);
  // Once an intent exists its server-locked quote is authoritative; before
  // that, prefer the live server quote over the local-formula fallback.
  const shownQuote = checkout?.quote ?? quote;
  const presets = method === "earnings"
    ? [1000, 2500, 10000, 25000, Math.floor(earnedCredits)]
    : [1000, 2500, 10000, 25000, 50000];

  const selectMethod = (next: PaymentMethod) => {
    setMethod(next);
    if (next !== "earnings") {
      // Paid methods accept 1,000–500,000 credits; clamp an out-of-range
      // carry-over from the earnings "Max" preset.
      setCreditsAmount((value) => Math.min(500000, Math.max(1000, value)));
    }
  };

  const paymentElementRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const reloadTimersRef = useRef<number[]>([]);
  // Invalidation token: bumped whenever the user abandons/restarts a checkout
  // so a stale in-flight intent-create or confirm result can't clobber the UI.
  const seqRef = useRef(0);
  // The PaymentIntent amount is fixed at creation; while a confirm is in
  // flight the user may already have been charged, so lock the inputs instead
  // of allowing a reset.
  const inputsLocked = phase === "confirming";

  useEffect(() => {
    // Clear immediately so a slow response can never leave a PREVIOUS
    // amount's quote on screen for the new selection.
    setLiveQuote(null);
    if (method === "earnings") return;
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

  // Amount/method changed: the prepared PaymentIntent no longer matches, so
  // drop the checkout and start over (inputs are locked during confirm, so a
  // possibly-charged intent can never be silently discarded here).
  useEffect(() => {
    seqRef.current += 1;
    setCheckout(null);
    setPhase("idle");
    setMessage("");
    setMessageIsError(false);
    setVerificationUrl(null);
  }, [creditsAmount, method]);

  // Mount the Stripe Payment Element once an intent exists. The container div
  // renders whenever `checkout` is set, so this effect runs after it exists.
  useEffect(() => {
    if (!checkout) return;
    let cancelled = false;
    (async () => {
      try {
        const stripe = await getStripe(checkout.publishableKey);
        if (cancelled) return;
        if (!stripe) {
          throw new Error(
            "Stripe.js failed to load. Check your network or ad blocker and try again.",
          );
        }
        if (!paymentElementRef.current) {
          throw new Error("Payment form failed to initialize.");
        }
        const elements = stripe.elements({
          clientSecret: checkout.clientSecret,
          appearance: { theme: "stripe" },
        });
        const paymentElement = elements.create("payment");
        // Gate "collecting" on the iframe actually rendering: an enabled Pay
        // button over an empty box (e.g. consumed client secret) is a dead end.
        paymentElement.on("ready", () => {
          if (!cancelled) setPhase("collecting");
        });
        paymentElement.on("loaderror", (event) => {
          if (cancelled) return;
          setCheckout(null);
          setPhase("idle");
          setMessageIsError(true);
          setMessage(
            event.error?.message ||
              "The payment form failed to load. Please try again.",
          );
        });
        paymentElement.mount(paymentElementRef.current);
        stripeRef.current = stripe;
        elementsRef.current = elements;
      } catch (err) {
        if (cancelled) return;
        setCheckout(null);
        setPhase("idle");
        setMessageIsError(true);
        setMessage(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      elementsRef.current?.getElement("payment")?.destroy();
      elementsRef.current = null;
      stripeRef.current = null;
    };
  }, [checkout]);

  // Restore an outcome that arrived outside this mount: a redirect return
  // (card/ACH confirm inline under `redirect: "if_required"`, so this is
  // defensive) or a confirm that resolved after the panel unmounted (the
  // sessionStorage marker). Declared AFTER the amount-reset effect so the
  // restored state survives the shared on-mount run order.
  useEffect(() => {
    const pending = redirectOutcome ?? readPendingTopUpResult();
    if (!pending) return;
    writePendingTopUpResult(null);
    if (pending === "succeeded") {
      setPhase("succeeded");
      setMessageIsError(false);
      setMessage(TOPUP_SUCCESS_MESSAGE);
      scheduleWalletReloads();
    } else if (pending === "processing") {
      setPhase("processing");
      setMessageIsError(false);
      setMessage(TOPUP_PROCESSING_MESSAGE);
      scheduleWalletReloads();
    } else if (pending === "verify") {
      setPhase("processing");
      setMessageIsError(false);
      setMessage(TOPUP_VERIFY_MESSAGE);
    } else if (pending === "confirming") {
      // The panel unmounted while a confirm was in flight — the charge may
      // have completed. Warn before offering a fresh checkout.
      setMessageIsError(false);
      setMessage(
        "A payment you started may still be processing. Check your balance before paying again.",
      );
      scheduleWalletReloads();
    } else {
      setMessageIsError(true);
      setMessage("Payment was not completed. You have not been charged.");
    }
  }, [redirectOutcome]);

  useEffect(() => () => {
    for (const timer of reloadTimersRef.current) clearTimeout(timer);
  }, []);

  const scheduleWalletReloads = () => {
    for (const timer of reloadTimersRef.current) clearTimeout(timer);
    reloadTimersRef.current = [3000, 8000, 20000].map((delay) =>
      window.setTimeout(() => live.reload(), delay)
    );
  };

  const startCheckout = async () => {
    if (method === "earnings") {
      setMessageIsError(false);
      setMessage("Earnings transfer is not wired into the launch API yet.");
      return;
    }
    if (!termsAccepted) {
      setMessageIsError(true);
      setMessage("Accept the Ultralight Terms to continue.");
      return;
    }
    seqRef.current += 1;
    const seq = seqRef.current;
    setPhase("creating");
    setMessageIsError(false);
    setMessage("");
    setVerificationUrl(null);
    writePendingTopUpResult(null);
    try {
      const response = await launchApi.createWalletTopUpIntent({
        amountCredits: creditsAmount,
        method,
        termsAccepted: true,
      });
      if (seqRef.current !== seq) return;
      // Phase advances to "collecting" once the Payment Element reports ready.
      setCheckout({
        clientSecret: response.clientSecret,
        publishableKey: response.publishableKey,
        quote: {
          baseDollars: response.quote.baseAmountCents / 100,
          feeDollars: response.quote.processingFeeCents / 100,
          feeNote: response.quote.feeFormula,
          totalDollars: response.quote.totalAmountCents / 100,
        },
      });
    } catch (err) {
      if (seqRef.current !== seq) return;
      setPhase("idle");
      setMessageIsError(true);
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmTopUpPayment = async () => {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) return;
    const seq = seqRef.current;
    setPhase("confirming");
    setMessageIsError(false);
    setMessage("");
    // If the panel unmounts before this resolves, the marker lets the next
    // mount warn that a charge may have completed. Updated to the terminal
    // outcome below (the setStates would be silent no-ops on a dead instance,
    // but these writes still run).
    writePendingTopUpResult("confirming");
    try {
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/wallet?tab=topup`,
        },
        redirect: "if_required",
      });
      if (seqRef.current !== seq) return;
      if (result.error) {
        writePendingTopUpResult(null);
        setPhase("collecting");
        setMessageIsError(true);
        setMessage(
          result.error.message ||
            "Payment failed. You have not been charged — please try again.",
        );
        return;
      }
      const status = result.paymentIntent?.status;
      if (status === "succeeded") {
        writePendingTopUpResult("succeeded");
        setPhase("succeeded");
        setMessageIsError(false);
        setMessage(TOPUP_SUCCESS_MESSAGE);
        setCheckout(null);
        scheduleWalletReloads();
      } else if (status === "processing") {
        writePendingTopUpResult("processing");
        setPhase("processing");
        setMessageIsError(false);
        setMessage(TOPUP_PROCESSING_MESSAGE);
        setCheckout(null);
        scheduleWalletReloads();
      } else if (status === "requires_action") {
        // ACH microdeposit fallback: the intent is NOT failed — Stripe needs
        // the user to verify their bank account first. Treating this as a
        // retryable error would invite a second, duplicate payment.
        const nextAction = (result.paymentIntent?.next_action ?? null) as
          | {
            verify_with_microdeposits?: { hosted_verification_url?: string };
          }
          | null;
        if (nextAction?.verify_with_microdeposits) {
          writePendingTopUpResult("verify");
          setPhase("processing");
          setMessageIsError(false);
          setMessage(TOPUP_VERIFY_MESSAGE);
          setVerificationUrl(
            nextAction.verify_with_microdeposits.hosted_verification_url ??
              null,
          );
          setCheckout(null);
        } else {
          writePendingTopUpResult(null);
          setPhase("collecting");
          setMessageIsError(true);
          setMessage(
            "Additional verification is required to complete this payment. Please try again or use a different payment method.",
          );
        }
      } else {
        writePendingTopUpResult(null);
        setPhase("collecting");
        setMessageIsError(true);
        setMessage(
          `Payment not completed (status: ${status ?? "unknown"}). Please try again.`,
        );
      }
    } catch (err) {
      if (seqRef.current !== seq) return;
      writePendingTopUpResult(null);
      setPhase("collecting");
      setMessageIsError(true);
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const resetForAnotherTopUp = () => {
    seqRef.current += 1;
    writePendingTopUpResult(null);
    setCheckout(null);
    setPhase("idle");
    setMessage("");
    setMessageIsError(false);
    setTermsAccepted(false);
    setVerificationUrl(null);
    live.reload();
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
              disabled={inputsLocked}
              key={amount}
              onClick={() => setCreditsAmount(amount)}
              type="button"
            >
              {amount === Math.floor(earnedCredits) && method === "earnings"
                ? "Max"
                : formatCreditFromLight(amount)}
            </button>
          ))}
        </div>
        <div className="payment-methods">
          <button
            className={method === "card" ? "active" : ""}
            disabled={inputsLocked}
            onClick={() => selectMethod("card")}
            type="button"
          >
            <strong>Card</strong>
            <span>2.9% + $0.30 gross-up</span>
          </button>
          <button
            className={method === "ach" ? "active" : ""}
            disabled={inputsLocked}
            onClick={() => selectMethod("ach")}
            type="button"
          >
            <strong>Bank (ACH)</strong>
            <span>0.8% gross-up, capped at $5</span>
          </button>
          <button
            className={method === "earnings" ? "active" : ""}
            disabled={inputsLocked}
            onClick={() => selectMethod("earnings")}
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
          value={formatCurrency(shownQuote.baseDollars)}
        />
        <QuoteLine
          label="Processing fee"
          muted={shownQuote.feeNote}
          value={formatCurrency(shownQuote.feeDollars)}
        />
        <QuoteLine
          label="Rate"
          value={method === "earnings" ? "1:1 · no fee" : "$1 credit / $1"}
        />
        <div className="quote-total">
          <span>{method === "earnings" ? "Transfer" : "Total"}</span>
          <strong>{formatCurrency(shownQuote.totalDollars)}</strong>
        </div>
        <div className="quote-receive">
          <span>You receive</span>
          <strong>✦{creditsAmount.toLocaleString()}</strong>
        </div>
        {checkout
          ? <div className="topup-payment-element" ref={paymentElementRef} />
          : null}
        {method !== "earnings" && phase !== "succeeded" &&
            phase !== "processing"
          ? (
            <label className="topup-terms">
              <input
                checked={termsAccepted}
                // Consent was recorded at intent creation; once a checkout
                // exists, unchecking would only desync the UI from it.
                disabled={inputsLocked || checkout !== null}
                onChange={(event) => setTermsAccepted(event.target.checked)}
                type="checkbox"
              />
              <span>
                I agree to the Ultralight{" "}
                <a href="/terms" rel="noopener" target="_blank">
                  Terms of Service
                </a>{" "}
                and authorize this charge.
              </span>
            </label>
          )
          : null}
        {phase === "succeeded" || phase === "processing"
          ? (
            <Button onClick={resetForAnotherTopUp} size="lg" variant="secondary">
              Top up again
            </Button>
          )
          : checkout
          ? (
            <Button
              disabled={phase !== "collecting"}
              onClick={confirmTopUpPayment}
              size="lg"
            >
              {phase === "confirming"
                ? "Processing payment…"
                : phase === "collecting"
                ? `Pay ${formatCurrency(shownQuote.totalDollars)}`
                : "Preparing checkout…"}
            </Button>
          )
          : (
            <Button
              disabled={phase === "creating" ||
                (method !== "earnings" && !termsAccepted)}
              onClick={startCheckout}
              size="lg"
            >
              {phase === "creating"
                ? "Preparing checkout…"
                : method === "earnings"
                ? `Transfer ✦${creditsAmount.toLocaleString()}`
                : "Continue to payment"}
            </Button>
          )}
        {message
          ? (
            <p
              className={messageIsError
                ? "settings-help error"
                : "settings-help"}
              role={messageIsError ? "alert" : "status"}
            >
              {message}
            </p>
          )
          : null}
        {verificationUrl
          ? (
            <a
              className="route-link"
              href={verificationUrl}
              rel="noreferrer"
              target="_blank"
            >
              Verify your bank account
            </a>
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
      {receipts.length > 0
        ? (
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
        )
        : (
          <EmptyState icon="wallet" title="No receipts yet">
            Every Agent call produces a receipt; they appear here as your
            connected agents run functions.
          </EmptyState>
        )}
    </Card>
  );
}

const payoutBannerFallback = {
  action: "Withdraw earnings",
  description:
    "Stripe Connect payouts are enabled. Withdraw earned credits to your bank or transfer them to spendable balance.",
  label: "Payouts ready",
  tone: "green",
} as const;

function payoutBannerContent(payoutStatus?: LaunchPayoutStatus | null): {
  action: string;
  description: string;
  label: string;
  tone: "amber" | "green" | "neutral";
} {
  if (!payoutStatus) return payoutBannerFallback;
  const tone = payoutStatus.kind === "ready"
    ? "green"
    : payoutStatus.kind === "onboarding"
    ? "amber"
    : "neutral";
  const action = payoutStatus.kind === "ready"
    ? "Withdraw earnings"
    : payoutStatus.kind === "onboarding"
    ? "Resume Stripe onboarding"
    : "Connect payouts";
  return {
    action,
    description: payoutStatus.description ||
      payoutBannerFallback.description,
    label: payoutStatus.label || payoutBannerFallback.label,
    tone,
  };
}

function WalletEarningsPanel({
  earnings,
  payoutStatus,
}: {
  earnings: LedgerRow[];
  payoutStatus?: LaunchPayoutStatus | null;
}): ReactElement {
  const [toolFilter, setToolFilter] = useState("all");
  const banner = payoutBannerContent(payoutStatus);
  const tools = Array.from(
    new Set(
      earnings.map((row) => row.tool).filter((tool): tool is string =>
        Boolean(tool)
      ),
    ),
  );
  const visibleEarnings = toolFilter === "all"
    ? earnings
    : earnings.filter((row) => row.tool === toolFilter);

  return (
    <div className="wallet-panel">
      <Card className={`payout-banner payout-banner-${banner.tone}`}>
        <span className="target-icon">
          <Icon name="shield" />
        </span>
        <div>
          <h3>Payouts</h3>
          <p>
            Withdrawals run through Stripe Connect via <Mono>ul.wallet</Mono>
            {" "}from a connected agent — a website payout flow is coming.
          </p>
        </div>
      </Card>
      <Card className="wallet-ledger-card">
        <div className="wallet-section-head">
          <h2>Earnings ledger</h2>
          <div className="wallet-earnings-controls">
            {tools.length > 0
              ? (
                <select
                  aria-label="Filter earnings by tool"
                  className="admin-input earnings-tool-filter"
                  onChange={(event) => setToolFilter(event.target.value)}
                  value={toolFilter}
                >
                  <option value="all">All tools</option>
                  {tools.map((tool) => (
                    <option key={tool} value={tool}>{tool}</option>
                  ))}
                </select>
              )
              : null}
            <Pill>creator income</Pill>
          </div>
        </div>
        <div className="wallet-ledger">
          {earnings.length > 0
            ? earnings.map((row, index) => (
              <WalletLedgerRow
                first={index === 0}
                key={`${row.detail}-${row.when}-${index}`}
                row={row}
              />
            ))
            : (
              <EmptyState icon="wallet" title="No earnings yet">
                Per-call earnings from Agents you publish appear here.
              </EmptyState>
            )}
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
    earning: "$",
    payout: "↑",
    topup: "+",
    transfer: "⇄",
  };
  return (
    <div className={first ? "wallet-ledger-row first" : "wallet-ledger-row"}>
      <span className={`mono ledger-glyph ledger-glyph-${row.kind}`}>
        {glyphs[row.kind]}
      </span>
      <span>{row.detail}</span>
      <Mono>{row.when}</Mono>
      <span className={positive ? "mono positive" : "mono"}>
        {positive ? "+" : "-"}{formatCreditFromLight(Math.abs(row.amount))}
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
      <Mono>{receipt.latency !== null ? `${receipt.latency}ms` : "—"}</Mono>
      <span
        className={receipt.status === "error" ? "mono error" : "mono positive"}
      >
        {receipt.status}
      </span>
      <Mono>{receipt.when}</Mono>
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
  // Both StrictMode dev mounts must share ONE create call — a key is a
  // server-side credential, so the effect cannot simply re-run.
  const createOnce = useRef<Promise<LaunchApiKeyCreateResponse> | null>(null);

  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  useEffect(() => {
    let cancelled = false;
    if (!createOnce.current) {
      createOnce.current = launchApi.createApiKey({
        expiresInDays: 90,
        name: `Launch web ${new Date().toLocaleDateString()}`,
        scopes: ["apps:call"],
      });
    }
    createOnce.current
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
    // Never copy a placeholder: only the real once-revealed token is useful.
    if (!plaintextToken) return;
    navigator.clipboard?.writeText(plaintextToken).catch(() => {});
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
              : errorMessage || plaintextToken || "Token unavailable"}
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
  title,
  wrap = false,
}: {
  code?: string;
  highlight?: string;
  title?: string;
  wrap?: boolean;
}): ReactElement {
  const config = code ?? genericMcpConfig("$KEY");
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(config).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <div className={wrap ? "config-preview wrap" : "config-preview"}>
      <div className="config-titlebar">
        <span style={{ background: "#ec6a5e" }} />
        <span style={{ background: "#f4bf4f" }} />
        <span style={{ background: "#61c554" }} />
        <Mono>{title ?? "mcp.json"}</Mono>
        <button className="config-copy" onClick={copy} type="button">
          <Icon name={copied ? "check" : "copy"} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>
          {highlight
            ? highlightSnippet(config, highlight)
            : colorizeSnippet(config)}
        </code>
      </pre>
    </div>
  );
}

function colorizeSnippet(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const pattern = /"[^"\n]*"/gu;
  let cursor = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const after = text.slice(match.index + match[0].length).trimStart();
    nodes.push(
      <span
        className={after.startsWith(":") ? "json-key" : "json-string"}
        key={match.index}
      >
        {match[0]}
      </span>,
    );
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function highlightSnippet(text: string, highlight: string): ReactNode {
  if (!highlight || !text.includes(highlight)) return colorizeSnippet(text);
  const parts = text.split(highlight);
  return parts.map((part, index) => (
    <span key={`${part}-${index}`}>
      {colorizeSnippet(part)}
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
        <Mono>
          {tool.installs !== null
            ? `${formatNumber(tool.installs)} installs`
            : tool.category}
        </Mono>
        {free
          ? <span>Free</span>
          : <span>{formatCredits(tool.callPrice)}/call</span>}
      </div>
    </Card>
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
  const groupLabels = {
    Prompt: "One-prompt setup",
    MCP: "Remote MCP servers",
    Direct: "CLI and API",
  } as const;
  const groupIcons = { Prompt: "copy", MCP: "spark", Direct: "terminal" } as const;
  return (
    <div className="target-picker">
      {(["Prompt", "MCP", "Direct"] as const).map((group) => {
        const groupTargets = targets.filter((target) => target.group === group);
        if (groupTargets.length === 0) return null;
        return (
          <div key={group}>
            <p className="section-label">{groupLabels[group]}</p>
            <div className="target-list">
              {groupTargets.map((target) => (
                <button
                  className={active === target.target ? "active" : ""}
                  key={target.target}
                  onClick={() => onPick(target.target)}
                  type="button"
                >
                  <Icon name={groupIcons[group]} />
                  {target.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
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
  // Only claim a retrieval mode the API actually reported.
  if (!query) {
    return (
      <div className="retrieval-note">
        Browsing all public Agents{mode ? ` · ${mode}` : ""}
      </div>
    );
  }
  return (
    <div className="retrieval-note active">
      <span /> {mode ? `${mode} retrieval` : "Search results"}
    </div>
  );
}

function StoreAgentCard({ tool }: { tool: AgentFixture }): ReactElement {
  return (
    <Card className="store-tool-card">
      <div className="store-card-title">
        <Avatar color={tool.color} name={tool.author} />
        <h3>{tool.name}</h3>
        <Pill>{tool.kind}</Pill>
      </div>
      <p>{tool.summary}</p>
      <div className="store-card-meta">
        <Mono>
          {tool.installs !== null
            ? `${formatNumber(tool.installs)} installs`
            : tool.category}
        </Mono>
        {tool.free || tool.callPrice === 0
          ? <span>Free</span>
          : <span>{formatCredits(tool.callPrice)}/call</span>}
      </div>
      {tool.spark !== null
        ? <Sparkline points={tool.spark} growth={tool.growth} />
        : null}
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
    const x = (index / (points.length - 1)) * 56;
    const y = 15 - ((value - min) / range) * 14;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg
      className={growth > 0.1 ? "sparkline growing" : "sparkline"}
      viewBox="0 0 56 16"
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
  return (
    <Card className="leaderboard-card">
      <div className="leaderboard-head">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        {/* Data is fetched for a fixed 30d window; don't offer period
            switches that wouldn't change it. */}
        <Mono>30d</Mono>
      </div>
      <div className="leaderboard-list">
        {rows.length > 0
          ? rows.map((row) => (
            <div className="leader-row" key={`${title}-${row.rank}`}>
              <Mono>{row.rank}</Mono>
              <Avatar color={row.color} name={row.name} />
              <span>
                <strong>{row.name}</strong>
                {row.featured ? <small>{row.featured}</small> : null}
              </span>
              <Mono>{formatCredits(row.value)}</Mono>
            </div>
          ))
          : <p className="muted-note">No entries yet.</p>}
      </div>
    </Card>
  );
}

function NoResults(
  { onClear, query }: { onClear: () => void; query: string },
): ReactElement {
  if (!query) {
    return (
      <div className="store-empty">
        <EmptyState icon="search" title="No Agents published yet">
          The store is empty right now. Deploy an Agent with the CLI and it
          appears here.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="store-empty">
      <EmptyState icon="search" title="No Agents match that yet">
        Try broader terms, or browse by kind.
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

function formatAgentPrice(value: number): string {
  return value > 0 ? `✦${formatCredits(value)}` : "Free";
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

// Dollar-rendered credit amount (1 credit = 1 cent) — the wallet design
// displays currency-styled values.
function formatCreditFromLight(amountCents: number): string {
  const dollars = amountCents / 100;
  if (!Number.isFinite(dollars)) return "$0.00";
  const abs = Math.abs(dollars);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatCredits(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(3);
}


// ── Legal pages ─────────────────────────────────────────────────────────────
// Plain-language launch versions, flagged for counsel review in the release
// packet. The top-up consent checkbox links to /terms; keep billing language
// in sync with the wallet flow.

export function TermsPage(): ReactElement {
  return (
    <section className="foundation-page legal-page">
      <h1>Terms of Service</h1>
      <p className="legal-updated">Last updated: June 11, 2026</p>
      <p>
        Ultralight provides hosted agents: small programs you install, wire
        together, and run, including functions that call AI models. By creating
        an account or using the platform you agree to these terms.
      </p>
      <h2>Your account</h2>
      <p>
        You are responsible for activity under your account and for keeping
        your sign-in method and API tokens secret. Revoke tokens you no longer
        use from Settings.
      </p>
      <h2>Credits and billing</h2>
      <p>
        Paid usage is denominated in credits. Top-ups are charged at the
        amount shown before you confirm, plus any fees stated at checkout.
        Usage (AI inference, compute, storage) draws down your balance at the
        rates shown on the platform; every charge is recorded against a
        receipt you can inspect in your wallet. Credits are prepaid platform
        usage, not money: they are non-transferable and, except where required
        by law, unused credits are not refundable.
      </p>
      <h2>Your agents and data</h2>
      <p>
        You retain ownership of code and data you bring to the platform. You
        grant us only the rights needed to host and execute it. Agents you
        install may call other agents only through grants you approve, with
        the spending caps you set.
      </p>
      <h2>Acceptable use</h2>
      <p>
        Do not use the platform for unlawful activity, to harm others, to
        attempt to break tenant isolation, or to interfere with the service or
        other users. We may suspend accounts that do.
      </p>
      <h2>Disclaimers</h2>
      <p>
        The service is provided "as is" during launch. AI model outputs are
        probabilistic and may be wrong; you are responsible for reviewing
        outputs before relying on them. To the maximum extent permitted by
        law, our liability is limited to the amount you paid in the three
        months before a claim.
      </p>
      <h2>Changes</h2>
      <p>
        We may update these terms; material changes will be announced on the
        platform before they take effect. Questions: support@ultralight.run.
      </p>
    </section>
  );
}

export function PrivacyPage(): ReactElement {
  return (
    <section className="foundation-page legal-page">
      <h1>Privacy Policy</h1>
      <p className="legal-updated">Last updated: June 11, 2026</p>
      <h2>What we collect</h2>
      <p>
        Account details (email, display name, avatar) from your sign-in
        provider; operational records of platform activity (executions,
        receipts, balances, grants, tokens); and the code and data your agents
        store. Payment card details are processed by Stripe and never touch
        our servers.
      </p>
      <h2>How we use it</h2>
      <p>
        To run your agents, meter and bill usage, secure the platform, and
        support you. Prompts sent to AI models go to the model provider you
        selected (or your own key when you bring one); we do not sell your
        data or use your agents' data to train models.
      </p>
      <h2>Where it lives</h2>
      <p>
        Data is stored with our infrastructure providers (Cloudflare,
        Supabase, Stripe). Your agents' databases are isolated per agent.
      </p>
      <h2>Your choices</h2>
      <p>
        You can delete agents and their data, revoke tokens and grants, and
        request account deletion at support@ultralight.run. Operational
        billing records are retained as required for accounting.
      </p>
    </section>
  );
}
