import { useState, type ReactElement, type ReactNode } from "react";

import {
  LAUNCH_SCOPE_CONTRACT,
  type LaunchDeferredCapability,
  type LaunchIncludedCapability,
} from "../../../../shared/contracts/launch.ts";
import type { LaunchPageProps } from "../App";
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
  kind: "mcp" | "http";
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
  ["install", "Install Ultralight", "Connect the MCP/API layer to an existing agent.", "/install"],
  ["discover", "Discover tools", "Find public agent-native tools and widgets.", "/store"],
  ["wallet", "Light wallet", "Spendable Light for installs, calls, hosting.", "/wallet"],
  ["widgets", "Widgets", "Open public UI surfaces attached to tools.", "/tools/:slug"],
] as const;

const builderLeaders: LeaderboardRow[] = [
  { rank: 1, name: "@kepler", color: "#7c3aed", value: 4820.4, eventCount: 268000, featured: "get_weather" },
  { rank: 2, name: "stripe", color: "#635bff", value: 3910.2, eventCount: 142000, featured: "stripe.subscribe" },
  { rank: 3, name: "@anchor", color: "#0891b2", value: 2740.8, eventCount: 198000, featured: "currency_convert" },
  { rank: 4, name: "@vellum", color: "#ea580c", value: 1690.0, eventCount: 64000, featured: "pdf.parse" },
  { rank: 5, name: "@cartography", color: "#10b981", value: 1120.5, eventCount: 88000, featured: "maps.route" },
];

const feeLeaders: LeaderboardRow[] = [
  { rank: 1, name: "stripe", color: "#635bff", value: 1284.0, eventCount: 5120 },
  { rank: 2, name: "@kepler", color: "#7c3aed", value: 942.6, eventCount: 4380 },
  { rank: 3, name: "@octo", color: "#0a0a0a", value: 770.2, eventCount: 2010 },
  { rank: 4, name: "@anchor", color: "#0891b2", value: 615.4, eventCount: 3160 },
  { rank: 5, name: "@hex", color: "#22c55e", value: 402.1, eventCount: 1890 },
];

