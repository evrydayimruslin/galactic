import "./styles.css";

import {
  LAUNCH_DEFERRED_CAPABILITIES,
  LAUNCH_INCLUDED_CAPABILITIES,
  LAUNCH_INSTALL_TARGETS,
  LAUNCH_PLATFORM_PRIMITIVES,
  LAUNCH_SCOPE_CONTRACT,
  type LaunchApiKeyCreateResponse,
  type LaunchApiKeySummary,
  type LaunchDiscoveryRequest,
  type LaunchDiscoveryResponse,
  type LaunchDiscoveryRetrievalSummary,
  type LaunchInstallInstruction,
  type LaunchInstallResponse,
  type LaunchInstallTarget,
  type LaunchLeaderboardEntry,
  type LaunchLeaderboardKind,
  type LaunchLeaderboardResponse,
  type LaunchLibraryResponse,
  type LaunchPlatformPrimitiveSuggestion,
  type LaunchToolAdminSummary,
  type LaunchToolInstallContext,
  type LaunchFunctionRunResponse,
  type LaunchFunctionSummary,
  type LaunchToolKind,
  type LaunchToolSummary,
  type LaunchTrustCard,
  type LaunchWalletDetailKind,
  type LaunchWalletDetailResponse,
  type LaunchWalletEarningSummary,
  type LaunchWalletPageInfo,
  type LaunchWalletPayoutSummary,
  type LaunchWalletReceiptSummary,
  type LaunchWalletSummary,
  type LaunchWalletTransaction,
  type LaunchWidgetRenderResponse,
  type LaunchWidgetSummary,
} from "../../../shared/contracts/launch.ts";
import { launchApi } from "./lib/api";
import {
  accountRoutes,
  primaryRoutes,
  type ResolvedLaunchRoute,
  resolveLaunchRoute,
} from "./lib/routes";

const app = document.getElementById("app");

if (!app) {
  throw new Error("Launch app root not found");
}

const appRoot = app;
type InstallState =
  | { status: "idle" }
  | { status: "loading"; key: string; tool?: string }
  | {
    status: "loaded";
    key: string;
    instructions: LaunchInstallInstruction[];
    toolInstall?: LaunchToolInstallContext | null;
  }
  | { status: "error"; key: string; message: string };
type LibraryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; library: LaunchLibraryResponse }
  | { status: "error"; message: string };
type AdminToolState =
  | { status: "loading" }
  | {
    status: "loaded";
    admin: LaunchToolAdminSummary;
    trustCard?: LaunchTrustCard;
  }
  | { status: "error"; message: string };
type PublicToolState =
  | { status: "loading" }
  | {
    status: "loaded";
    tool: LaunchToolSummary;
    trustCard?: LaunchTrustCard;
    functions: LaunchFunctionSummary[];
    generatedAt?: string;
  }
  | { status: "error"; message: string };
type DiscoverState =
  | { status: "idle" }
  | { status: "loading"; key: string; request: LaunchDiscoveryRequest }
  | { status: "loaded"; key: string; response: LaunchDiscoveryResponse }
  | { status: "error"; key: string; message: string };
type LeaderboardPeriod = LaunchLeaderboardResponse["period"];
type LeaderboardState =
  | { status: "idle" }
  | { status: "loading"; key: string; period: LeaderboardPeriod }
  | {
    status: "loaded";
    key: string;
    builder: LaunchLeaderboardResponse;
    feeCredit: LaunchLeaderboardResponse;
  }
  | { status: "error"; key: string; message: string };
type WalletState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; wallet: LaunchWalletSummary }
  | { status: "error"; message: string };
type WalletTab = "topup" | "transactions" | "receipts" | "earnings" | "payouts";
type WalletDetailItem =
  | LaunchWalletTransaction
  | LaunchWalletReceiptSummary
  | LaunchWalletEarningSummary
  | LaunchWalletPayoutSummary;
interface WalletDetailLoaded {
  kind: LaunchWalletDetailKind;
  items: WalletDetailItem[];
  page: LaunchWalletPageInfo;
  generatedAt: string;
}
type WalletDetailState =
  | {
    status: "loading";
    key: string;
    kind: LaunchWalletDetailKind;
    tool?: string;
  }
  | {
    status: "loaded";
    key: string;
    response: WalletDetailLoaded;
  }
  | {
    status: "loadingMore";
    key: string;
    response: WalletDetailLoaded;
  }
  | {
    status: "error";
    key: string;
    kind: LaunchWalletDetailKind;
    message: string;
    response?: WalletDetailLoaded;
  };
type ApiKeysState =
  | { status: "idle" }
  | { status: "loading" }
  | {
    status: "loaded";
    apiKeys: LaunchApiKeySummary[];
    reveal?: LaunchApiKeyCreateResponse | null;
  }
  | { status: "error"; message: string };
type WidgetRenderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; response: LaunchWidgetRenderResponse }
  | { status: "error"; message: string };
type FunctionRunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; response: LaunchFunctionRunResponse }
  | { status: "error"; message: string };

let installState: InstallState = { status: "idle" };
let libraryState: LibraryState = { status: "idle" };
let discoverState: DiscoverState = { status: "idle" };
let leaderboardState: LeaderboardState = { status: "idle" };
let walletState: WalletState = { status: "idle" };
let apiKeysState: ApiKeysState = { status: "idle" };
const adminToolStates = new Map<string, AdminToolState>();
const publicToolStates = new Map<string, PublicToolState>();
const widgetRenderStates = new Map<string, WidgetRenderState>();
const functionRunStates = new Map<string, FunctionRunState>();
const walletDetailStates = new Map<string, WalletDetailState>();

window.addEventListener("popstate", render);
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const link = target.closest<HTMLAnchorElement>("a[data-route]");
  if (!link) return;
  const url = new URL(link.href);
  if (url.origin !== window.location.origin) return;
  event.preventDefault();
  navigate(`${url.pathname}${url.search}${url.hash}`);
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>("button[data-copy-install]");
  if (!button) return;
  event.preventDefault();
  void copyInstallConfig(button);
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>(
    "button[data-copy-api-token]",
  );
  if (!button) return;
  event.preventDefault();
  void copyApiToken(button);
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>(
    "button[data-render-widget]",
  );
  if (!button) return;
  event.preventDefault();
  void renderWidget(button);
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>(
    "button[data-revoke-api-key]",
  );
  if (!button) return;
  event.preventDefault();
  void revokeApiKey(button);
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>(
    "button[data-wallet-load-more]",
  );
  if (!button) return;
  event.preventDefault();
  void loadMoreWalletDetail(button);
});
document.addEventListener("submit", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.matches("form[data-discover-search]")) return;
  event.preventDefault();
  navigate(discoverUrlFromForm(target));
});
document.addEventListener("submit", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.matches("form[data-function-run-form]")) return;
  event.preventDefault();
  void runToolFunctionFromForm(target);
});
document.addEventListener("submit", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.matches("form[data-api-key-form]")) return;
  event.preventDefault();
  void createApiKey(target);
});

render();

function render(): void {
  const route = resolveLaunchRoute(window.location.pathname);
  ensureRouteData(route);
  appRoot.innerHTML = layout(route);
}

