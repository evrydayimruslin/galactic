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
  visibility: "public" | "unlisted";
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
  const tool = toolDetails[slug];
  const widgetId = new URLSearchParams(window.location.search).get("widget");

  if (!tool) return <ToolNotFoundPage navigate={navigate} slug={slug} />;
  if (widgetId) return <WidgetOpenSurface navigate={navigate} tool={tool} widgetId={widgetId} />;
  return <ToolDetailSurface navigate={navigate} tool={tool} />;
}

function ToolDetailSurface({
  navigate,
  tool,
}: {
  navigate: (to: string) => void;
  tool: ToolDetailFixture;
}): ReactElement {
  const hasWidgets = tool.widgetList.length > 0;
  const [installed, setInstalled] = useState(false);
  const [tab, setTab] = useState<"widgets" | "functions" | "details">(
    hasWidgets ? "widgets" : "functions",
  );
  const [selectedWidgetId, setSelectedWidgetId] = useState(tool.widgetList[0]?.id || "");
  const [selectedFunctionName, setSelectedFunctionName] = useState(tool.functions[0]?.name || "");

  return (
    <div className="launch-page-narrow tool-page">
      <button className="back-link" onClick={() => navigate("/store")} type="button">
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
            {hasWidgets ? (
              <Button
                icon="grid"
                onClick={() => navigate(`/tools/${tool.slug}?widget=${selectedWidgetId}`)}
                size="lg"
                variant="secondary"
              >
                Open widget
              </Button>
            ) : (
              <RouteButton icon="copy" navigate={navigate} size="lg" to="/install" variant="secondary">
                Copy MCP config
              </RouteButton>
            )}
          </div>
        </div>
      </section>

      <div className="tool-tabs" role="tablist" aria-label="Tool page sections">
        {hasWidgets ? (
          <button className={tab === "widgets" ? "active" : ""} onClick={() => setTab("widgets")} type="button">
            Widgets
          </button>
        ) : null}
        <button className={tab === "functions" ? "active" : ""} onClick={() => setTab("functions")} type="button">
          Functions
        </button>
        <button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")} type="button">
          Details
        </button>
      </div>

      <div className="tool-detail-layout">
        <main className="tool-main-panel">
          {tab === "widgets" ? (
            <ToolWidgetsPanel
              navigate={navigate}
              selectedWidgetId={selectedWidgetId}
              setSelectedWidgetId={setSelectedWidgetId}
              tool={tool}
            />
          ) : null}
          {tab === "functions" ? (
            <ToolFunctionsPanel
              selectedFunctionName={selectedFunctionName}
              setSelectedFunctionName={setSelectedFunctionName}
              tool={tool}
            />
          ) : null}
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
  const widget = tool.widgetList.find((item) => item.id === selectedWidgetId) || tool.widgetList[0];

  if (!widget) {
    return (
      <EmptyState icon="grid" title="No public widget">
        This tool exposes functions only. Agents can still install and call it through MCP or API.
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
      <WidgetSelector selected={widget.id} setSelected={setSelectedWidgetId} widgets={tool.widgetList} />
      <WidgetStateSelector state={state} setState={setState} />
      <WidgetSandboxShell state={state} tool={tool} widget={widget} />
    </Card>
  );
}

function ToolFunctionsPanel({
  selectedFunctionName,
  setSelectedFunctionName,
  tool,
}: {
  selectedFunctionName: string;
  setSelectedFunctionName: (name: string) => void;
  tool: ToolDetailFixture;
}): ReactElement {
  const selectedFunction =
    tool.functions.find((fn) => fn.name === selectedFunctionName) || tool.functions[0];

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
      <FunctionSandboxCard fn={selectedFunction} tool={tool} />
    </div>
  );
}

function FunctionSandboxCard({
  fn,
  tool,
}: {
  fn: ToolFunctionFixture;
  tool: ToolDetailFixture;
}): ReactElement {
  const [ran, setRan] = useState(false);

  return (
    <Card className="function-sandbox-card">
      <div className="function-sandbox-head">
        <div>
          <Mono>{fn.name}</Mono>
          <p>{fn.description}</p>
        </div>
        <Pill>{formatToolPrice(fn.price)}/call</Pill>
      </div>
      <div className="arg-grid">
        {fn.args.length > 0 ? fn.args.map((arg) => (
          <label key={arg}>
            <span>{arg}</span>
            <input defaultValue={argDefault(arg)} placeholder={argHint(arg)} />
          </label>
        )) : <p className="muted-note">No arguments.</p>}
      </div>
      <div className="manual-run-row">
        <Button icon="arrow" onClick={() => setRan(true)} size="sm">
          Run
        </Button>
        <span>Manual website runs create receipts; external agents still obey saved permission.</span>
      </div>
      {ran ? (
        <div className="function-response">
          <p className="section-label">response · 200 · receipt queued</p>
          <pre>{JSON.stringify(functionResponse(tool.slug, fn.name), null, 2)}</pre>
        </div>
      ) : null}
      <PermissionControl fn={fn} />
    </Card>
  );
}

function PermissionControl({ fn }: { fn: ToolFunctionFixture }): ReactElement {
  const [permission, setPermission] = useState(fn.permission);
  const [savedPermission, setSavedPermission] = useState(fn.permission);
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
          onClick={() => setSavedPermission(permission)}
          size="sm"
          variant={dirty ? "primary" : "secondary"}
        >
          {dirty ? "Save" : "Saved"}
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
            <ToolCapabilityPill capability={capability} key={`${capability.kind}-${capability.text}`} />
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
            <p>Signed manifest, receipts, and capability disclosure are live.</p>
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
          <MetaPair label="from" value={minPrice > 0 ? `✦${formatLight(minPrice)}` : "Free"} />
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
          {["Claude Code", "Cursor", "Codex", "MCP", "CLI", "API"].map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

type WidgetState = "ready" | "loading" | "error" | "setup";

function WidgetOpenSurface({
  navigate,
  tool,
  widgetId,
}: {
  navigate: (to: string) => void;
  tool: ToolDetailFixture;
  widgetId: string;
}): ReactElement {
  const widget = tool.widgetList.find((item) => item.id === widgetId) || tool.widgetList[0];
  const [state, setState] = useState<WidgetState>("ready");

  if (!widget) return <ToolDetailSurface navigate={navigate} tool={tool} />;

  return (
    <div className="launch-page-narrow widget-open-page">
      <button className="back-link" onClick={() => navigate(`/tools/${tool.slug}`)} type="button">
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
        <span>Calls relay through Ultralight; the widget never sees your API key.</span>
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
        <span className="state-icon error"><Icon name="shield" /></span>
        <h3>Could not load this widget</h3>
        <p>The widget UI function failed to render. Your balance was not charged.</p>
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
        <span className="state-icon setup"><Icon name="shield" /></span>
        <h3>Finish setup to run this widget</h3>
        <p>{tool.name} needs one connection before this widget can run. Your API key is never shared.</p>
        <div className="card-row">
          <Button size="sm">Go to setup</Button>
          <Button size="sm" variant="ghost">Why?</Button>
        </div>
      </div>
    );
  }

  if (tool.slug === "get_weather" && widget.id === "now_badge") return <WeatherNowBadge />;
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

function GenericToolWidget({ tool }: { tool: ToolDetailFixture }): ReactElement {
  return (
    <div className="generic-widget">
      <Avatar color={tool.color} name={tool.author} />
      <h3>{tool.title}</h3>
      <p>{tool.summary}</p>
      <Mono>{primaryFunctionFor(tool).name} ready</Mono>
    </div>
  );
}

function MetaPair({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="meta-pair">
      <span>{label}</span>
      <Mono>{value}</Mono>
    </div>
  );
}

function ToolCapabilityPill({ capability }: { capability: ToolCapability }): ReactElement {
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
        actions={<RouteButton navigate={navigate} size="lg" to="/store">Back to Store</RouteButton>}
        eyebrow="Public tool page"
        intro="This public tool is not available in the launch fixture set yet."
        title={slug}
      />
      <EmptyState icon="search" title="Tool not found">
        Public tool pages will load from the launch tool contract when the live store
        API is connected.
      </EmptyState>
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
      ? [{ id: "overview", label: "Overview", description: "Public tool UI preview." }]
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
          description: "Five-day outlook with highs, lows, and current conditions.",
        },
        {
          id: "now_badge",
          label: "Now badge",
          description: "Compact current-conditions chip for quick agent responses.",
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
          description: "Small UI for creating and confirming subscription actions.",
        },
      ],
    },
  };

  return { ...base, ...overrides[tool.slug] };
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
  return responses[`${slug}.${name}`] || { ok: true, receipt: "rec_launch_demo" };
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