const installTargets: InstallTarget[] = [
  {
    config: (key) => genericMcpConfig(key),
    description: "Add Ultralight as a remote MCP server for an existing Claude Code workspace.",
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
    description: "Install the Ultralight MCP server in Cursor's MCP configuration.",
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
    description: "Connect Codex to the same remote MCP endpoint used by other agents.",
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
      JSON.stringify({ server_url: mcpUrl, authorization: `Bearer ${key}` }, null, 2),
    description: "Register Ultralight as a remote MCP server for OpenAI agent runtimes that support MCP tools.",
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
    description: "Use the standard remote MCP server declaration for any compatible agent.",
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
    description: "Use the Ultralight CLI to login, upload, test, and run deployed tools.",
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
    description: "Call launch and platform endpoints directly with an Ultralight API token.",
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

export function HomeFoundationPage({ navigate }: LaunchPageProps): ReactElement {
  return (
    <div className="launch-page-narrow home-page">
      <section className="home-hero">
        <div className="home-hero-copy">
          <h1>Many agents?<br />One tool layer.</h1>
          <p>
            Connected agents now inherit every published tool, with unified auth
            and payments. Or deploy your own.
          </p>
          <div className="hero-actions left">
            <RouteButton icon="copy" navigate={navigate} size="lg" to="/install">
              Add to agent
            </RouteButton>
            <RouteButton navigate={navigate} size="lg" to="/store" variant="secondary">
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
          Every agent draws from one core: the same context, tools, auth, and payments.
        </p>
        <SharedCore />
      </section>

      <Section
        action={<RouteLink navigate={navigate} to="/store">Browse all</RouteLink>}
        title="Tools shipping now"
      >
        <div className="home-tool-grid">
          {discoverTools.slice(0, 6).map((tool) => <CompactToolCard key={tool.id} tool={tool} />)}
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
          <p>One endpoint for every capability: discover, call, and settle in Light.</p>
        </div>
        <div className="hero-actions left">
          <RouteButton icon="copy" navigate={navigate} size="lg" to="/install" variant="secondary">
            Add to agent
          </RouteButton>
          <RouteButton navigate={navigate} size="lg" to="/store" variant="ghost">
            Browse Store
          </RouteButton>
        </div>
      </section>
    </div>
  );
}

export function InstallFoundationPage(_props: LaunchPageProps): ReactElement {
  const [target, setTarget] = useState("claude_code");
  const [signedIn, setSignedIn] = useState(false);
  const selected = installTargets.find((item) => item.target === target) || installTargets[0];
  const key = signedIn ? "ulk_live_7Qp2sR9vK3mD8xN4" : apiKeyPlaceholder;

  return (
    <div className="launch-page install-page">
      <PageHeader
        actions={
          <Button icon="key" onClick={() => setSignedIn((value) => !value)} size="lg" variant={signedIn ? "secondary" : "primary"}>
            {signedIn ? "Use placeholder" : "Simulate sign in"}
          </Button>
        }
        eyebrow="Install"
        intro="One remote MCP endpoint, or the CLI and API, lets any existing agent discover, call, and pay for tools."
        title="Connect Ultralight to your agent."
      />

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
          <TargetPicker active={target} onPick={setTarget} />
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

export function StoreFoundationPage({ navigate }: LaunchPageProps): ReactElement {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const filteredTools = discoverTools.filter((tool) =>
    (kind === "all" || tool.kind === kind) &&
    (!query ||
      `${tool.name} ${tool.summary} ${tool.category}`.toLowerCase().includes(
        query.toLowerCase(),
      ))
  );

  return (
    <div className="launch-page-narrow store-page">
      <section className="store-heading">
        <h1>Tools your agent can call.</h1>
        <SearchControls query={query} setQuery={setQuery} />
        <div className="kind-tabs" aria-label="Tool kinds">
          {["all", "mcp", "http"].map((option) => (
            <button
              className={kind === option ? "active" : ""}
              key={option}
              onClick={() => setKind(option)}
              type="button"
            >
              {option === "all" ? "All" : option.toUpperCase()}
            </button>
          ))}
        </div>
      </section>

      <div className="store-layout">
        <section className="store-results">
          <RetrievalNote query={query} />
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
              : <NoResults onClear={() => setQuery("")} />}
          </div>
        </section>
        <aside className="store-sidebar">
          <PrimitivesRail navigate={navigate} />
          <Leaderboard title="Top builders" subtitle="By earned Light" rows={builderLeaders} />
          <Leaderboard title="Fee credit" subtitle="Fee-waiver program" rows={feeLeaders} />
        </aside>
      </div>
    </div>
  );
}

export function ToolFoundationPage({ navigate, route }: LaunchPageProps): ReactElement {
  const slug = route.params.slug || "get_weather";
  return (
    <>
      <PageHeader
        actions={
          <>
            <Button icon="check" size="lg">Install</Button>
            <RouteButton navigate={navigate} size="lg" to="/store" variant="secondary">
              Back to Store
            </RouteButton>
          </>
        }
        eyebrow="Public tool page"
        intro="Public pages show trust, pricing, functions, widgets, and install state before an agent calls anything."
        title={slug}
      />
      <div className="tool-layout">
        <Section title="Widget preview">
          <Card className="widget-preview">
            <div className="widget-toolbar">
              <Pill tone="green">Public</Pill>
              <Mono>forecast_card</Mono>
            </div>
            <div className="weather-widget">
              <strong>72 F</strong>
              <span>Clear, light wind</span>
              <div className="weather-bars">
                {[64, 70, 73, 69, 66].map((value) => (
                  <span key={value} style={{ height: `${value - 38}px` }} />
                ))}
              </div>
            </div>
          </Card>
        </Section>
        <Section title="Trust + functions">
          <div className="stack">
            <Card>
              <h3>Signed manifest</h3>
              <p>Runtime, capabilities, setup requirements, receipts, and signer details sit here.</p>
              <div className="pill-row">
                <Pill tone="green">Receipts</Pill>
                <Pill>Read</Pill>
                <Pill>Network</Pill>
              </div>
            </Card>
            <Card>
              <h3>forecast</h3>
              <p>Manual website runs bypass external-agent prompts and still return receipts.</p>
              <div className="card-row spaced">
                <Mono>0.012/call</Mono>
                <Button size="sm" variant="secondary">Run</Button>
              </div>
            </Card>
          </div>
        </Section>
      </div>
    </>
  );
}

export function LibraryFoundationPage({ navigate }: LaunchPageProps): ReactElement {
  return (
    <>
      <PageHeader
        actions={<RouteButton icon="grid" navigate={navigate} size="lg" to="/store">Open Store</RouteButton>}
        eyebrow="Library"
        intro="Installed tools and owned tools live together, with owner admin one click away."
        title="Your launch tool library."
      />
      <Section title="Installed">
        <div className="tool-grid">
          {discoverTools.slice(0, 2).map((tool) => <StoreToolCard key={tool.id} tool={tool} />)}
        </div>
      </Section>
      <Section title="Owned">
        <Card>
          <div className="card-row spaced">
            <div>
              <h3>get_weather</h3>
              <p>Public, 2 widgets, 4 functions, receipts enabled.</p>
            </div>
            <RouteButton navigate={navigate} to="/admin/tools/tool_8fa21c" variant="secondary">
              Admin
            </RouteButton>
          </div>
        </Card>
      </Section>
    </>
  );
}

export function AdminFoundationPage(_props: LaunchPageProps): ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Owner admin"
        intro="Owner-only management for tool details, pricing, widgets, secrets, trust, receipts, and logs."
        title="Manage get_weather."
      />
      <Section title="Admin surface">
        <div className="admin-grid">
          {["Details", "Pricing", "Widgets", "Secrets", "Trust", "Receipts"].map((item) => (
            <Card key={item}>
              <h3>{item}</h3>
              <p>Production controls will wire into the existing app/admin endpoints.</p>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}

export function WalletFoundationPage(_props: LaunchPageProps): ReactElement {
  return (
    <>
      <PageHeader
        actions={<Button icon="wallet" size="lg">Add Light</Button>}
        eyebrow="Wallet"
        intro="Spendable balance, top-ups, transactions, receipts, earnings, and payouts."
        title="Light balance and creator earnings."
      />
      <Section title="Balance">
        <div className="wallet-metrics">
          <Metric label="Spendable" value="1,240 Light" />
          <Metric label="Purchased" value="1,000 Light" />
          <Metric label="Earned" value="240 Light" />
          <Metric label="Escrow" value="0 Light" />
        </div>
      </Section>
      <Section title="Top-up quote">
        <Card>
          <div className="split-card">
            <div>
              <Pill>100:1</Pill>
              <h3>Users choose Light amount.</h3>
              <p>Stripe processing fees are passed through with true gross-up for card or Bank (ACH).</p>
            </div>
            <div className="quote-box">
              <span>10,000 Light</span>
              <strong>$103.30 card</strong>
              <small>$100.00 base + $3.30 processing</small>
            </div>
          </div>
        </Card>
      </Section>
    </>
  );
}

export function SettingsFoundationPage(_props: LaunchPageProps): ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Profile"
        intro="Account settings, API key lifecycle, and external-agent permission defaults."
        title="Launch-safe preferences."
      />
      <Section title="Agent access">
        <div className="two-column">
          <Card>
            <h3>API key</h3>
            <p>Create, copy once, rotate, or revoke scoped launch tokens.</p>
            <CodeBlock>{apiKeyMask}</CodeBlock>
          </Card>
          <Card>
            <h3>Default permission</h3>
            <p>New external-agent function calls default to ask until explicitly allowed.</p>
            <div className="segmented">
              <span>Always</span>
              <span className="active">Ask</span>
              <span>Never</span>
            </div>
          </Card>
        </div>
      </Section>
    </>
  );
}

function ValueProps(): ReactElement {
  const items = [
    ["01", "One core", "Plug in and inherit context, tools, balance, and preferences."],
    ["02", "No subscriptions", "Agents pay per call, only for what they use."],
    ["03", "Open marketplace", "Every published tool is discoverable and callable by any agent."],
    ["04", "Inherited power", "Every deployed tool inherits composability and distribution."],
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
      {["Context", "Tools", "Auth", "Payments"].map((item) => <span key={item}>{item}</span>)}
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
      <span className="orbit-node node-center"><Icon name="spark" size={34} /></span>
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
        {free ? <span>Free</span> : <span>{formatLight(tool.callPrice)}/call</span>}
      </div>
    </Card>
  );
}

function KeyBanner({ signedIn }: { signedIn: boolean }): ReactElement {
  return (
    <section className={signedIn ? "key-banner signed-in" : "key-banner"}>
      <span className="target-icon"><Icon name="key" /></span>
      <div>
        <h2>{signedIn ? "Your API key is included below" : "Sign in to drop your key into these snippets"}</h2>
        <p>
          {signedIn
            ? <>Copy any snippet and it is ready to run: <Mono>{apiKeyMask}</Mono>.</>
            : <>Until then they show <Mono>{apiKeyPlaceholder}</Mono>; replace it with your own token.</>}
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
}: {
  active: string;
  onPick: (target: string) => void;
}): ReactElement {
  return (
    <div className="target-picker">
      {(["MCP", "Direct"] as const).map((group) => (
        <div key={group}>
          <p className="section-label">{group === "MCP" ? "Remote MCP servers" : "CLI and API"}</p>
          <div className="target-list">
            {installTargets.filter((target) => target.group === group).map((target) => (
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
      {query ? (
        <button onClick={() => setQuery("")} type="button">Clear</button>
      ) : null}
    </label>
  );
}

function RetrievalNote({ query }: { query: string }): ReactElement {
  if (!query) {
    return (
      <div className="retrieval-note">
        Browsing all public tools · top by install
      </div>
    );
  }
  return (
    <div className="retrieval-note active">
      <span /> hybrid retrieval · semantic + lexical fallback
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
        {tool.widgets > 0 ? <span><Icon name="grid" size={12} /> {tool.widgets} widgets</span> : <span>functions only</span>}
      </div>
      <Sparkline points={tool.spark} growth={tool.growth} />
    </Card>
  );
}

function Sparkline({ growth, points }: { growth: number; points: number[] }): ReactElement {
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const polyline = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 74;
    const y = 24 - ((value - min) / range) * 24;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg className={growth > 0.1 ? "sparkline growing" : "sparkline"} viewBox="0 0 74 28" aria-hidden="true">
      <polyline points={polyline} />
    </svg>
  );
}

function PrimitivesRail({ navigate }: { navigate: (to: string) => void }): ReactElement {
  return (
    <Card className="primitives-rail">
      <p className="section-label">For agents · platform primitives</p>
      {primitives.map(([key, label, description, route]) => (
        <button
          key={key}
          onClick={() => navigate(route === "/tools/:slug" ? "/tools/get_weather" : route)}
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
        Semantic search would fall back to lexical results here. Try broader terms,
        or browse by kind.
      </EmptyState>
      <Button onClick={onClear} size="sm" variant="secondary">Clear search</Button>
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

export function FoundationNotice({ children }: { children: ReactNode }): ReactElement {
  return <EmptyState title="Ready for page port">{children}</EmptyState>;
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