function navigate(path: string): void {
  window.history.pushState({}, "", path);
  render();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function ensureRouteData(route: ResolvedLaunchRoute): void {
  if (
    (route.definition.key === "home" || route.definition.key === "install" ||
      route.definition.key === "settings")
  ) {
    const request = currentInstallRequest();
    const key = installKey(request);
    if (installState.status === "idle" || installState.key !== key) {
      installState = { status: "loading", key, tool: request.tool };
      void loadInstallInstructions(request, key);
    }
  }

  if (route.definition.key === "library" && libraryState.status === "idle") {
    libraryState = { status: "loading" };
    void loadLibrary();
  }

  if (route.definition.key === "store") {
    const request = currentDiscoverRequest();
    const key = discoverKey(request);
    if (discoverState.status === "idle" || discoverState.key !== key) {
      discoverState = { status: "loading", key, request };
      void loadDiscover(request, key);
    }

    const period = currentLeaderboardPeriod();
    const rankingsKey = leaderboardKey(period);
    if (
      leaderboardState.status === "idle" ||
      leaderboardState.key !== rankingsKey
    ) {
      leaderboardState = { status: "loading", key: rankingsKey, period };
      void loadLeaderboards(period, rankingsKey);
    }
  }

  if (route.definition.key === "wallet" && walletState.status === "idle") {
    walletState = { status: "loading" };
    void loadWallet();
  }

  if (route.definition.key === "wallet") {
    const kind = currentWalletDetailKind();
    if (kind) {
      const tool = kind === "earnings" || kind === "receipts"
        ? currentWalletToolFilter()
        : undefined;
      const key = walletDetailKey(kind, tool);
      if (!walletDetailStates.has(key)) {
        walletDetailStates.set(key, { status: "loading", key, kind, tool });
        void loadWalletDetail(kind, key, { tool });
      }
    }
  }

  if (route.definition.key === "settings" && apiKeysState.status === "idle") {
    apiKeysState = { status: "loading" };
    void loadApiKeys();
  }

  if (route.definition.key === "adminTool") {
    const id = route.params.id || "";
    if (id && !adminToolStates.has(id)) {
      adminToolStates.set(id, { status: "loading" });
      void loadAdminTool(id);
    }
  }

  if (route.definition.key === "tool") {
    const slug = route.params.slug || "";
    if (slug && !publicToolStates.has(slug)) {
      publicToolStates.set(slug, { status: "loading" });
      void loadPublicTool(slug);
    }
  }
}

async function loadInstallInstructions(
  request: { tool?: string },
  key: string,
): Promise<void> {
  try {
    const response: LaunchInstallResponse = await launchApi.install(request);
    installState = {
      status: "loaded",
      key,
      instructions: sortInstallInstructions(response.instructions),
      toolInstall: response.toolInstall || null,
    };
  } catch (err) {
    installState = {
      status: "error",
      key,
      message: err instanceof Error
        ? err.message
        : "Install instructions unavailable",
    };
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (
    route.definition.key === "home" || route.definition.key === "install" ||
    route.definition.key === "settings"
  ) {
    const currentKey = installKey(currentInstallRequest());
    if (currentKey === key) render();
  }
}

async function loadLibrary(): Promise<void> {
  try {
    libraryState = {
      status: "loaded",
      library: await launchApi.library(),
    };
  } catch (err) {
    libraryState = {
      status: "error",
      message: err instanceof Error ? err.message : "Library unavailable",
    };
  }

  if (
    resolveLaunchRoute(window.location.pathname).definition.key === "library"
  ) {
    render();
  }
}

async function loadDiscover(
  request: LaunchDiscoveryRequest,
  key: string,
): Promise<void> {
  try {
    discoverState = {
      status: "loaded",
      key,
      response: await launchApi.store(request),
    };
  } catch (err) {
    discoverState = {
      status: "error",
      key,
      message: err instanceof Error ? err.message : "Discovery unavailable",
    };
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (
    route.definition.key === "store" &&
    discoverKey(currentDiscoverRequest()) === key
  ) {
    render();
  }
}

async function loadLeaderboards(
  period: LeaderboardPeriod,
  key: string,
): Promise<void> {
  try {
    const [builder, feeCredit] = await Promise.all([
      launchApi.leaderboard("builder", { period, limit: 10 }),
      launchApi.leaderboard("fee_credit", { period, limit: 10 }),
    ]);
    leaderboardState = {
      status: "loaded",
      key,
      builder,
      feeCredit,
    };
  } catch (err) {
    leaderboardState = {
      status: "error",
      key,
      message: err instanceof Error ? err.message : "Leaderboards unavailable",
    };
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (
    route.definition.key === "store" &&
    leaderboardKey(currentLeaderboardPeriod()) === key
  ) {
    render();
  }
}

async function loadWallet(): Promise<void> {
  try {
    const response = await launchApi.wallet();
    walletState = {
      status: "loaded",
      wallet: response.wallet,
    };
  } catch (err) {
    walletState = {
      status: "error",
      message: err instanceof Error ? err.message : "Wallet unavailable",
    };
  }

  if (
    resolveLaunchRoute(window.location.pathname).definition.key === "wallet"
  ) {
    render();
  }
}

async function loadWalletDetail(
  kind: LaunchWalletDetailKind,
  key: string,
  request: { cursor?: string | null; tool?: string | null } = {},
): Promise<void> {
  try {
    const response = normalizeWalletDetailResponse(
      await launchApi.walletDetail(kind, {
        limit: 25,
        cursor: request.cursor,
        tool: request.tool,
      }),
    );
    const previous = walletDetailStates.get(key);
    walletDetailStates.set(key, {
      status: "loaded",
      key,
      response: previous?.status === "loadingMore"
        ? mergeWalletDetailResponse(previous.response, response)
        : response,
    });
  } catch (err) {
    const previous = walletDetailStates.get(key);
    walletDetailStates.set(key, {
      status: "error",
      key,
      kind,
      message: err instanceof Error ? err.message : "Wallet detail unavailable",
      response: previous?.status === "loaded" ||
          previous?.status === "loadingMore"
        ? previous.response
        : undefined,
    });
  }

  if (
    resolveLaunchRoute(window.location.pathname).definition.key === "wallet"
  ) {
    render();
  }
}

async function loadApiKeys(): Promise<void> {
  try {
    const response = await launchApi.apiKeys();
    apiKeysState = {
      status: "loaded",
      apiKeys: response.apiKeys,
      reveal: apiKeysState.status === "loaded" ? apiKeysState.reveal : null,
    };
  } catch (err) {
    apiKeysState = {
      status: "error",
      message: err instanceof Error ? err.message : "API keys unavailable",
    };
  }

  if (
    resolveLaunchRoute(window.location.pathname).definition.key === "settings"
  ) {
    render();
  }
}

async function loadAdminTool(id: string): Promise<void> {
  try {
    const response = await launchApi.toolAdmin(id);
    adminToolStates.set(id, {
      status: "loaded",
      admin: response.admin,
      trustCard: response.trustCard,
    });
  } catch (err) {
    adminToolStates.set(id, {
      status: "error",
      message: err instanceof Error ? err.message : "Tool admin unavailable",
    });
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (route.definition.key === "adminTool" && route.params.id === id) {
    render();
  }
}

async function loadPublicTool(slug: string): Promise<void> {
  try {
    const [toolResponse, widgetsResponse, functionsResponse] = await Promise.all([
      launchApi.tool(slug),
      launchApi.toolWidgets(slug),
      launchApi.toolFunctions(slug),
    ]);
    publicToolStates.set(slug, {
      status: "loaded",
      tool: {
        ...toolResponse.tool,
        widgets: widgetsResponse.widgets,
      },
      trustCard: toolResponse.trustCard,
      functions: functionsResponse.functions,
      generatedAt: functionsResponse.generatedAt,
    });
  } catch (err) {
    publicToolStates.set(slug, {
      status: "error",
      message: err instanceof Error ? err.message : "Tool unavailable",
    });
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (route.definition.key === "tool" && route.params.slug === slug) {
    render();
  }
}

function layout(route: ResolvedLaunchRoute): string {
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="/" data-route>
          <span class="brand-mark">UL</span>
          <span>
            <strong>Ultralight</strong>
            <small>Launch MVP</small>
          </span>
        </a>
        <nav class="nav-section" aria-label="Primary">
          ${
    primaryRoutes().map((item) => navLink(item.path, item.label, route)).join(
      "",
    )
  }
        </nav>
        <nav class="nav-section nav-section-secondary" aria-label="Account">
          ${
    accountRoutes().map((item) => navLink(item.path, item.label, route)).join(
      "",
    )
  }
        </nav>
      </aside>
      <main class="main">
        ${pageHeader(route)}
        ${pageBody(route)}
      </main>
    </div>
  `;
}

function navLink(
  path: string,
  label: string,
  route: ResolvedLaunchRoute,
): string {
  const active = route.definition.path === path;
  return `<a class="nav-link ${
    active ? "active" : ""
  }" href="${path}" data-route>${label}</a>`;
}

function pageHeader(route: ResolvedLaunchRoute): string {
  const eyebrow = route.definition.key === "home"
    ? "External-agent tool layer"
    : route.definition.label;
  return `
    <header class="page-header">
      <div>
        <p class="eyebrow">${eyebrow}</p>
        <h1>${pageTitle(route)}</h1>
      </div>
      <div class="header-actions">
        <a class="button secondary" href="/install" data-route>Install</a>
        <a class="button primary" href="/store" data-route>Browse store</a>
      </div>
    </header>
  `;
}

function pageTitle(route: ResolvedLaunchRoute): string {
  switch (route.definition.key) {
    case "home":
      return "Deploy tools for the agents you already use";
    case "tool":
      if (
        route.params.slug &&
        publicToolStates.get(route.params.slug)?.status === "loaded"
      ) {
        const state = publicToolStates.get(route.params.slug);
        if (state?.status === "loaded") return state.tool.name;
      }
      return `Tool: ${escapeHtml(route.params.slug || "unknown")}`;
    case "adminTool":
      return `Tool admin: ${escapeHtml(route.params.id || "unknown")}`;
    default:
      return route.definition.label;
  }
}

function pageBody(route: ResolvedLaunchRoute): string {
  switch (route.definition.key) {
    case "home":
      return homePage();
    case "install":
      return installPage();
    case "library":
      return libraryPage();
    case "store":
      return discoverPage();
    case "tool":
      return toolPage(route.params.slug || "");
    case "wallet":
      return walletPage();
    case "settings":
      return settingsPage();
    case "adminTool":
      return adminToolPage(route.params.id || "");
  }
}

function homePage(): string {
  return `
    <section class="hero-band">
      <p>${escapeHtml(LAUNCH_SCOPE_CONTRACT.thesis)}</p>
      <div class="hero-grid">
        ${metric("Public surface", "Website + MCP + CLI/API")}
        ${metric("Launch UI", "Widgets only")}
        ${metric("Model layer", "External agents")}
      </div>
    </section>
    <section class="content-grid two">
      <div class="panel">
        <h2>MVP Surfaces</h2>
        <div class="pill-grid">
          ${
    LAUNCH_INCLUDED_CAPABILITIES.map((item) => pill(labelize(item), "included"))
      .join("")
  }
        </div>
      </div>
      <div class="panel">
        <h2>Deferred Publicly</h2>
        <div class="pill-grid">
          ${
    LAUNCH_DEFERRED_CAPABILITIES.map((item) => pill(labelize(item), "deferred"))
      .join("")
  }
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <h2>External Agent Loop</h2>
        <p>Install once, then let the agent discover tools, call them, and return widget links when UI matters.</p>
      </div>
      <div class="step-row">
        ${
    ["Install", "Discover", "Inspect", "Call", "Open widget", "Show receipt"]
      .map(step).join("")
  }
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <h2>Install Into Existing Agents</h2>
        <p>The launch path starts with MCP, CLI, or direct API access from the agents people already use.</p>
      </div>
      ${installPreview()}
      <div class="action-row">
        <a class="button primary" href="/install" data-route>View all install targets</a>
      </div>
    </section>
  `;
}

function installPage(): string {
  return `
    ${toolInstallContextPanel()}
    <section class="panel">
      <div class="section-heading">
        <h2>Install Targets</h2>
        <p>Copy the config for your agent, then use the same Ultralight account for hosted tools, widgets, and Light receipts.</p>
      </div>
      ${installInstructionList()}
    </section>
    ${agentApiPanel()}
    ${
    apiContractPanel([
      "GET /api/launch/install",
      "GET /api/launch/status",
      "GET /api/launch/openapi.json",
    ])
  }
  `;
}

function libraryPage(): string {
  return `
    <section class="split-layout">
      <div class="panel">
        <div class="section-heading">
          <h2>Owned Tools</h2>
          <p>Owned tools route to launch-safe admin settings for visibility, pricing, widgets, and trust.</p>
        </div>
        ${libraryToolList("owned")}
      </div>
      <div class="panel">
        <div class="section-heading">
          <h2>Installed Tools</h2>
          <p>Installed tools open widgets when available.</p>
        </div>
        ${libraryToolList("installed")}
      </div>
    </section>
    ${apiContractPanel(["GET /api/launch/library"])}
  `;
}

function discoverPage(): string {
  const request = currentDiscoverRequest();
  const leaderboardPeriod = currentLeaderboardPeriod();
  return `
    <section class="panel">
      <form class="toolbar discover-form" data-discover-search>
        <input class="search" name="query" type="search" value="${
    escapeAttribute(request.query || "")
  }" placeholder="Search public tools, widgets, pages, and platform primitives" />
        <select class="filter-select" name="kind" aria-label="Tool kind">
          ${discoverKindOptions(request.kind || "all")}
        </select>
        <button class="button primary" type="submit">Search</button>
      </form>
      <div class="section-heading">
        <h2>Public Tools</h2>
        <p>Search across public tool metadata, widget declarations, and launch platform primitives.</p>
      </div>
      ${discoverResults()}
    </section>
    <section class="content-grid two">
      <div class="panel">
        <div class="section-heading">
          <h2>Platform Suggestions</h2>
          <p>Platform primitives are suggested beside tools so external agents can deploy, publish, price, and inspect.</p>
        </div>
        ${discoverPrimitiveSuggestions()}
      </div>
      <div class="panel">
        <div class="section-heading">
          <h2>Retrieval Contract</h2>
          <p>Launch discovery reports whether results came from semantic embeddings, lexical fallback, or a hybrid path.</p>
        </div>
        <div class="summary-list">
          ${summaryRow("Query", request.query || "All public tools")}
          ${summaryRow("Kind", labelize(request.kind || "all"))}
          ${summaryRow("Widgets", "Included")}
          ${summaryRow("Limit", String(request.limit || 24))}
          ${
    summaryRow("Leaderboard period", leaderboardPeriodLabel(leaderboardPeriod))
  }
          ${discoveryRetrievalRows()}
        </div>
      </div>
    </section>
    ${leaderboardSection(leaderboardPeriod)}
    ${
    apiContractPanel([
      "GET /api/launch/store",
      "GET /api/launch/leaderboard",
      "GET /api/launch/platform-primitives",
    ])
  }
  `;
}

function toolPage(slug: string): string {
  if (!slug) {
    return emptyState("No tool selected", "Choose a tool from the Store.");
  }

  const state = publicToolStates.get(slug);
  if (!state || state.status === "loading") {
      return `
      <section class="panel">
        ${
      emptyState("Loading tool", "Fetching public profile and widget surfaces.")
    }
      </section>
      ${
    apiContractPanel([
      "GET /api/launch/tools/:id",
      "GET /api/launch/tools/:id/widgets",
      "GET /api/launch/tools/:id/functions",
      "POST /api/launch/tools/:id/functions/:functionName/run",
    ])
  }
    `;
  }

  if (state.status === "error") {
    return `
      <section class="panel">
        ${emptyState("Tool unavailable", state.message)}
      </section>
      ${
      apiContractPanel([
        "GET /api/launch/tools/:id",
        "GET /api/launch/tools/:id/widgets",
        "GET /api/launch/tools/:id/functions",
        "POST /api/launch/tools/:id/functions/:functionName/run",
      ])
    }
    `;
  }

  const { tool, trustCard, functions } = state;
  return `
    <section class="content-grid two">
      <div class="panel">
        <div class="section-heading">
          <h2>${escapeHtml(tool.name)}</h2>
          <p>${escapeHtml(tool.description || "No description provided.")}</p>
        </div>
        ${publicToolSummary(tool)}
        <div class="action-row tool-actions standalone-actions">
          ${
    tool.installUrl ? routeButton("Install", tool.installUrl, "primary") : ""
  }
          ${tool.adminUrl ? routeButton("Admin", tool.adminUrl) : ""}
        </div>
        ${toolTagList(tool)}
      </div>
      <div class="panel">
        <div class="section-heading">
          <h2>Widget Surface</h2>
          <p>Widgets are the only public launch UI surface.</p>
        </div>
        ${publicWidgetSurface(tool)}
      </div>
    </section>
    ${publicFunctionsPanel(tool, functions)}
    ${trustPanel(trustCard)}
    ${
    apiContractPanel([
      "GET /api/launch/tools/:id",
      "GET /api/launch/tools/:id/widgets",
      "GET /api/launch/tools/:id/functions",
      "POST /api/launch/tools/:id/functions/:functionName/run",
    ])
  }
  `;
}

function walletPage(): string {
  const walletApiRoutes = [
    "GET /api/launch/wallet",
    "GET /api/launch/wallet/transactions",
    "GET /api/launch/wallet/receipts",
    "GET /api/launch/wallet/earnings",
    "GET /api/launch/wallet/payouts",
    "GET /api/launch/wallet/topup/quote",
    "POST /api/launch/wallet/topup/intent",
  ];
  if (walletState.status === "error") {
    return `
      <section class="panel">
        ${emptyState("Wallet unavailable", walletState.message)}
      </section>
      ${apiContractPanel(walletApiRoutes)}
    `;
  }

  if (walletState.status !== "loaded") {
    return `
      <section class="panel">
        ${
      emptyState("Loading wallet", "Fetching Light balance and payout status.")
    }
      </section>
      ${apiContractPanel(walletApiRoutes)}
    `;
  }

  const { wallet } = walletState;
  const tab = currentWalletTab();
  return `
    <section class="wallet-grid">
      <div class="panel">
        <h2>Light Balance</h2>
        <div class="balance-box primary-balance">
          <span>Total balance</span>
          <strong>${escapeHtml(wallet.balance.display)}</strong>
        </div>
        <div class="mini-metric-grid">
          ${walletMiniMetric("Spendable", wallet.spendableBalance.display)}
          ${
    walletMiniMetric("Purchased", wallet.depositBalance?.display || "0 Light")
  }
          ${
    walletMiniMetric("Earned", wallet.earnedBalance?.display || "0 Light")
  }
          ${
    walletMiniMetric("Escrow", wallet.escrowBalance?.display || "0 Light")
  }
        </div>
      </div>
      <div class="panel">
        <h2>Wallet Actions</h2>
        <div class="settings-list">
          ${
    walletActionRow(
      "Add Light",
      "Fund tool calls, installs, and hosting.",
      wallet.topUpUrl,
      wallet.canTopUp,
    )
  }
          ${
    walletActionRow(
      "Transactions",
      "Review Light movement and charges.",
      wallet.transactionsUrl,
      true,
    )
  }
          ${
    walletActionRow(
      "Receipts",
      "Trace monetized tool usage and purchases.",
      wallet.receiptsUrl,
      true,
    )
  }
        </div>
      </div>
    </section>
    <section class="panel">
      <nav class="tab-row" aria-label="Wallet sections">
        ${walletTabLink("topup", "Top-up", tab)}
        ${walletTabLink("transactions", "Transactions", tab)}
        ${walletTabLink("receipts", "Receipts", tab)}
        ${walletTabLink("earnings", "Earnings", tab)}
        ${walletTabLink("payouts", "Payouts", tab)}
      </nav>
      ${walletTabPanel(wallet, tab)}
    </section>
    ${apiContractPanel(walletApiRoutes)}
  `;
}

function settingsPage(): string {
  return `
    <section class="panel">
      <div class="section-heading">
        <h2>Launch-Safe Account Settings</h2>
        <p>Settings stays focused on API key, install defaults, and account basics. BYOK is intentionally not a public launch surface.</p>
      </div>
      <div class="settings-list">
        ${
    settingsRow("Install defaults", "Preferred agent target and endpoint copy.")
  }
        ${
    settingsRow(
      "Public profile",
      "Display name and builder leaderboard identity.",
    )
  }
      </div>
    </section>
    <section class="content-grid two">
      <div class="panel">
        <div class="section-heading">
          <h2>Create API Key</h2>
          <p>Keys power CLI, MCP configs, direct API calls, and widget rendering from existing agents.</p>
        </div>
        ${apiKeyCreateForm()}
      </div>
      <div class="panel">
        <div class="section-heading">
          <h2>Active API Keys</h2>
          <p>Plaintext tokens are reveal-once; this list only shows metadata.</p>
        </div>
        ${apiKeyList()}
      </div>
    </section>
    ${
    apiContractPanel([
      "GET /api/launch/api-keys",
      "POST /api/launch/api-keys",
      "DELETE /api/launch/api-keys/:id",
    ])
  }
  `;
}

function adminToolPage(id: string): string {
  const state = adminToolStates.get(id);
  if (!id) {
    return emptyState("No tool selected", "Choose an owned tool from Library.");
  }

  if (!state || state.status === "loading") {
    return `
      <section class="panel">
        ${
      emptyState("Loading tool admin", "Fetching owner-only launch settings.")
    }
      </section>
      ${apiContractPanel(["GET /api/launch/admin/tools/:id"])}
    `;
  }

  if (state.status === "error") {
    return `
      <section class="panel">
        ${emptyState("Tool admin unavailable", state.message)}
      </section>
      ${apiContractPanel(["GET /api/launch/admin/tools/:id"])}
    `;
  }

  const { admin } = state;
  const tool = admin.tool;
  return `
    <section class="content-grid two">
      <div class="panel">
        <div class="section-heading">
          <h2>Owner Admin</h2>
          <p>Launch-safe management for ${escapeHtml(tool.name)}.</p>
        </div>
        ${toolAdminSummary(admin)}
        <div class="action-row tool-actions">
          ${
    tool.publicUrl ? routeButton("Open public page", tool.publicUrl) : ""
  }
          ${
    admin.receiptsUrl
      ? `<a class="button secondary" href="${
        escapeAttribute(admin.receiptsUrl)
      }">Receipts</a>`
      : ""
  }
          ${
    admin.logsUrl
      ? `<a class="button secondary" href="${
        escapeAttribute(admin.logsUrl)
      }">Logs</a>`
      : ""
  }
        </div>
      </div>
      <div class="panel">
        <div class="section-heading">
          <h2>Widget Surfaces</h2>
          <p>Widgets are the only public launch UI exposed here.</p>
        </div>
        ${widgetList(tool)}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <h2>Editable Fields</h2>
        <p>The launch facade declares which internal settings are safe to surface.</p>
      </div>
      <div class="pill-grid">
        ${
    admin.editableFields.map((field) => pill(labelize(field), "included")).join(
      "",
    )
  }
      </div>
    </section>
    ${apiContractPanel(["GET /api/launch/admin/tools/:id"])}
  `;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${
    escapeHtml(value)
  }</strong></div>`;
}

function pill(label: string, kind: "included" | "deferred"): string {
  return `<span class="pill ${kind}">${escapeHtml(label)}</span>`;
}

function step(label: string): string {
  return `<div class="step"><span>${escapeHtml(label)}</span></div>`;
}

function installPreview(): string {
  if (installState.status === "loaded") {
    return `
      <div class="target-grid preview-targets">
        ${
      installState.instructions.slice(0, 3).map((instruction) =>
        installTargetCard(instruction.target, instruction.description)
      ).join("")
    }
      </div>
    `;
  }

  return `
    <div class="target-grid preview-targets">
      ${
    LAUNCH_INSTALL_TARGETS.slice(0, 3).map((target) =>
      installTargetCard(target, installTargetDescription(target))
    ).join("")
  }
    </div>
  `;
}

function installInstructionList(): string {
  if (installState.status === "error") {
    return emptyState(
      "Install instructions unavailable",
      installState.message,
    );
  }

  if (installState.status !== "loaded") {
    return `
      <div class="install-list loading">
        ${
      LAUNCH_INSTALL_TARGETS.map((target) =>
        installTargetCard(target, "Loading install config...")
      )
        .join("")
    }
      </div>
    `;
  }

  return `
    <div class="install-list">
      ${
    installState.instructions.map((instruction) =>
      installInstructionCard(instruction)
    ).join("")
  }
    </div>
  `;
}

function toolInstallContextPanel(): string {
  const requestedTool = currentInstallRequest().tool;
  if (!requestedTool) return "";
  if (installState.status === "error") {
    return `
      <section class="panel">
        ${emptyState("Tool install unavailable", installState.message)}
      </section>
    `;
  }
  if (installState.status !== "loaded") {
    return `
      <section class="panel">
        ${
      emptyState(
        "Loading tool install",
        "Fetching the tool-specific agent handoff.",
      )
    }
      </section>
    `;
  }
  const context = installState.toolInstall;
  if (!context) return "";
  return `
    <section class="panel tool-install-panel">
      <div class="section-heading">
        <h2>Install ${escapeHtml(context.tool.name)}</h2>
        <p>${
    escapeHtml(
      context.tool.description ||
        "Tool-specific install handoff for external agents.",
    )
  }</p>
      </div>
      <div class="content-grid two">
        <div class="summary-list">
          ${summaryRow("Tool", context.selectedToolSlug)}
          ${summaryRow("MCP endpoint", context.platformMcpUrl)}
          ${summaryRow("Public page", context.publicToolUrl)}
          ${summaryRow("Scoped key", apiKeyRecommendationLabel(context))}
        </div>
        <div class="settings-list">
          ${
    context.agentHandoff.map((item) => settingsRow("Agent step", item)).join("")
  }
        </div>
      </div>
      ${
    context.widgetUrls.length
      ? `
        <div class="widget-list install-widget-list">
          ${
        context.widgetUrls.map((widget) => `
            <a class="widget-card widget-selector" href="${
          escapeAttribute(widget.openUrl)
        }" data-route>
              <div>
                <strong>${escapeHtml(widget.label)}</strong>
                <span>${escapeHtml(widget.id)}</span>
              </div>
              <span class="tool-kind">${
          widget.renderUrl ? "Renderable" : "Open"
        }</span>
            </a>
          `).join("")
      }
        </div>
      `
      : ""
  }
    </section>
  `;
}

function apiKeyRecommendationLabel(context: LaunchToolInstallContext): string {
  const scopes = context.recommendedApiKey.scopes?.join(", ") || "apps:call";
  const appIds = context.recommendedApiKey.appIds?.join(", ") ||
    context.tool.id;
  return `${scopes}; app ${appIds}`;
}

function installInstructionCard(instruction: LaunchInstallInstruction): string {
  return `
    <article class="install-card">
      <div class="install-card-header">
        <div>
          <h3>${escapeHtml(instruction.label)}</h3>
          <p>${escapeHtml(instruction.description)}</p>
        </div>
        <button class="button secondary compact" type="button" data-copy-install="${
    escapeHtml(instruction.target)
  }">Copy</button>
      </div>
      <ol class="install-steps">
        ${
    instruction.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
  }
      </ol>
      ${
    instruction.configText
      ? `<pre class="config-block"><code>${
        escapeHtml(instruction.configText)
      }</code></pre>`
      : ""
  }
    </article>
  `;
}

function agentApiPanel(): string {
  const links = [
    {
      label: "Launch status",
      href: "/api/launch/status",
      description: "Machine-readable route list, capabilities, and agent loop.",
    },
    {
      label: "OpenAPI",
      href: "/api/launch/openapi.json",
      description: "Launch facade schema for direct API agents and scripts.",
    },
    {
      label: "MCP discovery",
      href: "/.well-known/mcp.json",
      description: "Platform MCP transport and capability metadata.",
    },
    {
      label: "Platform MCP",
      href: "/mcp/platform",
      description: "JSON-RPC endpoint for tools/list and tools/call.",
    },
  ];
  return `
    <section class="panel">
      <div class="section-heading">
        <h2>Agent API</h2>
        <p>External agents can discover the launch contract before calling tools or asking for credentials.</p>
      </div>
      <div class="api-link-grid">
        ${
    links.map((link) => `
          <a class="api-link-card" href="${escapeAttribute(link.href)}">
            <strong>${escapeHtml(link.label)}</strong>
            <code>${escapeHtml(link.href)}</code>
            <span>${escapeHtml(link.description)}</span>
          </a>
        `).join("")
  }
      </div>
    </section>
  `;
}

function installTargetCard(
  target: LaunchInstallTarget,
  description = installTargetDescription(target),
): string {
  return `
    <article class="target-card">
      <span>${escapeHtml(labelize(target))}</span>
      <small>${escapeHtml(description)}</small>
    </article>
  `;
}

function discoverResults(): string {
  if (discoverState.status === "error") {
    return emptyState("Discovery unavailable", discoverState.message);
  }

  if (discoverState.status !== "loaded") {
    return emptyState(
      "Loading discovery",
      "Fetching public tools and widgets.",
    );
  }

  const results = discoverState.response.results;
  if (results.length === 0) {
    return emptyState(
      "No tools found",
      "Try a broader query or switch the kind filter back to all.",
    );
  }

  return `
    <div class="result-count">${results.length} public result${
    results.length === 1 ? "" : "s"
  }</div>
    <div class="tool-list discover-results">
      ${results.map((tool) => toolCard(tool)).join("")}
    </div>
  `;
}

function discoverPrimitiveSuggestions(): string {
  const suggestions = discoverState.status === "loaded"
    ? discoverState.response.platformPrimitives || []
    : LAUNCH_PLATFORM_PRIMITIVES.map((primitive) => ({
      primitive,
      label: labelize(primitive),
      description: "Indexed launch primitive",
      similarity: null,
    } satisfies LaunchPlatformPrimitiveSuggestion));

  if (suggestions.length === 0) {
    return emptyState(
      "No platform suggestions",
      "Try deploy, wallet, pricing, install, or publish.",
    );
  }

  return `
    <div class="primitive-grid">
      ${
    suggestions.slice(0, 8).map((suggestion) =>
      primitiveSuggestionCard(suggestion)
    ).join("")
  }
    </div>
  `;
}

function discoveryRetrievalRows(): string {
  const retrieval = discoverState.status === "loaded"
    ? discoverState.response.retrieval
    : null;
  if (!retrieval) {
    return `
      ${summaryRow("Retrieval", "Loading")}
      ${summaryRow("Embedding model", "Pending")}
    `;
  }
  return `
    ${summaryRow("Retrieval", labelize(retrieval.mode))}
    ${
    summaryRow(
      "Embedding model",
      retrieval.embeddingModel || "Not used",
    )
  }
    ${
    summaryRow("Embedded sources", sourceListLabel(retrieval.embeddedSources))
  }
    ${
    summaryRow(
      "Fallback sources",
      sourceListLabel(retrieval.fallbackSources),
    )
  }
    ${
    retrieval.fallbackReason
      ? summaryRow("Fallback reason", retrieval.fallbackReason)
      : ""
  }
  `;
}

function leaderboardSection(period: LeaderboardPeriod): string {
  return `
    <section class="panel leaderboard-shell">
      <div class="section-heading">
        <h2>Launch Leaderboards</h2>
        <p>Builder rankings and fee-credit rankings are exposed through the same launch facade external agents use.</p>
      </div>
      ${leaderboardPeriodControls(period)}
      <div class="leaderboard-grid">
        ${
    leaderboardPanel(
      "builder",
      "Builder Leaderboard",
      "Ranks public builders by launch-visible activity and earnings.",
    )
  }
        ${
    leaderboardPanel(
      "fee_credit",
      "Fee-Credit Leaderboard",
      "Shows creators earning fee-waiver credit through monetized usage.",
    )
  }
      </div>
    </section>
  `;
}

function leaderboardPeriodControls(selected: LeaderboardPeriod): string {
  const periods: Array<{ period: LeaderboardPeriod; label: string }> = [
    { period: "30d", label: "30 days" },
    { period: "90d", label: "90 days" },
    { period: "all", label: "All time" },
  ];
  return `
    <nav class="tab-row leaderboard-periods" aria-label="Leaderboard period">
      ${
    periods.map(({ period, label }) => `
        <a class="tab-link ${period === selected ? "selected" : ""}" href="${
      leaderboardPeriodUrl(period)
    }" data-route>
          ${escapeHtml(label)}
        </a>
      `).join("")
  }
    </nav>
  `;
}

function leaderboardPanel(
  kind: LaunchLeaderboardKind,
  title: string,
  description: string,
): string {
  let body = "";
  if (leaderboardState.status === "error") {
    body = emptyState("Leaderboard unavailable", leaderboardState.message);
  } else if (leaderboardState.status !== "loaded") {
    body = emptyState("Loading rankings", "Fetching launch leaderboard data.");
  } else {
    const response = kind === "builder"
      ? leaderboardState.builder
      : leaderboardState.feeCredit;
    body = leaderboardEntryList(response.entries, kind);
  }

  return `
    <article class="leaderboard-board">
      <div class="leaderboard-board-header">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>
        </div>
        <span class="tool-kind">${escapeHtml(labelize(kind))}</span>
      </div>
      ${body}
    </article>
  `;
}

function leaderboardEntryList(
  entries: LaunchLeaderboardEntry[],
  kind: LaunchLeaderboardKind,
): string {
  if (entries.length === 0) {
    return emptyState(
      "No rankings yet",
      "Ranking data will appear as public tools are used and monetized.",
    );
  }

  return `
    <ol class="leaderboard-list">
      ${
    entries.slice(0, 10).map((entry) => leaderboardEntry(entry, kind)).join("")
  }
    </ol>
  `;
}

function leaderboardEntry(
  entry: LaunchLeaderboardEntry,
  kind: LaunchLeaderboardKind,
): string {
  const name = entry.displayName || entry.profileSlug || entry.userId ||
    "Unknown builder";
  const profile = entry.profileSlug ? `@${entry.profileSlug}` : shortUserId(
    entry.userId,
  );
  const events = typeof entry.eventCount === "number"
    ? `${entry.eventCount.toLocaleString("en-US")} ${
      entry.eventCount === 1 ? "event" : "events"
    }`
    : kind === "builder"
    ? "Builder score"
    : "Fee-credit activity";
  const featuredTool = entry.featuredTool?.slug
    ? `<a href="/tools/${
      encodeURIComponent(entry.featuredTool.slug)
    }" data-route>${escapeHtml(entry.featuredTool.name)}</a>`
    : "";

  return `
    <li class="leaderboard-entry">
      <span class="rank-badge">${entry.rank}</span>
      <div class="leaderboard-identity">
        <strong>${escapeHtml(name)}</strong>
        <span>${escapeHtml(profile)}</span>
        ${
    featuredTool
      ? `<span class="leaderboard-meta">Featured tool ${featuredTool}</span>`
      : ""
  }
      </div>
      <div class="leaderboard-value">
        <strong>${escapeHtml(entry.value.display)}</strong>
        <span>${escapeHtml(events)}</span>
      </div>
    </li>
  `;
}

function primitiveSuggestionCard(
  suggestion: LaunchPlatformPrimitiveSuggestion,
): string {
  const route = suggestion.route && !suggestion.route.includes(":")
    ? suggestion.route
    : null;
  const similarity = typeof suggestion.similarity === "number"
    ? `${Math.round(suggestion.similarity * 100)}%`
    : null;

  return `
    <article class="primitive-card suggestion">
      <strong>${escapeHtml(suggestion.label)}</strong>
      <span>${escapeHtml(suggestion.description)}</span>
      <div class="primitive-card-footer">
        ${similarity ? `<small>${escapeHtml(similarity)}</small>` : ""}
        ${route ? routeButton("Open", route) : ""}
      </div>
    </article>
  `;
}

function discoverKindOptions(selected: LaunchToolKind | "all"): string {
  const options: Array<LaunchToolKind | "all"> = [
    "all",
    "mcp",
    "http",
    "gpu",
    "markdown",
  ];
  return options.map((option) =>
    `<option value="${option}" ${option === selected ? "selected" : ""}>${
      escapeHtml(labelize(option))
    }</option>`
  ).join("");
}

function walletMiniMetric(label: string, value: string): string {
  return `
    <div class="wallet-mini-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function walletActionRow(
  label: string,
  description: string,
  href: string | null | undefined,
  enabled: boolean,
): string {
  const action = href && enabled
    ? `<a class="button secondary compact" href="${
      escapeAttribute(href)
    }" data-route>Open</a>`
    : `<span class="status-pill muted">Unavailable</span>`;
  return `
    <div class="settings-row action-settings-row">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(description)}</span>
      ${action}
    </div>
  `;
}

function walletTabLink(
  tab: WalletTab,
  label: string,
  selected: WalletTab,
): string {
  return `
    <a class="tab-link ${
    tab === selected ? "selected" : ""
  }" href="/wallet?tab=${tab}" data-route>
      ${escapeHtml(label)}
    </a>
  `;
}

function walletTabPanel(wallet: LaunchWalletSummary, tab: WalletTab): string {
  switch (tab) {
    case "topup":
      return walletTopupPanel(wallet);
    case "transactions":
      return walletTransactionsPanel(wallet);
    case "receipts":
      return walletReceiptsPanel(wallet);
    case "earnings":
      return walletEarningsPanel(wallet);
    case "payouts":
      return walletPayoutPanel(wallet);
  }
}

function walletTopupPanel(wallet: LaunchWalletSummary): string {
  return `
    <div class="wallet-tab-panel">
      <div class="summary-list">
        ${summaryRow("Current spendable", wallet.spendableBalance.display)}
        ${
    summaryRow("Purchased balance", wallet.depositBalance?.display || "0 Light")
  }
        ${summaryRow("Can top up", wallet.canTopUp ? "Yes" : "No")}
      </div>
      <div class="action-row standalone-actions">
        ${
    wallet.topUpUrl && wallet.canTopUp
      ? routeButton("Add Light", wallet.topUpUrl, "primary")
      : ""
  }
      </div>
    </div>
  `;
}

function walletTransactionsPanel(wallet: LaunchWalletSummary): string {
  const state = walletDetailState("transactions");
  const rows = walletDetailRows<LaunchWalletTransaction>(
    state,
    wallet.recentTransactions || [],
  );
  return `
    <div class="wallet-tab-panel">
      ${
    rows.length
      ? `
        <div class="settings-list wallet-row-list">
          ${rows.map(walletTransactionRow).join("")}
        </div>
      `
      : walletDetailEmptyState(
        state,
        "No transactions yet",
        "Wallet funding and charges will appear here.",
      )
  }
      ${walletDetailFooter(state)}
    </div>
  `;
}

function walletReceiptsPanel(wallet: LaunchWalletSummary): string {
  const state = walletDetailState("receipts");
  const rows = walletDetailRows<LaunchWalletReceiptSummary>(
    state,
    wallet.recentReceipts || [],
  );
  return `
    <div class="wallet-tab-panel">
      ${
    rows.length
      ? `
        <div class="settings-list wallet-row-list">
          ${rows.map(walletReceiptRow).join("")}
        </div>
      `
      : walletDetailEmptyState(
        state,
        "No receipts yet",
        "Tool-call receipts will appear after monetized usage.",
      )
  }
      ${walletDetailFooter(state)}
    </div>
  `;
}

function walletEarningsPanel(wallet: LaunchWalletSummary): string {
  const state = walletDetailState("earnings");
  const rows = walletDetailRows<LaunchWalletEarningSummary>(
    state,
    wallet.recentEarnings || [],
  );
  return `
    <div class="wallet-tab-panel">
      <div class="summary-list">
        ${
    summaryRow("Earned balance", wallet.earnedBalance?.display || "0 Light")
  }
        ${
    summaryRow("Escrow balance", wallet.escrowBalance?.display || "0 Light")
  }
        ${summaryRow("Payout status", wallet.payoutStatus?.label || "Unknown")}
      </div>
      ${walletEarningsFilter(wallet, state)}
      ${
    rows.length
      ? `
        <div class="settings-list wallet-row-list">
          ${rows.map(walletEarningRow).join("")}
        </div>
      `
      : walletDetailEmptyState(
        state,
        "No earnings yet",
        "Creator earnings appear after paid tool usage.",
      )
  }
      ${walletDetailFooter(state)}
      <p class="muted-copy">Creator earnings accrue as Light. Payout readiness is derived from the launch wallet facade.</p>
    </div>
  `;
}

function walletPayoutPanel(wallet: LaunchWalletSummary): string {
  const status = wallet.payoutStatus;
  const state = walletDetailState("payouts");
  const rows = walletDetailRows<LaunchWalletPayoutSummary>(
    state,
    wallet.recentPayouts || [],
  );
  return `
    <div class="wallet-tab-panel">
      <div class="payout-status ${status?.kind || "unavailable"}">
        <strong>${
    escapeHtml(status?.label || "Payout status unavailable")
  }</strong>
        <span>${
    escapeHtml(status?.description || "Payout details are not available yet.")
  }</span>
      </div>
      <div class="summary-list">
        ${
    summaryRow("Earned balance", wallet.earnedBalance?.display || "0 Light")
  }
        ${
    summaryRow("Escrow balance", wallet.escrowBalance?.display || "0 Light")
  }
      </div>
      ${
    rows.length
      ? `
        <div class="settings-list wallet-row-list">
          ${rows.map(walletPayoutRow).join("")}
        </div>
      `
      : walletDetailEmptyState(
        state,
        "No payouts yet",
        "Payout records will appear after creator withdrawals.",
      )
  }
      ${walletDetailFooter(state)}
    </div>
  `;
}

function walletDetailRows<T extends WalletDetailItem>(
  state: WalletDetailState,
  fallback: T[],
): T[] {
  const response = walletLoadedDetailResponse(state);
  if (response) return response.items as T[];
  return fallback;
}

function walletLoadedDetailResponse(
  state: WalletDetailState,
): WalletDetailLoaded | null {
  if (state.status === "loaded" || state.status === "loadingMore") {
    return state.response;
  }
  return state.status === "error" ? state.response || null : null;
}

function walletDetailEmptyState(
  state: WalletDetailState,
  title: string,
  description: string,
): string {
  if (state.status === "loading") {
    return emptyState(
      "Loading wallet rows",
      "Fetching the latest ledger page.",
    );
  }
  if (state.status === "error") {
    return emptyState("Wallet rows unavailable", state.message);
  }
  return emptyState(title, description);
}

function walletDetailFooter(state: WalletDetailState): string {
  if (state.status === "loading") {
    return `<p class="muted-copy wallet-loading-copy">Loading latest page...</p>`;
  }
  if (state.status === "error" && state.response) {
    return `<p class="muted-copy wallet-error-copy">${
      escapeHtml(state.message)
    }</p>`;
  }
  if (state.status !== "loaded" && state.status !== "loadingMore") return "";
  const { response, key } = state;
  if (!response.page.hasMore || !response.page.nextCursor) {
    return `<p class="muted-copy wallet-loading-copy">End of ledger.</p>`;
  }
  const loading = state.status === "loadingMore";
  return `
    <div class="wallet-load-more">
      <button
        class="button secondary"
        type="button"
        data-wallet-load-more
        data-wallet-kind="${escapeAttribute(response.kind)}"
        data-wallet-key="${escapeAttribute(key)}"
        data-wallet-cursor="${escapeAttribute(response.page.nextCursor)}"
        ${
    currentWalletToolFilter()
      ? `data-wallet-tool="${escapeAttribute(currentWalletToolFilter() || "")}"`
      : ""
  }
        ${loading ? "disabled" : ""}
      >${loading ? "Loading..." : "Load more"}</button>
    </div>
  `;
}

function walletEarningsFilter(
  wallet: LaunchWalletSummary,
  state: WalletDetailState,
): string {
  const selected = currentWalletToolFilter();
  const tools = new Set<string>();
  for (const row of wallet.recentEarnings || []) {
    if (row.appId) tools.add(row.appId);
  }
  const response = walletLoadedDetailResponse(state);
  if (response) {
    for (const item of response.items as LaunchWalletEarningSummary[]) {
      if (item.appId) tools.add(item.appId);
    }
  }
  if (selected) tools.add(selected);

  const options = ["", ...tools].slice(0, 10);
  if (options.length <= 1) return "";
  return `
    <nav class="wallet-filter-row" aria-label="Earnings tool filter">
      ${
    options.map((tool) => {
      const active = (selected || "") === tool;
      const label = tool ? tool : "All tools";
      return `<a class="tab-link ${active ? "selected" : ""}" href="${
        walletEarningsFilterUrl(tool || null)
      }" data-route>${escapeHtml(label)}</a>`;
    }).join("")
  }
    </nav>
  `;
}

function walletEarningsFilterUrl(tool: string | null): string {
  const params = new URLSearchParams();
  params.set("tab", "earnings");
  if (tool) params.set("tool", tool);
  return `/wallet?${params.toString()}`;
}

function walletTransactionRow(row: LaunchWalletTransaction): string {
  return walletLedgerRow({
    title: row.description,
    meta: [
      labelize(row.category),
      row.appName || row.appId || "",
      row.createdAt ? formatDate(row.createdAt) : "Unknown date",
    ],
    amount: row.amount.display,
    positive: row.amount.light > 0,
  });
}

function walletReceiptRow(row: LaunchWalletReceiptSummary): string {
  return walletLedgerRow({
    title: row.appName || row.appId || "Tool receipt",
    meta: [
      row.functionName || "function",
      row.success ? "success" : "failed",
      row.createdAt ? formatDate(row.createdAt) : "Unknown date",
    ],
    amount: row.total.display,
    positive: false,
  });
}

function walletEarningRow(row: LaunchWalletEarningSummary): string {
  return walletLedgerRow({
    title: row.appId || "Tool earnings",
    meta: [
      labelize(row.reason),
      row.functionName || "tool usage",
      row.createdAt ? formatDate(row.createdAt) : "Unknown date",
    ],
    amount: row.amount.display,
    positive: row.amount.light >= 0,
  });
}

function walletPayoutRow(row: LaunchWalletPayoutSummary): string {
  return walletLedgerRow({
    title: row.status,
    meta: [
      row.completedAt ? `completed ${formatDate(row.completedAt)}` : "",
      row.createdAt ? `created ${formatDate(row.createdAt)}` : "Unknown date",
    ],
    amount: row.amount.display,
    positive: false,
  });
}

function walletLedgerRow(input: {
  title: string;
  meta: string[];
  amount: string;
  positive: boolean;
}): string {
  const meta = input.meta.filter(Boolean).join(" · ");
  return `
    <div class="settings-row wallet-ledger-row">
      <strong>${escapeHtml(input.title)}</strong>
      <span>${escapeHtml(meta)}</span>
      <b class="wallet-amount ${input.positive ? "positive" : ""}">${
    escapeHtml(input.amount)
  }</b>
    </div>
  `;
}

function publicToolSummary(tool: LaunchToolSummary): string {
  return `
    <div class="summary-list">
      ${summaryRow("Slug", tool.slug)}
      ${summaryRow("Kind", labelize(tool.kind))}
      ${summaryRow("Visibility", labelize(tool.visibility))}
      ${summaryRow("Relationship", labelize(tool.relationship))}
      ${summaryRow("Owner", ownerLabel(tool))}
      ${summaryRow("Pricing", pricingLabel(tool))}
      ${summaryRow("Widgets", widgetsLabel(tool))}
      ${summaryRow("Updated", updatedLabel(tool))}
    </div>
  `;
}

function toolTagList(tool: LaunchToolSummary): string {
  if (!tool.tags || tool.tags.length === 0) return "";
  return `
    <div class="pill-grid tool-tags">
      ${
    tool.tags.slice(0, 12).map((tag) => pill(labelize(tag), "included")).join(
      "",
    )
  }
    </div>
  `;
}

function publicWidgetSurface(tool: LaunchToolSummary): string {
  if (tool.widgets.length === 0) {
    return emptyState(
      "No widgets declared",
      "Agents can still install and call this tool through Ultralight.",
    );
  }

  const selected = selectedWidget(tool.widgets);
  const renderState =
    widgetRenderStates.get(widgetRenderKey(tool.slug, selected.id)) ||
    { status: "idle" } satisfies WidgetRenderState;
  return `
    <div class="widget-frame public-widget-frame">
      <div class="widget-toolbar">
        <span>${escapeHtml(selected.label)}</span>
        ${
    selected.openUrl
      ? `<a class="button secondary compact" href="${
        escapeAttribute(selected.openUrl)
      }" data-route>Open</a>`
      : ""
  }
        ${
    selected.renderUrl
      ? `<button class="button primary compact" type="button" data-render-widget="${
        escapeAttribute(selected.id)
      }" data-render-tool="${escapeAttribute(tool.slug)}">Render</button>`
      : ""
  }
      </div>
      <div class="widget-body public-widget-body">
        <div class="summary-list">
          ${summaryRow("Widget ID", selected.id)}
          ${summaryRow("Description", selected.description || "Widget surface")}
          ${summaryRow("Public", selected.public ? "Yes" : "No")}
          ${summaryRow("Detail API", selected.detailUrl || "Unavailable")}
          ${summaryRow("Render API", selected.renderUrl || "No UI function")}
          ${
    summaryRow(
      "Preview",
      selected.previewAvailable ? "Available" : "Metadata only",
    )
  }
        </div>
        ${widgetRenderPanel(renderState)}
      </div>
    </div>
    <div class="widget-list surface-selector">
      ${
    tool.widgets.map((widget) =>
      publicWidgetSelector(tool, widget, selected.id)
    )
      .join("")
  }
    </div>
  `;
}

function widgetRenderPanel(state: WidgetRenderState): string {
  if (state.status === "loading") {
    return emptyState(
      "Rendering widget",
      "Calling the widget UI function through the launch runtime.",
    );
  }
  if (state.status === "error") {
    return emptyState("Widget render failed", state.message);
  }
  if (state.status === "loaded") {
    const response = state.response;
    if (!response.success || !response.render?.html) {
      return emptyState(
        "Widget render failed",
        response.error?.message || "The widget did not return renderable HTML.",
      );
    }
    return `
      <div class="rendered-widget-shell">
        <iframe class="rendered-widget-frame" sandbox="allow-scripts" srcdoc="${
      escapeAttribute(response.render.html)
    }"></iframe>
        <div class="summary-list render-receipt">
          ${summaryRow("Receipt", response.render.receiptId || "No receipt")}
          ${
      summaryRow(
        "Duration",
        response.render.durationMs === null ||
          response.render.durationMs === undefined
          ? "Unknown"
          : `${response.render.durationMs} ms`,
      )
    }
          ${summaryRow("Version", response.render.version || "Unknown")}
        </div>
      </div>
    `;
  }
  return "";
}

function publicWidgetSelector(
  tool: LaunchToolSummary,
  widget: LaunchWidgetSummary,
  selectedId: string,
): string {
  const href = widget.openUrl ||
    `/tools/${encodeURIComponent(tool.slug)}?widget=${
      encodeURIComponent(widget.id)
    }`;
  return `
    <a class="widget-card widget-selector ${
    widget.id === selectedId ? "selected" : ""
  }" href="${escapeAttribute(href)}" data-route>
      <div>
        <strong>${escapeHtml(widget.label)}</strong>
        <span>${escapeHtml(widget.description || "Widget surface")}</span>
      </div>
      <span class="tool-kind">${widget.previewAvailable ? "UI" : "Data"}</span>
    </a>
  `;
}

function selectedWidget(widgets: LaunchWidgetSummary[]): LaunchWidgetSummary {
  const selectedId = new URLSearchParams(window.location.search).get("widget");
  return widgets.find((widget) => widget.id === selectedId) || widgets[0];
}

function trustPanel(trustCard: unknown): string {
  const trust = asRecord(trustCard);
  if (!trust) return "";
  const capabilitySummary = asRecord(trust.capability_summary);
  const permissions = asStringArray(trust.permissions);
  const requiredSecrets = asStringArray(trust.required_secrets);
  const perUserSecrets = asStringArray(trust.per_user_secrets);
  const signedManifest = trust.signed_manifest === true ? "Signed" : "Unsigned";
  const receipts = asRecord(trust.execution_receipts)?.enabled === true
    ? "Enabled"
    : "Unknown";
  const capabilities = capabilitySummary
    ? Object.entries(capabilitySummary)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => labelize(key))
      .join(", ") || "None declared"
    : "Unknown";

  return `
    <section class="panel">
      <div class="section-heading">
        <h2>Trust</h2>
        <p>Launch-safe trust metadata for external agents and users.</p>
      </div>
      <div class="summary-list trust-grid">
        ${summaryRow("Runtime", asString(trust.runtime) || "Unknown")}
        ${summaryRow("Manifest", signedManifest)}
        ${summaryRow("Receipts", receipts)}
        ${summaryRow("Capabilities", capabilities)}
        ${
    summaryRow(
      "Permissions",
      permissions.length ? permissions.join(", ") : "None declared",
    )
  }
        ${
    summaryRow(
      "Required secrets",
      requiredSecrets.length ? requiredSecrets.join(", ") : "None",
    )
  }
        ${
    summaryRow(
      "Per-user secrets",
      perUserSecrets.length ? perUserSecrets.join(", ") : "None",
    )
  }
      </div>
    </section>
  `;
}

function libraryToolList(kind: "owned" | "installed"): string {
  if (libraryState.status === "error") {
    return emptyState("Library unavailable", libraryState.message);
  }

  if (libraryState.status !== "loaded") {
    return emptyState("Loading library", "Fetching owned and installed tools.");
  }

  const tools = kind === "owned"
    ? libraryState.library.owned
    : libraryState.library.installed;
  if (tools.length === 0) {
    return emptyState(
      kind === "owned" ? "No owned tools yet" : "No installed tools yet",
      kind === "owned"
        ? "Deploy a tool with the CLI or install instructions to manage it here."
        : "Discover public tools and add them to your external-agent workflow.",
    );
  }

  return `
    <div class="tool-list">
      ${tools.map((tool) => toolCard(tool)).join("")}
    </div>
  `;
}

function toolCard(tool: LaunchToolSummary): string {
  return `
    <article class="tool-card">
      <div class="tool-card-header">
        <div>
          <h3>${escapeHtml(tool.name)}</h3>
          <p>${escapeHtml(tool.description || "No description provided.")}</p>
        </div>
        <span class="tool-kind">${escapeHtml(labelize(tool.kind))}</span>
      </div>
      <div class="tool-meta">
        ${summaryRow("Visibility", labelize(tool.visibility))}
        ${summaryRow("Owner", ownerLabel(tool))}
        ${summaryRow("Pricing", pricingLabel(tool))}
        ${summaryRow("Widgets", widgetsLabel(tool))}
        ${tool.relevance ? summaryRow("Relevance", relevanceLabel(tool)) : ""}
      </div>
      <div class="action-row tool-actions">
        ${tool.publicUrl ? routeButton("Open", tool.publicUrl) : ""}
        ${tool.adminUrl ? routeButton("Admin", tool.adminUrl, "primary") : ""}
      </div>
    </article>
  `;
}

function toolAdminSummary(admin: LaunchToolAdminSummary): string {
  const tool = admin.tool;
  return `
    <div class="settings-list">
      ${settingsRow("Slug", tool.slug)}
      ${settingsRow("Visibility", labelize(tool.visibility))}
      ${settingsRow("Relationship", labelize(tool.relationship))}
      ${settingsRow("Pricing", pricingLabel(tool))}
      ${settingsRow("Owner", ownerLabel(tool))}
      ${settingsRow("Updated", updatedLabel(tool))}
    </div>
  `;
}

function widgetList(tool: LaunchToolSummary): string {
  if (tool.widgets.length === 0) {
    return emptyState(
      "No widgets declared",
      "This tool can still be installed and called by external agents.",
    );
  }

  return `
    <div class="widget-list">
      ${
    tool.widgets.map((widget) => `
        <article class="widget-card">
          <div>
            <strong>${escapeHtml(widget.label)}</strong>
            <span>${escapeHtml(widget.description || "Widget surface")}</span>
          </div>
          ${
      widget.openUrl
        ? `<a class="button secondary compact" href="${
          escapeAttribute(widget.openUrl)
        }">Open</a>`
        : ""
    }
        </article>
      `).join("")
  }
    </div>
  `;
}

