import { getEnv } from "../lib/env.ts";

export interface CommandDashboardCardPosition {
  x: number;
  y: number;
}

export interface CommandDashboardCardInstance {
  instance_id: string;
  app_id: string;
  app_slug?: string;
  widget_id: string;
  card_id: string;
  position: CommandDashboardCardPosition;
  size: string;
  config?: Record<string, unknown>;
}

export interface CommandDashboardLayout {
  dashboard_key: string;
  cards: CommandDashboardCardInstance[];
}

interface CommandDashboardLayoutRow {
  dashboard_key: string;
  title?: string | null;
  description?: string | null;
  icon?: string | null;
  sort_order?: number | null;
  is_default?: boolean | null;
  layout: CommandDashboardLayout;
  created_at?: string | null;
  updated_at: string;
}

export interface CommandDashboardSummary {
  dashboard_key: string;
  title: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  is_default: boolean;
  card_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface StoredCommandDashboardLayout extends CommandDashboardSummary {
  layout: CommandDashboardLayout;
}

export interface CommandDashboardMetadataInput {
  dashboard_key?: unknown;
  title?: unknown;
  description?: unknown;
  icon?: unknown;
  sort_order?: unknown;
  is_default?: unknown;
}

const DEFAULT_DASHBOARD_KEY = "command_home";
const DASHBOARD_KEY_RE = /^[a-z0-9_-]{1,64}$/;
const CARD_SIZE_RE = /^[1-4]x[1-4]$/;
const DASHBOARD_TITLE_MAX = 80;
const DASHBOARD_DESCRIPTION_MAX = 280;
const DASHBOARD_ICON_MAX = 64;
const DASHBOARD_SELECT =
  "dashboard_key,title,description,icon,sort_order,is_default,layout,created_at,updated_at";

function getSupabaseEnv(): {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
} {
  return {
    SUPABASE_URL: getEnv("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function serviceHeaders(): Record<string, string> {
  const { SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  return {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cardCount(layout: unknown): number {
  if (!isRecord(layout) || !Array.isArray(layout.cards)) return 0;
  return layout.cards.length;
}

function humanizeDashboardKey(key: string): string {
  return key
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Command";
}

function slugifyDashboardKey(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalizeDashboardKey(slug);
}

function normalizeOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function normalizeDashboardTitle(value: unknown, dashboardKey: string): string {
  if (value === undefined || value === null || value === "") {
    return humanizeDashboardKey(dashboardKey);
  }
  if (typeof value !== "string") {
    throw new Error("title must be a string");
  }
  const normalized = value.trim();
  if (!normalized) return humanizeDashboardKey(dashboardKey);
  if (normalized.length > DASHBOARD_TITLE_MAX) {
    throw new Error(`title must be ${DASHBOARD_TITLE_MAX} characters or fewer`);
  }
  return normalized;
}

function normalizeSortOrder(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("sort_order must be a finite number");
  }
  return Math.max(0, Math.floor(value));
}

function normalizeMetadata(
  input: CommandDashboardMetadataInput | undefined,
  dashboardKey: string,
): {
  title: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  is_default: boolean;
} {
  return {
    title: normalizeDashboardTitle(input?.title, dashboardKey),
    description: normalizeOptionalString(
      input?.description,
      "description",
      DASHBOARD_DESCRIPTION_MAX,
    ) ?? null,
    icon: normalizeOptionalString(input?.icon, "icon", DASHBOARD_ICON_MAX) ??
      null,
    sort_order: normalizeSortOrder(input?.sort_order),
    is_default: typeof input?.is_default === "boolean"
      ? input.is_default
      : dashboardKey === DEFAULT_DASHBOARD_KEY,
  };
}

function mergeMetadata(
  existing: CommandDashboardLayoutRow | null,
  input: CommandDashboardMetadataInput | undefined,
  dashboardKey: string,
): {
  title: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  is_default: boolean;
} {
  const defaults = existing
    ? {
      title: existing.title || humanizeDashboardKey(dashboardKey),
      description: existing.description ?? null,
      icon: existing.icon ?? null,
      sort_order: existing.sort_order ?? 0,
      is_default: existing.is_default ?? dashboardKey === DEFAULT_DASHBOARD_KEY,
    }
    : normalizeMetadata(undefined, dashboardKey);

  return {
    title: input && "title" in input
      ? normalizeDashboardTitle(input.title, dashboardKey)
      : defaults.title,
    description: input && "description" in input
      ? normalizeOptionalString(
        input.description,
        "description",
        DASHBOARD_DESCRIPTION_MAX,
      ) ?? null
      : defaults.description,
    icon: input && "icon" in input
      ? normalizeOptionalString(input.icon, "icon", DASHBOARD_ICON_MAX) ?? null
      : defaults.icon,
    sort_order: input && "sort_order" in input
      ? normalizeSortOrder(input.sort_order)
      : defaults.sort_order,
    is_default: input && "is_default" in input
      ? input.is_default === true
      : defaults.is_default,
  };
}

export function normalizeDashboardKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_DASHBOARD_KEY;
  const normalized = value.trim();
  if (!DASHBOARD_KEY_RE.test(normalized)) {
    throw new Error(
      "dashboard_key must be 1-64 lowercase letters, numbers, dashes, or underscores",
    );
  }
  return normalized;
}

function normalizePosition(
  value: unknown,
  index: number,
): CommandDashboardCardPosition {
  if (!isRecord(value)) return { x: 0, y: index };
  const x = typeof value.x === "number" && Number.isFinite(value.x)
    ? Math.max(0, Math.floor(value.x))
    : 0;
  const y = typeof value.y === "number" && Number.isFinite(value.y)
    ? Math.max(0, Math.floor(value.y))
    : index;
  return { x, y };
}

function normalizeCardInstance(
  value: unknown,
  index: number,
): CommandDashboardCardInstance {
  if (!isRecord(value)) {
    throw new Error(`layout.cards.${index} must be an object`);
  }

  const appId = typeof value.app_id === "string" ? value.app_id.trim() : "";
  const widgetId = typeof value.widget_id === "string"
    ? value.widget_id.trim()
    : "";
  const cardId = typeof value.card_id === "string" ? value.card_id.trim() : "";
  if (!appId) throw new Error(`layout.cards.${index}.app_id is required`);
  if (!widgetId) throw new Error(`layout.cards.${index}.widget_id is required`);
  if (!cardId) throw new Error(`layout.cards.${index}.card_id is required`);

  const size = typeof value.size === "string" && CARD_SIZE_RE.test(value.size)
    ? value.size
    : null;
  if (!size) {
    throw new Error(
      `layout.cards.${index}.size must use the form "2x1" with 1-4 columns and rows`,
    );
  }

  const instanceId =
    typeof value.instance_id === "string" && value.instance_id.trim()
      ? value.instance_id.trim()
      : crypto.randomUUID();

  return {
    instance_id: instanceId,
    app_id: appId,
    ...(typeof value.app_slug === "string" && value.app_slug.trim()
      ? { app_slug: value.app_slug.trim() }
      : {}),
    widget_id: widgetId,
    card_id: cardId,
    position: normalizePosition(value.position, index),
    size,
    ...(isRecord(value.config) ? { config: value.config } : {}),
  };
}

export function normalizeCommandDashboardLayout(
  input: unknown,
  dashboardKey = DEFAULT_DASHBOARD_KEY,
): CommandDashboardLayout {
  if (!isRecord(input)) {
    throw new Error("layout must be an object");
  }

  const cardsInput = input.cards === undefined ? [] : input.cards;
  if (!Array.isArray(cardsInput)) {
    throw new Error("layout.cards must be an array");
  }

  return {
    dashboard_key: normalizeDashboardKey(input.dashboard_key ?? dashboardKey),
    cards: cardsInput.map((card, index) => normalizeCardInstance(card, index)),
  };
}

export function emptyCommandDashboardLayout(
  dashboardKey = DEFAULT_DASHBOARD_KEY,
): CommandDashboardLayout {
  return {
    dashboard_key: dashboardKey,
    cards: [],
  };
}

function emptyStoredCommandDashboardLayout(
  dashboardKey = DEFAULT_DASHBOARD_KEY,
): StoredCommandDashboardLayout {
  const metadata = normalizeMetadata(undefined, dashboardKey);
  return {
    dashboard_key: dashboardKey,
    ...metadata,
    card_count: 0,
    layout: emptyCommandDashboardLayout(dashboardKey),
    created_at: null,
    updated_at: null,
  };
}

function normalizeStoredLayoutRow(
  row: CommandDashboardLayoutRow,
): StoredCommandDashboardLayout {
  const dashboardKey = normalizeDashboardKey(row.dashboard_key);
  const layout = {
    ...normalizeCommandDashboardLayout(row.layout, dashboardKey),
    dashboard_key: dashboardKey,
  };

  return {
    dashboard_key: dashboardKey,
    title: row.title || humanizeDashboardKey(dashboardKey),
    description: row.description ?? null,
    icon: row.icon ?? null,
    sort_order: row.sort_order ?? 0,
    is_default: row.is_default ?? dashboardKey === DEFAULT_DASHBOARD_KEY,
    card_count: layout.cards.length,
    layout,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function summarizeStoredLayout(
  row: CommandDashboardLayoutRow,
): CommandDashboardSummary {
  const dashboardKey = normalizeDashboardKey(row.dashboard_key);
  return {
    dashboard_key: dashboardKey,
    title: row.title || humanizeDashboardKey(dashboardKey),
    description: row.description ?? null,
    icon: row.icon ?? null,
    sort_order: row.sort_order ?? 0,
    is_default: row.is_default ?? dashboardKey === DEFAULT_DASHBOARD_KEY,
    card_count: cardCount(row.layout),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function fetchDashboardRow(
  userId: string,
  dashboardKey: string,
): Promise<CommandDashboardLayoutRow | null> {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_command_dashboard_layouts?user_id=eq.${userId}&dashboard_key=eq.${
      encodeURIComponent(dashboardKey)
    }&deleted_at=is.null&select=${DASHBOARD_SELECT}&limit=1`,
    { headers: serviceHeaders() },
  );

  if (!res.ok) {
    throw new Error(`Failed to load command dashboard layout (${res.status})`);
  }

  const rows = await res.json() as CommandDashboardLayoutRow[];
  return rows[0] ?? null;
}

async function clearDefaultDashboard(userId: string): Promise<void> {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_command_dashboard_layouts?user_id=eq.${userId}&is_default=eq.true&deleted_at=is.null`,
    {
      method: "PATCH",
      headers: {
        ...serviceHeaders(),
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        is_default: false,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to clear default command dashboard (${res.status})`,
    );
  }
}

export async function listCommandDashboardLayouts(
  userId: string,
): Promise<{ dashboards: CommandDashboardSummary[] }> {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_command_dashboard_layouts?user_id=eq.${userId}&deleted_at=is.null&select=${DASHBOARD_SELECT}&order=sort_order.asc,dashboard_key.asc`,
    { headers: serviceHeaders() },
  );

  if (!res.ok) {
    throw new Error(`Failed to list command dashboards (${res.status})`);
  }

  const rows = await res.json() as CommandDashboardLayoutRow[];
  return { dashboards: rows.map(summarizeStoredLayout) };
}

export async function getCommandDashboardLayout(
  userId: string,
  dashboardKeyInput?: unknown,
): Promise<StoredCommandDashboardLayout> {
  const dashboardKey = normalizeDashboardKey(dashboardKeyInput);
  const row = await fetchDashboardRow(userId, dashboardKey);
  return row
    ? normalizeStoredLayoutRow(row)
    : emptyStoredCommandDashboardLayout(dashboardKey);
}

export async function createCommandDashboardLayout(
  userId: string,
  input: CommandDashboardMetadataInput & { layout?: unknown },
): Promise<StoredCommandDashboardLayout> {
  const dashboardKey = input.dashboard_key === undefined
    ? slugifyDashboardKey(
      typeof input.title === "string" && input.title.trim()
        ? input.title
        : DEFAULT_DASHBOARD_KEY,
    )
    : normalizeDashboardKey(input.dashboard_key);
  const metadata = normalizeMetadata(input, dashboardKey);
  const layout = input.layout === undefined
    ? emptyCommandDashboardLayout(dashboardKey)
    : {
      ...normalizeCommandDashboardLayout(input.layout, dashboardKey),
      dashboard_key: dashboardKey,
    };
  const { SUPABASE_URL } = getSupabaseEnv();

  if (metadata.is_default) await clearDefaultDashboard(userId);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_command_dashboard_layouts`,
    {
      method: "POST",
      headers: {
        ...serviceHeaders(),
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        user_id: userId,
        dashboard_key: dashboardKey,
        ...metadata,
        layout,
        deleted_at: null,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to create command dashboard (${res.status}): ${message}`,
    );
  }

  const rows = await res.json() as CommandDashboardLayoutRow[];
  return normalizeStoredLayoutRow(rows[0]);
}

export async function updateCommandDashboardMetadata(
  userId: string,
  dashboardKeyInput: unknown,
  input: CommandDashboardMetadataInput,
): Promise<StoredCommandDashboardLayout> {
  const dashboardKey = normalizeDashboardKey(dashboardKeyInput);
  const existing = await fetchDashboardRow(userId, dashboardKey);
  if (!existing) {
    throw new Error(`Command dashboard "${dashboardKey}" not found`);
  }

  const metadata = mergeMetadata(existing, input, dashboardKey);
  if (metadata.is_default && !existing.is_default) {
    await clearDefaultDashboard(userId);
  }

  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_command_dashboard_layouts?user_id=eq.${userId}&dashboard_key=eq.${
      encodeURIComponent(dashboardKey)
    }&deleted_at=is.null`,
    {
      method: "PATCH",
      headers: {
        ...serviceHeaders(),
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        ...metadata,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to update command dashboard (${res.status}): ${message}`,
    );
  }

  const rows = await res.json() as CommandDashboardLayoutRow[];
  return normalizeStoredLayoutRow(rows[0]);
}

export async function deleteCommandDashboardLayout(
  userId: string,
  dashboardKeyInput: unknown,
): Promise<{ ok: true; dashboard_key: string }> {
  const dashboardKey = normalizeDashboardKey(dashboardKeyInput);
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_command_dashboard_layouts?user_id=eq.${userId}&dashboard_key=eq.${
      encodeURIComponent(dashboardKey)
    }&deleted_at=is.null`,
    {
      method: "PATCH",
      headers: {
        ...serviceHeaders(),
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        is_default: false,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  );

  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to delete command dashboard (${res.status}): ${message}`,
    );
  }

  return { ok: true, dashboard_key: dashboardKey };
}

export async function upsertCommandDashboardLayout(
  userId: string,
  dashboardKeyInput: unknown,
  layoutInput: unknown,
  metadataInput?: CommandDashboardMetadataInput,
): Promise<StoredCommandDashboardLayout> {
  const dashboardKey = normalizeDashboardKey(dashboardKeyInput);
  const layout = {
    ...normalizeCommandDashboardLayout(layoutInput, dashboardKey),
    dashboard_key: dashboardKey,
  };
  const existing = await fetchDashboardRow(userId, dashboardKey);
  const metadata = mergeMetadata(existing, metadataInput, dashboardKey);
  const { SUPABASE_URL } = getSupabaseEnv();

  if (metadata.is_default && !existing?.is_default) {
    await clearDefaultDashboard(userId);
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_command_dashboard_layouts?on_conflict=user_id,dashboard_key`,
    {
      method: "POST",
      headers: {
        ...serviceHeaders(),
        "Prefer": "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify({
        user_id: userId,
        dashboard_key: dashboardKey,
        ...metadata,
        layout,
        deleted_at: null,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to save command dashboard layout (${res.status}): ${message}`,
    );
  }

  const rows = await res.json() as CommandDashboardLayoutRow[];
  return normalizeStoredLayoutRow(rows[0]);
}
