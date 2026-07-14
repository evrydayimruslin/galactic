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
  type LaunchAgentRoutineAction,
  type LaunchAgentRoutineOverview,
  type LaunchAgentRoutineResponse,
  type LaunchAgentRelationship,
  type LaunchAgentSummary,
  type LaunchFolder,
  type LaunchFullTimeDisclosure,
  type LaunchInterfaceSummary,
  type LaunchNetworkDisclosure,
  type LaunchTrustCard,
  type LaunchWalletEarningSummary,
  type LaunchWalletReceiptSummary,
  type LaunchWalletSummary,
  type LaunchWalletTransaction,
} from "../../../../shared/contracts/launch.ts";
import {
} from "../../../../shared/types/index.ts";
import type { LaunchPageProps } from "../App";
import {
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
  type LaunchConnectStatus,
} from "../lib/api";
import {
  attachInterfaceBridge,
  clampInterfaceHeight,
} from "../lib/interface-bridge";
import {
  getStripe,
  type Stripe,
  type StripeAddressElement,
  type StripeElements,
} from "../lib/stripe";
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
  access: "read" | "write";
  args: string[];
  description: string;
  name: string;
  p50: number | null;
  permission: "always" | "ask" | "never";
  // When permission is "always", auto-allow only when the target is recently healthy.
  healthGate: boolean;
  price: number;
  usesInference?: boolean;
  inferenceOverride?:
    | { billingMode: "light" | "byok"; provider: string | null; model: string | null }
    | null;
}

interface AgentDetailFixture extends AgentFixture {
  callsPerDay: number | null;
  capabilities: AgentCapability[];
  // Phase 4: outbound destinations + the per-user secrets bound to each, plus
  // unbound "general" settings. Null until the Agent publishes a trust card.
  networkDisclosure: LaunchNetworkDisclosure | null;
  functions: AgentFunctionFixture[];
  // Sandboxed HTML interfaces the agent ships; empty for agents without any.
  interfaces: LaunchInterfaceSummary[];
  // Autonomous-behavior disclosure, present only for full-time agents (the
  // manifest declares a routine). Null otherwise.
  fullTime: LaunchFullTimeDisclosure | null;
  relationship: LaunchAgentRelationship;
  // Trust fields are null until the Agent publishes a signed trust card.
  runtime: string | null;
  signer: string | null;
  // Phase 4 trust chips — derived from the signed trust card (default off).
  publisherVerified: boolean;
  openCode: boolean;
  // signedManifest attests the published SOURCE only ("Source signed").
  // executedIntegrity is the real runtime claim (running bytes vs signature).
  signedManifest: boolean;
  executedIntegrity: LaunchTrustCard["executed_integrity"];
  health: LaunchTrustCard["health"] | null;
  title: string;
  updatedAt: string | null;
  version: string | null;
  visibility: "public" | "private" | "unlisted";
}

const apiKeyPlaceholder = "$GALACTIC_API_KEY";
// The MCP host is the API worker itself — derive it so snippets can never
// drift to a stale hardcoded domain.
const apiOrigin = launchApiOrigin();
const mcpUrl = `${apiOrigin}/mcp/platform`;