function routeButton(
  label: string,
  path: string,
  kind: "primary" | "secondary" = "secondary",
): string {
  return `<a class="button ${kind}" href="${
    escapeAttribute(path)
  }" data-route>${escapeHtml(label)}</a>`;
}

function ownerLabel(tool: LaunchToolSummary): string {
  return tool.owner.displayName || tool.owner.profileSlug || tool.owner.userId;
}

function pricingLabel(tool: LaunchToolSummary): string {
  const pricing = tool.pricing;
  if (!pricing) return "No pricing data";
  const paid = pricing.paidFunctionsCount || 0;
  const defaultPrice = pricing.defaultCallPrice?.display ||
    "Free default calls";
  return paid > 0 ? `${defaultPrice}; ${paid} paid functions` : defaultPrice;
}

function widgetsLabel(tool: LaunchToolSummary): string {
  if (tool.widgets.length === 0) return "No widgets";
  if (tool.widgets.length === 1) return "1 widget";
  return `${tool.widgets.length} widgets`;
}

function relevanceLabel(tool: LaunchToolSummary): string {
  const relevance = tool.relevance;
  if (!relevance) return "Not ranked";
  const source = labelize(relevance.source);
  const score = typeof relevance.score === "number"
    ? ` ${Math.round(relevance.score * 100)}%`
    : "";
  return `${source}${score}`;
}

