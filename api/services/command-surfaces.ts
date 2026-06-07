import type {
  WidgetDependencyDeclaration,
  WidgetGenerationHints,
} from '../../shared/contracts/widget.ts';
import type { WidgetIndexEntry } from './codemode-tools.ts';
import { buildWidgetIndexForApp, type AppForCodemode } from './codemode-tools.ts';
import {
  type CommandDashboardCardInstance,
  type CommandDashboardLayout,
  type CommandDashboardMetadataInput,
  normalizeDashboardKey,
  upsertCommandDashboardLayout,
} from './command-dashboard.ts';
import {
  getOrRebuildFunctionIndex,
  type FunctionIndex,
} from './function-index.ts';

export type CommandSurfaceKind = 'widget' | 'command_card';
export type CommandSurfaceSource = 'owned' | 'saved' | 'installed' | 'appstore';

export interface CommandSurfaceApp {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  manifest?: unknown;
}

export interface CommandWidgetSurfaceEntry {
  surface: 'widget';
  id: string;
  app_id: string;
  app_slug: string;
  app_name: string;
  widget_id: string;
  widget_label: string;
  description: string | null;
  embedding_text: string;
  ui_function: string;
  data_function: string;
  cards_count: number;
  card_ids: string[];
  dependencies?: WidgetDependencyDeclaration[];
  generation_hints?: WidgetGenerationHints;
  source: CommandSurfaceSource;
}

export interface CommandCardSurfaceEntry {
  surface: 'command_card';
  id: string;
  app_id: string;
  app_slug: string;
  app_name: string;
  widget_id: string;
  widget_label: string;
  card_id: string;
  card_label: string;
  description: string | null;
  embedding_text: string;
  size: string;
  render: 'native';
  kind?: string;
  data_view?: string;
  data_function: string;
  refresh_interval_s?: number;
  dependencies?: WidgetDependencyDeclaration[];
  generation_hints?: WidgetGenerationHints;
  opens_widget: true;
  source: CommandSurfaceSource;
}

export type CommandSurfaceEntry =
  | CommandWidgetSurfaceEntry
  | CommandCardSurfaceEntry;

export interface CommandSurfaceInventoryOptions {
  query?: unknown;
  surfaces?: unknown;
  limit?: unknown;
  source?: CommandSurfaceSource;
  app_id?: unknown;
  app_ids?: unknown;
  app_slug?: unknown;
  app_slugs?: unknown;
  app_scope?: unknown;
}

export interface CommandSurfaceInventory {
  query: string | null;
  surfaces: CommandSurfaceEntry[];
  totals: {
    widgets: number;
    command_cards: number;
    apps: number;
  };
  updated_at: string | null;
}

interface CommandDashboardBlueprintInput
  extends CommandDashboardMetadataInput {
  prompt?: unknown;
  query?: unknown;
  limit?: unknown;
}

interface CommandDashboardBlueprintCard
  extends CommandDashboardCardInstance {
  app_name: string;
  widget_label: string;
  card_label: string;
  description: string | null;
}

interface CommandDashboardBlueprint {
  dashboard_key: string;
  title: string;
  description: string | null;
  icon: string | null;
  is_default: boolean;
  layout: CommandDashboardLayout;
  cards: CommandDashboardBlueprintCard[];
  rationale: string[];
  unmatched: string[];
}

interface ScoredSurface {
  surface: CommandSurfaceEntry;
  score: number;
}

const DEFAULT_DASHBOARD_KEY = 'command_home';
const DEFAULT_SURFACES: CommandSurfaceKind[] = ['widget', 'command_card'];
const DEFAULT_BLUEPRINT_LIMIT = 8;
const MAX_INVENTORY_LIMIT = 100;
const GRID_COLUMNS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_INVENTORY_LIMIT, Math.floor(value)));
}

export function normalizeCommandSurfaceKinds(
  value: unknown,
  fallback: CommandSurfaceKind[] = DEFAULT_SURFACES,
): CommandSurfaceKind[] {
  if (!Array.isArray(value)) return fallback;
  const allowed = new Set<CommandSurfaceKind>(['widget', 'command_card']);
  const normalized = value
    .filter((entry): entry is CommandSurfaceKind =>
      typeof entry === 'string' && allowed.has(entry as CommandSurfaceKind)
    );
  return normalized.length > 0 ? [...new Set(normalized)] : fallback;
}

function normalizeQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 240) : null;
}

function normalizeStringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0
    )
    .map((entry) => entry.trim()))];
}

