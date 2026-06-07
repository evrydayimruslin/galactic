// launch-data.jsx — shared data + palette + helpers for the Launch web mockups.
// Monochrome Ultralight system (colors_and_type.css). All money in Light (✦).
// Data shapes mirror shared/contracts/launch.ts so the mockups represent real
// backend fields: LaunchToolSummary, LaunchWidgetSummary, LaunchInstallInstruction,
// LaunchLeaderboardEntry, LaunchPlatformPrimitiveSuggestion, LaunchWalletSummary.

const L = {
  text: '#0a0a0a',
  sec: '#555555',
  mute: '#999999',
  faint: '#bbbbbb',
  bg: '#ffffff',
  raised: '#fafafa',
  sidebar: '#f9fafb',
  border: 'rgba(0,0,0,0.08)',
  borderStrong: 'rgba(0,0,0,0.15)',
  focus: 'rgba(0,0,0,0.4)',
  hover: 'rgba(0,0,0,0.04)',
  active: 'rgba(0,0,0,0.06)',
  green: '#22c55e',
  greenDeep: '#15803d',
  greenSoft: 'rgba(34,197,94,0.10)',
  blue: '#3b82f6',
  amber: '#f59e0b',
  amberDeep: '#a16207',
  amberSoft: 'rgba(245,158,11,0.10)',
  red: '#ef4444',
  violet: '#8b5cf6',
  font: "'Newsreader', Georgia, 'Times New Roman', serif",
  fontSans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', monospace",
};

// ── Capability taxonomy (read / write / net) — lifted from premium tool-page ──
const CAP_COLORS = { read: '#3b82f6', write: '#f59e0b', net: '#8b5cf6' };
const CAP_GLYPH = { read: '↘', write: '↗', net: '⇄' };

// ── Tools ────────────────────────────────────────────────────────────────────
// One tool WITH widgets (widget-primary public page) + one WITHOUT (install/run).
const TOOL_WEATHER = {
  id: 'tool_8fa21c', slug: 'get_weather', name: 'get_weather', title: 'Get Weather',
  author: '@kepler', authorColor: '#7c3aed', category: 'Weather',
  kind: 'mcp', visibility: 'public', relationship: 'public', installed: false,
  tagline: 'Hyper-local forecasts, current conditions, and severe-weather alerts — anywhere on Earth.',
  installs: 24803, callsPerDay: 38200, version: '2.4.1', signer: 'kepler.studio',
  updatedAt: '4d', freeToInstall: true,
  capabilities: [
    { kind: 'read', what: 'public weather data (NOAA, OpenWeather)' },
    { kind: 'read', what: 'user-supplied city / coordinates' },
    { kind: 'net', what: 'outbound HTTPS → api.openweather.com' },
  ],
  functions: [
    { name: 'forecast', args: '{ city, days }', price: 0.012, p50: 142, desc: '5-day hyperlocal forecast.' },
    { name: 'now', args: '{ city }', price: 0.004, p50: 68, desc: 'Current temperature + conditions.' },
    { name: 'alerts', args: '{ city }', price: 0.006, p50: 92, desc: 'Active severe-weather alerts.' },
    { name: 'historical', args: '{ city, date }', price: 0.018, p50: 280, desc: 'Look up any past day.' },
  ],
  widgets: [
    { id: 'forecast_card', label: 'Forecast card', description: '5-day outlook with hi/lo and conditions.', public: true, previewAvailable: true },
    { id: 'now_badge', label: 'Now badge', description: 'Compact current-conditions chip.', public: true, previewAvailable: true },
  ],
};

const TOOL_FX = {
  id: 'tool_3b90de', slug: 'currency_convert', name: 'currency_convert', title: 'Currency Convert',
  author: '@anchor', authorColor: '#0891b2', category: 'Finance',
  kind: 'http', visibility: 'public', relationship: 'public', installed: false,
  tagline: 'Live FX across 180+ pairs with spot and historical rates. Stripe-backed metering.',
  installs: 19402, callsPerDay: 9200, version: '1.12.0', signer: 'anchor.studio',
  updatedAt: '2d', freeToInstall: true,
  capabilities: [
    { kind: 'read', what: 'reference FX rates (ECB, openexchange)' },
    { kind: 'net', what: 'outbound HTTPS → api.openexchangerates.org' },
    { kind: 'write', what: 'no writes — read-only tool' },
  ],
  functions: [
    { name: 'convert', args: '{ from, to, amount }', price: 0.002, p50: 84, desc: 'Spot-rate conversion between any pair.' },
    { name: 'historical', args: '{ from, to, date }', price: 0.003, p50: 120, desc: 'End-of-day rate for a given date.' },
    { name: 'list_pairs', args: '{}', price: 0, p50: 40, desc: 'All 180+ supported pairs.' },
  ],
  widgets: [],
};