function sourceListLabel(
  sources: LaunchDiscoveryRetrievalSummary["embeddedSources"],
): string {
  return sources.length
    ? sources.map((source) => labelize(source)).join(", ")
    : "None";
}

function updatedLabel(tool: LaunchToolSummary): string {
  if (!tool.updatedAt) return "Unknown";
  return formatDate(tool.updatedAt);
}

function settingsRow(label: string, description: string): string {
  return `
    <div class="settings-row">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(description)}</span>
    </div>
  `;
}

function apiKeyCreateForm(): string {
  const reveal = apiKeysState.status === "loaded" ? apiKeysState.reveal : null;
  return `
    <form class="settings-list api-key-form" data-api-key-form>
      <label class="field-stack">
        <span>Name</span>
        <input name="name" type="text" maxlength="50" placeholder="Claude Code launch key" required />
      </label>
      <label class="field-stack">
        <span>Expires</span>
        <select name="expiresInDays">
          <option value="30">30 days</option>
          <option value="90" selected>90 days</option>
          <option value="365">365 days</option>
        </select>
      </label>
      <button class="button primary" type="submit">Create key</button>
    </form>
    ${reveal ? apiKeyReveal(reveal) : ""}
  `;
}

function apiKeyReveal(reveal: LaunchApiKeyCreateResponse): string {
  return `
    <div class="reveal-box">
      <div class="install-card-header">
        <div>
          <h3>${escapeHtml(reveal.apiKey.name)}</h3>
          <p>${escapeHtml(reveal.message)}</p>
        </div>
        <button class="button secondary compact" type="button" data-copy-api-token>Copy token</button>
      </div>
      <pre class="config-block"><code>${
    escapeHtml(reveal.plaintextToken)
  }</code></pre>
    </div>
  `;
}

