import './styles.css';

import {
  LAUNCH_DEFERRED_CAPABILITIES,
  LAUNCH_INCLUDED_CAPABILITIES,
  LAUNCH_INSTALL_TARGETS,
  LAUNCH_PLATFORM_PRIMITIVES,
  LAUNCH_SCOPE_CONTRACT,
  type LaunchDiscoveryRequest,
  type LaunchDiscoveryResponse,
  type LaunchDiscoveryRetrievalSummary,
  type LaunchInstallInstruction,
  type LaunchInstallTarget,
  type LaunchLeaderboardEntry,
  type LaunchLeaderboardKind,
  type LaunchLeaderboardResponse,
  type LaunchLibraryResponse,
  type LaunchPlatformPrimitiveSuggestion,
  type LaunchToolAdminSummary,
  type LaunchToolKind,
  type LaunchToolSummary,
  type LaunchWalletSummary,
  type LaunchWidgetSummary,
} from '../../../shared/contracts/launch.ts';
import { launchApi } from './lib/api';
import {
  accountRoutes,
  primaryRoutes,
  type ResolvedLaunchRoute,
  resolveLaunchRoute,
} from './lib/routes';

const app = document.getElementById('app');

if (!app) {
  throw new Error('Launch app root not found');
}

const appRoot = app;
type InstallState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; instructions: LaunchInstallInstruction[] }
  | { status: 'error'; message: string };
type LibraryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; library: LaunchLibraryResponse }
  | { status: 'error'; message: string };
type AdminToolState =
  | { status: 'loading' }
  | { status: 'loaded'; admin: LaunchToolAdminSummary; trustCard?: unknown }
  | { status: 'error'; message: string };
type PublicToolState =
  | { status: 'loading' }
  | { status: 'loaded'; tool: LaunchToolSummary; trustCard?: unknown }
  | { status: 'error'; message: string };
type DiscoverState =
  | { status: 'idle' }
  | { status: 'loading'; key: string; request: LaunchDiscoveryRequest }
  | { status: 'loaded'; key: string; response: LaunchDiscoveryResponse }
  | { status: 'error'; key: string; message: string };
type LeaderboardPeriod = LaunchLeaderboardResponse['period'];
type LeaderboardState =
  | { status: 'idle' }
  | { status: 'loading'; key: string; period: LeaderboardPeriod }
  | {
    status: 'loaded';
    key: string;
    builder: LaunchLeaderboardResponse;
    feeCredit: LaunchLeaderboardResponse;
  }
  | { status: 'error'; key: string; message: string };
type WalletState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; wallet: LaunchWalletSummary }
  | { status: 'error'; message: string };
type WalletTab = 'topup' | 'transactions' | 'receipts' | 'earnings' | 'payouts';

let installState: InstallState = { status: 'idle' };
let libraryState: LibraryState = { status: 'idle' };
let discoverState: DiscoverState = { status: 'idle' };
let leaderboardState: LeaderboardState = { status: 'idle' };
let walletState: WalletState = { status: 'idle' };
const adminToolStates = new Map<string, AdminToolState>();
const publicToolStates = new Map<string, PublicToolState>();

window.addEventListener('popstate', render);
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const link = target.closest<HTMLAnchorElement>('a[data-route]');
  if (!link) return;
  const url = new URL(link.href);
  if (url.origin !== window.location.origin) return;
  event.preventDefault();
  navigate(`${url.pathname}${url.search}${url.hash}`);
});
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>('button[data-copy-install]');
  if (!button) return;
  event.preventDefault();
  void copyInstallConfig(button);
});
document.addEventListener('submit', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (!target.matches('form[data-discover-search]')) return;
  event.preventDefault();
  navigate(discoverUrlFromForm(target));
});

render();

function render(): void {
  const route = resolveLaunchRoute(window.location.pathname);
  ensureRouteData(route);
  appRoot.innerHTML = layout(route);
}

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function ensureRouteData(route: ResolvedLaunchRoute): void {
  if (
    (route.definition.key === 'home' || route.definition.key === 'install' ||
      route.definition.key === 'settings') &&
    installState.status === 'idle'
  ) {
    installState = { status: 'loading' };
    void loadInstallInstructions();
  }

  if (route.definition.key === 'library' && libraryState.status === 'idle') {
    libraryState = { status: 'loading' };
    void loadLibrary();
  }

  if (route.definition.key === 'discover') {
    const request = currentDiscoverRequest();
    const key = discoverKey(request);
    if (discoverState.status === 'idle' || discoverState.key !== key) {
      discoverState = { status: 'loading', key, request };
      void loadDiscover(request, key);
    }

    const period = currentLeaderboardPeriod();
    const rankingsKey = leaderboardKey(period);
    if (
      leaderboardState.status === 'idle' ||
      leaderboardState.key !== rankingsKey
    ) {
      leaderboardState = { status: 'loading', key: rankingsKey, period };
      void loadLeaderboards(period, rankingsKey);
    }
  }

  if (route.definition.key === 'wallet' && walletState.status === 'idle') {
    walletState = { status: 'loading' };
    void loadWallet();
  }

  if (route.definition.key === 'adminTool') {
    const id = route.params.id || '';
    if (id && !adminToolStates.has(id)) {
      adminToolStates.set(id, { status: 'loading' });
      void loadAdminTool(id);
    }
  }

  if (route.definition.key === 'tool') {
    const slug = route.params.slug || '';
    if (slug && !publicToolStates.has(slug)) {
      publicToolStates.set(slug, { status: 'loading' });
      void loadPublicTool(slug);
    }
  }
}