function normalizeAppScope(options: CommandSurfaceInventoryOptions): {
  appIds: Set<string>;
  appSlugs: Set<string>;
} {
  const appScope = isRecord(options.app_scope) ? options.app_scope : {};
  const appIds = new Set([
    ...normalizeStringList(options.app_id),
    ...normalizeStringList(options.app_ids),
    ...normalizeStringList(appScope.app_id),
    ...normalizeStringList(appScope.app_ids),
  ]);
  const appSlugs = new Set([
    ...normalizeStringList(options.app_slug),
    ...normalizeStringList(options.app_slugs),
    ...normalizeStringList(appScope.app_slug),
    ...normalizeStringList(appScope.app_slugs),
  ]);
  return { appIds, appSlugs };
}

function surfaceMatchesAppScope(
  surface: CommandSurfaceEntry,
  scope: { appIds: Set<string>; appSlugs: Set<string> },
): boolean {
  if (scope.appIds.size === 0 && scope.appSlugs.size === 0) return true;
  return scope.appIds.has(surface.app_id) || scope.appSlugs.has(surface.app_slug);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
    .slice(0, 20);
}

function dependencyKey(dep: WidgetDependencyDeclaration): string {
  return `${dep.app}:${dep.functions.join(',')}:${dep.access || 'read'}`;
}