function apiKeyList(): string {
  if (apiKeysState.status === "error") {
    return emptyState("API keys unavailable", apiKeysState.message);
  }
  if (apiKeysState.status !== "loaded") {
    return emptyState("Loading API keys", "Fetching launch key metadata.");
  }
  if (apiKeysState.apiKeys.length === 0) {
    return emptyState(
      "No API keys yet",
      "Create one to install Ultralight into external agents.",
    );
  }
  return `
    <div class="settings-list">
      ${apiKeysState.apiKeys.map(apiKeyRow).join("")}
    </div>
  `;
}

function apiKeyRow(key: LaunchApiKeySummary): string {
  return `
    <div class="settings-row action-settings-row">
      <strong>${escapeHtml(key.name)}</strong>
      <span>${escapeHtml(key.tokenPrefix)}... · ${
    escapeHtml(key.scopes.join(", ") || "default scopes")
  } · ${
    escapeHtml(
      key.expiresAt ? `expires ${formatDate(key.expiresAt)}` : "no expiry",
    )
  }</span>
      <button class="button secondary compact" type="button" data-revoke-api-key="${
    escapeAttribute(key.id)
  }">Revoke</button>
    </div>
  `;
}

function summaryRow(label: string, value: string): string {
  return `
    <div class="summary-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function emptyState(title: string, description: string): string {
  return `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(description)}</span>
    </div>
  `;
}

function apiContractPanel(routes: string[]): string {
  return `
    <section class="panel contract-panel">
      <h2>Launch API Contract</h2>
      <div class="route-list">
        ${routes.map((route) => `<code>${escapeHtml(route)}</code>`).join("")}
      </div>
    </section>
  `;
}

function currentInstallRequest(): { tool?: string } {
  const tool = new URLSearchParams(window.location.search).get("tool")?.trim();
  return tool ? { tool } : {};
}

function currentDiscoverRequest(): LaunchDiscoveryRequest {
  const params = new URLSearchParams(window.location.search);
  const query = params.get("query") || params.get("q") || "";
  const kind = parseDiscoverKind(params.get("kind"));
  return {
    query: query.trim() || undefined,
    kind,
    includeWidgets: true,
    limit: 24,
  };
}

function currentLeaderboardPeriod(): LeaderboardPeriod {
  const params = new URLSearchParams(window.location.search);
  return parseLeaderboardPeriod(
    params.get("leaderboardPeriod") || params.get("period"),
  );
}

function publicFunctionsPanel(
  tool: LaunchToolSummary,
  functions: LaunchFunctionSummary[],
): string {
  if (functions.length === 0) {
    return `
      <section class="panel">
        <div class="section-heading">
          <h2>Functions</h2>
          <p>This tool exposes no callable function signatures yet.</p>
        </div>
        ${emptyState("No functions", "Install and version details may be unavailable in this build.")}
      </section>
    `;
  }

  return `
    <section class="panel">
      <div class="section-heading">
        <h2>Functions</h2>
        <p>Run these directly from the website surface while keeping the tool callable from external agents.</p>
      </div>
      <div class="function-grid">
        ${functions.map((fn) => functionCard(tool.slug, fn)).join("")}
      </div>
    </section>
  `;
}

function functionCard(toolSlug: string, fn: LaunchFunctionSummary): string {
  const key = functionRunStateKey(toolSlug, fn.name);
  const state = functionRunState(toolSlug, fn.name);
  const runDisabled = state.status === "loading" ? " disabled" : "";
  return `
    <article class="function-card">
      <div class="function-card-header">
        <div>
          <h3>${escapeHtml(fn.name)}</h3>
          <p>${escapeHtml(fn.description || "No description available.")}</p>
        </div>
        ${functionPermissionBadge(fn)}
      </div>
      <div class="summary-list function-meta-list">
        ${summaryRow("Pricing", functionPricingLabel(fn))}
        ${summaryRow("Input schema", functionSchemaSummary(fn.inputSchema))}
        ${summaryRow("Output schema", functionSchemaSummary(fn.outputSchema))}
        ${summaryRow(
    "Widget routes",
    fn.widgetIds && fn.widgetIds.length > 0
      ? fn.widgetIds.join(", ")
      : "None linked",
  )}
      </div>
      <p class="muted-copy">Website-run calls bypass external-agent prompts and still generate launch receipts.</p>
      <form
        class="function-run-form"
        data-function-run-form
        data-function-tool="${escapeAttribute(toolSlug)}"
        data-function-name="${escapeAttribute(fn.name)}"
      >
        <label class="field-stack">
          <span>Args JSON</span>
          <textarea
            class="function-args"
            name="args"
            spellcheck="false"
          >${escapeHtml(functionArgsPlaceholder(fn))}</textarea>
        </label>
        <button class="button compact" type="submit"${runDisabled}>Run function</button>
      </form>
      ${functionRunResult(state)}
    </article>
  `;
}

function functionPermissionBadge(fn: LaunchFunctionSummary): string {
  const policy = fn.agentPermission?.policy || "ask";
  const source = fn.agentPermission?.source || "default";
  const classes =
    policy === "always"
      ? "permission-pill policy-always"
      : policy === "never"
      ? "permission-pill policy-never"
      : "permission-pill policy-ask";
  return `<span class="${classes}">Agent: ${labelize(policy)} (${labelize(source)})</span>`;
}

function functionPricingLabel(fn: LaunchFunctionSummary): string {
  const pricing = fn.pricing;
  return pricing?.defaultCallPrice?.display || "Free";
}

function functionSchemaSummary(value: Record<string, unknown> | null | undefined): string {
  const schema = asRecord(value);
  const properties = asRecord(schema?.properties);
  if (!properties) return "Undefined";
  const keys = Object.keys(properties);
  return `${keys.length} fields`;
}

function functionArgsPlaceholder(fn: LaunchFunctionSummary): string {
  const schema = asRecord(fn.inputSchema);
  const properties = asRecord(schema?.properties);
  if (!properties) return "{}";
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties).slice(0, 6)) {
    payload[key] = schemaValueExample(value);
  }
  return JSON.stringify(payload, null, 2);
}

function schemaValueExample(value: unknown): unknown {
  const schema = asRecord(value);
  const type = asString(schema?.type);
  if (type === "string") return "";
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  if (type === "array") return [];
  if (type === "object") return {};
  if (schema && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0] ?? null;
  }
  return null;
}

function functionRunResult(state: FunctionRunState): string {
  if (state.status === "idle") {
    return `<p class="muted-copy run-result-note">Submit args JSON to run this function.</p>`;
  }
  if (state.status === "loading") {
    return `<p class="muted-copy run-result-note">Running function...</p>`;
  }
  if (state.status === "error") {
    return `
      <div class="function-run-result function-run-error">
        <strong>Run failed</strong>
        <span>${escapeHtml(state.message)}</span>
      </div>
    `;
  }

  const response = state.response;
  const warnings = response.warnings && response.warnings.length > 0
    ? `
      <div class="function-run-warnings">
        <strong>Warnings</strong>
        ${response.warnings.map((item) =>
    `<span>${escapeHtml(item.type)}: ${escapeHtml(item.message)}</span>`
  ).join(" ")}
      </div>
    `
    : "";

  if (!response.success) {
    return `
      <div class="function-run-result function-run-error">
        <strong>${response.error?.message || "Execution failed"}</strong>
        ${response.receiptId
      ? `<p>Receipt: ${escapeHtml(response.receiptId)}</p>`
      : ""}
        ${warnings}
      </div>
    `;
  }

  const resultText = response.result === undefined
    ? "null"
    : safeJson(response.result);
  return `
    <div class="function-run-result">
      <div class="summary-row function-result-header">
        <strong>Execution result</strong>
        <span>${response.receiptId ? `receipt ${response.receiptId}` : "no receipt"}</span>
      </div>
      <pre class="function-result">${escapeHtml(resultText)}</pre>
      ${warnings}
    </div>
  `;
}

function functionRunStateKey(toolSlug: string, functionName: string): string {
  return `${toolSlug}:${functionName}`;
}

function functionRunState(toolSlug: string, functionName: string): FunctionRunState {
  const key = functionRunStateKey(toolSlug, functionName);
  return functionRunStates.get(key) || { status: "idle" };
}

function currentWalletTab(): WalletTab {
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (
    tab === "transactions" || tab === "receipts" || tab === "earnings" ||
    tab === "payouts"
  ) {
    return tab;
  }
  return "topup";
}

function currentWalletDetailKind(): LaunchWalletDetailKind | null {
  const tab = currentWalletTab();
  return tab === "topup" ? null : tab;
}

function currentWalletToolFilter(): string | undefined {
  const tool = new URLSearchParams(window.location.search).get("tool")?.trim();
  return tool || undefined;
}

function walletDetailKey(
  kind: LaunchWalletDetailKind,
  tool?: string | null,
): string {
  return `${kind}:${tool || "all"}`;
}

function walletDetailState(kind: LaunchWalletDetailKind): WalletDetailState {
  const tool = kind === "earnings" || kind === "receipts"
    ? currentWalletToolFilter()
    : undefined;
  const key = walletDetailKey(kind, tool);
  return walletDetailStates.get(key) || { status: "loading", key, kind, tool };
}

function normalizeWalletDetailResponse(
  response: LaunchWalletDetailResponse,
): WalletDetailLoaded {
  return {
    kind: response.kind,
    items: [...response.items] as WalletDetailItem[],
    page: response.page,
    generatedAt: response.generatedAt,
  };
}

function mergeWalletDetailResponse(
  previous: WalletDetailLoaded,
  next: WalletDetailLoaded,
): WalletDetailLoaded {
  return {
    ...next,
    items: previous.kind === next.kind
      ? [...previous.items, ...next.items]
      : next.items,
  };
}

function discoverUrlFromForm(form: HTMLFormElement): string {
  const data = new FormData(form);
  const query = String(data.get("query") || "").trim();
  const kind = parseDiscoverKind(String(data.get("kind") || "all"));
  const period = currentLeaderboardPeriod();
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (kind !== "all") params.set("kind", kind);
  if (period !== "30d") params.set("leaderboardPeriod", period);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/store${suffix}`;
}