async function loadInstallInstructions(): Promise<void> {
  try {
    const response = await launchApi.install();
    installState = {
      status: 'loaded',
      instructions: sortInstallInstructions(response.instructions),
    };
  } catch (err) {
    installState = {
      status: 'error',
      message: err instanceof Error ? err.message : 'Install instructions unavailable',
    };
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (
    route.definition.key === 'home' || route.definition.key === 'install' ||
    route.definition.key === 'settings'
  ) {
    render();
  }
}

async function loadLibrary(): Promise<void> {
  try {
    libraryState = {
      status: 'loaded',
      library: await launchApi.library(),
    };
  } catch (err) {
    libraryState = {
      status: 'error',
      message: err instanceof Error ? err.message : 'Library unavailable',
    };
  }

  if (
    resolveLaunchRoute(window.location.pathname).definition.key === 'library'
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
      status: 'loaded',
      key,
      response: await launchApi.discover(request),
    };
  } catch (err) {
    discoverState = {
      status: 'error',
      key,
      message: err instanceof Error ? err.message : 'Discovery unavailable',
    };
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (
    route.definition.key === 'discover' &&
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
      launchApi.leaderboard('builder', { period, limit: 10 }),
      launchApi.leaderboard('fee_credit', { period, limit: 10 }),
    ]);
    leaderboardState = {
      status: 'loaded',
      key,
      builder,
      feeCredit,
    };
  } catch (err) {
    leaderboardState = {
      status: 'error',
      key,
      message: err instanceof Error ? err.message : 'Leaderboards unavailable',
    };
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (
    route.definition.key === 'discover' &&
    leaderboardKey(currentLeaderboardPeriod()) === key
  ) {
    render();
  }
}

async function loadWallet(): Promise<void> {
  try {
    const response = await launchApi.wallet();
    walletState = {
      status: 'loaded',
      wallet: response.wallet,
    };
  } catch (err) {
    walletState = {
      status: 'error',
      message: err instanceof Error ? err.message : 'Wallet unavailable',
    };
  }

  if (
    resolveLaunchRoute(window.location.pathname).definition.key === 'wallet'
  ) {
    render();
  }
}