function mergeDependencies(
  ...groups: Array<WidgetDependencyDeclaration[] | undefined>
): WidgetDependencyDeclaration[] | undefined {
  const merged = new Map<string, WidgetDependencyDeclaration>();
  for (const group of groups) {
    for (const dep of group || []) {
      merged.set(dependencyKey(dep), dep);
    }
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

function compactEmbeddingText(fields: Array<string | null | undefined>): string {
  return fields
    .filter((field): field is string => typeof field === 'string' && field.trim().length > 0)
    .map((field) => field.replace(/\s+/g, ' ').trim())
    .join(' | ')
    .slice(0, 4000);
}

function widgetEmbeddingText(widget: WidgetIndexEntry): string {
  const hints = widget.generationHints ? generationHintText(widget.generationHints) : '';
  return compactEmbeddingText([
    `Surface: widget`,
    `App: ${widget.appName}`,
    `Slug: ${widget.appSlug}`,
    `Widget: ${widget.label}`,
    `Widget id: ${widget.name}`,
    widget.description,
    widget.cards.length ? `Cards: ${widget.cards.map((card) => `${card.label} ${card.id}`).join(', ')}` : '',
    hints,
  ]);
}

function cardEmbeddingText(
  widget: WidgetIndexEntry,
  card: WidgetIndexEntry['cards'][number],
): string {
  const hints = card.generationHints || widget.generationHints
    ? generationHintText(card.generationHints || widget.generationHints!)
    : '';
  return compactEmbeddingText([
    `Surface: command card`,
    `App: ${widget.appName}`,
    `Slug: ${widget.appSlug}`,
    `Widget: ${widget.label}`,
    `Widget id: ${widget.name}`,
    `Card: ${card.label}`,
    `Card id: ${card.id}`,
    card.description || widget.description,
    card.kind ? `Kind: ${card.kind}` : '',
    card.dataView ? `Data view: ${card.dataView}` : '',
    hints,
  ]);
}

function surfaceSearchText(surface: CommandSurfaceEntry): string {
  return surface.embedding_text.toLowerCase();
}

function generationHintText(hints: WidgetGenerationHints): string {
  return [
    ...(hints.tags || []),
    ...(hints.entity_types || []),
    ...(hints.prompt_examples || []),
    hints.preferred_component || '',
    hints.action_group || '',
    ...(hints.suggested_components || []).flatMap((component) => [
      component.kind,
      component.title || '',
      component.description || '',
      component.data_view || '',
      component.context_source_id || '',
      ...(component.action_ids || []),
    ]),
  ].filter(Boolean).join(' ');
}

function scoreSurface(surface: CommandSurfaceEntry, query: string | null): number {
  if (!query) return 1;
  const searchText = surfaceSearchText(surface);
  const normalizedQuery = query.toLowerCase();
  let score = searchText.includes(normalizedQuery) ? 8 : 0;
  for (const token of tokenize(query)) {
    if (searchText.includes(token)) score += 2;
    if (surface.surface === 'command_card' && surface.card_id.includes(token)) {
      score += 1;
    }
    if (surface.widget_id.includes(token)) score += 1;
  }
  return score;
}

function buildWidgetSurface(
  widget: WidgetIndexEntry,
  source: CommandSurfaceSource,
): CommandWidgetSurfaceEntry {
  return {
    surface: 'widget',
    id: `${widget.appId}:${widget.name}`,
    app_id: widget.appId,
    app_slug: widget.appSlug,
    app_name: widget.appName,
    widget_id: widget.name,
    widget_label: widget.label,
    description: widget.description || null,
    embedding_text: widgetEmbeddingText(widget),
    ui_function: widget.uiFunction,
    data_function: widget.dataFunction,
    cards_count: widget.cards.length,
    card_ids: widget.cards.map((card) => card.id),
    ...(widget.dependencies?.length ? { dependencies: widget.dependencies } : {}),
    ...(widget.generationHints ? { generation_hints: widget.generationHints } : {}),
    source,
  };
}

function buildCardSurface(
  widget: WidgetIndexEntry,
  card: WidgetIndexEntry['cards'][number],
  source: CommandSurfaceSource,
): CommandCardSurfaceEntry {
  const dependencies = mergeDependencies(widget.dependencies, card.dependencies);
  return {
    surface: 'command_card',
    id: `${widget.appId}:${widget.name}:${card.id}`,
    app_id: widget.appId,
    app_slug: widget.appSlug,
    app_name: widget.appName,
    widget_id: widget.name,
    widget_label: widget.label,
    card_id: card.id,
    card_label: card.label,
    description: card.description || widget.description || null,
    embedding_text: cardEmbeddingText(widget, card),
    size: card.size,
    render: 'native',
    ...(card.kind ? { kind: card.kind } : {}),
    ...(card.dataView ? { data_view: card.dataView } : {}),
    data_function: card.dataFunction || widget.dataFunction,
    ...(typeof card.refreshIntervalS === 'number'
      ? { refresh_interval_s: card.refreshIntervalS }
      : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(card.generationHints || widget.generationHints
      ? { generation_hints: card.generationHints || widget.generationHints }
      : {}),
    opens_widget: true,
    source,
  };
}

export function flattenCommandSurfaceInventory(
  fnIndex: Pick<FunctionIndex, 'widgets' | 'updatedAt'>,
  options: CommandSurfaceInventoryOptions = {},
): CommandSurfaceInventory {
  const query = normalizeQuery(options.query);
  const requestedSurfaces = normalizeCommandSurfaceKinds(options.surfaces);
  const requested = new Set(requestedSurfaces);
  const source = options.source || 'installed';
  const appScope = normalizeAppScope(options);
  const entries: CommandSurfaceEntry[] = [];
  const appIds = new Set<string>();

  for (const widget of fnIndex.widgets || []) {
    appIds.add(widget.appId);
    if (requested.has('widget')) {
      entries.push(buildWidgetSurface(widget, source));
    }
    if (requested.has('command_card')) {
      for (const card of widget.cards || []) {
        entries.push(buildCardSurface(widget, card, source));
      }
    }
  }

  const scored: ScoredSurface[] = entries
    .filter((surface) => surfaceMatchesAppScope(surface, appScope))
    .map((surface) => ({ surface, score: scoreSurface(surface, query) }))
    .filter((entry) => !query || entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.surface.surface !== b.surface.surface) {
        return a.surface.surface === 'command_card' ? -1 : 1;
      }
      return surfaceSearchText(a.surface).localeCompare(surfaceSearchText(b.surface));
    });

  const limit = normalizeLimit(options.limit, MAX_INVENTORY_LIMIT);
  const surfaces = scored.slice(0, limit).map((entry) => entry.surface);

  return {
    query,
    surfaces,
    totals: {
      widgets: entries.filter((entry) => entry.surface === 'widget').length,
      command_cards: entries.filter((entry) => entry.surface === 'command_card').length,
      apps: appIds.size,
    },
    updated_at: fnIndex.updatedAt || null,
  };
}

function parseManifest(value: unknown): AppForCodemode['manifest'] {
  if (!value) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return isRecord(parsed) ? parsed as AppForCodemode['manifest'] : {};
}

export function buildCommandSurfacesFromApps(
  apps: CommandSurfaceApp[],
  options: CommandSurfaceInventoryOptions = {},
): CommandSurfaceInventory {
  const widgets: WidgetIndexEntry[] = [];
  for (const app of apps) {
    try {
      widgets.push(
        ...buildWidgetIndexForApp({
          id: app.id,
          name: app.name,
          slug: app.slug,
          manifest: parseManifest(app.manifest),
        }),
      );
    } catch {
      // Ignore invalid third-party manifests so one bad app does not hide the rest.
    }
  }

  return flattenCommandSurfaceInventory(
    { widgets, updatedAt: '' },
    { ...options, source: options.source || 'appstore' },
  );
}

export async function getCommandSurfaceInventory(
  userId: string,
  options: CommandSurfaceInventoryOptions = {},
): Promise<CommandSurfaceInventory> {
  const fnIndex = await getOrRebuildFunctionIndex(userId);
  return flattenCommandSurfaceInventory(fnIndex, options);
}

function humanizeTitle(value: string | null): string {
  if (!value) return 'Command Dashboard';
  const tokens = tokenize(value).slice(0, 4);
  if (tokens.length === 0) return 'Command Dashboard';
  return tokens
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function slugifyDashboardKey(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return normalizeDashboardKey(slug || DEFAULT_DASHBOARD_KEY);
}

function parseSize(size: string): { width: number; height: number } {
  const match = /^([1-4])x([1-4])$/.exec(size);
  if (!match) return { width: 1, height: 1 };
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function packCards(
  surfaces: CommandCardSurfaceEntry[],
  dashboardKey: string,
): {
  layout: CommandDashboardLayout;
  cards: CommandDashboardBlueprintCard[];
} {
  let x = 0;
  let y = 0;
  let rowHeight = 1;
  const cards: CommandDashboardBlueprintCard[] = [];

  for (const surface of surfaces) {
    const size = parseSize(surface.size);
    if (x + size.width > GRID_COLUMNS) {
      x = 0;
      y += rowHeight;
      rowHeight = 1;
    }
    const instance: CommandDashboardBlueprintCard = {
      instance_id: crypto.randomUUID(),
      app_id: surface.app_id,
      app_slug: surface.app_slug,
      widget_id: surface.widget_id,
      card_id: surface.card_id,
      position: { x, y },
      size: surface.size,
      app_name: surface.app_name,
      widget_label: surface.widget_label,
      card_label: surface.card_label,
      description: surface.description,
    };
    cards.push(instance);
    x += size.width;
    rowHeight = Math.max(rowHeight, size.height);
  }

  return {
    layout: {
      dashboard_key: dashboardKey,
      cards: cards.map((card) => ({
        instance_id: card.instance_id,
        app_id: card.app_id,
        app_slug: card.app_slug,
        widget_id: card.widget_id,
        card_id: card.card_id,
        position: card.position,
        size: card.size,
      })),
    },
    cards,
  };
}

export function buildCommandDashboardBlueprintFromInventory(
  inventory: CommandSurfaceInventory,
  input: CommandDashboardBlueprintInput = {},
): CommandDashboardBlueprint {
  const prompt = normalizeQuery(input.prompt) || normalizeQuery(input.query);
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().slice(0, 80)
    : humanizeTitle(prompt);
  const dashboardKey = input.dashboard_key === undefined
    ? slugifyDashboardKey(title === 'Command Dashboard' ? DEFAULT_DASHBOARD_KEY : title)
    : normalizeDashboardKey(input.dashboard_key);
  const limit = normalizeLimit(input.limit, DEFAULT_BLUEPRINT_LIMIT);
  const selectedCards = inventory.surfaces
    .filter((surface): surface is CommandCardSurfaceEntry =>
      surface.surface === 'command_card'
    )
    .slice(0, limit);
  const packed = packCards(selectedCards, dashboardKey);

  return {
    dashboard_key: dashboardKey,
    title,
    description: typeof input.description === 'string' && input.description.trim()
      ? input.description.trim().slice(0, 280)
      : prompt,
    icon: typeof input.icon === 'string' && input.icon.trim()
      ? input.icon.trim().slice(0, 64)
      : null,
    is_default: typeof input.is_default === 'boolean'
      ? input.is_default
      : dashboardKey === DEFAULT_DASHBOARD_KEY,
    ...packed,
    rationale: selectedCards.map((card) =>
      `${card.card_label} from ${card.app_name} matches ${prompt || 'available installed cards'}`
    ),
    unmatched: selectedCards.length === 0
      ? [prompt || 'No installed command cards are available yet.']
      : [],
  };
}

export async function createCommandDashboardBlueprint(
  userId: string,
  input: CommandDashboardBlueprintInput = {},
): Promise<{
  blueprint: CommandDashboardBlueprint;
  inventory: CommandSurfaceInventory;
}> {
  const query = normalizeQuery(input.prompt) || normalizeQuery(input.query);
  const inventory = await getCommandSurfaceInventory(userId, {
    query,
    surfaces: ['command_card'],
    limit: input.limit,
  });
  return {
    blueprint: buildCommandDashboardBlueprintFromInventory(inventory, input),
    inventory,
  };
}

export async function saveCommandDashboardFromInput(
  userId: string,
  input: Record<string, unknown>,
) {
  const blueprint = isRecord(input.blueprint) ? input.blueprint : null;
  const layoutInput = input.layout ?? blueprint?.layout;
  if (!layoutInput) {
    throw new Error('layout or blueprint.layout is required to save a Command dashboard');
  }

  const dashboardKey = normalizeDashboardKey(
    input.dashboard_key ?? blueprint?.dashboard_key ??
      (isRecord(layoutInput) ? layoutInput.dashboard_key : undefined),
  );
  const metadata: CommandDashboardMetadataInput = {
    dashboard_key: dashboardKey,
    title: input.title ?? blueprint?.title,
    description: input.description ?? blueprint?.description,
    icon: input.icon ?? blueprint?.icon,
    sort_order: input.sort_order,
    is_default: input.is_default ?? blueprint?.is_default,
  };

  return await upsertCommandDashboardLayout(
    userId,
    dashboardKey,
    layoutInput,
    metadata,
  );
}