// Local fallback mirroring the BE `prompt` install instruction
// (buildInstallInstructions in api/handlers/launch.ts) for when the live
// instructions are unavailable.
function buildConnectPrompt(key: string): string {
  const claudeCodeAdd =
    `claude mcp add --transport http --scope user galactic ${mcpUrl} --header "Authorization: Bearer ${key}"`;
  const genericConfig = JSON.stringify({
    mcpServers: {
      galactic: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } },
    },
  });
  return [
    "Connect Galactic to this coding agent, then help me conjure one useful full-time Agent.",
    "",
    "Galactic hosts private persistent Agents. You write and test the Agent; Galactic keeps it scheduled, sandboxed, stateful, bounded by owner-approved budgets and capabilities, and visible through run history and inbox reports.",
    "",
    "1. Install the MCP server (pick whichever works in your environment):",
    `   - Claude Code: ${claudeCodeAdd}`,
    `   - Any MCP config file: ${genericConfig}`,
    `   - Automated installer: npx galacticconnection setup --token ${key}`,
    "",
    "2. Connect, then learn the platform: the server's initialize response carries the full platform guide, including a first-contact directive for how to orient me on this first connection. The same docs are also served at " +
    `${apiOrigin}/api/skills.`,
    "",
    '3. Inspect only my private Agent library with gx.discover({ scope: "library" }). Then ask me for one recurring responsibility. Turn it into a mission, scaffold with gx.download({ full_time: true }), implement and test a representative wake, upload it privately, and stop for my explicit review of capabilities, grants, cadence, secrets, and hard budgets before activation.',
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

// Builder/operator key for the user's primary coding agent. Keep the grants
// explicit: legacy wildcard keys intentionally do not inherit newly-added
// control-plane capabilities, and owner approvals still require the website
// account session even with these scopes.
function mintConnectKey(): Promise<string> {
  return launchApi.createApiKey({
    expiresInDays: 90,
    name: connectKeyName(),
    scopes: ["apps:read", "apps:call", "agents:build", "agents:operate"],
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
    `Set up the "${agent.title}" Agent from Galactic for me, then start using it.`,
    "",
    `"${agent.title}" is an Agent hosted on Galactic. Connect to it as a standalone MCP server; the API key below is scoped to this Agent only.`,
    "",
    "1. Install the MCP server (pick whichever works in your environment):",
    `   - Claude Code: claude mcp add --transport http --scope user ${agent.slug} ${agentMcpUrl} --header "Authorization: Bearer ${key}"`,
    `   - Any MCP config file: ${config}`,
    "",
    `2. Connect, then run tools/list to see what "${agent.title}" can do. ${publicUrl} documents pricing and trust.`,
    "",
    `3. Prove it works: pick its most representative read-only function and call it, then tell me in a few lines how you can use "${agent.title}" for me going forward.`,
    "",
    "Calls may spend credits from my Galactic wallet: preserve receipt_id values and surface any credits-balance errors. Treat the API key as a secret: never echo it back, log it, or commit it anywhere.",
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

const installTargets: InstallTarget[] = [
  {
    config: (key) => buildConnectPrompt(key),
    description:
      "One prompt that makes any agent install Galactic itself and start using it.",
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
      `claude mcp add --transport http --scope user galactic ${mcpUrl} --header "Authorization: Bearer ${key}"`,
    description:
      "Add Galactic as a remote MCP server for an existing Claude Code workspace.",
    group: "MCP",
    label: "Claude Code",
    requiresApiKey: true,
    steps: [
      "Create a Galactic API token from Settings.",
      "Run the command below with your token in place of the placeholder.",
      "Run /mcp (or restart) so Claude Code picks up the galactic server.",
    ],
    target: "claude_code",
  },
  {
    config: (key) => genericMcpConfig(key),
    description:
      "Install the Galactic MCP server in Cursor's MCP configuration.",
    group: "MCP",
    label: "Cursor",
    requiresApiKey: true,
    steps: [
      "Open Cursor MCP settings.",
      "Add the galactic server entry below.",
      "Reload Cursor so your connected agent can discover Galactic Agents.",
    ],
    target: "cursor",
  },
  {
    config: (key) =>
      `[mcp_servers.galactic]\nurl = "${mcpUrl}"\nheaders = { Authorization = "Bearer ${key}" }`,
    description:
      "Connect Codex to the same remote MCP endpoint used by other agents.",
    group: "MCP",
    label: "Codex",
    requiresApiKey: true,
    steps: [
      "Create a Galactic API token.",
      "Add a remote MCP server named galactic.",
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
      "Register Galactic as a remote MCP server for OpenAI agent runtimes that support MCP tools.",
    group: "MCP",
    label: "OpenAI Remote MCP",
    requiresApiKey: true,
    steps: [
      "Use the platform MCP endpoint as the server URL.",
      "Pass your Galactic API token as a bearer Authorization header.",
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
      "Replace the API token placeholder with an Galactic API token.",
      "Restart the agent or refresh its tool registry.",
    ],
    target: "generic_mcp",
  },
  {
    config: (key) =>
      `npm install -g galacticconnection\ngalactic login --token ${key}\ngalactic upload .`,
    description:
      "Use the Galactic CLI to login, upload, test, and run deployed Agents.",
    group: "Direct",
    label: "CLI",
    requiresApiKey: true,
    steps: [
      "Install the galacticconnection package.",
      "Run galactic login --token <your-token>.",
      "Run galactic upload . from a deployable Agent directory.",
    ],
    target: "cli",
  },
  {
    config: (key) =>
      `curl "${apiOrigin}/api/launch/status"\ncurl -H "Authorization: Bearer ${key}" \\\n  "${apiOrigin}/api/launch/library"`,
    description:
      "Call launch and platform endpoints directly with an Galactic API token.",
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

// Legacy admin tab implementation remains temporarily for compatibility while
// /admin/agents/:id redirects to the canonical Agent Overview.
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
type AgentPageTabId = "overview" | "functions" | "interface";

const visibilityOptions = [
  [
    "public",
    "Public",
    "Anyone can view and connect. Eligible for Galactic showcases.",
  ],
  [
    "unlisted",
    "Unlisted",
    "Anyone with the link can view and connect. Not featured publicly.",
  ],
  [
    "private",
    "Private",
    "Only you can view and call it.",
  ],
] as const;

type PaymentMethod = "ach" | "card" | "earnings";

interface LedgerRow {
  amount: number;
  detail: string;
  kind: "call" | "earning" | "payout" | "topup" | "transfer";
  tool?: string;
  when: string;
}

// Unified row for the merged balance ledger (transactions + receipts in one
// time-sorted list). Transaction rows are static; receipt rows expand to their
// own cost breakdown — the receipt IS the drill-down "depth".
type WalletRow =
  | {
    source: "transaction";
    id: string;
    createdAt: string | null;
    when: string;
    amount: number;
    detail: string;
    kind: LedgerRow["kind"];
  }
  | {
    source: "receipt";
    id: string;
    createdAt: string | null;
    when: string;
    amount: number;
    detail: string;
    fn: string;
    status: "error" | "ok";
    total: number;
    appCharge: number;
    infraCharge: number;
    platformFee: number;
    developerNet: number;
    tax: number;
  };

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
    ) => [entry.functionName, entry]),
  );
  const defaultHealthGate = options.permissions?.defaultHealthGate ?? true;
  // Only real data: functions come from the live endpoint (or stay empty),
  // metrics the platform doesn't report are null, and trust fields exist only
  // when the Agent ships a trust card. Nothing here is fabricated.
  const functions = (options.functions || []).map((fn) => ({
    access: fn.annotations?.readOnlyHint === true
      ? "read" as const
      : "write" as const,
    args: inputArgs(fn.inputSchema),
    description: fn.description || `Run ${fn.name}.`,
    name: fn.name,
    p50: null,
    permission: permissions.get(fn.name)?.policy || fn.callerPermission?.policy ||
      fn.agentPermission?.policy || "ask" as const,
    healthGate: permissions.get(fn.name)?.healthGate ?? defaultHealthGate,
    price: creditsValue(fn.pricing?.defaultCallPrice),
    usesInference: fn.usesInference ?? false,
    inferenceOverride: fn.inferenceOverride
      ? {
        billingMode: fn.inferenceOverride.billingMode,
        provider: fn.inferenceOverride.provider,
        model: fn.inferenceOverride.model,
      }
      : null,
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
    networkDisclosure: trust?.network_disclosure ?? null,
    category: tool.tags?.[0] || tool.kind.toUpperCase(),
    color: stableColor(tool.id),
    free: callPrice === 0,
    functions,
    growth: 0,
    id: tool.id,
    installs: null,
    interfaces: tool.interfaces || [],
    kind: tool.kind,
    name: tool.name,
    fullTime: tool.fullTime ?? null,
    relationship: tool.relationship,
    runtime: trust?.runtime || null,
    signer: trust?.signer || null,
    publisherVerified: trust?.publisher_verified ?? false,
    openCode: trust?.open_code ?? false,
    signedManifest: trust?.signed_manifest ?? false,
    executedIntegrity: trust?.executed_integrity ?? "unknown",
    health: trust?.health ?? null,
    slug: tool.slug,
    spark: null,
    summary: tool.description || "Agent published on Galactic.",
    title: titleizeAgentName(tool.name),
    updatedAt: relativeTime(tool.updatedAt) || null,
    version: trust?.version || null,
    visibility: tool.visibility,
  };
}

// Collapse the 1h/24h/7d/30d windows into one binary chip (green/red), or
// neutral when there isn't enough paid, non-self traffic to judge. No amber —
// "no data" is shown as neutral, never an ambiguous warning colour.
function overallHealthTone(
  health: LaunchTrustCard["health"] | null,
): { tone: "green" | "red" | "default"; label: string } {
  if (!health) return { tone: "default", label: "Health: no data" };
  // Prefer the freshest window with a verdict so a now-broken Agent (24h red)
  // never reads "Healthy" on a stale 7d green.
  for (const window of ["24h", "7d"] as const) {
    if (health[window] === "green") return { tone: "green", label: "Healthy" };
    if (health[window] === "red") return { tone: "red", label: "Unhealthy" };
  }
  return { tone: "default", label: "Health: no data" };
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

function liveWalletTotals(wallet?: LaunchWalletSummary): typeof walletSummary {
  if (!wallet) return walletSummary;
  return {
    deposited: creditsValue(wallet.depositBalance),
    earned: creditsValue(wallet.earnedBalance),
    escrow: creditsValue(wallet.escrowBalance),
    spendable: creditsValue(wallet.spendableBalance || wallet.balance),
  };
}

// The ledger persists deposit rows server-side as "Light deposit" /
// "Light deposit refund" / "Light deposit dispute" — "Light" is the internal
// accounting unit and shouldn't surface in the UI. Relabel at display time so
// existing rows read cleanly without a data migration.
function cleanLedgerDescription(description: string): string {
  return description.replace(/\bLight deposit\b/gi, "Deposit");
}

// Merge the two disjoint streams — billing transactions (hosting/chat/top-up
// charges) and agent-call receipts — into one list, newest first. They share
// no key, so we keep each row's provenance distinct rather than fuzzy-joining.
function mergeWalletRows(
  transactions?: LaunchWalletTransaction[],
  receipts?: LaunchWalletReceiptSummary[],
): WalletRow[] {
  const txRows: WalletRow[] = (transactions || []).map((entry) => ({
    source: "transaction",
    id: entry.id,
    createdAt: entry.createdAt ?? null,
    when: relativeTime(entry.createdAt) || "now",
    amount: creditsValue(entry.amount),
    detail: entry.appName
      ? `${entry.appName} · ${cleanLedgerDescription(entry.description)}`
      : cleanLedgerDescription(entry.description),
    kind: ledgerKind(entry.category, entry.type),
  }));
  const receiptRows: WalletRow[] = (receipts || []).map((receipt) => {
    const total = creditsValue(receipt.total);
    return {
      source: "receipt",
      id: `receipt-${receipt.receiptId}`,
      createdAt: receipt.createdAt ?? null,
      when: relativeTime(receipt.createdAt) || "now",
      // A receipt is a spend against the balance.
      amount: -Math.abs(total),
      detail: `${receipt.appName || receipt.appId || "agent"} · ${
        receipt.functionName || "run"
      }`,
      fn: receipt.functionName || "run",
      status: receipt.success ? "ok" : "error",
      total,
      appCharge: creditsValue(receipt.appCharge),
      infraCharge: creditsValue(receipt.infraCharge),
      platformFee: creditsValue(receipt.platformFee),
      developerNet: creditsValue(receipt.developerNet),
      tax: creditsValue(receipt.tax),
    };
  });
  return [...txRows, ...receiptRows].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
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

// Live API status notices (loading / error) are intentionally suppressed
// across the launch surface — a no-op keeps the page call sites unchanged.
function ApiNotice(
  _props: { live: LaunchPageProps["live"]; noun: string },
): ReactElement | null {
  return null;
}

export function AddToAgentButton({
  instructions,
  label = "Add to agent",
  size = "lg",
  variant,
}: {
  instructions?: LaunchInstallInstruction[];
  label?: string;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost";
}): ReactElement {
  const [open, setOpen] = useState(false);
  const openSignIn = useSignInModal();
  // Signed out there is no key to mint — prompt sign-in first; the same button
  // mints the key + copies the prompt once a session exists.
  if (!hasLaunchAuthToken()) {
    return (
      <Button icon="copy" onClick={openSignIn} size={size} variant={variant}>
        {label}
      </Button>
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
        {label}
      </Button>
      {open
        ? (
          <ConnectPromptModal
            buildPrompt={buildPrompt}
            intro="This created a 90-day key scoped to read, call, build, and operate your private Agents. Owner approvals, secrets, billing, and publication still require your Galactic account session. The key is shown only here."
            mint={mintConnectKey}
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
  onClose,
}: {
  buildPrompt: (key: string) => string;
  intro: string;
  mint: () => Promise<string>;
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
    <div
      className="settings-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
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
          <Button onClick={onClose} size="sm">Done</Button>
        </div>
      </Card>
    </div>
  );
}

// --- Lightweight first-party markdown renderer for the platform SDK docs. ---
// /api/skills is authored by us (buildPlatformDocs), so this only needs to cover
// the constructs it emits: headings, GFM tables, fenced code, lists, bold,
// inline code, links, and rules. The source is HTML-escaped up front, so the
// rendered output is injection-safe.
function escapeDocsHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function renderDocsInline(value: string): string {
  const codes: string[] = [];
  let out = value.replace(/`([^`]+)`/gu, (_match, code: string) => {
    codes.push(code);
    return ` ${codes.length - 1} `;
  });
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/gu,
    (_match, text: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noreferrer">${text}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>");
  out = out.replace(
    / (\d+) /gu,
    (_match, index: string) => `<code>${codes[Number(index)]}</code>`,
  );
  return out;
}

function renderDocsMarkdown(markdown: string): string {
  const lines = escapeDocsHtml(markdown).replace(/\r\n/gu, "\n").split("\n");
  let html = "";
  let index = 0;
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length) {
      html += `<p>${renderDocsInline(paragraph.join(" "))}</p>`;
      paragraph = [];
    }
  };
  const isSeparator = (line: string | undefined): boolean =>
    Boolean(line) && line!.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/u.test(line!);
  const splitCells = (line: string): string[] =>
    line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) =>
      cell.trim()
    );
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/u.test(line)) {
      flush();
      index += 1;
      const buffer: string[] = [];
      while (index < lines.length && !/^\s*```/u.test(lines[index])) {
        buffer.push(lines[index]);
        index += 1;
      }
      index += 1;
      html += `<pre><code>${buffer.join("\n")}</code></pre>`;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/u);
    if (heading) {
      flush();
      const level = heading[1].length;
      html += `<h${level}>${renderDocsInline(heading[2])}</h${level}>`;
      index += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      flush();
      html += "<hr/>";
      index += 1;
      continue;
    }
    if (line.includes("|") && isSeparator(lines[index + 1])) {
      flush();
      const header = splitCells(line);
      index += 2;
      let table = `<table><thead><tr>${
        header.map((cell) => `<th>${renderDocsInline(cell)}</th>`).join("")
      }</tr></thead><tbody>`;
      while (
        index < lines.length && lines[index].includes("|") && lines[index].trim()
      ) {
        table += `<tr>${
          splitCells(lines[index]).map((cell) => `<td>${renderDocsInline(cell)}</td>`)
            .join("")
        }</tr>`;
        index += 1;
      }
      html += `${table}</tbody></table>`;
      continue;
    }
    if (/^\s*[-*]\s+/u.test(line)) {
      flush();
      let list = "<ul>";
      while (index < lines.length && /^\s*[-*]\s+/u.test(lines[index])) {
        list += `<li>${renderDocsInline(lines[index].replace(/^\s*[-*]\s+/u, ""))}</li>`;
        index += 1;
      }
      html += `${list}</ul>`;
      continue;
    }
    if (/^\s*\d+\.\s+/u.test(line)) {
      flush();
      let list = "<ol>";
      while (index < lines.length && /^\s*\d+\.\s+/u.test(lines[index])) {
        list += `<li>${renderDocsInline(lines[index].replace(/^\s*\d+\.\s+/u, ""))}</li>`;
        index += 1;
      }
      html += `${list}</ol>`;
      continue;
    }
    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return html;
}

function DocsModal({ onClose }: { onClose: () => void }): ReactElement {
  const [html, setHtml] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${launchApiOrigin()}/api/skills`)
      .then((response) =>
        response.ok
          ? response.text()
          : Promise.reject(new Error(`HTTP ${response.status}`))
      )
      .then((markdown) => {
        if (!cancelled) setHtml(renderDocsMarkdown(markdown));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div
      className="settings-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <Card className="docs-modal">
        <div className="modal-title-row">
          <span className="target-icon"><Icon name="terminal" /></span>
          <h2>Developer docs — the Galactic SDK reference</h2>
        </div>
        <p className="docs-modal-intro">
          The single source every MCP- and CLI-connected agent reads to build on
          Galactic — capabilities, platform tools, and recipes. Served live from
          {" "}
          <code>/api/skills</code>.
        </p>
        {errorMessage
          ? <p>Could not load the docs: {errorMessage}</p>
          : html
          ? (
            <div
              className="docs-markdown"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )
          : <p>Loading the SDK reference…</p>}
        <div className="modal-actions">
          <Button onClick={onClose} size="sm">Done</Button>
        </div>
      </Card>
    </div>
  );
}

function DeveloperDocsButton(
  { label = "Developers", size = "lg", variant = "ghost" }: {
    label?: string;
    size?: "sm" | "md" | "lg";
    variant?: "primary" | "secondary" | "ghost";
  },
): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        icon="terminal"
        onClick={() => setOpen(true)}
        size={size}
        variant={variant}
      >
        {label}
      </Button>
      {open ? <DocsModal onClose={() => setOpen(false)} /> : null}
    </>
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
            Connect once.<br />Access every tool.
          </h1>
          <p>
            Add Galactic to your agent so it can call any tool published to
            the platform, with your auth, payments, and preferences in one
            place. Pay per call. Nothing to subscribe to.
          </p>
          <div className="hero-actions left">
            <AddToAgentButton
              instructions={installInstructions}
              label="Add to your agent"
            />
            <RouteButton
              navigate={navigate}
              size="lg"
              to="/browse"
              variant="secondary"
            >
              Browse agents
            </RouteButton>
            <DeveloperDocsButton />
          </div>
        </div>
        <AgentOrbit />
      </section>

      <ValueProps />

      <section className="shared-core-section">
        <h2>Every agent draws from one source.</h2>
        <p>
          The same context, tools, auth, and payments — wherever you work.
        </p>
        <SharedCore />
      </section>

      {homeTools.length > 0
        ? (
          <Section
            action={
              <RouteLink navigate={navigate} to="/browse">Browse all</RouteLink>
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
          <AddToAgentButton instructions={installInstructions} />
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
            variant="secondary"
          />
          <RouteButton
            navigate={navigate}
            size="lg"
            to="/browse"
            variant="ghost"
          >
            Browse
          </RouteButton>
        </div>
      </section>
    </div>
  );
}

export function StoreFoundationPage(
  { live, location, navigate }: LaunchPageProps,
): ReactElement {
  const [query, setQuery] = useState(storeQueryFromSearch());
  useEffect(() => {
    setQuery(storeQueryFromSearch());
  }, [location.search]);

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    syncSearchParams({ q: nextQuery.trim() || null });
  };
  const storeTools = liveStoreAgents(live.data.store?.results);
  const agentRows = waivedLeaderboardRows(
    live.data.agentFeeLeaderboard?.entries,
  );
  const builderRows = waivedLeaderboardRows(live.data.feeLeaderboard?.entries);
  const searching = query.trim().length > 0;
  const filteredTools = storeTools.filter((tool) =>
    !query ||
    `${tool.name} ${tool.summary} ${tool.category}`.toLowerCase().includes(
      query.toLowerCase(),
    )
  );

  return (
    <div className="launch-page-narrow store-page">
      <ApiNotice live={live} noun="store Agents" />
      <section className="store-heading">
        <SearchControls query={query} setQuery={updateQuery} />
      </section>

      <div className={searching ? "store-layout searching" : "store-layout"}>
        <section className="store-results">
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
        {searching ? null : (
          <aside className="store-sidebar">
            <TopChart agentRows={agentRows} builderRows={builderRows} />
          </aside>
        )}
      </div>
    </div>
  );
}

// Both Top charts rank by platform fees waived — the visibility reward for
// developers actively spreading their tools via referral links. The ranking
// basis is documented in the API reference, not restated on the card.
function waivedLeaderboardRows(
  entries?: LaunchLeaderboardEntry[],
): LeaderboardRow[] {
  return (entries ?? []).map((entry) => ({
    color: stableColor(entry.userId),
    eventCount: entry.eventCount || 0,
    name: entry.profileSlug
      ? `@${entry.profileSlug}`
      : entry.displayName || `@${entry.userId.slice(0, 6)}`,
    rank: entry.rank,
    value: creditsValue(entry.value),
  }));
}

function TopChart({
  agentRows,
  builderRows,
}: {
  agentRows: LeaderboardRow[];
  builderRows: LeaderboardRow[];
}): ReactElement {
  const [tab, setTab] = useState<"agents" | "builders">("agents");
  const rows = tab === "agents" ? agentRows : builderRows;
  return (
    <Card className="leaderboard-card">
      <div className="leaderboard-head">
        <div className="account-subtabs" role="tablist" aria-label="Top charts">
          {([
            ["agents", "Top Agents"],
            ["builders", "Top Builders"],
          ] as const).map(([id, label]) => (
            <button
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              key={id}
              onClick={() => setTab(id)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <Mono>30d</Mono>
      </div>
      <div className="leaderboard-list">
        {rows.length > 0
          ? rows.map((row) => (
            <div className="leader-row" key={`${tab}-${row.rank}`}>
              <Mono>{row.rank}</Mono>
              <Avatar color={row.color} name={row.name} />
              <span>
                <strong>{row.name}</strong>
              </span>
              <Mono>{formatCredits(row.value)}</Mono>
            </div>
          ))
          : <p className="muted-note">No entries yet.</p>}
      </div>
    </Card>
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
  tool,
}: {
  agentInstall?: LaunchAgentInstallContext | null;
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
        Add direct to agent
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
        Add direct to agent
      </Button>
      {open
        ? (
          <ConnectPromptModal
            buildPrompt={buildPrompt}
            intro={`This created a 90-day API key scoped to ${tool.title} only and baked it into the prompt below. The key is shown only here.`}
            mint={() => mintAgentConnectKey(tool)}
            onClose={() => setOpen(false)}
          />
        )
        : null}
    </>
  );
}

function AgentInstallButton({ tool }: { tool: AgentDetailFixture }): ReactElement {
  const openSignIn = useSignInModal();
  const [state, setState] = useState<
    "idle" | "installing" | "installed" | "uninstalling" | "error"
  >(tool.relationship === "installed" ? "installed" : "idle");

  // Signed out there is no library to add to — prompt sign-in first.
  if (!hasLaunchAuthToken()) {
    return (
      <Button icon="grid" onClick={openSignIn} size="lg" variant="secondary">
        Install
      </Button>
    );
  }

  const locator = tool.slug || tool.id;
  const busy = state === "installing" || state === "uninstalling";

  const toggle = () => {
    if (busy) return;
    if (state === "installed") {
      setState("uninstalling");
      launchApi.uninstallAgent(locator)
        .then(() => setState("idle"))
        .catch(() => setState("installed"));
      return;
    }
    setState("installing");
    launchApi.installAgent(locator)
      .then(() => setState("installed"))
      .catch(() => setState("error"));
  };

  // Installed state doubles as the uninstall control (click to remove).
  return (
    <Button
      className={state === "installed" ? "install-toggle is-installed" : "install-toggle"}
      disabled={busy}
      icon={state === "installed" ? "check" : "grid"}
      onClick={toggle}
      size="lg"
      variant="secondary"
    >
      {state === "installing"
        ? "Installing…"
        : state === "uninstalling"
        ? "Removing…"
        : state === "installed"
        ? "Installed"
        : state === "error"
        ? "Retry install"
        : "Install"}
    </Button>
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
  const [fnMenuOpen, setFnMenuOpen] = useState(false);
  const fnMenuRef = useRef<HTMLDivElement>(null);
  const selectedFunction =
    tool.functions.find((fn) => fn.name === selectedFunctionName) ||
    tool.functions[0];

  // Interface selection lives here (not in the panel) so the Interface tab can
  // be a dropdown — matching the Functions tab — when there's more than one.
  const [selectedInterfaceId, setSelectedInterfaceId] = useState(
    tool.interfaces[0]?.id || "",
  );
  const [intMenuOpen, setIntMenuOpen] = useState(false);
  const intMenuRef = useRef<HTMLDivElement>(null);
  const selectedInterface =
    tool.interfaces.find((iface) => iface.id === selectedInterfaceId) ||
    tool.interfaces[0];
  const multiInterface = tool.interfaces.length > 1;

  useEffect(() => {
    setTab(agentTabFromSearch());
  }, [locationSearch]);

  // The Functions and (multi-)Interface tabs double as dropdowns; close the
  // open one on outside click / Escape. Each ref wraps its trigger + menu so a
  // trigger click toggles cleanly.
  useEffect(() => {
    if (!fnMenuOpen && !intMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (fnMenuOpen && !fnMenuRef.current?.contains(target)) {
        setFnMenuOpen(false);
      }
      if (intMenuOpen && !intMenuRef.current?.contains(target)) {
        setIntMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFnMenuOpen(false);
        setIntMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [fnMenuOpen, intMenuOpen]);

  // Wiring is meaningful only when signed in and the Agent is the user's own
  // (owner) or one they've installed. Public, signed-out views hide the tab.
  const signedIn = hasLaunchAuthToken();
  const wiringRelevant = signedIn &&
    (tool.relationship === "owner" || tool.relationship === "installed");
  const pendingCount = live.data.agentWiring?.pendingRequests.length ?? 0;
  const headerSummary = tool.relationship === "owner" &&
      live.data.agentRoutine?.routine?.mission
    ? live.data.agentRoutine.routine.mission
    : tool.summary;

  // The Interface tab exists only when the facade reports renderable
  // interfaces (the feature kill switch): a stale ?tab=interface deep link
  // on an agent without any lands on Functions instead.
  const hasInterfaces = tool.interfaces.length > 0;
  const effectiveTab = tab === "interface" && !hasInterfaces
    ? "functions"
    : tab;

  const activateToolTab = (nextTab: AgentPageTabId) => {
    setTab(nextTab);
    syncSearchParams({ tab: nextTab === "overview" ? null : nextTab });
  };

  return (
    <div className="launch-page-narrow tool-page">
      <ApiNotice live={live} noun="Agent details" />

      {tool.visibility === "unlisted"
        ? (
          <div className="unlisted-banner">
            <Icon name="shield" size={13} />
            Unlisted — anyone with the link can view it; any signed-in Galactic
            user can call it.
          </div>
        )
        : null}

      <section className="public-tool-header">
        <div>
          <div className="tool-title-row">
            <h1>{tool.title}</h1>
          </div>
          <p>{headerSummary}</p>
          <div className="tool-header-actions">
            <AgentConnectButton
              agentInstall={live.data.install?.agentInstall}
              tool={tool}
            />
          </div>
        </div>
      </section>

      <div className="tool-tabs" role="tablist" aria-label="Agent page sections">
        <button
          className={effectiveTab === "overview" ? "active" : ""}
          onClick={() => {
            setFnMenuOpen(false);
            setIntMenuOpen(false);
            activateToolTab("overview");
          }}
          type="button"
        >
          Overview
          {wiringRelevant && pendingCount > 0
            ? <Pill tone="amber">{pendingCount}</Pill>
            : null}
        </button>
        <div className="tool-tab-menu" ref={fnMenuRef}>
          <button
            aria-expanded={effectiveTab === "functions" && fnMenuOpen}
            aria-haspopup="listbox"
            className={effectiveTab === "functions" ? "active" : ""}
            onClick={() => {
              setIntMenuOpen(false);
              if (effectiveTab !== "functions") {
                activateToolTab("functions");
                setFnMenuOpen(true);
              } else {
                setFnMenuOpen((open) => !open);
              }
            }}
            type="button"
          >
            <span>Functions</span>
            {tool.functions.length > 0
              ? (
                <span
                  aria-hidden="true"
                  className={effectiveTab === "functions" && fnMenuOpen
                    ? "picker-caret open"
                    : "picker-caret"}
                />
              )
              : null}
          </button>
          {effectiveTab === "functions" && fnMenuOpen && selectedFunction
            ? (
              <TabSelectMenu
                items={tool.functions.map((fn) => ({
                  id: fn.name,
                  label: (
                    <>
                      <Mono>{fn.name}</Mono>
                      <small>{fn.description}</small>
                    </>
                  ),
                  meta: (
                    <span className="function-menu-badges">
                      <span className={`function-badge ${fn.access}`}>
                        {fn.access === "read" ? "Read" : "Write"}
                      </span>
                      {fn.usesInference
                        ? <span className="function-badge ai">AI</span>
                        : null}
                    </span>
                  ),
                }))}
                onPick={(name) => {
                  setSelectedFunctionName(name);
                  setFnMenuOpen(false);
                }}
                selectedId={selectedFunction.name}
              />
            )
            : null}
        </div>
        {hasInterfaces
          ? (multiInterface
            ? (
              <div className="tool-tab-menu" ref={intMenuRef}>
                <button
                  aria-expanded={effectiveTab === "interface" && intMenuOpen}
                  aria-haspopup="listbox"
                  className={effectiveTab === "interface" ? "active" : ""}
                  onClick={() => {
                    setFnMenuOpen(false);
                    if (effectiveTab !== "interface") {
                      activateToolTab("interface");
                      setIntMenuOpen(true);
                    } else {
                      setIntMenuOpen((open) => !open);
                    }
                  }}
                  type="button"
                >
                  <span>Interfaces</span>
                  <span
                    aria-hidden="true"
                    className={effectiveTab === "interface" && intMenuOpen
                      ? "picker-caret open"
                      : "picker-caret"}
                  />
                </button>
                {effectiveTab === "interface" && intMenuOpen && selectedInterface
                  ? (
                    <TabSelectMenu
                      items={tool.interfaces.map((iface) => ({
                        id: iface.id,
                        label: iface.label,
                      }))}
                      onPick={(id) => {
                        setSelectedInterfaceId(id);
                        setIntMenuOpen(false);
                      }}
                      selectedId={selectedInterface.id}
                    />
                  )
                  : null}
              </div>
            )
            : (
              <button
                className={effectiveTab === "interface" ? "active" : ""}
                onClick={() => activateToolTab("interface")}
                type="button"
              >
                Interface
              </button>
            ))
          : null}
      </div>

      <div className="tool-detail-layout single">
        <main className="tool-main-panel">
          {effectiveTab === "functions"
            ? (
              <AgentFunctionsPanel
                live={live}
                selectedFunction={selectedFunction}
                tool={tool}
              />
            )
            : null}
          {effectiveTab === "interface" && hasInterfaces
            ? (
              <AgentInterfacePanel
                selected={selectedInterface}
                signedIn={signedIn}
                tool={tool}
              />
            )
            : null}
          {effectiveTab === "overview"
            ? (
              <AgentOverviewPanel
                live={live}
                tool={tool}
                wiringRelevant={wiringRelevant}
              />
            )
            : null}
        </main>
      </div>
    </div>
  );
}

function AgentFunctionsPanel({
  live,
  selectedFunction,
  tool,
}: {
  live: LaunchPageProps["live"];
  selectedFunction: AgentFunctionFixture | undefined;
  tool: AgentDetailFixture;
}): ReactElement {
  const [modal, setModal] = useState<null | "inference" | "settings">(null);
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

  const override = selectedFunction.inferenceOverride;
  // The model this function actually resolves to today (the fallback tree:
  // per-function override > the account's platform model > deepseek-v4).
  const inferenceSummary = override
    ? (override.billingMode === "byok"
      ? `${override.model} · ${override.provider} key`
      : override.model)
    : `${
      live.data.inferenceOptions?.platformModel || GALACTIC_DEFAULT_MODEL
    } (default)`;

  return (
    <div className="functions-panel">
      <FunctionSandboxCard fn={selectedFunction} live={live} tool={tool} />
      <Card className="function-settings-bar">
        {selectedFunction.usesInference
          ? (
            <div className="preference-row">
              <div>
                <strong>This function uses AI</strong>
                <span>Current model: {inferenceSummary}</span>
              </div>
              <Button
                onClick={() => setModal("inference")}
                size="sm"
                variant="secondary"
              >
                Choose model
              </Button>
            </div>
          )
          : null}
        <div className="preference-row">
          <div>
            <strong>Permissions &amp; wiring</strong>
            <span>Connected-agent permission and inbound / outbound calls.</span>
          </div>
          <Button
            onClick={() => setModal("settings")}
            size="sm"
            variant="secondary"
          >
            Configure
          </Button>
        </div>
      </Card>
      {modal === "inference"
        ? (
          <FunctionInferenceModal
            fn={selectedFunction}
            key={selectedFunction.name}
            live={live}
            onClose={() => setModal(null)}
            tool={tool}
          />
        )
        : null}
      {modal === "settings"
        ? (
          <FunctionSettingsModal
            fn={selectedFunction}
            live={live}
            onClose={() => setModal(null)}
            tool={tool}
          />
        )
        : null}
    </div>
  );
}

// The function list shown by the Functions tab dropdown. Outside-click / Escape
// closing is owned by the parent (AgentDetailSurface) so a click on the tab
// trigger toggles cleanly.
// Compact selector shared by the Functions and Interface tab dropdowns: a
// scannable list of names (the selected item's full detail lives in the panel
// below, so the menu stays tight instead of repeating every description).
function TabSelectMenu({
  items,
  onPick,
  selectedId,
}: {
  items: Array<{ id: string; label: ReactNode; meta?: ReactNode }>;
  onPick: (id: string) => void;
  selectedId: string;
}): ReactElement {
  return (
    <div className="tab-select-menu" role="listbox">
      {items.map((item) => {
        const active = item.id === selectedId;
        return (
          <button
            aria-selected={active}
            className={active ? "active" : ""}
            key={item.id}
            onClick={() => onPick(item.id)}
            role="option"
            type="button"
          >
            <span className="tab-select-check" aria-hidden="true">
              {active ? <Icon name="check" size={13} /> : null}
            </span>
            <span className="tab-select-label">{item.label}</span>
            {item.meta != null
              ? <span className="tab-select-meta">{item.meta}</span>
              : null}
          </button>
        );
      })}
    </div>
  );
}


// Interface selection now lives in the tab bar (the Interface tab is a dropdown
// when there's more than one), so the panel just renders the chosen surface.
function AgentInterfacePanel({
  selected,
  signedIn,
  tool,
}: {
  selected: LaunchInterfaceSummary | undefined;
  signedIn: boolean;
  tool: AgentDetailFixture;
}): ReactElement {
  if (!selected) {
    return (
      <div className="functions-panel">
        <EmptyState icon="grid" title="No interface available">
          This Agent has not published an interface.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="functions-panel">
      {/* key remounts the surface (iframe + bridge + spend) per interface. */}
      <InterfaceSurfaceCard
        iface={selected}
        key={selected.id}
        signedIn={signedIn}
        tool={tool}
      />
    </div>
  );
}

function InterfaceSurfaceCard({
  iface,
  signedIn,
  tool,
}: {
  iface: LaunchInterfaceSummary;
  signedIn: boolean;
  tool: AgentDetailFixture;
}): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [connected, setConnected] = useState(false);
  const [stalled, setStalled] = useState(false);
  // Bumped by the retry button: remounts the iframe and re-arms the bridge.
  const [reloadKey, setReloadKey] = useState(0);
  const [height, setHeight] = useState(() =>
    clampInterfaceHeight(iface.minHeight ?? 320)
  );
  const [spend, setSpend] = useState({ calls: 0, credits: 0 });
  // Focus mode dims the page behind and centers the interface. Implemented as
  // a class toggle on the SAME tree position: reparenting an iframe reloads
  // it, which would drop the bridge and the interface's in-memory state.
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocused(false);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [focused]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    return attachInterfaceBridge({
      iframe,
      context: {
        agent: { id: tool.id, slug: tool.slug, name: tool.title },
        interfaceId: iface.id,
        signedIn,
        minHeight: iface.minHeight ?? null,
      },
      allowlist: iface.functions,
      runFunction: async (functionName, args) => {
        try {
          const response = await launchApi.runAgentFunction(
            tool.id,
            functionName,
            { args },
          );
          return {
            success: response.success !== false && !response.error,
            result: response.result,
            receiptId: response.receiptId ?? null,
            error: response.error ?? null,
          };
        } catch (err) {
          if (err instanceof LaunchApiAuthenticationError) {
            return {
              success: false,
              error: {
                type: "SIGN_IN_REQUIRED",
                message: "Sign in on this page to use functions.",
              },
            };
          }
          return {
            success: false,
            error: {
              type: "RUN_FAILED",
              message: err instanceof Error
                ? err.message
                : "Function call failed.",
            },
          };
        }
      },
      onConnected: () => setConnected(true),
      onResize: setHeight,
      onCall: (functionName) => {
        const price =
          tool.functions.find((fn) => fn.name === functionName)?.price || 0;
        setSpend((prev) => ({
          calls: prev.calls + 1,
          credits: prev.credits + price,
        }));
      },
    });
    // tool.functions feeds only display pricing; identity churn on it must
    // not tear down a connected bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iface.id, iface.url, signedIn, reloadKey, tool.id]);

  // A bridge-less interface never says hello — surface that instead of an
  // indefinite spinner.
  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setStalled(true), 12_000);
    return () => clearTimeout(timer);
  }, [connected, reloadKey]);

  return (
    <div
      className={focused ? "interface-panel interface-focus" : "interface-panel"}
      onClick={(event) => {
        // Clicking the dimmed backdrop (the panel itself, not its children)
        // exits focus.
        if (focused && event.target === event.currentTarget) setFocused(false);
      }}
    >
      <div className="interface-stage">
        <iframe
          className="interface-frame"
          key={reloadKey}
          ref={iframeRef}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-forms"
          src={iface.url}
          style={{ height: `${height}px` }}
          title={`${tool.title} — ${iface.label}`}
        />
        <button
          aria-label={focused ? "Exit focus" : "Focus this interface"}
          className="interface-focus-btn"
          onClick={() => setFocused((value) => !value)}
          title={focused ? "Exit focus (Esc)" : "Focus"}
          type="button"
        >
          {focused
            ? (
              <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
              </svg>
            )
            : (
              <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
                <path d="M8.5 1H13v4.5M13 1L8 6M5.5 13H1V8.5M1 13l5-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
              </svg>
            )}
        </button>
      </div>
      <div className="interface-status">
        {!connected && !stalled ? <span>Loading interface…</span> : null}
        {!connected && stalled
          ? (
            <>
              <span>
                The interface has not connected — it may not include the
                Galactic bridge.
              </span>
              <button
                className="interface-reload"
                onClick={() => {
                  setStalled(false);
                  setReloadKey((key) => key + 1);
                }}
                type="button"
              >
                Reload
              </button>
            </>
          )
          : null}
        {connected && !signedIn && iface.functions.length > 0
          ? <span>Sign in to use this interface's functions.</span>
          : null}
        {connected && spend.calls > 0
          ? (
            <span>
              {spend.calls} call{spend.calls === 1 ? "" : "s"} ·{" "}
              {formatAgentPrice(spend.credits)} this session
            </span>
          )
          : null}
      </div>
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
            "Still running. The job continues server-side — check back or poll gx.job from your agent.",
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
          <strong className="fn-section-head">{fn.name}</strong>
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
    </Card>
  );
}

// Per-function galactic.ai() provider+model override. The viewer pins which
// provider (Galactic AI = credits, or one of their BYOK keys) and model this
// function's galactic.ai() calls use. Unset => the default fallback chain
// (dev per-call model > the viewer's global platform model > deepseek-v4).
function FunctionInferenceModal({
  fn,
  live,
  tool,
  onClose,
}: {
  fn: AgentFunctionFixture;
  live: LaunchPageProps["live"];
  tool: AgentDetailFixture;
  onClose: () => void;
}): ReactElement {
  const byokProviders =
    (live.data.byok ? live.data.byok.providers : byokProviderFixtures)
      .filter((option) => option.configured);
  const galacticDefault = live.data.inferenceOptions?.platformModel ||
    GALACTIC_DEFAULT_MODEL;
  const providerOptions = [
    { value: "galactic", label: "Galactic AI", defaultModel: galacticDefault },
    ...byokProviders.map((option) => ({
      value: option.id,
      label: option.name,
      defaultModel: option.model || option.defaultModel || "",
    })),
  ];
  const defaultModelFor = (value: string) =>
    providerOptions.find((option) => option.value === value)?.defaultModel ||
    galacticDefault;

  const initialProvider = fn.inferenceOverride
    ? (fn.inferenceOverride.billingMode === "byok"
      ? (fn.inferenceOverride.provider || "galactic")
      : "galactic")
    : "galactic";
  const [provider, setProvider] = useState(initialProvider);
  const [model, setModel] = useState(
    fn.inferenceOverride?.model || defaultModelFor(initialProvider),
  );
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  const save = async () => {
    if (state === "saving") return;
    if (!model.trim()) {
      setState("error");
      setMessage("Enter a model slug.");
      return;
    }
    setState("saving");
    setMessage("");
    try {
      await launchApi.updateAgentFunctionInference(tool.id, fn.name, {
        provider,
        model: model.trim(),
      });
      live.reload();
      onClose();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="settings-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <Card className="new-key-modal byok-key-modal">
        <div className="modal-title-row">
          <span className="target-icon">
            <Icon name="spark" />
          </span>
          <h2>AI model for this function</h2>
        </div>
        <p>
          Which provider and model this function's galactic.ai() calls use.
          Galactic AI bills credits; a BYOK provider uses your own key.
        </p>
        <form
          className="byok-modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            <span>provider</span>
            <select
              onChange={(event) => {
                const value = event.currentTarget.value;
                setProvider(value);
                setModel(defaultModelFor(value));
              }}
              value={provider}
            >
              {providerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>model</span>
            <input
              autoFocus
              onChange={(event) => setModel(event.currentTarget.value)}
              placeholder={defaultModelFor(provider)}
              value={model}
            />
          </label>
        </form>
        {message
          ? (
            <p
              className={state === "error"
                ? "settings-help error"
                : "settings-help"}
            >
              {message}
            </p>
          )
          : null}
        <div className="modal-actions byok-modal-actions">
          <div className="modal-actions-right">
            <Button onClick={onClose} size="sm" variant="secondary">
              Cancel
            </Button>
            <Button onClick={() => void save()} size="sm">
              {state === "saving" ? "Saving" : "Save model"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// All per-function permissions in one modal: the connected-agent permission
// (Always/Ask/Never) and the inbound/outbound wiring, so the function surface
// stays clean.
function FunctionSettingsModal({
  fn,
  live,
  tool,
  onClose,
}: {
  fn: AgentFunctionFixture;
  live: LaunchPageProps["live"];
  tool: AgentDetailFixture;
  onClose: () => void;
}): ReactElement {
  const [permission, setPermission] = useState(fn.permission);
  const [healthGate, setHealthGate] = useState(fn.healthGate);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const options = [
    ["always", "Always"],
    ["ask", "Ask"],
    ["never", "Never"],
  ] as const;

  // One unified save for the whole modal. The connected-agent permission is the
  // only draft state here (the wiring rows act immediately).
  const save = async () => {
    if (state === "saving") return;
    setState("saving");
    try {
      if (permission !== fn.permission || healthGate !== fn.healthGate) {
        await launchApi.updateAgentCallerPermissions(tool.id, {
          permissions: [{ functionName: fn.name, policy: permission, healthGate }],
        });
        live.reload();
      }
      onClose();
    } catch {
      setState("error");
    }
  };

  return (
    <div
      className="settings-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <Card className="new-key-modal function-settings-modal">
        <div className="modal-title-row">
          <span className="target-icon">
            <Icon name="shield" />
          </span>
          <h2>Permissions &amp; wiring</h2>
        </div>
        <div className="preference-row">
          <div>
            <strong>Connected agent permission</strong>
            <span>Default is ask. Manual website runs are separate.</span>
          </div>
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
        </div>
        {permission === "always"
          ? (
            <div className="preference-row">
              <div>
                <strong>Auto-allow only when healthy</strong>
                <span>
                  Unproven or recently failing Agents fall back to ask.
                </span>
              </div>
              <div className="mini-segments">
                <button
                  className={healthGate ? "active" : ""}
                  onClick={() => setHealthGate(true)}
                  type="button"
                >
                  On
                </button>
                <button
                  className={!healthGate ? "active" : ""}
                  onClick={() => setHealthGate(false)}
                  type="button"
                >
                  Off
                </button>
              </div>
            </div>
          )
          : null}
        <FunctionWiring fn={fn} live={live} />
        <div className="modal-actions byok-modal-actions">
          <div className="modal-actions-right">
            <Button onClick={onClose} size="sm" variant="secondary">
              Cancel
            </Button>
            <Button onClick={() => void save()} size="sm">
              {state === "saving"
                ? "Saving"
                : state === "error"
                ? "Retry"
                : "Save"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// Per-function slice of the agent's wiring, shown under the permission control:
// who may call THIS function (inbound, incl. pending approvals) and which
// functions fire when it runs (outbound). The Details tab keeps the full,
// agent-wide wiring view.
function FunctionWiring(
  { fn, live }: { fn: AgentFunctionFixture; live: LaunchPageProps["live"] },
): ReactElement | null {
  const [busyId, setBusyId] = useState<string | null>(null);
  const wiring = live.data.agentWiring;
  // Wiring is account-scoped; signed-out / non-owner views have no data here.
  if (!wiring) return null;

  const inboundActive = wiring.inboundGrants.filter(
    (grant) => grant.targetFunction === fn.name,
  );
  const inboundPending = wiring.pendingRequests.filter(
    (grant) => grant.targetFunction === fn.name,
  );
  const outbound = wiring.outboundGrants.filter(
    (grant) => grant.callerFunction === fn.name,
  );

  const act = async (grantId: string, run: () => Promise<unknown>) => {
    setBusyId(grantId);
    try {
      await run();
      live.reload();
    } catch {
      // Row stays so the action can be retried.
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Card className="function-wiring-card">
        <div className="function-wiring-col">
          <strong className="fn-section-head">
            Agents that can call this function
          </strong>
        {inboundPending.length === 0 && inboundActive.length === 0
          ? (
            <p className="muted-note">
              No other Agent is wired to call <Mono>{fn.name}</Mono> yet.
            </p>
          )
          : (
            <div className="wiring-row-list">
              {inboundPending.map((request) => (
                <div className="wiring-pending-row" key={request.id}>
                  <div className="wiring-pending-main">
                    <strong>
                      <Mono>{grantAppLabel(request.callerApp)}</Mono>
                      {" wants to call this"}
                    </strong>
                    <CallerTrustChip
                      trust={wiring.callerTrustByApp[request.callerApp.id] ??
                        null}
                    />
                  </div>
                  <div className="wiring-row-actions">
                    <Button
                      onClick={() =>
                        act(request.id, () =>
                          launchApi.approveGrant(request.id))}
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
              {inboundActive.map((grant) => (
                <GrantRow
                  direction="inbound"
                  grant={grant}
                  key={grant.id}
                  live={live}
                />
              ))}
            </div>
          )}
        </div>
      </Card>
      <Card className="function-wiring-card">
        <div className="function-wiring-col">
          <strong className="fn-section-head">
            Functions called when this runs
          </strong>
        {outbound.length === 0
          ? (
            <p className="muted-note">
              This function calls no other Agent directly yet.
            </p>
          )
          : (
            <div className="wiring-row-list">
              {outbound.map((grant) => (
                <GrantRow
                  direction="outbound"
                  grant={grant}
                  key={grant.id}
                  live={live}
                />
              ))}
            </div>
          )}
        <FunctionOutboundBind
          callerAppId={wiring.app.id}
          callerFunction={fn.name}
          live={live}
        />
        </div>
      </Card>
    </>
  );
}

// Per-function "wire a new outbound call": grants this function permission to
// call a target Agent's function (callerFunction-scoped grant). The server
// enforces the safety invariant — the user must be able to call the target.
function FunctionOutboundBind({
  callerAppId,
  callerFunction,
  live,
}: {
  callerAppId: string;
  callerFunction: string;
  live: LaunchPageProps["live"];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<AgentWiringTarget[]>([]);
  const [targetAppId, setTargetAppId] = useState("");
  const [targetFunction, setTargetFunction] = useState("");
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Targets are fetched lazily the first time the control is opened.
  useEffect(() => {
    if (!open || targets.length > 0) return;
    let cancelled = false;
    launchApi.wiringTargets()
      .then((response) => {
        if (!cancelled) setTargets(response.targets);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, targets.length]);

  // Don't offer to wire a function to itself.
  const eligibleTargets = targets.filter((entry) => entry.app.id !== callerAppId);
  const selectedTarget = eligibleTargets.find((t) => t.app.id === targetAppId);

  const bind = async () => {
    if (!targetAppId || !targetFunction) return;
    setBinding(true);
    setError(null);
    try {
      await launchApi.createGrant({
        callerAppId,
        targetAppId,
        targetFunction,
        callerFunction,
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
        Add outbound call
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
      {error ? <p className="api-notice warning">{error}</p> : null}
      <div className="wiring-row-actions">
        <Button onClick={bind} size="sm">
          {binding ? "Wiring" : "Wire call"}
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
            ? `${formatCredits(grant.spentCreditsPeriod)} / ${
              formatCredits(grant.monthlyCapCredits)
            } credits this month`
            : `${formatCredits(grant.spentCreditsPeriod)} credits spent · uncapped`}
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
        placeholder={`uncapped (default ${
          formatCredits(DEFAULT_GRANT_MONTHLY_CAP_CREDITS)
        } credits)`}
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

// Phase 4: the "Capabilities & connections" card on the details tab. Renders the
// outbound destinations, the per-user secrets bound to each (as write-only secure
// inputs with the enforced "only sent to X" assurance), and the unbound general
// settings. Values are never rendered back — only connected status.
function AgentConnectionsCard(
  { tool }: { tool: AgentDetailFixture },
): ReactElement | null {
  const disclosure = tool.networkDisclosure;
  const destinations = disclosure?.destinations ?? [];
  const general = disclosure?.general_settings ?? [];
  const hasInputs = destinations.some((d) => d.credentials.length > 0) ||
    general.length > 0;
  const hasAnything = destinations.length > 0 || general.length > 0 ||
    tool.capabilities.length > 0;

  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<
    "idle" | "loading" | "saving" | "locked"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!hasInputs) return;
    let cancelled = false;
    setStatus("loading");
    launchApi.agentSettings(tool.id)
      .then((res) => {
        if (cancelled) return;
        setConnected(new Set(res.connected_keys));
        setStatus("idle");
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus("locked");
        setMessage(
          err instanceof LaunchApiAuthenticationError
            ? "Sign in and install this Agent to connect your own keys."
            : "Install this Agent to connect your own keys.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [tool.id, hasInputs]);

  if (!hasAnything) {
    return tool.relationship === "owner"
      ? (
        <Card>
          <p className="section-label">Data sources &amp; secrets</p>
          <p className="muted-note">
            No data sources or secrets are declared yet. Ask your connected
            coding agent to declare the required settings in the Agent, then
            enter their values here.
          </p>
        </Card>
      )
      : null;
  }

  const noPending = Object.values(values).every((v) => v.trim().length === 0);

  const onSave = async () => {
    const pending = Object.entries(values).filter(([, v]) =>
      v.trim().length > 0
    );
    if (pending.length === 0) return;
    setStatus("saving");
    setMessage(null);
    try {
      const res = await launchApi.updateAgentSettings(
        tool.id,
        Object.fromEntries(pending),
      );
      setConnected(new Set(res.connected_keys));
      setValues({});
      setStatus("idle");
      setMessage("Saved.");
    } catch (err) {
      setStatus("idle");
      setMessage(
        err instanceof LaunchApiRequestError ? err.message : "Could not save.",
      );
    }
  };

  const field = (
    key: string,
    label: string,
    required: boolean,
    opts: { secret: boolean; host?: string | null; note?: string | null },
  ): ReactElement => {
    const isSet = connected.has(key);
    const disabled = status === "locked" || status === "saving";
    return (
      <div className="connection-field" key={key}>
        <label>
          <span>
            {required
              ? (
                <span aria-label="required" className="connection-req-star">
                  *
                </span>
              )
              : null}
            {label}
          </span>
        </label>
        <div className="connection-input-wrap">
          <input
            type={opts.secret ? "password" : "text"}
            autoComplete="off"
            placeholder={opts.secret && isSet ? "••••••••" : opts.note ?? ""}
            value={values[key] ?? ""}
            disabled={disabled}
            onChange={(event) =>
              setValues((prev) => ({ ...prev, [key]: event.target.value }))}
          />
          {isSet
            ? (
              <span
                className="connection-setmark"
                title={(opts.secret ? "Connected" : "Configured") +
                  " — type to replace"}
              >
                ✓
              </span>
            )
            : null}
        </div>
        {opts.host
          ? (
            <p className="connection-note">
              Only ever sent to <Mono>{opts.host}</Mono>.
            </p>
          )
          : null}
      </div>
    );
  };

  return (
    <Card>
      <p className="section-label">Data sources &amp; secrets</p>
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
        : null}

      {destinations.map((dest) => (
        <div className="connection-dest" key={dest.host}>
          <div className="connection-dest-head">
            <Mono>{dest.host}</Mono>
            {dest.label ? <strong>{dest.label}</strong> : null}
            {dest.credentials.length === 0
              ? <span className="connection-transparent">no credentials sent</span>
              : null}
          </div>
          {dest.description
            ? <p className="connection-note">{dest.description}</p>
            : null}
          {dest.credentials.map((cred) =>
            field(cred.key, cred.label, cred.required, {
              secret: true,
              host: dest.host,
            })
          )}
        </div>
      ))}

      {general.length > 0
        ? (
          <div className="connection-general">
            <p className="connection-sublabel">App settings</p>
            {general.map((setting) =>
              field(setting.key, setting.label, setting.required, {
                secret: setting.secret,
                note: setting.description,
              })
            )}
          </div>
        )
        : null}

      {hasInputs
        ? (
          <div className="connection-actions">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={status === "locked" || status === "saving" || noPending}
            >
              {status === "saving" ? "Saving…" : "Save"}
            </button>
            {message
              ? <span className="connection-message">{message}</span>
              : null}
          </div>
        )
        : null}
    </Card>
  );
}

interface AgentRoutineDraft {
  name: string;
  mission: string;
  cadenceMinutes: string;
  maxLightPerRun: string;
  maxLightPerDay: string;
  maxLightPerMonth: string;
  maxCallsPerRun: string;
}

function agentRoutineDraft(
  tool: AgentDetailFixture,
  routine: LaunchAgentRoutineOverview | null | undefined,
): AgentRoutineDraft {
  return {
    name: tool.name,
    mission: routine?.mission ?? "",
    cadenceMinutes: routine ? String(routine.intervalSeconds / 60) : "",
    maxLightPerRun: routine ? String(routine.budgets.maxLightPerRun) : "",
    maxLightPerDay: routine ? String(routine.budgets.maxLightPerDay) : "",
    maxLightPerMonth: routine ? String(routine.budgets.maxLightPerMonth) : "",
    maxCallsPerRun: routine ? String(routine.budgets.maxCallsPerRun) : "",
  };
}

function humanizeRoutineValue(value: string): string {
  return value.replaceAll("_", " ");
}

function routineStatusTone(
  value: LaunchAgentRoutineOverview["status"] | LaunchAgentRoutineOverview["health"],
): "default" | "green" | "amber" | "red" {
  if (value === "active") return "green";
  if (value === "error") return "red";
  if (value === "needs_approval" || value === "paused") return "amber";
  return "default";
}

function AgentOverviewPanel({
  live,
  tool,
  wiringRelevant,
}: {
  live: LaunchPageProps["live"];
  tool: AgentDetailFixture;
  wiringRelevant: boolean;
}): ReactElement {
  const isOwner = tool.relationship === "owner";
  const [routineResponse, setRoutineResponse] = useState<
    LaunchAgentRoutineResponse | undefined
  >(live.data.agentRoutine);
  const routine = routineResponse?.routine;
  const [draft, setDraft] = useState<AgentRoutineDraft>(() =>
    agentRoutineDraft(tool, routine)
  );
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<LaunchAgentRoutineAction | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setRoutineResponse(live.data.agentRoutine);
    setDraft(agentRoutineDraft(tool, live.data.agentRoutine?.routine));
    setSaveState("idle");
    setSaveError(null);
    setActionState(null);
    setActionError(null);
  }, [tool.id, tool.name, live.data.agentRoutine?.generatedAt]);

  const parsedCadenceSeconds = Math.round(Number(draft.cadenceMinutes) * 60);
  const routineDirty = routine !== null && routine !== undefined && (
    draft.mission.trim() !== routine.mission ||
    draft.cadenceMinutes !== String(routine.intervalSeconds / 60) ||
    draft.maxLightPerRun !== String(routine.budgets.maxLightPerRun) ||
    draft.maxLightPerDay !== String(routine.budgets.maxLightPerDay) ||
    draft.maxLightPerMonth !== String(routine.budgets.maxLightPerMonth) ||
    draft.maxCallsPerRun !== String(routine.budgets.maxCallsPerRun)
  );
  const dirty = draft.name.trim() !== tool.name || routineDirty;
  const save = async () => {
    if (!isOwner || !dirty || saveState === "saving") return;
    setSaveState("saving");
    setSaveError(null);
    try {
      if (routineDirty && routine) {
        const numericValues = [
          parsedCadenceSeconds,
          Number(draft.maxLightPerRun),
          Number(draft.maxLightPerDay),
          Number(draft.maxLightPerMonth),
          Number(draft.maxCallsPerRun),
        ];
        if (numericValues.some((value) => !Number.isFinite(value))) {
          throw new Error("Cadence and budget ceilings must be numbers.");
        }
        const updated = await launchApi.updateAgentRoutine(tool.id, {
          mission: draft.mission.trim() || null,
          intervalSeconds: parsedCadenceSeconds,
          budgets: {
            maxLightPerRun: Number(draft.maxLightPerRun),
            maxLightPerDay: Number(draft.maxLightPerDay),
            maxLightPerMonth: Number(draft.maxLightPerMonth),
            maxCallsPerRun: Number(draft.maxCallsPerRun),
          },
        });
        setRoutineResponse(updated);
        setDraft((current) => ({
          ...agentRoutineDraft(tool, updated.routine),
          name: current.name,
        }));
      }
      if (draft.name.trim() !== tool.name) {
        await launchApi.updateAgent(tool.id, { name: draft.name.trim() });
      }
      setSaveState("saved");
      live.reload();
    } catch (err) {
      setSaveState("error");
      setSaveError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't save changes. Please try again.",
      );
    }
  };

  const runAction = async (
    action: LaunchAgentRoutineAction,
    capabilityIds?: string[],
  ) => {
    if (actionState) return;
    if (dirty) {
      setActionError("Save your configuration changes before changing runtime state.");
      return;
    }
    setActionState(action);
    setActionError(null);
    try {
      const updated = await launchApi.actOnAgentRoutine(tool.id, {
        action,
        ...(capabilityIds ? { capabilityIds } : {}),
      });
      setRoutineResponse(updated);
      setDraft(agentRoutineDraft(tool, updated.routine));
      live.reload();
    } catch (err) {
      setActionError(
        err instanceof Error && err.message
          ? err.message
          : "The routine action could not be completed.",
      );
    } finally {
      setActionState(null);
    }
  };

  const accessLabel = tool.visibility === "private"
    ? "Only you"
    : tool.visibility === "unlisted"
    ? "Link-accessible"
    : "Public";
  const accessCopy = tool.visibility === "private"
    ? "Reach this Agent from any MCP client using your Galactic keys."
    : tool.visibility === "unlisted"
    ? "Anyone with the link can view it; any signed-in Galactic user can call its functions."
    : "Anyone can view it; any signed-in Galactic user can call its functions.";

  return (
    <div className="details-panel agent-overview-panel">
      {isOwner
        ? (
          <Card className="agent-overview-editor">
            <div className="agent-overview-card-head">
              <div>
                <p className="section-label">Overview</p>
                <p className="muted-note">
                  The Agent's identity and owner-approved ongoing responsibility.
                </p>
              </div>
              <Button
                disabled={!dirty || saveState === "saving"}
                onClick={() => void save()}
                size="sm"
              >
                {saveState === "saving"
                  ? "Saving…"
                  : saveState === "saved" && !dirty
                  ? "Saved"
                  : "Save changes"}
              </Button>
            </div>
            <AdminField label="Name">
              <input
                className="admin-input"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))}
                value={draft.name}
              />
            </AdminField>
            {routine
              ? (
                <>
                  <AdminField label="Mission">
                    <textarea
                      className="admin-textarea"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          mission: event.target.value,
                        }))}
                      rows={4}
                      value={draft.mission}
                    />
                  </AdminField>
                  <div className="routine-config-grid">
                    <AdminField label="Cadence (minutes)">
                      <input
                        className="admin-input"
                        min="1"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            cadenceMinutes: event.target.value,
                          }))}
                        step="1"
                        type="number"
                        value={draft.cadenceMinutes}
                      />
                    </AdminField>
                    <div className="routine-readonly-field">
                      <span>Reporting destination</span>
                      <strong>{routine.reportingDestination.label}</strong>
                    </div>
                  </div>
                  <div>
                    <p className="section-label routine-budget-label">
                      Hard cost / rate ceilings
                    </p>
                    <div className="routine-budget-grid">
                      {([
                        ["maxLightPerRun", "Light / run"],
                        ["maxLightPerDay", "Light / day"],
                        ["maxLightPerMonth", "Light / month"],
                        ["maxCallsPerRun", "Calls / run"],
                      ] as const).map(([key, label]) => (
                        <AdminField key={key} label={label}>
                          <input
                            className="admin-input"
                            min={key === "maxCallsPerRun" ? "1" : "0"}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                [key]: event.target.value,
                              }))}
                            step={key === "maxCallsPerRun" ? "1" : "any"}
                            type="number"
                            value={draft[key]}
                          />
                        </AdminField>
                      ))}
                    </div>
                    <p className="muted-note routine-budget-note">
                      Reserved before each paid action. Manual runs count too.
                    </p>
                  </div>
                </>
              )
              : null}
            {saveState === "error" && saveError
              ? <p className="agent-overview-error">{saveError}</p>
              : null}
          </Card>
        )
        : (
          <Card>
            <p className="section-label">Mission</p>
            <p className="agent-overview-mission">{tool.summary}</p>
          </Card>
        )}

      <Card className="agent-access-card">
        <div>
          <p className="section-label">Access</p>
          <strong>{accessLabel}</strong>
          <p>{accessCopy}</p>
        </div>
        <Pill tone={tool.visibility === "private" ? "green" : "amber"}>
          {tool.visibility}
        </Pill>
      </Card>

      {isOwner
        ? routine
          ? (
            <Card className="routine-operations-card">
              <div className="routine-operation-head">
                <div>
                  <p className="section-label">Persistent routine</p>
                  <div className="routine-state-pills">
                    <Pill tone={routineStatusTone(routine.status)}>
                      {humanizeRoutineValue(routine.status)}
                    </Pill>
                    <Pill tone={routineStatusTone(routine.health)}>
                      {humanizeRoutineValue(routine.health)}
                    </Pill>
                  </div>
                </div>
                <div className="routine-actions">
                  {routine.status === "active"
                    ? (
                      <Button
                        disabled={Boolean(actionState) || dirty}
                        onClick={() => void runAction("pause")}
                        size="sm"
                        variant="secondary"
                      >
                        {actionState === "pause" ? "Pausing…" : "Pause"}
                      </Button>
                    )
                    : (
                      <Button
                        disabled={!routine.actions.canActivate || Boolean(actionState) || dirty}
                        onClick={() => void runAction("activate")}
                        size="sm"
                      >
                        {actionState === "activate" ? "Activating…" : "Activate"}
                      </Button>
                    )}
                  <Button
                    disabled={!routine.actions.canRunNow || Boolean(actionState) || dirty}
                    onClick={() => void runAction("run_now")}
                    size="sm"
                    variant="secondary"
                  >
                    {actionState === "run_now" ? "Queuing…" : "Run now"}
                  </Button>
                </div>
              </div>

              <div className="routine-timing-grid">
                <MetaPair
                  label="next wake"
                  value={routine.nextRunAt
                    ? relativeTime(routine.nextRunAt) || routine.nextRunAt
                    : "not scheduled"}
                />
                <MetaPair
                  label="last wake"
                  value={routine.lastRunAt
                    ? relativeTime(routine.lastRunAt) || routine.lastRunAt
                    : "not run yet"}
                />
                <MetaPair
                  label="failures"
                  value={String(routine.failureCount)}
                />
              </div>

              {routine.autoPauseReason || routine.errorReason
                ? (
                  <div className="routine-stop-reason">
                    <strong>Needs attention</strong>
                    <span>
                      {humanizeRoutineValue(
                        routine.autoPauseReason || routine.errorReason || "routine error",
                      )}
                    </span>
                  </div>
                )
                : null}

              {routine.blockers.length > 0
                ? (
                  <div className="routine-blockers">
                    <p className="section-label">Activation blockers</p>
                    {routine.blockers.map((blocker) => (
                      <div key={`${blocker.code}-${blocker.message}`}>
                        <Mono>{humanizeRoutineValue(blocker.code)}</Mono>
                        <span>{blocker.message}</span>
                      </div>
                    ))}
                  </div>
                )
                : null}

              <div className="routine-capability-section">
                <p className="section-label">Allowed actions</p>
                {routine.capabilities.length === 0
                  ? (
                    <p className="muted-note">
                      This routine requests no downstream Agent functions.
                    </p>
                  )
                  : (
                    <div className="routine-capability-list">
                      {routine.capabilities.map((capability) => (
                        <div className="routine-capability-row" key={capability.id}>
                          <div>
                            <Mono>
                              {capability.appRef}.{capability.functionName}
                            </Mono>
                            {capability.purpose
                              ? <span>{capability.purpose}</span>
                              : null}
                          </div>
                          <div className="routine-capability-state">
                            <Pill tone={capability.access === "write" ? "amber" : "default"}>
                              {capability.access}
                            </Pill>
                            <Pill tone={capability.approved ? "green" : "amber"}>
                              {capability.approved ? "approved" : "pending"}
                            </Pill>
                            {!capability.approved
                              ? (
                                <Button
                                  disabled={Boolean(actionState) || dirty}
                                  onClick={() =>
                                    void runAction("approve_capabilities", [capability.id])}
                                  size="sm"
                                  variant="secondary"
                                >
                                  Approve
                                </Button>
                              )
                              : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
              {actionError
                ? <p className="agent-overview-error">{actionError}</p>
                : null}
            </Card>
          )
          : routineResponse
          ? (
            <Card>
              <EmptyState icon="spark" title="No routine proposal yet">
                This Agent is private, but it has no stored ongoing job. Ask
                your connected coding agent to scaffold with gx.download
                (full_time: true), test it, and upload the proposal for review.
              </EmptyState>
            </Card>
          )
          : (
            <Card>
              <p className="section-label">Persistent routine</p>
              <p className="muted-note">
                {tool.visibility !== "private"
                  ? "Persistent routines are launch-scoped to private, owner-only Agents."
                  : "Routine state is unavailable. Refresh the page or reconnect your account session."}
              </p>
            </Card>
          )
        : tool.fullTime
        ? <FullTimeDisclosureCard fullTime={tool.fullTime} />
        : (
          <Card>
            <p className="section-label">Cadence</p>
            <p className="muted-note">
              This Agent does not currently declare an autonomous routine.
            </p>
          </Card>
        )}

      <AgentConnectionsCard tool={tool} />

      {wiringRelevant
        ? <AgentWiringPanel live={live} tool={tool} />
        : null}

      {isOwner
        ? (
          <Card className="agent-logs-card">
            <p className="section-label">Logs</p>
            {routine && routine.recentRuns.length > 0
              ? (
                <div className="routine-run-list">
                  {routine.recentRuns.map((run) => (
                    <div className="routine-run-row" key={run.id}>
                      <div>
                        <Pill tone={run.status === "succeeded"
                          ? "green"
                          : run.status === "failed"
                          ? "red"
                          : run.status === "skipped"
                          ? "amber"
                          : "default"}
                        >
                          {run.status}
                        </Pill>
                        <Mono>{relativeTime(run.createdAt) || run.createdAt}</Mono>
                      </div>
                      <span>
                        {run.summary || (run.errorCode
                          ? humanizeRoutineValue(run.errorCode)
                          : `${humanizeRoutineValue(run.trigger)} run`)}
                      </span>
                      <Mono>{formatNumber(run.totalLight)} Light</Mono>
                    </div>
                  ))}
                </div>
              )
              : (
                <p>
                  {routine
                    ? "No wakes have been recorded yet."
                    : "Run history appears after a routine proposal is stored."}
                </p>
              )}
          </Card>
        )
        : null}

      <div className="works-with">
        <p className="section-label">Connect from anywhere</p>
        <div>
          {["Claude Code", "Cursor", "Codex", "MCP", "CLI", "API"].map((
            label,
          ) => <span key={label}>{label}</span>)}
        </div>
      </div>
    </div>
  );
}

// Viewer-facing disclosure that an Agent runs autonomously (full-time). Purely
// informational — what it does on its own, from its manifest routine
// declaration. Owners activate/manage it in the routine monitor, not here.
function FullTimeDisclosureCard(
  { fullTime }: { fullTime: LaunchFullTimeDisclosure },
): ReactElement {
  const light = (n: number | null): string | null =>
    n === null ? null : `${formatNumber(n)} Light`;
  const budgetParts = [
    light(fullTime.budget.perRunLight) &&
    `${light(fullTime.budget.perRunLight)}/run`,
    light(fullTime.budget.perDayLight) &&
    `${light(fullTime.budget.perDayLight)}/day`,
    light(fullTime.budget.perMonthLight) &&
    `${light(fullTime.budget.perMonthLight)}/month`,
  ].filter((part): part is string => Boolean(part));

  return (
    <Card className="fulltime-card">
      <div className="fulltime-head">
        <Icon name="spark" />
        <div>
          <h3>Full-time agent</h3>
          <p>
            {fullTime.description ||
              "Runs on its own, on a schedule, without being prompted."}
          </p>
        </div>
      </div>
      <div className="trust-meta">
        {fullTime.scheduleSummary
          ? <MetaPair label="runs" value={fullTime.scheduleSummary} />
          : null}
        {budgetParts.length > 0
          ? <MetaPair label="budget" value={budgetParts.join(" · ")} />
          : null}
        <MetaPair
          label="reasoning"
          value={fullTime.recordsReasoning ? "recorded" : "not recorded"}
        />
      </div>
      {fullTime.capabilities.length > 0
        ? (
          <div className="fulltime-caps">
            <p className="section-label">Uses on its own</p>
            <div className="fulltime-cap-list">
              {fullTime.capabilities.map((cap, i) => (
                <span
                  key={`${cap.appRef ?? "app"}-${cap.functionName ?? i}`}
                  className="fulltime-cap"
                >
                  <Mono>
                    {cap.appRef ?? "?"}
                    {cap.functionName ? `.${cap.functionName}` : ""}
                  </Mono>
                  {cap.access === "write"
                    ? <span className="fulltime-cap-write">write</span>
                    : null}
                </span>
              ))}
            </div>
          </div>
        )
        : null}
      <p className="fulltime-note">
        The owner controls whether it's active, its goal, and its budget.
      </p>
    </Card>
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
          <RouteButton navigate={navigate} size="lg" to="/agents">
            Back to Agents
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
  { live, navigate }: LaunchPageProps,
): ReactElement {
  const [busy, setBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [folderMenuFor, setFolderMenuFor] = useState<string | null>(null);
  const loading = live.status !== "ready" && live.status !== "error";

  // Close any open card / folder menu on an outside click or Escape.
  useEffect(() => {
    if (!menuFor && !folderMenuFor) return;
    const close = () => {
      setMenuFor(null);
      setFolderMenuFor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor, folderMenuFor]);

  const scope: LibraryView = "owned";
  const library = live.data.library;
  const rawAgents = library?.owned ?? [];
  const folders = library?.folders?.owned ?? [];

  const runFolderOp = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setFolderError(null);
    try {
      await fn();
      live.reload();
    } catch (err) {
      setFolderError(
        err instanceof Error ? err.message : "Something went wrong",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCreateFolderAndMove = (appId: string) => {
    const name = window.prompt("New folder name")?.trim();
    if (!name) return;
    void runFolderOp(async () => {
      const created = await launchApi.createFolder(scope, name);
      const newId = created?.folder?.id;
      if (newId) await launchApi.setAgentFolder(scope, appId, newId);
    });
  };
  const handleRenameFolder = (id: string, current: string) => {
    const name = window.prompt("Rename folder", current)?.trim();
    if (name && name !== current) {
      void runFolderOp(() => launchApi.renameFolder(id, name));
    }
  };
  const handleDeleteFolder = (id: string, name: string) => {
    if (
      window.confirm(
        `Delete the folder “${name}”? Its Agents move back to Uncategorized.`,
      )
    ) {
      void runFolderOp(() => launchApi.deleteFolder(id));
    }
  };
  const handleMoveAgent = (appId: string, folderId: string | null) => {
    void runFolderOp(() => launchApi.setAgentFolder(scope, appId, folderId));
  };

  // Group the tab's Agents by folder. folderId comes from the raw library data
  // (liveAgentFixture drops it). An Agent with no folder — or whose folder no
  // longer exists — falls into "Uncategorized".
  const folderIds = new Set(folders.map((folder) => folder.id));
  const byFolder = new Map<string, LaunchAgentSummary[]>();
  const uncategorized: LaunchAgentSummary[] = [];
  for (const agent of rawAgents) {
    const fid = agent.folderId && folderIds.has(agent.folderId)
      ? agent.folderId
      : null;
    if (fid) {
      byFolder.set(fid, [...(byFolder.get(fid) ?? []), agent]);
    } else {
      uncategorized.push(agent);
    }
  }
  const hasAny = rawAgents.length > 0 || folders.length > 0;

  const renderCard = (agent: LaunchAgentSummary) => {
    const fixture = liveAgentFixture(agent);
    const currentFolderId = agent.folderId && folderIds.has(agent.folderId)
      ? agent.folderId
      : null;
    const menuOpen = menuFor === agent.id;
    const agentPath = `/agents/${fixture.slug}`;
    return (
      <div className="library-card" key={agent.id}>
        <a
          aria-label={`Open ${fixture.title}`}
          className="library-card-clickable"
          href={agentPath}
          onClick={(event) => {
            if (
              event.button === 0 && !event.metaKey && !event.ctrlKey &&
              !event.shiftKey && !event.altKey
            ) {
              event.preventDefault();
              navigate(agentPath);
            }
          }}
        >
          <OwnedAgentCard tool={fixture} />
        </a>
        {hasLaunchAuthToken()
          ? (
            <div
              className="library-card-menu"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label="Folder options"
                className="library-card-menu-trigger"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuFor(menuOpen ? null : agent.id);
                }}
                type="button"
              >
                <svg
                  aria-hidden="true"
                  fill="currentColor"
                  height="16"
                  viewBox="0 0 24 24"
                  width="16"
                >
                  <circle cx="12" cy="5" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="12" cy="19" r="1.8" />
                </svg>
              </button>
              {menuOpen
                ? (
                  <div className="library-card-menu-popover" role="menu">
                    {folders.length > 0
                      ? (
                        <p className="library-card-menu-label">
                          Folder
                        </p>
                      )
                      : null}
                    {folders.map((folder) => (
                      <button
                        className={folder.id === currentFolderId
                          ? "library-card-menu-item is-current"
                          : "library-card-menu-item"}
                        key={folder.id}
                        onClick={() => {
                          setMenuFor(null);
                          if (folder.id !== currentFolderId) {
                            handleMoveAgent(agent.id, folder.id);
                          }
                        }}
                        role="menuitem"
                        type="button"
                      >
                        {folder.name}
                      </button>
                    ))}
                    {currentFolderId
                      ? (
                        <button
                          className="library-card-menu-item library-card-menu-danger"
                          onClick={() => {
                            setMenuFor(null);
                            handleMoveAgent(agent.id, null);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          Remove
                        </button>
                      )
                      : null}
                    {folders.length > 0
                      ? <div className="library-card-menu-sep" />
                      : null}
                    <button
                      className="library-card-menu-item library-card-menu-new"
                      onClick={() => {
                        setMenuFor(null);
                        handleCreateFolderAndMove(agent.id);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      + New folder…
                    </button>
                  </div>
                )
                : null}
            </div>
          )
          : null}
      </div>
    );
  };

  const renderSection = (
    key: string,
    title: string,
    agents: LaunchAgentSummary[],
    folder?: LaunchFolder,
  ) => (
    <section className="library-folder-section" key={key}>
      <div className="library-folder-header">
        <h3>{title}</h3>
        <span className="library-folder-count">{agents.length}</span>
        {folder
          ? (
            <div
              className="library-folder-menu"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                aria-expanded={folderMenuFor === folder.id}
                aria-haspopup="menu"
                aria-label="Folder actions"
                className="library-card-menu-trigger"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  setFolderMenuFor(
                    folderMenuFor === folder.id ? null : folder.id,
                  );
                }}
                type="button"
              >
                <svg
                  aria-hidden="true"
                  fill="currentColor"
                  height="16"
                  viewBox="0 0 24 24"
                  width="16"
                >
                  <circle cx="12" cy="5" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="12" cy="19" r="1.8" />
                </svg>
              </button>
              {folderMenuFor === folder.id
                ? (
                  <div className="library-card-menu-popover" role="menu">
                    <button
                      className="library-card-menu-item"
                      onClick={() => {
                        setFolderMenuFor(null);
                        handleRenameFolder(folder.id, folder.name);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      Rename
                    </button>
                    <button
                      className="library-card-menu-item library-card-menu-danger"
                      onClick={() => {
                        setFolderMenuFor(null);
                        handleDeleteFolder(folder.id, folder.name);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                )
                : null}
            </div>
          )
          : null}
      </div>
      {agents.length > 0
        ? <div className="library-installed-grid">{agents.map(renderCard)}</div>
        : <p className="library-folder-empty">No Agents in this folder yet.</p>}
    </section>
  );

  return (
    <div className="launch-page-narrow library-page">
      <ApiNotice live={live} noun="Agents" />

      {folderError
        ? <p className="library-folder-error" role="alert">{folderError}</p>
        : null}

      {hasAny
        ? (
          <div className="library-folders">
            {folders.map((folder) =>
              renderSection(
                folder.id,
                folder.name,
                byFolder.get(folder.id) ?? [],
                folder,
              )
            )}
            {renderSection(
              "__uncategorized",
              "Your Agents",
              uncategorized,
            )}
          </div>
        )
        : loading
        ? null
        : hasLaunchAuthToken()
        ? (
          <EmptyState icon="grid" title="No Agents yet">
            Ask your connected coding agent to build and upload one. It will
            appear here with its persistent home.
          </EmptyState>
        )
        : (
          <EmptyState icon="key" title="Sign in to load your library">
            The live library endpoint needs an account session before it can show
            your Agents.
          </EmptyState>
        )}

      {loading && !hasAny
        ? (
          <div className="library-empty-grid">
            <LibraryEmptyCard
              body="Ask your connected coding agent to scaffold, test, and upload your first persistent Agent."
              title="Your Agents"
            />
          </div>
        )
        : null}
    </div>
  );
}

export function AdminFoundationPage(
  { navigate, route }: LaunchPageProps,
): ReactElement {
  // Manage/Edit is now the canonical Agent Overview. Redirect by the route
  // handle itself so legacy links do not need to load the retired admin shell
  // (or an authenticated admin payload) before reaching the Agent home.
  const agentHandle = route.params.id;
  useEffect(() => {
    if (agentHandle) navigate(`/agents/${encodeURIComponent(agentHandle)}`);
  }, [agentHandle, navigate]);

  return (
    <div className="launch-page-narrow admin-page">
      <p className="muted-note">Opening Agent Overview…</p>
    </div>
  );
}

// The publisher's referral link for this Agent. Customers who arrive through
// it are permanently attributed to the publisher — platform fees on their
// usage are waived, and the waived total drives the Browse Top charts.
function ReferralLinkCard({
  referral,
}: {
  referral: { url: string; slug: string; status: "active" | "disabled" };
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(referral.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return (
    <Card className="referral-card">
      <div className="referral-card-main">
        <p className="section-label">Referral link</p>
        <p className="referral-blurb">
          Share this link in your marketing. Customers who sign up through it
          are attributed to you — platform fees on their usage of your Agents
          are waived, and the waived total powers the Browse Top charts.
        </p>
        <Mono>{referral.url}</Mono>
      </div>
      <Button
        icon={copied ? "check" : "copy"}
        onClick={copy}
        size="sm"
        variant="secondary"
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
    </Card>
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
  const [name, setName] = useState(tool.name);
  const [description, setDescription] = useState(tool.summary);
  const [category, setCategory] = useState(tool.category);
  const [visibility, setVisibility] = useState<AgentDetailFixture["visibility"]>(
    tool.visibility,
  );
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setTab(adminTabFromSearch());
  }, [locationSearch, routeId]);
  // Re-seed the form when switching to a different Agent (or after a reload
  // brings fresh values).
  useEffect(() => {
    setName(tool.name);
    setDescription(tool.summary);
    setCategory(tool.category);
    setVisibility(tool.visibility);
    setSaveState("idle");
  }, [tool.id]);

  const dirty = name !== tool.name || description !== tool.summary ||
    category !== tool.category || visibility !== tool.visibility;

  const save = async () => {
    if (!dirty || saveState === "saving") return;
    // Only send the fields the user actually changed.
    const fields: {
      name?: string;
      description?: string;
      visibility?: AgentDetailFixture["visibility"];
      category?: string;
    } = {};
    if (name.trim() !== tool.name) fields.name = name.trim();
    if (description.trim() !== tool.summary) {
      fields.description = description.trim();
    }
    if (category.trim() !== tool.category) fields.category = category.trim();
    if (visibility !== tool.visibility) fields.visibility = visibility;

    setSaveState("saving");
    setSaveError(null);
    try {
      await launchApi.updateAgent(tool.id, fields);
      setSaveState("saved");
      live.reload();
    } catch (err) {
      setSaveState("error");
      // Surface the server's message — notably the publish gate's
      // "set up Stripe Connect payouts to publish publicly" guidance.
      setSaveError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't save changes. Please try again.",
      );
    }
  };

  const selectTab = (nextTab: AdminTabId) => {
    setTab(nextTab);
    syncSearchParams({ tab: nextTab === "edit" ? null : nextTab });
  };

  return (
    <div className="launch-page-narrow admin-page">
      <ApiNotice live={live} noun="Agent admin" />
      <AdminHeader
        dirty={dirty}
        navigate={navigate}
        onSave={save}
        saveState={saveState}
        tool={tool}
        visibility={visibility}
      />
      {saveState === "error" && saveError
        ? (
          <Card className="admin-save-error">
            <Icon name="shield" />
            <p>{saveError}</p>
          </Card>
        )
        : null}
      {live.data.adminAgent?.admin.referral
        ? <ReferralLinkCard referral={live.data.adminAgent.admin.referral} />
        : null}
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
        category={category}
        description={description}
        name={name}
        navigate={navigate}
        setCategory={setCategory}
        setDescription={setDescription}
        setName={setName}
        setVisibility={setVisibility}
        tab={tab}
        tool={tool}
        visibility={visibility}
      />
    </div>
  );
}

function OwnedAgentCard({
  tool,
}: {
  tool: AgentDetailFixture;
}): ReactElement {
  return (
    <Card className="owned-tool-card">
      <div className="owned-tool-main">
        <div>
          <h3>{tool.title}</h3>
          <p>{tool.summary}</p>
        </div>
      </div>
    </Card>
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
  dirty,
  navigate,
  onSave,
  saveState,
  tool,
  visibility,
}: {
  dirty: boolean;
  navigate: (to: string) => void;
  onSave: () => void;
  saveState: "idle" | "saving" | "saved" | "error";
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
        <Button disabled={!dirty || saveState === "saving"} onClick={onSave}>
          {saveState === "saving"
            ? "Saving…"
            : saveState === "error"
            ? "Retry save"
            : saveState === "saved" && !dirty
            ? "Saved"
            : "Save changes"}
        </Button>
      </div>
    </section>
  );
}

function AdminTabPanel({
  category,
  description,
  name,
  navigate,
  setCategory,
  setDescription,
  setName,
  setVisibility,
  tab,
  tool,
  visibility,
}: {
  category: string;
  description: string;
  name: string;
  navigate: (to: string) => void;
  setCategory: (value: string) => void;
  setDescription: (value: string) => void;
  setName: (value: string) => void;
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
          category={category}
          description={description}
          name={name}
          setCategory={setCategory}
          setDescription={setDescription}
          setName={setName}
          setVisibility={setVisibility}
          visibility={visibility}
        />
      );
  }
}

function AdminEditPanel({
  category,
  description,
  name,
  setCategory,
  setDescription,
  setName,
  setVisibility,
  visibility,
}: {
  category: string;
  description: string;
  name: string;
  setCategory: (value: string) => void;
  setDescription: (value: string) => void;
  setName: (value: string) => void;
  setVisibility: (visibility: AgentDetailFixture["visibility"]) => void;
  visibility: AgentDetailFixture["visibility"];
}): ReactElement {
  return (
    <div className="admin-panel admin-edit-panel">
      <AdminField label="Name">
        <input
          className="admin-input mono"
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </AdminField>
      <AdminField label="Description">
        <textarea
          className="admin-textarea"
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          value={description}
        />
      </AdminField>
      <div className="admin-split-fields">
        <AdminField label="Category">
          <input
            className="admin-input"
            onChange={(event) => setCategory(event.target.value)}
            value={category}
          />
        </AdminField>
        <AdminField label="Tags">
          <div className="admin-tags">
            <span className="muted-note">managed from the CLI</span>
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
        <Mono>gx.set</Mono> from a connected agent (or the CLI) to manage this
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
        The website does not stream run logs yet. Use <Mono>gx.logs</Mono>{" "}
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

type AccountTabId = "preferences" | "balance" | "earnings";

// Account header: avatar + an inline-editable display name. The name persists
// to the account (and doubles as the public author label on published Agents).
function ProfileStrip({ canManage }: { canManage: boolean }): ReactElement {
  const [name, setName] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    launchApi.getLaunchSettings()
      .then((settings) => {
        if (cancelled) return;
        setName(settings.displayName ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage]);

  const trimmedName = name?.trim() || "";
  const headingLabel = canManage && trimmedName ? trimmedName : "Account";

  const startEdit = () => {
    setDraft(trimmedName);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const settings = await launchApi.updateLaunchSettings({
        displayName: draft.trim(),
      });
      setName(settings.displayName ?? null);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="account-name-card">
      <p className="section-label">Account</p>
      <div className="profile-strip">
        <div className="profile-identity">
          {editing
          ? (
            <form
              className="profile-name-edit"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <input
                aria-label="Display name"
                autoFocus
                maxLength={80}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder="Your name"
                value={draft}
              />
              <Button onClick={() => void save()} size="sm">
                {saving ? "Saving" : "Save"}
              </Button>
              <Button
                onClick={() => setEditing(false)}
                size="sm"
                variant="secondary"
              >
                Cancel
              </Button>
            </form>
          )
          : (
            <div className="profile-name-row">
              <h1>{headingLabel}</h1>
              {canManage && loaded
                ? (
                  <button
                    aria-label="Edit name"
                    className="profile-name-edit-btn"
                    onClick={startEdit}
                    type="button"
                  >
                    <Icon name="edit" size={14} />
                  </button>
                )
                : null}
            </div>
          )}
          {!canManage
            ? <p>Complete Google sign-in to manage your account</p>
            : null}
          {error ? <p className="profile-name-error">{error}</p> : null}
        </div>
      </div>
    </Card>
  );
}

export function AccountFoundationPage(
  { live, navigate }: LaunchPageProps,
): ReactElement {
  const canManageKeys = hasLaunchAuthToken() && live.status !== "error";
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [visibleKeys, setVisibleKeys] = useState<ApiKeyFixture[]>(() =>
    liveApiKeyFixtures(live.data.apiKeys?.apiKeys)
  );
  const [showTopUp, setShowTopUp] = useState(
    () => queryParam("tab") === "topup",
  );

  useEffect(() => {
    setVisibleKeys(liveApiKeyFixtures(live.data.apiKeys?.apiKeys));
  }, [live.data.apiKeys]);

  const totals = liveWalletTotals(live.data.wallet?.wallet);
  const wallet = live.data.wallet?.wallet;

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
    <div className="launch-page-narrow account-page">
      <ApiNotice live={live} noun="account" />
      <ProfileStrip canManage={canManageKeys} />

      <Card className="wallet-amount-card">
        <WalletAmount
          label="Credit balance"
          value={wallet ? totals.spendable : null}
        />
        <div className="wallet-hero-actions">
          <Button
            onClick={() => setShowTopUp((open) => !open)}
            variant={showTopUp ? "secondary" : "primary"}
          >
            {showTopUp ? "Close" : "+ Add credits"}
          </Button>
        </div>
      </Card>

      {wallet?.freeMode
        ? <FreeModeBanner onAddFunds={() => setShowTopUp(true)} />
        : null}

      <SettingsCard
        action={canManageKeys
          ? (
            <Button onClick={() => setNewKeyVisible(true)} size="sm">
              Create key
            </Button>
          )
          : null}
        collapsible
        defaultExpanded={false}
        subtitle="Tokens your connected agents use to call Galactic. New keys reveal once."
        summary={visibleKeys.length > 0
          ? <Pill>{visibleKeys.length} keys</Pill>
          : null}
        title="Galactic Keys"
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
        collapsible
        defaultExpanded={false}
        subtitle="Connected-agent consent and Agent-to-Agent delegation controls."
        title="Permissions"
      >
        <p className="settings-help">
          Function-level Always / Ask / Never controls live on each Agent's
          Functions tab. These settings do not create a cross-user whitelist.
        </p>
        <AgentGrantApprovalRow canManage={canManageKeys} live={live} />
      </SettingsCard>

      <SettingsCard
        collapsible
        defaultExpanded={false}
        subtitle="Build on Galactic — the full platform guide, tool reference, and SDK globals."
        title="Developer"
      >
        <a
          className="settings-doc-link"
          href={`${launchApiOrigin()}/api/skills`}
          rel="noreferrer"
          target="_blank"
        >
          <Icon name="terminal" />
          <div>
            <strong>Platform docs</strong>
            <span>
              Skills.md — building guide, Agent conventions, and resource URIs.
            </span>
          </div>
          <Icon name="external" />
        </a>
      </SettingsCard>

      <div className="connect-agent-callout">
        <div>
          <strong>Connecting an agent?</strong>
          <p>
            Use Add to agent. It bundles your API key into install instructions
            without exposing it in the page.
          </p>
        </div>
        <AddToAgentButton size="md" variant="secondary" />
      </div>

      {canManageKeys
        ? (
          <div className="account-signout-row">
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
        )
        : null}

      {showTopUp
        ? (
          <div
            className="topup-modal-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget) setShowTopUp(false);
            }}
            role="presentation"
          >
            <div
              aria-label="Add credits"
              aria-modal="true"
              className="topup-modal"
              role="dialog"
            >
              <button
                aria-label="Close"
                className="topup-modal-close"
                onClick={() => setShowTopUp(false)}
                type="button"
              >
                ✕
              </button>
              <WalletTopUpPanel
                earnedCredits={totals.earned}
                live={live}
                publishableKey={wallet?.stripePublishableKey}
                buyerEmail={wallet?.buyerEmail}
                onClose={() => setShowTopUp(false)}
              />
            </div>
          </div>
        )
        : null}

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
  // null = wallet not loaded yet; never show a fabricated 0.000-credit balance.
  // Ledger stores "Light" (100 = $1); display the real dollar value, uniform
  // size/color — no x100, no smaller/greyer cents.
  const figure = value === null
    ? "—"
    : `$${(value / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  return (
    <div className="wallet-amount">
      <p className="section-label">{label}</p>
      <strong>{figure}</strong>
    </div>
  );
}

// Shown on the balance tab when the server reports Free Mode is active (balance
// under $0.25 and the platform is enforcing no-spend mode). Mirrors the
// agent-facing notice (free-mode.ts) so the wallet and the agent tell the same
// story. The threshold is stated in dollars — the internal Light unit never
// surfaces in the UI.
function FreeModeBanner(
  { onAddFunds }: { onAddFunds: () => void },
): ReactElement {
  return (
    <div className="free-mode-banner" role="status">
      <div className="free-mode-banner-body">
        <strong>Free mode is on</strong>
        <p>
          Your balance is under $0.25, so paid and AI agent calls are paused —
          free functions still work. Add funds to restore full access, or set a
          BYOK provider key to keep using AI features.
        </p>
      </div>
      <Button onClick={onAddFunds} size="sm" variant="primary">
        Add funds
      </Button>
    </div>
  );
}

function WalletBalancePanel({
  rows,
}: {
  rows: WalletRow[];
}): ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="wallet-panel">
      <Card className="wallet-ledger-card">
        <div className="wallet-section-head">
          <h2>Balance ledger</h2>
          <Pill>{rows.length} entries</Pill>
        </div>
        <div className="wallet-ledger">
          {rows.length > 0
            ? rows.map((row, index) => (
              <WalletMergedRow
                expanded={expandedId === row.id}
                first={index === 0}
                key={row.id}
                onToggle={() =>
                  setExpandedId((current) =>
                    current === row.id ? null : row.id
                  )}
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

// Stripe Link mark — green rounded square with the Link chevron.
function WalletTopUpPanel(
  { earnedCredits, live, publishableKey, buyerEmail, onClose }: {
    earnedCredits: number;
    live: LaunchPageProps["live"];
    publishableKey?: string;
    buyerEmail?: string;
    onClose?: () => void;
  },
): ReactElement {
  // Card + Link only in this modal. The method toggle (and "Transfer from
  // earnings") was removed for a single-purpose checkout, so method is fixed.
  const [method] = useState<PaymentMethod>("card");
  const [creditsAmount, setCreditsAmount] = useState(1000);
  // Editable dollar amount. amountText is the free-typing buffer; while focused
  // we don't reformat it (avoids cursor jumps), and we keep it in sync when a
  // preset or method change moves creditsAmount.
  const [amountText, setAmountText] = useState(() => dollarsText(creditsAmount));
  const amountFocused = useRef(false);
  useEffect(() => {
    if (!amountFocused.current) setAmountText(dollarsText(creditsAmount));
  }, [creditsAmount]);
  const onAmountInput = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, "").replace(/(\..*?)\..*/g, "$1");
    setAmountText(cleaned);
    const dollars = parseFloat(cleaned);
    if (Number.isFinite(dollars)) {
      // Upper bound is the Stripe-safe max (mirrors server
      // LAUNCH_WALLET_MAX_TOPUP_LIGHT), not the old $5,000 cap.
      setCreditsAmount(Math.min(97_000_000, Math.round(dollars * 100)));
    }
  };
  const onAmountBlur = () => {
    amountFocused.current = false;
    const dollars = parseFloat(amountText);
    const light = Number.isFinite(dollars) ? Math.round(dollars * 100) : 1000;
    // $1 floor (100 Light); upper bound is the Stripe-safe max (no $5,000 cap).
    const clamped = Math.min(97_000_000, Math.max(100, light));
    setCreditsAmount(clamped);
    setAmountText(dollarsText(clamped));
  };
  const [phase, setPhase] = useState<TopUpPhase>("idle");
  // Latest phase, readable from async callbacks whose closures would otherwise
  // see a stale value.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // Bumped by "Top up again" to force a fresh Stripe element mount.
  const [mountNonce, setMountNonce] = useState(0);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  // The deferred Payment Element has mounted and reported ready.
  const [ready, setReady] = useState(false);
  // ACH microdeposit fallback: Stripe's hosted page for verifying the bank.
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [redirectOutcome] = useState(readStripeRedirectOutcome);
  const [liveQuote, setLiveQuote] = useState<
    {
      baseDollars: number;
      feeDollars: number;
      feeNote: string;
      totalDollars: number;
      totalCents: number;
    } | null
  >(null);
  const quote = liveQuote || quoteTopUp(creditsAmount, method);
  const shownQuote = quote;
  // Exact integer cents for the deferred Elements amount. Prefer the server
  // quote (authoritative + matches the PaymentIntent created at Pay); fall back
  // to the local formula before the server quote loads.
  const amountCents = liveQuote?.totalCents ??
    Math.round(quoteTopUp(creditsAmount, method).totalDollars * 100);
  // Live mirror so the (post-await) element mount reads the CURRENT amount, not
  // a value captured before getStripe() resolved.
  const amountCentsRef = useRef(amountCents);
  amountCentsRef.current = amountCents;
  const presets = method === "earnings"
    ? [1000, 2500, 10000, 25000, Math.floor(earnedCredits)]
    : [1000, 2500, 10000, 25000, 50000];

  const paymentElementRef = useRef<HTMLDivElement | null>(null);
  // Billing-address fields: shown only for non-Link methods (card). Mounted on
  // demand from the Payment Element's change event — never left mounted-empty
  // for Link, which provides the address itself and would otherwise be blocked
  // at confirm by an incomplete hidden field.
  const addressElementRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const reloadTimersRef = useRef<number[]>([]);
  // Invalidation token so a stale in-flight confirm result can't clobber the UI.
  const seqRef = useRef(0);
  // While a confirm is in flight the card may already have been charged — lock
  // the inputs so the amount can't change mid-charge.
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
          totalCents: response.quote.totalAmountCents,
        });
      })
      .catch(() => {
        if (!cancelled) setLiveQuote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [creditsAmount, method]);

  // Re-price the already-mounted deferred element when the amount changes — no
  // remount, no reload of Link, no PaymentIntent (the intent is created only at
  // Pay). elements.update is the supported way to change a deferred amount.
  useEffect(() => {
    elementsRef.current?.update({ amount: amountCents });
  }, [amountCents]);

  // Mount the Stripe Payment Element (+ Link wallet) IMMEDIATELY on open using
  // the publishable key alone — a deferred PaymentIntent, so there's no intent
  // round-trip and no "Preparing checkout" wait. The actual PaymentIntent is
  // created at Pay (confirmTopUpPayment). Re-mounts only when the modal is
  // re-armed ("Top up again", via mountNonce), never on amount change.
  useEffect(() => {
    if (!publishableKey) return;
    let cancelled = false;
    setReady(false);
    (async () => {
      try {
        const stripe = await getStripe(publishableKey);
        if (cancelled) return;
        if (!stripe) {
          throw new Error(
            "Stripe.js failed to load. Check your network or ad blocker and try again.",
          );
        }
        if (!paymentElementRef.current) return;
        const elements = stripe.elements({
          mode: "payment",
          // Read the latest amount (the quote may have resolved during the
          // getStripe await; the closure-captured value could be stale).
          amount: amountCentsRef.current,
          currency: "usd",
          paymentMethodTypes: ["card", "link"],
          appearance: { theme: "stripe" },
        });
        const paymentElement = elements.create("payment", {
          // Pre-fill the buyer's email so Stripe Link recognizes returning
          // users and shows the one-tap flow immediately.
          defaultValues: buyerEmail
            ? { billingDetails: { email: buyerEmail } }
            : undefined,
        });
        paymentElement.on("ready", () => {
          if (!cancelled) setReady(true);
        });
        paymentElement.on("loaderror", (event) => {
          if (cancelled) return;
          setMessageIsError(true);
          setMessage(
            event.error?.message ||
              "The payment form failed to load. Please try again.",
          );
        });
        paymentElement.mount(paymentElementRef.current);

        // Billing address: collect a FULL address for card (non-Link) payers in
        // the UI, but never for Link — Link supplies the address itself, and an
        // empty mounted address field would block confirm. Create + mount the
        // address fields ONLY while a non-Link method is selected, and DESTROY
        // them otherwise (destroying — not hiding — removes the element from the
        // group so it can't block a Link confirm). Default unmounted, so Link is
        // never blocked even if no change event fires. Both Link's autofilled
        // address and the card AddressElement land on the charge billing_details,
        // captured by the deposit webhook for consumption-time tax.
        let addressElement: StripeAddressElement | null = null;
        const syncAddressVisibility = (methodType?: string) => {
          const showAddress = !!methodType && methodType !== "link";
          if (showAddress && !addressElement && addressElementRef.current) {
            addressElement = elements.create("address", {
              mode: "billing",
              autocomplete: { mode: "automatic" },
              fields: { phone: "never" },
            });
            addressElement.mount(addressElementRef.current);
          } else if (!showAddress && addressElement) {
            addressElement.destroy();
            addressElement = null;
          }
        };
        paymentElement.on("change", (event) => {
          if (!cancelled) syncAddressVisibility(event.value?.type);
        });

        stripeRef.current = stripe;
        elementsRef.current = elements;
        // Re-apply the current amount: the [amountCents] update effect may have
        // fired while elementsRef was still null (mid-await) and no-op'd.
        elements.update({ amount: amountCentsRef.current });
      } catch (err) {
        if (cancelled) return;
        setMessageIsError(true);
        setMessage(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      elementsRef.current?.getElement("address")?.destroy();
      elementsRef.current?.getElement("payment")?.destroy();
      elementsRef.current = null;
      stripeRef.current = null;
    };
    // Mount once per publishable key / re-arm. amountCents is applied via the
    // separate elements.update effect, NOT a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishableKey, mountNonce]);

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

  const confirmTopUpPayment = async () => {
    // Consent gate: the card is only charged once the buyer has accepted the
    // Terms and clicked Pay.
    if (!termsAccepted) {
      setMessageIsError(true);
      setMessage("Accept the Galactic Terms to continue.");
      return;
    }
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) return;
    const seq = ++seqRef.current;
    setPhase("confirming");
    setMessageIsError(false);
    setMessage("");
    writePendingTopUpResult("confirming");
    try {
      // Deferred flow: validate the element, THEN create the PaymentIntent for
      // the current amount, THEN confirm against it. The intent is created here
      // (at Pay) — not on open — so there are no abandoned intents.
      const { error: submitError } = await elements.submit();
      if (submitError) {
        if (seqRef.current !== seq) return;
        writePendingTopUpResult(null);
        setPhase("idle");
        setMessageIsError(true);
        setMessage(
          submitError.message ||
            "Please complete the payment details and try again.",
        );
        return;
      }
      const intent = await launchApi.createWalletTopUpIntent({
        amountCredits: creditsAmount,
        method: "card",
        termsAccepted: true,
      });
      if (seqRef.current !== seq) return;
      const result = await stripe.confirmPayment({
        elements,
        clientSecret: intent.clientSecret,
        confirmParams: {
          return_url: `${window.location.origin}/account?tab=balance`,
        },
        redirect: "if_required",
      });
      if (seqRef.current !== seq) return;
      if (result.error) {
        writePendingTopUpResult(null);
        setPhase("idle");
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
        scheduleWalletReloads();
      } else if (status === "processing") {
        writePendingTopUpResult("processing");
        setPhase("processing");
        setMessageIsError(false);
        setMessage(TOPUP_PROCESSING_MESSAGE);
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
        } else {
          writePendingTopUpResult(null);
          setPhase("idle");
          setMessageIsError(true);
          setMessage(
            "Additional verification is required to complete this payment. Please try again or use a different payment method.",
          );
        }
      } else {
        writePendingTopUpResult(null);
        setPhase("idle");
        setMessageIsError(true);
        setMessage(
          `Payment not completed (status: ${status ?? "unknown"}). Please try again.`,
        );
      }
    } catch (err) {
      if (seqRef.current !== seq) return;
      writePendingTopUpResult(null);
      setPhase("idle");
      setMessageIsError(true);
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const resetForAnotherTopUp = () => {
    seqRef.current += 1;
    writePendingTopUpResult(null);
    setPhase("idle");
    phaseRef.current = "idle";
    setMessage("");
    setMessageIsError(false);
    setTermsAccepted(false);
    setVerificationUrl(null);
    // Re-mount a fresh Stripe element for another top-up.
    setMountNonce((n) => n + 1);
    live.reload();
  };

  // Dedicated confirmation screen — replaces the whole checkout form once the
  // charge is in (card succeeded) or the bank transfer is underway (ACH).
  if (phase === "succeeded" || phase === "processing") {
    const isProcessing = phase === "processing";
    return (
      <div className="topup-confirm">
        <div
          className={`topup-confirm-badge${
            isProcessing ? " is-processing" : ""
          }`}
        >
          <Icon name={isProcessing ? "shield" : "check"} size={28} />
        </div>
        <h2 className="topup-confirm-title">
          {isProcessing ? "Transfer initiated" : "Thank you!"}
        </h2>
        <p className="topup-confirm-amount">
          {formatCreditFromLight(creditsAmount)}
        </p>
        <p className="topup-confirm-sub">
          {isProcessing
            ? "is on its way to your Galactic balance"
            : "added to your Galactic balance"}
        </p>
        <p className="topup-confirm-note">
          {message ||
            (isProcessing ? TOPUP_PROCESSING_MESSAGE : TOPUP_SUCCESS_MESSAGE)}
        </p>
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
        <div className="topup-confirm-actions">
          <Button
            onClick={resetForAnotherTopUp}
            size="lg"
            variant="secondary"
          >
            Top up again
          </Button>
          <Button
            onClick={() => {
              live.reload();
              onClose?.();
            }}
            size="lg"
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="wallet-topup-grid">
      <Card className="wallet-topup-card">
        <p className="section-label">Amount</p>
        <div className="light-input-shell">
          <span className="amount-currency">$</span>
          <input
            aria-label="Top-up amount in dollars"
            className="amount-field"
            disabled={inputsLocked}
            inputMode="decimal"
            onBlur={onAmountBlur}
            onChange={(event) => onAmountInput(event.target.value)}
            onFocus={() => {
              amountFocused.current = true;
            }}
            value={amountText}
          />
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
              {formatPresetDollars(amount)}
            </button>
          ))}
        </div>
      </Card>

      <div className="wallet-quote-col">
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
        <div className="quote-total">
          <span>{method === "earnings" ? "Transfer" : "Total"}</span>
          <strong>{formatCurrency(shownQuote.totalDollars)}</strong>
        </div>
        {/* Deferred Payment Element + Link mount here immediately on open. */}
        <div className="topup-payment-element" ref={paymentElementRef} />
        {/* Address fields mount only for card (non-Link) payers; see effect. */}
        <div className="topup-address-element" ref={addressElementRef} />
        {method !== "earnings"
          ? (
            <label className="topup-terms">
              <input
                checked={termsAccepted}
                // The checkout is prepared on open, so the box must stay
                // checkable; only lock it once a charge is in flight.
                disabled={inputsLocked}
                onChange={(event) => setTermsAccepted(event.target.checked)}
                type="checkbox"
              />
              <span>
                I agree to the Galactic{" "}
                <a href="/terms" rel="noopener" target="_blank">
                  Terms of Service
                </a>{" "}
                and authorize this charge.
              </span>
            </label>
          )
          : null}
        <Button
          // Require the server quote (liveQuote) so the element amount at
          // confirm is the exact server total, never the ~1¢-off local fallback.
          disabled={!ready || !termsAccepted || !liveQuote ||
            phase === "confirming"}
          onClick={confirmTopUpPayment}
          size="lg"
        >
          {phase === "confirming"
            ? "Processing payment…"
            : `Pay ${formatCurrency(shownQuote.totalDollars)}`}
        </Button>
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
      </Card>
        <div className="secure-note">
          <Icon name="shield" size={12} />
          <span>
            {method === "earnings"
              ? "Instant internal transfer"
              : "Secure checkout · Stripe"}
          </span>
        </div>
      </div>
    </div>
  );
}

// Earnings → balance transfer. Reuses the top-up modal chrome (amount card +
// summary card), but there's no Stripe leg — the server moves creator earnings
// into the spendable balance atomically, so success is immediate and fee-free.
function WalletTransferPanel(
  { earnedCredits, live, onClose }: {
    earnedCredits: number;
    live: LaunchPageProps["live"];
    onClose?: () => void;
  },
): ReactElement {
  // Snapshot the transferable maximum at open; the server re-checks at
  // confirm (and "all" transfers convert whatever is actually available).
  const maxCredits = Math.max(0, Math.floor(earnedCredits));
  const [creditsAmount, setCreditsAmount] = useState(maxCredits);
  const [amountText, setAmountText] = useState(() => dollarsText(maxCredits));
  const amountFocused = useRef(false);
  useEffect(() => {
    if (!amountFocused.current) setAmountText(dollarsText(creditsAmount));
  }, [creditsAmount]);
  const onAmountInput = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, "").replace(/(\..*?)\..*/g, "$1");
    setAmountText(cleaned);
    const dollars = parseFloat(cleaned);
    if (Number.isFinite(dollars)) {
      setCreditsAmount(Math.min(maxCredits, Math.round(dollars * 100)));
    }
  };
  const onAmountBlur = () => {
    amountFocused.current = false;
    const dollars = parseFloat(amountText);
    const light = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    // 1-Light floor (a cent of earnings is still transferable), capped at
    // what's available.
    const clamped = Math.min(maxCredits, Math.max(1, light));
    setCreditsAmount(clamped);
    setAmountText(dollarsText(clamped));
  };
  const [phase, setPhase] = useState<"idle" | "confirming" | "succeeded">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [transferredCredits, setTransferredCredits] = useState(0);

  const presets = [
    ...[1000, 2500, 10000, 25000].filter((amount) => amount < maxCredits),
    ...(maxCredits > 0 ? [maxCredits] : []),
  ];

  const confirmTransfer = async () => {
    if (!termsAccepted) {
      setMessageIsError(true);
      setMessage("Accept the Galactic Terms to continue.");
      return;
    }
    const amount = Math.min(maxCredits, creditsAmount);
    if (amount <= 0) {
      setMessageIsError(true);
      setMessage("No earnings are available to transfer.");
      return;
    }
    setPhase("confirming");
    setMessageIsError(false);
    setMessage("");
    try {
      const result = await launchApi.convertEarningsToBalance(
        // "Everything" as all=true so the server converts what's actually
        // available even if earnings moved since the page loaded.
        amount >= maxCredits
          ? { all: true, termsAccepted: true }
          : { amountCredits: amount, termsAccepted: true },
      );
      setTransferredCredits(result.converted_light ?? amount);
      setPhase("succeeded");
      live.reload();
    } catch (err) {
      setPhase("idle");
      setMessageIsError(true);
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  if (phase === "succeeded") {
    return (
      <div className="topup-confirm">
        <div className="topup-confirm-badge">
          <Icon name="check" size={28} />
        </div>
        <h2 className="topup-confirm-title">Transfer complete</h2>
        <p className="topup-confirm-amount">
          {formatCreditFromLight(transferredCredits)}
        </p>
        <p className="topup-confirm-sub">
          moved from earnings to your Galactic balance
        </p>
        <p className="topup-confirm-note">
          The credits are spendable right away.
        </p>
        <div className="topup-confirm-actions">
          <Button
            onClick={() => {
              live.reload();
              onClose?.();
            }}
            size="lg"
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  const quote = quoteTopUp(creditsAmount, "earnings");
  const inputsLocked = phase === "confirming";

  return (
    <div className="wallet-topup-grid">
      <Card className="wallet-topup-card">
        <p className="section-label">Amount</p>
        <div className="light-input-shell">
          <span className="amount-currency">$</span>
          <input
            aria-label="Transfer amount in dollars"
            className="amount-field"
            disabled={inputsLocked}
            inputMode="decimal"
            onBlur={onAmountBlur}
            onChange={(event) => onAmountInput(event.target.value)}
            onFocus={() => {
              amountFocused.current = true;
            }}
            value={amountText}
          />
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
              {amount === maxCredits ? "Max" : formatPresetDollars(amount)}
            </button>
          ))}
        </div>
      </Card>

      <div className="wallet-quote-col">
        <Card className="wallet-quote-card">
          <p className="section-label">Transfer summary</p>
          <QuoteLine
            label="From earnings"
            value={formatCurrency(quote.baseDollars)}
          />
          <QuoteLine
            label="Processing fee"
            muted={quote.feeNote}
            value={formatCurrency(quote.feeDollars)}
          />
          <div className="quote-total">
            <span>To balance</span>
            <strong>{formatCurrency(quote.totalDollars)}</strong>
          </div>
          <label className="topup-terms">
            <input
              checked={termsAccepted}
              disabled={inputsLocked}
              onChange={(event) => setTermsAccepted(event.target.checked)}
              type="checkbox"
            />
            <span>
              I agree to the Galactic{" "}
              <a href="/terms" rel="noopener" target="_blank">
                Terms of Service
              </a>{" "}
              and authorize this transfer.
            </span>
          </label>
          <Button
            disabled={!termsAccepted || creditsAmount <= 0 || inputsLocked}
            onClick={() => void confirmTransfer()}
            size="lg"
          >
            {inputsLocked
              ? "Transferring…"
              : `Transfer ${formatCurrency(quote.totalDollars)}`}
          </Button>
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
        </Card>
        <div className="secure-note">
          <Icon name="shield" size={12} />
          <span>Instant internal transfer · no fee</span>
        </div>
      </div>
    </div>
  );
}

function PayoutsBanner(): ReactElement {
  const [connect, setConnect] = useState<LaunchConnectStatus | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    launchApi.connectStatus()
      .then((status) => {
        if (!cancelled) {
          setConnect(status);
          setState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startOnboarding = async () => {
    if (redirecting) return;
    setRedirecting(true);
    try {
      const { onboarding_url } = await launchApi.startConnectOnboarding();
      window.location.href = onboarding_url;
    } catch {
      setRedirecting(false);
    }
  };

  const payoutsReady = connect?.payouts_enabled === true;
  const hasAccount = connect?.connected === true;
  const dueCount = connect?.requirements_currently_due?.length ?? 0;
  // Treat an errored status read like "not set up" so the CTA still shows.
  const tone = state === "loading"
    ? "neutral"
    : payoutsReady
    ? "green"
    : hasAccount
    ? "amber"
    : "neutral";

  return (
    <Card className={`payout-banner payout-banner-${tone}`}>
      <span className="target-icon">
        <Icon name="shield" />
      </span>
      <div className="payout-banner-body">
        <h3>Payouts</h3>
        {state === "loading"
          ? <p>Checking your payout account…</p>
          : payoutsReady
          ? (
            <p>
              Stripe Connect payouts are set up. Withdraw earned credits via{" "}
              <Mono>gx.wallet</Mono> from a connected agent.
            </p>
          )
          : hasAccount
          ? (
            <p>
              Finish setting up Stripe Connect to receive payouts{dueCount > 0
                ? ` — ${dueCount} step${dueCount === 1 ? "" : "s"} left`
                : ""}. Required before an agent can be published publicly.
            </p>
          )
          : (
            <p>
              Set up Stripe Connect payouts to receive earnings — and to publish
              an agent publicly.
            </p>
          )}
        {!payoutsReady && state !== "loading"
          ? (
            <Button
              disabled={redirecting}
              onClick={() => void startOnboarding()}
              size="sm"
            >
              {redirecting
                ? "Redirecting…"
                : hasAccount
                ? "Resume payout setup"
                : "Set up payouts"}
            </Button>
          )
          : null}
      </div>
    </Card>
  );
}

function WalletEarningsPanel({
  earnings,
}: {
  earnings: LedgerRow[];
}): ReactElement {
  const [toolFilter, setToolFilter] = useState("all");
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
      <PayoutsBanner />
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

// One row of the merged balance ledger. Transaction rows are static; receipt
// rows are clickable and expand to their own cost breakdown.
function WalletMergedRow(
  { expanded, first, onToggle, row }: {
    expanded: boolean;
    first: boolean;
    onToggle: () => void;
    row: WalletRow;
  },
): ReactElement {
  const positive = row.amount > 0;
  const glyphs: Record<LedgerRow["kind"], string> = {
    call: "→",
    earning: "$",
    payout: "↑",
    topup: "+",
    transfer: "⇄",
  };
  const kind = row.source === "receipt" ? "call" : row.kind;
  const amount = (
    <span className={positive ? "positive" : ""}>
      {positive ? "+" : "-"}
      {formatCreditFromLight(Math.abs(row.amount))}
    </span>
  );

  if (row.source !== "receipt") {
    return (
      <div className={first ? "wallet-ledger-row first" : "wallet-ledger-row"}>
        <span className={`ledger-glyph ledger-glyph-${kind}`}>
          {glyphs[kind]}
        </span>
        <span>{row.detail}</span>
        <span>{row.when}</span>
        {amount}
      </div>
    );
  }

  return (
    <>
      <div
        aria-expanded={expanded}
        className={`wallet-ledger-row expandable${first ? " first" : ""}`}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className={`ledger-glyph ledger-glyph-${kind}`}>
          {glyphs[kind]}
        </span>
        <span>
          <span className={expanded ? "ledger-chevron open" : "ledger-chevron"}>
            ▸
          </span>
          {row.detail}
        </span>
        <span>{row.when}</span>
        {amount}
      </div>
      {expanded
        ? (
          <div className="wallet-ledger-detail">
            <QuoteLine
              label="App charge"
              value={formatCreditFromLight(row.appCharge)}
            />
            <QuoteLine
              label="Infrastructure"
              value={formatCreditFromLight(row.infraCharge)}
            />
            <QuoteLine
              label="Platform fee"
              value={formatCreditFromLight(row.platformFee)}
            />
            {row.tax > 0
              ? (
                <QuoteLine
                  label="Sales tax"
                  value={formatCreditFromLight(row.tax)}
                />
              )
              : null}
            <QuoteLine
              label="Developer earns"
              value={formatCreditFromLight(row.developerNet)}
            />
            <div className="quote-total">
              <span>
                Total · {row.fn}
                {row.status === "error" ? " · failed" : ""}
              </span>
              <strong>{formatCreditFromLight(row.total)}</strong>
            </div>
          </div>
        )
        : null}
    </>
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
  collapsible = false,
  defaultExpanded = true,
  subtitle,
  summary,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  subtitle?: string;
  summary?: ReactNode;
  title: string;
}): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const showBody = !collapsible || expanded;
  const heading = (
    <div className="settings-card-heading">
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
  );
  return (
    <Card className="settings-card">
      <div className="settings-card-head">
        {collapsible
          ? (
            <button
              aria-expanded={expanded}
              className="settings-card-toggle"
              onClick={() => setExpanded((open) => !open)}
              type="button"
            >
              {heading}
            </button>
          )
          : heading}
        <div className="settings-card-head-actions">
          {summary}
          {action}
        </div>
      </div>
      {showBody ? <div className="settings-card-body">{children}</div> : null}
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

// Mirrors the backend OpenRouter default (BYOK_PROVIDERS.openrouter.defaultModel)
// for display/prefill; the actual route default lives server-side.
const GALACTIC_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

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
  const [formState, setFormState] = useState<"idle" | "error">("idle");
  const [formMessage, setFormMessage] = useState("");
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  // Which provider's key modal is open (null = closed). Each provider gets its
  // own button rather than a shared dropdown.
  const [modalProvider, setModalProvider] = useState<
    LaunchByokProviderOption | null
  >(null);
  // The Galactic AI (platform credits) model modal — settable WITHOUT a key,
  // distinct from the per-provider BYOK key+model modal.
  const [galacticModelOpen, setGalacticModelOpen] = useState(false);

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
      collapsible
      defaultExpanded={false}
      subtitle="Bring your own inference key, or let platform runs bill credits. Stored keys are encrypted and never shown again."
      title="BYOK Settings"
    >
      {canManageKeys
        ? (
          <div className="byok-provider-list">
            <div className="preference-row byok-provider-row">
              <div>
                <strong>Galactic AI</strong>
                <span>
                  Current model:{" "}
                  {live.data.inferenceOptions?.platformModel ||
                    GALACTIC_DEFAULT_MODEL}{" "}
                  · no BYOK key required
                </span>
              </div>
              <Button
                onClick={() => {
                  setFormState("idle");
                  setFormMessage("");
                  setGalacticModelOpen(true);
                }}
                size="sm"
                variant="secondary"
              >
                Choose model
              </Button>
            </div>
            {providers.map((option) => (
              <ByokProviderRow
                busy={busyProvider === option.id}
                key={option.id}
                onConfigure={() => {
                  setFormState("idle");
                  setFormMessage("");
                  setModalProvider(option);
                }}
                onSetPrimary={() =>
                  runProviderAction(
                    option.id,
                    () => launchApi.setByokPrimary(option.id),
                  )}
                option={option}
              />
            ))}
          </div>
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
      {modalProvider
        ? (
          <ByokKeyModal
            onClose={() => setModalProvider(null)}
            onRemoved={(message) => {
              setModalProvider(null);
              setFormState("idle");
              setFormMessage(message);
              live.reload();
            }}
            onSaved={(message) => {
              setModalProvider(null);
              setFormState("idle");
              setFormMessage(message);
              live.reload();
            }}
            provider={modalProvider}
          />
        )
        : null}
      {galacticModelOpen
        ? (
          <GalacticModelModal
            inference={live.data.inferenceOptions}
            navigate={navigate}
            onClose={() => setGalacticModelOpen(false)}
            onSaved={(message) => {
              setGalacticModelOpen(false);
              setFormState("idle");
              setFormMessage(message);
              live.reload();
            }}
          />
        )
        : null}
    </SettingsCard>
  );
}

// The Galactic AI (platform credits) model picker. No key — sets the OpenRouter
// model galactic.ai() uses for credit-billed platform runs (chat + autonomous).
// The wallet/balance line lives here rather than on the card surface.
function GalacticModelModal({
  inference,
  navigate,
  onClose,
  onSaved,
}: {
  inference?: LaunchInferenceOptionsResponse;
  navigate: (to: string) => void;
  onClose: () => void;
  onSaved: (message: string) => void;
}): ReactElement {
  const [modelDraft, setModelDraft] = useState(
    inference?.platformModel || GALACTIC_DEFAULT_MODEL,
  );
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  const save = async () => {
    if (state === "saving") return;
    setState("saving");
    setMessage("");
    try {
      const res = await launchApi.setPlatformModel(modelDraft.trim());
      onSaved(
        `Galactic AI model set to ${res.platformModel ?? "provider default"}`,
      );
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="settings-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <Card className="new-key-modal byok-key-modal">
        <div className="modal-title-row">
          <span className="target-icon">
            <Icon name="spark" />
          </span>
          <h2>Galactic AI model</h2>
        </div>
        <p>
          The OpenRouter model galactic.ai() uses for credit-billed platform runs
          (chat and autonomous agent functions). No key required.
        </p>
        {inference
          ? (
            <p className="settings-help">
              Billed from your balance ·{" "}
              {formatCreditFromLight(inference.credits.spendable ?? 0)} spendable
              {" · "}
              <RouteLink navigate={navigate} to="/account?tab=balance">
                Manage wallet
              </RouteLink>
            </p>
          )
          : null}
        <form
          className="byok-modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            <span>model</span>
            <input
              autoFocus
              onChange={(event) => setModelDraft(event.currentTarget.value)}
              placeholder={inference?.platformModel || GALACTIC_DEFAULT_MODEL}
              value={modelDraft}
            />
          </label>
        </form>
        {message
          ? (
            <p
              className={state === "error"
                ? "settings-help error"
                : "settings-help"}
            >
              {message}
            </p>
          )
          : null}
        <div className="modal-actions byok-modal-actions">
          <div className="modal-actions-right">
            <Button onClick={onClose} size="sm" variant="secondary">
              Cancel
            </Button>
            <Button onClick={() => void save()} size="sm">
              {state === "saving" ? "Saving" : "Save model"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// Per-provider key entry. A single provider is locked in by the row that
// opened it, so there's no provider picker here — just the key + optional model.
function ByokKeyModal({
  onClose,
  onRemoved,
  onSaved,
  provider,
}: {
  onClose: () => void;
  onRemoved: (message: string) => void;
  onSaved: (message: string) => void;
  provider: LaunchByokProviderOption;
}): ReactElement {
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState(provider.model || "");
  const [validateOnSave, setValidateOnSave] = useState(true);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState("");
  const busy = state === "saving" || removing;

  const save = async () => {
    if (busy) return;
    if (!apiKeyDraft.trim()) {
      setState("error");
      setMessage("Paste an API key first.");
      return;
    }
    setState("saving");
    setMessage("");
    try {
      const response = await launchApi.upsertByokProvider(provider.id, {
        apiKey: apiKeyDraft.trim(),
        ...(modelDraft.trim() ? { model: modelDraft.trim() } : {}),
        validate: validateOnSave,
      });
      onSaved(response.message);
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    if (busy) return;
    setRemoving(true);
    setState("idle");
    setMessage("");
    try {
      const response = await launchApi.deleteByokProvider(provider.id);
      onRemoved(response.message);
    } catch (err) {
      setRemoving(false);
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="settings-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <Card className="new-key-modal byok-key-modal">
        <div className="modal-title-row">
          <span className="target-icon">
            <Icon name="key" />
          </span>
          <h2>
            {provider.configured
              ? `Update ${provider.name} key`
              : `Add ${provider.name} key`}
          </h2>
        </div>
        <p>Keys are sent once, stored encrypted, and used server-side only.</p>
        <form
          className="byok-modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            <span>API key</span>
            <input
              autoComplete="new-password"
              autoFocus
              onChange={(event) => setApiKeyDraft(event.currentTarget.value)}
              placeholder={provider.apiKeyPrefix
                ? `${provider.apiKeyPrefix}...`
                : "paste key"}
              type="password"
              value={apiKeyDraft}
            />
          </label>
          <label>
            <span>model (optional)</span>
            <input
              onChange={(event) => setModelDraft(event.currentTarget.value)}
              placeholder={provider.defaultModel || "provider default"}
              value={modelDraft}
            />
          </label>
        </form>
        <label className="byok-validate">
          <input
            checked={validateOnSave}
            onChange={(event) => setValidateOnSave(event.currentTarget.checked)}
            type="checkbox"
          />
          Validate key on save
        </label>
        {message
          ? (
            <p
              className={state === "error"
                ? "settings-help error"
                : "settings-help"}
            >
              {message}
            </p>
          )
          : null}
        {provider.apiKeyUrl
          ? (
            <p className="settings-help">
              <a href={provider.apiKeyUrl} rel="noreferrer" target="_blank">
                Get a {provider.name} key
              </a>
            </p>
          )
          : null}
        <div className="modal-actions byok-modal-actions">
          {provider.configured
            ? (
              <Button
                className="byok-remove-btn"
                onClick={() => void remove()}
                size="sm"
                variant="ghost"
              >
                {removing ? "Removing" : "Remove key"}
              </Button>
            )
            : null}
          <div className="modal-actions-right">
            <Button onClick={onClose} size="sm" variant="secondary">
              Cancel
            </Button>
            <Button onClick={() => void save()} size="sm">
              {state === "saving"
                ? "Saving"
                : provider.configured
                ? "Update key"
                : "Add key"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ByokProviderRow({
  busy,
  onConfigure,
  onSetPrimary,
  option,
}: {
  busy: boolean;
  onConfigure: () => void;
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
      {option.configured && !option.primary
        ? (
          <Button onClick={onSetPrimary} size="sm" variant="secondary">
            {busy ? "Working" : "Set primary"}
          </Button>
        )
        : null}
      <Button
        onClick={onConfigure}
        size="sm"
        variant={option.configured ? "secondary" : "primary"}
      >
        {option.configured ? "Update key" : "Add key"}
      </Button>
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
        // Include the time so a second key the same day doesn't collide with the
        // unique per-user token name (date alone caused "already exists").
        name: `Launch web ${new Date().toLocaleString()}`.slice(0, 50),
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

  const [copied, setCopied] = useState(false);
  const copyToken = () => {
    // Never copy a placeholder: only the real once-revealed token is useful.
    if (!plaintextToken) return;
    navigator.clipboard?.writeText(plaintextToken).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div
      className="settings-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
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
          <Button
            icon={copied ? "check" : "copy"}
            onClick={copyToken}
            size="sm"
            variant="secondary"
          >
            {copied ? "Copied" : "Copy"}
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
      "Single source",
      "Your context, memory, balance, and preferences live in one place, and follow you to any agent you use.",
    ],
    [
      "02",
      "Pay per call",
      "Your agent spends only on what it uses. Never a monthly seat.",
    ],
    [
      "03",
      "No setup, ever",
      "New tools work the moment they're published. No accounts to create, no per-vendor keys, no integrations to maintain.",
    ],
    [
      "04",
      "Yours to leave with",
      "Switch agents tomorrow and everything comes with you. Galactic belongs to you, not to any one platform.",
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
        <Mono>{tool.name}</Mono>
      </div>
      <p>{tool.summary}</p>
      <div className="compact-tool-footer">
        <Mono>
          {tool.installs !== null
            ? `${formatNumber(tool.installs)} installs`
            : ""}
        </Mono>
        {free
          ? <span>Free</span>
          : <span>{formatCredits(tool.callPrice)}/call</span>}
      </div>
    </Card>
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

function StoreAgentCard({ tool }: { tool: AgentFixture }): ReactElement {
  return (
    <Card className="store-tool-card">
      <div className="store-card-title">
        <h3>{tool.name}</h3>
      </div>
      <p>{tool.summary}</p>
      <div className="store-card-meta">
        <Mono>
          {tool.installs !== null
            ? `${formatNumber(tool.installs)} installs`
            : ""}
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
        Try broader terms, or clear the search to browse everything.
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

function libraryViewFromSearch(): LibraryView {
  return queryParam("view") === "owned" ? "owned" : "installed";
}

function agentTabFromSearch(): AgentPageTabId {
  const tab = queryParam("tab");
  if (tab === "functions") return "functions";
  if (tab === "interface") return "interface";
  // Legacy Details/Wiring links now land on the unified Agent home.
  if (tab === "overview" || tab === "details" || tab === "wiring") {
    return "overview";
  }
  return "overview";
}

function adminTabFromSearch(): AdminTabId {
  const tab = queryParam("tab");
  return adminTabs.some(([id]) => id === tab) ? tab as AdminTabId : "edit";
}

function accountTabFromSearch(): AccountTabId {
  const tab = queryParam("tab");
  // Tolerate legacy /wallet?tab=… deep links (topup/transactions/receipts/
  // payouts) so redirected URLs land on the right merged-account tab.
  if (tab === "earnings" || tab === "payouts") return "earnings";
  if (
    tab === "balance" || tab === "transactions" || tab === "receipts" ||
    tab === "topup"
  ) {
    return "balance";
  }
  return "preferences";
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
  return value > 0 ? `${formatCredits(value)} credits` : "Free";
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
        galactic: {
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
// Plain dollar string from Light (100 = $1): 10000 -> "100", 12550 -> "125.5".
function dollarsText(light: number): string {
  const dollars = light / 100;
  return Number.isInteger(dollars)
    ? String(dollars)
    : String(Number(dollars.toFixed(2)));
}

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

// Preset chips: whole dollars without trailing cents ($10, $25, $100), but
// keep cents if a preset is ever a non-round amount.
function formatPresetDollars(light: number): string {
  const dollars = light / 100;
  if (!Number.isFinite(dollars)) return "$0";
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
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
        Galactic provides hosted agents: small programs you install, wire
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
        platform before they take effect. Questions: support@connectgalactic.com.
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
        request account deletion at support@connectgalactic.com. Operational
        billing records are retained as required for accounting.
      </p>
    </section>
  );
}