async function loadAdminTool(id: string): Promise<void> {
  try {
    const response = await launchApi.toolAdmin(id);
    adminToolStates.set(id, {
      status: 'loaded',
      admin: response.admin,
      trustCard: response.trustCard,
    });
  } catch (err) {
    adminToolStates.set(id, {
      status: 'error',
      message: err instanceof Error ? err.message : 'Tool admin unavailable',
    });
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (route.definition.key === 'adminTool' && route.params.id === id) {
    render();
  }
}

async function loadPublicTool(slug: string): Promise<void> {
  try {
    const [toolResponse, widgetsResponse] = await Promise.all([
      launchApi.tool(slug),
      launchApi.toolWidgets(slug),
    ]);
    publicToolStates.set(slug, {
      status: 'loaded',
      tool: {
        ...toolResponse.tool,
        widgets: widgetsResponse.widgets,
      },
      trustCard: toolResponse.trustCard,
    });
  } catch (err) {
    publicToolStates.set(slug, {
      status: 'error',
      message: err instanceof Error ? err.message : 'Tool unavailable',
    });
  }

  const route = resolveLaunchRoute(window.location.pathname);
  if (route.definition.key === 'tool' && route.params.slug === slug) {
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
      '',
    )
  }
        </nav>
        <nav class="nav-section nav-section-secondary" aria-label="Account">
          ${
    accountRoutes().map((item) => navLink(item.path, item.label, route)).join(
      '',
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
  return `<a class="nav-link ${active ? 'active' : ''}" href="${path}" data-route>${label}</a>`;
}

function pageHeader(route: ResolvedLaunchRoute): string {
  const eyebrow = route.definition.key === 'home'
    ? 'External-agent tool layer'
    : route.definition.label;
  return `
    <header class="page-header">
      <div>
        <p class="eyebrow">${eyebrow}</p>
        <h1>${pageTitle(route)}</h1>
      </div>
      <div class="header-actions">
        <a class="button secondary" href="/install" data-route>Install</a>
        <a class="button primary" href="/discover" data-route>Discover tools</a>
      </div>
    </header>
  `;
}

function pageTitle(route: ResolvedLaunchRoute): string {
  switch (route.definition.key) {
    case 'home':
      return 'Deploy tools for the agents you already use';
    case 'tool':
      if (
        route.params.slug &&
        publicToolStates.get(route.params.slug)?.status === 'loaded'
      ) {
        const state = publicToolStates.get(route.params.slug);
        if (state?.status === 'loaded') return state.tool.name;
      }
      return `Tool: ${escapeHtml(route.params.slug || 'unknown')}`;
    case 'adminTool':
      return `Tool admin: ${escapeHtml(route.params.id || 'unknown')}`;
    default:
      return route.definition.label;
  }
}

function pageBody(route: ResolvedLaunchRoute): string {
  switch (route.definition.key) {
    case 'home':
      return homePage();
    case 'install':
      return installPage();
    case 'library':
      return libraryPage();
    case 'discover':
      return discoverPage();
    case 'tool':
      return toolPage(route.params.slug || '');
    case 'wallet':
      return walletPage();
    case 'settings':
      return settingsPage();
    case 'adminTool':
      return adminToolPage(route.params.id || '');
  }
}

function homePage(): string {
  return `
    <section class="hero-band">
      <p>${escapeHtml(LAUNCH_SCOPE_CONTRACT.thesis)}</p>
      <div class="hero-grid">
        ${metric('Public surface', 'Website + MCP + CLI/API')}
        ${metric('Launch UI', 'Widgets only')}
        ${metric('Model layer', 'External agents')}
      </div>
    </section>
    <section class="content-grid two">
      <div class="panel">
        <h2>MVP Surfaces</h2>
        <div class="pill-grid">
          ${
    LAUNCH_INCLUDED_CAPABILITIES.map((item) => pill(labelize(item), 'included'))
      .join('')
  }
        </div>
      </div>
      <div class="panel">
        <h2>Deferred Publicly</h2>
        <div class="pill-grid">
          ${
    LAUNCH_DEFERRED_CAPABILITIES.map((item) => pill(labelize(item), 'deferred'))
      .join('')
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
    ['Install', 'Discover', 'Inspect', 'Call', 'Open widget', 'Show receipt']
      .map(step).join('')
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
      'GET /api/launch/install',
      'GET /api/launch/status',
      'GET /api/launch/openapi.json',
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
        ${libraryToolList('owned')}
      </div>
      <div class="panel">
        <div class="section-heading">
          <h2>Installed Tools</h2>
          <p>Installed tools open widgets when available.</p>
        </div>
        ${libraryToolList('installed')}
      </div>
    </section>
    ${apiContractPanel(['GET /api/launch/library'])}
  `;
}

function discoverPage(): string {
  const request = currentDiscoverRequest();
  const leaderboardPeriod = currentLeaderboardPeriod();
  return `
    <section class="panel">
      <form class="toolbar discover-form" data-discover-search>
        <input class="search" name="query" type="search" value="${
    escapeAttribute(request.query || '')
  }" placeholder="Search public tools, widgets, pages, and platform primitives" />
        <select class="filter-select" name="kind" aria-label="Tool kind">
          ${discoverKindOptions(request.kind || 'all')}
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
          ${summaryRow('Query', request.query || 'All public tools')}
          ${summaryRow('Kind', labelize(request.kind || 'all'))}
          ${summaryRow('Widgets', 'Included')}
          ${summaryRow('Limit', String(request.limit || 24))}
          ${summaryRow('Leaderboard period', leaderboardPeriodLabel(leaderboardPeriod))}
          ${discoveryRetrievalRows()}
        </div>
      </div>
    </section>
    ${leaderboardSection(leaderboardPeriod)}
    ${
    apiContractPanel([
      'GET /api/launch/discover',
      'GET /api/launch/leaderboard',
      'GET /api/launch/platform-primitives',
    ])
  }
  `;
}

function toolPage(slug: string): string {
  if (!slug) {
    return emptyState('No tool selected', 'Choose a tool from Discover.');
  }

  const state = publicToolStates.get(slug);
  if (!state || state.status === 'loading') {
    return `
      <section class="panel">
        ${emptyState('Loading tool', 'Fetching public profile and widget surfaces.')}
      </section>
      ${
      apiContractPanel([
        'GET /api/launch/tools/:id',
        'GET /api/launch/tools/:id/widgets',
      ])
    }
    `;
  }

  if (state.status === 'error') {
    return `
      <section class="panel">
        ${emptyState('Tool unavailable', state.message)}
      </section>
      ${
      apiContractPanel([
        'GET /api/launch/tools/:id',
        'GET /api/launch/tools/:id/widgets',
      ])
    }
    `;
  }

  const { tool, trustCard } = state;
  return `
    <section class="content-grid two">
      <div class="panel">
        <div class="section-heading">
          <h2>${escapeHtml(tool.name)}</h2>
          <p>${escapeHtml(tool.description || 'No description provided.')}</p>
        </div>
        ${publicToolSummary(tool)}
        <div class="action-row tool-actions standalone-actions">
          ${tool.installUrl ? routeButton('Install', tool.installUrl, 'primary') : ''}
          ${tool.adminUrl ? routeButton('Admin', tool.adminUrl) : ''}
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
    ${trustPanel(trustCard)}
    ${
    apiContractPanel([
      'GET /api/launch/tools/:id',
      'GET /api/launch/tools/:id/widgets',
    ])
  }
  `;
}

function walletPage(): string {
  if (walletState.status === 'error') {
    return `
      <section class="panel">
        ${emptyState('Wallet unavailable', walletState.message)}
      </section>
      ${apiContractPanel(['GET /api/launch/wallet'])}
    `;
  }

  if (walletState.status !== 'loaded') {
    return `
      <section class="panel">
        ${emptyState('Loading wallet', 'Fetching Light balance and payout status.')}
      </section>
      ${apiContractPanel(['GET /api/launch/wallet'])}
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
          ${walletMiniMetric('Spendable', wallet.spendableBalance.display)}
          ${walletMiniMetric('Purchased', wallet.depositBalance?.display || '0 Light')}
          ${walletMiniMetric('Earned', wallet.earnedBalance?.display || '0 Light')}
          ${walletMiniMetric('Escrow', wallet.escrowBalance?.display || '0 Light')}
        </div>
      </div>
      <div class="panel">
        <h2>Wallet Actions</h2>
        <div class="settings-list">
          ${
    walletActionRow(
      'Add Light',
      'Fund tool calls, installs, and hosting.',
      wallet.topUpUrl,
      wallet.canTopUp,
    )
  }
          ${
    walletActionRow(
      'Transactions',
      'Review Light movement and charges.',
      wallet.transactionsUrl,
      true,
    )
  }
          ${
    walletActionRow(
      'Receipts',
      'Trace monetized tool usage and purchases.',
      wallet.receiptsUrl,
      true,
    )
  }
        </div>
      </div>
    </section>
    <section class="panel">
      <nav class="tab-row" aria-label="Wallet sections">
        ${walletTabLink('topup', 'Top-up', tab)}
        ${walletTabLink('transactions', 'Transactions', tab)}
        ${walletTabLink('receipts', 'Receipts', tab)}
        ${walletTabLink('earnings', 'Earnings', tab)}
        ${walletTabLink('payouts', 'Payouts', tab)}
      </nav>
      ${walletTabPanel(wallet, tab)}
    </section>
    ${apiContractPanel(['GET /api/launch/wallet'])}
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
        ${settingsRow('API key', 'Used by CLI, MCP config, and external agents.')}
        ${settingsRow('Install defaults', 'Preferred agent target and endpoint copy.')}
        ${
    settingsRow(
      'Public profile',
      'Display name and builder leaderboard identity.',
    )
  }
      </div>
    </section>
  `;
}

function adminToolPage(id: string): string {
  const state = adminToolStates.get(id);
  if (!id) {
    return emptyState('No tool selected', 'Choose an owned tool from Library.');
  }

  if (!state || state.status === 'loading') {
    return `
      <section class="panel">
        ${emptyState('Loading tool admin', 'Fetching owner-only launch settings.')}
      </section>
      ${apiContractPanel(['GET /api/launch/admin/tools/:id'])}
    `;
  }

  if (state.status === 'error') {
    return `
      <section class="panel">
        ${emptyState('Tool admin unavailable', state.message)}
      </section>
      ${apiContractPanel(['GET /api/launch/admin/tools/:id'])}
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
          ${tool.publicUrl ? routeButton('Open public page', tool.publicUrl) : ''}
          ${
    admin.receiptsUrl
      ? `<a class="button secondary" href="${escapeAttribute(admin.receiptsUrl)}">Receipts</a>`
      : ''
  }
          ${
    admin.logsUrl
      ? `<a class="button secondary" href="${escapeAttribute(admin.logsUrl)}">Logs</a>`
      : ''
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
    admin.editableFields.map((field) => pill(labelize(field), 'included')).join(
      '',
    )
  }
      </div>
    </section>
    ${apiContractPanel(['GET /api/launch/admin/tools/:id'])}
  `;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${
    escapeHtml(value)
  }</strong></div>`;
}

function pill(label: string, kind: 'included' | 'deferred'): string {
  return `<span class="pill ${kind}">${escapeHtml(label)}</span>`;
}

function step(label: string): string {
  return `<div class="step"><span>${escapeHtml(label)}</span></div>`;
}

function installPreview(): string {
  if (installState.status === 'loaded') {
    return `
      <div class="target-grid preview-targets">
        ${
      installState.instructions.slice(0, 3).map((instruction) =>
        installTargetCard(instruction.target, instruction.description)
      ).join('')
    }
      </div>
    `;
  }

  return `
    <div class="target-grid preview-targets">
      ${
    LAUNCH_INSTALL_TARGETS.slice(0, 3).map((target) =>
      installTargetCard(target, installTargetDescription(target))
    ).join('')
  }
    </div>
  `;
}

function installInstructionList(): string {
  if (installState.status === 'error') {
    return emptyState(
      'Install instructions unavailable',
      installState.message,
    );
  }

  if (installState.status !== 'loaded') {
    return `
      <div class="install-list loading">
        ${
      LAUNCH_INSTALL_TARGETS.map((target) => installTargetCard(target, 'Loading install config...'))
        .join('')
    }
      </div>
    `;
  }

  return `
    <div class="install-list">
      ${
    installState.instructions.map((instruction) => installInstructionCard(instruction)).join('')
  }
    </div>
  `;
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
        ${instruction.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ol>
      ${
    instruction.configText
      ? `<pre class="config-block"><code>${escapeHtml(instruction.configText)}</code></pre>`
      : ''
  }
    </article>
  `;
}

function agentApiPanel(): string {
  const links = [
    {
      label: 'Launch status',
      href: '/api/launch/status',
      description: 'Machine-readable route list, capabilities, and agent loop.',
    },
    {
      label: 'OpenAPI',
      href: '/api/launch/openapi.json',
      description: 'Launch facade schema for direct API agents and scripts.',
    },
    {
      label: 'MCP discovery',
      href: '/.well-known/mcp.json',
      description: 'Platform MCP transport and capability metadata.',
    },
    {
      label: 'Platform MCP',
      href: '/mcp/platform',
      description: 'JSON-RPC endpoint for tools/list and tools/call.',
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
        `).join('')
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

function primitiveCard(primitive: string): string {
  return `
    <article class="primitive-card">
      <strong>${escapeHtml(labelize(primitive))}</strong>
      <span>Indexed launch primitive</span>
    </article>
  `;
}

function discoverResults(): string {
  if (discoverState.status === 'error') {
    return emptyState('Discovery unavailable', discoverState.message);
  }

  if (discoverState.status !== 'loaded') {
    return emptyState(
      'Loading discovery',
      'Fetching public tools and widgets.',
    );
  }

  const results = discoverState.response.results;
  if (results.length === 0) {
    return emptyState(
      'No tools found',
      'Try a broader query or switch the kind filter back to all.',
    );
  }

  return `
    <div class="result-count">${results.length} public result${
    results.length === 1 ? '' : 's'
  }</div>
    <div class="tool-list discover-results">
      ${results.map((tool) => toolCard(tool)).join('')}
    </div>
  `;
}

function discoverPrimitiveSuggestions(): string {
  const suggestions = discoverState.status === 'loaded'
    ? discoverState.response.platformPrimitives || []
    : LAUNCH_PLATFORM_PRIMITIVES.map((primitive) => ({
      primitive,
      label: labelize(primitive),
      description: 'Indexed launch primitive',
      similarity: null,
    } satisfies LaunchPlatformPrimitiveSuggestion));

  if (suggestions.length === 0) {
    return emptyState(
      'No platform suggestions',
      'Try deploy, wallet, pricing, install, or publish.',
    );
  }

  return `
    <div class="primitive-grid">
      ${suggestions.slice(0, 8).map((suggestion) => primitiveSuggestionCard(suggestion)).join('')}
    </div>
  `;
}

function discoveryRetrievalRows(): string {
  const retrieval = discoverState.status === 'loaded' ? discoverState.response.retrieval : null;
  if (!retrieval) {
    return `
      ${summaryRow('Retrieval', 'Loading')}
      ${summaryRow('Embedding model', 'Pending')}
    `;
  }
  return `
    ${summaryRow('Retrieval', labelize(retrieval.mode))}
    ${
    summaryRow(
      'Embedding model',
      retrieval.embeddingModel || 'Not used',
    )
  }
    ${summaryRow('Embedded sources', sourceListLabel(retrieval.embeddedSources))}
    ${
    summaryRow(
      'Fallback sources',
      sourceListLabel(retrieval.fallbackSources),
    )
  }
    ${retrieval.fallbackReason ? summaryRow('Fallback reason', retrieval.fallbackReason) : ''}
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
      'builder',
      'Builder Leaderboard',
      'Ranks public builders by launch-visible activity and earnings.',
    )
  }
        ${
    leaderboardPanel(
      'fee_credit',
      'Fee-Credit Leaderboard',
      'Shows creators earning fee-waiver credit through monetized usage.',
    )
  }
      </div>
    </section>
  `;
}

function leaderboardPeriodControls(selected: LeaderboardPeriod): string {
  const periods: Array<{ period: LeaderboardPeriod; label: string }> = [
    { period: '30d', label: '30 days' },
    { period: '90d', label: '90 days' },
    { period: 'all', label: 'All time' },
  ];
  return `
    <nav class="tab-row leaderboard-periods" aria-label="Leaderboard period">
      ${
    periods.map(({ period, label }) => `
        <a class="tab-link ${period === selected ? 'selected' : ''}" href="${
      leaderboardPeriodUrl(period)
    }" data-route>
          ${escapeHtml(label)}
        </a>
      `).join('')
  }
    </nav>
  `;
}

function leaderboardPanel(
  kind: LaunchLeaderboardKind,
  title: string,
  description: string,
): string {
  let body = '';
  if (leaderboardState.status === 'error') {
    body = emptyState('Leaderboard unavailable', leaderboardState.message);
  } else if (leaderboardState.status !== 'loaded') {
    body = emptyState('Loading rankings', 'Fetching launch leaderboard data.');
  } else {
    const response = kind === 'builder' ? leaderboardState.builder : leaderboardState.feeCredit;
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
      'No rankings yet',
      'Ranking data will appear as public tools are used and monetized.',
    );
  }

  return `
    <ol class="leaderboard-list">
      ${entries.slice(0, 10).map((entry) => leaderboardEntry(entry, kind)).join('')}
    </ol>
  `;
}

function leaderboardEntry(
  entry: LaunchLeaderboardEntry,
  kind: LaunchLeaderboardKind,
): string {
  const name = entry.displayName || entry.profileSlug || entry.userId ||
    'Unknown builder';
  const profile = entry.profileSlug ? `@${entry.profileSlug}` : shortUserId(
    entry.userId,
  );
  const events = typeof entry.eventCount === 'number'
    ? `${entry.eventCount.toLocaleString('en-US')} ${entry.eventCount === 1 ? 'event' : 'events'}`
    : kind === 'builder'
    ? 'Builder score'
    : 'Fee-credit activity';
  const featuredTool = entry.featuredTool?.slug
    ? `<a href="/tools/${encodeURIComponent(entry.featuredTool.slug)}" data-route>${
      escapeHtml(entry.featuredTool.name)
    }</a>`
    : '';

  return `
    <li class="leaderboard-entry">
      <span class="rank-badge">${entry.rank}</span>
      <div class="leaderboard-identity">
        <strong>${escapeHtml(name)}</strong>
        <span>${escapeHtml(profile)}</span>
        ${featuredTool ? `<span class="leaderboard-meta">Featured tool ${featuredTool}</span>` : ''}
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
  const route = suggestion.route && !suggestion.route.includes(':') ? suggestion.route : null;
  const similarity = typeof suggestion.similarity === 'number'
    ? `${Math.round(suggestion.similarity * 100)}%`
    : null;

  return `
    <article class="primitive-card suggestion">
      <strong>${escapeHtml(suggestion.label)}</strong>
      <span>${escapeHtml(suggestion.description)}</span>
      <div class="primitive-card-footer">
        ${similarity ? `<small>${escapeHtml(similarity)}</small>` : ''}
        ${route ? routeButton('Open', route) : ''}
      </div>
    </article>
  `;
}

function discoverKindOptions(selected: LaunchToolKind | 'all'): string {
  const options: Array<LaunchToolKind | 'all'> = [
    'all',
    'mcp',
    'http',
    'gpu',
    'markdown',
  ];
  return options.map((option) =>
    `<option value="${option}" ${option === selected ? 'selected' : ''}>${
      escapeHtml(labelize(option))
    }</option>`
  ).join('');
}

function toolSummarySkeleton(slug: string): string {
  return `
    <div class="summary-list">
      ${summaryRow('Slug', slug || 'from route')}
      ${summaryRow('Install', 'MCP/API/CLI affordance')}
      ${summaryRow('Pricing', 'Light call pricing')}
      ${summaryRow('Owner', 'Public profile + admin if owner')}
    </div>
  `;
}

function widgetSkeleton(): string {
  return `
    <div class="widget-frame">
      <div class="widget-toolbar">
        <span>Widget preview</span>
        <button class="button secondary compact" type="button">Open</button>
      </div>
      <div class="widget-body">No widget loaded yet</div>
    </div>
  `;
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
    ? `<a class="button secondary compact" href="${escapeAttribute(href)}" data-route>Open</a>`
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
    <a class="tab-link ${tab === selected ? 'selected' : ''}" href="/wallet?tab=${tab}" data-route>
      ${escapeHtml(label)}
    </a>
  `;
}

function walletTabPanel(wallet: LaunchWalletSummary, tab: WalletTab): string {
  switch (tab) {
    case 'topup':
      return walletTopupPanel(wallet);
    case 'transactions':
      return walletLinkedPanel(
        'Transactions',
        'The launch wallet summary is connected. Normalized transaction rows come from the existing wallet ledger endpoint in the next backend expansion.',
        wallet.transactionsUrl,
      );
    case 'receipts':
      return walletLinkedPanel(
        'Receipts',
        'Receipts are preserved by tool execution and marketplace flows. This tab keeps the launch surface anchored while row-level receipt contracts are promoted.',
        wallet.receiptsUrl,
      );
    case 'earnings':
      return walletEarningsPanel(wallet);
    case 'payouts':
      return walletPayoutPanel(wallet);
  }
}

function walletTopupPanel(wallet: LaunchWalletSummary): string {
  return `
    <div class="wallet-tab-panel">
      <div class="summary-list">
        ${summaryRow('Current spendable', wallet.spendableBalance.display)}
        ${summaryRow('Purchased balance', wallet.depositBalance?.display || '0 Light')}
        ${summaryRow('Can top up', wallet.canTopUp ? 'Yes' : 'No')}
      </div>
      <div class="action-row standalone-actions">
        ${
    wallet.topUpUrl && wallet.canTopUp ? routeButton('Add Light', wallet.topUpUrl, 'primary') : ''
  }
      </div>
    </div>
  `;
}

function walletEarningsPanel(wallet: LaunchWalletSummary): string {
  return `
    <div class="wallet-tab-panel">
      <div class="summary-list">
        ${summaryRow('Earned balance', wallet.earnedBalance?.display || '0 Light')}
        ${summaryRow('Escrow balance', wallet.escrowBalance?.display || '0 Light')}
        ${summaryRow('Payout status', wallet.payoutStatus?.label || 'Unknown')}
      </div>
      <p class="muted-copy">Creator earnings accrue as Light. Payout readiness is derived from the launch wallet facade.</p>
    </div>
  `;
}

function walletPayoutPanel(wallet: LaunchWalletSummary): string {
  const status = wallet.payoutStatus;
  return `
    <div class="wallet-tab-panel">
      <div class="payout-status ${status?.kind || 'unavailable'}">
        <strong>${escapeHtml(status?.label || 'Payout status unavailable')}</strong>
        <span>${escapeHtml(status?.description || 'Payout details are not available yet.')}</span>
      </div>
      <div class="summary-list">
        ${summaryRow('Earned balance', wallet.earnedBalance?.display || '0 Light')}
        ${summaryRow('Escrow balance', wallet.escrowBalance?.display || '0 Light')}
      </div>
    </div>
  `;
}

function walletLinkedPanel(
  title: string,
  description: string,
  href: string | null | undefined,
): string {
  return `
    <div class="wallet-tab-panel">
      ${emptyState(title, description)}
      <div class="action-row standalone-actions">
        ${href ? routeButton(`Open ${title}`, href, 'secondary') : ''}
      </div>
    </div>
  `;
}

function publicToolSummary(tool: LaunchToolSummary): string {
  return `
    <div class="summary-list">
      ${summaryRow('Slug', tool.slug)}
      ${summaryRow('Kind', labelize(tool.kind))}
      ${summaryRow('Visibility', labelize(tool.visibility))}
      ${summaryRow('Relationship', labelize(tool.relationship))}
      ${summaryRow('Owner', ownerLabel(tool))}
      ${summaryRow('Pricing', pricingLabel(tool))}
      ${summaryRow('Widgets', widgetsLabel(tool))}
      ${summaryRow('Updated', updatedLabel(tool))}
    </div>
  `;
}

function toolTagList(tool: LaunchToolSummary): string {
  if (!tool.tags || tool.tags.length === 0) return '';
  return `
    <div class="pill-grid tool-tags">
      ${
    tool.tags.slice(0, 12).map((tag) => pill(labelize(tag), 'included')).join(
      '',
    )
  }
    </div>
  `;
}

function publicWidgetSurface(tool: LaunchToolSummary): string {
  if (tool.widgets.length === 0) {
    return emptyState(
      'No widgets declared',
      'Agents can still install and call this tool through Ultralight.',
    );
  }

  const selected = selectedWidget(tool.widgets);
  return `
    <div class="widget-frame public-widget-frame">
      <div class="widget-toolbar">
        <span>${escapeHtml(selected.label)}</span>
        ${
    selected.openUrl
      ? `<a class="button secondary compact" href="${
        escapeAttribute(selected.openUrl)
      }" data-route>Open</a>`
      : ''
  }
      </div>
      <div class="widget-body public-widget-body">
        <div class="summary-list">
          ${summaryRow('Widget ID', selected.id)}
          ${summaryRow('Description', selected.description || 'Widget surface')}
          ${summaryRow('Public', selected.public ? 'Yes' : 'No')}
          ${
    summaryRow(
      'Preview',
      selected.previewAvailable ? 'Available' : 'Metadata only',
    )
  }
        </div>
      </div>
    </div>
    <div class="widget-list surface-selector">
      ${
    tool.widgets.map((widget) => publicWidgetSelector(tool, widget, selected.id))
      .join('')
  }
    </div>
  `;
}

function publicWidgetSelector(
  tool: LaunchToolSummary,
  widget: LaunchWidgetSummary,
  selectedId: string,
): string {
  const href = widget.openUrl ||
    `/tools/${encodeURIComponent(tool.slug)}?widget=${encodeURIComponent(widget.id)}`;
  return `
    <a class="widget-card widget-selector ${widget.id === selectedId ? 'selected' : ''}" href="${
    escapeAttribute(href)
  }" data-route>
      <div>
        <strong>${escapeHtml(widget.label)}</strong>
        <span>${escapeHtml(widget.description || 'Widget surface')}</span>
      </div>
      <span class="tool-kind">${widget.previewAvailable ? 'UI' : 'Data'}</span>
    </a>
  `;
}

function selectedWidget(widgets: LaunchWidgetSummary[]): LaunchWidgetSummary {
  const selectedId = new URLSearchParams(window.location.search).get('widget');
  return widgets.find((widget) => widget.id === selectedId) || widgets[0];
}

function trustPanel(trustCard: unknown): string {
  const trust = asRecord(trustCard);
  if (!trust) return '';
  const capabilitySummary = asRecord(trust.capability_summary);
  const permissions = asStringArray(trust.permissions);
  const requiredSecrets = asStringArray(trust.required_secrets);
  const perUserSecrets = asStringArray(trust.per_user_secrets);
  const signedManifest = trust.signed_manifest === true ? 'Signed' : 'Unsigned';
  const receipts = asRecord(trust.execution_receipts)?.enabled === true ? 'Enabled' : 'Unknown';
  const capabilities = capabilitySummary
    ? Object.entries(capabilitySummary)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => labelize(key))
      .join(', ') || 'None declared'
    : 'Unknown';

  return `
    <section class="panel">
      <div class="section-heading">
        <h2>Trust</h2>
        <p>Launch-safe trust metadata for external agents and users.</p>
      </div>
      <div class="summary-list trust-grid">
        ${summaryRow('Runtime', asString(trust.runtime) || 'Unknown')}
        ${summaryRow('Manifest', signedManifest)}
        ${summaryRow('Receipts', receipts)}
        ${summaryRow('Capabilities', capabilities)}
        ${
    summaryRow(
      'Permissions',
      permissions.length ? permissions.join(', ') : 'None declared',
    )
  }
        ${
    summaryRow(
      'Required secrets',
      requiredSecrets.length ? requiredSecrets.join(', ') : 'None',
    )
  }
        ${
    summaryRow(
      'Per-user secrets',
      perUserSecrets.length ? perUserSecrets.join(', ') : 'None',
    )
  }
      </div>
    </section>
  `;
}

function libraryToolList(kind: 'owned' | 'installed'): string {
  if (libraryState.status === 'error') {
    return emptyState('Library unavailable', libraryState.message);
  }

  if (libraryState.status !== 'loaded') {
    return emptyState('Loading library', 'Fetching owned and installed tools.');
  }

  const tools = kind === 'owned' ? libraryState.library.owned : libraryState.library.installed;
  if (tools.length === 0) {
    return emptyState(
      kind === 'owned' ? 'No owned tools yet' : 'No installed tools yet',
      kind === 'owned'
        ? 'Deploy a tool with the CLI or install instructions to manage it here.'
        : 'Discover public tools and add them to your external-agent workflow.',
    );
  }

  return `
    <div class="tool-list">
      ${tools.map((tool) => toolCard(tool)).join('')}
    </div>
  `;
}

function toolCard(tool: LaunchToolSummary): string {
  return `
    <article class="tool-card">
      <div class="tool-card-header">
        <div>
          <h3>${escapeHtml(tool.name)}</h3>
          <p>${escapeHtml(tool.description || 'No description provided.')}</p>
        </div>
        <span class="tool-kind">${escapeHtml(labelize(tool.kind))}</span>
      </div>
      <div class="tool-meta">
        ${summaryRow('Visibility', labelize(tool.visibility))}
        ${summaryRow('Owner', ownerLabel(tool))}
        ${summaryRow('Pricing', pricingLabel(tool))}
        ${summaryRow('Widgets', widgetsLabel(tool))}
        ${tool.relevance ? summaryRow('Relevance', relevanceLabel(tool)) : ''}
      </div>
      <div class="action-row tool-actions">
        ${tool.publicUrl ? routeButton('Open', tool.publicUrl) : ''}
        ${tool.adminUrl ? routeButton('Admin', tool.adminUrl, 'primary') : ''}
      </div>
    </article>
  `;
}

function toolAdminSummary(admin: LaunchToolAdminSummary): string {
  const tool = admin.tool;
  return `
    <div class="settings-list">
      ${settingsRow('Slug', tool.slug)}
      ${settingsRow('Visibility', labelize(tool.visibility))}
      ${settingsRow('Relationship', labelize(tool.relationship))}
      ${settingsRow('Pricing', pricingLabel(tool))}
      ${settingsRow('Owner', ownerLabel(tool))}
      ${settingsRow('Updated', updatedLabel(tool))}
    </div>
  `;
}

function widgetList(tool: LaunchToolSummary): string {
  if (tool.widgets.length === 0) {
    return emptyState(
      'No widgets declared',
      'This tool can still be installed and called by external agents.',
    );
  }

  return `
    <div class="widget-list">
      ${
    tool.widgets.map((widget) => `
        <article class="widget-card">
          <div>
            <strong>${escapeHtml(widget.label)}</strong>
            <span>${escapeHtml(widget.description || 'Widget surface')}</span>
          </div>
          ${
      widget.openUrl
        ? `<a class="button secondary compact" href="${escapeAttribute(widget.openUrl)}">Open</a>`
        : ''
    }
        </article>
      `).join('')
  }
    </div>
  `;
}

function routeButton(
  label: string,
  path: string,
  kind: 'primary' | 'secondary' = 'secondary',
): string {
  return `<a class="button ${kind}" href="${escapeAttribute(path)}" data-route>${
    escapeHtml(label)
  }</a>`;
}

function ownerLabel(tool: LaunchToolSummary): string {
  return tool.owner.displayName || tool.owner.profileSlug || tool.owner.userId;
}

function pricingLabel(tool: LaunchToolSummary): string {
  const pricing = tool.pricing;
  if (!pricing) return 'No pricing data';
  const paid = pricing.paidFunctionsCount || 0;
  const defaultPrice = pricing.defaultCallPrice?.display ||
    'Free default calls';
  return paid > 0 ? `${defaultPrice}; ${paid} paid functions` : defaultPrice;
}

function widgetsLabel(tool: LaunchToolSummary): string {
  if (tool.widgets.length === 0) return 'No widgets';
  if (tool.widgets.length === 1) return '1 widget';
  return `${tool.widgets.length} widgets`;
}

function relevanceLabel(tool: LaunchToolSummary): string {
  const relevance = tool.relevance;
  if (!relevance) return 'Not ranked';
  const source = labelize(relevance.source);
  const score = typeof relevance.score === 'number' ? ` ${Math.round(relevance.score * 100)}%` : '';
  return `${source}${score}`;
}

function sourceListLabel(
  sources: LaunchDiscoveryRetrievalSummary['embeddedSources'],
): string {
  return sources.length ? sources.map((source) => labelize(source)).join(', ') : 'None';
}

function updatedLabel(tool: LaunchToolSummary): string {
  if (!tool.updatedAt) return 'Unknown';
  const date = new Date(tool.updatedAt);
  if (Number.isNaN(date.getTime())) return tool.updatedAt;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function settingsRow(label: string, description: string): string {
  return `
    <div class="settings-row">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(description)}</span>
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
        ${routes.map((route) => `<code>${escapeHtml(route)}</code>`).join('')}
      </div>
    </section>
  `;
}

function currentDiscoverRequest(): LaunchDiscoveryRequest {
  const params = new URLSearchParams(window.location.search);
  const query = params.get('query') || params.get('q') || '';
  const kind = parseDiscoverKind(params.get('kind'));
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
    params.get('leaderboardPeriod') || params.get('period'),
  );
}

function currentWalletTab(): WalletTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  if (
    tab === 'transactions' || tab === 'receipts' || tab === 'earnings' ||
    tab === 'payouts'
  ) {
    return tab;
  }
  return 'topup';
}

function discoverUrlFromForm(form: HTMLFormElement): string {
  const data = new FormData(form);
  const query = String(data.get('query') || '').trim();
  const kind = parseDiscoverKind(String(data.get('kind') || 'all'));
  const period = currentLeaderboardPeriod();
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (kind !== 'all') params.set('kind', kind);
  if (period !== '30d') params.set('leaderboardPeriod', period);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return `/discover${suffix}`;
}

function parseDiscoverKind(value: string | null): LaunchToolKind | 'all' {
  if (
    value === 'mcp' || value === 'http' || value === 'gpu' ||
    value === 'markdown'
  ) {
    return value;
  }
  return 'all';
}

function parseLeaderboardPeriod(value: string | null): LeaderboardPeriod {
  if (value === '90d' || value === 'all') return value;
  return '30d';
}

function discoverKey(request: LaunchDiscoveryRequest): string {
  return JSON.stringify({
    query: request.query || '',
    kind: request.kind || 'all',
    includeWidgets: request.includeWidgets !== false,
    limit: request.limit || 24,
  });
}

function leaderboardKey(period: LeaderboardPeriod): string {
  return `leaderboard:${period}`;
}

function leaderboardPeriodUrl(period: LeaderboardPeriod): string {
  const params = new URLSearchParams(window.location.search);
  params.delete('period');
  if (period === '30d') {
    params.delete('leaderboardPeriod');
  } else {
    params.set('leaderboardPeriod', period);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return `/discover${suffix}`;
}

function leaderboardPeriodLabel(period: LeaderboardPeriod): string {
  switch (period) {
    case '90d':
      return '90 days';
    case 'all':
      return 'All time';
    case '30d':
      return '30 days';
  }
}

function shortUserId(userId: string): string {
  if (!userId) return 'No profile';
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
  if (installState.status !== 'loaded') return;
  const target = button.dataset.copyInstall;
  const instruction = installState.instructions.find((item) => item.target === target);
  const text = instruction?.configText ||
    instruction?.steps.map((stepText, index) => `${index + 1}. ${stepText}`)
      .join('\n');
  if (!text) return;

  try {
    await writeClipboard(text);
    showCopyFeedback(button, 'Copied');
  } catch {
    showCopyFeedback(button, 'Copy failed');
  }
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard write failed');
}

function showCopyFeedback(button: HTMLButtonElement, label: string): void {
  const original = button.textContent || 'Copy';
  button.textContent = label;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1200);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function labelize(value: string): string {
  return value
    .split(/[_-]/u)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function installTargetDescription(target: LaunchInstallTarget): string {
  switch (target) {
    case 'claude_code':
      return 'Claude Code MCP server config.';
    case 'cursor':
      return 'Cursor MCP tools loaded into agent context.';
    case 'codex':
      return 'Codex-compatible MCP/API install path.';
    case 'openai_remote_mcp':
      return 'Remote MCP for OpenAI Responses API.';
    case 'generic_mcp':
      return 'Portable JSON config for MCP-capable agents.';
    case 'cli':
      return 'Ultralight CLI install and auth flow.';
    case 'api':
      return 'Direct API key and endpoint usage.';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#039;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