function parseDiscoverKind(value: string | null): LaunchToolKind | "all" {
  if (
    value === "mcp" || value === "http" || value === "gpu" ||
    value === "markdown"
  ) {
    return value;
  }
  return "all";
}

function parseLeaderboardPeriod(value: string | null): LeaderboardPeriod {
  if (value === "90d" || value === "all") return value;
  return "30d";
}

function discoverKey(request: LaunchDiscoveryRequest): string {
  return JSON.stringify({
    query: request.query || "",
    kind: request.kind || "all",
    includeWidgets: request.includeWidgets !== false,
    limit: request.limit || 24,
  });
}

function installKey(request: { tool?: string }): string {
  return `install:${request.tool || ""}`;
}

function leaderboardKey(period: LeaderboardPeriod): string {
  return `leaderboard:${period}`;
}

function leaderboardPeriodUrl(period: LeaderboardPeriod): string {
  const params = new URLSearchParams(window.location.search);
  params.delete("period");
  if (period === "30d") {
    params.delete("leaderboardPeriod");
  } else {
    params.set("leaderboardPeriod", period);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/store${suffix}`;
}

function leaderboardPeriodLabel(period: LeaderboardPeriod): string {
  switch (period) {
    case "90d":
      return "90 days";
    case "all":
      return "All time";
    case "30d":
      return "30 days";
  }
}

function widgetRenderKey(toolSlug: string, widgetId: string): string {
  return `${toolSlug}:${widgetId}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shortUserId(userId: string): string {
  if (!userId) return "No profile";
  return userId.length > 12 ? `${userId.slice(0, 8)}...` : userId;
}

function sortInstallInstructions(
  instructions: LaunchInstallInstruction[],
): LaunchInstallInstruction[] {
  const order = new Map(
    LAUNCH_INSTALL_TARGETS.map((target, index) => [target, index]),
  );
  return [...instructions].sort((left, right) =>
    (order.get(left.target) ?? 999) - (order.get(right.target) ?? 999)
  );
}

async function copyInstallConfig(button: HTMLButtonElement): Promise<void> {
  if (installState.status !== "loaded") return;
  const target = button.dataset.copyInstall;
  const instruction = installState.instructions.find((item) =>
    item.target === target
  );
  const text = instruction?.configText ||
    instruction?.steps.map((stepText, index) => `${index + 1}. ${stepText}`)
      .join("\n");
  if (!text) return;

  try {
    await writeClipboard(text);
    showCopyFeedback(button, "Copied");
  } catch {
    showCopyFeedback(button, "Copy failed");
  }
}

async function copyApiToken(button: HTMLButtonElement): Promise<void> {
  if (apiKeysState.status !== "loaded" || !apiKeysState.reveal) return;
  try {
    await writeClipboard(apiKeysState.reveal.plaintextToken);
    showCopyFeedback(button, "Copied");
  } catch {
    showCopyFeedback(button, "Copy failed");
  }
}

async function createApiKey(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const expiresInDays = Number(data.get("expiresInDays") || 90);
  if (!name) return;

  apiKeysState = { status: "loading" };
  render();
  try {
    const reveal = await launchApi.createApiKey({
      name,
      expiresInDays: Number.isFinite(expiresInDays) ? expiresInDays : 90,
      scopes: ["apps:call"],
    });
    const list = await launchApi.apiKeys();
    apiKeysState = {
      status: "loaded",
      apiKeys: list.apiKeys,
      reveal,
    };
  } catch (err) {
    apiKeysState = {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to create API key",
    };
  }
  render();
}

async function revokeApiKey(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.revokeApiKey;
  if (!id) return;
  try {
    await launchApi.revokeApiKey(id);
    const list = await launchApi.apiKeys();
    apiKeysState = {
      status: "loaded",
      apiKeys: list.apiKeys,
      reveal: apiKeysState.status === "loaded" ? apiKeysState.reveal : null,
    };
  } catch (err) {
    apiKeysState = {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to revoke API key",
    };
  }
  render();
}

async function renderWidget(button: HTMLButtonElement): Promise<void> {
  const toolSlug = button.dataset.renderTool;
  const widgetId = button.dataset.renderWidget;
  if (!toolSlug || !widgetId) return;

  const key = widgetRenderKey(toolSlug, widgetId);
  widgetRenderStates.set(key, { status: "loading" });
  render();
  try {
    const response = await launchApi.renderWidget(toolSlug, widgetId, {
      args: {},
    });
    widgetRenderStates.set(key, { status: "loaded", response });
  } catch (err) {
    widgetRenderStates.set(key, {
      status: "error",
      message: err instanceof Error ? err.message : "Widget render unavailable",
    });
  }
  render();
}

async function loadMoreWalletDetail(button: HTMLButtonElement): Promise<void> {
  const kind = button.dataset.walletKind as LaunchWalletDetailKind | undefined;
  const key = button.dataset.walletKey;
  const cursor = button.dataset.walletCursor || undefined;
  const tool = button.dataset.walletTool || undefined;
  if (!kind || !key || !cursor) return;

  const state = walletDetailStates.get(key);
  if (!state || state.status === "loading" || state.status === "loadingMore") {
    return;
  }
  const response = walletLoadedDetailResponse(state);
  if (!response) return;

  walletDetailStates.set(key, {
    status: "loadingMore",
    key,
    response,
  });
  render();
  await loadWalletDetail(kind, key, { cursor, tool });
}

async function runToolFunctionFromForm(form: HTMLFormElement): Promise<void> {
  const toolSlug = form.dataset.functionTool;
  const functionName = form.dataset.functionName;
  const argsInput = form.querySelector<HTMLTextAreaElement>(
    'textarea[name="args"]',
  );
  if (!toolSlug || !functionName) return;

  const key = functionRunStateKey(toolSlug, functionName);
  functionRunStates.set(key, { status: "loading" });
  render();

  let args: Record<string, unknown> = {};
  if (argsInput) {
    const raw = argsInput.value.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Function args must be a JSON object");
        }
        args = parsed as Record<string, unknown>;
      } catch (err) {
        functionRunStates.set(key, {
          status: "error",
          message: err instanceof Error
            ? err.message
            : "Invalid function args JSON",
        });
        render();
        return;
      }
    }
  }

  try {
    const response = await launchApi.runToolFunction(toolSlug, functionName, { args });
    functionRunStates.set(key, { status: "loaded", response });
  } catch (err) {
    functionRunStates.set(key, {
      status: "error",
      message: err instanceof Error ? err.message : "Function call failed",
    });
  }

  render();
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard write failed");
}

function showCopyFeedback(button: HTMLButtonElement, label: string): void {
  const original = button.textContent || "Copy";
  button.textContent = label;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1200);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? "<unserializable>" : text;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    )
    : [];
}

function labelize(value: string): string {
  return value
    .split(/[_-]/u)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function installTargetDescription(target: LaunchInstallTarget): string {
  switch (target) {
    case "claude_code":
      return "Claude Code MCP server config.";
    case "cursor":
      return "Cursor MCP tools loaded into agent context.";
    case "codex":
      return "Codex-compatible MCP/API install path.";
    case "openai_remote_mcp":
      return "Remote MCP for OpenAI Responses API.";
    case "generic_mcp":
      return "Portable JSON config for MCP-capable agents.";
    case "cli":
      return "Ultralight CLI install and auth flow.";
    case "api":
      return "Direct API key and endpoint usage.";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#039;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