// ── Discover result grid (LaunchToolSummary[]) ────────────────────────────────
const DISCOVER_TOOLS = [
  { id: 'tool_8fa21c', slug: 'get_weather', name: 'get_weather', author: '@kepler', authorColor: '#7c3aed', tagline: 'Hyper-local weather, anywhere.', kind: 'mcp', installs: 24803, callPrice: 0.012, growth: 0.18, spark: [11,13,16,12,17,21,28], widgets: 2, relevance: 'semantic' },
  { id: 'tool_3b90de', slug: 'currency_convert', name: 'currency_convert', author: '@anchor', authorColor: '#0891b2', tagline: 'Live FX with 180+ base currencies.', kind: 'http', installs: 19402, callPrice: 0.003, growth: 0.06, spark: [14,15,16,15,17,18,19], widgets: 0, relevance: 'semantic' },
  { id: 'tool_st', slug: 'stripe_subscribe', name: 'stripe.subscribe', author: 'stripe', authorColor: '#635bff', tagline: 'Charge & meter from any agent.', kind: 'http', installs: 18204, callPrice: 0.024, growth: 0.31, spark: [10,9,12,16,18,22,30], widgets: 1, relevance: 'semantic' },
  { id: 'tool_pd', slug: 'pdf_parse', name: 'pdf.parse', author: '@vellum', authorColor: '#ea580c', tagline: 'Layout-aware PDF text + tables.', kind: 'mcp', installs: 15211, callPrice: 0.018, growth: 0.12, spark: [12,13,14,15,16,17,19], widgets: 0, relevance: 'lexical' },
  { id: 'tool_gh', slug: 'github_diff', name: 'github.diff', author: '@octo', authorColor: '#0a0a0a', tagline: 'Branch diff + review comments.', kind: 'mcp', installs: 14093, callPrice: 0.005, free: true, growth: 0.09, spark: [13,14,14,15,16,16,17], widgets: 0, relevance: 'lexical' },
  { id: 'tool_mp', slug: 'maps_route', name: 'maps.route', author: '@cartography', authorColor: '#10b981', tagline: 'Driving, walking, transit ETAs.', kind: 'http', installs: 12705, callPrice: 0.008, free: true, growth: 0.21, spark: [9,10,11,12,13,15,16], widgets: 1, relevance: 'lexical' },
];

// ── Platform primitives (LaunchPlatformPrimitiveSuggestion[]) ─────────────────
const PRIMITIVES = [
  { primitive: 'install', label: 'Install Ultralight', description: 'Connect the MCP/API layer to an existing agent.', route: '/install' },
  { primitive: 'discover', label: 'Discover tools', description: 'Find public agent-native tools and widgets.', route: '/discover' },
  { primitive: 'wallet', label: 'Light wallet', description: 'Spendable Light for installs, calls, hosting.', route: '/wallet' },
  { primitive: 'widgets', label: 'Widgets', description: 'Open public UI surfaces attached to tools.', route: '/tools/:slug' },
];

// ── Leaderboards (LaunchLeaderboardEntry[]) ───────────────────────────────────
// Builder = earnings_light. Fee-credit = fee_waived_light (fee-waiver endpoint).
const LEADERBOARD_BUILDER = [
  { rank: 1, name: '@kepler', color: '#7c3aed', value: 4820.4, eventCount: 268000, featured: 'get_weather' },
  { rank: 2, name: 'stripe', color: '#635bff', value: 3910.2, eventCount: 142000, featured: 'stripe.subscribe' },
  { rank: 3, name: '@anchor', color: '#0891b2', value: 2740.8, eventCount: 198000, featured: 'currency_convert' },
  { rank: 4, name: '@vellum', color: '#ea580c', value: 1690.0, eventCount: 64000, featured: 'pdf.parse' },
  { rank: 5, name: '@cartography', color: '#10b981', value: 1120.5, eventCount: 88000, featured: 'maps.route' },
];
const LEADERBOARD_FEE = [
  { rank: 1, name: 'stripe', color: '#635bff', value: 1284.0, eventCount: 5120 },
  { rank: 2, name: '@kepler', color: '#7c3aed', value: 942.6, eventCount: 4380 },
  { rank: 3, name: '@octo', color: '#0a0a0a', value: 770.2, eventCount: 2010 },
  { rank: 4, name: '@anchor', color: '#0891b2', value: 615.4, eventCount: 3160 },
  { rank: 5, name: '@hex', color: '#22c55e', value: 402.1, eventCount: 1890 },
];

// ── Install targets (LaunchInstallInstruction[]) — config text from facade ────
const API_KEY = 'ulk_live_7Qp2sR9vK3mD8xN4';
const API_KEY_MASK = 'ulk_live_••••••••••••4xN4';
const MCP_URL = 'https://api.ultralight.dev/mcp/platform';
const BASE_URL = 'https://api.ultralight.dev';

function genericMcpConfig(key) {
  return JSON.stringify({
    mcpServers: { ultralight: { url: MCP_URL, headers: { Authorization: 'Bearer ' + key } } },
  }, null, 2);
}

const INSTALL_TARGETS = [
  { target: 'claude_code', label: 'Claude Code', group: 'MCP', requiresApiKey: true,
    description: 'Add Ultralight as a remote MCP server for an existing Claude Code workspace.',
    steps: ['Create an Ultralight API token from Settings.', 'Set ULTRALIGHT_API_KEY in your shell or Claude Code environment.', 'Add the remote MCP server with an Authorization header.'],
    config: (k) => genericMcpConfig(k) },
  { target: 'cursor', label: 'Cursor', group: 'MCP', requiresApiKey: true,
    description: "Install the Ultralight MCP server in Cursor's MCP configuration.",
    steps: ['Open Cursor MCP settings.', 'Add the ultralight server entry below.', 'Reload Cursor so agents can discover Ultralight tools.'],
    config: (k) => genericMcpConfig(k) },
  { target: 'codex', label: 'Codex', group: 'MCP', requiresApiKey: true,
    description: 'Connect Codex to the same remote MCP endpoint used by other agents.',
    steps: ['Create an Ultralight API token.', 'Add a remote MCP server named ultralight.', 'Use the platform MCP endpoint and Authorization header below.'],
    config: (k) => `[mcp_servers.ultralight]\nurl = "${MCP_URL}"\nheaders = { Authorization = "Bearer ${k}" }` },
  { target: 'openai_remote_mcp', label: 'OpenAI Remote MCP', group: 'MCP', requiresApiKey: true,
    description: 'Register Ultralight as a remote MCP server for OpenAI agent runtimes that support MCP tools.',
    steps: ['Use the platform MCP endpoint as the server URL.', 'Pass your Ultralight API token as a bearer Authorization header.', 'Allow the agent to list tools before calling specific tools.'],
    config: (k) => JSON.stringify({ server_url: MCP_URL, authorization: 'Bearer ' + k }, null, 2) },
  { target: 'generic_mcp', label: 'Generic MCP', group: 'MCP', requiresApiKey: true,
    description: 'Use the standard remote MCP server declaration for any compatible agent.',
    steps: ["Copy the server configuration into your agent's MCP config.", 'Replace the API token placeholder with an Ultralight API token.', 'Restart the agent or refresh its tool registry.'],
    config: (k) => genericMcpConfig(k) },
  { target: 'cli', label: 'CLI', group: 'Direct', requiresApiKey: true,
    description: 'Use the Ultralight CLI to login, upload, test, and run deployed tools.',
    steps: ['Install the ultralightpro package.', 'Run ultralight login --token <your-token>.', 'Run ultralight upload . from a deployable tool directory.'],
    config: (k) => `npm install -g ultralightpro\nultralight login --token ${k}\nultralight upload .` },
  { target: 'api', label: 'Direct API', group: 'Direct', requiresApiKey: true,
    description: 'Call launch and platform endpoints directly with an Ultralight API token.',
    steps: ['Create an API token from Settings.', 'Send Authorization: Bearer <token> on authenticated requests.', 'Read /api/launch/status and /openapi.json before calling.'],
    config: (k) => `curl "${BASE_URL}/api/launch/status"\ncurl -H "Authorization: Bearer ${k}" \\\n  "${BASE_URL}/api/launch/library"` },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtN(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}
function fmtLight(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(3);
}
function sparkPoints(arr, w = 56, h = 16) {
  const max = Math.max(...arr), min = Math.min(...arr), range = max - min || 1;
  const dx = w / (arr.length - 1);
  return arr.map((v, i) => `${(i * dx).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ');
}

window.LaunchData = {
  L, CAP_COLORS, CAP_GLYPH,
  TOOL_WEATHER, TOOL_FX, DISCOVER_TOOLS, PRIMITIVES,
  LEADERBOARD_BUILDER, LEADERBOARD_FEE,
  INSTALL_TARGETS, API_KEY, API_KEY_MASK, MCP_URL, BASE_URL,
  fmtN, fmtLight, sparkPoints,
};
